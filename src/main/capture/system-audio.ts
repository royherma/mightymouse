// system-audio.ts — spawn/lifecycle wrapper for the native ScreenCaptureKit
// system-audio helper (native/system-audio/SystemAudio.swift).
//
// Why native: Electron/Chromium only implements getDisplayMedia system-audio
// capture on Windows and ChromeOS. On macOS `audio: true` yields no track, so
// the phone-remote mirror captures audio through SCK instead and injects it
// into the existing peer connection. See
//
// Permission: rides the SAME Screen Recording grant the video mirror holds —
// verified live, no new TCC prompt.
//
// Protocol (mirrors native-mic.ts's shape):
//   stdout — "READY\n" then RAW float32 interleaved PCM bytes forever.
//   stderr — diagnostics only.
//   SIGINT — stop.
// The READY line and the first PCM bytes can arrive in the SAME chunk, so the
// split below is byte-exact rather than line-buffered; treating the tail as a
// log line would silently eat the first audio frames.

import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import { devLog } from '../../shared/env'
import { helpers } from '../platform'

const SYSTEM_AUDIO_BIN = 'system-audio'

/** Helper's exit code for "this Mac is too old for SCK audio" (macOS < 13),
 *  as distinct from a generic failure — lets the UI say "not supported"
 *  instead of showing a toggle that silently does nothing. */
const EXIT_UNSUPPORTED = 2

const READY_MARKER = Buffer.from('READY\n')

const READY_TIMEOUT_MS = 15_000

/** Resolve the binary path. Dev: repo root. Prod: app resources (shipped via
 *  electron-builder extraResources, same as the other native helpers). */
function resolveBinaryPath(): string {
  // null only where the OS ships no helper; '' then fails the existsSync guard like a missing binary.
  return helpers.resolve(SYSTEM_AUDIO_BIN) ?? ''
}

interface ActiveCapture {
  proc: ChildProcess
  /** Flips once READY has been seen; bytes after it are audio, not log text. */
  sawReady: boolean
  stopped: boolean
}

let active: ActiveCapture | null = null

export interface SystemAudioCallbacks {
  /** One chunk of raw float32 interleaved PCM. Called many times a second. */
  onPcm: (chunk: Buffer) => void
  /** Terminal failure. The caller should reflect this back to the phone
   *  rather than leaving a toggle stuck ON with no audio flowing. */
  onError: (reason: string) => void
}

/** True when the native helper exists and this Mac can run it. Cheap enough
 *  to call from an IPC handler — an existsSync, no spawn. */
export function isSystemAudioAvailable(): boolean {
  return existsSync(resolveBinaryPath())
}

/**
 * Start system audio capture. Resolves once the helper reports READY, which is
 * the point at which PCM begins flowing to `onPcm`.
 * Rejects if the binary is missing, the OS is too old, or it dies before READY.
 */
export function startSystemAudio(callbacks: SystemAudioCallbacks): Promise<void> {
  return new Promise((resolve, reject) => {
    if (active) {
      // Idempotent rather than fatal: a double-start races the phone's toggle
      // against a mirror restart, and failing that would leave audio off with
      // an error the user can't act on.
      devLog.warn('[system-audio] already capturing — ignoring duplicate start')
      resolve()
      return
    }

    const bin = resolveBinaryPath()
    if (!existsSync(bin)) {
      reject(
        new Error(
          `system-audio: binary not found at ${bin}. Run: cd native/system-audio && bash build.sh`
        )
      )
      return
    }

    const proc = spawn(bin)
    const capture: ActiveCapture = { proc, sawReady: false, stopped: false }
    active = capture
    const readyTimer = setTimeout(() => {
      if (!capture.sawReady) proc.kill('SIGKILL')
    }, READY_TIMEOUT_MS)

    proc.on('error', (err) => {
      clearTimeout(readyTimer)
      if (active === capture) active = null
      reject(new Error(`system-audio: spawn error: ${err.message}`))
    })

    // Holds bytes received before READY has been located. Once found, this is
    // dropped entirely — READY can share a chunk with the first PCM frames.
    let preReady: Buffer = Buffer.alloc(0)

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (capture.sawReady) {
        callbacks.onPcm(chunk)
        return
      }
      preReady = Buffer.concat([preReady, chunk])
      const idx = preReady.indexOf(READY_MARKER)
      if (idx === -1) return

      capture.sawReady = true
      clearTimeout(readyTimer)
      const tail = preReady.subarray(idx + READY_MARKER.length)
      preReady = Buffer.alloc(0)
      devLog.log('[system-audio] READY')
      resolve()
      // Anything already past the marker is audio — forward it rather than
      // discarding the first frames of every session.
      if (tail.length > 0) callbacks.onPcm(tail)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      devLog.warn('[system-audio] stderr:', chunk.toString().trim())
    })

    proc.once('close', (code) => {
      clearTimeout(readyTimer)
      const wasReady = capture.sawReady
      if (active === capture) active = null
      if (capture.stopped && !wasReady) {
        resolve()
        return
      }
      if (!wasReady) {
        reject(
          new Error(
            code === EXIT_UNSUPPORTED
              ? 'system-audio: requires macOS 13 or later'
              : `system-audio: exited (code ${code}) before READY`
          )
        )
        return
      }
      // Died mid-stream (SCK dropped the stream, permission revoked). The
      // phone must hear about it — silently stopping looks like a bug.
      if (code !== 0 && code !== null) {
        callbacks.onError(`system-audio exited unexpectedly (code ${code})`)
      }
    })
  })
}

/** Stop capture. SIGINT so the helper stops the SCK stream cleanly. */
export function stopSystemAudio(): void {
  if (!active) return
  const capture = active
  active = null
  capture.stopped = true
  capture.proc.kill(capture.sawReady ? 'SIGINT' : 'SIGKILL')
}

/** True while system audio is being captured. */
export function isCapturingSystemAudio(): boolean {
  return active !== null
}
