// local-setup.ts — get a local backend from "nothing installed" to "service
// answering" without the user opening a terminal.
//
// The `local` (Ollama) and `mlx` (Rapid-MLX) backends are HTTP services, not
// CLIs we spawn per run, so they fall outside installCliPackage's npm route.
// Both ship as Homebrew formulae, which is the one install path we already have.
//
// The two are NOT symmetric, and that asymmetry shapes this whole file:
//   Ollama    — `ollama serve` needs no model; the daemon is useful empty.
//   Rapid-MLX — `rapid-mlx serve <alias>` REQUIRES a model alias, so it can only
//               be started once the user has pulled something. We never pull or
//               pick a model for them; we serve one they already own.
import { spawn } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CONFIG } from '../../shared/config'
import type { LocalSetupProgress } from '../../shared/types'
import { resolveBrewBin, clearBinaryCache } from '../platform'
import { isOllamaRunning } from './local-models'
import { isMlxRunning } from './mlx-models'

export type LocalSetupBackend = 'local' | 'mlx'

/** Why a setup run couldn't finish, so the caller picks copy without parsing output. */
export type LocalSetupReason =
  | 'no-brew'
  | 'install-failed'
  | 'no-models'
  | 'start-failed'
  | 'unsupported-arch'

export interface LocalSetupResult {
  ok: boolean
  reason?: LocalSetupReason
  /** The alias we started Rapid-MLX with, so the UI can preselect it. */
  startedModel?: string
}

export type LocalSetupPhase = 'installing' | 'starting'

export type LocalSetupTick = Omit<LocalSetupProgress, 'backend'>

/**
 * Drives the progress bar for one phase.
 *
 * Neither brew nor `rapid-mlx serve` emits a parsable percentage — brew prints
 * ephemeral download bars to a TTY we don't have, and Metal shader compilation is
 * silent. So the bar is elapsed/expected, eased so it decelerates instead of
 * stalling at a hard 95%: an honest "still working, roughly this far" rather than
 * a fake precise number. The phase completing is what snaps it to its full share.
 */
function startTicker(
  phase: LocalSetupPhase,
  base: number,
  onTick: (tick: LocalSetupTick) => void
): () => void {
  const started = Date.now()
  const share = CONFIG.LOCAL_SETUP_PHASE_WEIGHT[phase]
  const expected = CONFIG.LOCAL_SETUP_EXPECTED_MS[phase]
  const copy = CONFIG.LOCAL_SETUP_COPY

  const emit = (): void => {
    const elapsedMs = Date.now() - started
    // 1 - e^-x approaches its ceiling without ever reaching it, so an overrun
    // keeps creeping instead of freezing — the tell that it's alive, not hung.
    const eased = 1 - Math.exp(-elapsedMs / expected)
    const percent = (base + share * eased * CONFIG.LOCAL_SETUP_PHASE_CEILING) * 100
    const slow = elapsedMs > CONFIG.LOCAL_SETUP_SLOW_AFTER_MS
    const message =
      phase === 'installing'
        ? slow
          ? copy.installingSlow
          : copy.installing
        : slow
          ? copy.startingSlow
          : copy.starting
    onTick({ phase, message, percent: Math.round(percent), elapsedMs })
  }

  emit()
  const timer = setInterval(emit, CONFIG.LOCAL_SETUP_TICK_MS)
  return () => clearInterval(timer)
}

const SERVICE = {
  local: { formula: 'ollama', bin: 'ollama', isRunning: isOllamaRunning },
  mlx: { formula: 'rapid-mlx', bin: 'rapid-mlx', isRunning: isMlxRunning }
} as const

/** Absolute path to a Homebrew-installed binary, or null. resolveBrewBin() gives
 *  the brew executable itself, so the sibling bin dir is its parent. */
function resolveServiceBin(bin: string): string | null {
  const brew = resolveBrewBin()
  if (!brew) return null
  const path = join(dirname(brew), bin)
  return existsSync(path) ? path : null
}

export function isLocalServiceInstalled(backend: LocalSetupBackend): boolean {
  return resolveServiceBin(SERVICE[backend].bin) !== null
}

/**
 * Can this cached model hold a conversation?
 *
 * The tell is `chat_template` in tokenizer_config.json: it's the thing that turns
 * messages into a prompt, so a model without one cannot serve /v1/chat/completions
 * no matter how happily `serve` boots. Embedding models (embeddinggemma-300m-6bit
 * and friends) have none — serving one turns the status dot green and then fails
 * every single run, which is exactly what shipped before this check existed.
 */
