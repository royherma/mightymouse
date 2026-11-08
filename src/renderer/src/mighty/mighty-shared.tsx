
import { useCallback, useState } from 'react'
import { MessageSquare, CalendarClock, FolderOpen, Images, Terminal, Settings as SettingsIcon, FileText, FileCode } from 'lucide-react'
import { type ConversationHandoff } from './ConversationPane'
import { formatTabName, dayKeyFor } from './workspace-naming'
import { CONFIG } from '../../../shared/config'
import { type Snippet } from '../../../shared/fuzzy'
import { type TimelineItem } from '../lib/run-events'
import type { MightySession, MightyRunSource, MightySchedule, MightyOutputFormat, ChatTabNameFormat } from '../../../shared/types'

// Mighty — the standing personal agent window (?window=mighty). Four tabs:
//   Chat — talk to Mighty; it knows your data and can build files/dashboards/apps.
//          A collapsible left rail lists every past conversation (switch/delete).
//   Jobs — scheduled work Mighty does on its own (the proactive morning report etc).
//   Made — the registry of everything Mighty created; open or remove each artifact.
//   Library — every capture (recordings, screenshots) with player, transcript, tags.
//             A finished recording's HUD card opens straight to it, selected.
//   Settings — persona name, custom instructions, default output format, workspace.
// All data flows through window.api.mighty.* (preload bridge); no logic lives here.

export type Tab = 'chat' | 'code' | 'jobs' | 'made' | 'library' | 'bubba' | 'settings'

/** One conversation's search result. `snippet` is null for a title hit — the
 *  title is already the row's headline, so echoing it below itself is noise. */
export interface SearchHit {
  score: number
  snippet: Snippet | null
}

/** Lifts every title hit above every body hit. Larger than any single match
 *  score, so the two ranges can't overlap. */
export const TITLE_RANK_BOOST = 10

/** Stable empty timeline for every turn except the in-flight one — avoids handing
 *  Message a fresh array identity on every render. Exported so ConversationPane
 *  (one instance per pane) shares the same stable identity instead of each pane
 *  minting its own array every render. */
export const EMPTY_TIMELINE: TimelineItem[] = []

/** Sidebar source filter. Grouped, not one row per MightyRunSource: 'chat'/'phone'
 *  are both "you typed it" and 'listen'/'voice'/'capture' are all "you spoke or
 *  captured it", so six raw sources would make the user sort out a distinction the
 *  list doesn't actually show. 'job' stays its own row — unattended work is the one
 *  people filter for by itself. */
export const SIDEBAR_SOURCE_GROUPS: ReadonlyArray<{
  key: string
  label: string
  sources: readonly MightyRunSource[]
}> = [
  { key: 'chat', label: 'Chats', sources: ['chat', 'phone'] },
  { key: 'capture', label: 'Voice notes & captures', sources: ['listen', 'voice', 'capture'] },
  { key: 'job', label: 'Scheduled jobs', sources: ['job'] }
]

/** Which filter row a session belongs to — decided by its FIRST turn, because that's
 *  what minted the session and what its title comes from. A voice note you later
 *  asked a follow-up in stays under "Voice notes", which is where you'd look for it. */
export function sourceGroupOf(s: MightySession): string {
  const source = s.turns[0]?.source
  return SIDEBAR_SOURCE_GROUPS.find((g) => g.sources.includes(source as MightyRunSource))?.key ?? 'chat'
}

/** Was anything actually sent in this conversation? A capture mints a session whose
 *  single turn holds the transcript with an empty `a` (capture-actions.ts) — nothing
 *  ever reached a model, so it's a row with no conversation behind it. Any turn with
 *  a reply, or any second turn, means the user went on to use it. */
export function hasRealExchange(s: MightySession): boolean {
  return s.turns.some((t) => (t.a ?? '').trim() !== '')
}

export const TABS: Array<{ id: Tab; label: string; icon: typeof MessageSquare }> = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'code', label: 'Code', icon: Terminal },
  { id: 'jobs', label: 'Jobs', icon: CalendarClock },
  { id: 'made', label: 'Made', icon: FolderOpen },
  { id: 'library', label: 'Library', icon: Images },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
]

const LAST_TAB_KEY = 'mighty-last-tab'
const TAB_HISTORY_MAX = 30

