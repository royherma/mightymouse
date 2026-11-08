import { execFile } from 'child_process'
import { promisify } from 'util'
import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { ResourceRow, ResourceSnapshot } from '../../shared/types'
import { sampleProcesses } from '../resources/sampler'
import { rollupProcesses } from '../resources/rollup'
import { recordFineSample, sparkFor, getTrend, startResourceHistory } from '../resources/history'
import { iconDataUrlFor } from '../resources/icons'
import { getResourcesWindow, setResourcesVisibilityHandler } from '../resources-window'
import { getPanelWindow, showPanelWindow, sendToPanelRenderer } from '../panel-window'
import { PREFS } from '../store/prefs'

const execFileAsync = promisify(execFile)

const FAST_MS = 1000
const SLOW_MS = 30_000
const PRESSURE_MS = 10_000

let cachedTotalCores: number | null = null
let cachedTotalMem: number | null = null

async function getTotalCores(): Promise<number> {
  if (cachedTotalCores !== null) return cachedTotalCores
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.ncpu'])
    cachedTotalCores = parseInt(stdout.trim(), 10) || 1
  } catch {
    cachedTotalCores = 1
  }
  return cachedTotalCores
}

async function getTotalMemBytes(): Promise<number> {
  if (cachedTotalMem !== null) return cachedTotalMem
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'hw.memsize'])
    cachedTotalMem = parseInt(stdout.trim(), 10) || 0
  } catch {
    cachedTotalMem = 0
  }
  return cachedTotalMem
}

async function getMemFreePercent(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('memory_pressure', [])
    const match = stdout.match(/System-wide memory free percentage:\s*(\d+)%/)
    return match ? parseInt(match[1], 10) : null
  } catch {
    return null
  }
}

async function getSwapUsedBytes(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('sysctl', ['vm.swapusage'])
    const match = stdout.match(/used\s*=\s*([\d.]+)M/)
    return match ? Math.round(parseFloat(match[1]) * 1024 * 1024) : null
  } catch {
    return null
  }
}

let watching = false
let running = false
let timer: ReturnType<typeof setTimeout> | null = null
let pressureAt = 0
let pressureInFlight = false
let memFreePercent: number | null = null
let swapUsedBytes: number | null = null
let latestRows: { rows: ResourceRow[]; totalCores: number } | null = null
let latestSnapshot: ResourceSnapshot | null = null
const pushedIcons = new Map<string, string>()

function arm(delay: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void tick()
  }, delay)
}

function takeIcons(rows: ResourceRow[], mode: 'all' | 'delta'): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const url = iconDataUrlFor(row.bundlePath)
    if (!url) continue
    if (mode === 'delta' && pushedIcons.get(row.id) === url) continue
    out[row.id] = url
    pushedIcons.set(row.id, url)
  }
  return Object.keys(out).length ? out : undefined
}

function withIcons(snapshot: ResourceSnapshot, mode: 'all' | 'delta'): ResourceSnapshot {
  const icons = takeIcons(snapshot.rows, mode)
  return icons ? { ...snapshot, icons } : snapshot
}

function push(mode: 'all' | 'delta'): void {
  if (!latestSnapshot) return
  const win = getResourcesWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(CHANNELS.resourcesUpdated, withIcons(latestSnapshot, mode))
}

function maybePressure(): void {
  if (!watching || pressureInFlight) return
  if (Date.now() - pressureAt < PRESSURE_MS) return
  pressureInFlight = true
  pressureAt = Date.now()
  void Promise.all([getMemFreePercent(), getSwapUsedBytes()])
    .then(([mem, swap]) => {
      memFreePercent = mem
      swapUsedBytes = swap
      if (latestSnapshot) latestSnapshot = { ...latestSnapshot, memFreePercent, swapUsedBytes }
    })
    .catch(() => undefined)
    .finally(() => {
      pressureInFlight = false
    })
}

async function sampleFast(): Promise<void> {
  const [procs, totalCores, totalMemBytes] = await Promise.all([
    sampleProcesses(),
    getTotalCores(),
    getTotalMemBytes()
  ])
  const rolled = rollupProcesses(procs)
  latestRows = { rows: rolled, totalCores }
  if (watching) recordFineSample(rolled)
  const rows = rolled.map((row) => {
    const series = sparkFor(row.id)
    return { ...row, spark: series.cores, memSpark: series.mem }
  })
  latestSnapshot = {
    rows,
    totalCores,
    totalMemBytes,
    memFreePercent,
    swapUsedBytes,
    sampledAt: Date.now(),
    trend: getTrend()
  }
}

async function pushFailed(): Promise<void> {
  const win = getResourcesWindow()
  if (!win || win.isDestroyed()) return
  const [totalCores, totalMemBytes] = await Promise.all([getTotalCores(), getTotalMemBytes()])
  win.webContents.send(CHANNELS.resourcesUpdated, {
    rows: [],
    totalCores,
    totalMemBytes,
    memFreePercent,
    swapUsedBytes,
    sampledAt: 0,
    trend: [],
    failed: true
  } satisfies ResourceSnapshot)
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    await sampleFast()
    if (watching) push('delta')
    maybePressure()
  } catch {
    if (watching && !latestSnapshot) await pushFailed()
  } finally {
    running = false
    arm(watching ? FAST_MS : SLOW_MS)
  }
}

function setWatching(open: boolean): void {
  watching = open
  if (open && latestSnapshot) push('all')
  maybePressure()
  if (!running) arm(0)
}

async function cachedOrEmpty(): Promise<ResourceSnapshot> {
  if (latestSnapshot) return withIcons(latestSnapshot, 'all')
  if (!running) arm(0)
  const [totalCores, totalMemBytes] = await Promise.all([getTotalCores(), getTotalMemBytes()])
  return {
    rows: [],
    totalCores,
    totalMemBytes,
    memFreePercent,
    swapUsedBytes,
    sampledAt: 0,
    trend: []
  }
}

export function startResourceRecording(): void {
  setResourcesVisibilityHandler(setWatching)
  const win = getResourcesWindow()
  if (win && !win.isDestroyed() && win.isVisible()) setWatching(true)
  else if (!running) arm(0)
  startResourceHistory(() => latestRows)
}

export function registerResourcesIpc(): void {
  ipcMain.handle(CHANNELS.resourcesSnapshot, (): Promise<ResourceSnapshot> => cachedOrEmpty())
  ipcMain.handle(CHANNELS.resourcesAsk, (_e, text: unknown) => {
    const q = typeof text === 'string' ? text.trim() : ''
    if (!q) return
    PREFS.setDraftInput(q)
    PREFS.setLastMode('ask')
    const existed = getPanelWindow()
    showPanelWindow('other')
    const push = (): void => sendToPanelRenderer(CHANNELS.resourcesAskDraft, q)
    if (existed && !existed.isDestroyed()) push()
    setTimeout(push, 700)
    setTimeout(push, 1600) // after panel init, which can restore a saved action over this draft
  })
}
