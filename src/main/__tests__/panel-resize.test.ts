import { describe, it, expect } from 'vitest'
import { CONFIG } from '../../shared/config'

// Guards the CONSTANTS behind the panel's chat height floor. The clamp itself
// (resizePanelWindow) needs a live BrowserWindow, so it isn't exercised here —
// these assert the invariants the clamp depends on, which is where the bug was:
// chat reused PANEL_MIN_H (240, tuned for the threadless compose view), which
// crushed .thread onto its own min-height:80px. That's the cramped first-message
// panel that then jerks taller as the reply streams in.

describe('panel chat height floor', () => {
  it('exports a chat floor taller than the compose floor', () => {
    // The whole fix rests on these being different numbers: PANEL_MIN_H is tuned
    // for the compose view (input + hints, no thread), so reusing it for chat is
    // what produced the squashed first-message panel.
    expect(CONFIG.PANEL_CHAT_MIN_H).toBeGreaterThan(CONFIG.PANEL_MIN_H)
  })

  it('chat floor leaves real room for the thread above its 80px min-height', () => {
    // .thread has min-height:80px; the header/context/composer chrome eats the
    // rest. If the chat floor doesn't clear that chrome by a wide margin we're
    // back to the cramped panel even with the floor "applied".
    const CHROME_H = 160 // header + ctx row + composer, measured live
    expect(CONFIG.PANEL_CHAT_MIN_H - CHROME_H).toBeGreaterThan(200)
  })

  it('chat floor stays under the max so long threads can still grow', () => {
    expect(CONFIG.PANEL_CHAT_MIN_H).toBeLessThan(CONFIG.PANEL_MAX_H)
  })
})
