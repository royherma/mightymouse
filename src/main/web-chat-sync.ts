import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { MightySession, MightyTurn } from '../shared/types'
import { withTimeout } from './auth'
import { broadcastMightyTurnAppended } from './mighty/broadcast'
import { getSupabase } from './supabase'
import { MIGHTY, onSessionsWritten } from './store/mighty'
import { PATHS } from './store/paths'
import { PREFS } from './store/prefs'
import { SETTINGS } from './store/settings'

const FALLBACK_INTERVAL_MS = 5 * 60_000
const DEBOUNCE_MS = 800
const REQUEST_TIMEOUT_MS = 8_000
const RETRY_DELAY_MS = 15_000
const MAX_PUSHED_SESSIONS = 200
const REMOTE_PAGE = 1000
const MAX_PROMPT_CHARS = 20_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ConversationRow {
  id: string
  title: string
  project_id: string | null
  created_at: string
  updated_at: string
  source: 'web' | 'mac'
}

interface RunRow {
  id: string
  prompt: string
  response: string | null
  resolved_model: string | null
  status: 'running' | 'complete' | 'failed'
  created_at: string
  source: 'web' | 'mac'
}

let interval: ReturnType<typeof setInterval> | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let running = false
let rerun = false
let applyingRemote = false
let channel: RealtimeChannel | null = null
let channelUserId: string | null = null

const LEGACY_OWNER = ''
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []

function readSyncedFile(path: string): Record<string, string[]> {
  try {
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (Array.isArray(raw)) return { [LEGACY_OWNER]: strings(raw) }
    if (raw && typeof raw === 'object') return Object.fromEntries(Object.entries(raw).map(([owner, ids]) => [owner, strings(ids)]))
  } catch {}
  return {}
}

// Keyed by account: a second account signing in on this Mac must not read the first one's ids as "deleted remotely".
export function readSyncedIds(path: string, userId: string): { mine: Set<string>; others: Set<string> } {
  const file = readSyncedFile(path)
  const others = Object.entries(file).filter(([owner]) => owner !== userId && owner !== LEGACY_OWNER).flatMap(([, ids]) => ids)
  return { mine: new Set(file[userId] ?? file[LEGACY_OWNER] ?? []), others: new Set(others) }
}

export function writeSyncedIds(path: string, userId: string, ids: Iterable<string>): void {
  const file = readSyncedFile(path)
  delete file[LEGACY_OWNER]
  file[userId] = [...ids]
  try {
    writeFileSync(path, JSON.stringify(file), { encoding: 'utf-8', mode: 0o600 })
  } catch (error) {
    console.warn('[web-sync] could not save synced ids:', error)
  }
}

const toSecond = (iso: string): string => new Date(iso).toISOString().replace(/\.\d+Z$/, 'Z')
const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000)
const lastChange = (session: MightySession): string => session.renamed && session.renamed > session.updated ? session.renamed : session.updated

function turnRunId(sessionId: string, turn: MightyTurn): string {
  if (turn.run_id && UUID.test(turn.run_id)) return turn.run_id.toLowerCase()
  const hex = createHash('sha256').update(`${sessionId}|${turn.ts}|${turn.q}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function pushableTurns(session: MightySession): MightyTurn[] {
  return session.turns.filter((turn) => {
    if (!turn.q?.trim()) return false
    if (session.runId && turn.run_id === session.runId) return false
    return Boolean(turn.a) || turn.ok === false
  })
}

function conversationTitle(session: MightySession): string {
  const title = (session.title || session.turns[0]?.q || '').trim().replace(/\s+/g, ' ')
  return (title || 'New chat').slice(0, 120)
}

async function signedInUserId(): Promise<string | null> {
  const session = await withTimeout(getSupabase().auth.getSession(), REQUEST_TIMEOUT_MS, null)
  return session?.data.session?.user.id ?? null
}

function subscribe(userId: string): void {
  if (channelUserId === userId && channel) return
  void channel?.unsubscribe()
  channelUserId = userId
  const filter = `user_id=eq.${userId}`
  channel = getSupabase()
    .channel(`web-chat-${userId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'web_chat_conversations', filter }, () => scheduleChatSync())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'web_chat_runs', filter }, () => scheduleChatSync())
    .subscribe()
}

function unsubscribe(): void {
  void channel?.unsubscribe()
  channel = null
  channelUserId = null
}

