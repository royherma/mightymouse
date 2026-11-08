// The Settings section registry: which sections exist, what they're called,
// which bucket each lives in, plus the collapse/visibility state helpers. No
// components -- those live in sections.tsx and SettingsSidebar.tsx, kept
// separate so fast-refresh works (a module mixing the two breaks it).
import { useCallback, useEffect, useState } from 'react'
import { CONFIG } from '../../../../shared/config'
import type { SettingsSectionFocus } from '../../../../shared/types'
import type { CollapseCtx } from './context-store'

// Re-exported so section files have one import for everything they need.
export type { CollapseCtx }

// A query matches a section when it's a substring of the section title OR any
// of its extra keywords (both lower-cased). Empty query = everything shows.
export function sectionMatches(query: string, title: string, keywords: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return title.toLowerCase().includes(q) || keywords.toLowerCase().includes(q)
}

// Section identity = its visible title + extra search keywords. Defined once so
// the bucket-header visibility check and the section render use the same data
// (no drift between "does this bucket have a visible child" and what renders).
export const SECTIONS = {
  account: { title: 'Account', keywords: 'sign in out email login session sync' },
  chat: { title: 'Chat', keywords: 'name agent mighty default format html dashboard tab names workspace folder' },
  projects: { title: 'Projects', keywords: 'projects folders repos workspace add remove copy worktree branch' },
  alerts: { title: 'Alerts', keywords: 'alerts notifications notify mac pop up question approval focus pulse score reply' },
  instructions: {
    title: CONFIG.UI_LABELS.CUSTOM_INSTRUCTIONS,
    keywords:
      'custom instructions prompt style preferences rewrite ask act mighty global tone rules'
  },
  aiModel: {
    title: 'AI Model',
    keywords: 'backend claude codex openai provider mightymouse llm engine'
  },
  credits: {
    title: `Your ${CONFIG.PRODUCT_NAME} plan`,
    keywords: 'plan usage limit left refill credits balance top up buy pay billing packs money payment subscribe upgrade pro max free'
  },
  aiPlans: {
    title: 'Your other AI plans',
    keywords: 'claude code chatgpt codex openai openrouter gemini subscription accounts connected usage limit'
  },
  usage: { title: 'Usage', keywords: 'history charges spend cost calls' },
  advancedMode: { title: 'Coding agents', keywords: 'advanced coding agents claude code codex chat code jobs made library tools simple' },
  cursor: { title: 'Cursor Companion', keywords: 'pointer cursor animated glow style mouse' },
  click: { title: 'Click to act', keywords: 'click act accessibility tap point automate' },
  actHighlight: {
    title: CONFIG.UI_LABELS.SHOW_BEFORE_ACTING,
    keywords: 'act highlight box flash dashed border glow screen action preview warning confirm'
  },
  actions: {
    title: 'Actions',
    keywords: 'actions do commands voice open app volume plugins capabilities integrations automate'
  },
  voiceRouting: {
    title: 'Action routing',
    keywords:
      'action routing voice routing dictation transcript paste destination app jev typesafe experimental api key'
  },
  phoneRemote: {
    title: 'Phone Remote',
    keywords: 'phone remote trackpad qr code cursor voice mic control iphone'
  },
  agentRelay: {
    title: 'Let other tools talk to Mighty',
    keywords: 'mcp agent relay notify ask approve claude code npx push notification developer'
  },
  suggestions: { title: 'Suggestions', keywords: 'suggest bubble next move hint tips' },
  recording: {
    title: CONFIG.UI_LABELS.SCREEN_RECORDING,
    keywords: 'record recording max length minutes auto stop screen video capture'
  },
  sound: { title: 'Sound effects', keywords: 'sound chime audio noise beep' },
  captureHud: {
    title: CONFIG.UI_LABELS.CAPTURE_HUD,
    keywords: 'hud capture card overlay recording indicator'
  },
  island: { title: 'Dynamic Island', keywords: 'dynamic island notch live activity' },
  selectionBar: {
    title: 'Highlight to fix',
    keywords: 'selection bar highlight select text rewrite grammar shorten popup'
  },
  voice: {
    title: 'Voice mode',
    keywords:
      'voice talk speak aloud companion live hands-free conversation tts read minimize circle'
  },
  dictation: {
    title: 'Dictation language',
    keywords:
      'language dictation dictate transcribe transcription speech whisper multilingual capture voice spanish espanol español french français german deutsch portuguese português italian italiano hebrew עברית arabic العربية chinese 中文 japanese 日本語 korean 한국어 russian hindi'
  },
  dockIcon: {
    title: 'Show in Dock',
    keywords: 'dock icon taskbar launcher tray menu bar app switcher hide'
  },
  fnListen: {
    title: CONFIG.UI_LABELS.FN_LISTEN,
    keywords: 'fn function globe key listen talk dictate voice shortcut hotkey transcribe'
  },
  autoPaste: {
    title: CONFIG.UI_LABELS.AUTO_PASTE,
    keywords: 'paste transcription listen dictate speech voice type um uh filler bro mode lowercase casual punctuation format'
  },
  showTiming: {
    title: CONFIG.UI_LABELS.SHOW_TIMING,
    keywords:
      'speed fast time duration latency ms seconds transcribe transcription listen dictate voice hud chat reply response answer mighty took history timer benchmark model'
  },
  feedback: {
    title: CONFIG.UI_LABELS.FEEDBACK_LEARNING,
    keywords: 'feedback learning rate thumbs corrections improve better'
  },
  agentPhotos: {
    title: CONFIG.UI_LABELS.AGENT_PHOTOS,
    keywords: 'photo photos picture image camera roll agent phone screenshot library'
  },
  decisionCards: {
    title: CONFIG.UI_LABELS.DECISION_CARDS,
    keywords: 'decision choose options percent sure score recommended agent ask card why'
  },
  contextLog: {
    title: CONFIG.UI_LABELS.CONTEXT_LOG,
    keywords: 'context log ambient activity track skills memory remember'
  },
  runTranscript: {
    title: CONFIG.UI_LABELS.RUN_DETAILS,
    keywords: 'run details transcript tools tokens usage debug inspector steps'
  },
  incognito: { title: 'Incognito mode', keywords: 'incognito private privacy stop saving disable' },
  privacy: { title: 'Privacy', keywords: 'encrypt history clear delete privacy security backup' },
  binaries: {
    title: 'Transcription & Recording',
    keywords: 'ffmpeg whisper model binary path install transcribe'
  },
  devices: {
    title: 'Microphone and camera',
    keywords: 'video audio mic camera device avfoundation input source'
  },
  storage: { title: 'Storage', keywords: 'storage path folder files captures disk location' },
  smallPanel: { title: 'Small panel', keywords: 'small panel main window hotkey dock tray open' },
  updates: { title: 'Updates', keywords: 'update version upgrade release check' }
} as const

