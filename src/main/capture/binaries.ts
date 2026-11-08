import { execFile, spawn } from 'child_process'
import {
  existsSync,
  statSync,
  createWriteStream,
  mkdirSync,
  renameSync,
  unlinkSync,
  statfsSync
} from 'fs'
import { dirname, join } from 'path'
import { get } from 'https'
import { SETTINGS } from '../store/settings'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import { BinaryStatus } from '../../shared/types'
import { resolveNpm, resolveBrewBin, npmPrefixWritable, clearBinaryCache } from '../platform'
import { hasManagedParakeet } from './download-binaries'

function version(bin: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!existsSync(bin)) return resolve(undefined)
    execFile(bin, args, { timeout: 4000 }, (err, stdout, stderr) => {
      if (err) return resolve(undefined)
      // First NON-EMPTY line: whisper-cli opens its usage block with a
      // newline, so line[0] is '' and a live binary read as dead.
      const line = (stdout || stderr || '')
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean)
      resolve(line || undefined)
    })
  })
}

export function humanSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb.toFixed(0)} MB`
}

export async function getBinaryStatuses(): Promise<BinaryStatus[]> {
  const s = SETTINGS.get()

  const ffmpegFound = existsSync(s.ffmpegPath)
  const whisperFound = existsSync(s.whisperPath)
  const modelPath = englishWhisperModelPath()
  const modelFound = existsSync(modelPath)

  const [ffmpegVer, whisperVer] = await Promise.all([
    ffmpegFound ? version(s.ffmpegPath, ['-version']) : Promise.resolve(undefined),
    // whisper-cli prints usage/version to stderr; --help is safest
    whisperFound ? version(s.whisperPath, ['--help']) : Promise.resolve(undefined)
  ])

  let modelDetail: string | undefined
  if (modelFound) {
    try {
      modelDetail = humanSize(statSync(modelPath).size)
    } catch {
      modelDetail = undefined
    }
  }

  const parakeetModelPath = whisperModelPathFor(CONFIG.PARAKEET_MODEL_NAME)
  const parakeetModelFound = existsSync(parakeetModelPath)
  let parakeetDetail: string | undefined
  if (parakeetModelFound) {
    try {
      parakeetDetail = humanSize(statSync(parakeetModelPath).size)
    } catch (err) {
      console.error('[binaries] could not size the parakeet model:', err)
    }
  }

  return [
    {
      key: 'ffmpeg',
      label: 'ffmpeg',
      path: s.ffmpegPath,
      // A brew ffmpeg with a stranded dylib exists on disk and dies in dyld;
      // `existsSync` alone read it as installed and hid the download button.
      found: ffmpegFound && ffmpegVer !== undefined,
      detail: ffmpegVer
    },
    {
      key: 'whisper',
      label: 'whisper-cli',
      path: s.whisperPath,
      found: whisperFound && whisperVer !== undefined,
      detail: whisperVer ? 'installed' : undefined
    },
    {
      key: 'whisperModel',
      label: 'Whisper model',
      path: modelPath,
      found: modelFound,
      detail: modelDetail
    },
    // One row, not two: the engine and its model are separate downloads but a
    // user has no use for that distinction — either fast transcription is here
    // or it isn't. Ready needs BOTH, so a half-download never reads as installed.
    {
      key: 'parakeet',
      label: 'Fast transcription',
      path: parakeetModelPath,
      found: hasManagedParakeet() && parakeetModelFound,
      detail: parakeetDetail
    }
  ]
}

/**
 * The model a language needs. English keeps the small fast `.en` build; every
 * other language requires the multilingual one, because `.en` builds physically
 * cannot decode another language — they return English-shaped nonsense instead
 * of an error.
 */
export function whisperModelFor(lang: string): string {
  return lang === 'en' ? CONFIG.WHISPER_MODEL_DEFAULT_NAME : CONFIG.WHISPER_MODEL_MULTILINGUAL_NAME
}

/**
 * Rough download sizes, used only to warn before starting. Real size comes from
 * content-length; these exist so we can refuse a doomed 1.6GB download up front
 * rather than fail 90% in on a full disk.
 */
const WHISPER_MODEL_BYTES: Record<string, number> = {
  'ggml-base.en.bin': 148 * 1024 * 1024,
  'ggml-large-v3-turbo.bin': 1_624_555_275,
  [CONFIG.PARAKEET_MODEL_NAME]: CONFIG.PARAKEET_MODEL_BYTES
}

/** Free bytes on the volume holding `path`, or null if it can't be read. */
function freeBytesFor(path: string): number | null {
  try {
    const fsStat = statfsSync(path)
    return fsStat.bavail * fsStat.bsize
  } catch {
    return null
  }
}

/**
 * Whether there is room for a model, plus the numbers to show the user.
 * Headroom of 1GB on top of the file: macOS behaves badly at zero free space,
 * and the `.part` file means the download briefly needs its own full size.
 */
export function checkWhisperModelSpace(modelName: string): {
  ok: boolean
  needBytes: number
  freeBytes: number | null
} {
  const needBytes = WHISPER_MODEL_BYTES[modelName] ?? 0
  const freeBytes = freeBytesFor(PATHS.WHISPER_CACHE_DIR) ?? freeBytesFor(PATHS.ROOT)
  // Unreadable free space is not a reason to block the user — let it proceed
  // and fail loudly later rather than refusing on a number we never got.
  if (freeBytes === null) return { ok: true, needBytes, freeBytes: null }
  return { ok: freeBytes > needBytes + 1024 * 1024 * 1024, needBytes, freeBytes }
}

/**
 * Resolve the on-disk path for a model file name. Every model lives in the same
 * whisper cache dir, so the file name is the cache key and two models coexist —
 * the English one is never overwritten by a multilingual download.
 */
export function whisperModelPathFor(modelName: string): string {
  return join(PATHS.WHISPER_CACHE_DIR, modelName)
}

export function englishWhisperModelPath(): string {
  const preferred = SETTINGS.get().whisperModelPath
  const quick = whisperModelPathFor(CONFIG.WHISPER_QUICK_MODEL_NAME)
  return !existsSync(preferred) && existsSync(quick) ? quick : preferred
}

export function whisperUsable(): boolean {
  return existsSync(SETTINGS.get().whisperPath) && existsSync(englishWhisperModelPath())
}

/**
 * Download a whisper model by file name, defaulting to base.en.
 *
 * Writes to `<dest>.part` and renames only after the byte count matches
 * content-length. A download that dies midway therefore leaves the previous
 * working model untouched instead of parking a truncated file at the path the
 * app trusts — which reads to the user as "dictation is broken". At 148MB this
 * never bit; at 1.6GB a mid-download failure is the common case.
 */
export function downloadWhisperModel(
  onProgress?: (pct: number) => void,
  modelName: string = CONFIG.WHISPER_MODEL_DEFAULT_NAME
): Promise<{ ok: boolean; path: string; error?: string }> {
  const url = CONFIG.WHISPER_MODELS[modelName]
  const dest = whisperModelPathFor(modelName)
  const partPath = `${dest}.part`

  return new Promise((resolve) => {
    if (!url) {
      return resolve({ ok: false, path: dest, error: `unknown whisper model ${modelName}` })
    }
    const space = checkWhisperModelSpace(modelName)
    if (!space.ok && space.freeBytes !== null) {
      return resolve({
        ok: false,
        path: dest,
        error: `Not enough space. This needs ${humanSize(space.needBytes)} and you have ${humanSize(space.freeBytes)} free.`
      })
    }
    try {
      mkdirSync(dirname(dest), { recursive: true })
    } catch {
      // Already there, or unwritable — createWriteStream below reports either.
    }

    const failed = (error: string): void => {
      try {
        unlinkSync(partPath)
      } catch {
        // Nothing written yet, or already gone. The download failed either way.
      }
      resolve({ ok: false, path: dest, error })
    }

    const file = createWriteStream(partPath)
    const req = (target: string): void => {
      get(target, (res) => {
        // Follow HF redirect to the CDN.
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location
          if (loc) {
            res.resume()
            return req(loc)
          }
        }
        if (res.statusCode !== 200) {
          file.close()
          return failed(`HTTP ${res.statusCode}`)
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let received = 0
        res.on('data', (chunk) => {
          received += chunk.length
          if (total && onProgress) onProgress(Math.round((received / total) * 100))
        })
        res.pipe(file)
        file.on('finish', () =>
          file.close(() => {
            // A truncated body is the failure that matters: the stream ends
            // clean, so only the byte count catches it before the rename.
            if (total && received !== total) {
              return failed(`incomplete download (${received} of ${total} bytes)`)
            }
            try {
              renameSync(partPath, dest)
            } catch (err) {
              return failed(`could not save model: ${(err as Error).message}`)
            }
            resolve({ ok: true, path: dest })
          })
        )
      }).on('error', (err) => {
        file.close()
        failed(err.message)
      })
    }
    req(url)
  })
}

/** Absolute brew path (Apple Silicon first, then Intel), or null if not installed. */
function resolveBrew(): string | null {
  const { appleSilicon, intel } = CONFIG.BREW_PATH
  return [appleSilicon, intel].find((p) => existsSync(p)) ?? null
}

/** True when Homebrew is present — lets the UI offer install vs. explain why it can't. */
export function hasHomebrew(): boolean {
  return resolveBrew() !== null
}

/**
 * Install a Homebrew formula, streaming brew's stdout/stderr to `onOutput` so the
 * UI can show live progress instead of a button frozen for minutes. ffmpeg pulls
 * ~70 dependencies and routinely outruns a short timeout, hence the per-call
 * `timeoutMs` — whisper-cpp is much smaller and keeps the original ceiling.
 */
function installViaBrew(
  formula: string,
  timeoutMs: number,
  onOutput?: (line: string) => void
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const brew = resolveBrew()
    if (!brew) {
      return resolve({ ok: false, output: CONFIG.CAPTURE_ERROR.brewMissing })
    }
    const proc = spawn(brew, ['install', formula], {
      timeout: timeoutMs,
      // Non-interactive: brew must never sit waiting on a prompt nobody can see.
      env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1' }
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString()
      output += text
      // Brew's progress lines are the only signal we have; forward the last
      // non-empty one so the UI can show what it's actually doing right now.
      const line = text
        .split('\n')
        .filter((l) => l.trim())
        .pop()
      if (line && onOutput) onOutput(line.trim())
    }
    proc.stdout?.on('data', collect)
    proc.stderr?.on('data', collect)
    proc.on('error', (err) => resolve({ ok: false, output: `${output}\n${err.message}` }))
    proc.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

/** Try to install whisper-cpp via Homebrew. Returns combined output. */
export function installWhisperViaBrew(
  onOutput?: (line: string) => void
): Promise<{ ok: boolean; output: string }> {
  return installViaBrew('whisper-cpp', CONFIG.BREW_INSTALL_TIMEOUT_MS, onOutput)
}

/**
 * Try to install ffmpeg via Homebrew. Recording is dead without it, so this is
 * the one-click path behind the "Can't find ffmpeg" error — the first external
 * tester hit that error with no way to act on it.
 */
export function installFfmpegViaBrew(
  onOutput?: (line: string) => void
): Promise<{ ok: boolean; output: string }> {
  return installViaBrew('ffmpeg', CONFIG.BREW_INSTALL_TIMEOUT_FFMPEG_MS, onOutput)
}

/**
 * Install a global npm package, streaming output the same way installViaBrew
 * does so the row can show live progress instead of a frozen button.
 *
 * SECURITY: spawn (not shell), so `pkg` is never interpolated into a shell
 * string. The name is additionally validated against NPM_PKG_RE by the caller.
 * Package names are ours, from a const — never user input.
 *
 * `--no-fund --no-audit` keeps npm's trailing noise out of the progress line;
 * the last non-empty line is all the UI shows.
 */
function installViaNpm(
  npmPath: string,
  pkg: string,
  onOutput?: (line: string) => void
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(npmPath, ['install', '-g', pkg, '--no-fund', '--no-audit'], {
      timeout: CONFIG.NPM_INSTALL_TIMEOUT_MS,
      env: { ...process.env, npm_config_yes: 'true' }
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString()
      output += text
      const line = text
        .split('\n')
        .filter((l) => l.trim())
        .pop()
      if (line && onOutput) onOutput(line.trim())
    }
    proc.stdout?.on('data', collect)
    proc.stderr?.on('data', collect)
    proc.on('error', (err) => resolve({ ok: false, output: `${output}\n${err.message}` }))
    proc.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

/** Guards the package name before it ever reaches spawn. Scoped names allowed. */
const NPM_PKG_RE = /^[@a-z0-9._/-]+$/

/**
 * Install a CLI package, obtaining Node FIRST if we can't already write to a
 * global npm prefix.
 *
 * This is the whole "opaque, one click" promise in one function:
 * the caller asks for a CLI, and whatever has to happen underneath — installing
 * Node via Homebrew because the user has no Node, or because their Node's
 * prefix needs sudo — happens silently under the SAME button and the SAME
 * progress line. The user never learns the words npm, Node, or Homebrew.
 *
 * Returns a machine-readable `reason` on failure so the caller can pick the
 * right user-facing copy without parsing tool output.
 */
export async function installCliPackage(
  pkg: string,
  onOutput?: (line: string) => void
): Promise<{ ok: boolean; output: string; reason?: 'bad-package' | 'no-route' }> {
  if (!NPM_PKG_RE.test(pkg)) return { ok: false, output: '', reason: 'bad-package' }

  let npmPath = resolveNpm()

  // No npm, or an npm whose global prefix needs sudo (nodejs.org .pkg installs
  // land in /usr/local). Either way the answer is the same: get a Node we can
  // actually write to. We never ask for a password — see the ffmpeg design.
  if (!npmPath || !npmPrefixWritable(npmPath)) {
    if (!resolveBrewBin()) return { ok: false, output: '', reason: 'no-route' }
    const node = await installViaBrew('node', CONFIG.BREW_INSTALL_TIMEOUT_MS, onOutput)
    if (!node.ok) return { ok: false, output: node.output, reason: 'no-route' }
    clearBinaryCache()
    npmPath = resolveNpm()
    if (!npmPath) return { ok: false, output: node.output, reason: 'no-route' }
  }

  const res = await installViaNpm(npmPath, pkg, onOutput)
  // A freshly installed CLI is invisible until the memoized "not found" is
  // dropped — the same stale-resolution bug ensureFfmpeg() fixes for ffmpeg.
  // Without this the user installs successfully and still sees "not connected".
  clearBinaryCache()
  return res
}
