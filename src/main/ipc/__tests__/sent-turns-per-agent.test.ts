import { describe, it, expect, vi } from 'vitest'
import type { AgentSession } from '../../agent-relay/mcp/http-listener'

vi.mock('electron', () => {
  const stub: Record<string, unknown> = new Proxy({}, { get: () => () => stub })
  return { default: stub, nativeImage: stub, app: { getPath: () => '/tmp', isPackaged: false, on: () => {}, getVersion: () => '0' }, ipcMain: { handle: () => {}, on: () => {} }, BrowserWindow: class {}, screen: stub, shell: stub, systemPreferences: stub, nativeTheme: stub, Menu: stub, Tray: class {}, clipboard: stub, globalShortcut: stub, powerMonitor: stub, Notification: class {} }
})
vi.mock('../../phone-remote/server', () => ({ sendToPhone: () => {} }))
vi.mock('../../agent-relay/picker-keys', () => ({
  sendPaneText: async () => 'tmux',
  sendPaneKeys: async () => true,
  capturePaneTail: () => ''
}))

const FOLDER = '/Users/x/side-projects'
const older = { label: 'side-projects', since: 1, cwd: FOLDER, origin: { tmuxPane: '%11' }, facts: { pid: 111 } } as unknown as AgentSession
const fresh = { label: 'side-projects', since: 2, cwd: FOLDER, origin: { tmuxPane: '%12' }, facts: { pid: 222 } } as unknown as AgentSession
vi.mock('../../agent-relay/session-control', () => ({
  resolveSessionRef: (ref: string) => (ref === '%11' ? older : ref === '%12' ? fresh : undefined),
  startSessionWrap: () => {}
}))

import { sendToSession, sentTurnsFor } from '../phone-remote-chat'

describe('sent messages stay with the agent they were sent to', () => {
  it('a new agent in the same folder does not show what was typed to another agent there', async () => {
    await sendToSession(older, 'Can you make it ten x more professional', [])
    await sendToSession(fresh, 'which model are u', [])
    expect(sentTurnsFor('%12').map((t) => t.text)).toEqual(['which model are u'])
    expect(sentTurnsFor('%11').map((t) => t.text)).toEqual(['Can you make it ten x more professional'])
  })
})
