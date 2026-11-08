import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ home: '' }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => env.home }
})
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { openExternal: vi.fn() } }))
vi.mock('../../platform', () => ({ resolveClaude: () => null }))

env.home = mkdtempSync(join(tmpdir(), 'mm-mcp-conn-'))
const { listMcpConnections, parseMcpList } = await import('../mcp-connections')

afterAll(() => rmSync(env.home, { recursive: true, force: true }))

describe('parseMcpList', () => {
  it('reads the rows `claude mcp list` prints, skipping the header', () => {
    const out = [
      'Checking MCP server health…',
      '',
      'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
      'sentry: https://mcp.sentry.dev/mcp (HTTP) - ✔ Connected',
      'stripe: https://mcp.stripe.com (HTTP) - ! Needs authentication',
      'legacy: https://old.example/sse (SSE) - ✗ Failed to connect',
      'gcloud: npx -y @google-cloud/gcloud-mcp@latest - ✔ Connected',
      'shared: node server.js - ⏸ Pending approval'
    ].join('\n')
    expect(parseMcpList(out)).toEqual([
      { name: 'claude.ai Claude Docs', target: 'https://api.anthropic.com/v1/pages/mcp', status: 'connected', detail: 'Connected' },
      { name: 'sentry', target: 'https://mcp.sentry.dev/mcp', status: 'connected', detail: 'Connected' },
      { name: 'stripe', target: 'https://mcp.stripe.com', status: 'needs-login', detail: 'Needs authentication' },
      { name: 'legacy', target: 'https://old.example/sse', status: 'failed', detail: 'Failed to connect' },
      { name: 'gcloud', target: 'npx -y @google-cloud/gcloud-mcp@latest', status: 'connected', detail: 'Connected' },
      { name: 'shared', target: 'node server.js', status: 'pending-approval', detail: 'Pending approval' }
    ])
  })

  it('keeps a stdio command that itself contains " - " whole', () => {
    expect(parseMcpList('x: tool --flag - value - ✔ Connected')[0].target).toBe('tool --flag - value')
  })

  it('returns nothing for output with no server rows', () => {
    expect(parseMcpList('No MCP servers configured. Use `claude mcp add` to add a server.')).toEqual([])
  })
})

describe('listMcpConnections', () => {
  const cwd = join(env.home, 'repo')

  it('merges local, project and user scopes and infers each transport', async () => {
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      join(env.home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { A: 'b' } },
          bare: { url: 'https://bare.example/mcp' }
        },
        projects: {
          [cwd]: { mcpServers: { mine: { command: 'node', args: ['s.js'], env: { K: 'v' } } } },
          '/elsewhere': { mcpServers: { notmine: { command: 'x' } } }
        }
      })
    )
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { team: { type: 'sse', url: 'https://t.example/sse' } } }))

    expect(await listMcpConnections(cwd)).toEqual([
      { name: 'mine', scope: 'local', spec: { transport: 'stdio', command: 'node', args: ['s.js'], env: { K: 'v' } } },
      { name: 'team', scope: 'project', spec: { transport: 'sse', url: 'https://t.example/sse', headers: {} } },
      { name: 'sentry', scope: 'user', spec: { transport: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { A: 'b' } } },
      { name: 'bare', scope: 'user', spec: { transport: 'http', url: 'https://bare.example/mcp', headers: {} } }
    ])
  })

  it('shows only user-scope servers with no folder picked', async () => {
    expect((await listMcpConnections('')).map((c) => c.scope)).toEqual(['user', 'user'])
  })

  it('returns an empty list when the config files are missing or broken', async () => {
    writeFileSync(join(env.home, '.claude.json'), '{not json')
    rmSync(join(cwd, '.mcp.json'))
    expect(await listMcpConnections(cwd)).toEqual([])
  })
})
