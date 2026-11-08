import { execFile } from 'child_process'
import { cpus, totalmem, uptime } from 'os'
import type { HideoutVitals } from '../shared/hideout'
import { getBatteryStatus } from './platform/macos/battery-status'

const TICK_MS = 1000
const HISTORY = 90
const TOP_EVERY = 3
const SLOW_EVERY = 30
const TOP_N = 3
const GB = 1024 ** 3

type Totals = { idle: number; total: number }

let timer: ReturnType<typeof setInterval> | null = null
let ticks = 0
let lastCpu: Totals | null = null
let lastNet: { at: number; rx: number; tx: number } | null = null
let iface = 'en0'
let vitals: HideoutVitals = blank()

function blank(): HideoutVitals {
  const list = cpus()
  return {
    chip: list[0]?.model.replace(/^Apple /, '') ?? 'Mac',
    cores: list.length,
    uptimeS: uptime(),
    cpu: [],
    memUsedGb: 0,
    memTotalGb: totalmem() / GB,
    netDown: 0,
    netUp: 0,
    wifi: null,
    battery: { percent: null, charging: true },
    top: []
  }
}

function run(cmd: string, args: string[], timeout = 2000): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout, encoding: 'utf8' }, (_e, out) => resolve(out ?? '')))
}

function cpuTotals(): Totals {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idle, total }
}

function sampleCpu(): void {
  const now = cpuTotals()
  if (lastCpu && now.total > lastCpu.total) {
    const busy = 100 * (1 - (now.idle - lastCpu.idle) / (now.total - lastCpu.total))
    vitals.cpu = [...vitals.cpu, Math.max(0, Math.min(100, busy))].slice(-HISTORY)
  }
  lastCpu = now
}

async function sampleNet(): Promise<void> {
  const row = (await run('netstat', ['-ib', '-I', iface])).split('\n').find((l) => l.includes('<Link#'))
  const cols = row?.trim().split(/\s+/)
  if (!cols || cols.length < 10) return
  const rx = Number(cols[cols.length - 5])
  const tx = Number(cols[cols.length - 2])
  const at = Date.now()
  if (lastNet && at > lastNet.at) {
    const s = (at - lastNet.at) / 1000
    vitals.netDown = Math.max(0, (rx - lastNet.rx) / s)
    vitals.netUp = Math.max(0, (tx - lastNet.tx) / s)
  }
  lastNet = { at, rx, tx }
}

async function sampleMemory(): Promise<void> {
  const out = await run('vm_stat', [])
  const page = Number(out.match(/page size of (\d+)/)?.[1] ?? 16384)
  const pages = (label: string): number => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0)
  vitals.memUsedGb = ((pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page) / GB
}

async function sampleTop(): Promise<void> {
  const by = new Map<string, number>()
  for (const line of (await run('ps', ['-Aceo', 'pcpu,comm', '-r'])).split('\n').slice(1, 40)) {
    const m = line.trim().match(/^([\d.]+)\s+(.+)$/)
    if (m && m[2] !== 'ps') by.set(m[2], (by.get(m[2]) ?? 0) + Number(m[1]))
  }
  vitals.top = [...by]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([name, pct]) => ({ name, pct: pct / vitals.cores }))
}

async function sampleWifi(): Promise<void> {
  const out = await run('system_profiler', ['SPAirPortDataType'], 10_000)
  const current = out.split('Current Network Information:')[1]?.split('Other Local Wi-Fi Networks:')[0]
  const rssi = current?.match(/Signal \/ Noise:\s+(-?\d+) dBm/)
  vitals.wifi = rssi
    ? {
        rssi: Number(rssi[1]),
        rateMbps: Number(current?.match(/Transmit Rate:\s+(\d+)/)?.[1] ?? 0),
        band: current?.match(/Channel:\s+\d+\s+\((\d+GHz)/)?.[1] ?? ''
      }
    : null
}

async function sampleSlow(): Promise<void> {
  vitals.uptimeS = uptime()
  vitals.battery = getBatteryStatus()
  iface = (await run('route', ['-n', 'get', 'default'])).match(/interface:\s+(\S+)/)?.[1] ?? iface
  await sampleWifi()
}

export function startVitals(onTick: (v: HideoutVitals) => void): void {
  if (timer) return
  vitals = blank()
  lastCpu = cpuTotals()
  lastNet = null
  ticks = 0
  void sampleSlow()
  void sampleTop()
  timer = setInterval(() => {
    ticks++
    sampleCpu()
    const jobs = [sampleNet(), ...(ticks % TOP_EVERY ? [] : [sampleTop(), sampleMemory()]), ...(ticks % SLOW_EVERY ? [] : [sampleSlow()])]
    if (ticks === 1) jobs.push(sampleMemory())
    void Promise.all(jobs).then(() => timer && onTick({ ...vitals, cpu: [...vitals.cpu] }))
  }, TICK_MS)
}

export function stopVitals(): void {
  if (timer) clearInterval(timer)
  timer = null
}
