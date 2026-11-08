import { describe, it, expect, vi, beforeEach } from 'vitest'

const signInWithOtp = vi.fn()
const verifyOtp = vi.fn()

vi.mock('../supabase', () => ({ getSupabase: () => ({ auth: { signInWithOtp, verifyOtp } }) }))
vi.mock('../auth-diagnostic', () => ({
  logAuthDiagnosticStartup: vi.fn(),
  logInitAuthResult: vi.fn(),
  logAuthStateChange: vi.fn()
}))
vi.mock('../analytics', () => ({ setAnalyticsUser: vi.fn(), identify: vi.fn(), track: vi.fn() }))
vi.mock('../admin-preview', () => ({ isPreviewingAsUser: () => false }))

import { sendCode, verifyCode } from '../auth'

beforeEach(() => {
  signInWithOtp.mockReset().mockResolvedValue({ error: null })
  verifyOtp.mockReset().mockResolvedValue({
    data: { session: { access_token: 'tok', user: { id: 'u1', email: 'a@b.co' } } },
    error: null
  })
})

describe('app sign-in', () => {
  it('tells the grant function the signup came from the Mac app, so no download email goes out', async () => {
    const fetchMock = vi.fn().mockResolvedValue({})
    vi.stubGlobal('fetch', fetchMock)
    await verifyCode('a@b.co', '123456')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/grant-signup-credits$/)
    expect(JSON.parse(init.body)).toEqual({ from: 'app' })
    expect(init.headers['Content-Type']).toBe('application/json')
    vi.unstubAllGlobals()
  })

  it('sends the email link to the web app-code page', async () => {
    await sendCode('a@b.co')
    const { options } = signInWithOtp.mock.calls[0][0]
    expect(options.emailRedirectTo).toMatch(/^https?:\/\/[^/]+\/app-code$/)
  })
})
