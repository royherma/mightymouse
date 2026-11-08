/**
 * Phone Remote — the chat sheet (Mighty sessions listed/opened/sent from the
 * phone), the relay-pending push, and the swipe-suggest pipeline (label ->
 * cached/in-flight/fresh Suggestion[] via a real backend call). Also owns the
 * per-message move/click/chat-turn counters and the pane-preview "did it
 * change" cache, both small pieces of state that only these handlers touch.
 */
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { nativeImage } from 'electron'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { PREFS } from '../store/prefs'
import { PATHS } from '../store/paths'
import { isPhoneChatSession, countBubbles } from './chat-session-filter'
import { RUN_EVENT } from '../../shared/types'
import { agentMessageBody, basename, turnMedia } from '../../shared/attachments'
import { runMighty } from '../mighty/run-mighty'
import { MIGHTY } from '../store/mighty'
import { EVENTS } from '../store/events'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { relaySnapshot } from '../agent-relay/wire'
import { relayRequestStore } from '../agent-relay/store'
import { recordJournal } from '../phone-remote/connection-journal'
import { listedAgentSessions, setAgentSessionBusy, type AgentSession } from '../agent-relay/mcp/http-listener'
import { capturePaneTail, sendPaneKeys, sendPaneText } from '../agent-relay/picker-keys'
import { resolveOrigin, setTmuxZoom } from '../agent-relay/origin-resolver'
import { resolveSessionRef, startSessionWrap } from '../agent-relay/session-control'
import { abortRun, resolveRunModel, runBackend } from '../backend/runner'
import { BACKENDS } from '../backend/adapters'
import { runLabel } from '../../shared/model-label'
import type { BackendId, MightySession } from '../../shared/types'
import { probeBackend, switchBackend } from './settings'
import { takeReplyImagePath } from './phone-remote-share'
import {
  suggestKey,
  suggestPrompt,
  parseSuggestions,
  worthSuggesting,
  suggestContext
} from '../../shared/swipe-suggest'
import type { Suggestion } from '../../shared/swipe-suggest'
import { buildDeck } from '../../shared/swipe-triage'
import { senderMatchKey, cardSummary } from '../../shared/relay-cards'
import { RELAY_TAP_OUTCOMES, type ChatProjectWire } from '../../shared/phone-remote-protocol'
import { sendToPhone, type PhoneRemoteMessage } from '../phone-remote/server'
import { bumpPhoneMessage, bumpPhoneMoves, bumpPhoneClicks, bumpPhoneChatTurns } from './phone-remote-audio'

type Msg<T extends PhoneRemoteMessage['type']> = Extract<PhoneRemoteMessage, { type: T }>

function chatPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > CONFIG.PHONE_REMOTE.CHAT_PREVIEW_MAX_CHARS
    ? `${flat.slice(0, CONFIG.PHONE_REMOTE.CHAT_PREVIEW_MAX_CHARS)}…`
    : flat
}

/** Pushed to the phone on connect and on every store change (PRD §6b: the
 *  sheet never polls). The snapshot itself is shared with the Mac panel's Code
 *  sheet -- see agent-relay/wire.ts for why both surfaces read one definition. */
export function sendRelayPending(): void {
  const snapshot = relaySnapshot()
  // The picture reaches the page in two steps -- this flag, then a fetch the
  // page makes off the back of it -- and only the fetch was logged, so a card
  // whose flag never arrived looked identical to one the page chose not to
  // draw. Log what we SENT, so the missing half is the half without a line.
  const withImage = snapshot.pending.filter((r) => r.params.hasImage).map((r) => r.id)
  if (withImage.length > 0) {
    devLog.log('[phone-remote] relay snapshot sent with images', { requestIds: withImage })
  }
  sendToPhone({ type: 'relayPending', ...snapshot })
}

const projectImageCache = new Map<string, string | undefined>()

function svgToPng(path: string): Electron.NativeImage {
  const out = join(tmpdir(), `mm-project-${randomUUID()}.png`)
  try {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', '80', '80', path, '--out', out], { stdio: 'ignore', timeout: 5000 })
    return nativeImage.createFromPath(out)
  } catch {
    return nativeImage.createEmpty()
  } finally {
    rmSync(out, { force: true })
  }
}

