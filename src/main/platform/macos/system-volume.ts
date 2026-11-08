// Read/write the Mac's output volume over Apple events. Every call is a process
// spawn, so callers must rate-limit — see queueSystemVolume in ipc/phone-remote.ts.

import { execFile, spawnSync } from 'child_process'
import { devLog } from '../../../shared/env'

/** An Apple-events round trip can hang behind a modal dialog. */
const OSASCRIPT_TIMEOUT_MS = 3000

export const VOLUME_MIN = 0
export const VOLUME_MAX = 100

export type SystemVolume = { volume: number; muted: boolean }

function runOsa(script: string): string | null {
  const r = spawnSync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: OSASCRIPT_TIMEOUT_MS
  })
  if (r.error || r.status !== 0) {
    devLog.warn('[system-volume] osascript failed:', r.stderr?.trim() || r.error?.message)
    return null
  }
  return r.stdout.trim()
}

function runOsaAsync(script: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: OSASCRIPT_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) devLog.warn('[system-volume] osascript failed:', stderr?.trim() || err.message)
      resolve()
    })
  })
}

export function clampVolume(value: number): number {
  // NaN only — Math.min/max already pin ±Infinity to the correct end.
  if (Number.isNaN(value)) return VOLUME_MIN
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, Math.round(value)))
}

/** Null when the device answers `missing value` (some AirPlay targets, DACs). */
export function getSystemVolume(): SystemVolume | null {
  const out = runOsa(
    'set s to (get volume settings)\n' +
      'return (output volume of s as text) & "," & (output muted of s as text)'
  )
  if (!out) return null
  const [rawVolume, rawMuted] = out.split(',')
  const volume = Number(rawVolume)
  if (!Number.isFinite(volume)) return null
  return { volume: clampVolume(volume), muted: rawMuted?.trim() === 'true' }
}

/** Non-zero also unmutes: a muted output stays silent whatever the slider says,
 *  so dragging up and hearing nothing would read as a broken control. */
export function setSystemVolume(value: number): Promise<void> {
  const volume = clampVolume(value)
  return runOsaAsync(
    volume === 0
      ? 'set volume output volume 0 with output muted'
      : `set volume output volume ${volume} without output muted`
  )
}
