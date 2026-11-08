// Observe -> Decide -> Act: the one place that turns a trigger into a ranked
// ActionCardPayload, and a picked proposal into a run.
import { randomUUID } from 'crypto'
import { CONFIG } from '../../shared/config'
import { track } from '../analytics'
import type {
  ActionCardPayload,
  ActionChip,
  ActionContextSnapshot,
  ActionDefinition,
  ActionProposal,
  ActionResultPayload,
  ActionRunInput,
  ActionSlotOption,
  ActionSlotValues,
  ActionTrigger
} from '../../shared/action-engine'
import { ACTION_PREFS } from '../store/action-prefs'
import { listAllActions } from './registry'
import { snapshotContext, noteActionRun } from './context-window'
import { appendActionDecision, appendActionOutcome } from './action-log'
import { getHabits, isMuted, habitBoost } from './personal-model'
import { buildActionQuestions, parseActionAnswers, type ParsedActionAnswer } from './decide'
import { callJev } from './decide-transport'
import { executeAction } from './executor'

export interface PreparedActions {
  runId: string
  trigger: ActionTrigger
  transcript: string
  context: ActionContextSnapshot
  actions: ActionDefinition[]
  state: Record<string, unknown>
  questions: Record<string, unknown>
}

export interface DecideMeta {
  latencyMs: number
  via: 'proxy' | 'direct'
  inputTokens: number
}

interface PendingProposal {
  runId: string
  trigger: ActionTrigger
  frontApp: string
  topActionId: string
  // Captured at propose time: by the time the user confirms, focus has moved to
  // the card and the selection that prompted the offer is already gone.
  transcript: string
  selectionText: string
  proposals: {
    proposalId: string
    def: ActionDefinition
    slots: ActionSlotValues
    suggestedSlots: ActionSlotValues
  }[]
}

const pending = new Map<string, PendingProposal>()

/** The card the chord keys act on: the newest one proposed, cleared the moment
 *  it is run, dismissed or expired. Without it ⌘⌥⇧1 could fire a row belonging
 *  to a card that left the screen minutes ago but is still in `pending`. */
let liveCardRunId = ''

// Retiring a run and forgetting it was the live card are the same event; a
// `pending.delete` that skipped this would leave the chord firing a dead row.
function retire(runId: string): void {
  pending.delete(runId)
  if (liveCardRunId === runId) liveCardRunId = ''
}

/** Which row ⌘⌥⇧1/2/3 would run, so the chord can be claimed only when there
 *  is really a card to act on — otherwise the key belongs to suggestions. */
export function liveProposalAt(index: number): { runId: string; proposalId: string } | null {
  const run = pending.get(liveCardRunId)
  const proposal = run?.proposals[index]
  if (!run || !proposal) return null
  return { runId: liveCardRunId, proposalId: proposal.proposalId }
}

// Null only when there's nothing worth asking about.
export function prewarmActions(): void {
  if (!ACTION_PREFS.getEnabled()) return
  void snapshotContext()
    .then((context) => listAllActions(context, 'voice'))
    .catch(() => {})
}

interface ObservedActions {
  context: ActionContextSnapshot
  candidates: ActionDefinition[]
}

let primed: { at: number; trigger: ActionTrigger; ready: Promise<ObservedActions> } | null = null

async function observe(trigger: ActionTrigger): Promise<ObservedActions> {
  const context = await snapshotContext()
  return { context, candidates: await listAllActions(context, trigger) }
}

// Start reading the screen + listing actions while the user is still talking.
export function primeActions(trigger: ActionTrigger): void {
  if (!ACTION_PREFS.getEnabled()) return
  if (primed && primed.trigger === trigger && Date.now() - primed.at < CONFIG.ACTIONS.PRIME_TTL_MS) return
  const ready = observe(trigger)
  ready.catch(() => {})
  primed = { at: Date.now(), trigger, ready }
}

