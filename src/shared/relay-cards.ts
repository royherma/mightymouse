/**
 * Card MEANING shared by both Code surfaces, phone and Mac: grouping, verb
 * wording, outcome. Pure functions only -- they look deliberately different, and
 * a copy of "Approval needed" in a second file is how the two start disagreeing.
 */

import type { RelayRequestWire, RelayVerbWire } from './phone-remote-protocol'

/** Named, never blank: a card whose identity failed to arrive must not look
 *  like one that simply has no chip. */
export const UNKNOWN_SENDER = 'Unknown agent'

/** At 1/4 of the timeout left, the deadline is the useful fact and the card
 *  switches from how long it has waited to how long is left. */
export const URGENT_FRACTION = 0.25

export interface SenderGroup {
  key: string
  from?: string
  requests: RelayRequestWire[]
}

/** Oldest-first, groups included: whatever has blocked an agent longest is
 *  answered first, and a later card never pushes an older one down. */
export function groupBySender(pending: RelayRequestWire[]): SenderGroup[] {
  const byKey = new Map<string, SenderGroup>()
  for (const request of pending) {
    const from = request.params.from
    const key = from ?? ''
    const group = byKey.get(key)
    if (group) group.requests.push(request)
    else byKey.set(key, { key, from, requests: [request] })
  }
  for (const group of byKey.values()) group.requests.sort((a, b) => a.createdAt - b.createdAt)
  return [...byKey.values()].sort((a, b) => a.requests[0].createdAt - b.requests[0].createdAt)
}

/** Prefixed onto every surface's card heading rather than typed into a title by
 *  the sender: a drill's own words are the untrustworthy part ("drop the prod
 *  table" reads identically either way), and a marker only some screens show
 *  makes the unmarked ones look verified. */
const TEST_BADGE = 'TEST'

/** The one place the marker is applied. Surfaces word their own headings --
 *  the HUD asks what's wanted OF YOU ("Needs your decision"), the cards name
 *  the verb -- so they share the badge, not the sentence. */
export function markTest(heading: string, test?: boolean): string {
  return test ? `[${TEST_BADGE}] ${heading}` : heading
}

function bareVerbLabel(verb: RelayVerbWire): string {
  return verb === 'ask' ? 'Question' : verb === 'approve' ? 'Approval needed' : 'Sent to you'
}

export function verbLabel(verb: RelayVerbWire, test?: boolean): string {
  return markTest(bareVerbLabel(verb), test)
}

/** `info` is omitted on purpose: a marker on every routine update stops reading
 *  as a signal on the ones that matter. Duplicated in two runtimes that cannot
 *  import this file -- the NSE's `levelPrefix` (Swift) and the push function's
 *  `LEVEL_PREFIX` (Deno). Change one, change all three. */
const LEVEL_EMOJI: Record<string, string> = {
  success: '✅',
  warn: '⚠️',
  error: '🛑'
}

/** Null, never a fallback glyph: an unrecognised level must not invent a
 *  severity the sender did not send. */
export function levelEmoji(level?: string): string | null {
  return (level && LEVEL_EMOJI[level]) ?? null
}

/** `[TEST] 🛑 Sent to you` -- badge leftmost, matching the NSE and the push
 *  function, so it survives iOS truncating a long heading. */
export function levelHeading(
  verb: RelayVerbWire,
  level?: string,
  test?: boolean
): string {
  const emoji = levelEmoji(level)
  const label = bareVerbLabel(verb)
  return markTest(emoji ? `${emoji} ${label}` : label, test)
}

export function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/** Only the two fields the countdown math needs -- widened from RelayRequestWire
 *  so the HUD's HudRelayCard (a different DTO, same two facts) can reuse this
 *  without either faking the rest of the wire shape or forking a copy. */
export function waitingLabel(
  request: Pick<RelayRequestWire, 'createdAt' | 'timeoutMs'>,
  now: number
): { text: string; urgent: boolean } | null {
  if (request.timeoutMs <= 0) return null
  const elapsed = Math.max(0, now - request.createdAt)
  const remaining = Math.max(0, request.createdAt + request.timeoutMs - now)
  const urgent = remaining <= request.timeoutMs * URGENT_FRACTION
  const text = urgent
    ? remaining === 0
      ? 'Timed out'
      : `Times out in ${formatDuration(remaining)}`
    : `Asked ${formatDuration(elapsed)} ago`
  return { text, urgent }
}