export type SectionKey = keyof typeof SECTIONS

// THE source of truth for "admin only". Drives three things that used to drift
// apart: whether the section renders, whether search can find it, and what the
// view-as-user preview hides. Adding an admin section = add its key here and
// wrap it in {advancedMenu && (…)} — nothing else.
//
// Fixed 2026-07-22: the old inline `advancedOnlyKeys` claimed captureHud /
// contextLog / feedback were admin-only while the render showed them to
// everyone (real users could see them but never SEARCH them), and omitted
// `storage`, which the render does gate. The render was truth.
//
// Same pass, two knobs were UNGATED as gated-by-accident: `autoPaste` ("Paste
// straight into your app") and `sound` ("A soft chime when things finish") are
// ordinary preferences with consumer copy already written — there's no reason
// a real user can't set them. Kept admin: unfinished/experimental surfaces
// (click, gaze, suggestions), and the two power-user knobs in the Advanced bucket (devices, storage).
export const SIMPLE_SECTIONS: SectionKey[] = [
  'phoneRemote',
  'account',
  'credits',
  'aiPlans',
  'dictation',
  'fnListen',
  'autoPaste',
  'updates',
  'advancedMode'
]

export const ADMIN_ONLY_SECTIONS: SectionKey[] = [
  'click',
  'suggestions',
  'devices',
  'storage',
  'smallPanel',
  // Still being dogfooded — the tray row is admin-gated too (main/index.ts).
  'voice',
  // PRD 2026-08-12-1786501335 §8: a dev-facing surface, kept off the main
  // consumer flow so it never adds a noun to onboarding.
  'agentRelay'
]

// Bucket membership, in render order. Capture used to hold 15 sections because
// new settings were appended to the end of the file rather than filed — half of
// them (Dock icon, sound, auto-paste, the three data toggles) had nothing to do
// with capturing the screen. These lists are the source of truth for which
// bucket a section belongs to, so refiling one is a one-line edit here.
export const BUCKETS = {
  phoneRemote: ['phoneRemote'],
  essentials: ['account', 'instructions', 'aiModel', 'credits', 'aiPlans', 'usage', 'advancedMode'],
  chat: ['chat', 'alerts'],
  projects: ['projects'],
  // Only things that watch, record, or act on the screen.
  capture: [
    'dictation',
    'actions',
    'voiceRouting',
    'cursor',
    'click',
    'actHighlight',
    'suggestions'
  ],
  // Everyday app behavior — how it looks and sounds, not what it captures.
  general: ['sound', 'island', 'voice', 'dockIcon', 'fnListen', 'autoPaste'],
  // What gets remembered, logged, or written to disk.
  privacy: ['feedback', 'agentPhotos', 'decisionCards', 'incognito', 'privacy'],
  advanced: [
    'recording',
    'captureHud',
    'showTiming',
    'contextLog',
    'runTranscript',
    'binaries',
    'devices',
    'storage',
    'smallPanel',
    'updates',
    'agentRelay'
  ]
} as const satisfies Record<string, readonly SectionKey[]>