export function projectImageBase64(path: string | undefined): string | undefined {
  if (!path) return undefined
  if (!projectImageCache.has(path)) {
    const img = path.toLowerCase().endsWith('.svg') ? svgToPng(path) : nativeImage.createFromPath(path)
    projectImageCache.set(
      path,
      img.isEmpty() ? undefined : img.resize({ width: 80, height: 80 }).toPNG().toString('base64')
    )
  }
  return projectImageCache.get(path)
}

function chatProject(projectId: string | undefined): ChatProjectWire | undefined {
  const project = projectId ? MIGHTY.getProject(projectId) : null
  if (!project) return undefined
  return {
    name: project.name,
    icon: project.icon,
    imageBase64: projectImageBase64(project.imagePath)
  }
}

function sidebarGroups(): (s: MightySession) => number {
  const live = MIGHTY.listProjects().filter((p) => !p.archived)
  const pinned = live.filter((p) => p.pinned)
  const rank = new Map(pinned.map((p, i) => [p.id, i]))
  live.filter((p) => !p.pinned).forEach((p, i) => rank.set(p.id, pinned.length + 1 + i))
  return (s) => (s.pinned ? pinned.length : !s.projectId ? live.length + 1 : (rank.get(s.projectId) ?? -1))
}

export function sendChatSessions(offset: number): void {
  const groupOf = sidebarGroups()
  const all = MIGHTY.listSessions().filter((s) => !s.archived && isPhoneChatSession(s) && groupOf(s) >= 0)
  const size = CONFIG.PHONE_REMOTE.CHAT_SESSION_PAGE_SIZE
  const page = all.slice(offset, offset + size)
  sendToPhone({
    type: 'chatSessions',
    sessions: page.map((s) => {
      const last = s.turns[s.turns.length - 1]
      return {
        id: s.id,
        title: s.title,
        updated: s.updated,
        messageCount: countBubbles(s),
        // Prefer the reply; fall back to the question for a turn still in flight
        // (a: '' until it resolves), so a resumed-mid-run thread still previews.
        preview: chatPreview(last ? (last.a.trim() !== '' ? last.a : last.q) : ''),
        // The session's live-run mark. Needed precisely BECAUSE of the preview
        // fallback above: previewing the question makes a running thread look
        // like a settled one whose answer happened to be short.
        running: s.runId !== undefined,
        project: chatProject(s.projectId),
        group: groupOf(s),
        pinned: s.pinned || undefined
      }
    }),
    offset,
    hasMore: offset + page.length < all.length
  })
}

/** One opened thread. Sends the NEWEST turns when a session exceeds the backstop
 *  — the tail is what you came back for — and flags it so the phone can say so
 *  rather than silently presenting a partial conversation as complete. */
export function sendChatSession(id: string): void {
  const session = MIGHTY.getSession(id)
  if (!session) {
    // Deleted on the Mac between listing and opening. Answer with an empty
    // thread rather than staying silent — the phone shows "conversation is
    // gone" instead of a spinner that never resolves.
    sendToPhone({ type: 'chatSession', id, title: '', turns: [], truncated: false, running: false })
    return
  }
  const limit = CONFIG.PHONE_REMOTE.CHAT_TRANSCRIPT_TURN_LIMIT
  const truncated = session.turns.length > limit
  const turns = truncated ? session.turns.slice(-limit) : session.turns
  sendToPhone({
    type: 'chatSession',
    id: session.id,
    title: session.title,
    // Flatten MightyRunSource -> boolean here: server.ts is deliberately
    // domain-free and must not learn Mighty's types (see its header).
    turns: turns.map((t, i) => {
      const media = turnMedia(t.sources, t.artifacts)
      return {
        fromPhone: t.source === 'phone',
        q: t.q,
        a: t.a,
        ts: t.ts,
        ok: t.ok,
        ...(media.length > 0
          ? {
              // The index into the STORED session, not into this array: a
              // truncated thread ships the last N turns, so the phone's own
              // position would fetch someone else's screenshot. Adding the
              // offset back here keeps the phone from computing an index it
              // has no way to check.
              media: media.map((m, item) => ({
                turn: session.turns.length - turns.length + i,
                item,
                kind: m.kind,
                name: basename(m.path),
                mine: m.mine
              }))
            }
          : {})
      }
    }),
    truncated,
    running: session.runId !== undefined
  })
}

