import { CONFIG } from './config'
import type {
  AgentOrigin,
  AgentRelaySessionInfo,
  AgentRelayStatus,
  McpClientState
} from './types'

/** How long a mid-turn stamp may claim "Responding…" before it is ignored. Stop
 *  is what clears the stamp and a SIGKILLed agent never fires it, so without a
 *  cap that row would claim it forever — a lying state is strictly worse than
 *  the honest "Connected" it replaced. Long enough to cover a real slow turn.
 *
 *  Lives here rather than in CONFIG because this module imports TYPES ONLY: the
 *  phone bundles it, and reaching into config.ts would pull the whole app config
 *  into that build. */
export const BUSY_MAX_MS = 10 * 60_000

/** How long a session may claim "Responding…" on the strength of its last proof
 *  of work. Short on purpose: the tool-use ping refreshes it every few seconds,
 *  so this only has to outlast one slow tool call (a long build, a big test run)
 *  plus the fire-and-forget hook's own `timeout 3`. That is what lets the crash
 *  case decay in ~2 minutes instead of the 10 a turn-start stamp had to allow. */
export const ACTIVITY_MAX_MS = 2 * 60_000

/** Is this session mid-turn RIGHT NOW? The one answer -- the card deck asked it
 *  separately and got a different one, so a working agent still got dealt.
 *
 *  Two windows, because the two stamps prove different things. A refreshed
 *  activity stamp is strong evidence and gets the SHORT window, so an agent
 *  grinding autonomously stays "Responding…" through an hour-long run while a
 *  killed one decays in two minutes. A lone `busySince` from a shim that never
 *  pings is weak and keeps the old long cap, so an older setup is unchanged. */
export function sessionIsCompacting(
  session: Pick<AgentRelaySessionInfo, 'compactingSince'>,
  now: number
): boolean {
  return session.compactingSince !== undefined && now - session.compactingSince < BUSY_MAX_MS
}

// Claude Code writes this as a user line when Esc interrupts a turn, and fires no Stop hook.
export function isInterruptMarker(text: string): boolean {
  return text.startsWith('[Request interrupted by user')
}

export function sessionIsWorking(
  session: Pick<AgentRelaySessionInfo, 'busySince' | 'lastActivityAt' | 'compactingSince'>,
  now: number
): boolean {
  if (sessionIsCompacting(session, now)) return true
  if (session.busySince === undefined) return false
  return session.lastActivityAt !== undefined
    ? now - session.lastActivityAt < ACTIVITY_MAX_MS
    : now - session.busySince < BUSY_MAX_MS
}

/** Whether a "go to this agent" action can do ANYTHING for this origin — pure
 *  and synchronous, no shell-out, so a surface can decide whether to offer the
 *  button rather than shelling out just to learn there was nothing to jump to.
 *
 *  Lives in `shared/` because both sides need the same answer: main resolves
 *  the origin, the renderer decides whether to render the button, and the two
 *  disagreeing is how a click ends in a dead end instead of a disabled button.
 *  Mirrors the exact fields `resolveOrigin` acts on. */
export function isOriginResolvable(origin: AgentOrigin | undefined): boolean {
  if (!origin) return false
  return Boolean(
    origin.cmuxWorkspaceId || origin.tmuxPane || origin.cmuxBundleId || origin.hostBundleId
  )
}

/** Composer: tmux pane or shim pid. Jump is `isOriginResolvable`. */
export function sessionCanReply(
  session: Pick<AgentRelaySessionInfo, 'origin' | 'pid'>
): boolean {
  return Boolean(session.origin?.tmuxPane || session.pid)
}

export type RelayHealth = 'off' | 'starting' | 'no-agent' | 'mac-only' | 'ready'

export interface RelayStatusLine {
  health: RelayHealth
  /** Plain-words state, written for someone who has never heard of MCP. */
  text: string
  /** The one thing to do about it, or undefined when nothing is wrong. */
  hint?: string
  /** Same state in a few words, for the chip in the panel head where the full
   *  sentence would eat the tab row. Falls back to `text` when it fits. */
  short?: string
  count: number
  /** Every listed session, including ended ones the Mac remembers. */
  names: AgentRelaySessionInfo[]
}

