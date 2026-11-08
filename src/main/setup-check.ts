/**
 * Setup Check — the main-process probe.
 *
 * This is a MAPPING layer, not a fourth source of truth. Three probes already
 * answer the question in pieces; each one just rendered its failure as a
 * different shape, two of them as dead-end sentences:
 *
 *   buildPermissionChecks()  → permission cards (the one good surface)
 *   getBinaryStatuses()      → one grey sentence, OnboardingApp.tsx
 *   probeBackend()           → another grey sentence
 *
 * Here they become one `SetupCheck[]`, and — the whole point — every failing
 * row carries the ACTION that fixes it.
 *
 * OPACITY: every user-visible string comes from CONFIG.SETUP_CHECK.
 * We never surface a binary name, a path (paths leak $HOME → a real name), or
 * raw tool output. `detail` is written for a person, not an operator.
 *
 */
import { existsSync } from 'fs'
import { basename } from 'path'
import { app, BrowserWindow } from 'electron'
import {
  SETUP_CHECK_ID,
  SETUP_STATUS,
  SETUP_FIX_KIND,
  SETUP_CHAIN,
  type SetupCheck,
  type SetupCheckId,
  type SetupChain,
  type SetupFix,
  voiceRowState
} from '../shared/setup-check'
import { CONFIG } from '../shared/config'
import { parakeetCanTranscribe } from '../shared/whisper-languages'
import { IS_DEV } from '../shared/env'
import type { BackendId, PermissionCheck, BinaryStatus } from '../shared/types'
import { buildPermissionChecks, PERMISSIONS, clearBinaryCache, resolveBrewBin } from './platform'
import {
  getBinaryStatuses,
  installCliPackage,
  downloadWhisperModel,
  whisperModelPathFor,
  whisperUsable
} from './capture/binaries'
import { listAvDevices } from './capture/devices'
import { ensureFfmpeg } from './capture/ensure-ffmpeg'
import { warmWhisper } from './capture/whisper'
import {
  downloadManagedFfmpeg,
  downloadManagedWhisper,
  downloadManagedParakeet,
  hasManagedParakeet,
  downloadFailureReason
} from './capture/download-binaries'
import { track } from './analytics'
import { probeBackend } from './ipc/settings'
import { PREFS } from './store/prefs'
import { SETTINGS } from './store/settings'
import { BACKENDS } from './backend/adapters'
import {
  setUpLocalBackend,
  isLocalServiceInstalled,
  mlxSupported,
  pulledMlxModels,
  type LocalSetupBackend
} from './backend/local-setup'
import { getSession } from './auth'

const COPY = CONFIG.SETUP_CHECK

/** Both halves of the Parakeet setup — the unpacked engine and its model. */
export function parakeetReady(): boolean {
  return hasManagedParakeet() && existsSync(whisperModelPathFor(CONFIG.PARAKEET_MODEL_NAME))
}

type ParakeetProgressListener = (pct: number) => void
const parakeetProgressListeners = new Set<ParakeetProgressListener>()

/** Observe the ONE in-flight background download — never starts a second one. */
export function onParakeetProgress(cb: ParakeetProgressListener): () => void {
  parakeetProgressListeners.add(cb)
  return () => parakeetProgressListeners.delete(cb)
}

function emitParakeetProgress(pct: number): void {
  for (const cb of parakeetProgressListeners) cb(pct)
}

/** Whether this install should be using Parakeet at all: the setting, the
 *  language, and a platform where it has been timed against whisper. */
function parakeetWanted(): boolean {
  const s = SETTINGS.get()
  if ((s.transcribeEngine ?? 'parakeet') !== 'parakeet') return false
  if (!parakeetCanTranscribe(s.whisperLang || CONFIG.WHISPER_LANG)) return false
  // Only Apple Silicon is measured. Intel Macs and Windows get
  // NVIDIA's CPU/Vulkan builds, which are untimed — until someone runs the same
  // 22 clips there, whisper stays the default rather than a guess.
  return process.platform === 'darwin' && process.arch === 'arm64'
}

/**
 * Fetch the engine and model for an existing user, in the background.
 *
 * Deliberately silent: whisper keeps transcribing every clip until both halves
 * land, so there is nothing for the user to decide and nothing to interrupt.
 */