export async function handleChatSend(sessionId: string | undefined, rawText: string, projectId?: string): Promise<void> {
  // Bound the free text server-side. The phone also disables send past this, but
  // this is the side that matters: it's the only phone message carrying free text
  // into a run, so it doesn't get to trust the client about length.
  const text = rawText.trim().slice(0, CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS)
  if (text === '') return

  const session = sessionId ? MIGHTY.getSession(sessionId) : null
  const project = typeof projectId === 'string' ? MIGHTY.getProject(projectId) : null
  const target = session ?? MIGHTY.newSession(text, project?.id)
  sendToPhone({ type: 'chatTurnStart', sessionId: target.id, title: target.title })

  try {
    const result = await runMighty({
      message: text,
      sessionId: target.id,
      source: 'phone',
      // Phase fires on every backend; chunks are claude-only (adapter-gated).
      // Both ride the same event so the phone renders from whichever it gets —
      // a non-streaming backend shows phases and must never look stalled.
      onPhase: (phase, detail) =>
        sendToPhone({ type: 'chatChunk', sessionId: target.id, phase, detail }),
      onEvent: (event) => {
        if (event.kind === RUN_EVENT.text && event.text !== '') {
          sendToPhone({ type: 'chatChunk', sessionId: target.id, chunk: event.text })
        }
      }
    })
    sendToPhone({
      type: 'chatTurnDone',
      sessionId: result.sessionId,
      ok: result.error === undefined,
      // On failure runMighty still logs the turn, so send the error as the reply
      // text — the thread shows what went wrong in place, not a vanishing toast.
      reply: result.error === undefined ? result.answer : CONFIG.UI_LABELS.RUN_FAIL_REASON[result.error] ?? CONFIG.UI_LABELS.RUN_FAIL_UNKNOWN
    })
  } catch (err) {
    // runMighty documents that it never throws, but this is the outermost frame
    // of a fire-and-forget path over a network transport — swallowing here costs
    // nothing and guarantees the phone never hangs on a spinner.
    devLog.error('Phone Remote: chat run error', err)
    sendToPhone({ type: 'chatTurnDone', sessionId: target.id, ok: false, reply: 'Run failed.' })
  }
}

export function countPhoneMessage(type: PhoneRemoteMessage['type']): void {
  bumpPhoneMessage(type)
  switch (type) {
    case 'move':
    case 'dragMove':
    case 'mirrorWarp':
      bumpPhoneMoves()
      return
    case 'tap':
    case 'twoFingerTap':
    case 'doubleTap':
      bumpPhoneClicks()
      return
    case 'chatSend':
      bumpPhoneChatTurns()
      return
    default:
      return
  }
}

/** Age of a pane preview: the poll runs every few seconds, so stamping capture
 *  time would read "just now" forever. Only a CHANGE in the text moves the
 *  clock, which is what "how old is this state" actually asks. */
const previewSeen = new Map<string, { text: string; at: number }>()
/** Must be asked BEFORE `previewChangedAt`, which records the text it is asked
 *  about and would make every peek look unchanged. */
export function previewIsUnchanged(label: string, preview: string): boolean {
  return previewSeen.get(label)?.text === preview
}
export function previewChangedAt(label: string, preview: string): number {
  const prev = previewSeen.get(label)
  if (prev && prev.text === preview) return prev.at
  // First sighting is the honest floor, not a claim the pane changed just now:
  // the phone shows "just now" once, then ages truthfully from here.
  const at = Date.now()
  previewSeen.set(label, { text: preview, at })
  return at
}

/** What the user has typed at each agent, so the thread can show both halves.
 *
 *  A reply goes into a tmux pane and mints no card, so the phone's own state was
 *  the only record it ever happened -- and a reload wiped it, leaving a screen
 *  of the agent talking to nobody. Held here instead: same shape and same
 *  lifetime as `previewSeen` above, so a reconnecting phone is told what it
 *  said. Deliberately not the relay store -- a typed message is not a card, and
 *  minting one would put a request with no verb in front of the approve path.
 *
 *  Capped per label because this one GROWS with use where `previewSeen` holds a
 *  single string: the thread only ever renders recent turns, so an unbounded
 *  list would be memory nothing reads. */
const SENT_TURNS_PER_LABEL = 50
const OPENING_TTL_MS = 10 * 60_000
const OPENING_CLOCK_SLACK_MS = 5_000

