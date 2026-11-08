import { describe, it, expect, vi, beforeEach } from 'vitest'

// A remote skin pref outliving its assets must fall back to the DEFAULT skin,
// not to the bare base cascade. Regression: the pref file is durable but the
// skin's directory is not, and isInstallableSkin only validates the id's shape.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn(), writeFileSync: vi.fn() }
})

import { existsSync, readFileSync } from 'fs'
import { PREFS } from '../prefs'
import { PATHS } from '../paths'
import { CONFIG } from '../../../shared/config'

const exists = vi.mocked(existsSync)
const read = vi.mocked(readFileSync)

/** Pref file present and holding `value`; skin dirs present only if listed. */
function onDisk(value: string, installedSkinIds: string[]): void {
  exists.mockImplementation((p) => {
    const s = String(p)
    if (s === PATHS.PHONE_REMOTE_SKIN) return true
    if (s.includes('/skins/')) return installedSkinIds.some((id) => s.includes(`/skins/${id}/`))
    return false
  })
  read.mockReturnValue(value as never)
}

beforeEach(() => vi.clearAllMocks())

describe('getPhoneRemoteSkin', () => {
  it('honors a remote skin that is still installed', () => {
    onDisk('remote:mil-spec-2', ['mil-spec-2'])
    expect(PREFS.getPhoneRemoteSkin()).toBe('remote:mil-spec-2')
  })

  it('falls back to the default when the skin was uninstalled', () => {
    onDisk('remote:mil-spec-2', [])
    expect(PREFS.getPhoneRemoteSkin()).toBe(CONFIG.PHONE_REMOTE.SKIN_DEFAULT)
  })

  it('honors a built-in without consulting the skins dir', () => {
    onDisk('cap', [])
    expect(PREFS.getPhoneRemoteSkin()).toBe('cap')
  })
})
