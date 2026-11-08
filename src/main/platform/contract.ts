/**
 * The contract every platform implementation (`./macos`, `./windows`, …) must
 * satisfy. This is NOT a hexagonal "port" object or a DI seam — it is just the
 * set of function signatures the picker (`./index.ts`) re-exports, expressed as
 * a type so TypeScript rejects a platform module that drifts from the shape.
 *
 * Split into per-domain sub-interfaces (mirrors the `BACKENDS` registry in
 * backend/adapters.ts) so a consumer imports one domain instead of a single
 * 60-method blob. Domain signatures are derived with `typeof import(...)` from
 * the existing macOS modules so the contract cannot silently drift from the
 * code that backs it — hand-written signatures come once a second real (non-
 * stub) implementation exists.
 *
 * All domain shapes (ContextData, PermissionKey, …) live in `shared/types.ts`;
 * we only reference them here. Adding a method = add it here, then every
 * platform module fails to typecheck until it implements it. That compile error
 * IS the cross-platform safety net.
 */
import type {
  ContextData,
  PermissionCheck,
  PermissionKey,
  PermissionState,
  PermissionTest
} from '../../shared/types'

// ── Selection (text in / out of the focused app) ────────────────────────────
export interface SelectionApi {
  captureSelection(passive?: boolean): Promise<string>
  pasteText(text: string): Promise<void>
  // Re-activate `appName` before pasting — for click-picked actions that blurred
  // the target field. Falls back to a plain paste when appName is ''.
  pasteTextToApp(text: string, appName: string): Promise<void>
  // Called just before a synthetic Cmd+V, so Away Mode's input watch can tell
  // our paste from a human's keypress and not relock the session.
  setSyntheticPasteListener(cb: (() => void) | null): void
}

// ── Accessibility control (drive another app's UI by label) ────────────────
/**
 * What the press attempt did. `status` is the binary's own vocabulary, kept
 * verbatim rather than collapsed to a boolean: a caller that has to speak the
 * outcome needs to tell "already running" from "started it" from "the button
 * isn't there", and those are three different sentences.
 */
export interface AxPressResult {
  /** ok = pressed and (if asked) verified · already = state already held ·
   *  not-found = no such control · not-running = app isn't open ·
   *  unverified = press delivered but the expected change never appeared ·
   *  failed = the spawn itself broke. */
  status: 'ok' | 'already' | 'not-found' | 'not-running' | 'unverified' | 'press-failed' | 'failed'
  /** True only when a post-condition was named AND observed. A caller that
   *  reports success to a user should require this, not just status === 'ok'. */
  verified: boolean
  /** The label actually pressed — which of the candidates matched. */
  pressed?: string
  /** The label that proved the state changed. */
  confirmedBy?: string
  /** Wall-clock for the whole attempt. The number that tells you whether a
   *  timeout needs raising or the app is simply slow to paint. */
  ms: number
  /** Everything the binary reported, for the log line. Untouched so a new
   *  field in the Swift doesn't need a change here to become visible. */
  raw?: Record<string, unknown>
}

export interface AxPressRequest {
  bundleId: string
  /** Candidate labels in priority order; the first one found is pressed. More
   *  than one because a single user-visible action often has two buttons behind
   *  it (a composer one and a sidebar one). */
  press: string[]
  /** Labels whose presence afterwards proves it worked. */
  verify?: string[]
  /** Labels whose presence BEFOREHAND means there is nothing to do. Without
   *  this, "start X" said twice restarts what the user was in the middle of. */
  already?: string[]
  timeoutMs?: number
}

// ── Context (sense the focused world) ───────────────────────────────────────
export interface ContextApi {
  captureContext(): Promise<ContextData>
  captureFinderSelection(): Promise<string[]>
  captureScreenshot(): Promise<string | null>

  frontmostBundleId: typeof import('./macos/app-context').frontmostBundleId
  userFacingFrontmostBundleId: typeof import('./macos/app-context').userFacingFrontmostBundleId
  waitForFrontmost: typeof import('./macos/app-context').waitForFrontmost
  readAppContext: typeof import('./macos/app-context').readAppContext
  readFrontmostScreen: typeof import('./macos/app-context').readFrontmostScreen
  activateAppItem: typeof import('./macos/app-context').activateAppItem
  activateAppPane: typeof import('./macos/app-context').activateAppPane
  activateAppGroup: typeof import('./macos/app-context').activateAppGroup