/** A card answered on the OTHER surface has to explain itself here rather than
 *  just vanishing.
 *
 *  Written from the READER's side ("You approved"), because the whole question
 *  a Previous card answers is "what did I do about this?" -- a bare "Approved"
 *  reads like a status the system reached on its own. */
export function resolvedOutcome(request: RelayRequestWire): string {
  const { response, status, verb } = request
  if (status === 'timedout') return 'Timed out before anyone answered'
  // Checked BEFORE the approved:false branch. A dismissed approve carries
  // approved:false so the agent is safe by default, but "Declined" would claim
  // the human made a call they explicitly did not make -- the whole point of
  // clearing a card is that it is not an answer.
  if (status === 'dismissed') return 'You cleared it without answering'
  if (response?.approved === true) return 'You approved it'
  if (response?.approved === false) return 'You said no'
  // Quoted, so a one-word answer ("yes") reads as something the user SAID and
  // not as a label the app chose.
  if (response?.answer) return `You said "${response.answer}"`
  if (response?.acked) return 'You marked it seen'
  // A notify resolves the instant it is minted -- nobody ever answered it, and
  // calling that "Answered" was the whole reason a wall of identical Previous
  // cards all claimed an answer nobody gave.
  if (verb === 'notify') return 'Delivered'
  return 'Answered'
}

/** When the card stopped being open, as "4m ago". Falls back to `createdAt`
 *  only for a still-pending card, where the two are the same question.
 *
 *  Deliberately NOT a "answered on your phone" line: `resolvedVia` names which
 *  CONTROL produced the answer, not which device, and the only field that knows
 *  the device (`resolvedBy`) is a hashed id. Saying "on your phone" from `via`
 *  would be a guess dressed as a fact. */
