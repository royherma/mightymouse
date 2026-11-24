import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home = ''
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  homedir: () => home
}))

const { addCursorRelay, antigravityHasRelay, relayCommand } = await import('../mcp-clients')

const mcpJson = (): string => join(home, '.cursor', 'mcp.json')

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mm-cursor-mcp-'))
})

describe('addCursorRelay', () => {
  it('adds the MightyMouse server next to the servers the user already had', () => {
    mkdirSync(join(home, '.cursor'))
    writeFileSync(mcpJson(), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: ['--stdio'] } }, theme: 'dark' }))
    addCursorRelay(home)
    const root = JSON.parse(readFileSync(mcpJson(), 'utf8'))
    expect(root.theme).toBe('dark')
    expect(root.mcpServers.github).toEqual({ command: 'gh-mcp', args: ['--stdio'] })
    expect(root.mcpServers['mightymouse-code']).toEqual({ command: 'npx', args: ['-y', 'mightymouse-code'] })
  })

  it('never rewrites a file it cannot parse', () => {
    mkdirSync(join(home, '.cursor'))
    const broken = '{ "mcpServers": { "github": { "command": "gh-mcp", } }'
    writeFileSync(mcpJson(), broken)
    addCursorRelay(home)
    expect(readFileSync(mcpJson(), 'utf8')).toBe(broken)
  })

  it('leaves an existing MightyMouse entry exactly as the user set it', () => {
    mkdirSync(join(home, '.cursor'))
    const mine = JSON.stringify({ mcpServers: { 'mightymouse-code': { command: '/opt/custom/mm', args: [] } } })
    writeFileSync(mcpJson(), mine)
    addCursorRelay(home)
    expect(readFileSync(mcpJson(), 'utf8')).toBe(mine)
  })

  it('creates ~/.cursor/mcp.json when Cursor has never written one', () => {
    addCursorRelay(home)
    expect(existsSync(mcpJson())).toBe(true)
    expect(JSON.parse(readFileSync(mcpJson(), 'utf8')).mcpServers['mightymouse-code'].command).toBe('npx')
  })

  it('uses the command the user configured for Claude Code, not the default', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'mightymouse-code': { command: '/usr/local/bin/mm-dev', args: ['--port', '9'] } } }))
    expect(relayCommand()).toEqual(['/usr/local/bin/mm-dev', '--port', '9'])
    addCursorRelay(home)
    expect(JSON.parse(readFileSync(mcpJson(), 'utf8')).mcpServers['mightymouse-code']).toEqual({ command: '/usr/local/bin/mm-dev', args: ['--port', '9'] })
  })
})

describe('antigravityHasRelay', () => {
  it('is true only when the server is in Antigravity mcp_config.json', () => {
    expect(antigravityHasRelay(home)).toBe(false)
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { other: {} } }))
    expect(antigravityHasRelay(home)).toBe(false)
    writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'mightymouse-code': { command: 'npx' } } }))
    expect(antigravityHasRelay(home)).toBe(true)
  })
})