  onFrontmostAppChange: typeof import('./macos/frontmost-watch').onFrontmostAppChange
  onRunningAppsChange: typeof import('./macos/frontmost-watch').onRunningAppsChange
  pinFrontmostWatch: typeof import('./macos/frontmost-watch').pinFrontmostWatch
  stopFrontmostWatch: typeof import('./macos/frontmost-watch').stopFrontmostWatch

  listSwitchableApps: typeof import('./macos/app-switcher-list').listSwitchableApps
  activateApp: typeof import('./macos/activate-app').activateApp
  axPress: typeof import('./macos/ax-control').axPress

  quickSwitchApps: typeof import('./macos/quick-switch').quickSwitchApps
  resetQuickSwitchAnchor: typeof import('./macos/quick-switch').resetQuickSwitchAnchor
  getQuickSwitchAnchor: typeof import('./macos/quick-switch').getQuickSwitchAnchor
  setQuickSwitchAnchor: typeof import('./macos/quick-switch').setQuickSwitchAnchor
  afterQuickSwitchQueue: typeof import('./macos/quick-switch').afterQuickSwitchQueue

  applyWindowLayout: typeof import('./macos/window-layout').applyWindowLayout
  hasRestoreStash: typeof import('./macos/window-layout').hasRestoreStash
  clearRestoreStash: typeof import('./macos/window-layout').clearRestoreStash
}

// Re-exported so a consumer outside platform/ can name the type without a
// direct platform/macos/* import (the ESLint boundary rule bans that).
export type HostKeyboardLayoutType = import('./macos/input').HostKeyboardLayoutType

// ── Input (trackpad/keyboard synthesis — the mm-input verbs + moveloop) ─────
export interface InputApi {
  setSyntheticInputListener: typeof import('./macos/input').setSyntheticInputListener
  runInput: typeof import('./macos/input').runInput
  inputBinPath: typeof import('./macos/input').inputBinPath
  shotCommand: typeof import('./macos/input').shotCommand
  captureScreenWithoutUs: typeof import('./macos/input').captureScreenWithoutUs
  uiBinPath: typeof import('./macos/input').uiBinPath
  detectHostKeyboardType: typeof import('./macos/input').detectHostKeyboardType
  moveCursorFast: typeof import('./macos/input').moveCursorFast
  dragDownFast: typeof import('./macos/input').dragDownFast
  dragMoveFast: typeof import('./macos/input').dragMoveFast
  dragUpFast: typeof import('./macos/input').dragUpFast
  scrollFast: typeof import('./macos/input').scrollFast
  stopMoveLoop: typeof import('./macos/input').stopMoveLoop
  clickAt: typeof import('./macos/input').clickAt
  rightClickAt: typeof import('./macos/input').rightClickAt
  doubleClickAt: typeof import('./macos/input').doubleClickAt
  typeText: typeof import('./macos/input').typeText
  pressKeys: typeof import('./macos/input').pressKeys
  zoomMac: typeof import('./macos/input').zoomMac
  smartZoomMac: typeof import('./macos/input').smartZoomMac
  openAppOverview: typeof import('./macos/input').openAppOverview

  hideSystemCursor: typeof import('./macos/hide-cursor').hideSystemCursor
  showSystemCursor: typeof import('./macos/hide-cursor').showSystemCursor
  getCursorAppearance: typeof import('./macos/cursor-appearance').getCursorAppearance
  setCursorSize: typeof import('./macos/cursor-appearance').setCursorSize

  onFnEdge: typeof import('./macos/fn-watch').onFnEdge
  stopFnWatch: typeof import('./macos/fn-watch').stopFnWatch
}

// ── System (host-level state: volume/battery/computer-name/notch) ──────────
export interface SystemApi {
  getSystemVolume: typeof import('./macos/system-volume').getSystemVolume
  setSystemVolume: typeof import('./macos/system-volume').setSystemVolume
  getBatteryStatus: typeof import('./macos/battery-status').getBatteryStatus
  getComputerName: typeof import('./macos/computer-name').getComputerName
  getHostDevice: typeof import('./macos/computer-name').getHostDevice
  getNotchInfo: typeof import('./macos/notch-info').getNotchInfo
}

// ── Permissions (gate the app tail) ─────────────────────────────────────────
export interface PermissionsApi {
  hasAccessibility(prompt?: boolean): boolean
  list(): PermissionState[]
  request(key: PermissionKey): Promise<void>
  openPane(key: PermissionKey): void
}

