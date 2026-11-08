import type { AgentRelaySessionInfo, SpokenWord } from './types'
import type { RelayRequestWire } from './phone-remote-protocol'

export const HIDEOUT_NAME = 'Hideout'
export const HIDEOUT_WORDS = ['hide out', 'bridge', 'jarvis', 'command center', 'command centre', 'big screen', 'hq', 'secret mode', 'mouse hole']
export const HIDEOUT_STUCK_VERDICTS: readonly string[] = ['looping', 'off_goal']

export type HideoutFocus = { kind: 'ask'; id: string } | { kind: 'agent'; project: string } | null

export interface HideoutAsk {
  id: string
  project: string | null
  question: string
  options: string[]
  recommended: number
  approve: boolean
  pcts: number[]
  createdAt: number
}

export interface HideoutWorld {
  open: boolean
  paused: boolean
  projects: string[]
  stuck: string | null
  asks: HideoutAsk[]
  focus: HideoutFocus
  place: HideoutPlace
}

export type HideoutCommand =
  | { kind: 'open' | 'close' | 'pause' | 'resume' | 'needs' | 'next' | 'back' | 'status' | 'help' | 'repeat' | 'hello' | 'recap' }
  | { kind: 'show' | 'watch'; project: string }
  | { kind: 'tell'; project: string | null; name: string; message: string }
  | { kind: 'answer'; askId: string; option: number }
  | { kind: 'noProject'; name: string }
  | { kind: 'place'; place: HideoutPlace; name: string }

export interface HideoutPlace {
  x: number
  y: number
  w: number
  h: number
}

export const HIDEOUT_FULL: HideoutPlace = { x: 0, y: 0, w: 1, h: 1 }
export const HIDEOUT_RAIL_W = 0.26
export const isHideoutFull = (p: HideoutPlace): boolean => p.w >= 0.99 && p.h >= 0.99
export const HIDEOUT_SIDE: HideoutPlace = { x: 1 - HIDEOUT_RAIL_W, y: 0, w: HIDEOUT_RAIL_W, h: 1 }

export interface HideoutPlan {
  commands: HideoutCommand[]
  complete: boolean
}

export type HideoutControl =
  | { kind: 'get' | 'pause' | 'resume' | 'close' | 'back' }
  | { kind: 'focus'; focus: HideoutFocus }
  | { kind: 'answer'; askId: string; option: number }
  | { kind: 'place'; place: HideoutPlace }

export interface HideoutHop {
  key: string
  icon: string
  model?: string
  label: string
  local: boolean
  ms: number
  usd?: number
}

export interface HideoutSpendRow {
  key: string
  icon: string
  model?: string
  label: string
  local: boolean
  turns: number
  usd: number
}

export const HIDEOUT_HOP = {
  whisper: { key: 'whisper', icon: 'mic', label: 'Transcription', local: true },
  here: { key: 'here', icon: 'mightymouse', label: 'MightyMouse', local: true },
  quick: { key: 'quick', icon: 'auto', label: 'Quick actions', local: false }
} satisfies Record<string, Omit<HideoutHop, 'ms' | 'usd'>>

const VOICES: Record<string, Omit<HideoutHop, 'ms' | 'usd'> & { free: boolean }> = {
  kokoro: { key: 'voice:kokoro', icon: 'voice', label: 'Kokoro voice', local: true, free: true },
  'macos-say': { key: 'voice:say', icon: 'voice', label: 'Mac voice', local: true, free: true },
  elevenlabs: { key: 'voice:elevenlabs', icon: 'voice', label: 'ElevenLabs voice', local: false, free: false }
}

export function voiceHop(provider: string, ms: number): HideoutHop | null {
  const v = VOICES[provider]
  if (!v) return null
  const { free, ...hop } = v
  return { ...hop, ms, ...(free ? { usd: 0 } : {}) }
}

export interface HideoutState {
  open: boolean
  paused: boolean
  place: HideoutPlace
  focus: HideoutFocus
  heard: string
  reply: string
  voiced: boolean
  words: SpokenWord[] | null
  chain: HideoutHop[]
  firstSoundMs: number | null
  steps: string[]
  feed: { at: number; text: string }[]
  spend: HideoutSpendRow[]
  today: HideoutToday
  verdicts: Record<string, string>
  scores: Record<string, Record<string, number>>
  vitals: HideoutVitals | null
}