export function resolvedWhen(request: RelayRequestWire, now: number): string {
  const at = request.resolvedAt ?? request.createdAt
  const mins = Math.floor(Math.max(0, now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** What one agent has actually done, counted off the cards it sent. */
export interface SessionActivity {
  total: number
  waiting: number
  /** Median createdAt→resolvedAt, ms. Null rather than 0 when nothing carries a
   *  `resolvedAt`, so "not known" cannot read as "answered instantly". */
  medianReplyMs: number | null
  lastSummary?: string
  lastAt?: number
  /** A subject INFERRED from this session's cards, for the overwhelming majority
   *  of sessions that never call `recap` (measured 2026-08-15: 4 declared TLDRs
   *  against 1264 named sessions). Never carries the TLDR chip -- derived is not
   *  declared, and a row that claims otherwise is lying about where it came from. */
  derivedSubject?: string
}

/** Median, not mean: one card left overnight otherwise drags the figure and
 *  makes a responsive agent look slow. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Two lines on a card that already carries a label, a model and a count. */
const SUBJECT_MAX_CHARS = 120

/**
 * The best subject this session's cards can name, for a session that never
 * declared one: the newest NON-notify card. An ask/approve/show names a decision
 * about the work ("The llm-proxy fix touches billing code"), which survives as a
 * subject; a notify names an event ("tests are green"), which does not.
 *
 * Falling back to a notify's BODY, though, because the alternative in practice
 * is nothing: the idle ping every Claude hook sends titles itself "Your Turn"
 * and puts the actual sentence in `body`, so a deck of sessions that only ever
 * notified rendered the same constant on every card. The body is the agent's
 * own words about what it just did -- a worse subject than a decision, and a far
 * better one than a fixed string.
 */
function deriveSubject(mine: readonly RelayRequestWire[]): string | undefined {
  let card: RelayRequestWire | undefined
  let notify: RelayRequestWire | undefined
  for (const r of mine) {
    if (r.verb === 'notify') {
      if (!notify || r.createdAt > notify.createdAt) notify = r
      continue
    }
    if (!card || r.createdAt > card.createdAt) card = r
  }
  return (card && cardSummary(card).trim()) || firstSentence(notify?.params.body) || undefined
}

/** A notify body is a paragraph; a card subject is one line. Sentences up to the
 *  budget rather than the FIRST one: agents open on a verdict ("Done.", "Build
 *  clean."), so stopping at the first period left every card on a two-word
 *  fragment and handed the suggestion prompt nothing to work with. */
function firstSentence(body: string | undefined): string | undefined {
  const flat = body?.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  if (flat.length <= SUBJECT_MAX_CHARS) return flat
  // Last boundary inside the budget, so it ends on a sentence when it can and
  // on a whole word when the first sentence is itself longer than the budget.
  const head = flat.slice(0, SUBJECT_MAX_CHARS)
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  if (stop > 0) return head.slice(0, stop + 1)
  const word = head.lastIndexOf(' ')
  return `${(word > 0 ? head.slice(0, word) : head).trimEnd()}…`
}

/** The shim registers "repo - tag" while the Claude hooks send "repo · tag", so
 *  an exact join matched 0 of 41 live sessions (24 once normalised) and every
 *  session read as having spoken zero times. Normalised here, not at either
 *  producer: the hooks are shell files outside the repo. */
export function senderMatchKey(from: string | undefined): string {
  // The SPACED separator only -- session names are full of internal hyphens
  // ("phone-remote-reconnect-grace-period") that a bare rule would collapse.
  return (from ?? '')
    .replace(/ · /g, ' - ')
    .trim()
    .toLowerCase()
}

/** Counts only what is still in the snapshot -- the resolved tail is capped
 *  (RELAY_RESOLVED_TAIL), so a surface wording `total` as all-time overclaims.
 *  `derivedSubject` inherits that cap: a long session's early cards fall off, so
 *  the subject drifts toward recent work, which is the behaviour we want anyway. */
export function sessionActivity(from: string, requests: readonly RelayRequestWire[]): SessionActivity {
  const want = senderMatchKey(from)
  const mine = requests.filter((r) => senderMatchKey(r.params.from) === want)
  const replies: number[] = []
  let last: RelayRequestWire | undefined
  let waiting = 0
  for (const r of mine) {
    if (r.status === 'pending') waiting++
    // notify resolves on mint, so its round-trip is always ~0 and would pull the
    // median toward zero while saying nothing about how fast anyone replied.
    if (r.verb !== 'notify' && r.resolvedAt) replies.push(Math.max(0, r.resolvedAt - r.createdAt))
    if (!last || r.createdAt > last.createdAt) last = r
  }
  return {
    total: mine.length,
    waiting,
    medianReplyMs: median(replies),
    lastSummary: last ? cardSummary(last) || undefined : undefined,
    lastAt: last?.createdAt,
    derivedSubject: deriveSubject(mine)
  }
}

/** Everything that is over, newest first: answered and cleared in one list.
 *
 *  Cleared cards do NOT get their own tab. A tab is empty almost always, and
 *  the question a user actually has -- "what happened to that card?" -- has one
 *  answer whether they answered it or cleared it. `resolvedOutcome` already
 *  says which, and only a cleared card renders an Undo.
 *
 *  notify is excluded. It resolves the instant it is minted, so every banner an
 *  agent ever sent landed here and buried the handful of cards that were
 *  actually a question -- Previous read as full while Needs you read as empty.
 *  The filter belongs HERE and not in `relaySnapshot`: a notification tap looks
 *  its id up in `resolved` (CodeSheet's focus effect), so dropping notify from
 *  the wire would make every tapped banner open nothing. */
export function previousList(
  resolved: RelayRequestWire[],
  dismissed: RelayRequestWire[]
): RelayRequestWire[] {
  return [...resolved, ...dismissed]
    .filter((r) => r.verb !== 'notify')
    .sort((a, b) => previousOrderAt(b) - previousOrderAt(a))
}

/** When a Previous card ENDED -- sorting by `createdAt` sank a card you just
 *  answered below one asked and answered while it sat there waiting. Same key
 *  the Mac's store sorts by, so the two surfaces cannot disagree. */
function previousOrderAt(request: RelayRequestWire): number {
  return request.resolvedAt ?? request.createdAt
}

/** Why the store refused an answer. Shared so both surfaces phrase it the same
 *  way -- the protection is server-side and identical, so the explanation
 *  should be too. */
export interface RelayRefusal {
  requestId: string
  kind: 'already-resolved' | 'unknown'
}

/** What to tell someone whose answer did not count. The store has always
 *  refused these correctly; without this the card just reappeared and the tap
 *  looked like it did nothing.
 *
 *  Deliberately does not distinguish "answered elsewhere" from "timed out
 *  first": the store returns the same 'already-resolved' for both, and
 *  guessing which one it was would be a claim we cannot support. */
export function refusalMessage(refusal: RelayRefusal): string {
  return refusal.kind === 'unknown'
    ? 'That request is gone. Your agent stopped waiting.'
    : 'Already answered somewhere else. Your answer was not used.'
}

/** How a surface orders the pending list. 'priority' leads because the list is
 *  a queue of BLOCKED agents, not a feed -- the thing that is hardest to undo
 *  and has waited longest is the one to answer first. */
export type RelaySort = 'priority' | 'newest'

/** 'all', or exactly one verb. Deliberately not a multi-select set: three verbs
 *  make every subset either "all" or "one", and a checkbox group would cost a
 *  screenful to say the same thing. */
export type RelayFilter = 'all' | RelayVerbWire

export const RELAY_SORTS: readonly RelaySort[] = ['priority', 'newest']
export const RELAY_FILTERS: readonly RelayFilter[] = ['all', 'approve', 'ask', 'notify']

export function sortLabel(sort: RelaySort): string {
  return sort === 'priority' ? 'Most urgent' : 'Newest'
}

export function filterLabel(filter: RelayFilter): string {
  if (filter === 'all') return 'Everything'
  return filter === 'ask' ? 'Questions' : filter === 'approve' ? 'Approvals' : 'Updates'
}

/** Higher wins. Risk first because an approve is the only card that can do
 *  damage by being answered late, then ask (an agent is parked on it), then
 *  notify (nothing is waiting -- it is a message, not a question). */
function priorityRank(request: RelayRequestWire): number {
  if (isHighRisk(request)) return 3
  if (request.verb === 'approve') return 2
  return request.verb === 'ask' ? 1 : 0
}

/** Never mutates its input -- callers pass the live snapshot array straight
 *  from the store's push. */
export function sortRequests(pending: readonly RelayRequestWire[], sort: RelaySort): RelayRequestWire[] {
  const rows = [...pending]
  if (sort === 'newest') return rows.sort((a, b) => b.createdAt - a.createdAt)
  // Oldest-first WITHIN a rank: among equally risky cards, the one that has
  // blocked its agent longest is the more urgent, which is the opposite of the
  // 'newest' tiebreak and the whole reason these are two sorts.
  return rows.sort((a, b) => priorityRank(b) - priorityRank(a) || a.createdAt - b.createdAt)
}

export function filterRequests(
  pending: readonly RelayRequestWire[],
  filter: RelayFilter
): RelayRequestWire[] {
  return filter === 'all' ? [...pending] : pending.filter((r) => r.verb === filter)
}

/** What to say when a filter, not an empty inbox, is why nothing is showing.
 *  Null when the list is genuinely empty, so the caller keeps its real empty
 *  state -- "nothing matches Approvals" on a first run would be a lie. */
/** One card needs no ordering, but a narrowed filter must ALWAYS keep its own
 *  escape hatch: the choice persists, so a filter set days ago plus one
 *  non-matching card hid the only control that could clear it. */
export function viewBarVisible(pendingCount: number, filter: RelayFilter): boolean {
  return pendingCount > 1 || filter !== 'all'
}

export function filteredEmptyNote(hiddenCount: number, filter: RelayFilter): string | null {
  if (hiddenCount <= 0 || filter === 'all') return null
  const n = hiddenCount
  return `Hiding ${n} ${n === 1 ? 'card' : 'cards'}. Showing ${filterLabel(filter).toLowerCase()} only.`
}

export function cardSummary(request: RelayRequestWire): string {
  const { params } = request
  return params.question ?? params.action ?? params.caption ?? params.title ?? ''
}

export function isHighRisk(request: RelayRequestWire): boolean {
  return request.verb === 'approve' && request.params.risk === 'high'
}

/** The Notification hook's waiting ping. Settles on send, so it never belongs
 *  on Needs you -- a tap opens that agent instead. */
export function isIdleNotify(request: RelayRequestWire): boolean {
  return request.verb === 'notify' && request.params.idle === true
}
