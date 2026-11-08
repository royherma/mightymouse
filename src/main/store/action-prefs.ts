import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PATHS } from './paths'

function readFlag(path: string, fallback: boolean): boolean {
  if (!existsSync(path)) return fallback
  try {
    return readFileSync(path, 'utf-8').trim() === '1'
  } catch {
    return fallback
  }
}

function writeText(path: string, value: string): void {
  try {
    writeFileSync(path, value, 'utf-8')
  } catch (err) {
    console.error(`action-prefs: failed to write ${path}:`, err)
  }
}

function readDisabled(): string[] {
  if (!existsSync(PATHS.ACTIONS_DISABLED_CAPABILITIES_PREF)) return []
  try {
    return readFileSync(PATHS.ACTIONS_DISABLED_CAPABILITIES_PREF, 'utf-8')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '')
  } catch {
    return []
  }
}

export const ACTION_PREFS = {
  getEnabled(): boolean {
    return readFlag(PATHS.ACTIONS_PREF, true)
  },

  setEnabled(on: boolean): void {
    writeText(PATHS.ACTIONS_PREF, on ? '1' : '0')
  },

  getIdleEnabled(): boolean {
    return readFlag(PATHS.ACTIONS_IDLE_PREF, false)
  },

  setIdleEnabled(on: boolean): void {
    writeText(PATHS.ACTIONS_IDLE_PREF, on ? '1' : '0')
  },

  isCapabilityEnabled(id: string): boolean {
    return !readDisabled().includes(id)
  },

  setCapabilityEnabled(id: string, on: boolean): void {
    const disabled = new Set(readDisabled())
    if (on) disabled.delete(id)
    else disabled.add(id)
    writeText(PATHS.ACTIONS_DISABLED_CAPABILITIES_PREF, [...disabled].join(','))
  }
}