export interface HideoutToday {
  day: string
  usd: number
  answers: number
  free: number
}

export interface HideoutVitals {
  chip: string
  cores: number
  uptimeS: number
  cpu: number[]
  memUsedGb: number
  memTotalGb: number
  netDown: number
  netUp: number
  wifi: { rssi: number; rateMbps: number; band: string } | null
  battery: { percent: number | null; charging: boolean }
  top: { name: string; pct: number }[]
}

export const projectOf = (s: AgentRelaySessionInfo): string => s.project?.name ?? s.label

function sessionFor(r: RelayRequestWire, sessions: AgentRelaySessionInfo[]): AgentRelaySessionInfo | undefined {
  const p = r.params
  return (
    sessions.find((s) => p.cwd && s.cwd === p.cwd) ??
    sessions.find((s) => p.from && s.stated === p.from) ??
    sessions.find((s) => r.sessionLabel && s.label === r.sessionLabel)
  )
}

export function hideoutAsks(pending: RelayRequestWire[], sessions: AgentRelaySessionInfo[]): HideoutAsk[] {
  const asks: HideoutAsk[] = []
  for (const r of pending) {
    const p = r.params
    const session = sessionFor(r, sessions)
    const project = session ? projectOf(session) : (p.from ?? null)
    if (r.verb === 'approve') {
      const question = [p.action, p.detail].filter(Boolean).join(' - ') || p.title || 'Approve this?'
      asks.push({ id: r.id, project, question, options: ['Approve', 'Deny'], recommended: 0, approve: true, pcts: [], createdAt: r.createdAt })
    } else if (r.verb === 'ask' && p.options && p.options.length >= 2 && (p.questions?.length ?? 0) <= 1) {
      const d = p.decision
      const recommended = d && d.best >= 0 && d.best < p.options.length ? d.best : 0
      asks.push({ id: r.id, project, question: p.question ?? p.title ?? '', options: p.options, recommended, approve: false, pcts: d?.pcts ?? [], createdAt: r.createdAt })
    }
  }
  return asks.sort((a, b) => a.createdAt - b.createdAt)
}

export function hideoutStuck(sessions: AgentRelaySessionInfo[], verdicts: Record<string, string>): string | null {
  const s = sessions.find((x) => !x.stale && x.sessionId && HIDEOUT_STUCK_VERDICTS.includes(verdicts[x.sessionId] ?? ''))
  return s ? projectOf(s) : null
}