/**
 * Each open `npx mightymouse-code` lives exactly as long as the session that
 * spawned it, so the count needs no timeout and 0 really means nothing is open.
 * `lastAgentAt` only separates a set-up-but-idle machine from a fresh one.
 */
export function relayStatusLine(
  status: AgentRelayStatus,
  clients: McpClientState[]
): RelayStatusLine {
  const count = status.agentCount ?? 0

  if (!status.enabled) {
    return {
      health: 'off',
      text: 'Turned off.',
      hint: 'Turn on "Let coding agents reach you" in Settings.',
      count: 0,
      names: []
    }
  }
  if (!status.running) {
    return { health: 'starting', text: status.reason ?? 'Starting up…', count: 0, names: [] }
  }

  if (count === 0) {
    // Never called at all vs called before but nothing open now: the first
    // needs setup, the second just needs the user to start coding.
    if (!status.lastAgentAt) {
      const names = clients.map((c) => c.label)
      return {
        health: 'no-agent',
        text: 'Waiting for your first coding agent.',
        short: 'No agent yet',
        hint:
          names.length > 0
            ? `Set up ${listNames(names)} in Settings, then ask it to message you.`
            : 'Set up your coding app in Settings, then ask it to message you.',
        count: 0,
        names: status.agentSessions ?? []
      }
    }
    return {
      health: 'no-agent',
      text: 'Ready. Open a coding agent and it shows up here.',
      short: 'No agents open',
      count: 0,
      names: status.agentSessions ?? []
    }
  }

  // One row per session, never collapsed: the list answers "which agents are
  // open", and a tally hides that two rows are two different terminals.
  const open: AgentRelaySessionInfo[] =
    status.agentSessions ?? (status.agentNames ?? []).map((label) => ({ label }))
  const who = count === 1 ? '1 agent' : `${count} agents`
  if (!status.deviceLabel) {
    return {
      health: 'mac-only',
      text: `${who} can reach you here.`,
      short: `${who}, Mac only`,
      hint: status.reason,
      count,
      names: open
    }
  }
  return {
    health: 'ready',
    text: `${who} can reach you here and on ${status.deviceLabel}.`,
    short: `${who} · ${status.deviceLabel}`,
    count,
    names: open
  }
}

/** Only two states, because only two are honest. The relay knows a session is
 *  connected and it knows how many of its cards are unanswered; the dot claims
 *  nothing beyond that. ("thinking" vs "idle at a prompt" used to be unknowable
 *  too -- `busySince` now answers it, and it is carried on `health` rather than
 *  here, next to the other states that outrank a plain connection.) */
export type SessionState = 'waiting' | 'connected'

