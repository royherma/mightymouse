import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ tracked: [] as Array<{ event: string; props: Record<string, unknown> }> }))

vi.mock('electron', () => ({ clipboard: {}, app: { getPath: () => '/tmp' }, ipcMain: { handle: () => {} } }))
vi.mock('../../analytics', () => ({
  track: (event: string, props: Record<string, unknown>) => h.tracked.push({ event, props })
}))
vi.mock('../../store/prefs', () => ({ PREFS: {} }))
vi.mock('../../store/paths', () => ({ PATHS: {} }))
vi.mock('../../store/settings', () => ({ SETTINGS: {} }))
vi.mock('../../store/events', () => ({ EVENTS: {} }))
vi.mock('../../store/speech', () => ({ SPEECH: {} }))
vi.mock('../../store/history', () => ({ HISTORY: {} }))
vi.mock('../../platform', () => ({ pasteText: () => {} }))
vi.mock('../../capture/whisper', () => ({ transcribe: () => {}, rtfOf: () => 0, countWords: () => 0 }))
vi.mock('../../capture/capture-actions', () => ({ logCapture: () => {} }))
vi.mock('../../hud-window', () => ({ startHud: () => {}, updateHud: () => {}, widenHud: () => {}, doneHud: () => {}, failHud: () => {} }))
vi.mock('../../backend/hud-run', () => ({ runHudRun: () => {} }))
vi.mock('../../backend/runner', () => ({ abortRun: () => {} }))
vi.mock('../../estimator/duration-estimator', () => ({ estimateDuration: () => 0 }))
vi.mock('../../backend/context-memory', () => ({ buildMemoryBlob: () => '' }))
vi.mock('../../activation-checklist', () => ({ trackChecklistStep: () => {} }))
vi.mock('../../phone-remote/server', () => ({
  sendToPhone: () => {},
  sendDictationHistory: () => {},
  isPhoneRun: () => false
}))
vi.mock('../phone-remote-context', () => ({ sendClipboardState: () => {} }))
vi.mock('../phone-first-steps', () => ({ notePhoneFirstStep: () => {} }))
vi.mock('../../first-run-window', () => ({ sendToFirstRunRenderer: () => {} }))

import { bumpPhoneMessage, bumpPhoneMoves, flushPhoneSession, resetPhoneSession } from '../phone-remote-audio'

describe('phone_session_ended message counts', () => {
  beforeEach(() => {
    h.tracked.length = 0
  })

  it('a 0-move session still reports what the phone did send', () => {
    resetPhoneSession()
    bumpPhoneMessage('getLayoutPrefs')
    bumpPhoneMessage('getSensitivity')
    bumpPhoneMessage('getLayoutPrefs')
    flushPhoneSession()

    expect(h.tracked).toHaveLength(1)
    expect(h.tracked[0].props).toMatchObject({
      moves: 0,
      idle: true,
      messages: 3,
      message_types: 'getLayoutPrefs,getSensitivity'
    })
  })

  it('a silent phone reports 0 messages, and counters reset per session', () => {
    resetPhoneSession()
    bumpPhoneMessage('move')
    bumpPhoneMoves()
    flushPhoneSession()
    resetPhoneSession()
    flushPhoneSession()

    expect(h.tracked[0].props).toMatchObject({ moves: 1, messages: 1, message_types: 'move' })
    expect(h.tracked[1].props).toMatchObject({ moves: 0, messages: 0, message_types: '' })
  })

  it('caps the type list at 12', () => {
    resetPhoneSession()
    for (let i = 0; i < 20; i++) bumpPhoneMessage(`t${i}`)
    flushPhoneSession()

    expect(h.tracked[0].props.messages).toBe(20)
    expect(String(h.tracked[0].props.message_types).split(',')).toHaveLength(12)
  })
})
