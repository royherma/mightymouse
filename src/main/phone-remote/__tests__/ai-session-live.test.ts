import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocket } from 'ws'
import { request } from 'https'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { CONFIG } from '../../../shared/config'
import type { PhoneRemoteEvent, PhoneRemoteMessage } from '../../../shared/phone-remote-protocol'

const TEST_ROOT = join(tmpdir(), 'mm-ai-session-live-test')
const IMAGE = join(TEST_ROOT, 'shot.png')
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
let activePort = 41974
const started: unknown[] = []

vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: { ...actual.CONFIG, PHONE_REMOTE: { ...actual.CONFIG.PHONE_REMOTE, PORT: 41974 } }
  }
})

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, j(t(), 'mm-ai-session-live-test')) }
})

vi.mock('../../../shared/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/env')>()
  return { ...actual, IS_DEV: true }
})

vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    listProjects: () => [
      { id: 'p1', name: 'MightyMouse', repoFolder: '/tmp/mightymouse', icon: 'mouse', pinned: true },
      { id: 'p2', name: 'Old', repoFolder: '/tmp/old', archived: true }
    ],
    getSession: () => null
  }
}))

vi.mock('../../ipc/agent-relay', () => ({
  startCodeSession: async (input: unknown) => {
    started.push(input)
    return { ok: true, pane: '%1' }
  }
}))

vi.mock('../../ipc/phone-remote-chat', () => ({ projectImageBase64: () => undefined }))
vi.mock('../../ipc/phone-remote-share', () => ({
  takeReplyImagePath: (label: string) => (label === 'new:r1' ? '/tmp/held.png' : undefined)
}))

const SESSION = { label: 'mightymouse/dev - fix', sessionId: 's1', cwd: '/tmp/mightymouse' }
vi.mock('../../agent-relay/session-control', () => ({
  resolveSessionRef: (ref: string) => (ref === SESSION.label ? SESSION : undefined)
}))
vi.mock('../../agent-relay/codex-threads', () => ({ codexThreadFor: () => undefined }))
vi.mock('../../agent-relay/session-transcript', () => ({
  readSessionTranscript: () => [
    { role: 'you', at: 1000, text: 'fix the login bug' },
    { role: 'agent', at: 2000, text: 'Here is the screen', files: ['/tmp/notes.txt', join(tmpdir(), 'mm-ai-session-live-test', 'shot.png')] }
  ],
  readSessionTools: () => [{ kind: 'builtin', name: 'Bash', calls: 3, lastAt: 1500, lastDetail: 'ls', tools: {} }],
  readRunningHelpers: () => [{ task: 'Explore', doing: 'reading', since: 1200 }]
}))
vi.mock('../../agent-relay/session-checklist', () => ({
  readSessionChecklist: () => ({ goal: 'fix login', items: [{ label: 'repro', status: 'completed' }], done: 1 })
}))
vi.mock('../../agent-relay/project-ideas', () => ({
  projectIdeas: async () => ({ ideas: [{ kind: 'fix', label: 'Fix login', prompt: 'Fix the login bug' }], at: 5, stale: false })
}))
vi.mock('../../ipc/mcp-connections', () => ({
  listMcpConnections: async () => [{ name: 'github', scope: 'user', spec: { transport: 'http', headers: { Authorization: 'x' } } }]
}))

