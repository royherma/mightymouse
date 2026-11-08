/**
 * Settings IPC — the Settings window's state (permissions, binaries, devices,
 * paths), live PREFS toggles (sound, capture HUD, gaze, cursor companion, etc.),
 * backend selection + health probe, and history encryption/clear/filter.
 * Extracted verbatim from the old monolithic `ipc.ts`.
 */
import { getModelCatalog } from '../model-catalog'
import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { CHANNELS } from '../../shared/ipc'
import {
  addPlanLogin,
  cancelPlanSignIn,
  checkPlanUsage,
  isPlanBackend,
  listPlanLogins,
  planLoginPicks,
  removePlanLogin,
  setPlanLoginPick
} from '../backend/plan-logins'
import {
  PermissionKey,
  SettingsState,
  SettingsPatch,
  StoredSettings,
  BackendProbeRecord,
  BackendTestResult,
  BackendCheck,
  GlobalInstructionsSettings,
  LocalModel,
  LocalSetupState
} from '../../shared/types'
import { TRANSCRIPT_FORMATS, TRANSCRIPT_FORMAT_KEY, isFormatOn } from '../../shared/transcript-format'
import { CONFIG } from '../../shared/config'
import { parakeetCanTranscribe } from '../../shared/whisper-languages'
import { spendableCents } from '../../shared/billing-math'
import { toCursorStyle } from '../../shared/cursor-styles'
import { toCompanionRenderer } from '../../shared/companion-renderers'
import { toCompanionSize } from '../../shared/companion-size'
import { PERMISSIONS, binaries, shell, capabilities } from '../platform'
import type { InstallableTool } from '../platform/contract'
import { route } from '../routing'
import { lowerOnboardingWindowForGrant } from '../onboarding-window'
import { replayFirstRun } from '../ftue-replay'
import { applyDockIcon } from '../dock'
import {
  getBinaryStatuses,
  downloadWhisperModel,
  checkWhisperModelSpace,
  whisperModelPathFor,
  humanSize,
  installWhisperViaBrew,
  installFfmpegViaBrew,
  hasHomebrew
} from '../capture/binaries'
import { downloadManagedParakeet, hasManagedParakeet } from '../capture/download-binaries'
import { listAvDevices } from '../capture/devices'
import { SETTINGS } from '../store/settings'
import { isRecording } from '../capture'
import { isAwayModeHeld } from '../phone-remote/away-mode'
import { startContextLogging, stopContextLogging } from '../capture/context-logger'
import { setFnListenEnabled } from '../capture/capture-hotkey'
import { sendToSettingsRenderer, takePendingSettingsFocus } from '../settings-window'
import { sendToPanelRenderer } from '../panel-window'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { HISTORY, reconcileHistoryEncryption } from '../store/history'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { clearBinaryCache } from '../platform'
import { getSupabase } from '../supabase'
import { isCurrentUserAdmin, getSession, signOut } from '../auth'
import { BACKENDS, BackendId, toBackendId } from '../backend/adapters'
import { probeOpenRouter, OPENROUTER_KEY_NAME } from '../backend/openrouter'
import { KEYS } from '../keys/store'
import { isOllamaRunning, listLocalModels } from '../backend/local-models'
import { isMlxRunning, listMlxModels } from '../backend/mlx-models'
import {
  setUpLocalBackend,
  isLocalServiceInstalled,
  pulledMlxModels,
  mlxSupported,
  type LocalSetupBackend
} from '../backend/local-setup'
import {
  setCursorCompanion,
  broadcastCursorStyle,
  startCursorCompanion,
  stopCursorCompanion
} from '../cursor-window'
import { startInsightsManager, stopInsightsManager } from '../insights/insights-manager'
import { setIslandWindow } from '../island-window'
import { applySelectionWatcher } from '../selection-watcher'
import {
  setCompanionWindow,
  applyCompanionRenderer,
  setCompanionInteractive
} from '../companion-window'
import { setLiveSession } from '../capture/live-listen'
import { closeWebClients } from '../phone-remote/web-client'
import { scheduleChatSync } from '../web-chat-sync'

/**
 * What the Language picker needs to know before it offers a non-English language:
 * is the model that language needs already here, and if not, does the disk have
 * room for it. Both numbers are shown to the user — a big download that fails at
 * 97% on a full disk is the worst version of this feature.
 */
function multilingualModelState(lang: string): SettingsState['multilingualModel'] {
  // Which model this language actually needs. Parakeet's 24 non-English
  // languages need its 714MB model, not whisper's 1.6GB one — quoting 1.6GB at
  // a French user is a number that stopped being true.
  const name = parakeetCanTranscribe(lang)
    ? CONFIG.PARAKEET_MODEL_NAME
    : CONFIG.WHISPER_MODEL_MULTILINGUAL_NAME
  const space = checkWhisperModelSpace(name)
  return {
    name,
    installed: existsSync(whisperModelPathFor(name)),
    needLabel: humanSize(space.needBytes),
    freeLabel: space.freeBytes === null ? null : humanSize(space.freeBytes),
    hasRoom: space.ok
  }
}