/** `files` stays on the Mac: a filesystem path must never ride the wire to the phone. */
export interface SentTurn {
  text: string
  at: number
  files?: string[]
}

const sentTurns = new Map<string, SentTurn[]>()

// The spawn knows its pane before the shim registers a row, so the pane is the join key.
const openingTurns: { pane: string; cwd: string; turn: SentTurn }[] = []

function sentTurn(text: string, files: string[]): SentTurn {
  return files.length ? { text, at: Date.now(), files } : { text, at: Date.now() }
}

export function forPhone(turns: SentTurn[]): { text: string; at: number }[] {
  return turns.map(({ text, at }) => ({ text, at }))
}

export function recordOpeningTurn(start: { pane: string; cwd: string }, text: string, files: string[] = []): void {
  if (!start.cwd || (!text && files.length === 0)) return
  openingTurns.push({ pane: start.pane, cwd: start.cwd, turn: sentTurn(text, files) })
}

export function recordSentTurn(label: string, text: string, files: string[] = []): SentTurn[] {
  const turns = sentTurns.get(label) ?? []
  turns.push(sentTurn(text, files))
  const capped = turns.slice(-SENT_TURNS_PER_LABEL)
  sentTurns.set(label, capped)
  return capped
}

/** The one way words and files reach a running agent: typed into its pane, recorded, echoed to the phone. */
export async function sendToSession(
  session: AgentSession,
  said: string,
  files: string[],
  opts: { context?: string; echoLabel?: string } = {}
): Promise<'tmux' | 'tty' | 'skipped'> {
  const via = await sendPaneText(session.origin, agentMessageBody(files, (opts.context ?? '') + said), session.facts?.pid)
  if (via === 'skipped') return via
  const turns = recordSentTurn(session.label, said, files)
  sendToPhone({ type: 'relaySessionSent', label: opts.echoLabel ?? session.label, turns: forPhone(turns) })
  return via
}

function claimOpening(session: { cwd?: string; since: number; origin?: { tmuxPane?: string } }): SentTurn | undefined {
  const now = Date.now()
  for (let i = openingTurns.length - 1; i >= 0; i--) {
    if (now - openingTurns[i].turn.at > OPENING_TTL_MS) openingTurns.splice(i, 1)
  }
  const pane = session.origin?.tmuxPane
  const at = openingTurns.findIndex((o) =>
    o.pane
      ? o.pane === pane
      : o.cwd === session.cwd && session.since >= o.turn.at - OPENING_CLOCK_SLACK_MS
  )
  if (at === -1) return undefined
  return openingTurns.splice(at, 1)[0].turn
}

/** Every turn typed at this agent, matched the way the renderer keys sessions.
 *  The map is keyed on the raw label a caller happened to hold, and the Mac
 *  pane addresses agents by the normalised key -- looking up raw would return
 *  an empty thread for a session that has plenty.
 *
 *  The Mac sheet passes a session ID, not a label (`sessionId ?? label`), and
 *  no amount of normalising turns a uuid into a name -- so the ref is resolved
 *  to its session's label first or every reply vanishes on send. */
export function sentTurnsFor(ref: string): SentTurn[] {
  const session = resolveSessionRef(ref)
  const label = session?.label ?? ref
  const opening = session ? claimOpening(session) : undefined
  if (opening) sentTurns.set(label, [opening, ...(sentTurns.get(label) ?? [])])
  const exact = sentTurns.get(label)
  if (exact) return exact
  const want = senderMatchKey(label)
  for (const [key, turns] of sentTurns) if (senderMatchKey(key) === want) return turns
  return []
}

/** Answers the phone's ask on open. Always answers, even with nothing -- the
 *  same reason `handleRelaySessionPeek` does: silence leaves the thread unable
 *  to tell "you have said nothing here" from "the Mac never replied". */
export function handleRelaySessionSentGet(msg: Msg<'relaySessionSentGet'>): void {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  sendToPhone({
    type: 'relaySessionSent',
    label: msg.label,
    turns: forPhone(sentTurns.get(msg.label) ?? [])
  })
}

/** Keyed on `(session, tldr)`, not label: skip-cycling returns to the same card
 *  repeatedly and a CLI spawn per pass would pin a core. In-flight is held too,
 *  so two arrivals in one second share a run. */
