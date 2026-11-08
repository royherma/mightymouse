// computer-name.ts — the Mac's human-readable name for the phone widget.
//
// Why not `os.hostname()`: on a DHCP network macOS reports the reverse-DNS name
// the router hands out, which is routinely the bare IP -- Pat's Mac returns
// "192.168.1.12" while its actual name is "MacBook Pro (7)". `scutil` reads the
// name the user set in System Settings → General → About, which is what the
// widget must show.

import { execFile, spawnSync } from 'child_process'
import { hostname } from 'os'
import { devLog } from '../../../shared/env'
import { hostDeviceFrom, type HostDevice } from '../../../shared/phone-remote-keys'

const SCUTIL_TIMEOUT_MS = 500

/** An `os.hostname()` fallback that is itself an address, not a name -- the
 *  exact case this module exists to avoid propagating to the widget. */
const LOOKS_LIKE_ADDRESS = /^[\d.]+$|^[\da-f:]+$/i

export function getComputerName(): string {
  try {
    const result = spawnSync('scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: SCUTIL_TIMEOUT_MS
    })
    const name = result.stdout?.trim()
    if (name) return name
    devLog.warn('[computer-name] scutil returned nothing, falling back')
  } catch (err) {
    devLog.warn('[computer-name] scutil read failed', err)
  }

  const fallback = hostname().replace(/\.local$/, '')
  return LOOKS_LIKE_ADDRESS.test(fallback) ? 'Mac' : fallback
}

const PROFILER_TIMEOUT_MS = 3000

export function getHostDevice(): Promise<HostDevice | null> {
  return new Promise((resolve) => {
    execFile(
      'system_profiler',
      ['SPHardwareDataType', '-json'],
      { timeout: PROFILER_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          devLog.warn('[computer-name] system_profiler failed', err.message)
          resolve(null)
          return
        }
        try {
          const hw = JSON.parse(stdout).SPHardwareDataType?.[0] ?? {}
          resolve(hostDeviceFrom(String(hw.machine_name ?? ''), String(hw.machine_model ?? '')))
        } catch {
          resolve(null)
        }
      }
    )
  })
}
