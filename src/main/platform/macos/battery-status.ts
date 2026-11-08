// battery-status.ts — read Mac battery percent + charging state for the phone
// widget's status tile.
//
// Why `pmset -g batt`, not Electron's powerMonitor: powerMonitor exposes only
// isOnBatteryPower() (a bool) plus on-ac/on-battery change EVENTS -- there is
// no percentage anywhere in its surface (verified against electron.d.ts). This
// is the same "reach past Electron's API" shape as cursor-appearance.ts.
//
// A Mac with no battery (Mini/Studio/Mac Pro) prints "No batteries available"
// -- that's the common case here, not an error, and must resolve to
// `percent: null` all the way to the widget rather than a sentinel 0 or 100.

import { spawnSync } from 'child_process'
import { devLog } from '../../../shared/env'

const PMSET_TIMEOUT_MS = 500

export interface BatteryStatus {
  percent: number | null
  charging: boolean
}

const NO_BATTERY: BatteryStatus = { percent: null, charging: true }

/** Matches `pmset -g batt`'s per-battery line, e.g.
 *  ` -InternalBattery-0 (id=...)  87%; discharging; 0:42 remaining present: true` */
const BATTERY_LINE = /(\d{1,3})%;\s*([a-z ]+);/i

export function getBatteryStatus(): BatteryStatus {
  try {
    const r = spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: PMSET_TIMEOUT_MS })
    if (r.status !== 0) return NO_BATTERY
    const out = r.stdout
    if (/No batteries available/i.test(out)) return NO_BATTERY

    const match = BATTERY_LINE.exec(out)
    if (!match) return NO_BATTERY
    const percent = Number(match[1])
    const state = match[2].trim().toLowerCase()
    return {
      percent: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
      charging: state === 'charging' || state === 'charged' || state === 'ac attached'
    }
  } catch (err) {
    devLog.warn('[battery-status] pmset read failed', err)
    return NO_BATTERY
  }
}
