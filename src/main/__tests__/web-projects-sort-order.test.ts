import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MightyProject } from '../../shared/types'

const h = vi.hoisted(() => ({
  local: [] as MightyProject[],
  remote: [] as Record<string, unknown>[],
  pushed: [] as Record<string, unknown>[][],
  upserted: [] as MightyProject[],
  reconciled: 0
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../supabase', () => {
  const chain = { on: () => chain, subscribe: () => chain, unsubscribe: async () => 'ok' }
  return {
    getSupabase: () => ({
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } })
      },
      channel: () => chain,
      from: () => ({
        select: () => ({ abortSignal: async () => ({ data: h.remote, error: null }) }),
        upsert: (rows: Record<string, unknown>[]) => {
          h.pushed.push(rows)
          return { abortSignal: async () => ({ error: null }) }
        }
      })
    })
  }
})
vi.mock('../auth', () => ({ withTimeout: (p: Promise<unknown>) => p }))
vi.mock('../store/mighty', () => ({
  MIGHTY: {
    listProjects: () => h.local,
    upsertProject: (p: MightyProject) => {
      h.upserted.push(p)
      return p
    },
    deleteProject: () => true
  },
  onProjectsWritten: vi.fn()
}))
vi.mock('../store/paths', () => ({ PATHS: { WEB_PROJECTS_SYNCED: '/nonexistent' } }))
vi.mock('../store/prefs', () => ({ PREFS: { getIncognito: () => false } }))
vi.mock('../infra/scan', () => ({ readRecord: async () => null, setInfraBrief: vi.fn() }))
vi.mock('../ipc/phone-remote-chat', () => ({ projectImageBase64: () => null }))
vi.mock('../web-chat-sync', () => ({ readSyncedIds: () => ({ mine: new Set(), others: new Set() }), writeSyncedIds: () => void h.reconciled++ }))

const { startWebProjectsSync, stopWebProjectsSync } = await import('../web-projects-sync')

const T1 = '2026-11-20T10:00:00Z'
const T2 = '2026-11-20T11:00:00Z'

const local = (extra: Partial<MightyProject> = {}): MightyProject => ({ id: 'p1', name: 'Shop', created: T1, updated: T1, ...extra })
const row = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1',
  user_id: 'u1',
  name: 'Shop',
  icon: null,
  default_model: null,
  repo_name: null,
  image_url: null,
  instructions: null,
  brief: null,
  archived: false,
  sort_order: null,
  created_at: T1,
  updated_at: T1,
  deleted_at: null,
  ...extra
})

async function sync(): Promise<void> {
  startWebProjectsSync()
  await vi.waitFor(() => expect(h.reconciled).toBe(1))
}

describe('project order travels between the computer and the cloud', () => {
  beforeEach(() => {
    h.local = []
    h.remote = []
    h.pushed = []
    h.upserted = []
    h.reconciled = 0
  })
  afterEach(() => stopWebProjectsSync())

  it('a new local project goes up with its sidebar position', async () => {
    h.local = [local({ order: 2 })]
    await sync()
    expect(h.pushed.flat()).toEqual([expect.objectContaining({ id: 'p1', sort_order: 2 })])
  })

  it('a project never dragged goes up with no position, not 0', async () => {
    h.local = [local()]
    await sync()
    expect(h.pushed.flat()[0]).toMatchObject({ sort_order: null })
  })

  it('an order that differs from the cloud is pushed even when both copies have the same timestamp', async () => {
    h.local = [local({ order: 3 })]
    h.remote = [row({ sort_order: 1 })]
    await sync()
    expect(h.pushed.flat()).toEqual([expect.objectContaining({ id: 'p1', sort_order: 3 })])
  })

  it('matching order, icon and image with the same timestamp sends nothing', async () => {
    h.local = [local({ order: 1 })]
    h.remote = [row({ sort_order: 1 })]
    await sync()
    expect(h.pushed.flat()).toEqual([])
    expect(h.upserted).toEqual([])
  })

  it('a newer cloud copy brings its order down', async () => {
    h.local = [local({ order: 0 })]
    h.remote = [row({ sort_order: 4, updated_at: T2 })]
    await sync()
    expect(h.upserted).toEqual([expect.objectContaining({ id: 'p1', order: 4 })])
  })

  it('a newer cloud copy with no order keeps the order dragged on this computer', async () => {
    h.local = [local({ order: 3 })]
    h.remote = [row({ sort_order: null, updated_at: T2, name: 'Shop renamed' })]
    await sync()
    expect(h.upserted).toEqual([expect.objectContaining({ name: 'Shop renamed', order: 3 })])
  })

  it('a project that only exists in the cloud arrives in its position', async () => {
    h.remote = [row({ id: 'p9', sort_order: 1 })]
    await sync()
    expect(h.upserted).toEqual([expect.objectContaining({ id: 'p9', order: 1 })])
  })
})
