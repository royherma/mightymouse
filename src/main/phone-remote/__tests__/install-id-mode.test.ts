import { describe, it, expect, vi } from 'vitest'
import { statSync, rmSync } from 'fs'

vi.mock('../../supabase', () => ({ getSupabase: () => ({}) }))
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const { sandboxPaths } = await import('./sandbox-paths')
  return { ...actual, PATHS: sandboxPaths(actual.PATHS, actual.PATHS.ROOT, j(t(), `mm-install-id-${process.pid}`)) }
})

const { PATHS } = await import('../../store/paths')
const { getPhoneRemoteInstallId } = await import('../cloudflare-tunnel')

describe('phone remote install id file', () => {
  it('is readable by the owner only', () => {
    rmSync(PATHS.PHONE_REMOTE_INSTALL_ID, { force: true })
    expect(getPhoneRemoteInstallId()).toMatch(/^[a-f0-9]{32}$/)
    expect(statSync(PATHS.PHONE_REMOTE_INSTALL_ID).mode & 0o077).toBe(0)
    rmSync(PATHS.ROOT, { recursive: true, force: true })
  })
})
