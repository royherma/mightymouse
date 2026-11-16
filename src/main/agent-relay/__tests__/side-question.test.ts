import { EventEmitter } from 'events'
import { homedir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Spawned = { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }

const h = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  exit: { code: 0, out: '', err: '' },
  account: null as { backend: 'claude' | 'codex'; dir: string } | null
}))

vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  spawn: (bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => {
    h.spawned.push({ bin, args, env: opts.env, cwd: opts.cwd })
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
    setTimeout(() => {
      if (h.exit.out) child.stdout.emit('data', Buffer.from(h.exit.out))
      if (h.exit.err) child.stderr.emit('data', Buffer.from(h.exit.err))
      child.emit('close', h.exit.code)
    }, 0)
    return child
  }
}))
vi.mock('../../backend/adapters', () => ({ BACKENDS: { claude: { binPath: '/opt/bin/claude' } } }))
vi.mock('../../platform', () => ({ shell: { env: () => ({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/stale/dir' }) } }))
vi.mock('../session-transcript', () => ({ sessionAccountHome: () => h.account }))

import { askSideQuestion } from '../side-question'

const SESSION = { label: 'x', since: 0, sessionId: 'abc-123', cwd: '/definitely/not/here', facts: { agent: 'claude-code' } }

beforeEach(() => {
  h.spawned = []
  h.exit = { code: 0, out: '  The flag is read in config.ts.\n', err: '' }
  h.account = { backend: 'claude', dir: join(homedir(), '.claude') }
})

describe('askSideQuestion answers from a throwaway copy of the session, never the live one', () => {
  it('runs claude on a forked, unsaved, tool-less copy of the session and returns its answer', async () => {
    expect(await askSideQuestion(SESSION, '  where is the flag read?  ')).toEqual({ ok: true, answer: 'The flag is read in config.ts.' })
    const [run] = h.spawned
    expect(run.bin).toBe('/opt/bin/claude')
    const flag = (name: string): string => run.args[run.args.indexOf(name) + 1]
    expect(flag('--resume')).toBe('abc-123')
    expect(run.args).toContain('--fork-session')
    expect(run.args).toContain('--no-session-persistence')
    expect(run.args).toContain('--strict-mcp-config')
    expect(flag('--tools')).toBe('')
    expect(flag('-p').endsWith('\n\nwhere is the flag read?')).toBe(true)
    expect(run.cwd).toBe(homedir())
  })

  it('the default account drops a stale CLAUDE_CONFIG_DIR; another account points at its own folder', async () => {
    await askSideQuestion(SESSION, 'q')
    expect(h.spawned[0].env.CLAUDE_CONFIG_DIR).toBeUndefined()
    h.account = { backend: 'claude', dir: '/Users/me/.claude-work' }
    await askSideQuestion(SESSION, 'q')
    expect(h.spawned[1].env.CLAUDE_CONFIG_DIR).toBe('/Users/me/.claude-work')
  })

  it('a long question is cut to 4000 characters', async () => {
    await askSideQuestion(SESSION, 'a'.repeat(5000))
    const prompt = h.spawned[0].args[h.spawned[0].args.indexOf('-p') + 1]
    expect(prompt.endsWith(`\n\n${'a'.repeat(4000)}`)).toBe(true)
    expect(prompt).not.toContain('a'.repeat(4001))
  })

  it('a failed run reports the last line claude printed to stderr; a silent one says no answer came back', async () => {
    h.exit = { code: 1, out: '', err: 'warming up\nError: No conversation found with session ID: abc-123\n' }
    expect(await askSideQuestion(SESSION, 'q')).toEqual({ ok: false, reason: 'Error: No conversation found with session ID: abc-123' })
    h.exit = { code: 0, out: '   ', err: '' }
    expect(await askSideQuestion(SESSION, 'q')).toEqual({ ok: false, reason: 'No answer came back. Try again.' })
  })
})

describe('askSideQuestion refuses before starting anything', () => {
  it('an empty question, a Codex session, or a session with no saved conversation start nothing', async () => {
    expect(await askSideQuestion(SESSION, '   ')).toEqual({ ok: false, reason: 'Type a question after /btw.' })
    expect(await askSideQuestion({ ...SESSION, facts: { agent: 'codex' } }, 'q')).toEqual({ ok: false, reason: 'Side questions work with Claude sessions only.' })
    expect((await askSideQuestion({ ...SESSION, sessionId: undefined }, 'q')).ok).toBe(false)
    h.account = { backend: 'codex', dir: join(homedir(), '.codex') }
    expect((await askSideQuestion(SESSION, 'q')).ok).toBe(false)
    expect(h.spawned).toEqual([])
  })
})
