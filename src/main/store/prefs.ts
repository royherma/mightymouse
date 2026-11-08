import { isCatalogModel } from '../model-catalog'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PATHS } from './paths'
import {
  AppMode,
  AnalyticsRange,
  MightySettings,
  MightyOutputFormat,
  ChatTabNameFormat,
  GlobalInstructionsSettings,
  GlobalInstructionsAppliesTo,
  WindowBounds,
  ChatWorkspaceTab,
  ChatPaneRef,
  PaneLayoutState,
  PhoneRemoteSkin,
  InstallableSkin,
  isInstallableSkin,
  REMOTE_SKIN_PREFIX,
  PhoneRemoteColorScheme,
  PhoneRemoteHandedness,
  PhoneRemoteKeysPosition,
  PhoneRemoteDeckMode,
  PhoneRemoteSplitConcept,
  isPhoneRemoteSplitConcept,
  PhoneRemoteMirrorPlacement,
  isPhoneRemoteMirrorPlacement,
  VoiceRoutingMode,
  MightyMode,
  isMightyMode
} from '../../shared/types'
import { isAppMode } from '../../shared/mode'
import { BackendId, toBackendId } from '../backend/adapters'
import { CursorStyleId, DEFAULT_CURSOR_STYLE, toCursorStyle } from '../../shared/cursor-styles'
import {
  CompanionRendererId,
  DEFAULT_COMPANION_RENDERER,
  toCompanionRenderer
} from '../../shared/companion-renderers'
import {
  DEFAULT_COMPANION_SIZE,
  toCompanionSize,
  type CompanionSize
} from '../../shared/companion-size'
import { CONFIG } from '../../shared/config'
import {
  DEFAULT_RELAY_MAC_ALERTS,
  DEFAULT_RELAY_PUSH_FILTER,
  DEFAULT_RELAY_TURN_END_PING,
  RELAY_PUSH_VERBS,
  type RelayMacAlertSettings,
  type RelayPushFilter,
  type RelayNotifyPushLevel
} from '../../shared/relay-push-filter'
import {
  ONBOARDING_STEP_KEYS,
  type OnboardingStepKey
} from '../../shared/analytics-events'

// Persisted shape of MIGHTY_WORKSPACES_PREF. Just the tabs — the auto-naming scheme
// (workspace-naming.ts) derives each day's next letter by scanning existing tab names
// for today's date prefix rather than tracking a separate counter, so a deleted tab
// can never desync a counter from what's actually on screen. Wrapped in an object
// (not a bare array) so the file can gain sibling fields later without a shape change.
interface MightyWorkspacesBlob {
  tabs: ChatWorkspaceTab[]
}

function isValidChatPaneRef(v: unknown): v is ChatPaneRef {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<ChatPaneRef>
  if (p.bindGen !== undefined && typeof p.bindGen !== 'number') return false
  if (p.agentLabel !== undefined && typeof p.agentLabel !== 'string') return false
  if (p.agentCwd !== undefined && typeof p.agentCwd !== 'string') return false
  return typeof p.id === 'string' && (p.sessionId === null || typeof p.sessionId === 'string')
}

function isValidChatWorkspaceTab(v: unknown): v is ChatWorkspaceTab {
  if (!v || typeof v !== 'object') return false
  const t = v as Partial<ChatWorkspaceTab>
  if (typeof t.id !== 'string' || typeof t.name !== 'string' || typeof t.createdAt !== 'string') {
    return false
  }
  if (!Array.isArray(t.panes) || !t.panes.every(isValidChatPaneRef)) return false
  if (!t.layout || typeof t.layout !== 'object') return false
  const layout = t.layout as Partial<PaneLayoutState>
  const ratiosOk = (r: unknown): boolean =>
    r === undefined || (Array.isArray(r) && r.every((n) => typeof n === 'number' && Number.isFinite(n)))
  return ratiosOk(layout.colRatios) && ratiosOk(layout.rowRatios)
}

// Shared read used by every workspaces getter/setter above, so a malformed file
// always resolves to a safe empty shape instead of throwing mid-write.
function readMightyWorkspacesBlob(): MightyWorkspacesBlob {
  if (!existsSync(PATHS.MIGHTY_WORKSPACES_PREF)) return { tabs: [] }
  try {
    const raw = JSON.parse(readFileSync(PATHS.MIGHTY_WORKSPACES_PREF, 'utf-8')) as unknown
    const blob = raw as Partial<MightyWorkspacesBlob>
    const tabs = Array.isArray(blob?.tabs) ? blob.tabs.filter(isValidChatWorkspaceTab) : []
    return { tabs }
  } catch {
    return { tabs: [] }
  }
}

// One-shot migration (2026-07-22): 'proII' shipped as a third COLOR SCHEME value
// but was always a skin of the pro pad; it moves onto the skin axis below.
// If the scheme file still holds 'proII', rewrite both files so an already-paired
// phone keeps its look instead of silently snapping back to plain pro/light.
function migrateProIIColorSchemeToLayout(): void {
  try {
    if (!existsSync(PATHS.PHONE_REMOTE_COLOR_SCHEME)) return
    if (readFileSync(PATHS.PHONE_REMOTE_COLOR_SCHEME, 'utf-8').trim() !== 'proII') return
    writeFileSync(PATHS.PHONE_REMOTE_LAYOUT, 'proII', 'utf-8')
    writeFileSync(PATHS.PHONE_REMOTE_COLOR_SCHEME, CONFIG.PHONE_REMOTE.COLOR_SCHEME_DEFAULT, 'utf-8')
  } catch {
    // Unreadable pref files already fall back to defaults in the getters.
  }
}

/** Is a `remote:<id>` skin's payload actually on disk?
 *
 *  A remote skin is two separate things: an id in the pref file, and a directory
 *  of assets under REMOTE_SKINS_DIR. Only the first is durable — uninstalling,
 *  a failed re-extract, or a wiped data dir removes the second and leaves the
 *  pref pointing at nothing. The manifest is the same file listInstalledRemoteSkins
 *  treats as the proof a skin exists, so checking for it here keeps both
 *  definitions of "installed" identical.
 *
 *  Deliberately a bare existsSync rather than an import from
 *  phone-remote/remote-skins.ts: the store layer sits UNDER phone-remote, and
 *  reaching up would invert that dependency for one boolean. Built-ins are
 *  compiled into the bundle and always present, so they short-circuit true. */
function remoteSkinIsInstalled(skin: InstallableSkin): boolean {
  if (!skin.startsWith(REMOTE_SKIN_PREFIX)) return true
  const id = skin.slice(REMOTE_SKIN_PREFIX.length)
  // The id charset is validated upstream by isInstallableSkin, so it cannot
  // contain a path separator or `..` by the time it reaches this join.
  return existsSync(join(PATHS.REMOTE_SKINS_DIR, id, 'manifest.json'))
}

// Pre-split layout values that were really SKINS of the pro layout, mapped onto
// the axis they belong to. Drives the migration below AND the layout getter's
// coercion, so both agree on what an old value means.
const LEGACY_LAYOUT_SKINS: Readonly<Record<string, PhoneRemoteSkin>> = {
  proII: 'proII',
  cap: 'cap'
}

// One-shot migration (2026-07-23): 'proII' and 'cap' shipped as LAYOUT values
// but were always skins of the pro layout — same component, same DOM, different
// paint. They live on PhoneRemoteSkin now. Rewrite an old layout file to
// layout='pro' + the matching skin so an already-paired phone keeps its look
// instead of silently snapping back to the default skin.
//
// Runs before every layout/skin read (both getters call it) rather than once at
// boot: the getters are the only entry points, and a no-op existsSync on an
// already-migrated file is cheaper than a boot-order dependency.
function migrateLayoutSkinsToSkinAxis(): void {
  try {
    if (!existsSync(PATHS.PHONE_REMOTE_LAYOUT)) return
    const legacy = readFileSync(PATHS.PHONE_REMOTE_LAYOUT, 'utf-8').trim()
    const skin = LEGACY_LAYOUT_SKINS[legacy]
    if (!skin) return
    // Skin first: if the process dies between the two writes, the layout file
    // still holds the legacy value and this migration re-runs cleanly. Writing
    // layout first would strand the skin at its default with no way back.
    writeFileSync(PATHS.PHONE_REMOTE_SKIN, skin, 'utf-8')
    writeFileSync(PATHS.PHONE_REMOTE_LAYOUT, 'pro', 'utf-8')
  } catch {
    // Unreadable pref files already fall back to defaults in the getters.
  }
}

/** Read the relay push file as a bag of keys, or an empty one. Every getter
 *  below re-reads rather than caching: the phone's alerts sheet and the Mac's
 *  screen both write it, so a cached copy would go stale the moment the other
 *  surface saved. */