const NAMES = [HIDEOUT_NAME, ...HIDEOUT_WORDS].map((w) => w.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').trim().replace(/\s+/g, '\\s*')).join('|')
const OPEN = new RegExp(`\\b(?:open|start|launch|enter|go to|show)\\b.*\\b(?:${NAMES})\\b|^(?:${NAMES})(?: mode)?$`)
const CLOSE = new RegExp(`\\b(?:close|exit|quit|shut)\\b.*\\b(?:${NAMES}|this|it)\\b|^(?:exit|close)$`)
const PAUSE = /^(?:pause|pause (?:it|this|listening|everything)|hold on|stop listening|go quiet|mute)$/
const RESUME = /^(?:resume|unpause|continue|carry on|i'?m back|start listening|unmute)$/
const REPEAT = /^(?:repeat(?: that)?|say (?:that|it) again|again|what did you say|come again|pardon|sorry what)$/
const HELLO = /^(?:(?:hey|hi|hello|yo)\b ?)*(?:can you hear me|are you there|you there|are you listening|you listening|testing(?: testing)*|mic check)?$/
const HELP = /^(?:help|what can i say|what can you do|commands|what are my options)\b/
const BACK = /^(?:go )?back\b|^overview$|^home$|^escape$/
const NEXT = /^(?:next|next one|skip|the next one|skip it)$/
const RECAP = /what did (?:my |the |all )?(?:agents?|everyone|they|we|you guys) (?:do|get done|finish|ship|work on)|\brecap\b|end of (?:the )?day|what got done|daily (?:summary|report)/
const WATCH = /^(?:watch|follow|keep an eye on|keep watching|pin|track|stick with|stay on)\s+(.+)/
const UNWATCH = /^(?:stop watching|unpin|stop following|stop tracking)\b/
const TELL = /^\s*(?:(?:hey|ok|okay|now|so|can you|could you|please)[\s,]+)*(?:tell|ask)\s+(.+?)\s+to\s+(.+?)[\s.!?]*$/i
const TELL_FOCUS = /^(?:it|that|this|that one|this one|them|the agent|him|her)$/
const NEEDS = /what needs me|what'?s waiting|anything for me|what do you need|what needs my|any decisions|decisions?$|what'?s pending|who needs me/
const STUCK = /\bstuck\b|what'?s broken|anything broken/
const STATUS = /status|how are things|what'?s going on|what'?s happening|brief|summary|catch me up|what did i miss|anything new|how are we doing|how many agents|what'?s running|who'?s working|agents? (?:are )?(?:running|working|on)\b/
const SHOW = /^(?:show(?: me)?|focus(?: on)?|open|go to|pull up|what about|how'?s|how is|check(?: on)?|let'?s see|switch to|jump to|zoom (?:in )?on)\s+(.+)/
const YES = /\b(?:ship it|approve|approved|recommended|yes|yeah|yep|do it|go ahead|go for it|sounds good|send it|let'?s do it|your pick|whatever you think)\b/
const NO = /^(?:no|nope|don'?t|do not|not yet|not now|hold off|nah|deny|reject)\b/
const BARE = /^(?:yes|yeah|yep|no|nope|ok|okay)$/
const PICK = [
  /^(?:option |answer |pick |choose |go with )?(?:a|ay|eh)$|\b(?:the )?first(?: one)?\b/,
  /^(?:option |answer |pick |choose |go with )?(?:b|be|bee)$|\b(?:the )?second(?: one)?\b/,
  /^(?:option |answer |pick |choose |go with )?(?:c|see|sea)$|\b(?:the )?third(?: one)?\b/
]
const FILLER = new Set(['the', 'a', 'to', 'it', 'and', 'on', 'for', 'my', 'me', 'with', 'of', 'please', 'just', 'tell', 'them', 'go', 'ahead', 'one', 'option'])
const SPLIT = /\s*(?:,|\band then\b|\bthen\b|\band also\b|\balso\b|\band\b)\s*/

export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim()

function spoken(name: string): string[] {
  const spaced = norm(name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]/g, ' '))
  return [...new Set([spaced, spaced.replace(/ /g, '')])].filter(Boolean)
}

export function findProject(s: string, projects: string[]): string | null {
  const joined = s.replace(/ /g, '')
  for (const p of projects) {
    for (const w of spoken(p)) {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\b${escaped}\\b`).test(s) || (w.length > 5 && joined.includes(w.replace(/ /g, '')))) return p
    }
  }
  const prefixed = projects.filter((p) => s.split(' ').some((w) => w.length >= 3 && !FILLER.has(w) && spoken(p).some((x) => x.replace(/ /g, '').startsWith(w))))
  return prefixed.length === 1 ? prefixed[0] : null
}

function pickOption(a: HideoutAsk, s: string, inAsk: boolean, named: boolean): number {
  for (let k = 0; k < PICK.length; k++) if (k < a.options.length && PICK[k].test(s)) return k
  if (NO.test(s) && (inAsk || s.includes(' '))) return a.options.findIndex((_, k) => k !== a.recommended)
  const ws = s.split(' ').filter((w) => !FILLER.has(w))
  let best = -1
  let bestN = 0
  a.options.forEach((o, k) => {
    const label = norm(o).split(' ')
    const n = ws.filter((w) => label.some((l) => l === w || (w.length > 4 && l.startsWith(w.slice(0, 5))))).length
    if (n > bestN) {
      best = k
      bestN = n
    }
  })
  if (best >= 0 && (inAsk || bestN >= 2 || named)) return best
  if (YES.test(s) && !/\b(?:don'?t|not)\b/.test(s)) return a.recommended
  return -1
}

interface Ctx {
  open: boolean
  paused: boolean
  place: HideoutPlace
  project: string | null
  agentFocus: boolean
  askId: string | null
}

const PLACE_NOISE = new Set(
  'hey can could would you please just now and then move go put snap slide shift jump park stick make get be become switch sit stay come over into in to on of at the a an it this yourself window screen view mode edge corner way all bit little more there over bring pop'.split(' ')
)
const PLACE_WORDS = new Set(
  'left right top bottom up down upper lower center centre middle bigger larger grow wider smaller shrink narrower tiny taller shorter expand full fullscreen maximize maximise max big huge whole half rail sidebar side panel dock compact mini minimize minimise small lot much'.split(' ')
)

export function placeHideout(s: string, cur: HideoutPlace): { place: HideoutPlace; name: string } | null {
  const ws = s.split(' ').filter((t) => !PLACE_NOISE.has(t))
  if (!ws.length || !ws.every((t) => PLACE_WORDS.has(t)) || ws.every((t) => t === 'lot' || t === 'much')) return null
  const has = (...k: string[]): boolean => k.some((t) => ws.includes(t))
  const left = has('left')
  const right = has('right')
  const top = has('top', 'up', 'upper')
  const bottom = has('bottom', 'down', 'lower')
  const center = has('center', 'centre', 'middle')
  const grow = has('bigger', 'larger', 'grow')
  const shrink = has('smaller', 'shrink', 'tiny')
  const k = has('lot', 'much') ? 1.5 : 1.25
  let p = { ...cur }
  let name = 'Moved.'
  if (has('expand', 'full', 'fullscreen', 'maximize', 'maximise', 'max', 'huge', 'whole') || (has('big') && !grow)) {
    return { place: { ...HIDEOUT_FULL }, name: 'Full screen.' }
  }
  if (has('rail', 'sidebar', 'panel', 'dock', 'compact', 'mini', 'minimize', 'minimise', 'small') || (has('side') && !left && !right)) {
    p = p.x + p.w / 2 < 0.5 && !isHideoutFull(p) ? { ...HIDEOUT_SIDE, x: 0 } : { ...HIDEOUT_SIDE }
    name = 'Side view.'
  } else if (has('half')) {
    p = { ...p, w: 0.5, h: 1, y: 0 }
    name = 'Half screen.'
  }
  const sw = grow ? k : shrink ? 1 / k : has('wider') ? k : has('narrower') ? 1 / k : 1
  const sh = grow ? k : shrink ? 1 / k : has('taller') ? k : has('shorter') ? 1 / k : 1
  if (sw !== 1 || sh !== 1) {
    const w = Math.min(1, Math.max(0.18, p.w * sw))
    const h = Math.min(1, Math.max(0.3, p.h * sh))
    p = { x: p.x + (p.w - w) / 2, y: p.y + (p.h - h) / 2, w, h }
    name = sw > 1 || sh > 1 ? 'Bigger.' : 'Smaller.'
  }
  if (isHideoutFull(p) && (left || right)) p = { ...p, w: HIDEOUT_RAIL_W }
  if (isHideoutFull(p) && (top || bottom)) p = { ...p, h: 0.5 }
  if (isHideoutFull(p) && center) p = { x: 0.2, y: 0.125, w: 0.6, h: 0.75 }
  if ((top || bottom) && (left || right) && p.h >= 0.99) p = { ...p, h: 0.5 }
  if (left) p.x = 0
  if (right) p.x = 1 - p.w
  if (top) p.y = 0
  if (bottom) p.y = 1 - p.h
  if (center) {
    if (!left && !right) p.x = (1 - p.w) / 2
    if (!top && !bottom) p.y = (1 - p.h) / 2
  }
  p.x = Math.min(Math.max(0, p.x), 1 - p.w)
  p.y = Math.min(Math.max(0, p.y), 1 - p.h)
  return { place: p, name }
}

function matchClause(s: string, w: HideoutWorld, ctx: Ctx): HideoutCommand | null {
  if (ctx.open && !ctx.paused) {
    const placed = placeHideout(s, ctx.place)
    if (placed) {
      ctx.place = placed.place
      return { kind: 'place', ...placed }
    }
  }
  if (OPEN.test(s)) {
    ctx.open = true
    ctx.paused = false
    return { kind: 'open' }
  }
  if (!ctx.open) return null
  if (CLOSE.test(s)) return { kind: 'close' }
  if (RESUME.test(s)) {
    ctx.paused = false
    return { kind: 'resume' }
  }
  if (ctx.paused) return null
  if (PAUSE.test(s)) return { kind: 'pause' }
  if (REPEAT.test(s)) return { kind: 'repeat' }
  if (HELLO.test(s)) return { kind: 'hello' }
  if (HELP.test(s)) return { kind: 'help' }
  if (BACK.test(s) || UNWATCH.test(s)) return { kind: 'back' }
  if (RECAP.test(s)) return { kind: 'recap' }
  const watched = s.match(WATCH)
  if (watched) {
    const project = findProject(watched[1], w.projects)
    if (project) {
      ctx.project = project
      ctx.agentFocus = true
      return { kind: 'watch', project }
    }
  }
  if (NEXT.test(s)) return { kind: 'next' }
  if (NEEDS.test(s)) return { kind: 'needs' }
  const named = findProject(s, w.projects)
  const shown = s.match(SHOW)
  if (!shown) {
    const open = w.asks
    const inAsk = ctx.askId ? open.find((a) => a.id === ctx.askId) : undefined
    const target = (named && open.find((a) => a.project === named)) || inAsk || (!ctx.agentFocus ? open[0] : undefined)
    if (target) {
      const mine = !!inAsk || (!!target.project && (target.project === named || target.project === ctx.project))
      const k = pickOption(target, s, mine, !!named)
      if (k >= 0 && (mine || !!named || !BARE.test(s))) {
        ctx.askId = null
        return { kind: 'answer', askId: target.id, option: k }
      }
    }
  }
  if (STUCK.test(s) && !named && w.stuck) {
    ctx.project = w.stuck
    return { kind: 'show', project: w.stuck }
  }
  if (named && (shown || s.split(' ').length <= 3)) {
    ctx.project = named
    ctx.agentFocus = true
    ctx.askId = w.asks.find((a) => a.project === named)?.id ?? null
    return { kind: 'show', project: named }
  }
  if (shown && !/\b(?:everything|all|overview|status)\b/.test(shown[1])) return { kind: 'noProject', name: shown[1] }
  if (STATUS.test(s)) return { kind: 'status' }
  return null
}

function tellCommand(text: string, w: HideoutWorld, ctx: Ctx): HideoutCommand | null {
  const m = ctx.open && !ctx.paused ? text.match(TELL) : null
  if (!m) return null
  const name = norm(m[1])
  const asked = ctx.askId ? w.asks.find((a) => a.id === ctx.askId) : undefined
  const pointed = TELL_FOCUS.test(name)
  const project = pointed ? (ctx.project ?? asked?.project ?? w.stuck ?? (w.projects.length === 1 ? w.projects[0] : null)) : findProject(name, w.projects)
  if (!project && !pointed) return null
  const message = m[2].charAt(0).toUpperCase() + m[2].slice(1)
  const ask = project ? w.asks.find((a) => a.project === project) : undefined
  const k = ask ? pickOption(ask, norm(message), true, true) : -1
  if (ask && k >= 0) return { kind: 'answer', askId: ask.id, option: k }
  return { kind: 'tell', project, name: m[1], message }
}

export function planHideout(text: string, w: HideoutWorld): HideoutPlan {
  const focus = w.focus
  const ctx: Ctx = {
    open: w.open,
    paused: w.paused,
    place: w.place,
    project: focus?.kind === 'agent' ? focus.project : null,
    agentFocus: focus?.kind === 'agent',
    askId: focus?.kind === 'ask' ? focus.id : focus?.kind === 'agent' ? (w.asks.find((a) => a.project === focus.project)?.id ?? null) : null
  }
  const told = tellCommand(text, w, ctx)
  if (told) return { commands: [told], complete: true }
  const parts = norm(text).split(SPLIT).filter(Boolean)
  const commands: HideoutCommand[] = []
  let missed = 0
  for (let i = 0; i < parts.length; i++) {
    let m = matchClause(parts[i], w, ctx)
    for (let j = i + 1; !m && j < parts.length; j++) {
      m = matchClause(parts.slice(i, j + 1).join(' and '), w, ctx)
      if (m) i = j
    }
    if (m) commands.push(m)
    else if (commands.length) {
      const merged = matchClause(`${parts[i - 1]} and ${parts[i]}`, w, { ...ctx })
      if (merged) commands[commands.length - 1] = merged
      else missed++
    } else missed++
  }
  return { commands, complete: commands.length > 0 && missed === 0 }
}
