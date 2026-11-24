import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ home: '', calls: [] as { cmd: string; args: string[]; home?: string }[] }))
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => h.home }))
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => h.home }))
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFile: (cmd: string, args: string[], opts: { env?: Record<string, string> }, cb: (err: Error | null, stdout: string) => void) => {
    h.calls.push({ cmd, args, home: opts?.env?.HOME })
    cb(null, args[0] === 'new-session' ? '%42\n' : '')
  }
}))
vi.mock('../../platform', () => ({ resolveBinary: (name: string) => `/bin/${name}` }))
vi.mock('../../agent-relay/origin-resolver', () => ({ cmuxPath: () => null }))
vi.mock('../agent-sinks', () => ({ projectIdentityPhrase: () => '' }))

const { startNewAgent } = await import('../new-agent-sink')

const CWD = '/Users/dev/my_app.v2'
const sink = { kind: 'new-agent', id: 'new-agent:x', label: 'x', project: 'My App', cwd: CWD, hostBundleId: '' } as unknown as Parameters<typeof startNewAgent>[0]
const agySettings = (): string => join(h.home, '.gemini', 'antigravity-cli', 'settings.json')
const start = (harness: 'antigravity' | 'cursor', text = 'fix the build') => startNewAgent(sink, text, harness, { reveal: false, env: { HOME: h.home } })
const spawned = (): string[] => h.calls.find((c) => c.args[0] === 'new-session')?.args ?? []

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), 'mm-trust-'))
  h.calls = []
})
afterEach(() => rmSync(h.home, { recursive: true, force: true }))

describe('starting an Antigravity agent', () => {
  it("adds the folder to Antigravity's trusted list, keeping the user's other settings", async () => {
    mkdirSync(join(h.home, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(agySettings(), JSON.stringify({ theme: 'dark', trustedWorkspaces: ['/Users/dev/other'] }))
    expect(await start('antigravity')).toMatchObject({ ok: true, pane: '%42' })
    expect(JSON.parse(readFileSync(agySettings(), 'utf-8'))).toEqual({ theme: 'dark', trustedWorkspaces: ['/Users/dev/other', CWD] })
    await start('antigravity')
    expect(JSON.parse(readFileSync(agySettings(), 'utf-8')).trustedWorkspaces).toEqual(['/Users/dev/other', CWD])
  })

  it('never rewrites a settings file it cannot parse', async () => {
    mkdirSync(join(h.home, '.gemini', 'antigravity-cli'), { recursive: true })
    writeFileSync(agySettings(), '{ "theme": "dark", ')
    await start('antigravity')
    expect(readFileSync(agySettings(), 'utf-8')).toBe('{ "theme": "dark", ')
  })

  it('registers the MightyMouse server with agy once, under the same HOME, and passes the ask as -i', async () => {
    await start('antigravity')
    const add = h.calls.filter((c) => c.args[0] === 'mcp')
    expect(add).toEqual([{ cmd: '/bin/agy', args: ['mcp', 'add', 'mightymouse-code', '--', 'npx', '-y', 'mightymouse-code'], home: h.home }])
    expect(spawned().slice(-3)).toEqual(['/bin/agy', '-i', 'fix the build'])

    mkdirSync(join(h.home, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(h.home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'mightymouse-code': { command: 'npx' } } }))
    h.calls = []
    await start('antigravity')
    expect(h.calls.filter((c) => c.args[0] === 'mcp')).toEqual([])
  })
})

describe('starting a Cursor agent', () => {
  const trustFile = (): string => join(h.home, '.cursor', 'projects', 'Users-dev-my-app-v2', '.workspace-trusted')

  it('pre-trusts the folder under the slug Cursor uses, adds the server and auto-approves MCP', async () => {
    await start('cursor')
    expect(JSON.parse(readFileSync(trustFile(), 'utf-8'))).toMatchObject({ workspacePath: CWD, trustMethod: 'cli-flag' })
    expect(JSON.parse(readFileSync(join(h.home, '.cursor', 'mcp.json'), 'utf-8')).mcpServers['mightymouse-code']).toBeDefined()
    expect(spawned().slice(-3)).toEqual(['/bin/cursor-agent', '--approve-mcps', 'fix the build'])
  })

  it("leaves a trust file Cursor already wrote alone", async () => {
    mkdirSync(join(h.home, '.cursor', 'projects', 'Users-dev-my-app-v2'), { recursive: true })
    writeFileSync(trustFile(), '{"trustedAt":"2026-01-01T00:00:00.000Z","workspacePath":"/Users/dev/my_app.v2","trustMethod":"dialog"}')
    await start('cursor')
    expect(JSON.parse(readFileSync(trustFile(), 'utf-8')).trustMethod).toBe('dialog')
  })
})
