import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { FloatingRecap, writeRecapOpen } from '../components/session-thread'

function fakeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size
    }
  }
}

const mount = (text: string): string => renderToString(<FloatingRecap key={text} text={text} onSize={() => {}} />)

afterEach(() => vi.unstubAllGlobals())

describe('FloatingRecap', () => {
  it('opens by default the first time', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(mount('First recap')).toContain('First recap')
  })

  it('stays closed after a new recap, a window reopen and a session switch', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    expect(mount('First recap')).toContain('First recap')
    writeRecapOpen(false)
    for (const text of ['A newer recap', 'First recap', 'Recap from another session']) {
      expect(mount(text)).not.toContain(text)
    }
  })

  it('opens again once the user opens it', () => {
    vi.stubGlobal('localStorage', fakeStorage())
    writeRecapOpen(false)
    writeRecapOpen(true)
    expect(mount('Back open')).toContain('Back open')
  })
})
