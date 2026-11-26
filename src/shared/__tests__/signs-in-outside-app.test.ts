import { describe, it, expect } from 'vitest'
import { signsInOutsideApp } from '../types'

const google = (redirect: string): string =>
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=${encodeURIComponent(redirect)}&response_type=code`

describe('signsInOutsideApp', () => {
  it.each([
    'http://localhost:8085/',
    'http://localhost:54545/callback',
    'http://127.0.0.1:3000/oauth2callback',
    'http://[::1]:9000/cb',
    'HTTP://LOCALHOST:8085/',
    'https://localhost/auth'
  ])('sends a sign-in calling back to %s out to the real browser', (redirect) => {
    expect(signsInOutsideApp(google(redirect))).toBe(true)
  })

  it.each([
    'https://app.example.com/auth/callback',
    'http://localhost.evil.com/cb',
    'http://127.0.0.1.nip.io/cb',
    'myapp://callback'
  ])('keeps a sign-in calling back to %s in the Browser tab', (redirect) => {
    expect(signsInOutsideApp(google(redirect))).toBe(false)
  })

  it('keeps pages without a redirect_uri in the Browser tab', () => {
    expect(signsInOutsideApp('https://accounts.google.com/signin')).toBe(false)
    expect(signsInOutsideApp('https://example.com/?next=http://localhost:3000/')).toBe(false)
  })

  it('does not throw on text that is not a URL', () => {
    expect(signsInOutsideApp('not a url')).toBe(false)
    expect(signsInOutsideApp('')).toBe(false)
  })
})

describe('signsInOutsideApp - loopback callback with no path', () => {
  it.each(['http://127.0.0.1:8080', 'http://localhost:8085', 'http://[::1]:9000'])('%s is a callback to this computer', (redirect) => {
    expect(signsInOutsideApp(google(redirect))).toBe(true)
  })

  it('still rejects a lookalike host', () => {
    expect(signsInOutsideApp(google('http://localhost.example.com:8080'))).toBe(false)
  })
})
