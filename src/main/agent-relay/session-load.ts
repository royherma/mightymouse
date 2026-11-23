import { execFile } from 'node:child_process'
import { cpus } from 'node:os'
import { promisify } from 'node:util'
import type { SessionLoad } from '../../shared/types'
import { liveAgentSessions, type AgentSession } from './mcp/http-listener'

const run = promisify(execFile)
const TOP_PROCS = 3
const CACHE_MS = 1500

interface Proc {
  pid: number
  ppid: number
  cpu: number
  rssKb: number
  name: string
}

let cached: { at: number; value: Promise<Record<string, SessionLoad>> } | null = null

async function processTable(): Promise<Map<number, Proc>> {
  const { stdout } = await run('ps', ['-Aceo', 'pid=,ppid=,pcpu=,rss=,comm='], { maxBuffer: 8 * 1024 * 1024 })
  const table = new Map<number, Proc>()
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const pid = Number(m[1])
    table.set(pid, { pid, ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), name: m[5] })
  }
  return table
}

function childrenOf(table: Map<number, Proc>): Map<number, number[]> {
  const kids = new Map<number, number[]>()
  for (const p of table.values()) {
    const list = kids.get(p.ppid)
    if (list) list.push(p.pid)
    else kids.set(p.ppid, [p.pid])
  }
  return kids
}

// The shim's `pid` is the MCP proxy `claude` spawned, so its parent is the agent.
function agentRoot(session: AgentSession, table: Map<number, Proc>): number | undefined {
  const facts = session.facts
  if (facts?.agentPid !== undefined && table.has(facts.agentPid)) return facts.agentPid
  if (facts?.pid !== undefined) return table.get(facts.pid)?.ppid
  return undefined
}

function treeOf(root: number, kids: Map<number, number[]>, table: Map<number, Proc>): Proc[] {
  const out: Proc[] = []
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const proc = table.get(pid)
    if (proc) out.push(proc)
    for (const k of kids.get(pid) ?? []) stack.push(k)
  }
  return out
}

function loadOf(tree: Proc[], cores: number): SessionLoad {
  const [agent, ...started] = tree
  const byName = new Map<string, { cpu: number; rssKb: number; count: number }>()
  for (const p of started) {
    const name = p.name.split('/').pop() || p.name
    const row = byName.get(name) ?? { cpu: 0, rssKb: 0, count: 0 }
    row.cpu += p.cpu
    row.rssKb += p.rssKb
    row.count += 1
    byName.set(name, row)
  }
  const share = (pct: number): number => Math.round((pct / cores) * 10) / 10
  return {
    cpuPct: share(tree.reduce((n, p) => n + p.cpu, 0)),
    memMb: Math.round(tree.reduce((n, p) => n + p.rssKb, 0) / 1024),
    agentCpuPct: share(agent?.cpu ?? 0),
    started: started.length,
    top: [...byName]
      .sort((a, b) => b[1].cpu - a[1].cpu || b[1].rssKb - a[1].rssKb)
      .slice(0, TOP_PROCS)
      .map(([name, r]) => ({ name, count: r.count, cpuPct: share(r.cpu), memMb: Math.round(r.rssKb / 1024) }))
  }
}

async function sample(): Promise<Record<string, SessionLoad>> {
  const live = liveAgentSessions().filter((s) => s.sessionId)
  if (live.length === 0) return {}
  const table = await processTable()
  const kids = childrenOf(table)
  const cores = Math.max(1, cpus().length)
  const out: Record<string, SessionLoad> = {}
  for (const s of live) {
    const root = agentRoot(s, table)
    if (root === undefined || root <= 1) continue
    out[s.sessionId as string] = loadOf(treeOf(root, kids, table), cores)
  }
  return out
}

export function sessionLoads(): Promise<Record<string, SessionLoad>> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_MS) return cached.value
  const value = sample().catch(() => ({}))
  cached = { at: now, value }
  return value
}
