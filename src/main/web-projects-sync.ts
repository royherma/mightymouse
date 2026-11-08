import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { BrowserWindow } from 'electron'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { CHANNELS } from '../shared/ipc'
import { cleanBrief, type ProjectBrief } from '../shared/infra'
import type { MightyProject } from '../shared/types'
import { withTimeout } from './auth'
import { readRecord, setInfraBrief } from './infra/scan'
import { projectImageBase64 } from './ipc/phone-remote-chat'
import { getSupabase } from './supabase'
import { MIGHTY, onProjectsWritten } from './store/mighty'
import { PATHS } from './store/paths'
import { PREFS } from './store/prefs'
import { readSyncedIds, writeSyncedIds } from './web-chat-sync'

const FALLBACK_INTERVAL_MS = 5 * 60_000
const DEBOUNCE_MS = 800
const REQUEST_TIMEOUT_MS = 8_000
const RETRY_DELAY_MS = 15_000

interface ProjectRow {
  id: string
  user_id: string
  name: string
  icon: string | null
  default_model: string | null
  repo_name: string | null
  image_url: string | null
  instructions: string | null
  brief: ProjectBrief | null
  archived: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
}

type PushRow = Omit<ProjectRow, 'deleted_at'>
type Newer = 'local' | 'remote' | 'same'

const MAX_INSTRUCTIONS_CHARS = 4000

// null/undefined means that side never had a value, so the other side fills it; '' or {} is a deliberate clear and competes like any value.
export function mergeField<T>(
  local: T | undefined,
  remote: T | null,
  newer: Newer,
  same: (a: T, b: T) => boolean
): { value: T | null; push: boolean; pull: boolean } {
  const mine = local ?? null
  if (mine === null || remote === null || same(mine, remote)) {
    return { value: mine ?? remote, push: remote === null && mine !== null, pull: mine === null && remote !== null }
  }
  if (newer === 'same') return { value: remote, push: false, pull: false }
  return newer === 'local' ? { value: mine, push: true, pull: false } : { value: remote, push: false, pull: true }
}

function sameBrief(a: ProjectBrief, b: ProjectBrief): boolean {
  return JSON.stringify(cleanBrief(a) ?? {}) === JSON.stringify(cleanBrief(b) ?? {})
}

async function localBrief(project: MightyProject): Promise<ProjectBrief | undefined> {
  if (!project.repoFolder) return undefined
  return (await readRecord(project.repoFolder).catch(() => null))?.brief
}

let interval: ReturnType<typeof setInterval> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
let running = false
let rerun = false
let applyingRemote = false
let channel: RealtimeChannel | null = null
let channelUserId: string | null = null

const MAX_IMAGE_URL_CHARS = 100_000

function imageUrl(path: string | undefined): string | null {
  if (!path) return null
  if (extname(path).toLowerCase() !== '.svg') {
    const png = projectImageBase64(path)
    return png ? `data:image/png;base64,${png}` : null
  }
  try {
    const url = `data:image/svg+xml;base64,${readFileSync(path).toString('base64')}`
    return url.length <= MAX_IMAGE_URL_CHARS ? url : null
  } catch {
    return null
  }
}

function toRow(project: MightyProject, userId: string, brief: ProjectBrief | null): PushRow {
  return {
    id: project.id,
    user_id: userId,
    name: project.name.slice(0, 120),
    icon: project.icon?.slice(0, 32) ?? null,
    default_model: project.defaultModel ?? null,
    repo_name: project.repoFolder ? basename(project.repoFolder).slice(0, 200) : null,
    image_url: imageUrl(project.imagePath),
    instructions: project.systemPrompt?.slice(0, MAX_INSTRUCTIONS_CHARS) ?? null,
    brief,
    archived: project.archived === true,
    created_at: project.created,
    updated_at: project.updated
  }
}

function fromRow(row: ProjectRow, local?: MightyProject): MightyProject {
  return {
    ...local,
    id: row.id,
    name: row.name,
    created: local?.created ?? row.created_at,
    updated: row.updated_at,
    icon: row.icon ?? local?.icon,
    defaultModel: row.default_model ?? undefined,
    systemPrompt: row.instructions ?? local?.systemPrompt,
    archived: row.archived
  }
}

function broadcastProjectsChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.mightyProjectsChanged)
  }
}

async function signedInUserId(): Promise<string | null> {
  const session = await withTimeout(getSupabase().auth.getSession(), REQUEST_TIMEOUT_MS, null)
  return session?.data.session?.user.id ?? null
}

