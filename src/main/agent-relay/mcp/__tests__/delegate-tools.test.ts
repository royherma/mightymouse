import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Session = { label: string; since: number; sessionId?: string; cwd?: string; origin?: { tmuxPane?: string; tmuxSocket?: string }; facts?: Record<string, string> }

const h = vi.hoisted(() => ({
  dir: '',
  live: [] as Session[],
  started: [] as Array<Record<string, unknown>>,
  start: { ok: true, pane: '%50' } as { ok: boolean; pane?: string; reason?: string },
  agentReply: ''
}))

vi.mock('../http-listener', () => ({ liveAgentSessions: () => h.live, setAgentSessionTldr: () => undefined }))
vi.mock('../../picker-keys', () => ({ capturePaneTail: async () => '' }))
vi.mock('../../session-transcript', () => ({
  claudeTranscriptPaths: (_home: string, _cwd: string, id: string) => [join(h.dir, `claude-${id}.jsonl`)],
  codexTranscriptPath: (_home: string, id: string) => join(h.dir, `codex-${id}.jsonl`),
  readSessionTranscript: () => [{ role: 'agent', text: h.agentReply }, { role: 'tool', text: 'Read' }]
}))
vi.mock('../../../ipc/agent-relay', () => ({
  startCodeSession: async (opts: Record<string, unknown>) => {
    h.started.push(opts)
    return h.start
  }
}))
vi.mock('../../../voice-routing/agent-models', () => ({ listAgentModels: async () => [] }))

type Run = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

const PARENT: Session = { label: 'parent', since: 0, sessionId: 'parent-1', cwd: '/repo/app', facts: { agent: 'claude' }, origin: { tmuxPane: '%10', tmuxSocket: 's' } }
const OTHER: Session = { label: 'other', since: 0, sessionId: 'other-1', cwd: '/repo/app', facts: { agent: 'codex' }, origin: { tmuxPane: '%11', tmuxSocket: 's' } }
const asParent = { sessionId: PARENT.sessionId, origin: PARENT.origin }
const asOther = { sessionId: OTHER.sessionId, origin: OTHER.origin }

async function handlers(): Promise<{ delegate: Run; task: Run }> {
  vi.resetModules()
  const { DELEGATE_HANDLERS } = await import('../delegate-tools')
  return { delegate: DELEGATE_HANDLERS.delegate.run as unknown as Run, task: DELEGATE_HANDLERS.task.run as unknown as Run }
}

const text = (r: { content: Array<{ text: string }> }): string => r.content[0].text
const taskId = (r: { content: Array<{ text: string }> }): string => /task ([0-9a-f]{8})/.exec(text(r))![1]

async function startHelper(run: { delegate: Run; task: Run }, agent: string, childId: string): Promise<string> {
  const id = taskId(await run.delegate({ task: 'Review src/auth.ts and list bugs', agent, wait: 0, ...asParent }))
  await vi.waitFor(async () => expect(text(await run.task({ id, ...asParent }))).toContain('still working'))
  h.live.push({ label: 'helper', since: Date.now(), sessionId: childId, cwd: '/repo/app', facts: { agent }, origin: { tmuxPane: '%50', tmuxSocket: 's' } })
  return id
}

const at = (ms: number): string => new Date(ms).toISOString()

beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'mm-delegate-'))
  h.live = [PARENT, OTHER]
  h.started = []
  h.start = { ok: true, pane: '%50' }
  h.agentReply = ''
})

afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true })
})

describe('delegate hands a task to another agent and reads its reply from the session file', () => {
  it('a Codex helper is done at its task_complete line, and the reply is its last_agent_message', async () => {
    const run = await handlers()
    const id = await startHelper(run, 'codex', 'child-codex')
    expect(h.started[0]).toMatchObject({ cwd: '/repo/app', harness: 'codex', message: 'Review src/auth.ts and list bugs', inApp: true })

    const file = join(h.dir, 'codex-child-codex.jsonl')
    writeFileSync(file, JSON.stringify({ timestamp: at(Date.now() - 60_000), payload: { type: 'task_complete', last_agent_message: 'an older turn' } }) + '\n')
    expect(text(await run.task({ id, ...asParent }))).toContain('still working')

    appendFileSync(file, JSON.stringify({ timestamp: at(Date.now() + 1000), payload: { type: 'task_complete', last_agent_message: '  Two bugs: line 4 and line 9.  ' } }) + '\n{"timestamp":')
    const done = text(await run.task({ id, ...asParent }))
    expect(done).toMatch(new RegExp(`^Codex finished task ${id} in \\d+s\\. Its reply:\\n\\nTwo bugs: line 4 and line 9\\.$`))
  })

  it('a Claude Code helper is done at its turn_duration line, and the reply is its last agent message', async () => {
    const run = await handlers()
    const id = await startHelper(run, 'claude', 'child-claude')
    h.agentReply = 'Looks fine.'
    writeFileSync(join(h.dir, 'claude-child-claude.jsonl'), JSON.stringify({ timestamp: at(Date.now() + 1000), type: 'system', subtype: 'turn_duration' }) + '\n')
    expect(text(await run.task({ id, ...asParent }))).toContain('Claude Code finished task')
    expect(text(await run.task({ id, ...asParent }))).toContain('Its reply:\n\nLooks fine.')
  })

  it('a helper that could not start says why, instead of waiting forever', async () => {
    h.start = { ok: false, reason: 'Codex is not installed.' }
    const run = await handlers()
    const res = await run.delegate({ task: 'x', agent: 'codex', wait: 1, ...asParent })
    expect(text(res)).toContain('Its reply:\n\nCould not start Codex: Codex is not installed.')
  })

  it('a session MightyMouse does not know, with no folder, is refused', async () => {
    const run = await handlers()
    const res = await run.delegate({ task: 'x', agent: 'codex', wait: 0, sessionId: 'stranger' })
    expect(res.isError).toBe(true)
    expect(h.started).toEqual([])
  })
})

describe('only the agent that handed off a task can read it, and a helper cannot hand it on', () => {
  it('another agent asking for the task id gets nothing back', async () => {
    const run = await handlers()
    const id = await startHelper(run, 'codex', 'child-codex')
    const res = await run.task({ id, ...asOther })
    expect(res.isError).toBe(true)
    expect(text(res)).toBe(`No task "${id}" from this session.`)
  })

  it('the same pane number on a different tmux server is a different caller', async () => {
    const run = await handlers()
    const id = await startHelper(run, 'codex', 'child-codex')
    const res = await run.task({ id, origin: { tmuxPane: '%10', tmuxSocket: 'other-server' } })
    expect(res.isError).toBe(true)
  })

  it('the helper itself calling delegate is refused and starts nothing', async () => {
    const run = await handlers()
    await startHelper(run, 'codex', 'child-codex')
    const res = await run.delegate({ task: 'pass it on', agent: 'claude', wait: 0, sessionId: 'child-codex', origin: { tmuxPane: '%50', tmuxSocket: 's' } })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain('A helper cannot hand its task on')
    expect(h.started).toHaveLength(1)
  })
})
