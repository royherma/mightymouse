// Jev only picks from closed lists (choice), scores (score), or already-known
// text (transcript/selection) — it never invents a string.
import { CONFIG } from '../../shared/config'
import type {
  ActionContextSnapshot,
  ActionDefinition,
  ActionHabit,
  ActionSlotValues,
  ActionTrigger,
  ChoiceSlotSpec,
  ScoreSlotSpec
} from '../../shared/action-engine'
import { rankOptions } from '../../shared/rank-options'
import { slotValueBoost } from './personal-model'

const NONE_ACTION_ID = 'none'

export interface ActionQuestions {
  state: Record<string, unknown>
  questions: Record<string, unknown>
}

function slotQuestionKey(actionId: string, slotKey: string): string {
  return `slot__${actionId}__${slotKey}`
}

function buildActionCriteria(actions: readonly ActionDefinition[]): Record<string, string> {
  const criteria: Record<string, string> = {
    [NONE_ACTION_ID]: 'Nothing here is what the user wants.'
  }
  for (const action of actions) criteria[action.id] = action.when
  return criteria
}

function buildChoiceQuestion(
  actionTitle: string,
  actionId: string,
  frontApp: string,
  slot: ChoiceSlotSpec,
  transcript: string
): Record<string, unknown> {
  const options = rankOptions(slot.options, transcript, CONFIG.ACTIONS.MAX_SLOT_OPTIONS, (value) =>
    slotValueBoost(frontApp, actionId, slot.key, value)
  )
  const criteria: Record<string, string> = {}
  for (const opt of options) criteria[opt.value] = opt.label
  return {
    type: 'choice',
    instructions: `For "${actionTitle}": ${slot.ask}`,
    criteria
  }
}

// Jev scores against an ordered rubric, not a numeric range: `criteria` is
// required and `min`/`max` are not schema fields (sending them 422s the whole
// call). We keep min/max as our own domain model and turn them into labelled
// levels here, then map the answer's level position back onto the range.
const SCORE_LEVELS = 5

function buildScoreQuestion(actionTitle: string, slot: ScoreSlotSpec): Record<string, unknown> {
  const step = (slot.max - slot.min) / (SCORE_LEVELS - 1)
  const criteria = Array.from(
    { length: SCORE_LEVELS },
    (_, i) => `${Math.round(slot.min + step * i)}${slot.unit}`
  )
  return {
    type: 'score',
    instructions: `For "${actionTitle}": ${slot.ask}`,
    criteria
  }
}

// `score` comes back as a position across the criteria levels (0..n-1), which
// may land between them. Anything outside that range is Jev disagreeing with
// the rubric, so it's clamped rather than trusted.
function scoreToSlotValue(score: number, slot: ScoreSlotSpec): number {
  const position = Math.min(SCORE_LEVELS - 1, Math.max(0, score))
  const value = slot.min + (position / (SCORE_LEVELS - 1)) * (slot.max - slot.min)
  return Math.round(value)
}

// A choice question's size is its criteria map, and accessibility labels run
// from 3 to 300 chars — so an option COUNT cannot keep the body under the
// proxy's limit. Drop the lowest-ranked options (rankOptions already ordered
// them, best first) off the largest question until the whole map fits.
function trimToByteBudget(questions: Record<string, unknown>): void {
  const budget = CONFIG.ACTIONS.MAX_QUESTIONS_BYTES
  if (JSON.stringify(questions).length <= budget) return

  for (;;) {
    let biggestKey = ''
    let biggestCount = 0
    for (const [key, q] of Object.entries(questions)) {
      const criteria = (q as { criteria?: unknown }).criteria
      if (criteria === null || typeof criteria !== 'object' || Array.isArray(criteria)) continue
      const count = Object.keys(criteria).length
      if (count > biggestCount) {
        biggestCount = count
        biggestKey = key
      }
    }
    if (biggestKey === '' || biggestCount <= 1) return

    const question = questions[biggestKey] as { criteria: Record<string, string> }
    const keys = Object.keys(question.criteria)
    for (const key of keys.slice(Math.max(1, Math.ceil(keys.length * 0.75)))) {
      delete question.criteria[key]
    }

    if (JSON.stringify(questions).length <= budget) return
  }
}