export interface SessionRow {
  state: SessionState
  /** Words for the dot — set ONLY when something is actually wanted from the
   *  user. Connected is the resting state of every row in the list, so spelling
   *  it out six times says nothing the green dot has not already said. */
  label?: string
  /** "8:54 AM (24m ago)" — when this session started, absolute first because that
   *  is the half a relative number cannot give you back, with the relative half
   *  in parentheses so the row still answers "recent?" at a glance. Drops the
   *  date for a session started today, which is nearly all of them. */
  started?: string
  lastReply?: string
  /** "14m" — how long the session has been HANDED BACK, measured from the moment
   *  it stopped rather than from when a card was minted, so an agent idling at a
   *  prompt with no question still shows one. Answers the only question `age`
   *  cannot: how long this has been ignored. Seconds-granular at the bottom,
   *  unlike `age` — a row that just went quiet is exactly the one being scanned
   *  for, so blanking it for the first minute hides the freshest handoff. */
  waitAge?: string
  /** Line 1 when the session has a name of its own: "mm-dev-735". A name a
   *  person or a hook chose beats a repo every row in the list already shares,
   *  so it takes the line and the repo steps down to line 2. */
  name?: string
  /** Live and still waiting on its real name: draw a skeleton, not `name`. */
  unnamed?: boolean
  /** Line 1, the thing you scan for when nothing better exists: "ShowAndTell". */
  repo: string
  /** Line 1 next to the repo, because which branch a session sits on is the
   *  most common reason two rows differ. */
  branch?: string
  /** Line 2: what tells THIS pane from the other five in the same checkout —
   *  a short id head, or the pid, when the row has no name to go by. */
  detail?: string
  /** Line 2 for a NAMED row: the checkout its name displaced off line 1. The
   *  name says which pane; this says which code it is sitting in. */
  place?: string
  /** Line 2, only when the folder is not the repo the name already states —
   *  a worktree, or a checkout whose folder was renamed. */
  where?: string
  /** Which coding agent is running, in the casing a person writes it ("Claude
   *  Code", not "claude-code"). Undefined for a shim too old to report it, in
   *  which case the card shows no chip at all rather than "unknown". */
  agent?: string
  /** The agent's reasoning effort, same absence rule as `agent`. */
  effort?: string
  /** Which model is running, in the words a person says: "Opus 5". Same absence
   *  rule -- a shim that cannot resolve one sends nothing, and every surface
   *  then shows no model rather than a guess. */
  model?: string
  /** What this session is ABOUT, one plain line the agent declared via `recap`
   *  ("porting the phone list to the new grouping API"). Every other field here
   *  answers WHICH session; this is the only one that answers WHAT IT IS DOING,
   *  which is what tells six panes in one checkout apart. Absent until an agent
   *  declares one -- and then the row renders exactly as it did before. */
  tldr?: string
  /** Who MAKES the agent, as a ProviderIcon id, so a surface can draw the
   *  vendor's logo. Undefined for an editor that fronts several vendors, which
   *  then draws its own neutral fallback. */
  vendor?: string
  /** The footer's whole state sentence: "Connected", "Waiting on you · 2", or
   *  "Ended 3m ago". Built here so the two surfaces cannot word it differently —
   *  they each had their own copy of this ternary before. */
  state_text: string
  /** What the footer's colour keys on. Separate from `state`: ended outranks a
   *  waiting card, and 'your-turn' (unread idle "ready for you" ping) sits
   *  below waiting — one has a button, the other only news. 'working' sits
   *  below both: something needing a human always outranks something merely
   *  in progress. It renders as "Responding…", never the word 'working'. */
  health: 'connected' | 'working' | 'your-turn' | 'waiting' | 'ended'
}

/** Words a slug flattens that a person would not: "ios" must not read "Ios". */
const SLUG_WORDS: Record<string, string> = {
  iphone: 'iPhone',
  ipad: 'iPad',
  ios: 'iOS',
  macos: 'macOS',
  oauth: 'OAuth',
  api: 'API',
  ui: 'UI',
  url: 'URL',
  mcp: 'MCP',
  ai: 'AI',
  id: 'ID',
  wip: 'WIP',
  ws: 'WS',
  db: 'DB',
  cli: 'CLI',
  pr: 'PR',
  prd: 'PRD',
  seo: 'SEO',
  npm: 'npm',
  tldr: 'TLDR'
}

/** Checked before the per-word map: "mighty mouse" is one product name split
 *  across two slug words, so no per-word rule can reach it. */
const SLUG_PHRASES: [RegExp, string][] = [
  [/\bmighty ?mouse\b/gi, 'MightyMouse'],
  [/\bapp store\b/gi, 'App Store'],
  [/\bclaude code\b/gi, 'Claude Code']
]

/** Slugs are written for filenames, not for reading: the hook publishes
 *  "iphone-model-naming-discrepancy" and the row showed it verbatim. */
/** Line 2 earns its row only by saying something line 1 did not: the recap is
 *  generated from the same prompt as the name, so it often just restates it.
 *  Callers that ask whether a session SPOKE must read `tldr`, not this. */
export function recapLine(row: { name?: string; tldr?: string }): string | undefined {
  const text = row.tldr?.trim()
  if (!text) return undefined
  const cased = text.charAt(0).toUpperCase() + text.slice(1)
  const name = row.name
  if (!name) return cased
  if (cased === name) return undefined
  const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[a-z0-9]+/g) ?? [])
  const nameWords = words(name)
  const fresh = [...words(cased)].filter((w) => !nameWords.has(w))
  return fresh.length < 2 ? undefined : cased
}