const suggestCache = new Map<string, Suggestion[]>()
const suggestInFlight = new Map<string, Promise<Suggestion[]>>()

/** Best-effort by construction: every failure path ends as an empty array, which
 *  the deck renders as "keep the canned three". Nothing here reports an error,
 *  because there is no version of this the user needs to hear about. */
export async function suggestForSession(
  label: string,
  tldr: string,
  opts: { said?: string; fresh?: boolean } = {}
): Promise<Suggestion[]> {
  const want = senderMatchKey(label)
  const session = listedAgentSessions().find(
    (s) => senderMatchKey(s.label) === want || senderMatchKey(s.stated) === want
  )
  devLog.log(`[suggest] asked label=${label} ctx=${tldr.slice(0, 40)} session=${Boolean(session)}`)
  // Bail-outs still ANSWER: the phone shows a loading skeleton until a reply
  // for this key arrives, so a silent return would pin it until its deadline.
  const declined = (): Suggestion[] => {
    sendToPhone({ type: 'relaySuggestions', label, tldr, suggestions: [] })
    return []
  }
  // The Mac thread is someone reading the conversation, so a stale agent still gets ideas.
  if (!session || (session.staleSince !== undefined && !opts.said)) return declined()
  // `tldr` here is whatever context the phone had -- a declared TLDR when the
  // agent set one, else the subject derived from its cards.
  if (!worthSuggesting({ stale: false }, false, tldr)) return declined()

  const key = `${suggestKey({ sessionId: session.sessionId, label, tldr })} ${opts.said ?? ''}`
  const cached = opts.fresh ? undefined : suggestCache.get(key)
  if (cached) {
    sendToPhone({ type: 'relaySuggestions', label, tldr, suggestions: cached })
    return cached
  }
  const inFlight = suggestInFlight.get(key)
  if (inFlight) return inFlight

  // MCP is agent->Mac, so we cannot ask the agent what it wants -- everything
  // below is observed. A few lines rather than the last one: a single line is
  // usually a prompt or a spinner, which says nothing about the work.
  let paneTail: string | undefined
  try {
    const tail = session.origin
      ? await capturePaneTail(
          session.origin,
          CONFIG.AGENT_RELAY.SUGGEST_PANE_LINES,
          CONFIG.AGENT_RELAY.SUGGEST_PANE_MAX_CHARS
        )
      : null
    paneTail = tail?.trim() || undefined
  } catch {
    paneTail = undefined
  }

  const snapshot = relaySnapshot()
  const sender = senderMatchKey(session.stated ?? session.label)
  const recent = [...snapshot.pending, ...snapshot.resolved]
    .filter((r) => senderMatchKey(r.params.from) === sender)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-CONFIG.AGENT_RELAY.SUGGEST_RECENT_CARDS)
    .map((r) => r.params.body?.trim() || cardSummary(r).trim())
    .filter(Boolean)
  if (opts.said) recent.push(opts.said.slice(-CONFIG.AGENT_RELAY.SUGGEST_SAID_MAX_CHARS))

  // Resolved by `finish`, so the /suggest probe can read what the phone would
  // have been sent. The phone path ignores it and reads the WS event as before.
  let settle: (suggestions: Suggestion[]) => void = () => {}
  const done = new Promise<Suggestion[]>((resolve) => {
    settle = resolve
  })
  suggestInFlight.set(key, done)

  const finish = (suggestions: Suggestion[]): void => {
    devLog.log(`[suggest] done label=${label} n=${suggestions.length} ${JSON.stringify(suggestions)}`)
    suggestInFlight.delete(key)
    suggestCache.set(key, suggestions)
    sendToPhone({ type: 'relaySuggestions', label, tldr, suggestions })
    settle(suggestions)
  }

  void runBackend({
    backend: PREFS.getBackend(),
    runId: `relay-suggest:${randomUUID()}`,
    systemPrompt: '',
    userPrompt: suggestPrompt({
      subject: tldr,
      repo: session.facts?.repo,
      branch: session.facts?.branch,
      agent: session.facts?.agent,
      model: session.facts?.model,
      age: session.since ? `${Math.max(1, Math.round((Date.now() - session.since) / 60000))}m` : undefined,
      recent,
      paneTail
    }),
    runDir: PATHS.TMP,
    timeoutMs: CONFIG.SUGGESTIONS.PREDICT_TIMEOUT_MS,
    mode: 'ask',
    fast: true,
    lean: true,
    onPhase: () => {},
    onDone: (result) => {
      devLog.log(`[suggest] raw label=${label} ${JSON.stringify(result?.slice(0, 300) ?? null)}`)
      finish(result ? parseSuggestions(result) : [])
    }
  }).catch(() => finish([]))

  return done
}

