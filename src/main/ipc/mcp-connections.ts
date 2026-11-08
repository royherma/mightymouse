import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { ipcMain, shell } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type {
  McpActionResult,
  McpConnection,
  McpHealthRow,
  McpSaveRequest,
  McpScope,
  McpServerSpec,
  McpStatus
} from '../../shared/types'
import { resolveClaude } from '../platform'

const HEALTH_TTL_MS = 60_000
const HEALTH_TIMEOUT_MS = 45_000
const WRITE_TIMEOUT_MS = 20_000
const LOGIN_TIMEOUT_MS = 5 * 60_000

type RawServer = {
  type?: string
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}
type ServerMap = Record<string, RawServer> | undefined

const healthCache = new Map<string, { at: number; rows: Promise<McpHealthRow[]> }>()

function runClaude(args: string[], cwd: string, timeout: number, tty = false): Promise<{ ok: boolean; out: string }> {
  const bin = resolveClaude()
  if (!bin) return Promise.resolve({ ok: false, out: 'Claude Code is not installed.' })
  const [file, argv] = tty ? ['/usr/bin/script', ['-q', '/dev/null', bin, ...args]] : [bin, args]
  return new Promise((resolve) => {
    execFile(file, argv, { cwd: cwd || homedir(), timeout, env: process.env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('[mcp-sdk]'))
        .join('\n')
      resolve({ ok: !err, out })
    })
  })
}

function toSpec(raw: RawServer): McpServerSpec {
  const transport = raw.type === 'http' || raw.type === 'sse' ? raw.type : raw.url ? 'http' : 'stdio'
  return transport === 'stdio'
    ? { transport, command: raw.command ?? '', args: raw.args ?? [], env: raw.env ?? {} }
    : { transport, url: raw.url ?? '', headers: raw.headers ?? {} }
}

function toRaw(spec: McpServerSpec): RawServer {
  if (spec.transport === 'stdio') {
    return { type: 'stdio', command: spec.command, args: spec.args ?? [], env: spec.env ?? {} }
  }
  const raw: RawServer = { type: spec.transport, url: spec.url }
  if (spec.headers && Object.keys(spec.headers).length > 0) raw.headers = spec.headers
  return raw
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function rows(map: ServerMap, scope: McpScope): McpConnection[] {
  return Object.entries(map ?? {}).map(([name, raw]) => ({ name, scope, spec: toSpec(raw) }))
}

export async function listMcpConnections(cwd: string): Promise<McpConnection[]> {
  const global = await readJson(join(homedir(), '.claude.json'))
  const projects = (global?.projects ?? {}) as Record<string, { mcpServers?: ServerMap }>
  const shared = cwd ? await readJson(join(cwd, '.mcp.json')) : undefined
  return [
    ...rows(cwd ? projects[cwd]?.mcpServers : undefined, 'local'),
    ...rows(shared?.mcpServers as ServerMap, 'project'),
    ...rows(global?.mcpServers as ServerMap, 'user')
  ]
}

function statusOf(mark: string, text: string): McpStatus {
  if (mark === '✔') return 'connected'
  if (mark === '⏸') return 'pending-approval'
  if (/auth/i.test(text)) return 'needs-login'
  return 'failed'
}

export function parseMcpList(out: string): McpHealthRow[] {
  const found: McpHealthRow[] = []
  for (const line of out.split('\n')) {
    const m = /^(.+?): (.+) - ([✔✗!⏸])\s*(.*)$/u.exec(line.trim())
    if (!m) continue
    found.push({ name: m[1], target: m[2].replace(/ \((HTTP|SSE)\)$/, ''), status: statusOf(m[3], m[4]), detail: m[4] })
  }
  return found
}

function health(cwd: string, fresh: boolean): Promise<McpHealthRow[]> {
  const hit = healthCache.get(cwd)
  if (hit && !fresh && Date.now() - hit.at < HEALTH_TTL_MS) return hit.rows
  const pending = runClaude(['mcp', 'list'], cwd, HEALTH_TIMEOUT_MS).then((r) => parseMcpList(r.out))
  healthCache.set(cwd, { at: Date.now(), rows: pending })
  pending.catch(() => healthCache.delete(cwd))
  return pending
}

function fail(out: string): McpActionResult {
  const line = out.split('\n').find((l) => /error|invalid|already|not found|failed/i.test(l)) ?? out.split('\n')[0]
  return { ok: false, error: line?.trim() || 'Claude Code did not accept that.' }
}

async function remove(cwd: string, name: string, scope: McpScope): Promise<McpActionResult> {
  const r = await runClaude(['mcp', 'remove', '-s', scope, name], cwd, WRITE_TIMEOUT_MS)
  return r.ok ? { ok: true } : fail(r.out)
}

async function save(req: McpSaveRequest): Promise<McpActionResult> {
  const before = req.previous ? (await listMcpConnections(req.cwd)).find(
    (c) => c.name === req.previous?.name && c.scope === req.previous?.scope
  ) : undefined
  if (req.previous) {
    const gone = await remove(req.cwd, req.previous.name, req.previous.scope)
    if (!gone.ok) return gone
  }
  const add = await runClaude(['mcp', 'add-json', '-s', req.scope, req.name, JSON.stringify(toRaw(req.spec))], req.cwd, WRITE_TIMEOUT_MS)
  if (add.ok) return { ok: true }
  if (before && req.previous) {
    await runClaude(['mcp', 'add-json', '-s', req.previous.scope, before.name, JSON.stringify(toRaw(before.spec))], req.cwd, WRITE_TIMEOUT_MS)
  }
  return fail(add.out)
}

export function registerMcpConnectionsIpc(): void {
  ipcMain.handle(CHANNELS.mcpList, (_e, cwd: string) => listMcpConnections(cwd))
  ipcMain.handle(CHANNELS.mcpHealth, (_e, cwd: string, fresh?: boolean) => health(cwd, Boolean(fresh)))
  ipcMain.handle(CHANNELS.mcpSave, async (_e, req: McpSaveRequest) => {
    const result = await save(req)
    healthCache.delete(req.cwd)
    return result
  })
  ipcMain.handle(CHANNELS.mcpRemove, async (_e, cwd: string, name: string, scope: McpScope) => {
    const result = await remove(cwd, name, scope)
    healthCache.delete(cwd)
    return result
  })
  ipcMain.handle(CHANNELS.mcpLogin, async (_e, cwd: string, name: string): Promise<McpActionResult> => {
    const r = await runClaude(['mcp', 'login', name], cwd, LOGIN_TIMEOUT_MS, true)
    healthCache.delete(cwd)
    return r.ok ? { ok: true } : fail(r.out)
  })
  ipcMain.handle(CHANNELS.mcpOpenClaudeConnectors, () => shell.openExternal('https://claude.ai/settings/connectors'))
}
