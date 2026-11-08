import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { DeckBoundary } from '../DeckBoundary'

vi.mock('../hooks/use-mirror', () => ({ PREVIEW_MODE: true }))

// React runs error boundaries only on the client (renderToString rethrows), and
// this repo has no DOM test environment, so the catch path is driven through the
// lifecycle methods React itself calls. See window-boundary.test.tsx.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DeckBoundary', () => {
  it('renders the deck when nothing throws', () => {
    const html = renderToString(
      <DeckBoundary>
        <p>deck</p>
      </DeckBoundary>
    )
    expect(html).toContain('deck')
    expect(html).not.toContain('hit a snag')
  })

  it('flips to the fallback state when a child throws', () => {
    expect(DeckBoundary.getDerivedStateFromError(new Error('kaboom'))).toEqual({
      failed: true,
      message: 'kaboom'
    })
  })

  it('offers a reload instead of a dead screen once failed', () => {
    const boundary = new DeckBoundary({ children: null })
    boundary.state = { failed: true, message: 'kaboom' }
    const html = renderToString(boundary.render() as React.ReactElement)
    expect(html).toContain('hit a snag')
    expect(html).toContain('Reload')
  })

  // The splash is z-index 9999 / inset:0 and is normally retired by App's
  // onReady, which never runs if App throws first — it would sit over the
  // fallback and swallow the tap on the only button there.
  it('removes the boot splash so the fallback is reachable', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const remove = vi.fn()
    vi.stubGlobal('document', { getElementById: (id: string) => (id === 'boot' ? { remove } : null) })

    new DeckBoundary({ children: null }).componentDidCatch(new Error('kaboom'), {
      componentStack: ''
    })

    expect(remove).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('does not throw when the splash is already gone', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('document', { getElementById: () => null })

    expect(() =>
      new DeckBoundary({ children: null }).componentDidCatch(new Error('kaboom'), {
        componentStack: ''
      })
    ).not.toThrow()
    spy.mockRestore()
  })
})
