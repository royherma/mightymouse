import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { PATHS } from '../store/paths'

/**
 * Resolve the Kokoro TTS runtime AT SPEAK TIME, re-checking the filesystem rather
 * than trusting a path cached when settings were first loaded.
 *
 * This is `ensureFfmpeg()`'s lesson verbatim (see capture/ensure-ffmpeg.ts): state
 * read once at load and never re-read is exactly what made the first external
 * tester restart the app repeatedly after installing a tool mid-session. A user who
 * taps "Install voice" must get the voice on the very next turn, not after a quit.
 *
 * Two candidate homes, in priority order:
 *   1. PATHS.MODELS/kokoro/bin — the managed payload we will ship (not built yet;
 *      Gate 0 in the PRD gates it on Gatekeeper/notarization evidence).
 *   2. ~/.local/bin — a `uv tool install mlx-audio` the user already has. This is
 *      the DEV path: it makes the rung reachable on a machine with the benchmark
 *      install, so the voice can be A/B'd before the payload work is paid for.
 *
 * Returns null when neither exists, which is the normal case for every shipped
 * user today — the ladder then falls through to `say` exactly as it does on main.
 */

/** The mlx-audio CLI entry point that synthesizes a WAV from text. */
const KOKORO_CLI = 'mlx_audio.tts.generate'

/**
 * Root of the managed payload — a self-contained venv installed by
 * downloadManagedKokoro(). Short on purpose: espeak-ng truncates a long data path
 * and then falls back to the path baked in at ITS build time, aborting the process
 * with no Python traceback. Keep this shallow.
 */
export function kokoroRoot(): string {
  return join(PATHS.MODELS, 'kokoro')
}

/**
 * Managed payload CLI. `uv venv --relocatable` writes this as a /bin/sh shim that
 * resolves its own directory, so it keeps working wherever the payload is unpacked.
 */
const MANAGED_CLI = join(PATHS.MODELS, 'kokoro', 'bin', KOKORO_CLI)

/** A pre-existing `uv tool install mlx-audio`. Dev/power-user path only. */
const USER_LOCAL_CLI = join(homedir(), '.local', 'bin', KOKORO_CLI)

/**
 * @returns absolute path to the Kokoro CLI, or null if it isn't installed.
 */
export function ensureKokoro(): string | null {
  if (existsSync(MANAGED_CLI)) return MANAGED_CLI
  if (existsSync(USER_LOCAL_CLI)) return USER_LOCAL_CLI
  return null
}

/**
 * The Python interpreter inside Kokoro's venv, read off the CLI shim's shebang.
 *
 * Needed because the word-timestamp path (resources/kokoro-speak.py) imports
 * KokoroPipeline directly instead of running the CLI — the CLI computes the
 * per-word alignment and then discards it. Running that script requires the venv's
 * own interpreter; the system python3 has none of the deps.
 *
 * Derived from the shebang rather than assumed at `<root>/bin/python3` so it holds
 * for BOTH homes ensureKokoro() resolves — the managed payload and a user's
 * `uv tool install` — each of which points at its own venv.
 *
 * @returns absolute interpreter path, or null if it can't be read.
 */
export function kokoroPython(): string | null {
  const cli = ensureKokoro()
  if (!cli) return null
  try {
    const shebang = readFileSync(cli, 'utf8').split('\n', 1)[0]
    if (!shebang.startsWith('#!')) return null
    const interpreter = shebang.slice(2).trim()
    return existsSync(interpreter) ? interpreter : null
  } catch {
    return null
  }
}

/**
 * True only where Kokoro can actually run: MLX is Metal-backed, so Apple Silicon
 * only. Intel Macs and every other platform keep today's ladder untouched, and the
 * install button never renders for them.
 */
export function isKokoroSupportedPlatform(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64'
}

/** Installed AND on a machine that can run it — the full availability check. */
export function isKokoroAvailable(): boolean {
  return isKokoroSupportedPlatform() && ensureKokoro() !== null
}