function readRelayPushFile(): Record<string, unknown> {
  if (!existsSync(PATHS.AGENT_RELAY_PUSH_FILTER)) return {}
  try {
    const raw = JSON.parse(readFileSync(PATHS.AGENT_RELAY_PUSH_FILTER, 'utf-8')) as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Merge-write, never a whole-file replace. The phone-side setters each rebuild
 *  the file from `{...filter, notifyLevel, turnEndPing}`, which would silently
 *  DROP the Mac's `mac` block every time Roy touched a phone switch. Reading
 *  first and spreading over it keeps whichever half this writer does not own. */
function writeRelayPushFile(fields: Record<string, unknown>): void {
  writeFileSync(
    PATHS.AGENT_RELAY_PUSH_FILTER,
    JSON.stringify({ ...readRelayPushFile(), ...fields }),
    'utf-8'
  )
}

export type ChatModelBackend = 'opencode' | 'openrouter' | 'claude' | 'codex'

const CHAT_MODEL_FILES: Record<ChatModelBackend, string> = {
  opencode: PATHS.OPENCODE_MODEL_FILE,
  openrouter: PATHS.OPENROUTER_MODEL_FILE,
  claude: PATHS.CLAUDE_CHAT_MODEL_FILE,
  codex: PATHS.CODEX_CHAT_MODEL_FILE
}

const chatModelFile = (backend: ChatModelBackend): string => CHAT_MODEL_FILES[backend]

export const PREFS = {
  // Staging-only escape hatch: skip real sign-in with a synthetic test-admin user
  // so we can keep working while auth/billing is in flux. HARD-gated on IS_STAGING
  // — in a packaged prod build this always reads false and can never be set true,
  // so the auth gate is never weakened where it matters.
  getDevBypassAuth(): boolean {
    return PREFS.getDevBypassAccount() !== null
  },

  /**
   * Which seeded test admin the bypass signs in as, or null when it's off.
   * The file holds an email; the legacy '1' from before multi-account predates
   * that and means the first account, so an existing install stays signed in.
   */
  getDevBypassAccount(): string | null {
    if (!CONFIG.IS_STAGING) return null
    if (!existsSync(PATHS.DEV_BYPASS_AUTH)) return null
    try {
      const raw = readFileSync(PATHS.DEV_BYPASS_AUTH, 'utf-8').trim()
      if (raw === '' || raw === '0') return null
      if (raw === '1') return CONFIG.STAGING_TEST_ADMINS[0].EMAIL
      const known = CONFIG.STAGING_TEST_ADMINS.find(
        (a) => a.EMAIL.toLowerCase() === raw.toLowerCase()
      )
      return known?.EMAIL ?? null
    } catch {
      return null
    }
  },

  /** Pass an email to sign in as it, or null to turn the bypass off. */
  setDevBypassAccount(email: string | null): void {
    if (!CONFIG.IS_STAGING) return
    try {
      writeFileSync(PATHS.DEV_BYPASS_AUTH, email ?? '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write dev-bypass-auth toggle:', err)
    }
  },
  // Stable anonymous device id. Generated once on first read, persisted forever.
  // Every analytics event carries it so pre-sign-in usage can be stitched to a
  // user on sign-in (see analytics.identify).
  getAnonId(): string {
    if (existsSync(PATHS.ANON_ID)) {
      try {
        const id = readFileSync(PATHS.ANON_ID, 'utf-8').trim()
        if (id !== '') return id
      } catch {}
    }
    const id = randomUUID()
    try {
      writeFileSync(PATHS.ANON_ID, id, 'utf-8')
    } catch (err) {
      console.error('Failed to write anon id:', err)
    }
    return id
  },

  getLastInstruction(): string {
    if (!existsSync(PATHS.LAST_INSTR)) return ''
    try {
      return readFileSync(PATHS.LAST_INSTR, 'utf-8').trim()
    } catch {
      return ''
    }
  },

  setLastInstruction(instr: string): void {
    if (this.getIncognito()) return
    try {
      writeFileSync(PATHS.LAST_INSTR, instr.trim(), 'utf-8')
    } catch (err) {
      console.error('Failed to write last instruction:', err)
    }
  },

  getLastMode(): AppMode | null {
    if (!existsSync(PATHS.LAST_MODE)) return null
    try {
      const mode = readFileSync(PATHS.LAST_MODE, 'utf-8').trim().toLowerCase()
      if (isAppMode(mode)) return mode
    } catch {}
    return null
  },

  setLastMode(mode: AppMode | null): void {
    if (this.getIncognito()) return
    try {
      writeFileSync(PATHS.LAST_MODE, mode || '', 'utf-8')
    } catch (err) {
      console.error('Failed to write last mode:', err)
    }
  },

  // Live, unsubmitted panel input. Written on every keystroke (debounced by the
  // renderer) so a draft survives a Panel remount, not just an explicit submit
  // (submit already persists via setLastInstruction). Cleared on submit/Stop/
  // reset so a stale draft never resurfaces after the user acts on it.
  getDraftInput(): string {
    if (!existsSync(PATHS.DRAFT_INPUT)) return ''
    try {
      return readFileSync(PATHS.DRAFT_INPUT, 'utf-8')
    } catch {
      return ''
    }
  },

  setDraftInput(text: string): void {
    if (this.getIncognito()) return
    try {
      writeFileSync(PATHS.DRAFT_INPUT, text, 'utf-8')
    } catch (err) {
      console.error('Failed to write draft input:', err)
    }
  },

  // The quick-action key currently selected in the panel (mirrors in-memory
  // panelState.activeAction). Empty = none selected. Cleared alongside the draft.
  getActiveActionKey(): string {
    if (!existsSync(PATHS.ACTIVE_ACTION_KEY)) return ''
    try {
      return readFileSync(PATHS.ACTIVE_ACTION_KEY, 'utf-8').trim()
    } catch {
      return ''
    }
  },

  setActiveActionKey(key: string | null): void {
    try {
      writeFileSync(PATHS.ACTIVE_ACTION_KEY, key || '', 'utf-8')
    } catch (err) {
      console.error('Failed to write active action key:', err)
    }
  },

  getCtxToggle(): boolean {
    if (!existsSync(PATHS.CTX_PREF)) return false
    try {
      return readFileSync(PATHS.CTX_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setCtxToggle(on: boolean): void {
    try {
      writeFileSync(PATHS.CTX_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write context toggle:', err)
    }
  },

  getBackend(): BackendId {
    if (!existsSync(PATHS.BACKEND_FILE)) return toBackendId(null)
    try {
      return toBackendId(readFileSync(PATHS.BACKEND_FILE, 'utf-8').trim().toLowerCase())
    } catch {
      return toBackendId(null)
    }
  },

  setBackend(backend: BackendId): void {
    try {
      writeFileSync(PATHS.BACKEND_FILE, backend, 'utf-8')
    } catch (err) {
      console.error('Failed to write backend:', err)
    }
  },

  getOllamaModel(): string {
    if (!existsSync(PATHS.OLLAMA_MODEL_FILE)) return ''
    try {
      return readFileSync(PATHS.OLLAMA_MODEL_FILE, 'utf-8').trim()
    } catch {
      return ''
    }
  },

  setOllamaModel(model: string): void {
    try {
      writeFileSync(PATHS.OLLAMA_MODEL_FILE, model.trim(), 'utf-8')
    } catch (err) {
      console.error('Failed to write ollama model:', err)
    }
  },

  getBrowserTaskModel(): string {
    if (!existsSync(PATHS.BROWSER_TASK_MODEL_FILE)) return ''
    try {
      return readFileSync(PATHS.BROWSER_TASK_MODEL_FILE, 'utf-8').trim()
    } catch {
      return ''
    }
  },

  setBrowserTaskModel(choice: string): void {
    try {
      writeFileSync(PATHS.BROWSER_TASK_MODEL_FILE, choice, 'utf-8')
    } catch (err) {
      console.error('Failed to write browser task model:', err)
    }
  },

  // Default OFF, so file-absent means disabled — matches the shipped hardcode.
  getThinkingEnabled(): boolean {
    if (!existsSync(PATHS.THINKING_FILE)) return false
    try {
      return readFileSync(PATHS.THINKING_FILE, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setThinkingEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.THINKING_FILE, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write thinking pref:', err)
    }
  },

  getMlxModel(): string {
    if (!existsSync(PATHS.MLX_MODEL_FILE)) return ''
    try {
      return readFileSync(PATHS.MLX_MODEL_FILE, 'utf-8').trim()
    } catch {
      return ''
    }
  },

  setMlxModel(model: string): void {
    try {
      writeFileSync(PATHS.MLX_MODEL_FILE, model.trim(), 'utf-8')
    } catch (err) {
      console.error('Failed to write mlx model:', err)
    }
  },

  getChatModel(backend: ChatModelBackend): string {
    const file = chatModelFile(backend)
    try {
      return existsSync(file) ? readFileSync(file, 'utf-8').trim() : ''
    } catch {
      return ''
    }
  },

  setChatModel(backend: ChatModelBackend, model: string): void {
    try {
      writeFileSync(chatModelFile(backend), model.trim(), 'utf-8')
    } catch (err) {
      console.error(`Failed to write ${backend} model:`, err)
    }
  },

  // The paid `mightymouse` backend's per-conversation model pick (an OpenRouter
  // slug from the live model list). Empty string = use the server's feature-routed
  // default. A persisted value that's no longer in the catalog (model removed) is
  // treated as empty so a stale pick can never pin a model the UI can't show — the
  // server allowlist is still the real gate, this is just so the chip/dropdown agree.
  getSelectedModel(): string {
    if (!existsSync(PATHS.SELECTED_MODEL_FILE)) return ''
    try {
      const id = readFileSync(PATHS.SELECTED_MODEL_FILE, 'utf-8').trim()
      return isCatalogModel(id) ? id : ''
    } catch {
      return ''
    }
  },

  setSelectedModel(model: string): void {
    try {
      // Only persist a known catalog id (or empty to clear) — never a junk string.
      const clean = model.trim()
      const value = clean === '' || isCatalogModel(clean) ? clean : ''
      writeFileSync(PATHS.SELECTED_MODEL_FILE, value, 'utf-8')
    } catch (err) {
      console.error('Failed to write selected model:', err)
    }
  },

  getCursorCompanion(): boolean {
    if (!existsSync(PATHS.CURSOR_PREF)) return false
    try {
      return readFileSync(PATHS.CURSOR_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setCursorCompanion(on: boolean): void {
    try {
      writeFileSync(PATHS.CURSOR_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write cursor companion toggle:', err)
    }
  },

  // Phone Remote (QR-paired trackpad + voice) toggle. Default OFF (opt-in) —
  // file-absent means disabled, so no server ever listens until the user flips
  // this on in Settings. Restored on launch (see startAppTail in main/index.ts).
  getPhoneRemoteEnabled(): boolean {
    if (!existsSync(PATHS.PHONE_REMOTE_PREF)) return false
    try {
      return readFileSync(PATHS.PHONE_REMOTE_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setPhoneRemoteEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote toggle:', err)
    }
  },

  // Agent relay MCP server (PRD 2026-08-12-1786501335). Default OFF -- a
  // dev-facing tool nobody should discover running by accident.
  getAgentRelayEnabled(): boolean {
    if (!existsSync(PATHS.AGENT_RELAY_PREF)) return false
    try {
      return readFileSync(PATHS.AGENT_RELAY_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setAgentRelayEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.AGENT_RELAY_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write agent relay toggle:', err)
    }
  },

  getPulseEnabled(): boolean {
    try {
      return readFileSync(PATHS.PULSE_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setPulseEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.PULSE_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write pulse toggle:', err)
    }
  },

  getPulseSessions(): Set<string> {
    try {
      return new Set(readFileSync(PATHS.PULSE_SESSIONS, 'utf-8').split('\n').filter(Boolean))
    } catch {
      return new Set()
    }
  },

  setPulseSession(sessionId: string, on: boolean): void {
    const ids = PREFS.getPulseSessions()
    if (on) ids.add(sessionId)
    else ids.delete(sessionId)
    try {
      writeFileSync(PATHS.PULSE_SESSIONS, [...ids].join('\n'), 'utf-8')
    } catch (err) {
      console.error('Failed to write pulse sessions:', err)
    }
  },

  // Whether an agent may pull a photo off the paired phone. Default OFF, and
  // read at REGISTRATION time rather than inside the verb: while this is off
  // the photo tools must be absent from the agent's tool list entirely, not
  // present and erroring (PRD decision 4).
  getAgentRelayPhotosEnabled(): boolean {
    if (!existsSync(PATHS.AGENT_RELAY_PHOTOS_PREF)) return false
    try {
      return readFileSync(PATHS.AGENT_RELAY_PHOTOS_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setAgentRelayPhotosEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.AGENT_RELAY_PHOTOS_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write agent photos toggle:', err)
    }
  },

  getDecisionCardsEnabled(): boolean {
    try {
      return existsSync(PATHS.DECISION_CARDS_PREF) && readFileSync(PATHS.DECISION_CARDS_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setDecisionCardsEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.DECISION_CARDS_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write decision cards toggle:', err)
    }
  },

  // Mirror every relay card to a native macOS notification. Read live on each
  // push, so flipping it needs no restart -- which is the whole point: the
  // restart is what kept losing the setting.
  getAgentRelayMacNotify(): boolean {
    if (!existsSync(PATHS.AGENT_RELAY_MAC_NOTIFY_PREF)) return false
    try {
      return readFileSync(PATHS.AGENT_RELAY_MAC_NOTIFY_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setAgentRelayMacNotify(on: boolean): void {
    try {
      writeFileSync(PATHS.AGENT_RELAY_MAC_NOTIFY_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write agent relay mac-notify toggle:', err)
    }
  },

  // Which verbs may buzz the phone (PRD 2026-08-14-1786690000). Gates the PUSH
  // only -- the card is minted into the store before the push is ever sent, so
  // a muted verb still reaches every inbox. All four are muteable by Roy's
  // call; muting `ask`/`approve` can leave an agent blocked with no phone
  // signal, which is why they default on and the Settings copy says out loud
  // that the card still arrives.
  getAgentRelayPushFilter(): RelayPushFilter {
    if (!existsSync(PATHS.AGENT_RELAY_PUSH_FILTER)) return { ...DEFAULT_RELAY_PUSH_FILTER }
    try {
      const raw = JSON.parse(readFileSync(PATHS.AGENT_RELAY_PUSH_FILTER, 'utf-8')) as unknown
      if (!raw || typeof raw !== 'object') return { ...DEFAULT_RELAY_PUSH_FILTER }
      const stored = raw as Record<string, unknown>
      // Per-verb, not all-or-nothing: a file that has lost one key still
      // honours the other three, and only the missing verb falls back to on.
      return RELAY_PUSH_VERBS.reduce((filter, verb) => {
        filter[verb] = stored[verb] === false ? false : true
        return filter
      }, {} as RelayPushFilter)
    } catch {
      return { ...DEFAULT_RELAY_PUSH_FILTER }
    }
  },

  setAgentRelayPushFilter(filter: RelayPushFilter): void {
    try {
      const floor = this.getAgentRelayNotifyLevel()
      writeRelayPushFile({
        ...filter,
        notifyLevel: floor,
        turnEndPing: this.getAgentRelayTurnEndPing()
      })
    } catch (err) {
      console.error('Failed to write agent relay push filter:', err)
    }
  },

  // Severity floor under the notify switch, in the same file: one read, one
  // write, one broadcast. `notifyLevel` can't collide with a verb key -- the
  // verb reducer above only ever looks up RELAY_PUSH_VERBS.
  getAgentRelayNotifyLevel(): RelayNotifyPushLevel {
    if (!existsSync(PATHS.AGENT_RELAY_PUSH_FILTER)) return 'all'
    try {
      const raw = JSON.parse(readFileSync(PATHS.AGENT_RELAY_PUSH_FILTER, 'utf-8')) as unknown
      if (!raw || typeof raw !== 'object') return 'all'
      // Anything but the one opt-in value reads as 'all': a corrupt or older
      // file must fail toward being notified, never toward silence.
      return (raw as Record<string, unknown>).notifyLevel === 'problems' ? 'problems' : 'all'
    } catch {
      return 'all'
    }
  },

  setAgentRelayNotifyLevel(level: RelayNotifyPushLevel): void {
    try {
      const filter = this.getAgentRelayPushFilter()
      writeRelayPushFile({
        ...filter,
        notifyLevel: level,
        turnEndPing: this.getAgentRelayTurnEndPing()
      })
    } catch (err) {
      console.error('Failed to write agent relay notify level:', err)
    }
  },

  // Same file again, but the CONSUMER is the Stop hook, not any send path in
  // this process -- the turn-end ping is fired by ~/.claude/hooks/mm-relay-notify.sh,
  // which reads this JSON directly. Opt-IN (see DEFAULT_RELAY_TURN_END_PING):
  // unlike the verbs, a missing key must fail toward silence, because switching
  // it on for someone who never asked buzzes them on every finished turn.
  getAgentRelayTurnEndPing(): boolean {
    if (!existsSync(PATHS.AGENT_RELAY_PUSH_FILTER)) return DEFAULT_RELAY_TURN_END_PING
    try {
      const raw = JSON.parse(readFileSync(PATHS.AGENT_RELAY_PUSH_FILTER, 'utf-8')) as unknown
      if (!raw || typeof raw !== 'object') return DEFAULT_RELAY_TURN_END_PING
      return (raw as Record<string, unknown>).turnEndPing === true
    } catch {
      return DEFAULT_RELAY_TURN_END_PING
    }
  },

  setAgentRelayTurnEndPing(on: boolean): void {
    try {
      const filter = this.getAgentRelayPushFilter()
      writeRelayPushFile({
        ...filter,
        notifyLevel: this.getAgentRelayNotifyLevel(),
        turnEndPing: on
      })
    } catch (err) {
      console.error('Failed to write agent relay turn-end ping:', err)
    }
  },

  // The Mac's OWN alert answers (PRD 2026-08-22-1787388684), in the same file
  // as the phone's. Absence means "whatever the phone says", which is exactly
  // what shipped before this block existed -- so an install that has never
  // opened the new screen behaves identically until Roy touches a switch.
  //
  // `enabled` is the exception and stays false: it replaces the old
  // agent-relay-mac-notify.txt toggle, which also defaulted off.
  getAgentRelayMacAlerts(): RelayMacAlertSettings {
    const stored = readRelayPushFile()
    const mac = stored.mac
    if (!mac || typeof mac !== 'object') {
      // No Mac block yet: mirror the phone's verbs and floor, so switching the
      // master on gives the same alerts the phone already gets rather than a
      // set of defaults Roy never chose.
      return {
        ...DEFAULT_RELAY_MAC_ALERTS,
        enabled: this.getAgentRelayMacNotify(),
        filter: this.getAgentRelayPushFilter(),
        notifyLevel: this.getAgentRelayNotifyLevel()
      }
    }
    const bag = mac as Record<string, unknown>
    // Per-verb, like the phone's reducer: a file that lost one key still
    // honours the rest, and the missing verb fails toward being told.
    const filter = RELAY_PUSH_VERBS.reduce((acc, verb) => {
      acc[verb] = bag[verb] === false ? false : true
      return acc
    }, {} as RelayPushFilter)
    return {
      enabled: bag.enabled === true,
      renderer: bag.renderer === 'card' ? 'card' : 'native',
      filter,
      notifyLevel: bag.notifyLevel === 'problems' ? 'problems' : 'all'
    }
  },

  setAgentRelayMacAlerts(next: RelayMacAlertSettings): void {
    try {
      writeRelayPushFile({
        mac: {
          ...next.filter,
          enabled: next.enabled,
          renderer: next.renderer,
          notifyLevel: next.notifyLevel
        }
      })
    } catch (err) {
      console.error('Failed to write agent relay mac alerts:', err)
    }
  },

  // Keep the display awake while Phone Remote runs. Default OFF (opt-in) --
  // blocking display sleep has a real battery cost, so the user turns it on
  // deliberately rather than discovering their Mac stopped sleeping. Layered on
  // the base toggle above: only ever consulted while the remote is enabled.
  getPhoneRemoteStayAwake(): boolean {
    if (!existsSync(PATHS.PHONE_REMOTE_STAY_AWAKE)) return false
    try {
      return readFileSync(PATHS.PHONE_REMOTE_STAY_AWAKE, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setPhoneRemoteStayAwake(on: boolean): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_STAY_AWAKE, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote stay-awake toggle:', err)
    }
  },

  // Clamshell (lid-closed) mode. Default OFF, and a HARDER opt-in than
  // stay-awake above: it sets a machine-wide `pmset disablesleep` flag behind an
  // admin prompt. Stored so Settings can show the toggle's last state, but it is
  // NEVER auto-restored on launch -- clamshell.ts clears any stale flag at
  // startup instead (see revertClamshellOnLaunch), so a crash can't leave the
  // machine permanently awake. The pref records intent; the machine state is
  // always re-derived from pmset itself.
  getPhoneRemoteClamshell(): boolean {
    if (!existsSync(PATHS.PHONE_REMOTE_CLAMSHELL)) return false
    try {
      return readFileSync(PATHS.PHONE_REMOTE_CLAMSHELL, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setPhoneRemoteClamshell(on: boolean): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_CLAMSHELL, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote clamshell toggle:', err)
    }
  },

  // Away Mode -- keep driving the Mac after walking away. The hardest opt-in of
  // the three: for the length of a phone session it holds the Mac unlocked (the
  // display-sleep block keeps the idle lock from arming) and relocks on the way
  // out. Records INTENT only, never auto-applied on launch; away-mode.ts
  // acquires it per session. A crash can't leave a Mac that never locks -- the
  // hold is just the display-sleep blocker, which dies with the process, so the
  // idle lock re-arms on its own.
  getPhoneRemoteAwayMode(): boolean {
    if (!existsSync(PATHS.PHONE_REMOTE_AWAY_MODE)) return false
    try {
      return readFileSync(PATHS.PHONE_REMOTE_AWAY_MODE, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setPhoneRemoteAwayMode(on: boolean): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_AWAY_MODE, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote Away Mode toggle:', err)
    }
  },

  // Off-Wi-Fi (Cloudflare Tunnel) access. Defaults ON: the tunnel reaches the
  // Mac from any network AND carries a real CA cert, which removes the
  // self-signed warning from pairing -- the LAN path is the fallback now, not
  // the primary. An explicit off is still honored; only the absent file reads
  // as on, so a user who turned this off stays off across upgrades.
  getPhoneRemoteTunnelEnabled(): boolean {
    if (!existsSync(PATHS.PHONE_REMOTE_TUNNEL_PREF)) return true
    try {
      return readFileSync(PATHS.PHONE_REMOTE_TUNNEL_PREF, 'utf-8').trim() === '1'
    } catch {
      // Unreadable file is not an opt-out -- match the absent-file default.
      return true
    }
  },

  setPhoneRemoteTunnelEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_TUNNEL_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote tunnel toggle:', err)
    }
  },

  // Trackpad move sensitivity — a multiplier applied to every dx/dy the phone
  // sends (see applyMoveDelta in ipc/phone-remote.ts). Default 1.0 = the raw
  // finger-delta passthrough that shipped originally; user asked for a way to
  // turn it up without hardcoding one "right" speed for everyone.
  getPhoneRemoteSensitivity(): number {
    if (!existsSync(PATHS.PHONE_REMOTE_SENSITIVITY)) return CONFIG.PHONE_REMOTE.SENSITIVITY_DEFAULT
    try {
      const n = parseFloat(readFileSync(PATHS.PHONE_REMOTE_SENSITIVITY, 'utf-8').trim())
      if (!Number.isFinite(n)) return CONFIG.PHONE_REMOTE.SENSITIVITY_DEFAULT
      return Math.min(CONFIG.PHONE_REMOTE.SENSITIVITY_MAX, Math.max(CONFIG.PHONE_REMOTE.SENSITIVITY_MIN, n))
    } catch {
      return CONFIG.PHONE_REMOTE.SENSITIVITY_DEFAULT
    }
  },

  setPhoneRemoteSensitivity(value: number): void {
    const clamped = Math.min(
      CONFIG.PHONE_REMOTE.SENSITIVITY_MAX,
      Math.max(CONFIG.PHONE_REMOTE.SENSITIVITY_MIN, value)
    )
    // Skip the syscall when the value didn't move. This write sits on the
    // main thread at the end of a slider drag, and a dragged-to-the-end
    // slider repeats its final value; a no-op write still blocks the loop.
    if (clamped === PREFS.getPhoneRemoteSensitivity()) return
    try {
      writeFileSync(PATHS.PHONE_REMOTE_SENSITIVITY, String(clamped), 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote sensitivity:', err)
    }
  },

  // Which skin paints the pro layout. Absent = CONFIG.PHONE_REMOTE.SKIN_DEFAULT;
  // an explicit choice in the pref file is honored over the default, as long as
  // that skin still exists (see remoteSkinIsInstalled).
  getPhoneRemoteSkin(): InstallableSkin {
    migrateLayoutSkinsToSkinAxis()
    if (!existsSync(PATHS.PHONE_REMOTE_SKIN)) {
      // No skin file yet. If the layout file still holds a legacy skin value the
      // migration failed to move, honor it anyway — otherwise a phone whose disk
      // refused the write silently loses its look.
      try {
        if (existsSync(PATHS.PHONE_REMOTE_LAYOUT)) {
          const legacy = LEGACY_LAYOUT_SKINS[readFileSync(PATHS.PHONE_REMOTE_LAYOUT, 'utf-8').trim()]
          if (legacy) return legacy
        }
      } catch {
        // Fall through to the default.
      }
      return CONFIG.PHONE_REMOTE.SKIN_DEFAULT
    }
    try {
      const v = readFileSync(PATHS.PHONE_REMOTE_SKIN, 'utf-8').trim()
      // Derived from the union (see types.ts) — a literal list here silently
      // rejected any skin added after it was written.
      // Accepts `remote:<id>` too — a skin installed from the catalog is as
      // valid a pref as a compiled-in one.
      if (!isInstallableSkin(v)) return CONFIG.PHONE_REMOTE.SKIN_DEFAULT
      // A `remote:` pref is only honored while that skin is STILL INSTALLED.
      // isInstallableSkin validates the id's SHAPE, never its existence, so a
      // pref outliving its assets used to sail through here and set a data-skin
      // no stylesheet matched — painting the bare base cascade, which is a
      // third look that is neither the chosen skin nor the default. Reconciling
      // at the read is what makes "you always get a skin that exists" true for
      // every caller, instead of each one having to check.
      return remoteSkinIsInstalled(v) ? v : CONFIG.PHONE_REMOTE.SKIN_DEFAULT
    } catch {
      return CONFIG.PHONE_REMOTE.SKIN_DEFAULT
    }
  },

  setPhoneRemoteSkin(value: InstallableSkin): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_SKIN, value, 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote skin:', err)
    }
  },

  // Pro-layout color scheme. Irrelevant to the classic layout.
  getPhoneRemoteColorScheme(): PhoneRemoteColorScheme {
    migrateProIIColorSchemeToLayout()
    if (!existsSync(PATHS.PHONE_REMOTE_COLOR_SCHEME)) return CONFIG.PHONE_REMOTE.COLOR_SCHEME_DEFAULT
    try {
      const v = readFileSync(PATHS.PHONE_REMOTE_COLOR_SCHEME, 'utf-8').trim()
      return v === 'light' || v === 'dark' ? v : CONFIG.PHONE_REMOTE.COLOR_SCHEME_DEFAULT
    } catch {
      return CONFIG.PHONE_REMOTE.COLOR_SCHEME_DEFAULT
    }
  },

  setPhoneRemoteColorScheme(value: PhoneRemoteColorScheme): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_COLOR_SCHEME, value, 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote color scheme:', err)
    }
  },

  // Pro-layout handedness — mirrors the whole layout horizontally.
  getPhoneRemoteHandedness(): PhoneRemoteHandedness {
    if (!existsSync(PATHS.PHONE_REMOTE_HANDEDNESS)) return CONFIG.PHONE_REMOTE.HANDEDNESS_DEFAULT
    try {
      const v = readFileSync(PATHS.PHONE_REMOTE_HANDEDNESS, 'utf-8').trim()
      return v === 'left' || v === 'right' ? v : CONFIG.PHONE_REMOTE.HANDEDNESS_DEFAULT
    } catch {
      return CONFIG.PHONE_REMOTE.HANDEDNESS_DEFAULT
    }
  },

  setPhoneRemoteHandedness(value: PhoneRemoteHandedness): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_HANDEDNESS, value, 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote handedness:', err)
    }
  },

  // Landscape-only key-cluster position — the vertical axis to handedness's
  // horizontal one. Stored on the Mac rather than in the phone's localStorage
  // for the same reason handedness is: it's a property of how this person
  // holds their phone, so it should follow them to a second device and survive
  // a browser data clear, not be re-picked per handset.
  getPhoneRemoteKeysPosition(): PhoneRemoteKeysPosition {
    if (!existsSync(PATHS.PHONE_REMOTE_KEYS_POSITION))
      return CONFIG.PHONE_REMOTE.KEYS_POSITION_DEFAULT
    try {
      const v = readFileSync(PATHS.PHONE_REMOTE_KEYS_POSITION, 'utf-8').trim()
      return v === 'top' || v === 'bottom' ? v : CONFIG.PHONE_REMOTE.KEYS_POSITION_DEFAULT
    } catch {
      return CONFIG.PHONE_REMOTE.KEYS_POSITION_DEFAULT
    }
  },

  setPhoneRemoteKeysPosition(value: PhoneRemoteKeysPosition): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_KEYS_POSITION, value, 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote keys position:', err)
    }
  },

  // Landscape-only: one control cluster or two. Mac-side for the same reason as
  // the two axes above — it describes the grip, not the handset.
  getPhoneRemoteDeckMode(): PhoneRemoteDeckMode {
    if (!existsSync(PATHS.PHONE_REMOTE_DECK_MODE)) return CONFIG.PHONE_REMOTE.DECK_MODE_DEFAULT
    try {
      const v = readFileSync(PATHS.PHONE_REMOTE_DECK_MODE, 'utf-8').trim()
      return v === 'split' || v === 'stacked' ? v : CONFIG.PHONE_REMOTE.DECK_MODE_DEFAULT
    } catch {
      return CONFIG.PHONE_REMOTE.DECK_MODE_DEFAULT
    }
  },

  setPhoneRemoteDeckMode(value: PhoneRemoteDeckMode): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_DECK_MODE, value, 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote deck mode:', err)
    }
  },

  // Which split concept. Only consulted when deck mode is 'split'.
  getPhoneRemoteSplitConcept(): PhoneRemoteSplitConcept {
    if (!existsSync(PATHS.PHONE_REMOTE_SPLIT_CONCEPT))
      return CONFIG.PHONE_REMOTE.SPLIT_CONCEPT_DEFAULT
    try {
      const v = readFileSync(PATHS.PHONE_REMOTE_SPLIT_CONCEPT, 'utf-8').trim()
      // The shared guard, not a hardcoded name chain -- a chain here silently
      // rejected any newly added concept and fell back to the default.
      return isPhoneRemoteSplitConcept(v) ? v : CONFIG.PHONE_REMOTE.SPLIT_CONCEPT_DEFAULT
    } catch {
      return CONFIG.PHONE_REMOTE.SPLIT_CONCEPT_DEFAULT
    }
  },

  setPhoneRemoteSplitConcept(value: PhoneRemoteSplitConcept): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_SPLIT_CONCEPT, value, 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote split concept:', err)
    }
  },

  // Portrait-only mirror placement. Mac-side like the layout axes above: it
  // describes how this person wants the remote to look, not the handset.
  getPhoneRemoteMirrorPlacement(): PhoneRemoteMirrorPlacement {
    if (!existsSync(PATHS.PHONE_REMOTE_MIRROR_PLACEMENT)) return CONFIG.PHONE_REMOTE.MIRROR_PLACEMENT_DEFAULT
    try {
      const v = readFileSync(PATHS.PHONE_REMOTE_MIRROR_PLACEMENT, 'utf-8').trim()
      return isPhoneRemoteMirrorPlacement(v) ? v : CONFIG.PHONE_REMOTE.MIRROR_PLACEMENT_DEFAULT
    } catch {
      return CONFIG.PHONE_REMOTE.MIRROR_PLACEMENT_DEFAULT
    }
  },

  setPhoneRemoteMirrorPlacement(value: PhoneRemoteMirrorPlacement): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_MIRROR_PLACEMENT, value, 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote mirror placement:', err)
    }
  },

  // "Show cursor" — draw the Mac's pointer on the phone's touchpad while it's
  // moving, then fade it out. Default lives in CONFIG so the on/off default is
  // one edit, not a literal repeated across getter and UI.
  getPhoneRemoteShowCursor(): boolean {
    if (!existsSync(PATHS.PHONE_REMOTE_SHOW_CURSOR)) {
      return CONFIG.PHONE_REMOTE.SHOW_CURSOR_DEFAULT
    }
    try {
      return readFileSync(PATHS.PHONE_REMOTE_SHOW_CURSOR, 'utf-8').trim() === 'true'
    } catch {
      return CONFIG.PHONE_REMOTE.SHOW_CURSOR_DEFAULT
    }
  },

  setPhoneRemoteShowCursor(value: boolean): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_SHOW_CURSOR, value ? 'true' : 'false', 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote show cursor:', err)
    }
  },

  // "App ring" — the arc around the button cluster that scrubs the MRU app
  // list. Same shape as show-cursor; default lives in CONFIG.
  getPhoneRemoteAppRing(): boolean {
    if (!existsSync(PATHS.PHONE_REMOTE_APP_RING)) {
      return CONFIG.PHONE_REMOTE.APP_RING_DEFAULT
    }
    try {
      return readFileSync(PATHS.PHONE_REMOTE_APP_RING, 'utf-8').trim() === 'true'
    } catch {
      return CONFIG.PHONE_REMOTE.APP_RING_DEFAULT
    }
  },

  setPhoneRemoteAppRing(value: boolean): void {
    try {
      writeFileSync(PATHS.PHONE_REMOTE_APP_RING, value ? 'true' : 'false', 'utf-8')
    } catch (err) {
      console.error('Failed to write phone remote app ring:', err)
    }
  },

  // Pending sign-in email from the landing-page download handoff (deeplink). Read
  // once by the auth window to pre-fill the field, then cleared so it never
  // resurfaces on a later sign-in. Empty string = nothing pending.
  getPendingAuthEmail(): string {
    if (!existsSync(PATHS.PENDING_AUTH_EMAIL)) return ''
    try {
      return readFileSync(PATHS.PENDING_AUTH_EMAIL, 'utf-8').trim()
    } catch {
      return ''
    }
  },

  setPendingAuthEmail(email: string): void {
    try {
      writeFileSync(PATHS.PENDING_AUTH_EMAIL, email.trim(), 'utf-8')
    } catch (err) {
      console.error('Failed to write pending auth email:', err)
    }
  },

  clearPendingAuthEmail(): void {
    try {
      if (existsSync(PATHS.PENDING_AUTH_EMAIL)) unlinkSync(PATHS.PENDING_AUTH_EMAIL)
    } catch (err) {
      console.error('Failed to clear pending auth email:', err)
    }
  },

  // Run Transcript Inspector ("Show run details"). Default OFF — a debug/admin
  // surface that exposes raw tool inputs/outputs, so it stays hidden until turned
  // on. Same flat-file write-through pattern as cursor-companion above.
  getRunTranscript(): boolean {
    if (!existsSync(PATHS.RUN_TRANSCRIPT_PREF)) return false
    try {
      return readFileSync(PATHS.RUN_TRANSCRIPT_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setRunTranscript(on: boolean): void {
    try {
      writeFileSync(PATHS.RUN_TRANSCRIPT_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write run-transcript toggle:', err)
    }
  },

  // One switch behind every per-run duration. Default ON (file-absent = enabled), and
  // backed by the old transcribe-time file so an existing "off" survives the merge.
  getShowTiming(): boolean {
    if (!existsSync(PATHS.SHOW_TIMING_PREF)) return true
    try {
      return readFileSync(PATHS.SHOW_TIMING_PREF, 'utf-8').trim() === '1'
    } catch {
      return true
    }
  },

  setShowTiming(on: boolean): void {
    try {
      writeFileSync(PATHS.SHOW_TIMING_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write show-timing toggle:', err)
    }
  },

  // Dynamic Island overlay (notch-anchored live activity). Default OFF (opt-in) —
  // file-absent means disabled, so existing users see no change until they turn it on.
  getDynamicIsland(): boolean {
    if (!existsSync(PATHS.ISLAND_PREF)) return false
    try {
      return readFileSync(PATHS.ISLAND_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setDynamicIsland(on: boolean): void {
    try {
      writeFileSync(PATHS.ISLAND_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write dynamic island toggle:', err)
    }
  },

  // Selection bar. Default OFF (file-absent); only an explicit '1' turns it on.
  getSelectionBar(): boolean {
    if (!existsSync(PATHS.SELECTION_BAR_PREF)) return false
    try {
      return readFileSync(PATHS.SELECTION_BAR_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setSelectionBar(on: boolean): void {
    try {
      writeFileSync(PATHS.SELECTION_BAR_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write selection bar toggle:', err)
    }
  },

  // Fast mode: run the rewrite through our hosted API instead of the user's own
  // CLI. Default OFF (file-absent) because it spends credits — the opposite
  // default from the bar itself.
  getSelectionBarFast(): boolean {
    if (!existsSync(PATHS.SELECTION_BAR_FAST_PREF)) return false
    try {
      return readFileSync(PATHS.SELECTION_BAR_FAST_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setSelectionBarFast(on: boolean): void {
    try {
      writeFileSync(PATHS.SELECTION_BAR_FAST_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write selection bar fast toggle:', err)
    }
  },

  // Dock icon visibility. Default ON (file-absent) — a new user expects to find the
  // app in the Dock. Showing the Dock icon also promotes the app from accessory to
  // regular: it gains a menu bar and joins ⌘-Tab. That's inherent to macOS, not a
  // side effect we choose.
  getDockIcon(): boolean {
    if (!existsSync(PATHS.DOCK_ICON_PREF)) return true
    try {
      return readFileSync(PATHS.DOCK_ICON_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setDockIcon(on: boolean): void {
    try {
      writeFileSync(PATHS.DOCK_ICON_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write dock icon toggle:', err)
    }
  },

  // Live Voice Companion overlay ("Live mode" — the ?window=companion mouse
  // character). Default OFF (opt-in) — file-absent means disabled, same flat-file
  // pattern as Dynamic Island above. Phase 0: purely cosmetic (scripted state
  // cycle, no mic/LLM); the toggle just shows/hides the overlay window.
  getLiveMode(): boolean {
    if (!existsSync(PATHS.COMPANION_PREF)) return false
    try {
      return readFileSync(PATHS.COMPANION_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setLiveMode(on: boolean): void {
    try {
      writeFileSync(PATHS.COMPANION_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write live-mode toggle:', err)
    }
  },

  // May a live turn DRIVE the Mac, or only answer? Default ON when the file is
  // absent — screen control is what Live mode is for, so this is the one toggle
  // here that is opt-OUT. Read per turn (not cached) so flipping it in Settings
  // takes effect on the very next thing the user says.
  getLiveActs(): boolean {
    if (!existsSync(PATHS.LIVE_ACTS_PREF)) return true
    try {
      return readFileSync(PATHS.LIVE_ACTS_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setLiveActs(on: boolean): void {
    try {
      writeFileSync(PATHS.LIVE_ACTS_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write live-acts toggle:', err)
    }
  },

  // "Read answers aloud" in Mighty chat — the same TTS ladder the companion uses,
  // on a surface the user is typing into. Default OFF, deliberately: a chat that
  // starts talking on its own is a bug, not a feature. Independent of getLiveMode
  // (the overlay) — voice is a mode any chat surface can turn on, not a property
  // of the mouse character.
  getSpeakReplies(): boolean {
    if (!existsSync(PATHS.SPEAK_REPLIES_PREF)) return false
    try {
      return readFileSync(PATHS.SPEAK_REPLIES_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setSpeakReplies(on: boolean): void {
    try {
      writeFileSync(PATHS.SPEAK_REPLIES_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write speak-replies toggle:', err)
    }
  },

  // Which companion visualization draws the character (3D mouse / 2D warp /
  // blob). A dev-facing A/B choice picked from the companion debug panel;
  // persisted flat-file (same write-through pattern as cursor style) so it
  // survives a reload. File-absent → DEFAULT_COMPANION_RENDERER.
  getCompanionRenderer(): CompanionRendererId {
    if (!existsSync(PATHS.COMPANION_RENDERER)) return DEFAULT_COMPANION_RENDERER
    try {
      return toCompanionRenderer(readFileSync(PATHS.COMPANION_RENDERER, 'utf-8').trim())
    } catch {
      return DEFAULT_COMPANION_RENDERER
    }
  },

  setCompanionRenderer(renderer: CompanionRendererId): void {
    try {
      writeFileSync(PATHS.COMPANION_RENDERER, toCompanionRenderer(renderer), 'utf-8')
    } catch (err) {
      console.error('Failed to write companion renderer:', err)
    }
  },

  // How much screen a voice conversation takes — full work area, or the small
  // bottom-right puck. Its own pref rather than a side effect of the renderer
  // pick, so minimizing doesn't mean learning what a "renderer" is.
  getCompanionSize(): CompanionSize {
    if (!existsSync(PATHS.COMPANION_SIZE)) return DEFAULT_COMPANION_SIZE
    try {
      return toCompanionSize(readFileSync(PATHS.COMPANION_SIZE, 'utf-8').trim())
    } catch {
      return DEFAULT_COMPANION_SIZE
    }
  },

  setCompanionSize(size: CompanionSize): void {
    try {
      writeFileSync(PATHS.COMPANION_SIZE, toCompanionSize(size), 'utf-8')
    } catch (err) {
      console.error('Failed to write companion size:', err)
    }
  },

  getCursorStyle(): CursorStyleId {
    if (!existsSync(PATHS.CURSOR_STYLE)) return DEFAULT_CURSOR_STYLE
    try {
      return toCursorStyle(readFileSync(PATHS.CURSOR_STYLE, 'utf-8').trim())
    } catch {
      return DEFAULT_CURSOR_STYLE
    }
  },

  setCursorStyle(style: CursorStyleId): void {
    try {
      writeFileSync(PATHS.CURSOR_STYLE, toCursorStyle(style), 'utf-8')
    } catch (err) {
      console.error('Failed to write cursor style:', err)
    }
  },

  // Permissions onboarding completed once. Default OFF (file-absent = not done),
  // so a fresh user is always walked through the wizard. Set when the user
  // finishes (or skips past the optional steps of) the onboarding flow.
  getOnboardingComplete(): boolean {
    if (!existsSync(PATHS.ONBOARDING_DONE)) return false
    try {
      return readFileSync(PATHS.ONBOARDING_DONE, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setOnboardingComplete(done: boolean): void {
    try {
      writeFileSync(PATHS.ONBOARDING_DONE, done ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write onboarding-complete flag:', err)
    }
  },

  // The wizard step in progress. Unlike ONBOARDING_DONE this is NOT consumed on
  // read — the boot gate asks for it repeatedly, and only finishing or skipping
  // past the step resolves it.
  getOnboardingStep(): OnboardingStepKey | null {
    if (!existsSync(PATHS.ONBOARDING_STEP)) return null
    try {
      const raw = readFileSync(PATHS.ONBOARDING_STEP, 'utf-8').trim()
      return ONBOARDING_STEP_KEYS.includes(raw as OnboardingStepKey)
        ? (raw as OnboardingStepKey)
        : null
    } catch {
      return null
    }
  },

  clearOnboardingStep(): void {
    try {
      if (existsSync(PATHS.ONBOARDING_STEP)) unlinkSync(PATHS.ONBOARDING_STEP)
    } catch (err) {
      console.error('Failed to clear onboarding-step flag:', err)
    }
  },

  // Dev-only FTUE mock. Persisted because the mocked Screen Recording step tells
  // the user to quit and reopen — an in-memory flag dies on exactly that restart,
  // dropping the replay into real checks that already pass.
  getFtueMock(): boolean {
    return existsSync(PATHS.FTUE_MOCK)
  },

  setFtueMock(on: boolean): void {
    try {
      if (on) writeFileSync(PATHS.FTUE_MOCK, '1', 'utf-8')
      else if (existsSync(PATHS.FTUE_MOCK)) unlinkSync(PATHS.FTUE_MOCK)
    } catch (err) {
      console.error('Failed to write ftue-mock flag:', err)
    }
  },

  markSetupResume(): void {
    try {
      writeFileSync(PATHS.SETUP_RESUME, '1', 'utf-8')
    } catch (err) {
      console.error('Failed to write setup-resume flag:', err)
    }
  },

  // Consume-on-read: a resume that itself crashed must not re-trigger forever,
  // so the flag is deleted before the caller acts on it.
  consumeSetupResume(): boolean {
    if (!existsSync(PATHS.SETUP_RESUME)) return false
    try {
      unlinkSync(PATHS.SETUP_RESUME)
    } catch (err) {
      console.error('Failed to clear setup-resume flag:', err)
    }
    return true
  },

  // Activation latch for the first_run_succeeded event. Write-once: the caller
  // checks this before emitting, so the event fires exactly once per machine and
  // "activated users" stays a count of people, not of runs.
  getFirstRunSucceeded(): boolean {
    return existsSync(PATHS.FIRST_RUN_OK)
  },

  setFirstRunSucceeded(): void {
    try {
      writeFileSync(PATHS.FIRST_RUN_OK, '1', 'utf-8')
    } catch (err) {
      console.error('Failed to write first-run-succeeded flag:', err)
    }
  },

  /** Write-once: first process boot on this install, before auth. */
  getFirstBootRecorded(): boolean {
    return existsSync(PATHS.FIRST_BOOT)
  },

  setFirstBootRecorded(): void {
    try {
      writeFileSync(PATHS.FIRST_BOOT, String(Date.now()), 'utf-8')
    } catch (err) {
      console.error('Failed to write first-boot flag:', err)
    }
  },

  getFirstBootAtMs(): number | null {
    if (!existsSync(PATHS.FIRST_BOOT)) return null
    try {
      const ms = Number(readFileSync(PATHS.FIRST_BOOT, 'utf-8').trim())
      return Number.isFinite(ms) && ms > 0 ? ms : null
    } catch {
      return null
    }
  },

  // Same write-once latch, for the "try transcribe" checklist row.
  getTranscribeSucceeded(): boolean {
    return existsSync(PATHS.TRANSCRIBE_OK)
  },

  setTranscribeSucceeded(): void {
    try {
      writeFileSync(PATHS.TRANSCRIBE_OK, '1', 'utf-8')
    } catch (err) {
      console.error('Failed to write transcribe-succeeded flag:', err)
    }
  },

  // Same write-once latch, for the "grant permissions" checklist row.
  getPermissionsSucceeded(): boolean {
    return existsSync(PATHS.PERMISSIONS_OK)
  },

  setPermissionsSucceeded(): void {
    try {
      writeFileSync(PATHS.PERMISSIONS_OK, '1', 'utf-8')
    } catch (err) {
      console.error('Failed to write permissions-succeeded flag:', err)
    }
  },

  // Set when the user opens a 5/5 checklist. Gates the header ring's final
  // disappearance, so completion is always seen before the button goes away.
  getChecklistSeenDone(): boolean {
    return existsSync(PATHS.CHECKLIST_SEEN_DONE)
  },

  setChecklistSeenDone(): void {
    try {
      writeFileSync(PATHS.CHECKLIST_SEEN_DONE, '1', 'utf-8')
    } catch (err) {
      console.error('Failed to write checklist-seen-done flag:', err)
    }
  },

  /** Version string of the previous launch. null on a fresh install. */
  getLastSeenVersion(): string | null {
    if (!existsSync(PATHS.LAST_SEEN_VERSION)) return null
    try {
      return readFileSync(PATHS.LAST_SEEN_VERSION, 'utf-8').trim() || null
    } catch {
      return null
    }
  },

  setLastSeenVersion(version: string): void {
    try {
      writeFileSync(PATHS.LAST_SEEN_VERSION, version, 'utf-8')
    } catch (err) {
      console.error('Failed to write last-seen version:', err)
    }
  },

  // Value tour seen once. Default OFF (file-absent = not seen), so a fresh user
  // gets it auto-shown after the perms wizard. Set on any dismissal (Done / Skip
  // / red-X) so it never nags. Re-openable any time from the tray.
  getTourSeen(): boolean {
    if (!existsSync(PATHS.TOUR_SEEN)) return false
    try {
      return readFileSync(PATHS.TOUR_SEEN, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setTourSeen(seen: boolean): void {
    try {
      writeFileSync(PATHS.TOUR_SEEN, seen ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write tour-seen flag:', err)
    }
  },

  // Max recording length in minutes before auto-stop. Default 5; floored at 0.1
  // so the value can't disable the guard or be nonsensical.
  getMaxRecordingMin(): number {
    if (!existsSync(PATHS.MAX_REC_MIN)) return 5
    try {
      const n = parseFloat(readFileSync(PATHS.MAX_REC_MIN, 'utf-8').trim())
      if (!Number.isFinite(n) || n <= 0) return 5
      return Math.max(0.1, n)
    } catch {
      return 5
    }
  },

  setMaxRecordingMin(min: number): void {
    try {
      const n = Number.isFinite(min) && min > 0 ? Math.max(0.1, min) : 5
      writeFileSync(PATHS.MAX_REC_MIN, String(n), 'utf-8')
    } catch (err) {
      console.error('Failed to write max recording minutes:', err)
    }
  },

  // UI sound effects. Default ON, so file-absent means enabled.
  getSoundEnabled(): boolean {
    if (!existsSync(PATHS.SOUND_PREF)) return true
    try {
      return readFileSync(PATHS.SOUND_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setSoundEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.SOUND_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write sound toggle:', err)
    }
  },

  // Capture HUD (top-right cards on screenshot/record). Default ON.
  getCaptureHud(): boolean {
    if (!existsSync(PATHS.CAPTURE_HUD_PREF)) return true
    try {
      return readFileSync(PATHS.CAPTURE_HUD_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setCaptureHud(on: boolean): void {
    try {
      writeFileSync(PATHS.CAPTURE_HUD_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write capture HUD toggle:', err)
    }
  },

  // Mighty chat: render replies as formatted Markdown vs raw source text. Default ON.
  getMightyRenderMarkup(): boolean {
    if (!existsSync(PATHS.MIGHTY_RENDER_MARKUP_PREF)) return true
    try {
      return readFileSync(PATHS.MIGHTY_RENDER_MARKUP_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setMightyRenderMarkup(on: boolean): void {
    try {
      writeFileSync(PATHS.MIGHTY_RENDER_MARKUP_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty render-markup toggle:', err)
    }
  },

  // Detail mode: surface run timing + deeper insight in the chat. Default OFF — the
  // calm view is the one people want by default; detail is opt-in for when they're
  // debugging a slow run or curious what Mighty actually did.
  getMightyDetailMode(): boolean {
    if (!existsSync(PATHS.MIGHTY_DETAIL_MODE_PREF)) return false
    try {
      return readFileSync(PATHS.MIGHTY_DETAIL_MODE_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setMightyDetailMode(on: boolean): void {
    try {
      writeFileSync(PATHS.MIGHTY_DETAIL_MODE_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty detail-mode toggle:', err)
    }
  },

  // Mighty chat: user-dragged conversation-sidebar width (px), clamped to the
  // configured MIN/MAX so a stale pref can never render an unusable sidebar. Absent
  // (never dragged) → DEFAULT_WIDTH.
  getMightySidebarWidth(): number {
    const { MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH } = CONFIG.MIGHTY.SIDEBAR
    if (!existsSync(PATHS.MIGHTY_SIDEBAR_WIDTH_PREF)) return DEFAULT_WIDTH
    try {
      const n = Number(readFileSync(PATHS.MIGHTY_SIDEBAR_WIDTH_PREF, 'utf-8').trim())
      if (!Number.isFinite(n)) return DEFAULT_WIDTH
      return Math.min(Math.max(Math.round(n), MIN_WIDTH), MAX_WIDTH)
    } catch {
      return DEFAULT_WIDTH
    }
  },

  // Mighty window zoom level (Electron's logarithmic level, not a percentage —
  // see CONFIG.MIGHTY.ZOOM). Clamped on read so a hand-edited or stale pref can
  // never restore the window at an unreadable size.
  getMightyZoomLevel(): number {
    const { MIN_LEVEL, MAX_LEVEL, DEFAULT_LEVEL } = CONFIG.MIGHTY.ZOOM
    if (!existsSync(PATHS.MIGHTY_ZOOM_LEVEL_PREF)) return DEFAULT_LEVEL
    try {
      const n = Number(readFileSync(PATHS.MIGHTY_ZOOM_LEVEL_PREF, 'utf-8').trim())
      if (!Number.isFinite(n)) return DEFAULT_LEVEL
      return Math.min(Math.max(n, MIN_LEVEL), MAX_LEVEL)
    } catch {
      return DEFAULT_LEVEL
    }
  },

  setMightyZoomLevel(level: number): void {
    const { MIN_LEVEL, MAX_LEVEL } = CONFIG.MIGHTY.ZOOM
    const clamped = Math.min(Math.max(level, MIN_LEVEL), MAX_LEVEL)
    try {
      writeFileSync(PATHS.MIGHTY_ZOOM_LEVEL_PREF, String(clamped), 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty zoom level:', err)
    }
  },

  setMightySidebarWidth(width: number): void {
    const { MIN_WIDTH, MAX_WIDTH } = CONFIG.MIGHTY.SIDEBAR
    const clamped = Math.min(Math.max(Math.round(width), MIN_WIDTH), MAX_WIDTH)
    try {
      writeFileSync(PATHS.MIGHTY_SIDEBAR_WIDTH_PREF, String(clamped), 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty sidebar width:', err)
    }
  },

  // Mighty chat: whether the conversation sidebar is shown. Default ON (file-absent).
  getMightySidebarShown(): boolean {
    if (!existsSync(PATHS.MIGHTY_SIDEBAR_SHOWN_PREF)) return true
    try {
      return readFileSync(PATHS.MIGHTY_SIDEBAR_SHOWN_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setMightySidebarShown(on: boolean): void {
    try {
      writeFileSync(PATHS.MIGHTY_SIDEBAR_SHOWN_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty sidebar-shown toggle:', err)
    }
  },

  getMightyLastMode(): MightyMode | null {
    try {
      const mode = readFileSync(PATHS.MIGHTY_LAST_MODE_PREF, 'utf-8').trim()
      return isMightyMode(mode) ? mode : null
    } catch {
      return null
    }
  },

  setMightyLastMode(mode: MightyMode): void {
    try {
      writeFileSync(PATHS.MIGHTY_LAST_MODE_PREF, mode, 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty last mode:', err)
    }
  },

  getMightyLastCodeSession(): string | null {
    try {
      return readFileSync(PATHS.MIGHTY_LAST_CODE_SESSION_PREF, 'utf-8').trim() || null
    } catch {
      return null
    }
  },

  setMightyLastCodeSession(ref: string): void {
    try {
      writeFileSync(PATHS.MIGHTY_LAST_CODE_SESSION_PREF, ref, 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty last Code session:', err)
    }
  },

  // Mighty chat: whether the right context rail (Outputs / Sources) is shown.
  // Default ON (file-absent) — the rail is the point of the feature, so a fresh
  // install shows it, and only an explicit collapse persists a '0'.
  getMightyContextRailShown(): boolean {
    if (!existsSync(PATHS.MIGHTY_CONTEXT_RAIL_SHOWN_PREF)) return true
    try {
      return readFileSync(PATHS.MIGHTY_CONTEXT_RAIL_SHOWN_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setMightyContextRailShown(on: boolean): void {
    try {
      writeFileSync(PATHS.MIGHTY_CONTEXT_RAIL_SHOWN_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty context-rail-shown toggle:', err)
    }
  },

  // Mighty chat window bounds. Absent (never resized) → null, so the caller uses
  // the default size. Only accepts a fully-formed, finite rectangle — a partial or
  // corrupt file reads as null rather than opening a zero-size or off-screen window.
  getMightyWindowBounds(): WindowBounds | null {
    if (!existsSync(PATHS.MIGHTY_WINDOW_BOUNDS_PREF)) return null
    try {
      const raw = JSON.parse(readFileSync(PATHS.MIGHTY_WINDOW_BOUNDS_PREF, 'utf-8')) as unknown
      const b = raw as Partial<WindowBounds>
      const ok =
        b !== null &&
        typeof b === 'object' &&
        [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number' && Number.isFinite(n))
      if (!ok) return null
      return { x: b.x!, y: b.y!, width: b.width!, height: b.height! }
    } catch {
      return null
    }
  },

  setMightyWindowBounds(bounds: WindowBounds): void {
    try {
      writeFileSync(PATHS.MIGHTY_WINDOW_BOUNDS_PREF, JSON.stringify(bounds), 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty window bounds:', err)
    }
  },

  // Mighty chat tab strip: every ChatWorkspaceTab (panes + layout ratios). Malformed
  // entries are dropped individually rather than failing the whole file, so one
  // corrupt tab doesn't cost the user every other open workspace. Auto-naming (see
  // workspace-naming.ts) needs no separate counter store — it derives each day's next
  // letter straight from this same tab list, so there's nothing else to keep in sync.
  getMightyWorkspaces(): ChatWorkspaceTab[] {
    return readMightyWorkspacesBlob().tabs
  },

  setMightyWorkspaces(tabs: ChatWorkspaceTab[]): void {
    try {
      const blob: MightyWorkspacesBlob = { tabs }
      writeFileSync(PATHS.MIGHTY_WORKSPACES_PREF, JSON.stringify(blob, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty workspaces:', err)
    }
  },

  // Include the user's own macOS screenshots/recordings in the Media Library.
  // Default OFF (opt-in) — reading the screencapture folder may trigger a one-time
  // macOS TCC prompt, so the user turns it on knowingly. File-absent = off.
  getOsScreenshots(): boolean {
    if (!existsSync(PATHS.OS_SCREENSHOTS_PREF)) return false
    try {
      return readFileSync(PATHS.OS_SCREENSHOTS_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setOsScreenshots(on: boolean): void {
    try {
      writeFileSync(PATHS.OS_SCREENSHOTS_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write os-screenshots toggle:', err)
    }
  },

  // Auto-paste the listen/transcribe result into the frontmost app after copying
  // it to the clipboard. Default ON, so file-absent means enabled.
  getListenAutoPaste(): boolean {
    if (!existsSync(PATHS.LISTEN_AUTOPASTE_PREF)) return true
    try {
      return readFileSync(PATHS.LISTEN_AUTOPASTE_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setListenAutoPaste(on: boolean): void {
    try {
      writeFileSync(PATHS.LISTEN_AUTOPASTE_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write listen auto-paste toggle:', err)
    }
  },

  // Experimental voice routing: after a recording, rank the open apps and offer
  // the best destination instead of pasting into whatever is frontmost.
  //
  // 'always' ranks every transcription. 'hover' ranks NOTHING up front and waits
  // for the user to hover the transcript card — most dictations are not worth a
  // Jev call plus an osascript window scan, and under 'always' every one paid
  // both. Default OFF: file-absent means the existing auto-paste path runs
  // unchanged. The legacy '1'/'0' this file used to hold still reads as
  // 'always'/'off', so an existing user's setting survives the upgrade.
  getVoiceRoutingMode(): VoiceRoutingMode {
    if (!existsSync(PATHS.VOICE_ROUTING_PREF)) return 'off'
    try {
      const raw = readFileSync(PATHS.VOICE_ROUTING_PREF, 'utf-8').trim()
      if (raw === 'hover') return 'hover'
      if (raw === 'always' || raw === '1') return 'always'
      return 'off'
    } catch {
      return 'off'
    }
  },

  setVoiceRoutingMode(mode: VoiceRoutingMode): void {
    try {
      writeFileSync(PATHS.VOICE_ROUTING_PREF, mode, 'utf-8')
    } catch (err) {
      console.error('Failed to write voice-routing mode:', err)
    }
  },

  /** On in either mode — the question "is routing available at all?". Callers
   *  that care WHEN the ranking fires ask getVoiceRoutingMode() instead. */
  getVoiceRouting(): boolean {
    return PREFS.getVoiceRoutingMode() !== 'off'
  },

  // Offer "Go there & submit" (activate the target app, then paste) next to
  // "Paste & submit". Separate flag because it MOVES YOU: it pulls focus out of
  // whatever you are doing, which is the right call sometimes and jarring other
  // times. Default OFF.
  getVoiceRoutingGoTo(): boolean {
    if (!existsSync(PATHS.VOICE_ROUTING_GOTO_PREF)) return false
    try {
      return readFileSync(PATHS.VOICE_ROUTING_GOTO_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setVoiceRoutingGoTo(on: boolean): void {
    try {
      writeFileSync(PATHS.VOICE_ROUTING_GOTO_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write voice-routing go-to toggle:', err)
    }
  },

  // The card's second column: the skills you could run and the agents you have
  // running. Default ON — unlike go-to these only ADD destinations, they never
  // change where an app pick lands. File-absent means on.
  getVoiceRoutingSkills(): boolean {
    if (!existsSync(PATHS.VOICE_ROUTING_SKILLS_PREF)) return true
    try {
      return readFileSync(PATHS.VOICE_ROUTING_SKILLS_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setVoiceRoutingSkills(on: boolean): void {
    try {
      writeFileSync(PATHS.VOICE_ROUTING_SKILLS_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write voice-routing skills toggle:', err)
    }
  },

  getVoiceRoutingAgents(): boolean {
    if (!existsSync(PATHS.VOICE_ROUTING_AGENTS_PREF)) return true
    try {
      return readFileSync(PATHS.VOICE_ROUTING_AGENTS_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setVoiceRoutingAgents(on: boolean): void {
    try {
      writeFileSync(PATHS.VOICE_ROUTING_AGENTS_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write voice-routing agents toggle:', err)
    }
  },

  // Width the user last dragged the routing card to. 0 means "never dragged",
  // which the window reads as its own default rather than as a real width.
  getVoiceRoutingCardWidth(): number {
    if (!existsSync(PATHS.VOICE_ROUTING_CARD_WIDTH_PREF)) return 0
    try {
      const n = Number(readFileSync(PATHS.VOICE_ROUTING_CARD_WIDTH_PREF, 'utf-8').trim())
      return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
    } catch {
      return 0
    }
  },

  setVoiceRoutingCardWidth(width: number): void {
    try {
      writeFileSync(PATHS.VOICE_ROUTING_CARD_WIDTH_PREF, String(Math.round(width)), 'utf-8')
    } catch (err) {
      console.error('Failed to write voice-routing card width:', err)
    }
  },

  // Experimental: use native CoreAudio AVAudioEngine mic path instead of ffmpeg
  // for listen/transcribe. Default OFF — enable by writing '1'. The native path
  // opens far faster than ffmpeg -f avfoundation's 576–848 ms cold-open.
  // Toggle via: echo '1' > ~/MightyMouse/use-native-mic.txt
  getUseNativeMic(): boolean {
    if (!existsSync(PATHS.USE_NATIVE_MIC)) return false
    try {
      return readFileSync(PATHS.USE_NATIVE_MIC, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setUseNativeMic(on: boolean): void {
    try {
      writeFileSync(PATHS.USE_NATIVE_MIC, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write use-native-mic toggle:', err)
    }
  },

  // Ambient context log. Default OFF (opt-in) — file-absent means disabled.
  getContextLog(): boolean {
    if (!existsSync(PATHS.CONTEXT_LOG_PREF)) return false
    try {
      return readFileSync(PATHS.CONTEXT_LOG_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setContextLog(on: boolean): void {
    try {
      writeFileSync(PATHS.CONTEXT_LOG_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write context log toggle:', err)
    }
  },

  // History-at-rest encryption. Default OFF (file-absent = plaintext) — kept off
  // during dev so records stay grep-able; flip on to encrypt via safeStorage.
  // Toggling either direction triggers a backup-then-convert pass in HISTORY.
  getHistoryEncryption(): boolean {
    if (!existsSync(PATHS.HISTORY_ENC_PREF)) return false
    try {
      return readFileSync(PATHS.HISTORY_ENC_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setHistoryEncryption(on: boolean): void {
    try {
      writeFileSync(PATHS.HISTORY_ENC_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write history-encryption toggle:', err)
    }
  },

  // History-panel kind filter. Persists the set of HIDDEN run kinds as a CSV so
  // file-absent = nothing hidden = every kind visible (the natural default), and a
  // newly-added kind shows up without a migration. Read/write-through, no cache —
  // the panel re-reads it via buildPanelInitData on each open.
  getHistoryFilterHidden(): string[] {
    if (!existsSync(PATHS.HISTORY_FILTER_PREF)) return []
    try {
      return readFileSync(PATHS.HISTORY_FILTER_PREF, 'utf-8')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    } catch {
      return []
    }
  },

  setHistoryFilterHidden(hidden: string[]): void {
    try {
      writeFileSync(PATHS.HISTORY_FILTER_PREF, hidden.join(','), 'utf-8')
    } catch (err) {
      console.error('Failed to write history-filter pref:', err)
    }
  },

  // Mighty conversation-sidebar filter. Same CSV-of-hidden shape as the history
  // filter above, keyed by MightyRunSource instead of run kind.
  getMightySourceFilterHidden(): string[] {
    if (!existsSync(PATHS.MIGHTY_SOURCE_FILTER_PREF)) return []
    try {
      return readFileSync(PATHS.MIGHTY_SOURCE_FILTER_PREF, 'utf-8')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    } catch {
      return []
    }
  },

  setMightySourceFilterHidden(hidden: string[]): void {
    try {
      writeFileSync(PATHS.MIGHTY_SOURCE_FILTER_PREF, hidden.join(','), 'utf-8')
    } catch (err) {
      console.error('Failed to write mighty source-filter pref:', err)
    }
  },

  // Whether the sidebar lists conversations nothing was ever sent in. Absent =
  // false (hidden) — the inverse of the two prefs above, because every voice note
  // mints a reply-less session and listing them all buries the real chats.
  getMightyShowEmpty(): boolean {
    return existsSync(PATHS.MIGHTY_SHOW_EMPTY_PREF)
      ? readFileSync(PATHS.MIGHTY_SHOW_EMPTY_PREF, 'utf-8').trim() === '1'
      : false
  },

  setMightyShowEmpty(show: boolean): void {
    try {
      writeFileSync(PATHS.MIGHTY_SHOW_EMPTY_PREF, show ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write mighty show-empty pref:', err)
    }
  },

  // Incognito mode. Default OFF (file-absent = off). When ON, every activity-log
  // write consults this and early-returns at its store chokepoint, so nothing
  // about the session is recorded locally or sent to the cloud. Read-through (no
  // cache) so a toggle takes effect on the very next write with no restart.
  getIncognito(): boolean {
    if (!existsSync(PATHS.INCOGNITO_PREF)) return false
    try {
      return readFileSync(PATHS.INCOGNITO_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setIncognito(on: boolean): void {
    try {
      writeFileSync(PATHS.INCOGNITO_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write incognito toggle:', err)
    }
  },

  // Last analytics range picked, so reopening the window restores the same view
  // instead of always snapping back to All Time. Default 'alltime' when unset.
  getAnalyticsRange(): AnalyticsRange {
    const valid: AnalyticsRange[] = ['daily', 'weekly', 'monthly', 'alltime']
    if (!existsSync(PATHS.ANALYTICS_RANGE)) return 'alltime'
    try {
      const r = readFileSync(PATHS.ANALYTICS_RANGE, 'utf-8').trim()
      return valid.includes(r as AnalyticsRange) ? (r as AnalyticsRange) : 'alltime'
    } catch {
      return 'alltime'
    }
  },

  setAnalyticsRange(range: AnalyticsRange): void {
    try {
      writeFileSync(PATHS.ANALYTICS_RANGE, range, 'utf-8')
    } catch (err) {
      console.error('Failed to write analytics range:', err)
    }
  },

  // Experimental: idle suggestion bubble near the cursor. Default OFF (opt-in)
  // — file-absent means disabled. Toggle via:
  // echo '1' > ~/MightyMouse/experimental-suggestions.txt
  getExperimentalSuggestions(): boolean {
    if (!existsSync(PATHS.EXPERIMENTAL_SUGGESTIONS)) return false
    try {
      return readFileSync(PATHS.EXPERIMENTAL_SUGGESTIONS, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setExperimentalSuggestions(on: boolean): void {
    try {
      writeFileSync(PATHS.EXPERIMENTAL_SUGGESTIONS, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write experimental-suggestions toggle:', err)
    }
  },

  // Feedback loop (👍/👎 + "what I expected" notes). Default ON, so file-absent
  // means enabled. When OFF: the rating UI is hidden AND corrections are NOT folded
  // into the prompt — one master switch covers capture + learning together.
  getFeedbackEnabled(): boolean {
    if (!existsSync(PATHS.FEEDBACK_PREF)) return true
    try {
      return readFileSync(PATHS.FEEDBACK_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setFeedbackEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.FEEDBACK_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write feedback-enabled toggle:', err)
    }
  },

  // Kokoro voice (free offline TTS). Default OFF — the voice is opt-in, and this
  // toggle is the kill-switch: turning it off drops the ladder back to `say`
  // instantly WITHOUT deleting the 350MB model, so re-enabling costs no download.
  getKokoroEnabled(): boolean {
    if (!existsSync(PATHS.KOKORO_PREF)) return false
    try {
      return readFileSync(PATHS.KOKORO_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setKokoroEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.KOKORO_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write kokoro-enabled toggle:', err)
    }
  },

  // Click-to-act: when ON, a [POINT:x,y] in an ask answer not only flies the
  // cursor glyph there but actually moves + clicks the OS cursor (CGEvent).
  // Default OFF (opt-in) — the model only points unless the user turns this on,
  // and the toggle itself is gated on Accessibility being granted.
  // Defaults ON, unlike every other boolean pref here — fn-as-listen ships enabled
  // and the file only ever exists to record a user turning it OFF. So absent means
  // true, and the stored value is read as "not disabled" rather than "equals 1":
  // the usual === '1' shape would read a missing file as false and silently ship
  // the feature dead for every existing user.
  getFnListenEnabled(): boolean {
    if (!existsSync(PATHS.FN_LISTEN_PREF)) return true
    try {
      return readFileSync(PATHS.FN_LISTEN_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setFnListenEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.FN_LISTEN_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('[prefs] setFnListenEnabled failed:', err)
    }
  },

  getShiftListenEnabled(): boolean {
    try {
      return readFileSync(PATHS.SHIFT_LISTEN_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  getClickEnabled(): boolean {
    if (!existsSync(PATHS.CLICK_PREF)) return false
    try {
      return readFileSync(PATHS.CLICK_PREF, 'utf-8').trim() === '1'
    } catch {
      return false
    }
  },

  setClickEnabled(on: boolean): void {
    try {
      writeFileSync(PATHS.CLICK_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write click-enabled toggle:', err)
    }
  },

  // Act-mode highlight-box overlay. Default ON (absent = on) — file-absent means
  // "never toggled", not "explicitly turned off", unlike the debug-only prefs above.
  getActHighlight(): boolean {
    if (!existsSync(PATHS.ACT_HIGHLIGHT_PREF)) return true
    try {
      return readFileSync(PATHS.ACT_HIGHLIGHT_PREF, 'utf-8').trim() !== '0'
    } catch {
      return true
    }
  },

  setActHighlight(on: boolean): void {
    try {
      writeFileSync(PATHS.ACT_HIGHLIGHT_PREF, on ? '1' : '0', 'utf-8')
    } catch (err) {
      console.error('Failed to write act-highlight toggle:', err)
    }
  },

  // Mighty settings (persona name override, custom instructions, default output
  // format) as one JSON file. Missing/corrupt → defaults from CONFIG. The runner
  // reads getMightySettings() to fill the system prompt; the Settings tab writes it.
  getMightySettings(): MightySettings {
    const fallback: MightySettings = {
      name: '',
      instructions: '',
      outputFormat: CONFIG.MIGHTY.DEFAULT_OUTPUT_FORMAT,
      tabNameFormat: CONFIG.MIGHTY.DEFAULT_TAB_NAME_FORMAT,
      linksOpenIn: CONFIG.MIGHTY.DEFAULT_LINK_TARGET
    }
    if (!existsSync(PATHS.MIGHTY_SETTINGS)) return fallback
    try {
      const raw = JSON.parse(readFileSync(PATHS.MIGHTY_SETTINGS, 'utf-8')) as Partial<MightySettings>
      const fmt = raw.outputFormat
      const tabFmt = raw.tabNameFormat
      return {
        name: typeof raw.name === 'string' ? raw.name : '',
        instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
        outputFormat: (CONFIG.MIGHTY.OUTPUT_FORMATS as readonly string[]).includes(fmt ?? '')
          ? (fmt as MightyOutputFormat)
          : CONFIG.MIGHTY.DEFAULT_OUTPUT_FORMAT,
        // Absent on every settings file written before this field existed, so an
        // upgrading user silently adopts the new default rather than an invalid ''.
        tabNameFormat: (CONFIG.MIGHTY.TAB_NAME_FORMATS as readonly string[]).includes(tabFmt ?? '')
          ? (tabFmt as ChatTabNameFormat)
          : CONFIG.MIGHTY.DEFAULT_TAB_NAME_FORMAT,
        linksOpenIn: raw.linksOpenIn === 'browser' ? 'browser' : CONFIG.MIGHTY.DEFAULT_LINK_TARGET,
        importedFoundProjects: raw.importedFoundProjects === true
      }
    } catch {
      return fallback
    }
  },

  setMightySettings(settings: MightySettings): void {
    try {
      writeFileSync(PATHS.MIGHTY_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to write Mighty settings:', err)
    }
  },

  /** Resolved Mighty persona name — the user's override, or the CONFIG default. */
  getMightyName(): string {
    const name = this.getMightySettings().name.trim()
    return name !== '' ? name : CONFIG.MIGHTY.NAME
  },

  // Global custom instructions (one text field, injected into rewrite/ask/act/mighty
  // gated per-mode by appliesTo). All 4 modes default ON — instructions are opt-out,
  // not opt-in. One-time migration: the first read after upgrade copies the old
  // Mighty-only `instructions` field over if this store is still empty, so existing
  // users don't lose their text.
  getGlobalInstructions(): GlobalInstructionsSettings {
    const fallback: GlobalInstructionsSettings = {
      text: '',
      appliesTo: { rewrite: true, ask: true, act: true, mighty: true }
    }
    if (!existsSync(PATHS.GLOBAL_INSTRUCTIONS)) {
      const legacy = this.getMightySettings().instructions.trim()
      if (legacy !== '') {
        const migrated: GlobalInstructionsSettings = { ...fallback, text: legacy }
        this.setGlobalInstructions(migrated)
        return migrated
      }
      return fallback
    }
    try {
      const raw = JSON.parse(readFileSync(PATHS.GLOBAL_INSTRUCTIONS, 'utf-8')) as Partial<GlobalInstructionsSettings>
      const a: Partial<GlobalInstructionsAppliesTo> = raw.appliesTo || {}
      return {
        text: typeof raw.text === 'string' ? raw.text : '',
        appliesTo: {
          rewrite: a.rewrite !== false,
          ask: a.ask !== false,
          act: a.act !== false,
          mighty: a.mighty !== false
        }
      }
    } catch {
      return fallback
    }
  },

  setGlobalInstructions(settings: GlobalInstructionsSettings): void {
    try {
      writeFileSync(PATHS.GLOBAL_INSTRUCTIONS, JSON.stringify(settings, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to write global instructions:', err)
    }
  }
}
