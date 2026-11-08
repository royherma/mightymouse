import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { SETTINGS } from '../store/settings'

export interface AvDevice {
  index: string
  name: string
}
export interface AvDevices {
  video: AvDevice[]
  audio: AvDevice[]
  /** Set only when ffmpeg itself failed to run. Absent on a healthy enumeration. */
  error?: string
}

let deviceCache: AvDevices | null = null

function fetchAvDevices(): Promise<AvDevices> {
  return new Promise((resolve) => {
    const ffmpeg = SETTINGS.get().ffmpegPath
    if (!existsSync(ffmpeg)) return resolve({ video: [], audio: [], error: `ffmpeg not found at ${ffmpeg}` })
    execFile(
      ffmpeg,
      ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      { timeout: 8000 },
      (err, _stdout, stderr) => {
        const text = stderr || ''
        const failure = enumerationFailure(err, text)
        resolve(failure ? { video: [], audio: [], error: failure } : parseDevices(text))
      }
    )
  })
}

/**
 * Why an enumeration produced nothing: ffmpeg died, or it ran fine and the Mac
 * genuinely has no devices. Discarding this distinction once reported a broken
 * ffmpeg as a missing microphone.
 *
 * A HEALTHY listing still exits nonzero (`-i ''` always ends in "Error opening
 * input file ."), so `err` alone cannot decide it. The section headers are the
 * real proof ffmpeg reached its AVFoundation code at all; a dyld failure dies
 * before main() and prints none.
 */
function enumerationFailure(err: Error | null, stderr: string): string | null {
  if (/AVFoundation (video|audio) devices:/i.test(stderr)) return null
  const line = stderr.split('\n').map((l) => l.trim()).find(Boolean)
  if (line) return line
  return err ? String(err.message || err) : 'ffmpeg produced no output'
}

/**
 * Enumerate AVFoundation devices via ffmpeg. Returns cache immediately if
 * available, and refreshes the cache in the background for next time.
 */
export async function listAvDevices(): Promise<AvDevices> {
  if (deviceCache) {
    // Refresh in background so next call is still fast
    fetchAvDevices().then(cacheIfHealthy)
    return deviceCache
  }
  const fresh = await fetchAvDevices()
  cacheIfHealthy(fresh)
  return fresh
}

/**
 * Never cache a failed run: a repaired ffmpeg has to be visible to the next
 * "Check again" without relaunching the app.
 */
function cacheIfHealthy(d: AvDevices): void {
  if (!d.error) deviceCache = d
}

/** Pre-warm the device cache at app startup so the first recording is instant. */
export function prewarmDeviceCache(): void {
  fetchAvDevices().then(cacheIfHealthy)
}

export function parseDevices(stderr: string): AvDevices {
  const video: AvDevice[] = []
  const audio: AvDevice[] = []
  let bucket: AvDevice[] | null = null

  for (const line of stderr.split('\n')) {
    if (/AVFoundation video devices:/i.test(line)) {
      bucket = video
      continue
    }
    if (/AVFoundation audio devices:/i.test(line)) {
      bucket = audio
      continue
    }
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/)
    if (bucket && m) {
      bucket.push({ index: m[1], name: m[2] })
    }
  }
  return { video, audio }
}

/**
 * Resolve a stored device name to its current index. If the stored value is
 * already a bare index, return it. If a name match is found, return its current
 * index. Otherwise fall back to the stored value unchanged.
 */
export function resolveDeviceIndex(stored: string, devices: AvDevice[]): string {
  if (/^\d+$/.test(stored)) {
    // Stored as index; keep it but prefer a name re-match if the index moved.
    return stored
  }
  const hit = devices.find((d) => d.name === stored)
  return hit ? hit.index : stored
}