export async function ensureParakeetInBackground(): Promise<void> {
  if (parakeetReady()) return
  await ensureQuickDictation()
  if (!parakeetWanted()) return
  if (!hasManagedParakeet()) {
    const engine = await downloadManagedParakeet((pct) => emitParakeetProgress(pct * 0.5))
    track('binary_downloaded', {
      binary: 'nemo-speech',
      arch: process.arch,
      ok: engine.ok,
      reason: downloadFailureReason(engine.error)
    })
    if (!engine.ok) return
  }
  const modelPath = whisperModelPathFor(CONFIG.PARAKEET_MODEL_NAME)
  if (!existsSync(modelPath)) {
    const got = await downloadWhisperModel(
      (pct) => emitParakeetProgress(50 + pct * 0.5),
      CONFIG.PARAKEET_MODEL_NAME
    )
    track('binary_downloaded', {
      binary: 'parakeet-model',
      arch: process.arch,
      ok: got.ok,
      reason: downloadFailureReason(got.error)
    })
  }
  emitParakeetProgress(100)
  clearBinaryCache()
}

export function dictationReady(): boolean {
  return parakeetReady() || whisperUsable()
}

// A new Mac otherwise waits on Parakeet's 714 MB before its first word; tiny.en is 78 MB.
async function ensureQuickDictation(): Promise<void> {
  if (whisperUsable()) return
  if ((SETTINGS.get().whisperLang || CONFIG.WHISPER_LANG) !== 'en') return
  if (!existsSync(SETTINGS.get().whisperPath)) {
    const cli = await downloadManagedWhisper((pct) => emitParakeetProgress(pct * 0.05))
    track('binary_downloaded', {
      binary: 'whisper-cli',
      arch: process.arch,
      ok: cli.ok,
      reason: downloadFailureReason(cli.error)
    })
    if (!cli.ok) return
    SETTINGS.set({ whisperPath: cli.path })
  }
  const got = await downloadWhisperModel(
    (pct) => emitParakeetProgress(5 + pct * 0.95),
    CONFIG.WHISPER_QUICK_MODEL_NAME
  )
  track('binary_downloaded', {
    binary: 'whisper-quick-model',
    arch: process.arch,
    ok: got.ok,
    reason: downloadFailureReason(got.error)
  })
  if (!got.ok) return
  await warmWhisper()
  emitParakeetProgress(100)
}

// Native CoreAudio mic isn't packaged in a release build (native-mic.ts), so
// listen/record falls back to ffmpeg — a fresh Mac has neither. Silent, same shape as above.
export async function ensureFfmpegInBackground(): Promise<void> {
  if (ensureFfmpeg()) return
  const got = await downloadManagedFfmpeg()
  track('binary_downloaded', {
    binary: 'ffmpeg',
    arch: process.arch,
    ok: got.ok,
    reason: downloadFailureReason(got.error)
  })
}

/**
 * The zero-install backend. Typed as BackendId (not a bare string) so a typo
 * or a rename of the adapter key fails the typecheck rather than at runtime.
 */
const MANAGED_BACKEND: BackendId = 'mightymouse'

/**
 * Narrow a BackendId to the two local services setUpLocalBackend() can drive.
 *
 * Declared as a BackendId[] so adding a third brew-installed backend without a
 * SERVICE entry in local-setup.ts fails the typecheck here rather than falling
 * through to a silent `{ ok: false }` at runtime.
 */
const LOCAL_SETUP_BACKENDS: BackendId[] = ['local', 'mlx']

function isLocalSetupBackend(backend: BackendId): backend is LocalSetupBackend {
  return LOCAL_SETUP_BACKENDS.includes(backend)
}

/** Friendly backend name ("Claude"), never an id or a binary name. */
function backendLabel(backend: BackendId): string {
  return CONFIG.BACKEND_META[backend]?.label ?? backend
}

/** `{name}` is the only placeholder in SETUP_CHECK copy. */
function withName(template: string, name: string): string {
  return template.replace('{name}', name)
}

// ── Permissions ─────────────────────────────────────────────────────────────

const PERMISSION_ROWS = [
  {
    key: 'accessibility',
    id: SETUP_CHECK_ID.accessibility,
    copy: COPY.accessibility,
    required: true
  },
  { key: 'screen', id: SETUP_CHECK_ID.screen, copy: COPY.screen, required: true },
  { key: 'microphone', id: SETUP_CHECK_ID.microphone, copy: COPY.microphone, required: false }
] as const