function takePrimed(trigger: ActionTrigger): Promise<ObservedActions> | null {
  const hit = primed && primed.trigger === trigger && Date.now() - primed.at < CONFIG.ACTIONS.PRIME_TTL_MS
  const ready = hit ? primed!.ready : null
  primed = null
  return ready
}

export async function prepareActions(
  runId: string,
  trigger: ActionTrigger,
  transcript: string
): Promise<PreparedActions | null> {
  if (!ACTION_PREFS.getEnabled()) {
    console.log(`[actions] ${runId} skip: disabled in settings`)
    return null
  }
  const t0 = Date.now()
  const warm = takePrimed(trigger)
  const { context, candidates } = (warm && (await warm.catch(() => null))) || (await observe(trigger))
  const tContext = Date.now()
  const actions = candidates.filter((a) => isReserved(a.id) || !isMuted(a.id, context.frontApp))
  console.log(
    `[actions] ${runId} trigger=${trigger} front=${context.frontApp} candidates=${candidates.length} afterMute=${actions.length} observe=${tContext - t0}ms${warm ? ' primed' : ''} said="${transcript.slice(0, 40)}"`
  )
  if (actions.length === 0) return null

  const habits = getHabits(context.frontApp)
  const { state, questions } = buildActionQuestions(actions, context, habits, transcript, trigger)

  return { runId, trigger, transcript, context, actions, state, questions }
}

function optionLabel(def: ActionDefinition, slotKey: string, value: string): string {
  const slot = def.slots.find((s) => s.key === slotKey)
  if (!slot || slot.kind !== 'choice') return value
  return slot.options.find((o) => o.value === value)?.label ?? value
}

function buildChips(
  def: ActionDefinition,
  slots: ActionSlotValues,
  confidences: Record<string, number>
): ActionChip[] {
  const chips: ActionChip[] = []
  for (const [key, value] of Object.entries(slots)) {
    chips.push({
      key,
      label: optionLabel(def, key, String(value)),
      value: String(value),
      options: pickerOptions(def, key, String(value)),
      confidence: confidences[key]
    })
  }
  return chips
}

// The chosen value always travels, even when the ranker put it past the cap --
// a picker that cannot show what is currently selected reads as a wrong value.
function pickerOptions(
  def: ActionDefinition,
  slotKey: string,
  value: string
): ActionSlotOption[] | undefined {
  const slot = def.slots.find((s) => s.key === slotKey)
  if (!slot || slot.kind !== 'choice') return undefined
  const head = slot.options.slice(0, CONFIG.ACTIONS.CHIP_PICKER_OPTIONS)
  if (head.some((o) => o.value === value)) return [...head]
  const chosen = slot.options.find((o) => o.value === value)
  return chosen ? [chosen, ...head] : [...head]
}

function clearsPreselectFloor(trigger: ActionTrigger, probability: number): boolean {
  if (trigger === 'idle') return probability >= CONFIG.ACTIONS.IDLE_MIN_PROBABILITY
  return probability >= CONFIG.ACTIONS.VOICE_PRESELECT_PROBABILITY
}

function isReserved(actionId: string): boolean {
  return (CONFIG.ACTIONS.RESERVED_ACTION_IDS as readonly string[]).includes(actionId)
}

function keepReservedSlots(ranked: ParsedActionAnswer[]): ParsedActionAnswer[] {
  const reserved = ranked.filter((p) => isReserved(p.actionId))
  const others = ranked
    .filter((p) => !isReserved(p.actionId))
    .slice(0, Math.max(1, CONFIG.ACTIONS.MAX_PROPOSALS - reserved.length))
  return [...others, ...reserved]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, CONFIG.ACTIONS.MAX_PROPOSALS)
}