async function buildSettingsState(): Promise<SettingsState> {
  const s = SETTINGS.get()
  const [binaries, available] = await Promise.all([getBinaryStatuses(), listAvDevices()])
  return {
    permissions: PERMISSIONS.list(),
    binaries,
    paths: {
      ffmpeg: s.ffmpegPath,
      whisper: s.whisperPath,
      whisperModel: s.whisperModelPath
    },
    whisperLang: s.whisperLang || CONFIG.WHISPER_LANG,
    multilingualModel: multilingualModelState(s.whisperLang || CONFIG.WHISPER_LANG),
    devices: {
      video: s.videoDevice,
      audio: s.audioDevice
    },
    available,
    storage: {
      root: PATHS.ROOT,
      captures: PATHS.CAPTURES,
      acts: PATHS.ACTS
    },
    platform: process.platform,
    recording: isRecording(),
    hasHomebrew: hasHomebrew(),
    // `!== false`, not `?? true`: the default lives in one place and this is a
    // read of it, so an absent value and an explicit true are the same answer.
    siriScreenAnswer: s.siriScreenAnswer !== false,
    smallPanel: s.smallPanel === true,
    holdForSmartDictation: s.holdForSmartDictation === true,
    advancedMode: SETTINGS.advancedMode(),
    webAccess: s.webAccess !== false,
    codeOwnCopy: s.codeOwnCopy === true,
    transcriptFormats: Object.fromEntries(
      TRANSCRIPT_FORMATS.map((f) => [f.id, isFormatOn(f, s.transcriptFormats)])
    )
  }
}

/**
 * Run a CLI command and resolve { ok, out } from exit code + combined stdout/stderr.
 * Spawns via `/bin/zsh -c` exactly like runner.ts — this is load-bearing: the CLIs
 * (esp. `claude`) resolve their OAuth/keychain auth from the LOGIN-SHELL environment.
 * A bare execFile() with a stripped env reports "Invalid API key" even when the user
 * is logged in, so the probe MUST go through the same shell the real backend uses.
 * Never throws.
 */
function runCli(
  bin: string,
  cmdArgs: string[],
  timeoutMs = 8000
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // Mirror runner.ts: prepend the brew bin dirs so CLIs resolve their own deps.
    const cmd = [shell.quote(bin), ...cmdArgs.map(shell.quote)].join(' ')
    const child = spawn(shell.bin, shell.spawnArgs(cmd), { env: shell.env() })
    let out = ''
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve({ ok, out: out.trim() })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (out += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0)
    })
  })
}

/**
 * Resolve the model for a local-service backend (`local` / `mlx`), auto-selecting
 * when the choice is unambiguous.
 *
 * A running server that serves models already tells us everything needed to pick
 * one — making the user restate it in a dropdown is friction with no payoff. And
 * an empty pref FAILS the probe, which banner-blocks a backend that works fine:
 * Rapid-MLX shipped with its server up and a model served, but unusable until a
 * manual pick nobody knew to make.
 *
 * Only auto-selects when exactly ONE model is served. With several, choosing for
 * the user would silently decide which model answers their questions — that's
 * their call. A stored pref always wins, so this never overrides a real choice.
 */
async function resolveLocalModel(
  stored: string,
  list: () => Promise<LocalModel[]>,
  persist: (model: string) => void
): Promise<string> {
  if (stored !== '') return stored
  const models = await list().catch(() => [] as LocalModel[])
  if (models.length !== 1) return ''
  persist(models[0].name)
  return models[0].name
}

/**
 * Fast, cheap, layered health check for a backend CLI — NO LLM round-trip.
 * Step 1: binary runs (`--version`). Step 2: authenticated (`auth/login status`).
 * Each step is ~0.1-0.5s and free. Stops at the first failure and advises a fix.
 */
const lastProbes: Partial<Record<BackendId, BackendProbeRecord>> = {}

export async function probeBackend(backend: BackendId): Promise<BackendTestResult> {
  const result = await runProbe(backend)
  lastProbes[backend] = { result, at: Date.now(), canDisconnect: canDisconnect(backend) }
  return result
}

export async function switchBackend(backend: string): Promise<BackendId> {
  const next = toBackendId(backend)
  // Re-resolve binaries on the next run: the new backend may use a CLI that
  // wasn't installed (and got cached as null) when the app first launched.
  clearBinaryCache()
  PREFS.setBackend(next)
  // Circular import (index.ts -> ipc/settings.ts registration) forces a
  // dynamic import here, same workaround as broadcastIncognito below.
  const { broadcastBackendChanged } = await import('../index')
  broadcastBackendChanged(next)
  track(ANALYTICS_EVENT.backend_switched, { to: next })
  // "Know before you try": probe the newly-chosen backend and warn NOW if it's
  // not set up (BYO CLI missing / not logged in) or out of credits
  // (mightymouse $0) — instead of the user only finding out when their next
  // run fails. Same dismissible banner + payload as the startup probe. Runs
  // fire-and-forget AFTER the pref is saved so switching stays instant (the
  // probe spawns a CLI or hits Supabase). A passing probe pushes nothing.
  probeBackend(next)
    .then((result) => {
      if (result.ok) return
      sendToPanelRenderer(CHANNELS.backendHealthWarning, { backend: next, result })
    })
    .catch(() => {})
  return next
}

function canDisconnect(backend: BackendId): boolean {
  return backend === 'mightymouse' || backend === 'openrouter' || !!BACKENDS[backend].logoutArgs
}

async function disconnectBackend(backend: BackendId): Promise<void> {
  if (backend === 'mightymouse') return signOut()
  if (backend === 'openrouter') {
    const records = KEYS.list().filter((r) => r.name === OPENROUTER_KEY_NAME)
    for (const r of records) await KEYS.remove(r.id, true)
    return
  }
  const { binPath, logoutArgs } = BACKENDS[backend]
  if (binPath && logoutArgs) await runCli(binPath, logoutArgs)
}

