import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { TerminalBack } from '../TerminalState'

function bootstrap(features: string[]) {
  vi.stubGlobal('window', { __MM_NATIVE_BOOTSTRAP__: { features } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TerminalBack in the simple iPhone app', () => {
  it('renders no back arrow when there is no onBack and the app is simple', () => {
    bootstrap(['hideDeck', 'exitNotFound', 'simple'])
    expect(renderToString(<TerminalBack />)).toBe('')
  })

  it('keeps the arrow with Advanced on', () => {
    bootstrap(['hideDeck', 'exitNotFound'])
    expect(renderToString(<TerminalBack />)).toContain('terminalBack')
  })

  it('keeps the arrow in simple mode when the screen has its own onBack', () => {
    bootstrap(['hideDeck', 'simple'])
    expect(renderToString(<TerminalBack onBack={() => {}} />)).toContain('terminalBack')
  })
})