// Idle returns null below its own probability floor entirely — an
// unconfident idle guess is worse than nothing.
export function resolveActions(
  prepared: PreparedActions,
  answers: Record<string, unknown>,
  meta: DecideMeta
): ActionCardPayload | null {
  const parsed = parseActionAnswers(prepared.actions, answers)
  const boosted = keepReservedSlots(
    parsed
      .map((p) => ({
        ...p,
        probability: p.probability * habitBoost(p.actionId, prepared.context.frontApp)
      }))
      .sort((a, b) => b.probability - a.probability)
  )

  const isCommandAnswer = answers['is_command'] as { noul?: unknown } | undefined
  const isCommand =
    typeof isCommandAnswer?.noul === 'number' && isCommandAnswer.noul > CONFIG.ACTIONS.COMMAND_NOUL

  appendActionDecision({
    runId: prepared.runId,
    trigger: prepared.trigger,
    transcript: prepared.transcript,
    context: prepared.context,
    offered: prepared.actions.map((a) => ({ actionId: a.id, percent: 0 })),
    topActionId: boosted[0]?.actionId ?? '',
    slots: boosted[0]?.slots ?? {},
    isCommand,
    latencyMs: meta.latencyMs,
    via: meta.via,
    inputTokens: meta.inputTokens
  })

  console.log(
    `[actions] ${prepared.runId} decided isCommand=${isCommand} ranked=${
      boosted.map((b) => `${b.actionId}@${b.probability.toFixed(2)}`).join(',') || 'none'
    } ms=${meta.latencyMs} via=${meta.via}`
  )

  if (prepared.trigger === 'idle') {
    if (boosted.length === 0 || !clearsPreselectFloor('idle', boosted[0].probability)) {
      console.log(
        `[actions] ${prepared.runId} drop: idle below ${CONFIG.ACTIONS.IDLE_MIN_PROBABILITY}`
      )
      return null
    }
  }
  if (boosted.length === 0) {
    console.log(`[actions] ${prepared.runId} drop: no action parsed from the answers`)
    return null
  }

  const pendingProposals: PendingProposal['proposals'] = []
  const proposals: ActionProposal[] = boosted.map((p: ParsedActionAnswer, i) => {
    const def = prepared.actions.find((a) => a.id === p.actionId)!
    const proposalId = randomUUID()
    pendingProposals.push({ proposalId, def, slots: p.slots, suggestedSlots: { ...p.slots } })

    const preselected =
      i === 0 &&
      p.chosen &&
      def.safety === 'safe' &&
      clearsPreselectFloor(prepared.trigger, p.probability) &&
      (prepared.trigger === 'idle' || isCommand)

    return {
      proposalId,
      actionId: def.id,
      capabilityId: def.capabilityId,
      title: def.title,
      icon: def.icon,
      chips: buildChips(def, p.slots, p.confidences),
      // Clamped: habitBoost goes to 1.5x, which is right for ORDERING but is not
      // a probability — an unclamped 0.89 x 1.5 rendered on the card as "134%".
      percent: Math.min(100, Math.round(p.probability * 100)),
      safety: def.safety,
      preselected
    }
  })

  liveCardRunId = prepared.runId
  pending.set(prepared.runId, {
    runId: prepared.runId,
    trigger: prepared.trigger,
    frontApp: prepared.context.frontApp,
    topActionId: boosted[0].actionId,
    transcript: prepared.transcript,
    selectionText: prepared.context.selectionText,
    proposals: pendingProposals
  })

  track('action_proposed', {
    trigger: prepared.trigger,
    front_app: prepared.context.frontApp,
    action_id: boosted[0].actionId,
    count: proposals.length,
    percent: proposals[0].percent,
    latency_ms: meta.latencyMs,
    via: meta.via
  })

  return {
    runId: prepared.runId,
    trigger: prepared.trigger,
    proposals,
    isCommand,
    latencyMs: meta.latencyMs,
    via: meta.via
  }
}

