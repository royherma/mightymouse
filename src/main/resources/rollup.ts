import { CONFIG } from '../../shared/config'
import type { ResourceRow } from '../../shared/types'
import { commBaseName, type ProcDelta } from './sampler'

const MIN_CORES = 0.02
const MIN_BYTES = 50 * 1024 * 1024
const MAX_ROWS = 40

const DAEMON_NAMES: Record<string, { name: string; detail: string }> = {
  mds: { name: 'Spotlight indexing', detail: 'macOS' },
  mds_stores: { name: 'Spotlight indexing', detail: 'macOS' },
  mdworker: { name: 'Spotlight indexing', detail: 'macOS' },
  kernel_task: { name: 'macOS system', detail: 'macOS' },
  WindowServer: { name: 'macOS windows', detail: 'macOS' },
  backupd: { name: 'Time Machine', detail: 'macOS' }
}

interface AppRef {
  name: string
  bundlePath: string
}

function appNameFromCommand(command: string): string | null {
  const match = command.match(/\/([^/]+)\.app\//)
  if (!match) return null
  return match[1]
}

function outermostApp(command: string): AppRef | null {
  const match = command.match(/\/([^/]+)\.app\//)
  if (!match || match.index === undefined) return null
  return { name: match[1], bundlePath: command.slice(0, match.index + match[0].length - 1) }
}

interface Node {
  proc: ProcDelta
  appName: string | null
}

function ownBundlePath(): string | undefined {
  const mark = process.execPath.indexOf('.app/')
  if (mark === -1) return undefined
  return process.execPath.slice(0, mark + 4)
}

function belongsToSelf(proc: ProcDelta, byPid: Map<number, Node>, selfPid: number): boolean {
  let pid = proc.pid
  const seen = new Set<number>()
  while (pid > 0 && !seen.has(pid)) {
    if (pid === selfPid) return true
    seen.add(pid)
    const node = byPid.get(pid)
    if (!node) return false
    pid = node.proc.ppid
  }
  return false
}

function buildApp(proc: ProcDelta, byPid: Map<number, Node>): AppRef | null {
  const own = outermostApp(proc.command)
  if (own) return own

  let current: Node | undefined = byPid.get(proc.pid)
  const seen = new Set<number>()
  while (current) {
    if (seen.has(current.proc.pid)) break
    seen.add(current.proc.pid)
    const parent = byPid.get(current.proc.ppid)
    if (!parent) break
    const parentApp = outermostApp(parent.proc.command)
    if (parentApp) return parentApp
    current = parent
  }
  return null
}

export function rollupProcesses(procs: ProcDelta[], selfPid: number = process.pid): ResourceRow[] {
  const byPid = new Map<number, Node>()
  for (const proc of procs) {
    byPid.set(proc.pid, { proc, appName: appNameFromCommand(proc.command) })
  }

  const groups = new Map<
    string,
    { cores: number; memBytes: number; pids: number[]; bundlePath?: string }
  >()

  for (const proc of procs) {
    const daemon = DAEMON_NAMES[commBaseName(proc.command)]
    const ours = !daemon && belongsToSelf(proc, byPid, selfPid)
    const app = daemon || ours ? null : buildApp(proc, byPid)
    const key = daemon ? daemon.name : ours ? CONFIG.APP_NAME : app?.name ?? commBaseName(proc.command)
    const bundlePath = ours ? ownBundlePath() : app?.bundlePath
    const existing = groups.get(key)
    if (existing) {
      existing.cores += proc.cores
      existing.memBytes += proc.memBytes
      existing.pids.push(proc.pid)
      if (!existing.bundlePath && bundlePath) existing.bundlePath = bundlePath
    } else {
      groups.set(key, {
        cores: proc.cores,
        memBytes: proc.memBytes,
        pids: [proc.pid],
        bundlePath
      })
    }
  }

  const rows: ResourceRow[] = []
  for (const [key, group] of groups) {
    if (group.cores < MIN_CORES && group.memBytes < MIN_BYTES) continue
    const daemon = Object.values(DAEMON_NAMES).find((d) => d.name === key)
    rows.push({
      id: key,
      name: key,
      detail: daemon?.detail,
      cores: group.cores,
      memBytes: group.memBytes,
      pids: group.pids,
      bundlePath: group.bundlePath,
      spark: [],
      memSpark: []
    })
  }

  rows.sort((a, b) => b.cores - a.cores)
  return rows.slice(0, MAX_ROWS)
}
