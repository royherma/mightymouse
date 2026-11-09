import { describe, it, expect, vi } from 'vitest'
import { STOPPED_MARK } from '../../../shared/stopped-reply'

const sent: Array<Record<string, unknown>> = []
vi.mock('electron', () => {
  const stub: Record<string, unknown> = new Proxy({}, { get: () => () => stub })
  return { default: stub, nativeImage: stub, app: { getPath: () => '/tmp', isPackaged: false, on: () => {}, getVersion: () => '0' }, ipcMain: { handle: () => {}, on: () => {} }, BrowserWindow: class {}, screen: stub, shell: stub, systemPreferences: stub, nativeTheme: stub, Menu: stub, Tray: class {}, clipboard: stub, globalShortcut: stub, powerMonitor: stub, Notification: class {} }
})
vi.mock('../../phone-remote/server', () => ({ sendToPhone: (m: Record<string, unknown>) => sent.push(m) }))
vi.mock('../../store/mighty', () => ({
  MIGHTY: { getSession: () => ({ id: 's1', title: 't', turns: [] }), getProject: () => null, newSession: () => ({ id: 's1', title: 't' }) }
}))
vi.mock('../../mighty/run-mighty', () => ({
  runMighty: async (opts: { onEvent?: (e: unknown) => void }) => {
    opts.onEvent?.({ kind: 'text', text: 'Half a sentence' })
    return { answer: `Half a sentence\n\n${STOPPED_MARK}`, sessionId: 's1', artifacts: [], error: 'stopped' }
  }
}))

import { handleChatSend } from '../phone-remote-chat'

describe('phone chat stop', () => {
  it('sends the kept partial plus the marker as the reply, not the stopped label', async () => {
    await handleChatSend('s1', 'write me a long list')
    expect(sent.find((m) => m.type === 'chatChunk')?.chunk).toBe('Half a sentence')
    const done = sent.find((m) => m.type === 'chatTurnDone')
    expect(done?.reply).toBe(`Half a sentence\n\n${STOPPED_MARK}`)
    expect(done?.ok).toBe(false)
  })
})
