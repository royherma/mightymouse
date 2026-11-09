import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, shell: {} }))
vi.mock('electron-updater', () => ({ autoUpdater: {} }))
vi.mock('../analytics', () => ({ track: () => {}, trackError: () => {} }))
vi.mock('../store/prefs', () => ({ PREFS: {} }))

import { isOfflineOrServerHiccup } from '../updater'

describe('isOfflineOrServerHiccup', () => {
  it.each([
    'net::ERR_INTERNET_DISCONNECTED',
    'Error: net::ERR_NETWORK_CHANGED',
    'net::ERR_NAME_NOT_RESOLVED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_TIMED_OUT',
    'net::ERR_HTTP2_PROTOCOL_ERROR',
    'HttpError: 503 Service Unavailable\n"method: GET url: https://example.com/latest-mac.yml"',
    '502 Bad Gateway'
  ])('a laptop going offline or the server blinking is not reported: %s', (message) => {
    expect(isOfflineOrServerHiccup(message)).toBe(true)
  })

  it.each([
    'HttpError: 404 \n"method: GET url: https://example.com/latest-mac.yml"',
    'Code signature at URL file:///x did not pass validation: code failed to satisfy specified code requirement(s)',
    'ENOSPC: no space left on device',
    'sha512 checksum mismatch, expected abc, got def',
    'net::ERR_CERT_AUTHORITY_INVALID',
    'Update file 5123 bytes short'
  ])('a real update failure still gets reported: %s', (message) => {
    expect(isOfflineOrServerHiccup(message)).toBe(false)
  })
})