// ── Binary resolution (find the chosen LLM CLI on PATH) ─────────────────────
export type InstallableTool = 'ffmpeg' | 'whisper' | 'node'

export interface BinariesApi {
  resolveBinary(name: string, override?: string): string | null
  resolveClaude(): string | null
  resolveCodex(): string | null
  resolveOpencode(): string | null
  resolveGemini(): string | null
  /** npm, resolved through version-manager dirs too (nvm/fnm/volta). */
  resolveNpm(): string | null
  /** Homebrew binary, or null when brew isn't installed. */
  resolveBrewBin(): string | null
  /** Can we `npm install -g` without sudo? Gates the one-click CLI install. */
  npmPrefixWritable(npmPath: string): boolean
  clearBinaryCache(): void
  /** Sentence Settings shows when `tool` is missing and one-click install
   *  can't run -- names this OS's package manager, never the other one's. */
  installHint(tool: InstallableTool): string
}

// ── Shell (spawn shell + PATH quoting — stub until Phase 3.2) ──────────────
export interface ShellApi {
  /** Shell binary every CLI child is spawned through (`/bin/zsh` on mac). */
  readonly bin: string
  /** Colon-joined dirs prepended to PATH for spawned children (homebrew on mac). */
  readonly pathPrefix: string
  /** Quote one value as a single argument for `bin`. */
  quote(s: string): string
  /** Argv that makes `bin` run one command string (`-c` on a POSIX shell, a
   *  four-flag incantation on PowerShell). Spawn sites pass this instead of
   *  hardcoding a switch that only one OS's shell understands. */
  spawnArgs(cmd: string): string[]
  /** Command-string fragment expanding to the CONTENTS of `path` as one
   *  argument. The agent CLIs take their prompt this way, and `$(cat …)` means
   *  nothing to PowerShell. */
  fileText(path: string): string
  /** The env CLI children run with (`pathPrefix` prepended to PATH). */
  env(): NodeJS.ProcessEnv
  /** The "use these native tools" line the act-mode system prompt shows the agent. */
  agentToolHints(): string
  /** Merge the user's real login-shell PATH into process.env.PATH once, at
   *  startup. Fixes packaged (GUI-launched) apps that inherit a minimal
   *  launchd PATH and so can't see ~/.local/bin CLIs or the CLIs' own auth.
   *  No-op where not needed. */
  applyLoginShellPath(): void
}

// ── Helpers (native binary resolution) ─────────────────────────────────────
export type { HelperName } from './macos/helpers'
export interface HelpersApi {
  /** Absolute path to a bundled native helper, or null where the OS ships none. */
  resolve(name: import('./macos/helpers').HelperName): string | null
}

// ── Chrome (the OS-specific slice of BrowserWindow options) ────────────────
export type ChromeKind = 'inset' | 'inset-notraffic' | 'panel' | 'vibrant'
export interface ChromeApi {
  windowOptions(kind: ChromeKind): Electron.BrowserWindowConstructorOptions
  showOnAllWorkspaces(win: Electron.BrowserWindow): void
}

/** UI-gating flags — a method may still throw `PlatformNotSupportedError`
 *  even when its flag is true; the flag says "worth showing the control",
 *  not "guaranteed to succeed". */
export interface Capabilities {
  readonly phoneMic: boolean
  readonly virtualDisplay: boolean
  readonly notch: boolean
  readonly windowLayout: boolean
  readonly appSwitcher: boolean
  readonly fnKey: boolean
  /** Synthetic cursor/scroll/drag. False disables the phone remote wholesale —
   *  a trackpad that cannot move the cursor is not a degraded remote. */
  readonly pointerControl: boolean
  readonly systemAudio: boolean
  readonly ocr: boolean
  readonly clamshell: boolean
  readonly nativeMic: boolean
  readonly browserUrl: boolean
}

/** OS automation + permissions + CLI resolution a single platform owns. */
export interface PlatformImpl {
  selection: SelectionApi
  context: ContextApi
  input: InputApi
  system: SystemApi
  permissions: PermissionsApi
  requiredPermissionKeys(): PermissionKey[]
  runSelfTest(key: PermissionKey): Promise<PermissionTest>
  buildPermissionChecks(): Promise<PermissionCheck[]>
  needsOnboarding(onboardingComplete: boolean): Promise<boolean>
  binaries: BinariesApi
  shell: ShellApi
  helpers: HelpersApi
  chrome: ChromeApi
  capabilities: Capabilities
}
