import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { WindowBoundary } from '../WindowBoundary'

// The repo has no DOM test environment (no jsdom/happy-dom — every other test is
// pure logic under `node`), and React runs error boundaries ONLY on the client:
// renderToString rethrows instead of calling componentDidCatch. So the catch path
// is exercised by driving the boundary's lifecycle methods directly, which is what
// React itself calls, and the healthy path via a real render.

function Boom(): never {
  throw new Error('kaboom')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WindowBoundary', () => {
  it('renders children when nothing throws', () => {
    const html = renderToString(
      <WindowBoundary route="panel">
        <p>all good</p>
      </WindowBoundary>
    )
    expect(html).toContain('all good')
    expect(html).not.toContain('hit a snag')
  })

  it('flips to the fallback state when a child throws', () => {
    expect(WindowBoundary.getDerivedStateFromError(new Error('kaboom'))).toEqual({
      failed: true,
      message: 'kaboom'
    })
  })

  it('renders the recovery UI, not a blank window, once failed', () => {
    const boundary = new WindowBoundary({ route: 'panel', children: <Boom /> })
    boundary.state = { failed: true, message: 'kaboom' }
    const html = renderToString(boundary.render() as React.ReactElement)
    expect(html).toContain('hit a snag')
    expect(html).toContain('Try again')
  })

  it('reports the throw to public.errors tagged with its route', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reportError = vi.fn()
    vi.stubGlobal('window', { api: { reportError } })

    const boundary = new WindowBoundary({ route: 'settings', children: null })
    boundary.componentDidCatch(new Error('kaboom'), { componentStack: '\n  at Boom' })

    expect(reportError).toHaveBeenCalledTimes(1)
    expect(reportError.mock.calls[0][0]).toMatchObject({
      kind: 'react.render',
      message: 'kaboom',
      source: 'renderer',
      props: { route: 'settings' }
    })
    expect(reportError.mock.calls[0][0].stack).toContain('at Boom')
    spy.mockRestore()
  })

  // This runs inside React's error path, so a throw here would turn a recoverable
  // window into an unrecoverable one.
  it('survives reportError itself throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('window', {
      api: {
        reportError: () => {
          throw new Error('ipc gone')
        }
      }
    })

    const boundary = new WindowBoundary({ route: 'hud', children: null })
    expect(() => boundary.componentDidCatch(new Error('kaboom'), { componentStack: '' })).not.toThrow()
    spy.mockRestore()
  })
})