async function fetchRuns(conversationId: string): Promise<RunRow[] | null> {
  const { data, error } = await getSupabase().from('web_chat_runs')
    .select('id,prompt,response,resolved_model,status,created_at,source')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  if (error) {
    console.warn('[web-chat-sync] runs fetch failed:', error.message)
    return null
  }
  return data as RunRow[]
}

async function push(session: MightySession, row: ConversationRow | undefined, userId: string, projectIds: Set<string>): Promise<boolean> {
  const supabase = getSupabase()
  const projectId = session.projectId && projectIds.has(session.projectId) ? session.projectId : null
  const title = conversationTitle(session)
  const conversation = row
    ? await supabase.from('web_chat_conversations')
      .update({ title, project_id: projectId, updated_at: lastChange(session) })
      .eq('id', session.id)
    : await supabase.from('web_chat_conversations').insert({
      id: session.id, user_id: userId, title, project_id: projectId,
      created_at: session.created, updated_at: lastChange(session), source: 'mac'
    })
  if (conversation.error) {
    console.warn('[web-chat-sync] conversation push failed:', conversation.error.message)
    return false
  }

  const remote = row ? await fetchRuns(session.id) : []
  if (!remote) return false
  const remoteById = new Map(remote.map((run) => [run.id, run]))
  const localIds = new Set<string>()
  let ok = true
  for (const turn of pushableTurns(session)) {
    const id = turnRunId(session.id, turn)
    localIds.add(id)
    const fields = {
      prompt: turn.q.slice(0, MAX_PROMPT_CHARS),
      response: turn.a || null,
      resolved_model: turn.model ?? null,
      status: turn.ok === false ? 'failed' : 'complete'
    } as const
    const existing = remoteById.get(id)
    if (existing?.source === 'web') continue
    const result = existing
      ? existing.prompt === fields.prompt && existing.response === fields.response &&
        existing.status === fields.status && existing.resolved_model === fields.resolved_model
        ? null
        : await supabase.from('web_chat_runs').update(fields).eq('id', id)
      : await supabase.from('web_chat_runs').insert({
        ...fields, id, conversation_id: session.id, user_id: userId, client_request_id: id,
        requested_model: turn.model ?? null, created_at: turn.ts, finished_at: turn.ts, source: 'mac'
      })
    if (result?.error) {
      console.warn('[web-chat-sync] run push failed:', result.error.message)
      ok = false
    }
  }
  const stale = remote.filter((run) => run.source === 'mac' && !localIds.has(run.id)).map((run) => run.id)
  if (stale.length) {
    const { error } = await supabase.from('web_chat_runs').delete().in('id', stale)
    if (error) ok = false
  }
  const known = new Set(session.turns.map((turn) => turnRunId(session.id, turn)))
  if (row && remote.some((run) => run.source === 'web' && run.status !== 'running' && !known.has(run.id))) {
    ok = (await pull({ ...row, title: session.title, project_id: projectId, updated_at: session.updated }, session, projectIds)) && ok
  }
  return ok
}

async function pull(row: ConversationRow, local: MightySession | undefined, projectIds: Set<string>): Promise<boolean> {
  const runs = await fetchRuns(row.id)
  if (!runs) return false
  const localTurns = new Map((local?.turns ?? []).map((turn) => [turnRunId(row.id, turn), turn]))
  const remoteIds = new Set(runs.map((run) => run.id))
  const turns: MightyTurn[] = []
  for (const run of runs) {
    if (run.status === 'running') continue
    turns.push(localTurns.get(run.id) ?? {
      source: 'chat',
      q: run.prompt,
      a: run.response ?? '',
      ts: toSecond(run.created_at),
      ok: run.status === 'complete',
      backend: 'web-hosted',
      model: run.resolved_model ?? undefined,
      run_id: run.id
    })
  }
  for (const [id, turn] of localTurns) if (!remoteIds.has(id)) turns.push(turn)
  turns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))

  const projectId = row.project_id && MIGHTY.getProject(row.project_id)
    ? row.project_id
    : !row.project_id && local?.projectId && !projectIds.has(local.projectId) ? local.projectId : undefined
  MIGHTY.putSession({
    ...local,
    schema_version: local?.schema_version ?? 1,
    id: row.id,
    created: local?.created ?? toSecond(row.created_at),
    updated: toSecond(row.updated_at),
    title: row.title === 'New chat' && local?.title ? local.title : row.title,
    turns,
    projectId
  })
  broadcastMightyTurnAppended(row.id)
  return true
}

