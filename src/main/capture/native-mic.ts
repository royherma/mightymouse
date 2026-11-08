// native-mic.ts — EXPERIMENTAL CoreAudio mic wrapper for listen/transcribe.
//
// Why: a RESIDENT AVAudioEngine restarts in ~180 ms to first buffer, vs
// 640–1250 ms for a process spawned per press (and ~600–850 ms for ffmpeg
// -f avfoundation). Measured 2026-08-29 — see the listen-drops-first-word PRD.
//
// Gated behind PREFS.getUseNativeMic() — default OFF. Enable by writing '1'
// to ~/MightyMouse/use-native-mic.txt (or calling PREFS.setUseNativeMic(true)).
//
// The binary (native/mic-recorder/mic-recorder) must be built first:
//   cd native/mic-recorder && bash build.sh
//
// Packaging: electron-builder's `extraResources` ships all of native/** into
// Contents/Resources, signed with the hardened runtime. This binary is gitignored,
// so a machine that never ran build.sh packages an app without it — the feature
// then silently falls back, since it's off by default behind getUseNativeMic().

import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import { helpers } from '../platform'

// Binary name + its directory under the repo / app resources. Constants so the
// path layout lives in one place and never a bare literal.
const MIC_RECORDER_BIN = 'mic-recorder'

// Resolve the binary path at runtime.
//   Dev:  <repo-root>/native/mic-recorder/mic-recorder  (pre-built via build.sh)
//   Prod: <app-resources>/native/mic-recorder/mic-recorder  (TODO: packaging)
function resolveBinaryPath(): string {
  // null only where the OS ships no helper; '' then fails the existsSync guard like a missing binary.
  return helpers.resolve(MIC_RECORDER_BIN) ?? ''
}

// One resident helper for the app's lifetime. The engine inside it is built +
// prepare()d once; each press is only the HAL start (~180 ms to first buffer,
// vs 640-1250 ms when a process was spawned per press).
let daemon: ChildProcess | null = null
let daemonSpawnedAt = 0
let stdoutBuf = ''
/** Whether a `start` is in flight — mirrors the helper's own session state. */
let listening = false
/** Resolver for the single reply we're waiting on (READY / STOPPED / CANCELLED). */
let pending: { token: string; resolve: () => void; reject: (e: Error) => void } | null = null

// Give up respawning when the helper dies this quickly after launch — that's
// a broken binary or a denied mic, not a transient crash.
const RESPAWN_MIN_UPTIME_MS = 2000
const READY_TIMEOUT_MS = 5000
const STOP_TIMEOUT_MS = 8000

function onLine(line: string): void {
  if (!pending) return
  if (line.startsWith(pending.token)) {
    const p = pending
    pending = null
    p.resolve()
  } else if (line.startsWith('ERROR')) {
    const p = pending
    pending = null
    p.reject(new Error(`native-mic: helper replied "${line}"`))
  }
}

/**
 * Spawn the resident helper if it isn't running. Safe to call repeatedly;
 * called at app boot and again on every start (covers a pref toggled at runtime
 * and a helper that died). Returns false when the binary is missing.
 */
export function ensureNativeMicDaemon(): boolean {
  if (daemon) return true
  const bin = resolveBinaryPath()
  if (!existsSync(bin)) return false

  const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  daemon = proc
  daemonSpawnedAt = Date.now()
  stdoutBuf = ''

  proc.on('error', (err) => console.error('[native-mic] helper spawn error:', err.message))
  proc.stdin?.on('error', (err) => console.error('[native-mic] helper stdin closed:', err.message))
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString()
    let nl: number
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      onLine(stdoutBuf.slice(0, nl))
      stdoutBuf = stdoutBuf.slice(nl + 1)
    }
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    console.error('[native-mic] stderr:', chunk.toString().trim())
  })
  proc.once('close', (code) => {
    const uptime = Date.now() - daemonSpawnedAt
    daemon = null
    listening = false
    if (pending) {
      const p = pending
      pending = null
      p.reject(new Error(`native-mic: helper exited (code ${code})`))
    }
    if (uptime < RESPAWN_MIN_UPTIME_MS) {
      console.error(`[native-mic] helper exited after ${uptime} ms — not respawning`)
      return
    }
    console.warn(`[native-mic] helper exited (code ${code}) — respawning`)
    setTimeout(() => ensureNativeMicDaemon(), 1000)
  })
  return true
}

function send(cmd: string, token: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!daemon?.stdin?.writable) {
      reject(new Error('native-mic: helper not running'))
      return
    }
    if (pending) {
      reject(new Error('native-mic: another command is in flight'))
      return
    }
    const timer = setTimeout(() => {
      if (pending?.token !== token) return
      pending = null
      // A stuck helper is worse than a cold one — kill it; `close` respawns.
      daemon?.kill('SIGKILL')
      reject(new Error(`native-mic: no ${token} within ${timeoutMs} ms`))
    }, timeoutMs)
    pending = {
      token,
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    }
    daemon.stdin.write(cmd + '\n')
  })
}

/**
 * Start native mic capture, writing 16kHz mono PCM WAV to wavPath.
 * Resolves once the engine is running (helper prints "READY").
 * Rejects if the helper is missing or fails to start — caller falls back to ffmpeg.
 */
export async function startNativeListen(wavPath: string): Promise<void> {
  if (listening) throw new Error('native-mic: already listening')
  if (!ensureNativeMicDaemon()) {
    throw new Error(
      `native-mic: binary not found at ${resolveBinaryPath()}. Run: cd native/mic-recorder && bash build.sh`
    )
  }
  const t0 = Date.now()
  await send(`start ${wavPath}`, 'READY', READY_TIMEOUT_MS)
  listening = true
  console.log(`[native-mic] READY in ${Date.now() - t0} ms`)
}

/**
 * Stop native mic capture. Resolves once the helper has flushed and finalized
 * the WAV header — same contract as the ffmpeg path.
 */
export async function stopNativeListen(): Promise<void> {
  if (!listening) return
  listening = false
  try {
    await send('stop', 'STOPPED', STOP_TIMEOUT_MS)
  } catch (err) {
    console.error('[native-mic] stop failed:', err)
  }
}

/**
 * Cancel native mic capture and discard. No flush, no header finalize, since
 * the caller is about to delete the WAV. Fire-and-forget.
 */
export function cancelNativeListen(): void {
  if (!listening) return
  listening = false
  send('cancel', 'CANCELLED', STOP_TIMEOUT_MS).catch((err) =>
    console.error('[native-mic] cancel failed:', err)
  )
}

/** True when native mic capture is active. */
export function isNativeListening(): boolean {
  return listening
}