export async function proposeActions(
  runId: string,
  trigger: ActionTrigger,
  transcript: string
): Promise<ActionCardPayload | null> {
  const prepared = await prepareActions(runId, trigger, transcript)
  if (!prepared) return null

  const result = await callJev(
    { state: prepared.state, questions: prepared.questions },
    CONFIG.ACTIONS.DECIDE_TIMEOUT_MS
  )
  if (!result) return null

  return resolveActions(prepared, result.answers, {
    latencyMs: result.latencyMs,
    via: result.via,
    inputTokens: result.inputTokens
  })
}

export async function runProposal(runId: string, proposalId: string): Promise<ActionResultPayload> {
  const run = pending.get(runId)
  const proposal = run?.proposals.find((p) => p.proposalId === proposalId)
  if (!run || !proposal) return { runId, proposalId, ok: false, line: 'rejected: unknown-proposal' }

  retire(runId)
  const started = Date.now()

  const input: ActionRunInput = {
    slots: proposal.slots,
    transcript: run.transcript,
    selection: run.selectionText,
    trigger: run.trigger,
    runId
  }
  const result = await executeAction(proposal.def, input)
  // A failed run goes back on the card as Retry, so the chord has to come back
  // with it — retire() cleared the live id on the way in.
  if (!result.ok) {
    pending.set(runId, run)
    liveCardRunId = runId
  }
  const runMs = Date.now() - started
  const wasTop = proposal.def.id === run.topActionId

  appendActionOutcome({
    runId,
    trigger: run.trigger,
    frontApp: run.frontApp,
    topActionId: run.topActionId,
    chosenActionId: proposal.def.id,
    suggestedSlots: proposal.suggestedSlots,
    slots: proposal.slots,
    outcome: wasTop ? 'accepted' : 'overrode',
    ok: result.ok,
    line: result.line,
    runMs
  })
  noteActionRun(proposal.def.id)

  track('action_executed', {
    trigger: run.trigger,
    action_id: proposal.def.id,
    ok: result.ok,
    overrode: !wasTop,
    run_ms: runMs
  })

  return { runId, proposalId, ok: result.ok, line: result.line, detail: result.detail }
}

// Validated against the full slot.options, never the truncated list the picker
// showed -- the same rule parseActionAnswers holds for Jev's own answer.
export function setProposalSlot(
  runId: string,
  proposalId: string,
  slotKey: string,
  value: string
): boolean {
  const run = pending.get(runId)
  const proposal = run?.proposals.find((p) => p.proposalId === proposalId)
  if (!run || !proposal) return false

  const slot = proposal.def.slots.find((s) => s.key === slotKey)
  if (!slot || slot.kind !== 'choice') return false
  if (!slot.options.some((o) => o.value === value)) return false

  proposal.slots = { ...proposal.slots, [slotKey]: value }
  return true
}

export function dismissProposal(runId: string, proposalId: string): void {
  const run = pending.get(runId)
  const proposal = run?.proposals.find((p) => p.proposalId === proposalId)
  if (!run || !proposal) return

  retire(runId)
  appendActionOutcome({
    runId,
    trigger: run.trigger,
    frontApp: run.frontApp,
    topActionId: run.topActionId,
    chosenActionId: proposal.def.id,
    suggestedSlots: proposal.suggestedSlots,
    slots: proposal.slots,
    outcome: 'dismissed',
    ok: false,
    line: '',
    runMs: 0
  })
  track('action_dismissed', {
    trigger: run.trigger,
    action_id: proposal.def.id,
    front_app: run.frontApp
  })
}

export function expireProposals(runId: string): void {
  const run = pending.get(runId)
  if (!run) return

  retire(runId)
  for (const proposal of run.proposals) {
    appendActionOutcome({
      runId,
      trigger: run.trigger,
      frontApp: run.frontApp,
      topActionId: run.topActionId,
      chosenActionId: proposal.def.id,
      suggestedSlots: proposal.suggestedSlots,
      slots: proposal.slots,
      outcome: 'ignored',
      ok: false,
      line: '',
      runMs: 0
    })
  }
}