/** Back/forward over tab switches, like a browser; switches made by goBack/goForward don't push. */
export function useTabHistory(tab: Tab, setTab: (t: Tab) => void): { back?: Tab; forward?: Tab; goBack: () => void; goForward: () => void } {
  const [h, setH] = useState({ tab, back: [] as Tab[], forward: [] as Tab[], stepTo: null as Tab | null })
  if (h.tab !== tab)
    setH(
      h.stepTo === tab
        ? { ...h, tab, stepTo: null }
        : { tab, back: [...h.back, h.tab].slice(-TAB_HISTORY_MAX), forward: [], stepTo: null }
    )
  const goBack = useCallback(() => {
    const t = h.back.at(-1)
    if (!t) return
    setH({ tab: h.tab, back: h.back.slice(0, -1), forward: [...h.forward, h.tab], stepTo: t })
    setTab(t)
  }, [h, setTab])
  const goForward = useCallback(() => {
    const t = h.forward.at(-1)
    if (!t) return
    setH({ tab: h.tab, back: [...h.back, h.tab], forward: h.forward.slice(0, -1), stepTo: t })
    setTab(t)
  }, [h, setTab])
  return { back: h.back.at(-1), forward: h.forward.at(-1), goBack, goForward }
}

export const tabLabel = (t: Tab): string => (t === 'bubba' ? CONFIG.UI_LABELS.BUBBA : (TABS.find((x) => x.id === t)?.label ?? 'Back'))

export function readLastTab(): Tab {
  const q = new URLSearchParams(window.location.search)
  if (['tab', 'session', 'fresh', 'focus'].some((k) => q.has(k))) return 'chat'
  const saved = q.get('mode')
  if (saved) return saved === 'code' ? 'code' : 'chat'
  try {
    return localStorage.getItem(LAST_TAB_KEY) === 'code' ? 'code' : 'chat'
  } catch {
    return 'chat'
  }
}

export function rememberTab(tab: Tab): void {
  if (tab !== 'chat' && tab !== 'code') return
  try {
    localStorage.setItem(LAST_TAB_KEY, tab)
  } catch {
    /* private storage off: next open lands on Chat */
  }
}

const ALL_MODE_KEY = 'mighty-all-mode'