const projectUploaded = (local: MightySession, row: ConversationRow, projectIds: Set<string>): boolean =>
  !row.project_id && !!local.projectId && projectIds.has(local.projectId)

const projectArrived = (local: MightySession, row: ConversationRow): boolean =>
  !!row.project_id && local.projectId !== row.project_id && !!MIGHTY.getProject(row.project_id)

async function reconcile(): Promise<boolean> {
  if (PREFS.getIncognito() || SETTINGS.get().webAccess === false) {
    unsubscribe()
    return true
  }
  const userId = await signedInUserId()
  if (!userId) {
    unsubscribe()
    return true
  }
  subscribe(userId)

  const supabase = getSupabase()
  const [conversations, projects] = await Promise.all([
    supabase.from('web_chat_conversations')
      .select('id,title,project_id,created_at,updated_at,source')
      .order('updated_at', { ascending: false })
      .limit(REMOTE_PAGE)
      .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
    supabase.from('user_projects').select('id').is('deleted_at', null)
      .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
  ])
  if (conversations.error || projects.error) {
    console.warn('[web-chat-sync] fetch failed:', (conversations.error ?? projects.error)?.message)
    return false
  }
  const remote = new Map((conversations.data as ConversationRow[]).map((row) => [row.id, row]))
  const remoteComplete = remote.size < REMOTE_PAGE
  const projectIds = new Set((projects.data as Array<{ id: string }>).map((p) => p.id))
  const { mine: synced, others } = readSyncedIds(PATHS.WEB_CHATS_SYNCED, userId)
  const all = MIGHTY.listSessions().filter((s) => UUID.test(s.id) && !others.has(s.id))
  const localById = new Map(all.map((s) => [s.id, s]))
  const recent = all.filter((s) => pushableTurns(s).length > 0).slice(0, MAX_PUSHED_SESSIONS)
  const inserted = new Set<string>()
  let ok = true

  applyingRemote = true
  try {
    for (const session of recent) {
      const row = remote.get(session.id)
      if (!row) {
        if (synced.has(session.id) && remoteComplete) {
          MIGHTY.deleteSession(session.id)
          broadcastMightyTurnAppended(session.id)
        }
        else if (await push(session, undefined, userId, projectIds)) inserted.add(session.id)
        else ok = false
      } else if (seconds(lastChange(session)) > seconds(row.updated_at) || projectUploaded(session, row, projectIds)) {
        ok = (await push(session, row, userId, projectIds)) && ok
      } else if ((seconds(lastChange(session)) < seconds(row.updated_at) || projectArrived(session, row)) && !session.runId) {
        ok = (await pull(row, session, projectIds)) && ok
      }
    }
    const recentIds = new Set(recent.map((s) => s.id))
    const deleted: string[] = []
    for (const row of remote.values()) {
      if (recentIds.has(row.id)) continue
      const local = localById.get(row.id)
      if (!local && synced.has(row.id)) deleted.push(row.id)
      else if (!local || ((seconds(lastChange(local)) < seconds(row.updated_at) || projectArrived(local, row)) && !local.runId)) {
        ok = (await pull(row, local, projectIds)) && ok
      }
    }
    if (deleted.length) {
      const { error } = await supabase.from('web_chat_conversations').delete().in('id', deleted)
      if (error) {
        console.warn('[web-chat-sync] delete failed:', error.message)
        ok = false
      }
    }
  } finally {
    applyingRemote = false
  }

  const localIds = new Set(MIGHTY.listSessions().map((s) => s.id))
  writeSyncedIds(PATHS.WEB_CHATS_SYNCED, userId, [...remote.keys(), ...inserted].filter((id) => localIds.has(id)))
  return ok
}

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
    console.warn('[web-chat-sync] sync failed:', error)
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

export function scheduleChatSync(): void {
  if (interval === null) return
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    void run()
  }, DEBOUNCE_MS)
}

let authSubscription: { unsubscribe: () => void } | null = null

export function startWebChatSync(): void {
  if (interval !== null) return
  interval = setInterval(() => void run(), FALLBACK_INTERVAL_MS)
  onSessionsWritten(() => {
    if (!applyingRemote) scheduleChatSync()
  })
  authSubscription?.unsubscribe()
  authSubscription = getSupabase().auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') scheduleChatSync()
  }).data.subscription
  void run()
}

export function stopWebChatSync(): void {
  if (interval === null) return
  clearInterval(interval)
  interval = null
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  authSubscription?.unsubscribe()
  authSubscription = null
  unsubscribe()
}
