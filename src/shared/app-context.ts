export const APP_ADAPTER = {
  chrome: 'chrome',
  safari: 'safari',
  cmux: 'cmux',
  cursor: 'cursor'
} as const
export type AppAdapterId = (typeof APP_ADAPTER)[keyof typeof APP_ADAPTER]

export interface AppContextItem {
  id: string
  title: string
  subtitle: string
  active: boolean
  iconPngBase64: string
}

/** One tmux pane inside a terminal — the level Roy actually navigates, since he
 *  runs six agents as panes in a single cmux terminal. Only an adapter that can
 *  prove a terminal is a tmux one ever fills these. */
export interface AppContextPane {
  /** tmux's `#{pane_id}` (the `%47` form). NEVER `pane_index`: killing a sibling
   *  shifted a live pane's index 1→0 while its id held, and re-resolving an index
   *  against a list read at a different moment is this repo's three-time bug. */
  id: string
  title: string
  active: boolean
  zoomed: boolean
}

export interface AppContextGroup {
  id: string
  name: string
  iconPngBase64: string
  subtitle: string
  itemCount: number
  active: boolean
}

export interface AppContextReading {
  items: AppContextItem[]
  groups: AppContextGroup[]
  activeGroupId: string
  /** Whether the focused pane is fullscreened (tmux's ctrl+b z), when the
   *  adapter can prove the pane is a tmux one. `null` means "no tmux here, or
   *  we could not ask" — a plain shell and an unreachable tmux server are the
   *  same answer to the button: stay stateless rather than claim `false`. */
  tmuxZoomed: boolean | null
  /** Panes inside the FOCUSED terminal, when that terminal runs tmux. Optional
   *  rather than a defaulted array because the level is per-TERMINAL, not
   *  per-adapter: half of a live cmux window's panels were plain shells, and a
   *  browser tab has nothing inside it at all. Absent means "no third level
   *  here", which is what the bar keys its third chip on. */
  panes?: AppContextPane[]
}

export interface AppContext extends AppContextReading {
  adapterId: AppAdapterId | null
  appName: string
  bundleId: string
  appIconPngBase64: string
}

export const EMPTY_READING: AppContextReading = {
  items: [],
  groups: [],
  activeGroupId: '',
  tmuxZoomed: null
}

/** Bundle id prefixes belonging to MightyMouse itself. Dev runs as raw
 *  Electron (com.github.Electron), the shipped app as com.mightymouse.* */
export const OWN_BUNDLE_PREFIXES = ['com.mightymouse', 'com.github.Electron'] as const

export function isOwnBundleId(bundleId: string): boolean {
  return OWN_BUNDLE_PREFIXES.some((p) => bundleId.startsWith(p))
}