/** The probe fires the real path with the real context, so a terminal sees exactly
 *  what a card would. Context is derived here the way the deck derives it, since
 *  the caller only knows a label. */
export async function suggestProbeForLabel(label: string): Promise<Suggestion[]> {
  const want = senderMatchKey(label)
  const session = listedAgentSessions().find(
    (s) => senderMatchKey(s.label) === want || senderMatchKey(s.stated) === want
  )
  if (!session) return []
  const snapshot = relaySnapshot()
  const card = buildDeck(
    listedAgentSessions(),
    [...snapshot.pending, ...snapshot.resolved],
    Date.now()
  ).find((c) => senderMatchKey(c.label) === want)
  const context = suggestContext(session, card?.subject)
  if (!context) return []
  return suggestForSession(label, context)
}

export function handleChatListSessions(msg: Msg<'chatListSessions'>): void {
  sendChatSessions(msg.offset ?? 0)
}

export function handleChatGetSession(msg: Msg<'chatGetSession'>): void {
  sendChatSession(msg.id)
}

const readyBackends = new Set<BackendId>()

const AUTO_CHAT_MODEL = 'auto'

function sendChatModels(): void {
  const current = PREFS.getBackend()
  const ids = (Object.keys(BACKENDS) as BackendId[]).filter((id) => id === current || readyBackends.has(id))
  const auto = ids.includes('mightymouse') ? [{ id: AUTO_CHAT_MODEL, label: 'Auto', icon: 'auto' }] : []
  sendToPhone({
    type: 'models',
    scope: 'chat',
    current: current === 'mightymouse' && PREFS.getSelectedModel() === '' ? AUTO_CHAT_MODEL : current,
    options: [...auto, ...ids.map((id) => ({ id, label: runLabel(id, resolveRunModel(id)), icon: id }))]
  })
}

export function handleChatGetModels(): void {
  sendChatModels()
  const ids = Object.keys(BACKENDS) as BackendId[]
  void Promise.all(
    ids.map((id) =>
      probeBackend(id)
        .then((r) => (r.ok ? readyBackends.add(id) : readyBackends.delete(id)))
        .catch(() => readyBackends.delete(id))
    )
  ).then(sendChatModels)
}

export async function handleChatSetModel(id: string): Promise<void> {
  if (id === AUTO_CHAT_MODEL) PREFS.setSelectedModel('')
  const backend = id === AUTO_CHAT_MODEL ? 'mightymouse' : id
  if (!(Object.keys(BACKENDS) as string[]).includes(backend)) return
  await switchBackend(backend)
  sendChatModels()
}

export function handleChatSendMsg(msg: Msg<'chatSend'>): void {
  void handleChatSend(msg.sessionId, msg.text, msg.projectId)
}

export function handleRelayRespond(msg: Msg<'relayRespond'>): void {
  const { via, dismissed, ...response } = msg.response
  // Dismiss is a separate store call, never a response field: a cleared
  // card must not be able to carry an answer with it.
  if (dismissed === true) {
    relayRequestStore.dismiss(msg.requestId, 'phone')
    return
  }
  const outcome = relayRequestStore.resolve(msg.requestId, response, 'phone', via)
  // Only the REFUSALS come back. A successful answer needs no ack -- the
  // 'changed' event this triggers already drops the card everywhere. But
  // that event cannot say whose answer lost the race, and a phone that
  // typed a reply which was silently discarded looks like a broken button.
  // 'buffered' is a multi-question ask holding this answer and waiting for
  // the next one -- a success mid-interview, not a refusal. Reporting it
  // here would paint "your answer was discarded" over a working card.
  if (outcome !== 'resolved' && outcome !== 'buffered') {
    sendToPhone({ type: 'relayRefused', requestId: msg.requestId, kind: outcome })
  }
}