function subscribe(userId: string): void {
  if (channelUserId === userId && channel) return
  void channel?.unsubscribe()
  channelUserId = userId
  channel = getSupabase()
    .channel(`user-projects-${userId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_projects', filter: `user_id=eq.${userId}` }, () => scheduleProjectsSync())
    .subscribe()
}

async function reconcile(): Promise<boolean> {
  if (PREFS.getIncognito()) return true
  const userId = await signedInUserId()
  if (!userId) return true
  subscribe(userId)

  const supabase = getSupabase()
  const { data, error } = await supabase.from('user_projects').select('*')
    .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  if (error) {
    console.warn('[web-projects-sync] fetch failed:', error.message)
    return false
  }
  const remote = new Map((data as ProjectRow[]).map((row) => [row.id, row]))
  const { mine: synced, others } = readSyncedIds(PATHS.WEB_PROJECTS_SYNCED, userId)
  const local = MIGHTY.listProjects().filter((p) => !others.has(p.id))
  const localIds = new Set(local.map((p) => p.id))
  const briefs = new Map(await Promise.all(local.map(async (p) => [p.id, await localBrief(p)] as const)))
  const push: PushRow[] = []
  const tombstones: Array<Pick<ProjectRow, 'id' | 'user_id' | 'name' | 'updated_at' | 'deleted_at'>> = []
  const briefPulls: Array<[string, ProjectBrief]> = []
  let changedLocal = false

  applyingRemote = true
  try {
    for (const project of local) {
      const row = remote.get(project.id)
      if (!row) {
        push.push(toRow(project, userId, briefs.get(project.id) ?? null))
        continue
      }
      if (row.deleted_at) {
        changedLocal = MIGHTY.deleteProject(project.id) || changedLocal
        continue
      }
      const mine = Date.parse(project.updated)
      const theirs = Date.parse(row.updated_at)
      const newer: Newer = mine > theirs ? 'local' : mine < theirs ? 'remote' : 'same'
      const context = mergeField(project.systemPrompt?.slice(0, MAX_INSTRUCTIONS_CHARS), row.instructions ?? null, newer, (a, b) => a === b)
      const had = briefs.get(project.id)
      const about = mergeField(had, row.brief ?? null, newer, sameBrief)
      if (about.pull && about.value && project.repoFolder && (had || cleanBrief(about.value))) briefPulls.push([project.id, about.value])

      let current = project
      if (newer === 'remote') current = fromRow(row, project)
      else if (context.pull) current = { ...project, systemPrompt: context.value ?? undefined }
      if (current !== project) changedLocal = MIGHTY.upsertProject(current) !== null || changedLocal

      const next = toRow(current, userId, about.value)
      const drifted = newer === 'same' && (next.icon !== row.icon || next.image_url !== row.image_url)
      if (newer === 'local' || drifted || context.push || about.push) push.push({ ...next, instructions: context.value })
    }
    for (const row of remote.values()) {
      if (localIds.has(row.id) || row.deleted_at) continue
      if (synced.has(row.id)) {
        const now = new Date().toISOString()
        tombstones.push({ id: row.id, user_id: row.user_id, name: row.name, updated_at: now, deleted_at: now })
      } else {
        changedLocal = MIGHTY.upsertProject(fromRow(row)) !== null || changedLocal
      }
    }
  } finally {
    applyingRemote = false
  }
  for (const [id, brief] of briefPulls) await setInfraBrief(id, brief).catch(() => null)

  // One upsert per key set: PostgREST nulls every column a row in a mixed batch leaves out, which would wipe github_repo.
  let pushOk = true
  const batches: Array<Record<string, unknown>[]> = [push, tombstones]
  for (const batch of batches) {
    if (!batch.length) continue
    const { error: pushError } = await supabase.from('user_projects').upsert(batch, { onConflict: 'id' })
      .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
    if (pushError) {
      console.warn('[web-projects-sync] push failed:', pushError.message)
      pushOk = false
    }
  }
  writeSyncedIds(PATHS.WEB_PROJECTS_SYNCED, userId, MIGHTY.listProjects().map((p) => p.id).filter((id) => !others.has(id)))
  if (changedLocal) broadcastProjectsChanged()
  return pushOk
}

let retryTimer: ReturnType<typeof setTimeout> | null = null

async function run(): Promise<void> {
  if (running) {
    rerun = true
    return
  }
  running = true
  let ok = true
  try {
    do {
      rerun = false
      ok = await reconcile()
    } while (rerun)
  } catch (error) {
    console.warn('[web-projects-sync] sync failed:', error)
    ok = false
  } finally {
    running = false
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (!ok && interval !== null) {
    retryTimer = setTimeout(() => {
      retryTimer = null
      void run()
    }, RETRY_DELAY_MS)
  }
}

export function scheduleProjectsSync(): void {
  if (interval === null) return
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    void run()
  }, DEBOUNCE_MS)
}

let authSubscription: { unsubscribe: () => void } | null = null

export function startWebProjectsSync(): void {
  if (interval !== null) return
  interval = setInterval(() => void run(), FALLBACK_INTERVAL_MS)
  onProjectsWritten(() => {
    if (applyingRemote) return
    broadcastProjectsChanged()
    scheduleProjectsSync()
  })
  authSubscription?.unsubscribe()
  authSubscription = getSupabase().auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') scheduleProjectsSync()
  }).data.subscription
  void run()
}

export function stopWebProjectsSync(): void {
  if (interval === null) return
  clearInterval(interval)
  interval = null
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  void channel?.unsubscribe()
  channel = null
  channelUserId = null
  authSubscription?.unsubscribe()
  authSubscription = null
}
