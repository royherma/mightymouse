/**
 * One-click MCP client setup (PRD 2026-08-12-1786501335 item 3b) — detect which
 * agent clients exist on this Mac and write our server entry into their config,
 * so the user never opens a config file to use `mightymouse-code`.
 *
 * Every client gets the same stdio command, so there is one entry to write in
 * four file formats. Writes are merge-only and back the original up first: these
 * are files the user's other tools own, and clobbering one breaks every OTHER
 * MCP server they had configured.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpClientId, McpClientState } from '../../shared/types'

const SERVER_KEY = 'mightymouse-code'
const COMMAND = 'npx'
const ARGS = ['-y', 'mightymouse-code']
const CODEX_RELAY_ENV = ['TMUX', 'TMUX_PANE', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CMUX_WORKSPACE_ID', 'CMUX_TAB_ID', 'CMUX_BUNDLE_ID', 'TERM_PROGRAM', '__CFBundleIdentifier']

type Client = {
  id: McpClientId
  label: string
  /** Resolved per call, never at module load — the home dir is not ours to cache. */
  path: () => string
  /** Reads the file and reports whether our entry is already present and correct. */
  isConfigured: (raw: string) => boolean
  /** Returns the full new file contents with our entry merged in. */
  merge: (raw: string) => string
}

function jsonClient(
  id: McpClientId,
  label: string,
  path: () => string,
  key: 'mcpServers' | 'servers'
): Client {
  return {
    id,
    label,
    path,
    // Claude Code writes a per-PROJECT bucket for anything added without
    // `--scope user`, so a root-only check reports "not set up" on a machine
    // that has been using the relay for weeks.
    isConfigured: (raw) => {
      const root = safeParseJson(raw)
      if (!root) return false
      if (root[key]?.[SERVER_KEY]?.command === COMMAND) return true
      const projects = root.projects
      if (!projects || typeof projects !== 'object') return false
      return Object.values(projects).some(
        (p: any) => p?.[key]?.[SERVER_KEY]?.command === COMMAND
      )
    },
    merge: (raw) => {
      // Unparseable ⇒ refuse. Starting from {} would write a valid file that
      // silently drops every OTHER server the user had configured.
      const root = safeParseJson(raw)
      if (!root) throw new Error(`${label} config isn't valid JSON — fix it and try again.`)
      const bucket = (root[key] ??= {})
      bucket[SERVER_KEY] = { command: COMMAND, args: ARGS }
      // 2-space + trailing newline matches what these clients write themselves,
      // so our merge doesn't show up as a whole-file diff in the user's editor.
      return JSON.stringify(root, null, 2) + '\n'
    }
  }
}

function safeParseJson(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const CODEX_BLOCK =
  `\n[mcp_servers.${SERVER_KEY}]\n` +
  `command = "${COMMAND}"\n` +
  `args = [${ARGS.map((a) => `"${a}"`).join(', ')}]\n` +
  `env_vars = ${JSON.stringify(CODEX_RELAY_ENV)}\n`

export function codexRelayArgs(): string[] {
  const path = join(homedir(), '.codex', 'config.toml')
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8')
  const header = /^\[mcp_servers\.mightymouse-code\][^\n]*\n/m.exec(raw)
  if (!header) return []
  const block = raw.slice(header.index + header[0].length).split(/^\[/m)[0]
  const existing = block.match(/^\s*env_vars\s*=\s*\[([\s\S]*?)\]/m)?.[1]?.trim().replace(/,\s*$/, '') ?? ''
  return ['-c', `mcp_servers.${SERVER_KEY}.env_vars=[${existing ? `${existing},\n` : ''}${CODEX_RELAY_ENV.map((name) => JSON.stringify(name)).join(',')}]`]
}

const CLIENTS: Client[] = [
  jsonClient('claude-code', 'Claude Code', () => join(homedir(), '.claude.json'), 'mcpServers'),
  jsonClient('cursor', 'Cursor', () => join(homedir(), '.cursor', 'mcp.json'), 'mcpServers'),
  jsonClient(
    'vscode',
    'VS Code',
    () => join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    'servers'
  ),
  {
    id: 'codex',
    label: 'Codex',
    path: () => join(homedir(), '.codex', 'config.toml'),
    // Deliberately not a TOML parse: Codex's config is hand-edited and full of
    // comments a round-trip through a parser would drop. A section header match
    // is enough to answer "is ours already here?", and appending is enough to
    // add it -- TOML tables are order-independent.
    isConfigured: (raw) => new RegExp(`^\\[mcp_servers\\.${SERVER_KEY}\\]`, 'm').test(raw),
    merge: (raw) => (raw.endsWith('\n') ? raw : raw + '\n') + CODEX_BLOCK
  }
]

export function opencodeRelayEnv(): Record<string, string> {
  const claudeConfig = join(homedir(), '.claude.json')
  const raw = existsSync(claudeConfig) ? readFileSync(claudeConfig, 'utf8') : ''
  const entry = safeParseJson(raw)?.mcpServers?.[SERVER_KEY]
  const command =
    typeof entry?.command === 'string'
      ? [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
      : [COMMAND, ...ARGS]
  const mcp = { [SERVER_KEY]: { type: 'local', command, enabled: true } }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) }
}

/** Detected clients only — an absent config file means that client isn't installed. */
export function detectMcpClients(): McpClientState[] {
  const found: McpClientState[] = []
  for (const client of CLIENTS) {
    const path = client.path()
    if (!existsSync(path)) continue
    let configured = false
    try {
      configured = client.isConfigured(readFileSync(path, 'utf8'))
    } catch {
      configured = false
    }
    found.push({ id: client.id, label: client.label, path, configured })
  }
  return found
}

export function configureMcpClient(id: McpClientId): { ok: true } | { ok: false; detail: string } {
  const client = CLIENTS.find((c) => c.id === id)
  if (!client) return { ok: false, detail: 'Unknown client.' }
  const path = client.path()
  if (!existsSync(path)) return { ok: false, detail: `${client.label} isn't set up on this Mac.` }

  try {
    const raw = readFileSync(path, 'utf8')
    if (client.isConfigured(raw)) return { ok: true }
    const merged = client.merge(raw)
    copyFileSync(path, `${path}.mightymouse-backup`)
    writeFileSync(path, merged, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
