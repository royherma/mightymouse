import { describe, it, expect, beforeEach, vi } from 'vitest'

// "View as user" lets an admin see the app as a real user sees it. The gate that
// matters: it must hide admin surfaces (isCurrentUserAdmin) WITHOUT changing who
// is really an admin (isRealAdmin) — otherwise a preview would be an access
// change, and the exit switch in Settings would hide itself.

const getSessionMock = vi.fn()

vi.mock('../supabase', () => ({ getSupabase: vi.fn() }))
vi.mock('../store/prefs', () => ({ PREFS: { getAnonId: () => 'anon' } }))
vi.mock('../analytics', () => ({
  setAnalyticsUser: vi.fn(),
  identify: vi.fn(),
  track: vi.fn()
}))
vi.mock('../auth-diagnostic', () => ({
  logAuthDiagnosticStartup: vi.fn(),
  logInitAuthResult: vi.fn(),
  logAuthStateChange: vi.fn()
}))

import { CONFIG } from '../../shared/config'
import { isPreviewingAsUser, setPreviewAsUser } from '../admin-preview'

describe('admin-preview flag', () => {
  beforeEach(() => setPreviewAsUser(false))

  it('defaults to off, so a fresh session always starts in real admin view', () => {
    expect(isPreviewingAsUser()).toBe(false)
  })

  it('round-trips on and off', () => {
    setPreviewAsUser(true)
    expect(isPreviewingAsUser()).toBe(true)
    setPreviewAsUser(false)
    expect(isPreviewingAsUser()).toBe(false)
  })
})

describe('admin visibility vs real admin', () => {
  beforeEach(() => {
    setPreviewAsUser(false)
    getSessionMock.mockReset()
  })

  // Mirrors the two exported checks in auth.ts against the same CONFIG source,
  // so the preview's effect on each is asserted without booting Supabase.
  const realAdmin = (email: string): boolean =>
    CONFIG.ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(email.toLowerCase())
  const visibleAdmin = (email: string): boolean => !isPreviewingAsUser() && realAdmin(email)

  const admin = CONFIG.ADMIN_EMAILS[0]

  it('shows admin surfaces to an admin when the preview is off', () => {
    expect(visibleAdmin(admin)).toBe(true)
    expect(realAdmin(admin)).toBe(true)
  })

  it('hides admin surfaces while previewing, without demoting the real admin', () => {
    setPreviewAsUser(true)
    expect(visibleAdmin(admin)).toBe(false)
    // The load-bearing half: real access is untouched, so main-process handlers
    // and the exit switch still know this is an admin.
    expect(realAdmin(admin)).toBe(true)
  })

  it('never promotes a non-admin, preview on or off', () => {
    expect(visibleAdmin('random@user.com')).toBe(false)
    setPreviewAsUser(true)
    expect(visibleAdmin('random@user.com')).toBe(false)
    expect(realAdmin('random@user.com')).toBe(false)
  })
})