export function readableName(slug: string | undefined): string | undefined {
  if (!slug) return undefined
  // A handle carries a number ("mm-dev-719") and is something a person types or
  // says out loud. Spacing it out makes it unsearchable, so it stays verbatim.
  if (/\d/.test(slug)) return slug
  let spaced = slug.replace(/[-_]+/g, ' ').trim()
  if (!spaced) return undefined
  for (const [re, name] of SLUG_PHRASES) spaced = spaced.replace(re, name)
  const words = spaced.split(' ').map((w) => SLUG_WORDS[w.toLowerCase()] ?? w)
  const [first, ...rest] = words
  const head = SLUG_WORDS[first.toLowerCase()] ? first : first.charAt(0).toUpperCase() + first.slice(1)
  return [head, ...rest].join(' ')
}

/** The shim sends whatever the agent calls itself, lowercase and hyphenated.
 *  Mapped rather than title-cased because "Claude Code" and "VS Code" are names
 *  with their own casing, not words. Anything unrecognised passes through as
 *  sent -- a new agent should read as itself, never as "Unknown". */
const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  aider: 'Aider'
}

export function agentLabel(agent: string | undefined): string | undefined {
  const key = agent?.trim().toLowerCase()
  if (!key) return undefined
  return AGENT_LABELS[key] ?? AGENT_LABELS[agentKey(key) ?? ''] ?? agent?.trim()
}

/** Which agent a raw `AI_AGENT` string is, ignoring the build suffix the cmux
 *  wrapper appends: it sends "claude-code_2-1-232_agent", not "claude-code", so
 *  an exact lookup misses every real session. Longest key first, or "claude"
 *  would win over "claude-code" on the same string. */
function agentKey(raw: string): string | undefined {
  return Object.keys(AGENT_LABELS)
    .sort((a, b) => b.length - a.length)
    .find((k) => raw.startsWith(k))
}

/** Who MAKES the agent, as a `ProviderIconId` the renderer can draw a logo for.
 *  Separate from the agent itself because the two are different questions: a
 *  card says "Claude Code" (the tool) and shows the Anthropic mark (the vendor),
 *  and several tools share one vendor.
 *
 *  Undefined for anything unrecognised — the surface then draws its own fallback
 *  rather than claiming a vendor we did not identify. */
export function agentVendor(agent: string | undefined): string | undefined {
  const raw = agent?.trim().toLowerCase()
  if (!raw) return undefined
  const key = AGENT_LABELS[raw] ? raw : agentKey(raw)
  if (!key) return undefined
  return AGENT_VENDORS[key]
}

/** One vendor per agent id. Cursor/VS Code/Windsurf/Aider are editors that
 *  front several models, so they get no vendor mark rather than a wrong one. */
const AGENT_VENDORS: Record<string, string> = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex'
}

/**
 * The shim packs everything it knows into one string: "repo/branch - tag",
 * where the tag is a host-set name (CLAUDE_SESSION_NAME) or an 8-char session-id
 * head (npm-shim `sessionTag()`). Presence sends nothing else, so splitting this
 * IS the only way to get a repo, a branch, and a per-pane detail onto the row.
 */
export function splitIdentity(label: string): {
  repo: string
  branch?: string
  tag?: string
} {
  // Right-most " - " only: a repo can contain " - " and a branch cannot, since
  // the shim builds "repo/branch" first and appends the tag last.
  const cut = label.lastIndexOf(' - ')
  const where = cut === -1 ? label : label.slice(0, cut)
  const tag = cut === -1 ? undefined : label.slice(cut + 3).trim() || undefined

  const slash = where.indexOf('/')
  return slash === -1
    ? { repo: where.trim(), tag }
    : { repo: where.slice(0, slash).trim(), branch: where.slice(slash + 1).trim() || undefined, tag }
}

/** A hex id is the shim's fallback tag, not something a person chose. Both
 *  lengths count: the full 8 chars as the shim sends them, and the 4-char head
 *  the row shortens them to once a real name is doing the identifying. */
const SESSION_ID = /^[0-9a-f]{4}(?:[0-9a-f]{4})?$/i

const rowCache = new WeakMap<AgentRelaySessionInfo, { now: number; row: SessionRow }>()
const agelessRowCache = new WeakMap<AgentRelaySessionInfo, SessionRow>()

