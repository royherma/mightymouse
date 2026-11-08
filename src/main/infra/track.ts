import { spawnSync } from 'child_process'
import { watch, type FSWatcher } from 'fs'
import { listedAgentSessions } from '../agent-relay/mcp/http-listener'
import { resolveBinary } from '../platform'
import type { InfraRecord, ProjectInfra, SetupState } from '../../shared/infra'
import { sessionIsWorking } from '../../shared/relay-status'
import { checkInfra } from './scan'

const TICK_MS = 4_000
const SCAN_DEBOUNCE_MS = 2_000
const SCAN_MIN_GAP_MS = 30_000
const SCAN_REST_FACTOR = 10
const STARTING_GRACE_MS = 90_000
const WAITING_AFTER_QUIET_MS = 15_000
const IGNORED =
  /(^|\/)(node_modules|\.git|\.mightymouse|dist|out|build|\.wrangler|\.turbo|\.next|\.cache)(\/|$)/

interface Watched {
  repoFolder?: string
  record: InfraRecord | null
  live: Record<string, SetupState>
  watcher: FSWatcher | null
  debounce: NodeJS.Timeout | null
  scanning: boolean
  again: boolean
  nextScanAt: number
}

const watched = new Map<string, Watched>()
let tick: NodeJS.Timeout | null = null
const quietSince = new Map<string, number>()
let publish: (infra: ProjectInfra) => void = () => {}

export function onInfraTracked(fn: (infra: ProjectInfra) => void): void {
  publish = fn
}

function livePanes(): Set<string> | null {
  const tmux = resolveBinary('tmux')
  if (!tmux) return null
  const r = spawnSync(tmux, ['list-panes', '-a', '-F', '#{pane_id}'], {
    encoding: 'utf8',
    timeout: 2_000
  })
  if (r.error) return null
  return new Set(r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [])
}

function quietState(key: string, working: boolean, now: number): SetupState {
  if (working) {
    quietSince.delete(key)
    return 'working'
  }
  const since = quietSince.get(key) ?? now
  quietSince.set(key, since)
  return now - since >= WAITING_AFTER_QUIET_MS ? 'waiting' : 'working'
}

function setupStates(projectId: string, record: InfraRecord | null): Record<string, SetupState> {
  const setups = Object.entries(record?.setups ?? {})
  if (setups.length === 0) return {}
  const panes = setups.some(([, s]) => s.pane) ? livePanes() : null
  const sessions = listedAgentSessions()
  const now = Date.now()
  const out: Record<string, SetupState> = {}
  for (const [kindId, setup] of setups) {
    const matched = setup.pane
      ? sessions.filter((s) => s.origin?.tmuxPane === setup.pane && s.staleSince === undefined)
      : []
    if (matched.length)
      out[kindId] = quietState(
        `${projectId}:${kindId}`,
        matched.some((s) => sessionIsWorking(s, now)),
        now
      )
    else if (setup.pane && panes && !panes.has(setup.pane)) out[kindId] = 'stopped'
    else
      out[kindId] =
        Date.now() - Date.parse(setup.startedAt) < STARTING_GRACE_MS ? 'starting' : 'working'
  }
  return out
}

function stop(projectId: string): void {
  const w = watched.get(projectId)
  if (!w) return
  w.watcher?.close()
  if (w.debounce) clearTimeout(w.debounce)
  watched.delete(projectId)
  if (watched.size === 0 && tick) {
    clearInterval(tick)
    tick = null
  }
}

function scheduleScan(projectId: string): void {
  const w = watched.get(projectId)
  if (!w) return
  if (w.debounce) clearTimeout(w.debounce)
  const wait = Math.max(SCAN_DEBOUNCE_MS, w.nextScanAt - Date.now())
  w.debounce = setTimeout(() => void rescan(projectId), wait)
}

async function rescan(projectId: string): Promise<void> {
  const w = watched.get(projectId)
  if (!w) return
  if (w.scanning) {
    w.again = true
    return
  }
  w.scanning = true
  const started = Date.now()
  try {
    publish(withLive(await checkInfra(projectId)))
  } catch {
    // next file change or tick retries
  } finally {
    w.scanning = false
    const took = Date.now() - started
    w.nextScanAt = Date.now() + Math.max(SCAN_MIN_GAP_MS, took * SCAN_REST_FACTOR)
    if (w.again) {
      w.again = false
      scheduleScan(projectId)
    }
  }
}

function start(infra: ProjectInfra): Watched {
  const w: Watched = {
    repoFolder: infra.repoFolder,
    record: infra.record,
    live: {},
    watcher: null,
    debounce: null,
    scanning: false,
    again: false,
    nextScanAt: 0
  }
  watched.set(infra.projectId, w)
  if (infra.repoFolder) {
    try {
      w.watcher = watch(infra.repoFolder, { recursive: true }, (_event, name) => {
        if (name && IGNORED.test(String(name))) return
        scheduleScan(infra.projectId)
      })
      w.watcher.on('error', () => w.watcher?.close())
    } catch {
      w.watcher = null
    }
  }
  tick ??= setInterval(onTick, TICK_MS)
  return w
}

export function withLive(infra: ProjectInfra): ProjectInfra {
  const live = setupStates(infra.projectId, infra.record)
  if (Object.keys(live).length === 0) {
    stop(infra.projectId)
    return infra
  }
  const w = watched.get(infra.projectId) ?? start(infra)
  w.record = infra.record
  w.repoFolder = infra.repoFolder
  w.live = live
  return { ...infra, live }
}

function onTick(): void {
  for (const [projectId, w] of watched) {
    const live = setupStates(projectId, w.record)
    const turnEnded = Object.entries(live).some(
      ([kindId, state]) => (state === 'waiting' || state === 'stopped') && w.live[kindId] !== state
    )
    if (JSON.stringify(live) !== JSON.stringify(w.live)) {
      w.live = live
      publish({ projectId, repoFolder: w.repoFolder, record: w.record, live })
    }
    if (turnEnded || (!w.watcher && Date.now() >= w.nextScanAt)) void rescan(projectId)
  }
}
