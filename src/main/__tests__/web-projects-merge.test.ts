import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => '/tmp' } }))
vi.mock('../supabase', () => ({ getSupabase: vi.fn() }))
vi.mock('../infra/scan', () => ({ readRecord: vi.fn(), setInfraBrief: vi.fn() }))
vi.mock('../ipc/phone-remote-chat', () => ({ projectImageBase64: vi.fn() }))
vi.mock('../store/mighty', () => ({ MIGHTY: {}, onProjectsWritten: vi.fn() }))
vi.mock('../auth', () => ({ withTimeout: vi.fn() }))
vi.mock('../web-chat-sync', () => ({ readSyncedIds: vi.fn(), writeSyncedIds: vi.fn() }))

const { mergeField } = await import('../web-projects-sync')

const eq = (a: string, b: string): boolean => a === b
const sameKeys = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => JSON.stringify(a) === JSON.stringify(b)

describe('mergeField', () => {
  it('fills the side that never had a value, whichever copy is newer', () => {
    for (const newer of ['local', 'remote', 'same'] as const) {
      expect(mergeField<string>(undefined, 'from web', newer, eq), newer).toEqual({ value: 'from web', push: false, pull: true })
      expect(mergeField<string>('from mac', null, newer, eq), newer).toEqual({ value: 'from mac', push: true, pull: false })
    }
  })

  it('does nothing when neither side has a value or both agree', () => {
    expect(mergeField<string>(undefined, null, 'local', eq)).toEqual({ value: null, push: false, pull: false })
    expect(mergeField('same text', 'same text', 'remote', eq)).toEqual({ value: 'same text', push: false, pull: false })
    expect(mergeField({ a: 1 }, { a: 1 }, 'local', sameKeys)).toEqual({ value: { a: 1 }, push: false, pull: false })
  })

  it('on a real conflict the newer copy wins and is sent the other way', () => {
    expect(mergeField('mac edit', 'web edit', 'local', eq)).toEqual({ value: 'mac edit', push: true, pull: false })
    expect(mergeField('mac edit', 'web edit', 'remote', eq)).toEqual({ value: 'web edit', push: false, pull: true })
  })

  it('on a tie keeps the server copy and moves nothing', () => {
    expect(mergeField('mac edit', 'web edit', 'same', eq)).toEqual({ value: 'web edit', push: false, pull: false })
  })

  it('treats an emptied field as a deliberate clear that competes, not as missing', () => {
    expect(mergeField('', 'old instructions', 'local', eq)).toEqual({ value: '', push: true, pull: false })
    expect(mergeField('old instructions', '', 'remote', eq)).toEqual({ value: '', push: false, pull: true })
    expect(mergeField<Record<string, unknown>>({}, { about: 'x' }, 'local', sameKeys)).toEqual({ value: {}, push: true, pull: false })
  })
})
