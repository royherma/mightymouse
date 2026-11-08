import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const PS_ARGS = ['-axo', 'pid=,ppid=,time=,rss=,command=']
const SAMPLE_WINDOW_MS = 1500

export interface RawProcSample {
  pid: number
  ppid: number
  cpuSeconds: number
  rssBytes: number
  command: string
}

export function commBaseName(command: string): string {
  const firstToken = command.split(' ')[0] ?? command
  const base = firstToken.split('/').pop() ?? firstToken
  return base || command
}

export interface ProcDelta {
  pid: number
  ppid: number
  command: string
  cores: number
  memBytes: number
}

function parseTime(time: string): number {
  const parts = time.split(':').map(Number)
  if (parts.some((n) => Number.isNaN(n))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] ?? 0
}

async function runPs(): Promise<Map<number, RawProcSample>> {
  const { stdout } = await execFileAsync('ps', PS_ARGS, { maxBuffer: 8 * 1024 * 1024 })
  const out = new Map<number, RawProcSample>()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const [, pidStr, ppidStr, time, rssStr, command] = match
    out.set(Number(pidStr), {
      pid: Number(pidStr),
      ppid: Number(ppidStr),
      cpuSeconds: parseTime(time),
      rssBytes: Number(rssStr) * 1024,
      command
    })
  }
  return out
}

interface StoredSample {
  at: number
  procs: Map<number, RawProcSample>
}

let previous: StoredSample | null = null

function diff(prev: StoredSample, next: StoredSample): ProcDelta[] {
  const elapsedSec = (next.at - prev.at) / 1000
  if (elapsedSec <= 0) return []
  const deltas: ProcDelta[] = []
  for (const [pid, sample] of next.procs) {
    const before = prev.procs.get(pid)
    if (!before) continue
    const cpuDelta = sample.cpuSeconds - before.cpuSeconds
    deltas.push({
      pid,
      ppid: sample.ppid,
      command: sample.command,
      cores: cpuDelta > 0 ? cpuDelta / elapsedSec : 0,
      memBytes: sample.rssBytes
    })
  }
  return deltas
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function sampleProcesses(): Promise<ProcDelta[]> {
  if (!previous) {
    const first = { at: Date.now(), procs: await runPs() }
    await delay(SAMPLE_WINDOW_MS)
    const second = { at: Date.now(), procs: await runPs() }
    previous = second
    return diff(first, second)
  }
  const next = { at: Date.now(), procs: await runPs() }
  const deltas = diff(previous, next)
  previous = next
  return deltas
}