export function sessionRow(session: AgentRelaySessionInfo, now: number): SessionRow {
  if (now === 0) {
    const ageless = agelessRowCache.get(session) ?? buildSessionRow(session, 0)
    agelessRowCache.set(session, ageless)
    return ageless
  }
  const cached = rowCache.get(session)
  if (cached?.now === now) return cached.row
  const row = buildSessionRow(session, now)
  rowCache.set(session, { now, row })
  return row
}

function buildSessionRow(session: AgentRelaySessionInfo, now: number): SessionRow {
  const waiting = session.waiting ?? 0
  const { repo, branch, tag } = splitIdentity(session.label)
  const stated = session.stated?.trim()

  // "Ended" outranks "waiting": a dropped socket is not waiting on anything,
  // whatever it was doing a moment ago. Both surfaces had their own copy of this
  // ternary, which is exactly how two surfaces drift.
  // Bare duration: the caller words it as "Ended 3m ago", so the suffix would
  // double up. Still blank under a minute, where "Ended" alone is the honest read.
  const endedAge =
    session.staleSince && now - session.staleSince >= 60_000
      ? relativeAge(now - session.staleSince).replace(' ago', '')
      : undefined
  // A turn that started but never ended is a CRASH, not a long think: Stop is
  // what clears the stamp, and a SIGKILLed agent never fires it. Expiring here,
  // at render time, means no timer has to run and a wedged row decays to
  // Connected on its own -- an honest "Connected" beats a lying "Responding…".
  //
  const working = sessionIsWorking(session, now)
  // A handoff is SPENT the moment the next turn starts: nothing clears idleSince
  // (it is the newest idle notify per sender, store.ts:370), so a session that
  // went back to work kept claiming "Handed back" while it was actively writing.
  // Compared by stamp rather than by a fixed rank -- the newer edge is the true
  // one in BOTH directions, and either order alone gets one of the two wrong.
  // Only a LIVE turn spends it: an expired stamp is a crashed agent, and letting
  // that bury the handoff would hide the row that most needs answering.
  const yourTurn =
    session.idleSince !== undefined &&
    !(working && session.busySince !== undefined && session.busySince > session.idleSince)
  const health = session.stale
    ? 'ended'
    : waiting > 0
      ? 'waiting'
      : yourTurn
        ? 'your-turn'
        : working
          ? 'working'
          : 'connected'
  const state_text = session.stale
    ? // A blip is under a minute and has no age to show, so the bare word is the
      // honest version rather than "Ended 0m ago".
      endedAge
      ? `Ended ${endedAge} ago`
      : 'Ended'
    : waiting > 0
      ? `Waiting on you${waiting > 1 ? ` · ${waiting}` : ''}`
      : yourTurn
        ? 'Handed back'
        : working
          ? // Says only what the stamp proves -- the turn is live. "Working"
            // would also be read as a build running in the background, which is
            // exactly the state this does NOT cover.
            sessionIsCompacting(session, now)
            ? CONFIG.UI_LABELS.CODE_SESSION_COMPACTING_SHORT
            : 'Responding…'
          : 'Connected'

  // Two places carry a chosen name and BOTH have to be honoured: `stated`, and
  // the label's own tag when the shim was started by an already-named session.
  // Reading only `stated` demoted rows like "mm-dev-719" to a line-2 handle.
  const fromTag = tag && !isGeneratedTag(tag) ? tag : undefined
  const published = stated && stated !== session.label ? stated : undefined
  const chosen = published ?? fromTag
  const placeholder = isPlaceholderName(chosen, branch ?? repo) ? chosen : undefined
  // Line 1 is the short name that tells rows apart; the recap is a sentence and
  // belongs on line 2. Only when nothing named the session does the recap rise.
  const named = (placeholder ? undefined : readableName(chosen)) || session.tldr?.trim() || placeholder
  // A tag the shim generated is not a name -- it is the LAST resort, kept only
  // because two unnamed panes in one checkout are otherwise identical. The pid
  // serves the same purpose and is the more useful of the two when both exist.
  const handle = isGeneratedTag(tag) ? tag?.slice(0, 4) : tag
  const detail = named
    ? undefined
    : session.pid !== undefined
      ? `pid ${session.pid}`
      : handle

  return {
    state: waiting > 0 ? 'waiting' : 'connected',
    label: waiting > 1 ? `Waiting on you · ${waiting}` : waiting === 1 ? 'Waiting on you' : undefined,
    started: startedText(session.since, now),
    lastReply: working ? 'Working now' : startedText(lastReplyAt(session), now),
    // Suppressed only while the agent is mid-turn or gone: that silence is the
    // agent's, not the user's, and a clock there would read as neglect. Anywhere
    // else it survives being SEEN, because glancing at a row is not answering it.
    waitAge:
      health === 'working' || health === 'ended'
        ? undefined
        : waitAgeText(session.handedBackAt ?? session.idleSince, now),
    name: named,
    unnamed:
      health !== 'ended' &&
      now - (session.since ?? 0) < CONFIG.AGENT_RELAY.NAMING_WAIT_MS &&
      (!named || named === placeholder),
    repo,
    branch,
    detail,
    // Only a named row has a checkout to put here: an unnamed one already shows
    // it on line 1, and repeating it would say the same thing twice.
    place: named ? [repo, branch].filter(Boolean).join('/') || undefined : undefined,
    where: distinctPath(session.cwd, repo),
    agent: agentLabel(session.agent),
    effort: session.effort?.trim() || undefined,
    model: session.model?.trim() || undefined,
    vendor: agentVendor(session.agent),
    tldr: session.tldr?.trim() || undefined,
    state_text,
    health
  }
}