async function runProbe(backend: BackendId): Promise<BackendTestResult> {
  if (backend === 'openrouter') return probeOpenRouter()
  const adapter = BACKENDS[backend]
  const checks: BackendCheck[] = []

  // `local` is HTTP transport but has no balance to check — it's a reachability
  // + model-selected check against the user's own Ollama service instead.
  if (backend === 'local') {
    const running = await isOllamaRunning()
    checks.push({
      label: CONFIG.BACKEND_CHECK.serviceRunning.label,
      ok: running,
      detail: running ? 'Ollama is running' : 'Ollama not reachable on localhost:11434'
    })
    if (!running) {
      return { ok: false, checks, advice: 'Start Ollama (ollama serve), then try again.' }
    }
    const model = await resolveLocalModel(PREFS.getOllamaModel(), listLocalModels, (m) =>
      PREFS.setOllamaModel(m)
    )
    checks.push({
      label: CONFIG.BACKEND_CHECK.modelSelected.label,
      ok: model !== '',
      detail: model !== '' ? model : 'No model selected'
    })
    return {
      ok: model !== '',
      checks,
      advice: model !== '' ? null : 'Pick a pulled model in Settings → Local.'
    }
  }

  // `mlx` (Rapid-MLX): same shape as `local` — reachability + model-selected against
  // the user's own Rapid-MLX server, no balance/auth.
  if (backend === 'mlx') {
    const running = await isMlxRunning()
    checks.push({
      label: CONFIG.BACKEND_CHECK.serviceRunning.label,
      ok: running,
      detail: running ? 'Rapid-MLX is running' : 'Rapid-MLX not reachable on localhost:8000'
    })
    if (!running) {
      return {
        ok: false,
        checks,
        advice: 'Start Rapid-MLX (rapid-mlx serve <model>), then try again.'
      }
    }
    const model = await resolveLocalModel(PREFS.getMlxModel(), listMlxModels, (m) =>
      PREFS.setMlxModel(m)
    )
    checks.push({
      label: CONFIG.BACKEND_CHECK.modelSelected.label,
      ok: model !== '',
      detail: model !== '' ? model : 'No model selected'
    })
    return {
      ok: model !== '',
      checks,
      advice: model !== '' ? null : 'Pick a served model in Settings → Rapid-MLX.'
    }
  }

  // HTTP adapters (e.g. mightymouse) have no local binary — report balance as the health signal.
  // transport can be a function (MightyMouse: act→shell, else→http). The health PROBE is not an
  // `act` call, so resolve it as the adapter's non-act transport. Comparing a function against
  // 'http' is always false — that bug made the paid HTTP backend fall through to the shell path
  // and show "CLI not found" instead of the balance.
  const probeTransport =
    typeof adapter.transport === 'function' ? adapter.transport(undefined) : adapter.transport
  if (probeTransport === 'http') {
    const user = await getSession()
    if (!user) {
      checks.push({
        label: CONFIG.BACKEND_CHECK.signedIn.label,
        ok: false,
        detail: 'Not signed in to MightyMouse'
      })
      return { ok: false, checks, advice: 'Sign in to MightyMouse to use this backend.' }
    }
    // Two buckets, one gate: subscription_cents (resets monthly, spent first) +
    // balance_cents (packs, never expire). Gate on the COMBINED total — a
    // subscriber with $0 packs and a funded monthly bucket must still pass,
    // same as the paywall (llm-proxy/cli-proxy). See migration 0016.
    const { data } = await getSupabase()
      .from('credit_balances')
      .select('balance_cents, subscription_cents')
      .eq('user_id', user.userId)
      .single()
    // NO ROW is not $0. The signup grant ($5) is fired fire-and-forget from
    // auth.ts AFTER onAuthedCb, so this probe can beat it on a first run and a
    // brand-new user was told "Balance is $0. Top up" seconds after being given
    // credits. Treat a missing row as still-provisioning and pass the check.
    if (!data) {
      checks.push({
        label: CONFIG.BACKEND_CHECK.balance.label,
        ok: true,
        detail: CONFIG.BACKEND_CHECK.balance.provisioning
      })
      return { ok: true, checks, advice: null }
    }
    const cents = spendableCents(data.balance_cents, data.subscription_cents)
    const display = `$${(cents / 100).toFixed(2)} balance`
    checks.push({ label: CONFIG.BACKEND_CHECK.balance.label, ok: cents > 0, detail: display })
    return {
      ok: cents > 0,
      checks,
      advice: cents > 0 ? null : `You have used all your usage. Upgrade or add extra usage in Settings → Your ${CONFIG.PRODUCT_NAME} plan.`
    }
  }

  // Shell adapters: Step 1 — binary exists + runs.
  // binPath resolves from PATH at runtime; an empty string means not found.
  const binPath = adapter.binPath ?? ''
  if (binPath === '' || !existsSync(binPath)) {
    const detail = binPath === '' ? 'Not found on PATH' : `Not found at ${binPath}`
    checks.push({ label: CONFIG.BACKEND_CHECK.installed.label, ok: false, detail })
    return {
      ok: false,
      checks,
      advice: `${adapter.label} CLI not found. Install it, then update its path.`
    }
  }
  const versionArgs = adapter.versionArgs ?? ['--version']
  const ver = await runCli(binPath, versionArgs)
  // Show WHICH binary answered (home-relative) so a two-installs situation — the
  // exact bug this detection rework fixes — is visible, never hidden behind a bare
  // version string. e.g. "2.1.207 · ~/.local/bin/claude".
  const shownPath = binPath.startsWith(homedir()) ? binPath.replace(homedir(), '~') : binPath
  checks.push({
    label: CONFIG.BACKEND_CHECK.installed.label,
    ok: ver.ok,
    detail: ver.ok
      ? `${ver.out.split('\n')[0].slice(0, 40)} · ${shownPath}`
      : ver.out.slice(0, 100) || 'failed to run'
  })
  if (!ver.ok) {
    return {
      ok: false,
      checks,
      advice: `${binPath} ${versionArgs.join(' ')} failed. The binary may be broken or blocked.`
    }
  }

  // Step 2 — authenticated (each adapter knows how to read its own auth output)
  const authArgs = adapter.authArgs ?? []
  const auth = await runCli(binPath, authArgs)
  const status = adapter.parseAuth
    ? adapter.parseAuth(auth.out, auth.ok)
    : { loggedIn: auth.ok, detail: '' }
  checks.push({
    label: CONFIG.BACKEND_CHECK.loggedIn.label,
    ok: status.loggedIn,
    detail: status.detail
  })

  return {
    ok: checks.every((c) => c.ok),
    checks,
    advice: status.loggedIn ? null : (adapter.loginAdvice ?? null)
  }
}

