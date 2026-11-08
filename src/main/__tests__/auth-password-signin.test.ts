import { describe, it, expect, vi, beforeEach } from 'vitest'

const signInWithPasswordApi = vi.fn()
const signUp = vi.fn()

vi.mock('../supabase', () => ({
  getSupabase: () => ({ auth: { signInWithPassword: signInWithPasswordApi, signUp } })
}))
vi.mock('../auth-diagnostic', () => ({
  logAuthDiagnosticStartup: vi.fn(),
  logInitAuthResult: vi.fn(),
  logAuthStateChange: vi.fn()
}))
vi.mock('../analytics', () => ({ setAnalyticsUser: vi.fn(), identify: vi.fn(), track: vi.fn() }))
vi.mock('../admin-preview', () => ({ isPreviewingAsUser: () => false }))

import { signInWithPassword } from '../auth'

const session = { access_token: 'tok', user: { id: 'u1', email: 'a@b.co' } }
const invalidCreds = { data: { session: null }, error: { message: 'Invalid login credentials' } }

beforeEach(() => {
  signInWithPasswordApi.mockReset()
  signUp.mockReset()
})

describe('password sign-in', () => {
  it('points a brand-new signup that got no session (email confirmation on) to the email code', async () => {
    signInWithPasswordApi.mockResolvedValue(invalidCreds)
    signUp.mockResolvedValue({ data: { session: null, user: { id: 'new' } }, error: null })
    const result = await signInWithPassword('new@b.co', 'secret1')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/email code/)
    expect(signUp).toHaveBeenCalledWith({ email: 'new@b.co', password: 'secret1' })
  })

  it('keeps the password error when sign-in returned no session without going through signup', async () => {
    signInWithPasswordApi.mockResolvedValue({ data: { session: null }, error: null })
    const result = await signInWithPassword('a@b.co', 'secret1')
    expect(result).toEqual({ ok: false, error: 'Could not start a session. Check your password.' })
    expect(signUp).not.toHaveBeenCalled()
  })

  it('surfaces the signup error itself rather than the email-code hint', async () => {
    signInWithPasswordApi.mockResolvedValue(invalidCreds)
    signUp.mockResolvedValue({ data: { session: null }, error: { message: 'Signups not allowed' } })
    expect(await signInWithPassword('a@b.co', 'secret1')).toEqual({
      ok: false,
      error: 'Signups not allowed'
    })
  })

  it('signs in a new user when signup returns a session', async () => {
    signInWithPasswordApi.mockResolvedValue(invalidCreds)
    signUp.mockResolvedValue({ data: { session }, error: null })
    expect(await signInWithPassword(' a@b.co ', 'secret1')).toEqual({ ok: true })
    expect(signUp).toHaveBeenCalledWith({ email: 'a@b.co', password: 'secret1' })
  })

  it('does not try signup on a non-credential sign-in error', async () => {
    signInWithPasswordApi.mockResolvedValue({ data: { session: null }, error: { message: 'Email rate limit exceeded' } })
    expect(await signInWithPassword('a@b.co', 'secret1')).toEqual({
      ok: false,
      error: 'Email rate limit exceeded'
    })
    expect(signUp).not.toHaveBeenCalled()
  })
})