function permissionChecks(checks: PermissionCheck[]): SetupCheck[] {
  return PERMISSION_ROWS.map(({ key, id, copy, required }) => {
    const found = checks.find((c) => c.key === key)
    // The functional probe is the verdict; `status` is a cached OS flag that
    // reads 'denied' for a grant made while we were running. ANDing the two told
    // a user staring at his own enabled toggle that he still had to grant it.
    const ok = found ? found.test.ok : false
    if (ok) {
      return { id, label: copy.label, status: SETUP_STATUS.ok, detail: copy.ok }
    }
    return {
      id,
      label: copy.label,
      // A missing mic doesn't block the app, so it must not block setup either.
      status: required ? SETUP_STATUS.fail : SETUP_STATUS.optional,
      // The probe knows WHICH failure this is (off / not listed / needs a
      // restart); the generic line can't tell them apart.
      detail: found?.test.detail ?? copy.fail,
      // A granted-but-dead permission is fixed by relaunching, not by granting
      // again, so the button has to say what it will actually do.
      fix: found?.test.ffmpegBroken
        ? { kind: SETUP_FIX_KIND.install, label: COPY.recording.fixLabel }
        : {
            kind: SETUP_FIX_KIND.grant,
            label:
              found?.status === 'granted' && 'restartLabel' in copy
                ? copy.restartLabel
                : copy.fixLabel
          }
    }
  })
}

/**
 * True when macOS has the grant but capture still comes back empty — the
 * per-process TCC cache, which nothing but a relaunch clears.
 */
async function needsRestartForScreen(): Promise<boolean> {
  const checks = await buildPermissionChecks()
  const screen = checks.find((c) => c.key === 'screen')
  return !!screen && screen.status === 'granted' && !screen.test.ok
}

// ── Capture binaries ────────────────────────────────────────────────────────

/**
 * Recording needs ffmpeg; transcription needs whisper + its model. The user
 * hears about neither — they hear "Screen recording" and "Voice transcription",
 * which is what they actually care about.
 */
function captureChecks(binaries: BinaryStatus[], micOk: boolean): SetupCheck[] {
  const found = (key: BinaryStatus['key']): boolean =>
    binaries.find((b) => b.key === key)?.found ?? false

  const rows: SetupCheck[] = []

  rows.push(
    found('ffmpeg')
      ? {
          id: SETUP_CHECK_ID.recording,
          label: COPY.recording.label,
          status: SETUP_STATUS.ok,
          detail: COPY.recording.ok
        }
      : {
          id: SETUP_CHECK_ID.recording,
          label: COPY.recording.label,
          // `optional`, not `fail`: isSetupComplete() (shared/setup-check.ts)
          // demands every blocking row pass, so a Mac without Homebrew could
          // never finish setup — while rewrite and ask work fine without this.
          // Transcription below has always been optional for the same reason.
          status: SETUP_STATUS.optional,
          // Always offer the button: the fix is now a direct download, so it no
          // longer depends on Homebrew being present. The old brew gate hid the
          // action on exactly the Macs that needed it most.
          detail: COPY.recording.fail,
          fix: { kind: SETUP_FIX_KIND.install, label: COPY.recording.fixLabel }
        }
  )

  // Transcription needs BOTH the engine and its model — from the user's side
  // that's one capability, so it's one row with one button.
  // Either engine is a working dictation setup, so a user who downloaded
  // Parakeet must not be told transcription is unconfigured because whisper's
  // 148MB model never landed.
  const voice = voiceRowState((found('whisper') && found('whisperModel')) || parakeetReady(), micOk)
  const needsMicOnly = voice.fixKind === SETUP_FIX_KIND.grant
  rows.push(
    voice.status === SETUP_STATUS.ok
      ? {
          id: SETUP_CHECK_ID.transcription,
          label: COPY.transcription.label,
          status: SETUP_STATUS.ok,
          detail: COPY.transcription.ok
        }
      : {
          id: SETUP_CHECK_ID.transcription,
          label: COPY.transcription.label,
          // Voice is a real feature but the app still rewrites without it.
          status: SETUP_STATUS.optional,
          detail: needsMicOnly ? COPY.transcription.needsMic : COPY.transcription.fail,
          fix: {
            kind: voice.fixKind ?? SETUP_FIX_KIND.install,
            label: needsMicOnly ? COPY.transcription.needsMicFixLabel : COPY.transcription.fixLabel
          }
        }
  )

  return rows
}

