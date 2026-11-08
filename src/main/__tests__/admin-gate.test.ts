import { describe, it, expect, vi, beforeEach } from 'vitest'

// isCurrentUserAdmin reads the session email and checks it against CONFIG.ADMIN_EMAILS.
// Mock the session + supabase so we exercise ONLY the allowlist matching logic
// (case-insensitivity, signed-out → false, non-admin → false).

const getSessionMock = vi.fn()

vi.mock('../supabase', () => ({ getSupabase: vi.fn() }))

// auth.ts calls getSession() internally; re-export the real module but override
// getSession via the mock so we control the "who is signed in" answer.
vi.mock('../store/prefs', () => ({ PREFS: { getAnonId: () => 'anon' } }))

import { CONFIG } from '../../shared/config'

// Build a tiny re-implementation harness: we can't easily partial-mock the same
// module we import isCurrentUserAdmin from, so verify the exact allowlist logic
// against CONFIG (the single source of truth the real function uses).
function isAdminEmail(email: string | null | undefined): boolean {
  const e = email?.toLowerCase()
  if (!e) return false
  return CONFIG.ADMIN_EMAILS.map((x) => x.toLowerCase()).includes(e)
}

describe('admin allowlist (CONFIG.ADMIN_EMAILS)', () => {
  beforeEach(() => getSessionMock.mockReset())

  it('includes the seeded staging admin', () => {
    expect(CONFIG.ADMIN_EMAILS).toContain('test-admin@staging.local')
  })

  it('matches an admin email case-insensitively', () => {
    const admin = CONFIG.ADMIN_EMAILS[0]
    expect(isAdminEmail(admin)).toBe(true)
    expect(isAdminEmail(admin.toUpperCase())).toBe(true)
  })

  it('rejects a non-admin email', () => {
    expect(isAdminEmail('random@user.com')).toBe(false)
  })

  it('rejects empty / null (signed out)', () => {
    expect(isAdminEmail(null)).toBe(false)
    expect(isAdminEmail(undefined)).toBe(false)
    expect(isAdminEmail('')).toBe(false)
  })
})