export function readAllMode(): boolean {
  const saved = new URLSearchParams(window.location.search).get('mode')
  if (saved) return saved === 'all'
  try {
    return localStorage.getItem(ALL_MODE_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberAllMode(on: boolean): void {
  try {
    localStorage.setItem(ALL_MODE_KEY, on ? '1' : '0')
  } catch {
    return
  }
}

const ASK_PREFIX = /^((please|ok|okay|so|hey|now)[,\s]+|(can|could|would|will) you\s+|go ahead and\s+)+/i
const CHANGE_START =
  /^(fix|add|build|make|change|update|refactor|remove|delete|rename|move|implement|create|write|wire|hook|ship|deploy|debug|test|clean|replace|convert|migrate|set up|setup|install|bump|port|split|merge|hide|show|redesign|polish|improve|let'?s|i want|i need|we need|we should|it should|there should)\b/i
const QUESTION_START = /^(what|why|how|who|when|where|which|is|are|was|were|do|does|did|should|explain|tell me|summari[sz]e)\b/i

export type SendRoute = 'chat' | 'agent'

export function routeFor(message: string, hasFolder: boolean): SendRoute {
  const text = message.trim().replace(ASK_PREFIX, '')
  if (!hasFolder || text === '' || QUESTION_START.test(text)) return 'chat'
  return CHANGE_START.test(text) ? 'agent' : 'chat'
}

const NERD_MODE_KEY = 'mighty-nerd-mode'

export function readNerdMode(): boolean {
  try {
    return localStorage.getItem(NERD_MODE_KEY) === '1'
  } catch {
    return false
  }
}

export function rememberNerdMode(on: boolean): void {
  try {
    localStorage.setItem(NERD_MODE_KEY, on ? '1' : '0')
  } catch {
    /* private storage off: next open starts with one chat */
  }
}

/** Code is the one opt-in tab: the relay is off by default, and a tab that can
 *  never hold anything is worse than no tab. ⌘1..⌘n follow whatever is shown. */
export function visibleTabs(relayEnabled: boolean, simple = false): typeof TABS {
  if (simple) return TABS.filter((t) => t.id === 'settings')
  return relayEnabled ? TABS : TABS.filter((t) => t.id !== 'code')
}

// Quick-start prompts on the empty Chat state — matched to what Mighty actually does
// well (recall, drafting, dashboards, scheduling), not generic coding-tool prompts.
// Exported for ConversationPane's own empty state (one per pane, same prompt set).
export const QUICK_START_PROMPTS: Array<{ icon: typeof MessageSquare; label: string; prompt: string }> = [
  { icon: Images, label: 'Make an image', prompt: 'Help me make an image - ask me what it should show first.' },
  { icon: FileCode, label: 'Draft something', prompt: 'Help me draft something - ask me what it is first.' }
]

export const AGENT_QUICK_START_PROMPTS: Array<{ icon: typeof MessageSquare; label: string; prompt: string }> = [
  { icon: FileCode, label: 'Explain this repo', prompt: 'Give me a quick tour of how this project is organized.' },
  { icon: SettingsIcon, label: 'Fix something', prompt: 'Find the most important rough edge here and fix it.' },
  { icon: FileText, label: 'Write a test', prompt: 'Find code that should have a test and add one.' },
  { icon: CalendarClock, label: 'Small win', prompt: 'Ship one small improvement a user would notice.' }
]

// Job templates offered when adding a new job — a fast start on Mighty's proven
// use cases instead of a blank "New job" the user has to write from scratch. Mirrors
// QUICK_START_PROMPTS but for scheduled (not one-shot) work.
export const JOB_TEMPLATES: Array<{
  icon: typeof MessageSquare
  label: string
  name: string
  prompt: string
  schedule: MightySchedule
  hour: number
}> = [
  {
    icon: FileText,
    label: 'Morning report',
    name: 'Morning report',
    prompt: CONFIG.MIGHTY.DEFAULT_JOB.prompt,
    schedule: 'weekdays',
    hour: 8
  },
  {
    icon: CalendarClock,
    label: 'Weekly recap',
    name: 'Weekly recap',
    prompt:
      'Look back at what I worked on this week (my recent activity and history) and give me a short recap: what shipped, what stalled, and what to carry into next week.',
    schedule: 'weekdays',
    hour: 17
  },
  {
    icon: FileCode,
    label: 'Inbox sweep',
    name: 'Inbox sweep',
    prompt: 'Check for anything time-sensitive I should know about and summarize it for me.',
    schedule: 'hourly',
    hour: 9
  },
  {
    icon: SettingsIcon,
    label: 'Blank job',
    name: 'New job',
    prompt: 'Describe what you want me to do on a schedule.',
    schedule: 'daily',
    hour: 9
  }
]

export const SCHEDULES: MightySchedule[] = ['daily', 'weekdays', 'hourly', 'manual']
export const FORMAT_LABELS: Record<MightyOutputFormat, string> = {
  auto: 'Auto (Mighty chooses)',
  html: 'HTML dashboard',
  markdown: 'Markdown'
}

/** Each tab-name option previewed as its real second-of-the-day name, rendered by the
 *  same formatter that mints tabs so the example can't drift from the actual output. */
export function tabFormatLabel(format: ChatTabNameFormat, now: Date): string {
  return `${formatTabName(dayKeyFor(now, format), 1, format)}  (second tab today)`
}

// Geometry for the portalled "Move to project" menu (see SessionRow). Width is a
// number, not a `w-48` class, because the clamp math needs it.
// Wider than the move menu: "Voice notes & captures" wraps below ~230.
export const SOURCE_MENU_W = 240
export const MOVE_MENU_W = 192
export const MOVE_MENU_GAP = 4 // px between the ⋯ button and the menu
export const MOVE_MENU_MARGIN = 8 // min px kept clear of the window edge

export function fileName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** True when a keyboard event originated inside an editable field, so a global
 *  shortcut (⌘1..5, ⌘↑/↓) shouldn't hijack a keystroke the user meant as text.
 *  Palette/composer keys deliberately still fire — they're handled with modifiers. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function isHtml(path: string): boolean {
  const p = path.toLowerCase()
  return p.endsWith('.html') || p.endsWith('.htm')
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/**
 * A run duration in seconds, always to one decimal ("0.1s", "1.0s", "14.2s"), rolling
 * to "1:05m" past a minute. Never milliseconds: "222ms" makes the reader do a unit
 * conversion mid-glance, and one unit means the number keeps its shape as it counts
 * up — the digits change, the format doesn't, so a live timer never reflows.
 */
export function formatDuration(ms: number): string {
  const secs = ms / 1000
  if (secs < 60) return `${secs.toFixed(1)}s`
  const mins = Math.floor(secs / 60)
  // Zero-padded so 1:05m reads as a clock, not as "1.5 minutes".
  const rem = Math.floor(secs % 60)
  return `${mins}:${String(rem).padStart(2, '0')}m`
}

export function fullTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}

/** A History-tab row handed to whichever pane is focused when Reuse/Continue is
 *  clicked. Alias of ConversationPane's own handoff shape (the type it actually
 *  consumes) — kept as one definition so the two can never drift apart. */
export type HistoryHandoff = ConversationHandoff
