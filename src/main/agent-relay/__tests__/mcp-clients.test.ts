import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home = ''
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  homedir: () => home
}))

const { detectMcpClients, configureMcpClient, codexRelayArgs } = await import('../mcp-clients')

// Mirrors the real files closely enough to catch a clobbering merge: an
// existing server in each, plus surrounding keys/tables that must survive.
const CLAUDE_JSON = JSON.stringify(
  { numStartups: 42, mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } },
  null,
  2
)
const CODEX_TOML = '[mcp_servers.node_repl]\nargs = []\ncommand = "node_repl"\n\n[memories]\nenabled = true\n'

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-mcp-'))
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.claude.json'), CLAUDE_JSON)
  writeFileSync(join(home, '.codex', 'config.toml'), CODEX_TOML)
})

describe('detectMcpClients', () => {
  it('lists only clients whose config exists', () => {
    const found = detectMcpClients()
    expect(found.map((c) => c.id).sort()).toEqual(['claude-code', 'codex'])
    expect(found.every((c) => !c.configured)).toBe(true)
  })

  it('sees a per-project entry, which is where Claude Code puts it by default', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        projects: {
          '/Users/someone/repo': {
            mcpServers: { 'mightymouse-code': { command: 'npx', args: ['-y', 'mightymouse-code'] } }
          }
        }
      })
    )
    expect(detectMcpClients().find((c) => c.id === 'claude-code')?.configured).toBe(true)
  })

  it('reports configured once the entry is written', () => {
    configureMcpClient('claude-code')
    configureMcpClient('codex')
    expect(detectMcpClients().every((c) => c.configured)).toBe(true)
  })
})

describe('configureMcpClient', () => {
  it('merges into JSON, keeping other servers and unrelated keys', () => {
    expect(configureMcpClient('claude-code')).toEqual({ ok: true })
    const after = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
    expect(after.mcpServers['mightymouse-code']).toEqual({
      command: 'npx',
      args: ['-y', 'mightymouse-code']
    })
    expect(after.mcpServers.sentry).toBeTruthy()
    expect(after.numStartups).toBe(42)
  })

  it('appends a TOML table, keeping existing tables', () => {
    expect(configureMcpClient('codex')).toEqual({ ok: true })
    const after = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(after).toContain('[mcp_servers.mightymouse-code]')
    expect(after).toContain('[mcp_servers.node_repl]')
    expect(after).toContain('[memories]')
    expect(after).toContain('"TMUX_PANE"')
    expect(after).toContain('"CODEX_THREAD_ID"')
  })

  it('backs the original up before writing', () => {
    configureMcpClient('claude-code')
    expect(readFileSync(join(home, '.claude.json.mightymouse-backup'), 'utf8')).toBe(CLAUDE_JSON)
  })

  it('is idempotent — a second run writes nothing new', () => {
    configureMcpClient('codex')
    const once = readFileSync(join(home, '.codex', 'config.toml'), 'utf8')
    expect(configureMcpClient('codex')).toEqual({ ok: true })
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(once)
  })

  it('refuses a client that is not installed', () => {
    const result = configureMcpClient('cursor')
    expect(result.ok).toBe(false)
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false)
  })

  it('refuses corrupt JSON rather than replacing it with a fresh file', () => {
    writeFileSync(join(home, '.claude.json'), '{ this is not json')
    const result = configureMcpClient('claude-code')
    expect(result.ok).toBe(false)
    // Untouched: a "successful" write here would have dropped every other server.
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{ this is not json')
    expect(existsSync(join(home, '.claude.json.mightymouse-backup'))).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })
})

describe('Codex relay environment', () => {
  it('leaves an unconfigured server alone', () => {
    expect(codexRelayArgs()).toEqual([])
  })

  it('forwards the terminal address for an existing server without changing its config', () => {
    const raw = CODEX_TOML + '\n[mcp_servers.mightymouse-code]\ncommand = "node"\nargs = ["local-shim.js"]\nenv_vars = ["CUSTOM_VAR",]\n\n[features]\nhooks = true\n'
    writeFileSync(join(home, '.codex', 'config.toml'), raw)
    const args = codexRelayArgs()
    expect(args[0]).toBe('-c')
    expect(args[1]).toContain('"CUSTOM_VAR",\n"TMUX"')
    expect(args[1]).toContain('"TMUX_PANE"')
    expect(args[1]).toContain('"CODEX_THREAD_ID"')
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(raw)
  })
})
