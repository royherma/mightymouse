import { VISIBLE_SHORTCUTS, comboGlyphs, type ShortcutId } from './shortcuts'
import type { Snippet } from './fuzzy'

export type NavigatorCategory = 'shortcut' | 'screen' | 'project' | 'session' | 'chat'

// The lucide icon name the renderer resolves. Kept as a string so this module
// stays importable from main, which has no React.
export type NavigatorIcon = string

export interface NavigatorSearchRef {
  id: string
  sessionId: string
  cwd: string
}

export interface NavigatorContentHit {
  id: string
  title: string
  snippet: Snippet | null
}

export interface NavigatorTarget {
  id: string
  category: NavigatorCategory
  label: string
  // The one-line "what it does", shown under the label in the overlay.
  detail?: string
  icon: NavigatorIcon
  avatar?: { icon?: string; imagePath?: string }
  // Key caps to render on the right (e.g. ['Cmd','Opt','Shift','L']).
  keys?: string[]
  // Extra words that should match the filter but are not shown (e.g. 'mic' → Listen).
  keywords?: string
  adminOnly?: boolean
}

// Icon per shortcut. A shortcut without a row here falls back to Command.
const SHORTCUT_ICONS: Partial<Record<ShortcutId, NavigatorIcon>> = {
  main: 'Zap',
  chat: 'MessageSquare',
  capture: 'Camera',
  listen: 'Mic',
  suggest: 'Lightbulb',
  selectionBar: 'Type',
  navigator: 'Search',
  stop: 'OctagonX'
}

// Words a user might type that aren't in the title. 'mic' finding Listen is the
// difference between the overlay working and the user closing it again.
const SHORTCUT_KEYWORDS: Partial<Record<ShortcutId, string>> = {
  listen: 'mic microphone voice dictate transcribe speak talk record audio start listening note',
  capture: 'screenshot screen record video shot grab new capture take snip clip',
  selectionBar: 'spelling grammar shorten rewrite fix text proofread edit selection',
  suggest: 'idea next move what should i do help me',
  chat: 'conversation talk ask mighty message',
  main: 'panel open ask act do something',
  stop: 'kill halt cancel panic abort quit end'
}

export function shortcutTargets(): NavigatorTarget[] {
  return VISIBLE_SHORTCUTS.map((s) => ({
    id: `shortcut:${s.id}`,
    category: 'shortcut' as const,
    label: s.title,
    detail: s.desc,
    icon: SHORTCUT_ICONS[s.id] ?? 'Command',
    keys: comboGlyphs(s),
    keywords: SHORTCUT_KEYWORDS[s.id]
  }))
}

// Screens with no chord of their own — today these are only reachable from the
// tray, which is the gap the navigator closes.
export const SCREEN_TARGETS: NavigatorTarget[] = [
  {
    id: 'screen:newChat',
    category: 'screen',
    label: 'New chat',
    detail: 'Start a fresh conversation with a clean slate.',
    icon: 'MessageSquarePlus',
    keywords: 'new chat start fresh blank begin conversation another talk'
  },
  {
    id: 'screen:code',
    adminOnly: true,
    category: 'screen',
    label: 'Code',
    detail: 'Your projects and the coding agents running in them.',
    icon: 'Code',
    keywords: 'new code coding project projects repo repos develop programming dev claude codex cursor'
  },
  {
    id: 'screen:connectCodingTool',
    adminOnly: true,
    category: 'screen',
    label: 'Connect a coding tool',
    detail: 'Let Claude Code, Codex or Cursor reach you on your phone.',
    icon: 'Plug',
    keywords: 'mcp connect coding tool relay setup wire hook up claude code codex cursor npx server install'
  },
  {
    id: 'screen:agents',
    adminOnly: true,
    category: 'screen',
    label: 'Agents',
    detail: 'Every agent you have running, one thread each.',
    icon: 'Bot',
    keywords: 'new agent agents threads running working background code claude codex'
  },
  {
    id: 'screen:settings',
    category: 'screen',
    label: 'Settings',
    detail: 'Shortcuts, voice, permissions, and everything else you can change.',
    icon: 'Settings',
    keywords: 'preferences options config permissions setup change shortcuts account'
  },
  {
    id: 'screen:phone',
    category: 'screen',
    label: 'Phone Remote',
    detail: 'Pair your iPhone as a trackpad and voice remote.',
    icon: 'Smartphone',
    keywords: 'iphone pair qr trackpad remote connect mobile phone scan device'
  },
  {
    id: 'screen:library',
    category: 'screen',
    label: 'Media Library',
    detail: 'Every screenshot, recording and transcript you have made.',
    icon: 'Images',
    keywords: 'captures recordings screenshots files videos media gallery photos'
  },
  {
    id: 'screen:analytics',
    category: 'screen',
    label: 'Analytics',
    detail: 'What you have used, and how much of it.',
    icon: 'BarChart3',
    keywords: 'usage stats numbers charts metrics data insights'
  },
  {
    id: 'screen:cheatsheet',
    category: 'screen',
    label: 'Cheat Sheet',
    detail: 'Every shortcut on one card.',
    icon: 'Keyboard',
    keywords: 'shortcuts keys help reference hotkeys keyboard commands chords'
  },

  {
    id: 'screen:actions',
    adminOnly: true,
    category: 'screen',
    label: 'Actions',
    detail: 'The one-tap things Mighty can run for you.',
    icon: 'Sparkles',
    keywords: 'automations tasks run new action shortcut one tap cards'
  },
  {
    id: 'screen:canvas',
    adminOnly: true,
    category: 'screen',
    label: 'Canvas',
    detail: 'Drop ideas; they file themselves under the right project.',
    icon: 'Lightbulb',
    keywords: 'canvas ideas idea board map planets thoughts brainstorm organize context'
  },
  {
    id: 'screen:deck',
    adminOnly: true,
    category: 'screen',
    label: 'Agents waiting',
    detail: 'Background agents that have finished and want you.',
    icon: 'Layers',
    keywords: 'cheese parked background done waiting finished deck ready'
  },
  {
    id: 'screen:billing',
    category: 'screen',
    label: 'Plan and billing',
    detail: 'What you are on and what you have used.',
    icon: 'CreditCard',
    keywords: 'subscription payment upgrade plan invoice pay card credits pricing'
  },
  {
    id: 'screen:bug',
    category: 'screen',
    label: 'Report a bug',
    detail: 'Tell us what broke. Logs come along automatically.',
    icon: 'Bug',
    keywords: 'feedback problem broken issue support help report bug contact'
  },
  {
    id: 'screen:tutorial',
    category: 'screen',
    label: 'Tutorial',
    detail: 'The walkthrough, again.',
    icon: 'GraduationCap',
    keywords: 'tour onboarding walkthrough learn help getting started guide how to demo'
  }
]

/** Does a typed query match this target? Matches the label, the detail and the
 *  hidden keywords, so 'mic' finds Listen and 'qr' finds Phone Remote. */
export function matchesTarget(t: NavigatorTarget, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const hay = `${t.label} ${t.detail ?? ''} ${t.keywords ?? ''}`.toLowerCase()
  return q.split(/\s+/).every((word) => hay.includes(word))
}

export const ADMIN_SCREEN_IDS = new Set(
  SCREEN_TARGETS.filter((t) => t.adminOnly).map((t) => t.id.slice('screen:'.length))
)
