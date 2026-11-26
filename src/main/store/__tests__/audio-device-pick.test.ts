import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const dir = mkdtempSync(join(tmpdir(), 'mm-settings-'))

vi.mock('../paths', () => ({ PATHS: { SETTINGS_FILE: join(dir, 'settings.json'), WHISPER_MODEL_DEFAULT: '/x', HISTORY: join(dir, 'h') } }))
vi.mock('../../platform', () => ({ resolveBinary: () => null }))
vi.mock('../prefs', () => ({ PREFS: { getOnboardingComplete: () => true } }))

describe('tray Microphone pick survives a restart', () => {
  beforeEach(() => vi.resetModules())

  it('keeps "MacBook Pro Microphone" picked from the tray after the app restarts', async () => {
    const first = await import('../settings')
    first.SETTINGS.set({ audioDevice: 'MacBook Pro Microphone' })
    vi.resetModules()
    const afterRestart = await import('../settings')
    expect(afterRestart.SETTINGS.get().audioDevice).toBe('MacBook Pro Microphone')
  })

  it('control: any other picked mic survives the restart', async () => {
    const first = await import('../settings')
    first.SETTINGS.set({ audioDevice: 'AirPods Pro' })
    vi.resetModules()
    const afterRestart = await import('../settings')
    expect(afterRestart.SETTINGS.get().audioDevice).toBe('AirPods Pro')
  })
})

describe('old built-in mic default still migrates', () => {
  beforeEach(() => vi.resetModules())

  it('a settings file from before the mic pick reads as the computer mic', async () => {
    const { writeFileSync } = await import('fs')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ audioDevice: 'MacBook Pro Microphone' }))
    const { SETTINGS } = await import('../settings')
    expect(SETTINGS.get().audioDevice).toBe('default')
  })
})