function isChatCapable(repoDir: string): boolean {
  const snapshots = join(repoDir, 'snapshots')
  try {
    for (const snap of readdirSync(snapshots)) {
      const config = join(snapshots, snap, 'tokenizer_config.json')
      if (!existsSync(config)) continue
      const parsed = JSON.parse(readFileSync(config, 'utf8'))
      if (typeof parsed.chat_template === 'string' && parsed.chat_template.length > 0) return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * Chat-capable aliases the user has already pulled, read from the HuggingFace
 * cache rather than `rapid-mlx ls`.
 *
 * `ls` renders a box-drawn table with no --json flag, so its column widths shift
 * with the longest alias. The cache dir encodes the same data structurally:
 * `models--mlx-community--qwen3-0.6b-4bit` → `qwen3-0.6b-4bit`, which is exactly
 * what `serve` takes. Verified against rapid-mlx 0.11.4.
 */
export function pulledMlxModels(): string[] {
  const dir = join(homedir(), '.cache', 'huggingface', 'hub')
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith('models--'))
      .filter((name) => isChatCapable(join(dir, name)))
      .map((name) => name.split('--').pop() ?? '')
      .filter((alias) => alias !== '')
      .sort()
  } catch {
    return []
  }
}

/** Rapid-MLX is Apple-Silicon only — the formula is arm64-bottle + macOS Sonoma. */
export function mlxSupported(): boolean {
  return process.arch === 'arm64'
}

function installViaBrew(formula: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const brew = resolveBrewBin()
    if (!brew) return resolve({ ok: false, output: '' })

    const proc = spawn(brew, ['install', formula], {
      timeout: CONFIG.BREW_INSTALL_TIMEOUT_LOCAL_MS,
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' }
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output += chunk.toString()
    }
    proc.stdout?.on('data', collect)
    proc.stderr?.on('data', collect)
    proc.on('error', (err) => resolve({ ok: false, output: `${output}\n${err.message}` }))
    proc.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

/**
 * Spawn the service detached, so it outlives MightyMouse.
 *
 * Both of these are daemons the user would otherwise run in their own terminal
 * and leave running. Tying their lifetime to ours would kill the backend on
 * quit and silently break the next launch — worse than not starting it at all.
 */
function spawnDetached(bin: string, args: string[]): void {
  const proc = spawn(bin, args, { detached: true, stdio: 'ignore' })
  proc.on('error', (err) => console.error('[local-setup] service failed to start:', err.message))
  proc.unref()
}

/** Poll until the service answers, or give up. Rapid-MLX compiles Metal shaders
 *  on first boot (~24s measured), so the ceiling is generous. */
async function waitUntilRunning(isRunning: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + CONFIG.LOCAL_SERVICE_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isRunning()) return true
    await new Promise((r) => setTimeout(r, CONFIG.LOCAL_SERVICE_POLL_MS))
  }
  return false
}

/**
 * Install (if needed) and start a local backend's service.
 *
 * `onProgress` fires on a timer for as long as a phase runs, so the UI can show a
 * moving bar. Brew's raw output never reaches it: it's noise to everyone but us,
 * and a half-rendered download bar is worse than a steady percentage.
 */
export async function setUpLocalBackend(
  backend: LocalSetupBackend,
  onProgress: (tick: LocalSetupTick) => void
): Promise<LocalSetupResult> {
  const svc = SERVICE[backend]

  if (backend === 'mlx' && !mlxSupported()) {
    return { ok: false, reason: 'unsupported-arch' }
  }

  if (await svc.isRunning()) return { ok: true }

  // An already-installed service skips straight to start, so start owns the whole
  // bar rather than beginning at the halfway mark it never earned.
  const needsInstall = !isLocalServiceInstalled(backend)
  const startBase = needsInstall ? CONFIG.LOCAL_SETUP_PHASE_WEIGHT.installing : 0

  if (needsInstall) {
    if (!resolveBrewBin()) return { ok: false, reason: 'no-brew' }
    const stop = startTicker('installing', 0, onProgress)
    const res = await installViaBrew(svc.formula).finally(stop)
    if (!res.ok) return { ok: false, reason: 'install-failed' }
    // A freshly installed binary is invisible behind the memoized "not found".
    clearBinaryCache()
  }

  const bin = resolveServiceBin(svc.bin)
  if (!bin) return { ok: false, reason: 'install-failed' }

  // Rapid-MLX can't serve without an alias, and picking one for the user would
  // mean downloading gigabytes they didn't ask for. Serve what they already have.
  let startedModel: string | undefined
  if (backend === 'mlx') {
    const pulled = pulledMlxModels()
    if (pulled.length === 0) return { ok: false, reason: 'no-models' }
    startedModel = pulled[0]
  }

  const stop = startTicker('starting', startBase, onProgress)
  try {
    spawnDetached(bin, startedModel ? ['serve', startedModel] : ['serve'])
    const running = await waitUntilRunning(svc.isRunning)
    return running ? { ok: true, startedModel } : { ok: false, reason: 'start-failed' }
  } finally {
    stop()
  }
}
