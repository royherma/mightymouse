import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installRendererCrashHook } from '../crash-hook'

// No DOM environment in this repo (every test runs pure under `node`), so the
// hook's two listeners are captured off a stubbed addEventListener and invoked
// directly with the event shape the browser would hand them.

type Handler = (e: unknown) => void

let handlers: Record<string, Handler>
let reported: { message: string; stack?: string }[]

beforeEach(() => {
  handlers = {}
  reported = []
  vi.stubGlobal('window', {
    addEventListener: (name: string, fn: Handler) => {
      handlers[name] = fn
    },
    api: {
      reportError: (e: { message: string; stack?: string }) => {
        reported.push(e)
      }
    }
  })
  installRendererCrashHook('panel')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// The literal stack MetaMask produces when its inpage script cannot reach its
// background worker. Chrome injects this into localhost, so it lands in any
// dev harness opened in a real browser rather than in Electron.
const METAMASK_STACK =
  'i: Failed to connect to MetaMask\n    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:7:84292)'

describe('installRendererCrashHook', () => {
  it('reports a real renderer rejection', () => {
    handlers.unhandledrejection({
      reason: { message: 'boom', stack: 'Error: boom\n    at PanelApp (http://localhost:5273/src/PanelApp.tsx:12:3)' }
    })
    expect(reported).toHaveLength(1)
    expect(reported[0].message).toBe('boom')
  })

  it('drops a rejection thrown by a browser extension', () => {
    handlers.unhandledrejection({
      reason: { message: 'Failed to connect to MetaMask', stack: METAMASK_STACK }
    })
    expect(reported).toEqual([])
  })

  it('drops an error event whose file is an extension', () => {
    handlers.error({ message: 'whatever', filename: 'chrome-extension://abc/inpage.js' })
    expect(reported).toEqual([])
  })

  it('still reports an error event from our own code', () => {
    handlers.error({
      message: 'real crash',
      filename: 'http://localhost:5273/src/main.tsx',
      error: { stack: 'Error: real crash\n    at main.tsx:1:1' }
    })
    expect(reported).toHaveLength(1)
    expect(reported[0].message).toBe('real crash')
  })
})