export function handleRelayTapTrace(msg: Msg<'relayTapTrace'>): void {
  // Validated, never passed through: both fields are attacker-controllable
  // over the tunnel and land in a file a human then reads. The id is
  // truncated for the same reason -- it is a log line, not a lookup key.
  const outcome = RELAY_TAP_OUTCOMES.find((o) => o === msg.outcome)
  if (!outcome || typeof msg.requestId !== 'string' || msg.requestId === '') return
  recordJournal('relay-tap', { detail: `${outcome}: ${msg.requestId.slice(0, 40)}` })
}

export function handleRelayUndismiss(msg: Msg<'relayUndismiss'>): void {
  // Same refusal channel as a lost answer: the window closing is exactly
  // the "too late, it already went through" case that message exists for.
  if (!relayRequestStore.undismiss(msg.requestId)) {
    sendToPhone({
      type: 'relayRefused',
      requestId: msg.requestId,
      kind: 'already-resolved'
    })
  }
}

export function handleRelayGetPushFilter(): void {
  sendToPhone({
    type: 'relayPushFilter',
    filter: PREFS.getAgentRelayPushFilter(),
    notifyLevel: PREFS.getAgentRelayNotifyLevel(),
    turnEndPing: PREFS.getAgentRelayTurnEndPing()
  })
}

export function handleRelaySetPushFilter(
  msg: Msg<'relaySetPushFilter'>,
  setRelayPushVerb: (verb: typeof msg.verb, on: boolean) => void
): void {
  // A non-boolean would coerce to `false` downstream and silently mute a verb.
  if (typeof msg.on !== 'boolean') return
  setRelayPushVerb(msg.verb, msg.on)
}

export function handleRelaySetNotifyLevel(
  msg: Msg<'relaySetNotifyLevel'>,
  setRelayNotifyLevel: (level: 'all' | 'problems') => void
): void {
  // Anything but the two known values would fall through to 'all' in PREFS,
  // silently un-muting instead of failing.
  if (msg.level !== 'all' && msg.level !== 'problems') return
  setRelayNotifyLevel(msg.level)
}

export function handleRelaySetTurnEndPing(
  msg: Msg<'relaySetTurnEndPing'>,
  setRelayTurnEndPing: (on: boolean) => void
): void {
  if (typeof msg.on !== 'boolean') return
  setRelayTurnEndPing(msg.on)
}

export function handleRelaySessionPeek(msg: Msg<'relaySessionPeek'>): void {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  const session = listedAgentSessions().find(
    (s) => s.label === msg.label || s.stated === msg.label
  )
  void capturePaneTail(session?.origin).then((preview) => {
    // Always answers, even empty. Returning silently here left the phone's
    // refresh with nothing to resolve against, so a failed capture and a
    // quiet agent both read as the button doing nothing at all.
    if (!preview) {
      sendToPhone({ type: 'relaySessionPreview', label: msg.label, preview: '', outcome: 'unavailable' })
      return
    }
    const seenBefore = previewIsUnchanged(msg.label, preview)
    sendToPhone({
      type: 'relaySessionPreview',
      label: msg.label,
      preview,
      changedAt: previewChangedAt(msg.label, preview),
      outcome: seenBefore ? 'unchanged' : 'changed'
    })
  })
}

export function handleRelaySessionReply(msg: Msg<'relaySessionReply'>): void {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  if (typeof msg.text !== 'string') return
  const text = msg.text.trim().slice(0, CONFIG.PHONE_REMOTE.CHAT_MESSAGE_MAX_CHARS)
  // An attached photo IS a message, so a bare attachment with no words still
  // sends. The empty-text guard therefore has to run after the path is claimed,
  // not before it.
  const imagePath = takeReplyImagePath(msg.label)
  if (!text && !imagePath) return
  const session = resolveSessionRef(msg.label)
  if (!session || session.staleSince !== undefined) return
  // The path goes FIRST, on its own line: both CLIs read an image by being given
  // somewhere to read it from, and a path buried after prose reads as part of
  // the sentence. This is the one hop that carries the picture -- the bytes
  // never reach the agent, only the file they were written to.
  void sendToSession(session, text, imagePath ? [imagePath] : [], { echoLabel: msg.label })
}