// One Jev call asks about every candidate action's slots speculatively; only
// the winning action's answers get read, so the rest cost nothing extra.
export function buildActionQuestions(
  actions: readonly ActionDefinition[],
  ctx: ActionContextSnapshot,
  habits: readonly ActionHabit[],
  transcript: string,
  trigger: ActionTrigger
): ActionQuestions {
  const state: Record<string, unknown> = {
    context: { ...ctx, selectionText: ctx.selectionText.slice(0, CONFIG.ACTIONS.MAX_STATE_SELECTION_CHARS) },
    habits,
    trigger,
    ...(trigger === 'idle' ? {} : { transcript })
  }

  const questions: Record<string, unknown> = {
    action: {
      type: 'choice',
      instructions:
        trigger === 'idle'
          ? 'Given only what is on screen right now, choose the action the user would clearly ' +
            'want next. Choose "none" unless an action is clearly useful right now — the user ' +
            "hasn't asked for anything, so a wrong guess costs more than staying quiet."
          : 'Which action, if any, is the user asking for. Choose "none" when nothing here is ' +
            'what the user wants.',
      criteria: buildActionCriteria(actions)
    }
  }

  if (trigger !== 'idle') {
    questions['is_command'] = {
      type: 'noul',
      instructions:
        'This text is an instruction telling the computer to do something, not text meant to ' +
        'be typed, pasted or sent as-is.'
    }
  }

  for (const action of actions) {
    for (const slot of action.slots) {
      if (slot.kind === 'choice') {
        questions[slotQuestionKey(action.id, slot.key)] = buildChoiceQuestion(
          action.title,
          action.id,
          ctx.frontApp,
          slot,
          transcript
        )
      } else if (slot.kind === 'score') {
        questions[slotQuestionKey(action.id, slot.key)] = buildScoreQuestion(action.title, slot)
      }
    }
  }

  trimToByteBudget(questions)

  return { state, questions }
}

interface ChoiceAnswer {
  choice?: unknown
  probabilities?: unknown
  confidence?: unknown
}

interface ScoreAnswer {
  score?: unknown
}

function coerceProbability(answers: Record<string, unknown>, actionId: string): number {
  const action = answers['action'] as ChoiceAnswer | undefined
  const probs = action?.probabilities
  if (!probs || typeof probs !== 'object') return 0
  const value = (probs as Record<string, unknown>)[actionId]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export interface ParsedActionAnswer {
  actionId: string
  probability: number
  slots: ActionSlotValues
  confidences: Record<string, number>
  chosen: boolean
}

function parseSlots(
  action: ActionDefinition,
  answers: Record<string, unknown>
): { slots: ActionSlotValues; confidences: Record<string, number> } {
  const slots: ActionSlotValues = {}
  const confidences: Record<string, number> = {}
  for (const slot of action.slots) {
    const key = slotQuestionKey(action.id, slot.key)
    if (!Object.prototype.hasOwnProperty.call(answers, key)) continue
    const raw = answers[key]

    if (slot.kind === 'choice') {
      const value = (raw as ChoiceAnswer | undefined)?.choice
      if (typeof value === 'string' && slot.options.some((o) => o.value === value)) {
        slots[slot.key] = value
        const confidence = (raw as ChoiceAnswer | undefined)?.confidence
        if (typeof confidence === 'number' && Number.isFinite(confidence)) {
          confidences[slot.key] = confidence
        }
      }
    } else if (slot.kind === 'score') {
      const value = (raw as ScoreAnswer | undefined)?.score
      if (typeof value === 'number' && Number.isFinite(value)) {
        slots[slot.key] = scoreToSlotValue(value, slot)
      }
    }
  }
  return { slots, confidences }
}

// Anything Jev returns that wasn't in the offered choice/option list is
// dropped, never trusted. Reserved actions ride along with their own odds even
// when Jev picked something else or "none".
export function parseActionAnswers(
  actions: readonly ActionDefinition[],
  answers: Record<string, unknown>
): ParsedActionAnswer[] {
  if (!Object.prototype.hasOwnProperty.call(answers, 'action')) return []
  const actionAnswer = answers['action'] as ChoiceAnswer | undefined
  const chosenId = typeof actionAnswer?.choice === 'string' ? actionAnswer.choice : ''
  const reserved: readonly string[] = CONFIG.ACTIONS.RESERVED_ACTION_IDS

  const results: ParsedActionAnswer[] = []
  for (const action of actions) {
    const chosen = action.id === chosenId
    const probability = coerceProbability(answers, action.id)
    if (!chosen && !(reserved.includes(action.id) && probability >= CONFIG.ACTIONS.RESERVED_MIN_PROBABILITY)) {
      continue
    }
    results.push({ actionId: action.id, probability, ...parseSlots(action, answers), chosen })
  }
  return results
}