/** "Your turn" is UNREAD state, per surface, never persisted — store terminal
 *  states are an agent-facing contract. Once seen, idleSince is spent; a newer
 *  ping carries a newer stamp and shows again by construction. */
export function withSeenIdle(
  session: AgentRelaySessionInfo,
  seenAt: number | undefined
): AgentRelaySessionInfo {
  if (seenAt === undefined || session.idleSince === undefined || session.idleSince > seenAt)
    return session
  return { ...session, idleSince: undefined }
}

/**
 * Every string a session can be recognised by, lowercased. Built from the ROW
 * so anything on screen is searchable by construction, plus the full label and
 * cwd, which the card shortens and a person may still paste in whole.
 */
export function sessionHaystack(session: AgentRelaySessionInfo, row: SessionRow): string {
  return [
    // First, and the reason search is worth having: with six panes on one
    // checkout, "the one doing the grouping API" is how someone looks for a
    // session -- never by its slug or its branch, which they all share.
    row.tldr,
    row.name,
    row.repo,
    row.branch,
    row.detail,
    row.place,
    row.where,
    row.agent,
    row.model,
    session.label,
    session.stated,
    session.cwd,
    // Where it lives on screen: the host app ("cmux") and its tab name — the
    // words someone reads off the tab strip are how they'll search for it.
    session.hostAppName,
    session.whereLabel,
    session.pid !== undefined ? String(session.pid) : undefined,
    // Never on the card, but it is what the relay CLI prints and what
    // a hook or a log names a session by, so it is the id someone pastes in.
    session.sessionId
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * AND across whitespace-separated terms, substring each. "dev 735" finds
 * `mm-dev-735` and "showandtell dev" narrows to a checkout — which is how
 * someone types when they are cutting seventeen cards down to one, and it costs
 * nothing over the single-term case.
 */
export function matchesSession(haystack: string, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((t) => haystack.includes(t))
}

/** Hook `from` is `ShowAndTell · name`. The session label is `ShowAndTell - name`.
 *  Exact equality misses, so a waiting tap opened the list instead of that agent. */
export function sessionMatchesFrom(
  session: { label: string; stated?: string },
  from: string | undefined
): boolean {
  if (!from) return false
  if (session.stated === from || session.label === from) return true
  const name = from.split('·').pop()?.trim()
  if (!name) return false
  return session.label.endsWith(name) || Boolean(session.stated?.endsWith(name))
}

/** True when the detail is a machine handle rather than a name someone picked —
 *  the row renders it in a dimmer, monospaced style so it reads as one. A pid
 *  qualifies for the same reason a hex head does: nobody chose it. */
export function isGeneratedTag(detail: string | undefined): boolean {
  if (detail === undefined) return false
  return SESSION_ID.test(detail) || /^pid \d+$/.test(detail)
}

// The naming hook's no-topic fallback: "<branch>-HHMM", "-b".."-z" for same-minute panes.
export function isPlaceholderName(name: string | undefined, branch: string | undefined): boolean {
  if (!name || !branch) return false
  const base = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return name.toLowerCase().startsWith(`${base}-`) && /^\d{4}(-[a-z])?$/.test(name.slice(base.length + 1))
}

const ATTACHED_PATH_LINE = /^\s*\/[^\n]*\/[^\n]*\.\w{1,5}\s*$/
const IMAGE_MARKERS = /^(?:\s*\[Image[^\]\n]*\])+\s*/

// An attached file arrives as its path alone on the line above the words, a pasted picture as a leading "[Image #1]".
export function withoutAttachments(text: string): string {
  const lines = text.split('\n')
  while (lines.length > 1 && ATTACHED_PATH_LINE.test(lines[0])) lines.shift()
  return lines.join('\n').replace(IMAGE_MARKERS, '')
}

export function nameFromMessage(text: string | undefined): string | undefined {
  const line = text && withoutAttachments(text).replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  if (line.length <= 48) return line
  const cut = line.slice(0, 48)
  return cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : 48).trim()
}