// ── Backend ─────────────────────────────────────────────────────────────────

/**
 * What the zero-install escape hatch has to do BEFORE switching is meaningful.
 *
 * Switching a signed-out user to the managed backend would land them in a
 * FOURTH dead end — the exact failure this whole design exists to kill. So the
 * fix declares its prerequisite and the runner walks it.
 */
async function switchChain(): Promise<SetupChain> {
  const user = await getSession()
  if (!user) return SETUP_CHAIN.signIn
  // Balance is checked by probeBackend against credit_balances; re-probing the
  // managed backend here is the cheapest way to ask "would it actually run?".
  const probe = await probeBackend(MANAGED_BACKEND)
  return probe.ok ? SETUP_CHAIN.none : SETUP_CHAIN.topUp
}

/**
 * @param asBackup the fix sits NEXT TO a working "Connect X" rather than
 *   standing alone, so it reads as the fallback instead of the main route.
 *
 * The label never carries the chain's sign-in/top-up step: the button's job is
 * to name the product choice, and runSetupSwitch() sets the backend either way.
 * A bare "Add credits" beside "Connect Local" never said what the credits buy.
 */
function switchFix(chain: SetupChain, asBackup = false): SetupFix {
  const label = asBackup ? COPY.backend.switchLabelBackup : COPY.backend.switchLabel
  return { kind: SETUP_FIX_KIND.switch, label, chain }
}

/**
 * The row that saves the ten minutes.
 *
 * A failing own-AI backend gets TWO actions, and this is the one sanctioned
 * two-button case (§4.0 rule 3): "Connect Claude" vs "Use MightyMouse instead"
 * is a genuine product choice — different cost, different behavior. It is not
 * "brew vs npm", which is us asking the user to do our job.
 */
async function backendCheck(): Promise<SetupCheck> {
  const backend = PREFS.getBackend()
  const name = backendLabel(backend)
  const result = await probeBackend(backend)

  if (result.ok) {
    return {
      id: SETUP_CHECK_ID.backend,
      label: COPY.backend.label,
      status: SETUP_STATUS.ok,
      detail: `${name} · ${COPY.backend.ok}`
    }
  }

  // The managed backend is already the zero-install option, so it has no
  // "switch" escape — its own failures are sign-in or credits, and those are
  // the fix.
  if (backend === MANAGED_BACKEND) {
    const chain = await switchChain()
    return {
      id: SETUP_CHECK_ID.backend,
      label: COPY.backend.label,
      status: SETUP_STATUS.fail,
      detail: withName(
        chain === SETUP_CHAIN.signIn ? COPY.backend.notSignedIn : COPY.backend.noCredits,
        name
      ),
      // Not the escape hatch — you can't switch to the backend you're already
      // on, so this row's action IS the sign-in or the top-up, and the detail
      // line right above it already names the backend.
      fix: {
        kind: SETUP_FIX_KIND.switch,
        label:
          chain === SETUP_CHAIN.signIn ? COPY.backend.fixLabelSignIn : COPY.backend.fixLabelTopUp,
        chain: chain === SETUP_CHAIN.none ? SETUP_CHAIN.topUp : chain
      }
    }
  }

  const adapter = BACKENDS[backend]
  const install = adapter && 'install' in adapter ? adapter.install : undefined
  const chain = await switchChain()

  // A brew backend declares `install`, but three of its states are not something
  // a button can fix: no Homebrew to install WITH, an Intel Mac Rapid-MLX has no
  // bottle for, and an installed service with no chat-capable model pulled. Each
  // gets its own sentence and falls back to the escape hatch — a button that is
  // guaranteed to fail is a worse dead end than the one this replaces.
  const blocked =
    install && 'brew' in install && isLocalSetupBackend(backend)
      ? localSetupBlocker(backend)
      : undefined

  return {
    id: SETUP_CHECK_ID.backend,
    label: COPY.backend.label,
    status: SETUP_STATUS.fail,
    detail: blocked ?? withName(COPY.backend.notConnected, name),
    fix:
      install && !blocked
        ? {
            kind: SETUP_FIX_KIND.install,
            label: withName(COPY.backend.fixLabelConnect, name),
            alternate: switchFix(chain, true)
          }
        : // Nothing we can install for this backend (e.g. Gemini, whose Homebrew
          // formula is deprecated) — the escape hatch becomes the primary action
          // rather than leaving the user with a sentence and no button. Stands
          // alone, so it's "instead", not "as backup".
          switchFix(chain)
  }
}