export const COLLAPSE_STORAGE_KEY = 'mm-settings-collapsed-sections'

// Collapsed state persists across window opens via localStorage (renderer-only
// UI state — no need to round-trip through PREFS/IPC for this). Missing/corrupt
// storage just falls back to the defaults below.
export function loadCollapsedSections(): Partial<Record<SectionKey, boolean>> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Partial<Record<SectionKey, boolean>>
  } catch {
    return {}
  }
}

// DOM anchors for deep-linking into a section (tray → "Phone Remote…" opens
// Settings scrolled here). Keyed by the shared SettingsSectionFocus union so a
// main-process sender can't name a section that has no anchor.
// Every section gets a scroll target, derived from its key, so the sidebar can
// jump to any of them without 30 hand-written anchorId props. The four entries
// in SECTION_ANCHOR_ID below are the deep-link names main already sends and
// must keep their existing spelling — sectionDomId returns those verbatim.
export function sectionDomId(key: SectionKey): string {
  const deepLink = (SECTION_ANCHOR_ID as Partial<Record<SectionKey, string>>)[key]
  return deepLink ?? `section-${key}`
}

// Sidebar labels for each bucket, in BUCKETS order. Kept beside BUCKETS so a
// new bucket can't render as a nameless group.
export type BucketKey = keyof typeof BUCKETS

export function bucketOf(key: SectionKey): BucketKey {
  const keys = Object.keys(BUCKETS) as BucketKey[]
  return keys.find((b) => (BUCKETS[b] as readonly SectionKey[]).includes(key)) ?? 'essentials'
}

export const BUCKET_TITLES: Record<BucketKey, string> = {
  phoneRemote: 'Phone Remote',
  essentials: 'Essentials',
  chat: 'Chat',
  projects: 'Projects',
  capture: 'Capture',
  general: 'General',
  privacy: 'Privacy & data',
  advanced: 'Advanced'
}

export const SECTION_ANCHOR_ID: Record<SettingsSectionFocus, string> = {
  phoneRemote: 'section-phone-remote',
  // Where a failed capture sends the user — the ffmpeg install button lives here.
  binaries: 'section-binaries',
  // Where every upgrade CTA lands. In the deep-link union rather than a private
  // constant because the QR window reaches it from a DIFFERENT window, which an
  // in-window scroll target can't express.
  credits: 'section-credits',
  selectionBar: 'section-selection-bar',
  // Where "Connect a coding tool" lands, from the navigator and from a relay
  // card that found no agent connected.
  agentRelay: 'section-agent-relay'
}

// True when at least one of the named sections matches the query — used to
// hide a bucket header once all its sections are filtered out, so no orphan
// header floats above an empty region.
export function anySectionVisible(query: string, keys: readonly SectionKey[]): boolean {
  if (!query.trim()) return true
  return keys.some((k) => sectionMatches(query, SECTIONS[k].title, SECTIONS[k].keywords))
}

export function isOpenSection(
  key: SectionKey,
  ctx: CollapseCtx,
  searchForceOpen: boolean
): boolean {
  if (searchForceOpen || ctx.forceOpenKey === key) return true
  return !ctx.collapsed[key]
}
export const SETTINGS_PAGE_STORAGE_KEY = 'mm-settings-page'
const SIDEBAR_SHOWN_STORAGE_KEY = 'mm-settings-sidebar-shown'

export const SIDEBAR_WIDTH_PX = 224
export const CONTENT_WIDTH_PX = 688
// Below this the nav plus a readable column no longer both fit, so the nav
// hides itself. 380px is the widest settings card (SettingRow's max-w) plus
// the page gutters — under that the cards start wrapping mid-sentence.
const AUTO_HIDE_BELOW_PX = 672

// Whether the nav is visible: the user's explicit choice AND enough width to
// show it. Only the explicit choice is remembered — a window that was merely
// too narrow reopens the nav once it's resized back.
export function useSidebarVisible(): {
  shown: boolean
  toggle: () => void
} {
  const [wanted, setWanted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_SHOWN_STORAGE_KEY) !== 'false'
    } catch {
      return true
    }
  })
  const [wide, setWide] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= AUTO_HIDE_BELOW_PX
  )

  useEffect(() => {
    const onResize = (): void => setWide(window.innerWidth >= AUTO_HIDE_BELOW_PX)
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const toggle = useCallback(() => {
    setWanted((prev) => {
      const next = !prev
      try {
        localStorage.setItem(SIDEBAR_SHOWN_STORAGE_KEY, String(next))
      } catch {
        // localStorage unavailable — the choice just doesn't outlive the window.
      }
      return next
    })
  }, [])

  return { shown: wanted && wide, toggle }
}