export function handleRelaySessionStop(msg: Msg<'relaySessionStop'>): void {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  const session = resolveSessionRef(msg.label)
  if (!session || session.staleSince !== undefined) return
  void sendPaneKeys(session.origin, [{ key: 'Escape' }]).then((ok) => {
    devLog.log(`[phone-remote] session stop label=${msg.label} ok=${ok}`)
    // An Esc interrupt fires no Stop hook, so the row would read busy until BUSY_MAX_MS.
    if (ok) setAgentSessionBusy(session.sessionId, false)
  })
}

// Label-only, like reply: the resolver shells out to raise apps, so what it
// acts on comes from the listener's list, never from the wire.
export function handleRelaySessionReveal(msg: Msg<'relaySessionReveal'>): void {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  const label = msg.label
  const session = resolveSessionRef(label)
  if (!session?.origin) {
    sendToPhone({ type: 'relaySessionRevealed', label, ok: false })
    return
  }
  void resolveOrigin(session.origin).then((via) => {
    sendToPhone({ type: 'relaySessionRevealed', label, ok: via !== 'none' })
  })
}

// Label-only for the same reason as reveal. `on` is the wanted state rather
// than a toggle, so the phone and the Mac cannot disagree about which way a tap
// went when a pane was already zoomed from the keyboard.
export function handleRelaySessionZoom(msg: Msg<'relaySessionZoom'>): void {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  if (typeof msg.on !== 'boolean') return
  const { label, on } = msg
  const session = resolveSessionRef(label)
  if (!session?.origin?.tmuxPane) {
    sendToPhone({ type: 'relaySessionZoomed', label, on: !on, ok: false })
    return
  }
  void setTmuxZoom(session.origin, on).then((ok) => {
    sendToPhone({ type: 'relaySessionZoomed', label, on: ok ? on : !on, ok })
  })
}

// No reply on a rejected input: suggestions are an enhancement, and a card
// with none renders exactly as it did before this existed.
export function handleRelaySuggest(msg: Msg<'relaySuggest'>): void {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  if (typeof msg.tldr !== 'string' || msg.tldr.trim() === '') return
  void suggestForSession(msg.label, msg.tldr)
}

// Answers on the ASK, not the close: the escalation behind it runs for up
// to a minute, and holding the phone's toast open that long would say
// "still working" about a session that finished in three seconds.
export function handleRelaySessionWrap(msg: Msg<'relaySessionWrap'>): void {
  if (typeof msg.label !== 'string' || msg.label.trim() === '') return
  const label = msg.label
  void startSessionWrap(label, 'phone').then(
    (started) => {
      sendToPhone({
        type: 'relaySessionWrapped',
        label,
        ok: started.ok,
        reason: started.ok ? undefined : started.reason
      })
      if (started.ok) {
        void started.done.then((outcome) =>
          devLog.log('[phone-remote] wrap finished', { label, outcome })
        )
      }
    },
    (err) => {
      devLog.error('[phone-remote] wrap failed', err)
      sendToPhone({ type: 'relaySessionWrapped', label, ok: false, reason: 'unreachable' })
    }
  )
}

export function handleChatStop(msg: Msg<'chatStop'>): void {
  if (typeof msg.sessionId !== 'string' || msg.sessionId === '') return
  const session = MIGHTY.getSession(msg.sessionId)
  const runId = session?.runId
  // Already settled (or never started): the turn's own chatTurnDone has
  // either landed or is about to. Nothing to kill, and nothing to push --
  // a stop that lost the race must look exactly like one that won.
  if (runId === undefined) return
  // abortRun SIGKILLs the process group; runMighty's close handler resolves
  // the turn and handleChatSend sends the chatTurnDone that settles the
  // phone's spinner, same as any other ending.
  const killed = abortRun(runId)
  EVENTS.append({ run_id: runId, event: 'run_stopped' })
  track(ANALYTICS_EVENT.run_stopped, { killed: killed ? 1 : 0 })
  // Nothing alive to kill: the run died with a previous app lifetime, so no
  // close handler will ever send the chatTurnDone that clears the spinner.
  // Stop settles it here or the thread stays stuck through every future tap.
  if (!killed) {
    MIGHTY.resolveTurn(msg.sessionId, runId, {
      a: CONFIG.MIGHTY.STOPPED_REPLY,
      ok: false,
      ts: new Date().toISOString()
    })
    sendToPhone({
      type: 'chatTurnDone',
      sessionId: msg.sessionId,
      ok: false,
      reply: CONFIG.MIGHTY.STOPPED_REPLY
    })
  }
}
