import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ lsof: {} as Record<string, string>, ppid: {} as Record<string, string>, calls: [] as string[] }))

vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    const pid = args[args.indexOf('-p') + 1]
    h.calls.push(`${cmd} ${pid}`)
    if (cmd === 'lsof') return cb(pid in h.lsof ? null : new Error('no such pid'), h.lsof[pid] ?? '')
    if (cmd === 'ps') return cb(pid in h.ppid ? null : new Error('no such pid'), h.ppid[pid] ?? '')
    return cb(new Error(`unexpected ${cmd}`), '')
  }
}))

import { codexThreadIdForAgent, withCodexThreads } from '../codex-threads'

const ID_A = '019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b'
const ID_B = '019affff-0000-7000-8000-123456789abc'
const rollout = (id: string): string => `n/Users/me/.codex/sessions/2026/11/16/rollout-2026-11-16T09-00-00-${id}.jsonl`
const lsofOut = (...names: string[]): string => ['p4242', 'fcwd', 'n/Users/me/proj', ...names.flatMap((n) => ['f23', n])].join('\n') + '\n'

beforeEach(() => {
  h.lsof = {}
  h.ppid = {}
  h.calls = []
})

describe('codexThreadIdForAgent reads the Codex chat id from the rollout file the process holds open', () => {
  it('one rollout file open, even on two descriptors, gives its id', async () => {
    h.lsof['4242'] = lsofOut('n/dev/ttys003', rollout(ID_A), rollout(ID_A), 'n/Users/me/.codex/history.jsonl')
    expect(await codexThreadIdForAgent(4242)).toBe(ID_A)
  })

  it('two different rollout files open is ambiguous and gives no id', async () => {
    h.lsof['4242'] = lsofOut(rollout(ID_A), rollout(ID_B))
    h.ppid['4242'] = '1\n'
    expect(await codexThreadIdForAgent(4242)).toBe('')
  })

  it('a jsonl that is not a rollout file, or a rollout name without a full uuid, gives no id', async () => {
    h.lsof['4242'] = lsofOut('n/Users/me/.codex/session-019a1b2c.jsonl', 'n/Users/me/.codex/sessions/rollout-2026-11-16-019a1b2c.jsonl')
    h.ppid['4242'] = '1\n'
    expect(await codexThreadIdForAgent(4242)).toBe('')
  })

  it('an npx-launched shim reports npm as the agent: the id comes from its parent Codex', async () => {
    h.lsof['5000'] = lsofOut('n/Users/me/.npm/_npx/abc/package.json')
    h.ppid['5000'] = '  4242\n'
    h.lsof['4242'] = lsofOut(rollout(ID_B))
    expect(await codexThreadIdForAgent(5000)).toBe(ID_B)
  })

  it('a process whose parent is launchd (pid 1) never has launchd looked up', async () => {
    h.lsof['5000'] = lsofOut()
    h.ppid['5000'] = '1\n'
    expect(await codexThreadIdForAgent(5000)).toBe('')
    expect(h.calls).toEqual(['lsof 5000', 'ps 5000'])
  })
})

describe('withCodexThreads gives an id-less Codex pane the chat id its process holds open', () => {
  it('the first listing kicks off the lookup, the next one carries the id and keeps the pane name', async () => {
    h.lsof['4242'] = lsofOut(rollout(ID_A))
    const pane = { label: 'fix-login', since: 0, facts: { agent: 'codex', agentPid: '4242' }, origin: { tmuxPane: '%9' } }
    expect(withCodexThreads([pane])[0].sessionId).toBeUndefined()
    await vi.waitFor(() => expect(withCodexThreads([pane])[0].sessionId).toBe(ID_A))
    expect(withCodexThreads([pane])[0].label).toBe('fix-login')
  })

  it('a Claude pane or a Codex pane that already has an id is never looked up', async () => {
    const claude = { label: 'c', since: 0, facts: { agent: 'claude', agentPid: '7001' }, origin: { tmuxPane: '%1' } }
    const named = { label: 'x', since: 0, sessionId: ID_B, facts: { agent: 'codex', agentPid: '7002' }, origin: { tmuxPane: '%2' } }
    withCodexThreads([claude, named])
    await new Promise((done) => setTimeout(done, 20))
    expect(h.calls).toEqual([])
  })
})