/**
 * The user-facing reason a local backend can't be fixed by the button, or
 * undefined when it can.
 *
 * Mirrors the `reason` codes setUpLocalBackend() returns, checked BEFORE the run
 * rather than after, so the row never offers an action it already knows fails.
 */
function localSetupBlocker(backend: LocalSetupBackend): string | undefined {
  const copy = CONFIG.LOCAL_SETUP_COPY
  if (backend === 'mlx' && !mlxSupported()) return copy.unsupportedArch
  if (!isLocalServiceInstalled(backend)) {
    return resolveBrewBin() ? undefined : copy.noBrew
  }
  // Installed but stopped: startable, unless MLX has nothing chat-capable to serve.
  if (backend === 'mlx' && pulledMlxModels().length === 0) return copy.noModels
  return undefined
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Dev-only: force every row into its FAILING state.
 *
 * A developer whose machine works can never see the states this feature exists
 * for — the surface renders six green rows and tells them nothing. This shows
 * the screen a blocked first-run user actually gets, without breaking anything
 * on the machine. Buttons are live; only the probe is faked.
 *
 * Inert in production: the tray entry that sets it is IS_DEV-gated, and this
 * flag is re-checked against IS_DEV on every read.
 */
let previewBroken = false

export function setSetupPreviewBroken(on: boolean): void {
  previewBroken = on
}

export function isSetupPreviewBroken(): boolean {
  return IS_DEV && previewBroken
}

/** The all-broken screen, matching what a clean macOS account would produce. */
function brokenPreview(): SetupCheck[] {
  // Driven off the same PERMISSION_ROWS table as the real mapper, so a new
  // permission row can't appear in one and be forgotten in the other.
  const perms: SetupCheck[] = PERMISSION_ROWS.map(({ id, copy, required }) => ({
    id,
    label: copy.label,
    status: required ? SETUP_STATUS.fail : SETUP_STATUS.optional,
    detail: copy.fail,
    fix: { kind: SETUP_FIX_KIND.grant, label: copy.fixLabel }
  }))

  const name = backendLabel(PREFS.getBackend())
  return [
    ...perms,
    {
      id: SETUP_CHECK_ID.recording,
      label: COPY.recording.label,
      status: SETUP_STATUS.fail,
      detail: COPY.recording.fail,
      fix: { kind: SETUP_FIX_KIND.install, label: COPY.recording.fixLabel }
    },
    {
      id: SETUP_CHECK_ID.transcription,
      label: COPY.transcription.label,
      status: SETUP_STATUS.optional,
      detail: COPY.transcription.fail,
      fix: { kind: SETUP_FIX_KIND.install, label: COPY.transcription.fixLabel }
    },
    {
      id: SETUP_CHECK_ID.backend,
      label: COPY.backend.label,
      status: SETUP_STATUS.fail,
      detail: withName(COPY.backend.notConnected, name),
      // The two-button case — shows both the install route and the zero-install
      // escape hatch, which is the row that matters most to get right.
      fix: {
        kind: SETUP_FIX_KIND.install,
        label: withName(COPY.backend.fixLabelConnect, name),
        alternate: switchFix(SETUP_CHAIN.none, true)
      }
    }
  ]
}

/**
 * Download a binary we built, rather than `brew install ffmpeg` — brew is
 * absent on a normal user's Mac, where that path silently did nothing.
 * downloadManagedFfmpeg() clears the resolver cache on success itself.
 */
async function downloadFfmpeg(
  onProgress: (message: string, percent?: number) => void
): Promise<{ ok: boolean }> {
  const res = await downloadManagedFfmpeg((pct) => onProgress(COPY.recording.working, pct))
  // Fired here, not next to setup_fix_ran in the renderer: that event only
  // carries ok/fail, and WHY a download failed is what decides whether the
  // removed Homebrew path has to come back.
  track('binary_downloaded', {
    binary: 'ffmpeg',
    arch: process.arch,
    ok: res.ok,
    reason: downloadFailureReason(res.error)
  })
  // Surface WHY on failure. Dropping the error here left the row showing
  // its generic copy after a failed press, so the button could be tapped
  // forever with no new information (real user, 2026-09-02).
  if (!res.ok) onProgress(COPY.recording.failedRetry)
  // The stored path may still name the broken brew copy, which exists, so
  // neither withResolvedBinaries() nor ensureFfmpeg() would ever replace it.
  if (res.ok) SETTINGS.set({ ffmpegPath: res.path })
  return { ok: res.ok }
}

/** Probe everything, in parallel. Every failing row comes back with a fix. */
export async function buildSetupChecks(): Promise<SetupCheck[]> {
  if (isSetupPreviewBroken()) return brokenPreview()

  const [perms, binaries, backend] = await Promise.all([
    buildPermissionChecks(),
    getBinaryStatuses(),
    backendCheck()
  ])
  const micOk = perms.find((c) => c.key === 'microphone')?.test.ok ?? false
  return [...permissionChecks(perms), ...captureChecks(binaries, micOk), backend]
}

/**
 * Run the fix for one check, streaming plain-English progress.
 *
 * `onProgress` receives a USER-FACING line only. Tool output is deliberately
 * dropped on the floor here — it is exactly where the forbidden vocabulary
 * lives, and a user watching a progress bar doesn't need it.
 */
export async function runSetupFix(
  id: SetupCheckId,
  onProgress: (message: string, percent?: number) => void
): Promise<{ ok: boolean }> {
  onProgress(COPY.working)

  switch (id) {
    case SETUP_CHECK_ID.screen: {
      // Grant present + probe failing is the stale-TCC-cache state, and only a
      // relaunch clears it. Requesting again is a visible no-op: it re-opens the
      // System Settings pane the user is already looking at, which is exactly
      // how one user spent four minutes pressing Grant on a permission he had
      // already given us.
      if (await needsRestartForScreen()) {
        onProgress(COPY.screen.restarting)
        // Mark the restart as OURS before taking the app down. Without this the
        // next boot is indistinguishable from a cold launch, so a user who was
        // mid-onboarding came back to the wizard at step 1 with the Setup window
        // they were actually working in gone.
        PREFS.markSetupResume()
        app.relaunch()
        app.exit(0)
        return { ok: true }
      }
      await PERMISSIONS.request(id)
      return { ok: true }
    }

    case SETUP_CHECK_ID.accessibility: {
      await PERMISSIONS.request(id)
      return { ok: true }
    }

    case SETUP_CHECK_ID.microphone: {
      // The Voice probe fails on a crashing ffmpeg too. Granting the mic again
      // did nothing for that user (pressed twice, 2026-09-03) — the download is
      // the only action that changes anything.
      if ((await listAvDevices()).error) return downloadFfmpeg(onProgress)
      await PERMISSIONS.request(id)
      return { ok: true }
    }

    case SETUP_CHECK_ID.recording:
      return downloadFfmpeg(onProgress)

    case SETUP_CHECK_ID.transcription: {
      // Engine already on disk means the mic is the only thing missing, so ask
      // for that instead of re-fetching 148MB that was never the problem.
      if (parakeetReady() || whisperUsable()) {
        await PERMISSIONS.request(SETUP_CHECK_ID.microphone)
        return { ok: true }
      }
      // A covered language gets Parakeet instead of base.en: same one button,
      // 714MB rather than 148MB, and dictation comes back ~2.8x faster. A
      // failure here falls through to whisper below rather than dead-ending.
      if (parakeetWanted()) {
        const fast = await downloadManagedParakeet((pct) =>
          onProgress(COPY.transcription.working, pct)
        )
        track('binary_downloaded', {
          binary: 'nemo-speech',
          arch: process.arch,
          ok: fast.ok,
          reason: downloadFailureReason(fast.error)
        })
        if (fast.ok) {
          const model = await downloadWhisperModel(
            (pct) => onProgress(COPY.transcription.working, pct),
            CONFIG.PARAKEET_MODEL_NAME
          )
          track('binary_downloaded', {
            binary: 'parakeet-model',
            arch: process.arch,
            ok: model.ok,
            reason: downloadFailureReason(model.error)
          })
          if (model.ok) {
            clearBinaryCache()
            return { ok: true }
          }
        }
      }
      // Engine THEN model, both over plain HTTPS — `brew install whisper-cpp`
      // silently did nothing on a Mac with no Homebrew, and unlike the recording
      // row this one never even hid its button, so it could be pressed forever
      // with no new information.
      const engine = await downloadManagedWhisper((pct) =>
        onProgress(COPY.transcription.working, pct)
      )
      track('binary_downloaded', {
        binary: 'whisper-cli',
        arch: process.arch,
        ok: engine.ok,
        reason: downloadFailureReason(engine.error)
      })
      if (!engine.ok) {
        onProgress(COPY.transcription.failedRetry)
        return { ok: false }
      }
      // SETTINGS.get() is cached, so without this the freshly downloaded
      // engine stays invisible until the next launch -- same reason ffmpeg
      // stores its path above.
      SETTINGS.set({ whisperPath: engine.path })

      // The engine is ~3MB and the model ~148MB, so the model owns the visible
      // percentage. Skipped when the model is already on disk.
      //
      // getBinaryStatuses() reports the model from SETTINGS.whisperModelPath,
      // so download exactly that file — downloading whisperModelFor(lang)
      // instead would leave the row red after a download that "succeeded".
      const modelPath = SETTINGS.get().whisperModelPath
      if (!existsSync(modelPath)) {
        const got = await downloadWhisperModel(
          (pct) => onProgress(COPY.transcription.working, pct),
          basename(modelPath)
        )
        track('binary_downloaded', {
          binary: 'whisper-model',
          arch: process.arch,
          ok: got.ok,
          reason: downloadFailureReason(got.error)
        })
        if (!got.ok) {
          onProgress(COPY.transcription.failedRetry)
          return { ok: false }
        }
      }
      clearBinaryCache()
      return { ok: true }
    }

    case SETUP_CHECK_ID.backend: {
      const backend = PREFS.getBackend()
      const adapter = BACKENDS[backend]
      const install = adapter && 'install' in adapter ? adapter.install : undefined
      if (!install) return { ok: false }

      // A brew-installed backend is a SERVICE: installing it is only half the
      // job, so this route also starts it and waits for it to answer. The npm
      // route installs a CLI we spawn per run, which needs no start.
      if ('brew' in install) {
        if (!isLocalSetupBackend(backend)) return { ok: false }
        const res = await setUpLocalBackend(backend, (tick) =>
          onProgress(tick.message, tick.percent)
        )
        clearBinaryCache()
        return { ok: res.ok }
      }

      const res = await installCliPackage(install.npm, () => onProgress(COPY.workingSlow))
      return { ok: res.ok }
    }

    default:
      return { ok: false }
  }
}

/**
 * Take the zero-install escape hatch, walking whatever it needs first.
 *
 * Returns `pending: true` when the user has been sent somewhere (sign-in
 * window, top-up page) and the switch can't complete yet — the caller keeps
 * the row in its "in progress" state instead of falsely reporting success.
 */
export async function runSetupSwitch(): Promise<{ ok: boolean; pending?: boolean }> {
  const chain = await switchChain()

  if (chain === SETUP_CHAIN.signIn) {
    const { showAuthWindow } = await import('./auth-window')
    showAuthWindow()
    return { ok: false, pending: true }
  }

  // Switching costs nothing and an empty balance only bites at the first call,
  // so the provider is set BEFORE billing opens. Gating the switch on credits
  // sent a user who tapped it to the billing window with their backend
  // unchanged — the escape hatch silently doing nothing.
  PREFS.setBackend(MANAGED_BACKEND)

  if (chain === SETUP_CHAIN.topUp) {
    // Credits are bought through a Stripe checkout the billing window owns —
    // there is no static URL to open.
    const { showBillingWindow } = await import('./billing-window')
    showBillingWindow()
  }

  return { ok: true }
}

/** Broadcast fresh checks to any window showing the setup surface. */
export function broadcastSetupChecks(channel: string, checks: SetupCheck[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, checks)
  }
}