/**
 * Proactive first-run/startup health check for the ACTIVE backend, run once
 * from the app tail (after onboarding completes, or on every launch once
 * onboarding is already done). probeBackend() before this was only reachable
 * from the Settings "Test" button, so a missing CLI silently dead-ended every
 * run until the user happened to open Settings. On failure, push a dismissible
 * banner to the Panel — same broadcast shape as showError, just its own channel
 * since the payload (which backend, which check failed, advice) doesn't fit
 * showError's single `msg` string.
 */
export async function runStartupBackendProbe(): Promise<void> {
  const backend = PREFS.getBackend()
  const result = await probeBackend(backend)
  if (result.ok) return
  sendToPanelRenderer(CHANNELS.backendHealthWarning, { backend, result })
}

export function registerSettingsHandlers(): void {
  // ── Settings window ────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.settingsGet, async () => buildSettingsState())
  ipcMain.handle(CHANNELS.settingsInstallHint, (_, tool: InstallableTool) =>
    binaries.installHint(tool)
  )

  ipcMain.handle(CHANNELS.settingsRequestPermission, async (_, key: PermissionKey) => {
    lowerOnboardingWindowForGrant()
    await PERMISSIONS.request(key)
    return buildSettingsState()
  })

  ipcMain.handle(CHANNELS.settingsOpenPane, (_, key: PermissionKey) => {
    lowerOnboardingWindowForGrant()
    PERMISSIONS.openPane(key)
  })

  // Settings title-bar "Permissions" button → opens the full wizard window.
  ipcMain.handle(CHANNELS.settingsOpenOnboarding, () => {
    route('onboarding')
  })

  // Dev-only twin of the tray's "Replay first run…" item. The tray click is a
  // human affordance; this makes the same replay drivable from a renderer or a
  // CDP eval, so the wizard's un-granted states can be walked and screenshotted
  // without revoking real TCC grants. Inert in prod (replayFirstRun IS_DEV-gates
  // itself, and the mock layer is only consulted while mock mode is on).
  ipcMain.handle(CHANNELS.devReplayFirstRun, (_, mock?: boolean) => {
    replayFirstRun({ mock: mock !== false })
  })

  // Cold-open deep link: a freshly-created Settings window pulls the section it
  // was opened AT (tray → Phone Remote) once React has mounted its listener.
  ipcMain.handle(CHANNELS.settingsTakeFocusSection, () => takePendingSettingsFocus())

  ipcMain.handle(CHANNELS.settingsSave, async (_, patch: SettingsPatch) => {
    // Drop cached CLI lookups so a path the user just set re-resolves immediately —
    // otherwise the stale "not found" from first launch sticks until an app restart.
    clearBinaryCache()
    // Only the keys the patch actually carried. SETTINGS.set spreads its patch,
    // so passing `undefined` for an absent field would blank the stored value —
    // and the Language picker saves itself alone, without the other five.
    // Typed to the STRING-valued keys only: this loop copies text fields from a
    // string-valued patch, and a non-string setting (siriScreenAnswer) has its
    // own handler. Widening it to `keyof StoredSettings` makes the assignment
    // below unsound rather than making this loop able to carry one.
    // `string extends StoredSettings[K]` and not the reverse: a field typed as a
    // literal union (transcribeEngine) also "extends string", and admitting it
    // here makes the assignment below accept any string for it.
    type StringSettingKey = {
      [K in keyof StoredSettings]-?: string extends StoredSettings[K] ? K : never
    }[keyof StoredSettings]
    const FIELDS: Record<string, StringSettingKey> = {
      ffmpeg: 'ffmpegPath',
      whisper: 'whisperPath',
      whisperModel: 'whisperModelPath',
      whisperLang: 'whisperLang',
      videoDevice: 'videoDevice',
      audioDevice: 'audioDevice'
    }
    const next: Partial<StoredSettings> = {}
    for (const [key, field] of Object.entries(FIELDS)) {
      const value = patch[key]
      if (typeof value === 'string') next[field] = value
    }
    // Carried by hand rather than through FIELDS above: that loop copies a
    // string-valued patch, and this is the only boolean setting.
    if (typeof patch.siriScreenAnswer === 'boolean') {
      next.siriScreenAnswer = patch.siriScreenAnswer
    }
    if (typeof patch.smallPanel === 'boolean') next.smallPanel = patch.smallPanel
    if (typeof patch.holdForSmartDictation === 'boolean') {
      next.holdForSmartDictation = patch.holdForSmartDictation
    }
    if (typeof patch.advancedMode === 'boolean') next.advancedMode = patch.advancedMode
    if (typeof patch.webAccess === 'boolean') next.webAccess = patch.webAccess
    if (typeof patch.codeOwnCopy === 'boolean') next.codeOwnCopy = patch.codeOwnCopy
    for (const f of TRANSCRIPT_FORMATS) {
      const on = patch[`${TRANSCRIPT_FORMAT_KEY}${f.id}`]
      if (typeof on === 'boolean') {
        next.transcriptFormats = { ...SETTINGS.get().transcriptFormats, ...next.transcriptFormats, [f.id]: on }
      }
    }
    if (patch.transcribeEngine === 'parakeet' || patch.transcribeEngine === 'whisper') {
      next.transcribeEngine = patch.transcribeEngine
    }
    SETTINGS.set(next)
    if (next.webAccess === false) closeWebClients('off')
    if (next.webAccess !== undefined) scheduleChatSync()
    for (const key of Object.keys(patch)) {
      track(ANALYTICS_EVENT.setting_saved, { key })
    }
    return buildSettingsState()
  })

  ipcMain.handle(CHANNELS.settingsDownloadModel, async (_, modelName?: string) => {
    const model = modelName || CONFIG.WHISPER_MODEL_DEFAULT_NAME
    track(ANALYTICS_EVENT.whisper_model_download, { model })
    // Parakeet's model is useless without its engine, and the engine is a
    // separate archive. Fetching only the model would leave the user's language
    // silently on whisper — needing the 1.6GB model the picker stopped offering.
    if (model === CONFIG.PARAKEET_MODEL_NAME && !hasManagedParakeet()) {
      const engine = await downloadManagedParakeet()
      if (!engine.ok) {
        return { result: engine, state: await buildSettingsState() }
      }
    }
    const res = await downloadWhisperModel((pct) => {
      sendToSettingsRenderer(CHANNELS.modelDownloadProgress, { pct })
    }, model)
    return { result: res, state: await buildSettingsState() }
  })

  ipcMain.handle(CHANNELS.settingsInstallWhisper, async () => {
    const res = await installWhisperViaBrew((line) => {
      sendToSettingsRenderer(CHANNELS.binaryInstallProgress, { key: 'whisper', line })
    })
    return { result: res, state: await buildSettingsState() }
  })

  ipcMain.handle(CHANNELS.settingsInstallFfmpeg, async () => {
    track(ANALYTICS_EVENT.ffmpeg_install, {})
    const res = await installFfmpegViaBrew((line) => {
      sendToSettingsRenderer(CHANNELS.binaryInstallProgress, { key: 'ffmpeg', line })
    })
    // Drop the memoized "not-found" so the fresh install is picked up without a
    // relaunch — the whole point of this flow is that it works immediately.
    if (res.ok) clearBinaryCache()
    return { result: res, state: await buildSettingsState() }
  })

  // Live PREFS toggles surfaced in the Settings window (cursor companion + model)
  ipcMain.handle(CHANNELS.settingsGetPrefs, async () => ({
    cursorCompanion: PREFS.getCursorCompanion(),
    cursorStyle: PREFS.getCursorStyle(),
    backend: PREFS.getBackend(),
    ollamaModel: PREFS.getOllamaModel(),
    mlxModel: PREFS.getMlxModel(),
    selectedModel: PREFS.getSelectedModel(),
    thinkingEnabled: PREFS.getThinkingEnabled(),
    maxRecordingMin: PREFS.getMaxRecordingMin(),
    soundEnabled: PREFS.getSoundEnabled(),
    captureHud: PREFS.getCaptureHud(),
    listenAutoPaste: PREFS.getListenAutoPaste(),
    contextLog: PREFS.getContextLog(),
    agentPhotos: PREFS.getAgentRelayPhotosEnabled(),
    decisionCards: PREFS.getDecisionCardsEnabled(),
    runTranscript: PREFS.getRunTranscript(),
    showTiming: PREFS.getShowTiming(),
    dynamicIsland: PREFS.getDynamicIsland(),
    selectionBar: PREFS.getSelectionBar(),
    selectionBarFast: PREFS.getSelectionBarFast(),
    dockIcon: PREFS.getDockIcon(),
    liveCompanion: PREFS.getLiveMode(),
    companionRenderer: PREFS.getCompanionRenderer(),
    companionSize: PREFS.getCompanionSize(),
    liveActs: PREFS.getLiveActs(),
    suggestions: PREFS.getExperimentalSuggestions(),
    clickEnabled: PREFS.getClickEnabled(),
    fnListenEnabled: PREFS.getFnListenEnabled(),
    actHighlight: PREFS.getActHighlight(),
    feedbackEnabled: PREFS.getFeedbackEnabled(),
    historyFilterHidden: PREFS.getHistoryFilterHidden(),
    mightySourceFilterHidden: PREFS.getMightySourceFilterHidden(),
    mightyShowEmpty: PREFS.getMightyShowEmpty(),
    historyEncryption: PREFS.getHistoryEncryption(),
    incognito: PREFS.getIncognito(),
    phoneRemoteEnabled: PREFS.getPhoneRemoteEnabled(),
    phoneRemoteStayAwake: PREFS.getPhoneRemoteStayAwake(),
    phoneRemoteClamshell: PREFS.getPhoneRemoteClamshell(),
    phoneRemoteAwayMode: PREFS.getPhoneRemoteAwayMode(),
    // Live session state, not a pref: Settings can open mid-session (a phone
    // connected, or the tray covered the screen), and a button seeded from the
    // pref alone would offer to cover an already-covered Mac.
    phoneRemoteAwayHeld: isAwayModeHeld(),
    phoneRemoteSupported: capabilities.pointerControl,
    // `advancedMenu` now means simply "is admin" — there's no manual toggle
    // anymore. Admins get the Settings Advanced bucket (binary paths, AV devices,
    // niche capture knobs); everyone else gets the slim simple view.
    advancedMenu: await isCurrentUserAdmin()
  }))

  ipcMain.handle(CHANNELS.settingsSetMaxRec, async (_, min: number) => {
    PREFS.setMaxRecordingMin(Number(min))
    track(ANALYTICS_EVENT.setting_saved, { key: 'max_recording_min' })
    return PREFS.getMaxRecordingMin()
  })

  ipcMain.handle(CHANNELS.settingsSetSound, async (_, on: boolean) => {
    const next = on === true
    PREFS.setSoundEnabled(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'sound', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetCaptureHud, async (_, on: boolean) => {
    const next = on === true
    PREFS.setCaptureHud(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'capture_hud', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetListenAutoPaste, async (_, on: boolean) => {
    const next = on === true
    PREFS.setListenAutoPaste(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'listen_auto_paste', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetRunTranscript, async (_, on: boolean) => {
    const next = on === true
    PREFS.setRunTranscript(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'run_transcript', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetShowTiming, async (_, on: boolean) => {
    const next = on === true
    PREFS.setShowTiming(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'show_timing', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.globalInstructionsGet, () => PREFS.getGlobalInstructions())
  ipcMain.handle(CHANNELS.globalInstructionsSet, (_, settings: GlobalInstructionsSettings) => {
    PREFS.setGlobalInstructions(settings)
    const on = Object.entries(settings.appliesTo)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(',')
    track(ANALYTICS_EVENT.setting_toggled, { key: 'global_instructions', value: on })
  })

  ipcMain.handle(CHANNELS.settingsSetContextLog, async (_, on: boolean) => {
    const next = on === true
    PREFS.setContextLog(next)
    if (next) startContextLogging()
    else stopContextLogging()
    track(ANALYTICS_EVENT.setting_toggled, { key: 'context_log', value: String(next) })
    return next
  })

  // No live effect to run: build-server reads the pref per connection, so the
  // next agent to connect sees the tool appear or vanish with no restart.
  ipcMain.handle(CHANNELS.settingsSetAgentPhotos, async (_, on: boolean) => {
    const next = on === true
    PREFS.setAgentRelayPhotosEnabled(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'agent_relay_photos', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetDecisionCards, async (_, on: boolean) => {
    const next = on === true
    PREFS.setDecisionCardsEnabled(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'decision_cards', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetDynamicIsland, async (_, on: boolean) => {
    const next = on === true
    PREFS.setDynamicIsland(next)
    // Live effect: create or destroy the notch overlay without a restart. On enable,
    // play the first-run demo so the user immediately sees what it does.
    setIslandWindow(next, next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'dynamic_island', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetSelectionBar, async (_, on: boolean) => {
    const next = on === true
    PREFS.setSelectionBar(next)
    // Live effect: start/stop the mouse watcher without a restart. Mirrors
    // settingsSetDynamicIsland.
    applySelectionWatcher()
    track(ANALYTICS_EVENT.setting_toggled, { key: 'selection_bar', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetSelectionBarFast, async (_, on: boolean) => {
    const next = on === true
    PREFS.setSelectionBarFast(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'selection_bar_fast', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetDockIcon, async (_, on: boolean) => {
    const next = on === true
    PREFS.setDockIcon(next)
    // Live effect, no restart — the bundle sets no LSUIElement, so macOS honors
    // show/hide immediately. Mirrors settingsSetDynamicIsland.
    applyDockIcon(next)
    // Turning it ON promotes the app out of accessory mode, so it joins ⌘-Tab and
    // the Dock. Show the panel so the icon the user just asked for has the main
    // surface behind it — an app you can switch to that shows nothing reads as
    // broken. showPanelWindow, not surfaceApp: Settings is open by definition here
    // (that's where this toggle lives), so surfaceApp would just refocus Settings
    // and the user would see nothing happen.
    if (next) route('panel', { panelSource: 'dock' })
    track(ANALYTICS_EVENT.setting_toggled, { key: 'dock_icon', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetCompanion, async (_, on: boolean) => {
    const next = on === true
    PREFS.setLiveMode(next)
    // Turning live mode off ends the spoken conversation: the next time it's
    // switched on, the user is starting a new one, not resuming whatever they
    // said an hour ago. The session itself survives in chat either way.
    if (!next) setLiveSession(undefined)
    // Live effect, no restart — mirrors settingsSetDynamicIsland.
    setCompanionWindow(next)
    // The tray row reads Start/End off the running window, so it goes stale
    // whenever the conversation ends from anywhere else (this handler, the ✕).
    // Circular import forces the dynamic import, same as broadcastIncognito.
    const { refreshTrayMenu } = await import('../index')
    refreshTrayMenu()
    track(ANALYTICS_EVENT.setting_toggled, { key: 'live_companion', value: String(next) })
    return next
  })

  // Which companion visualization draws the character. The swap is a live prop
  // change in CompanionApp (no window recreate), but Stage is full-screen and
  // click-through where the others are a draggable corner card — so the window's
  // bounds and pointer behavior have to be re-applied after the pick.
  ipcMain.handle(CHANNELS.settingsSetCompanionRenderer, async (_, renderer: string) => {
    const next = toCompanionRenderer(renderer)
    PREFS.setCompanionRenderer(next)
    applyCompanionRenderer()
    track(ANALYTICS_EVENT.setting_saved, { key: 'companion_renderer' })
    return next
  })

  // How much screen a voice conversation takes. Full-screen is click-through so
  // the agent's own clicks land underneath; minimized stays clickable so the
  // puck can be clicked to go back to full. Both re-applied by
  // applyCompanionRenderer, which reads the size pref.
  ipcMain.handle(CHANNELS.settingsSetCompanionSize, async (_, size: string) => {
    const next = toCompanionSize(size)
    PREFS.setCompanionSize(next)
    applyCompanionRenderer()
    track(ANALYTICS_EVENT.setting_saved, { key: 'companion_size' })
    return next
  })

  // May a voice turn DRIVE the Mac, or only answer? The one control that decides
  // whether an agent can click and type on the user's real machine.
  ipcMain.handle(CHANNELS.settingsSetLiveActs, async (_, on: boolean) => {
    PREFS.setLiveActs(on)
    track(ANALYTICS_EVENT.setting_saved, { key: 'live_acts' })
    return on
  })

  // Full-screen only. The overlay is click-through by default so the agent's own
  // clicks land on the app underneath; the renderer asks for pointer events
  // back while the cursor is over the input bar, and gives them up on leave.
  ipcMain.handle(CHANNELS.companionSetInteractive, async (_, interactive: boolean) => {
    setCompanionInteractive(interactive === true)
  })

  ipcMain.handle(CHANNELS.settingsSetSuggestions, async (_, on: boolean) => {
    const next = on === true
    PREFS.setExperimentalSuggestions(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'suggestions', value: String(next) })
    // Live effect, no restart. On enable: the overlay hosts the bubble, so bring
    // it up (pointer art stays off unless the companion pref is on) and start the
    // manager. On disable: stop the manager; only tear the overlay down if the
    // companion isn't using it too.
    if (next) {
      startCursorCompanion()
      startInsightsManager()
    } else {
      stopInsightsManager()
      if (!PREFS.getCursorCompanion()) stopCursorCompanion()
    }
    return next
  })

  // Let an ask answer move + click a coordinate. Clicking needs Accessibility,
  // so enabling fires the system prompt — but we return the raw pref either way;
  // the runner re-checks the live permission at click time and silently no-ops
  // (points only) if it's still denied, so a granted-later flow just works.
  // fn (globe) as a listen alias. Rides a native CGEvent tap, which needs the same
  // Accessibility grant uiohook already holds — so enabling prompts for it, exactly
  // like the click toggle below.
  ipcMain.handle(CHANNELS.settingsSetFnListen, async (_, on: boolean) => {
    const next = on === true
    PREFS.setFnListenEnabled(next)
    setFnListenEnabled(next)
    if (next) PERMISSIONS.hasAccessibility(true)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'fn_listen_enabled', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetClick, async (_, on: boolean) => {
    const next = on === true
    PREFS.setClickEnabled(next)
    if (next) PERMISSIONS.hasAccessibility(true)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'click_enabled', value: String(next) })
    return next
  })

  // Act-mode highlight box flash — see PREFS.getActHighlight() + hud-run.ts's
  // onActEvent. No permission side effect (act mode already has whatever it needs).
  ipcMain.handle(CHANNELS.settingsSetActHighlight, async (_, on: boolean) => {
    const next = on === true
    PREFS.setActHighlight(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'act_highlight', value: String(next) })
    return next
  })

  // Feedback loop master switch. Live effect: hides the rating UI in the panel AND
  // stops corrections being folded into the prompt (buildMemoryBlob reads the pref).
  ipcMain.handle(CHANNELS.settingsSetFeedback, async (_, on: boolean) => {
    const next = on === true
    PREFS.setFeedbackEnabled(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'feedback', value: String(next) })
    return next
  })

  // Flip the encryption toggle, then immediately reconcile the on-disk file
  // (backs up before converting). Returns the EFFECTIVE state — if safeStorage
  // is unavailable the convert is a no-op and the file stays plaintext.
  ipcMain.handle(CHANNELS.settingsSetHistoryEncryption, async (_, on: boolean) => {
    const next = on === true
    PREFS.setHistoryEncryption(next)
    reconcileHistoryEncryption()
    track(ANALYTICS_EVENT.setting_toggled, { key: 'history_encryption', value: String(next) })
    return PREFS.getHistoryEncryption()
  })

  // History-panel kind filter. Persists the HIDDEN run-kind set (CSV pref) so the
  // History flyout's filter survives restarts. Returns the stored set so the
  // renderer can reconcile its optimistic state.
  ipcMain.handle(CHANNELS.settingsSetHistoryFilter, async (_, hidden: string[]) => {
    const list = Array.isArray(hidden) ? hidden.map(String) : []
    PREFS.setHistoryFilterHidden(list)
    return PREFS.getHistoryFilterHidden()
  })

  ipcMain.handle(CHANNELS.settingsSetMightySourceFilter, async (_, hidden: string[]) => {
    const list = Array.isArray(hidden) ? hidden.map(String) : []
    PREFS.setMightySourceFilterHidden(list)
    return PREFS.getMightySourceFilterHidden()
  })

  ipcMain.handle(CHANNELS.settingsSetMightyShowEmpty, async (_, show: boolean) => {
    PREFS.setMightyShowEmpty(show === true)
    return PREFS.getMightyShowEmpty()
  })

  // Incognito mode. Intentionally NOT tracked in either direction: sending a
  // setting_toggled here would leak exactly when the user goes private, which
  // defeats the feature. The pref write itself is what takes effect.
  ipcMain.handle(CHANNELS.settingsSetIncognito, async (_, on: boolean) => {
    const next = on === true
    PREFS.setIncognito(next)
    const confirmed = PREFS.getIncognito()
    // Same side effects as the tray toggle: update every window's badge + the
    // tray. Lazy import avoids the index↔ipc load-time cycle (index imports ipc).
    // Deliberately NOT tracked — see the design; logging the toggle would leak the
    // moment the user goes private.
    const { broadcastIncognito } = await import('../index')
    broadcastIncognito(confirmed)
    return confirmed
  })

  // Wipe history (backs up to ~/MightyMouse/backups/ first). Returns the backup path.
  ipcMain.handle(CHANNELS.settingsClearHistory, async () => {
    track(ANALYTICS_EVENT.setting_saved, { key: 'history_clear' })
    return HISTORY.clear()
  })

  ipcMain.handle(CHANNELS.settingsSetCursor, async (_, on: boolean) => {
    const next = on === true
    PREFS.setCursorCompanion(next)
    setCursorCompanion(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'cursor_companion', value: String(next) })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetCursorStyle, async (_, style: string) => {
    const next = toCursorStyle(style)
    PREFS.setCursorStyle(next)
    // Push to the live overlay so the look swaps without a restart.
    broadcastCursorStyle(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'cursor_style', value: next })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetBackend, (_, backend: string) => switchBackend(backend))

  ipcMain.handle(CHANNELS.settingsTestBackend, async (_, backend: string) => {
    return probeBackend(toBackendId(backend))
  })

  ipcMain.handle(CHANNELS.settingsBackendProbes, () => lastProbes)

  ipcMain.handle(CHANNELS.planLoginsList, () => listPlanLogins())
  ipcMain.handle(CHANNELS.planLoginsCheck, () => checkPlanUsage())
  ipcMain.handle(CHANNELS.planLoginsAdd, (_, backend: string) =>
    isPlanBackend(backend) ? addPlanLogin(backend) : { logins: [], error: 'Unknown plan' }
  )
  ipcMain.handle(CHANNELS.planLoginsCancel, () => cancelPlanSignIn())
  ipcMain.handle(CHANNELS.planLoginsRemove, (_, id: string) => removePlanLogin(id))
  ipcMain.handle(CHANNELS.planLoginPicks, () => planLoginPicks())
  ipcMain.handle(CHANNELS.planLoginSetPick, (_, backend: string, id: unknown) =>
    isPlanBackend(backend) && typeof id === 'string' ? setPlanLoginPick(backend, id) : planLoginPicks()
  )

  ipcMain.handle(CHANNELS.settingsDisconnectBackend, async (_, backend: string) => {
    const id = toBackendId(backend)
    await disconnectBackend(id)
    if (id === 'mightymouse') (await import('../index')).refreshTrayMenu()
    return probeBackend(id)
  })

  // Panel-open pre-flight: probe whatever backend is currently selected and hand
  // back {backend, result} so the panel can warn + gate submit BEFORE the user
  // types. Returns the same payload shape as the startup/switch broadcasts so the
  // panel reuses one banner path. Never throws — a probe failure degrades to
  // "no warning" rather than blocking the panel from opening.
  ipcMain.handle(CHANNELS.panelProbeBackend, async () => {
    const backend = PREFS.getBackend()
    try {
      return { backend, result: await probeBackend(backend) }
    } catch {
      return null
    }
  })

  ipcMain.handle(CHANNELS.settingsSetOllamaModel, async (_, model: string) => {
    const next = typeof model === 'string' ? model.trim() : ''
    PREFS.setOllamaModel(next)
    track(ANALYTICS_EVENT.setting_saved, { key: 'ollama_model' })
    return next
  })

  ipcMain.handle(CHANNELS.settingsSetThinkingEnabled, async (_, on: boolean) => {
    const next = on === true
    PREFS.setThinkingEnabled(next)
    track(ANALYTICS_EVENT.setting_saved, { key: 'thinking_enabled' })
    return next
  })

  // The panel's model dropdown writes here on change. PREFS.setSelectedModel
  // validates against the live model list (junk/removed → cleared to ''), and we
  // echo the STORED value back so the renderer reflects exactly what persisted.
  ipcMain.handle(CHANNELS.modelCatalogGet, () => getModelCatalog())
  ipcMain.handle(CHANNELS.panelSetSelectedModel, async (_, model: string) => {
    PREFS.setSelectedModel(typeof model === 'string' ? model : '')
    track(ANALYTICS_EVENT.setting_saved, { key: 'selected_model' })
    return PREFS.getSelectedModel()
  })

  ipcMain.handle(CHANNELS.settingsListLocalModels, async () => {
    return listLocalModels()
  })

  ipcMain.handle(CHANNELS.settingsSetMlxModel, async (_, model: string) => {
    const next = typeof model === 'string' ? model.trim() : ''
    PREFS.setMlxModel(next)
    track(ANALYTICS_EVENT.setting_saved, { key: 'mlx_model' })
    return next
  })

  ipcMain.handle(CHANNELS.settingsListMlxModels, async () => {
    return listMlxModels()
  })

  ipcMain.handle(CHANNELS.settingsLocalSetupState, async (_, backend: string) => {
    return localSetupState(backend === 'mlx' ? 'mlx' : 'local')
  })

  ipcMain.handle(CHANNELS.settingsSetUpLocalBackend, async (event, backend: string) => {
    const target: LocalSetupBackend = backend === 'mlx' ? 'mlx' : 'local'
    const result = await setUpLocalBackend(target, (tick) => {
      // Plain-English lines only — brew's raw output never crosses this boundary.
      event.sender.send(CHANNELS.settingsLocalSetupProgress, { backend: target, ...tick })
    })

    // Serving a model IS selecting it: the user has one running model and an
    // empty dropdown otherwise, which reads as "it didn't work".
    if (result.ok && result.startedModel) PREFS.setMlxModel(result.startedModel)
    return result
  })
}

/**
 * What the local-backend row can offer right now.
 *
 * Ollama and Rapid-MLX diverge here: `ollama serve` needs nothing, while
 * `rapid-mlx serve` requires an alias the user has already pulled. So a
 * Rapid-MLX with an empty cache gets no button — a download is the user's
 * call, not something a Settings row should start unasked.
 */
async function localSetupState(backend: LocalSetupBackend): Promise<LocalSetupState> {
  const copy = CONFIG.LOCAL_SETUP_COPY

  if (backend === 'mlx' && !mlxSupported()) {
    return { action: null, pulledModels: [], detail: copy.unsupportedArch }
  }

  const running = await (backend === 'mlx' ? isMlxRunning() : isOllamaRunning())
  if (running) return { action: null, pulledModels: [], detail: null }

  if (!hasHomebrew() && !isLocalServiceInstalled(backend)) {
    return { action: null, pulledModels: [], detail: copy.noBrew }
  }

  const pulled = backend === 'mlx' ? pulledMlxModels() : []
  if (backend === 'mlx' && pulled.length === 0) {
    return { action: null, pulledModels: pulled, detail: copy.noModels }
  }

  return {
    action: isLocalServiceInstalled(backend) ? 'start' : 'install',
    pulledModels: pulled,
    detail: null
  }
}
