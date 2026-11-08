import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  started: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  saved: null as unknown,
  savedFails: false,
  askedForSaved: 0
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: () => {} } }))
vi.mock('../../store/mighty', () => ({
  MIGHTY: { listProjects: () => [{ id: 'p1', name: 'MightyMouse', repoFolder: '/tmp/mm' }] }
}))
vi.mock('../../phone-remote/server', () => ({
  sendToPhone: (msg: Record<string, unknown>) => h.sent.push(msg)
}))
vi.mock('../../phone-remote/relay-http', () => ({ transcriptMedia: () => [], transcriptSession: () => undefined }))
vi.mock('../../agent-relay/session-checklist', () => ({ readSessionChecklist: () => null }))
vi.mock('../../agent-relay/session-transcript', () => ({
  readRunningHelpers: () => [],
  readSessionTools: () => [],
  readSessionTranscript: () => []
}))
vi.mock('../../agent-relay/project-ideas', () => ({ projectIdeas: async () => null }))
vi.mock('../mcp-connections', () => ({ listMcpConnections: async () => [] }))
vi.mock('../phone-remote-chat', () => ({ projectImageBase64: () => undefined }))
vi.mock('../phone-remote-share', () => ({ takeReplyImagePath: () => undefined }))
vi.mock('../agent-relay', () => ({
  startCodeSession: async (input: Record<string, unknown>) => {
    h.started.push(input)
    return { ok: true }
  }
}))
vi.mock('../../voice-routing/agent-models', () => ({
  getAgentModel: async () => {
    h.askedForSaved++
    if (h.savedFails) throw new Error('models list failed')
    return h.saved
  },
  isModelHarness: () => true,
  listAgentModels: async () => [],
  setAgentModel: async () => true
}))

import { handleRelayStartSession } from '../phone-remote-ai'

async function start(harness?: string): Promise<Record<string, unknown>> {
  handleRelayStartSession({ type: 'relayStartSession', requestId: 'r1', projectId: 'p1', text: 'fix login', harness } as never)
  for (let i = 0; i < 20 && h.started.length === 0; i++) await new Promise((r) => setTimeout(r, 0))
  expect(h.started).toHaveLength(1)
  return h.started[0]
}

beforeEach(() => {
  h.started = []
  h.sent = []
  h.saved = null
  h.savedFails = false
  h.askedForSaved = 0
})

describe('phone-started code session picks its engine and model', () => {
  it('an unset choice (default engine, blank model) leaves both to the Mac, not pinned blank', async () => {
    h.saved = { harness: 'codex', model: '' }
    const input = await start()
    expect(input.harness).toBeUndefined()
    expect(input.model).toBeUndefined()
  })

  it('uses the model the user actually picked, with its engine', async () => {
    h.saved = { harness: 'codex', model: 'gpt-5.5' }
    const input = await start()
    expect(input).toMatchObject({ harness: 'codex', model: 'gpt-5.5', project: 'MightyMouse', cwd: '/tmp/mm', inApp: true })
  })

  it('an engine the phone names wins and skips the saved model', async () => {
    h.saved = { harness: 'codex', model: 'gpt-5.5' }
    const input = await start('claude')
    expect(input.harness).toBe('claude')
    expect(input.model).toBeUndefined()
    expect(h.askedForSaved).toBe(0)
  })

  it('an engine name the phone may not force falls back to the saved choice', async () => {
    h.saved = { harness: 'claude', model: 'opus' }
    const input = await start('opencode')
    expect(input).toMatchObject({ harness: 'claude', model: 'opus' })
  })

  it('still starts when reading the saved choice throws', async () => {
    h.savedFails = true
    const input = await start()
    expect(input.harness).toBeUndefined()
    expect(input.model).toBeUndefined()
  })
})