async function httpsJson(path: string, body?: string): Promise<{ status: number; data: Buffer }> {
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: activePort,
        path,
        method: body ? 'POST' : 'GET',
        rejectUnauthorized: false,
        agent: false,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }))
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('phone AI screens reach the Mac over a real socket', () => {
  let mod: typeof import('../server')
  let ws: WebSocket
  let credential: string
  const received: PhoneRemoteEvent[] = []

  const ask = async <T extends PhoneRemoteEvent['type']>(
    msg: PhoneRemoteMessage,
    type: T
  ): Promise<Extract<PhoneRemoteEvent, { type: T }>> => {
    ws.send(JSON.stringify(msg))
    for (let i = 0; i < 50; i++) {
      const hit = received.find((e) => e.type === type)
      if (hit) return hit as Extract<PhoneRemoteEvent, { type: T }>
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`no ${type} arrived`)
  }

  beforeAll(async () => {
    mkdirSync(TEST_ROOT, { recursive: true })
    writeFileSync(IMAGE, PNG)
    vi.resetModules()
    mod = await import('../server')
    const ai = await import('../../ipc/phone-remote-ai')
    const handlers: Partial<Record<PhoneRemoteMessage['type'], (m: never) => void>> = {
      relayStartSession: ai.handleRelayStartSession,
      relayProjects: ai.handleRelayProjects,
      relayProjectIdeas: ai.handleRelayProjectIdeas,
      relaySessionTranscript: ai.handleRelaySessionTranscript,
      relaySessionInfo: ai.handleRelaySessionInfo
    }
    const up = await mod.startPhoneRemoteServer({
      getLayoutPrefs: () => ({ layout: 'pro', skin: 'pro' }) as never,
      onMessage: (msg) => handlers[msg.type]?.(msg as never)
    })
    expect(up.ok, 'test server must start').toBe(true)
    if (up.ok) activePort = up.port
    expect(activePort, 'must never bind the real phone-remote port').not.toBe(17771)
    const code = mod.issuePairingCode()
    const pair = await httpsJson(CONFIG.PHONE_REMOTE.PAIR_CODE_PATH, JSON.stringify({ code }))
    credential = (JSON.parse(pair.data.toString()) as { credential: string }).credential
    ws = new WebSocket(`wss://127.0.0.1:${activePort}/?${CONFIG.PHONE_REMOTE.DEVICE_CREDENTIAL_PARAM}=${credential}`, {
      rejectUnauthorized: false
    })
    ws.on('message', (d) => received.push(JSON.parse(d.toString()) as PhoneRemoteEvent))
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
  }, 60_000)

  afterAll(() => {
    ws?.close()
    mod?.stopPhoneRemoteServer()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  it('lists only open code projects, by id and folder name, never a path', async () => {
    const list = await ask({ type: 'relayProjects' }, 'relayProjectList')
    expect(list.projects).toEqual([{ id: 'p1', name: 'MightyMouse', icon: 'mouse', pinned: true, folderName: 'mightymouse', imageBase64: undefined }].map((p) => JSON.parse(JSON.stringify(p))))
    expect(JSON.stringify(list)).not.toContain('/tmp/')
  })

  it('starts an in-app session in the project folder with the held photo', async () => {
    const reply = await ask(
      { type: 'relayStartSession', requestId: 'r1', projectId: 'p1', text: 'fix login', attachLabel: 'new:r1' },
      'relaySessionStarted'
    )
    expect(reply).toMatchObject({ requestId: 'r1', ok: true })
    expect(started).toEqual([
      { project: 'MightyMouse', cwd: '/tmp/mightymouse', inApp: true, harness: undefined, message: 'fix login', paths: ['/tmp/held.png'] }
    ])
  })

  it('refuses an unknown project without starting anything', async () => {
    received.length = 0
    const reply = await ask({ type: 'relayStartSession', requestId: 'r2', projectId: 'p2', text: 'x' }, 'relaySessionStarted')
    expect(reply.ok).toBe(false)
    expect(started).toHaveLength(1)
  })

  it('returns ideas for a project', async () => {
    const ideas = await ask({ type: 'relayProjectIdeas', projectId: 'p1' }, 'relayIdeas')
    expect(ideas.ideas[0].label).toBe('Fix login')
  })

  it('returns the transcript with an image count, and serves that image by position', async () => {
    const t = await ask({ type: 'relaySessionTranscript', label: SESSION.label }, 'relayTranscript')
    expect(t.turns.map((x) => x.media)).toEqual([undefined, 1])
    expect(JSON.stringify(t)).not.toContain(TEST_ROOT)
    const q = `label=${encodeURIComponent(SESSION.label)}&at=2000&item=0&credential=${credential}`
    const img = await httpsJson(`${CONFIG.PHONE_REMOTE.CHAT_MEDIA_PATH}?${q}`)
    expect(img.status).toBe(200)
    expect(img.data.equals(PNG)).toBe(true)
    const miss = await httpsJson(`${CONFIG.PHONE_REMOTE.CHAT_MEDIA_PATH}?${q.replace('item=0', 'item=1')}`)
    expect(miss.status).toBe(404)
  })

  it('returns session info without leaking MCP headers', async () => {
    const info = await ask({ type: 'relaySessionInfo', label: SESSION.label }, 'relayInfo')
    expect(info.checklist?.goal).toBe('fix login')
    expect(info.helpers).toHaveLength(1)
    expect(info.tools[0]).toEqual({ name: 'Bash', kind: 'builtin', calls: 3, lastAt: 1500 })
    expect(info.mcpList).toEqual([{ name: 'github', scope: 'user' }])
  })
})
