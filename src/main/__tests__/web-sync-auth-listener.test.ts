import { describe, expect, it, vi } from 'vitest'

const live = vi.hoisted(() => new Set<number>())
let nextId = 0

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../supabase', () => ({
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => {
        const id = nextId++
        live.add(id)
        return { data: { subscription: { unsubscribe: () => live.delete(id) } } }
      }
    },
    removeChannel: vi.fn()
  })
}))
vi.mock('../auth', () => ({ withTimeout: (p: Promise<unknown>) => p }))
vi.mock('../mighty/broadcast', () => ({ broadcastMightyTurnAppended: vi.fn() }))
vi.mock('../store/mighty', () => ({ MIGHTY: {}, onSessionsWritten: vi.fn(), onProjectsWritten: vi.fn() }))
vi.mock('../store/paths', () => ({ PATHS: {} }))
vi.mock('../store/prefs', () => ({ PREFS: { getIncognito: () => true } }))
vi.mock('../store/settings', () => ({ SETTINGS: { get: () => ({}) } }))
vi.mock('../infra/scan', () => ({ readRecord: vi.fn(), setInfraBrief: vi.fn() }))
vi.mock('../ipc/phone-remote-chat', () => ({ projectImageBase64: vi.fn() }))

import { startWebChatSync, stopWebChatSync } from '../web-chat-sync'
import { startWebProjectsSync, stopWebProjectsSync } from '../web-projects-sync'

describe('web sync across sign-out / sign-in cycles', () => {
  it('holds one auth listener per sync, not one per cycle', () => {
    for (let i = 0; i < 3; i++) {
      startWebChatSync()
      startWebProjectsSync()
      stopWebChatSync()
      stopWebProjectsSync()
    }
    startWebChatSync()
    startWebProjectsSync()
    expect(live.size).toBe(2)
    stopWebChatSync()
    stopWebProjectsSync()
    expect(live.size).toBe(0)
  })
})