/**
 * The path, but only when the folder is not simply the repo the row already
 * names. Six sessions in one checkout all shorten to `Development/ShowAndTell`,
 * so printing it under every row costs a line and distinguishes none of them --
 * whereas a worktree at `worktrees/wt-mirror` is worth the line.
 */
export function distinctPath(cwd: string | undefined, repo: string): string | undefined {
  const where = shortPath(cwd)
  if (!where) return undefined
  // Only the working folder is compared. Its parent ("Development/") is shared
  // by every checkout on this Mac, so it can never tell two rows apart.
  const segments = where.split('/').filter(Boolean)
  const folder = segments[segments.length - 1]
  return folder?.toLowerCase() === repo.toLowerCase() ? undefined : where
}

/**
 * Last two segments, home as `~`. The full path is the same 40-character
 * prefix for every session on this Mac, so showing it in full turns six
 * different rows into six identical ones.
 */
export function shortPath(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length === 0) return '/'
  return parts.slice(-2).join('/')
}

/** Coarse on purpose: this sits under a path in a hover list, so it answers
 *  "new or long-running", never "how long exactly". */
/** "8:54 AM (24m ago)", or "Aug 16, 11:20 PM (16h ago)" once the clock time alone
 *  stops being unambiguous. The absolute half leads because it is the one a
 *  relative number cannot reconstruct; the parenthesised half is what makes the
 *  row scannable without doing the arithmetic. */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

function lastReplyAt(session: AgentRelaySessionInfo): number | undefined {
  const stamps = [session.lastTurnEndedAt, session.handedBackAt, session.lastActivityAt].filter(
    (t): t is number => t !== undefined
  )
  return stamps.length ? Math.max(...stamps) : undefined
}

export function sessionActiveAt(session: AgentRelaySessionInfo): number {
  return Math.max(session.since ?? 0, session.busySince ?? 0, session.lastTurnEndedAt ?? 0, session.handedBackAt ?? 0)
}

export function shortAge(ms: number): string {
  return relativeAge(ms).replace(' ago', '').replace('just now', 'now')
}

function startedText(since: number | undefined, now: number): string | undefined {
  if (!since) return undefined
  const d = new Date(since)
  const time = TIME_FORMAT.format(d)
  const sameDay = new Date(now).toDateString() === d.toDateString()
  const stamp = sameDay ? time : `${DAY_FORMAT.format(d)}, ${time}`
  return `${stamp} (${relativeAge(now - since)})`
}

/** Words under a minute, not "0m": a session that just started reads as brand new
 *  rather than as one whose age rounded away. */
export function relativeAge(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** Same ladder as `sessionAge` above one minute, but it bottoms out in seconds
 *  instead of going blank: the sub-minute case is a session that JUST handed
 *  back, which is the one worth showing, not the one worth hiding. */
function waitAgeText(since: number | undefined, now: number): string | undefined {
  if (!since) return undefined
  const secs = Math.max(0, Math.floor((now - since) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

export function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' or ')
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}
