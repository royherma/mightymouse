/** The full screen grew a mic and the sheet's two "which screen" buttons. Both
 *  are ports of working code whose failure mode is silent: a mic keyed on a ref
 *  never binds (this directory's CLAUDE.md says that shipped twice), and a
 *  second spelling of "Open on Mac" drifts from the sheet without anything
 *  breaking. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const full = readFileSync(resolve(__dirname, '../SessionFullScreen.tsx'), 'utf8')
/** Comments stripped. Both keyboard rules below assert a string is ABSENT, and
 *  the comments explaining why it is absent naturally quote it -- matching those
 *  fails a passing fix. */
const codeOnly = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const fullCode = codeOnly(full)
const sheet = readFileSync(resolve(__dirname, '../SessionDetail.tsx'), 'utf8')
const list = readFileSync(resolve(__dirname, '../SessionList.tsx'), 'utf8')

describe('SessionFullScreen mic', () => {
  it('keys the listener effect on the NODE, so mounting the button binds it', () => {
    // useRef fires no render, so the effect would never re-run and the mic
    // would be a button with no listeners for the life of the screen.
    expect(full).toMatch(/const \[micEl, setMicEl\] = useState<HTMLButtonElement \| null>\(null\)/)
    expect(full).toMatch(/\}, \[micEl, onMicDown, onMicUp\]\)/)
    expect(full).toMatch(/ref=\{setMicEl\}/)
  })

  it('binds pointerdown non-passively, or iOS stomps the toggle on lift', () => {
    expect(full).toMatch(/addEventListener\('pointerdown', down, \{ passive: false \}\)/)
    expect(full).toMatch(/addEventListener\('pointercancel', up\)/)
  })

  it('never disables the button -- unmounting mid-gesture strands the recorder', () => {
    const btn = full.slice(full.indexOf('chatMicBtn'), full.indexOf('AttachPhotoButton'))
    expect(btn).not.toMatch(/disabled=/)
  })

  it('appends a transcript to the draft rather than clobbering what was typed', () => {
    expect(full).toMatch(/prev\.trim\(\) === '' \? draftPatch : `\$\{prev\.trimEnd\(\)\} \$\{draftPatch\}`/)
  })
})

describe('SessionFullScreen keyboard handling', () => {
  it('binds no focus scroll -- there is no scroller, so it pans the viewport', () => {
    // THE regression: this root is `position: fixed; inset: 0` with no overflow,
    // so scrollIntoView on the composer scrolled the visual viewport instead and
    // took the header, the facts panel and the transcript off the top of the
    // screen. The two surfaces that work bind no focus handler at all.
    expect(fullCode).not.toMatch(/scrollIntoView/)
  })

  it('shortens the column, and does not also set the composer variable', () => {
    // Spending the same inset in both places double-counts it with the keyboard
    // up: once on the column, once in .chatFull .chatComposer's max().
    expect(fullCode).toMatch(/style=\{\{ paddingBottom: `\$\{bottomInset\}px` \}\}/)
    expect(fullCode).not.toMatch(/--chat-full-keyboard/)
  })
})

describe('SessionFullScreen turn abstraction', () => {
  it('gates the outcome bubble on a real answer, not on the status', () => {
    // `status !== 'pending'` let a self-resolving notify print "Delivered" in
    // .chatFullAsk -- the USER's side -- so the agent's own push rendered as a
    // second message from the reader, about nothing the reader did.
    expect(fullCode).toMatch(/answeredByYou\(turn\.request\)/)
    expect(fullCode).not.toMatch(
      /turn\.request\.status !== 'pending' && \(\s*<div className="chatFullAsk"/
    )
  })

  it('keeps the raw log printing every outcome, Delivered included', () => {
    // Raw is the debug reading: the card's real status is the point there.
    expect(fullCode).toMatch(/sessionFullRawMeta">→ \{resolvedOutcome\(turn\.request\)\}/)
  })
})

describe('SessionFullScreen thinking state', () => {
  it('covers BOTH the un-echoed send and the agent turn', () => {
    // The echo can land while the agent is still writing, and the agent can
    // start before the echo returns -- either trigger alone leaves a hole.
    expect(fullCode).toMatch(/sendingAt !== null \|\| row\.health === 'working'/)
  })

  it('is NOT cleared by the sent echo', () => {
    // THE regression, on device: "I see the icon right after I send, it
    // disappears immediately." `relaySessionSent` is emitted synchronously by
    // the same handler that takes the reply (phone-remote-chat.ts), so it is
    // the Mac repeating this phone's own words back in milliseconds -- it says
    // nothing about the agent. Clearing on it killed the indicator a frame
    // after it appeared. The echo must never be the thing that ends the wait.
    expect(fullCode).not.toMatch(/setSendingAt\(null\)\s*\}, \[sentCount\]\)/)
    expect(fullCode).not.toMatch(/const sentCount = props\.sent\?\.length \?\? 0/)
  })

  it('waits for the agent turn, with a bounded ceiling as the only fallback', () => {
    // busySince is stamped on the shim's rising edge (http-listener.ts), well
    // after the echo -- that is the real end of the wait. The timer exists only
    // so a reply that wakes nothing does not spin forever.
    expect(fullCode).toMatch(/const agentBusy = session\?\.busySince !== undefined/)
    expect(fullCode).toMatch(/if \(agentBusy\) \{\s*setSendingAt\(null\)/)
    expect(fullCode).toMatch(/CONFIG\.PHONE_REMOTE\.SESSION_SENDING_MAX_MS/)
  })

  it('reads busySince off the session, never the row computed after the guard', () => {
    // `row` is derived below `if (!session) return null`, so naming it in an
    // effect above is a use-before-declaration.
    const effect = fullCode.slice(0, fullCode.indexOf('const row = sessionRow'))
    expect(effect).not.toMatch(/row\?\.health/)
  })

  it('prints the shared state sentence rather than a third wording', () => {
    expect(fullCode).toMatch(/row\.health === 'working' \? row\.state_text : 'Sending…'/)
  })

  it('animates the face, and respects reduced motion', () => {
    const css = readFileSync(resolve(__dirname, '../theme.css'), 'utf8')
    expect(css).toMatch(/@keyframes sessionFullHover/)
    expect(css).toMatch(
      /\.sessionFullThinkingFace,\s*\n\s*\.sessionFullThinkingText,\s*\n\s*\.sessionFullThinkingDots i \{\s*\n\s*animation: none/
    )
  })

  it('puts the stage in a reply bubble on the agent side, with typing dots', () => {
    // The agent taking its turn, so it reuses `.chatFullReply` -- a bare line
    // beside the face read as a status label about the thread instead.
    expect(fullCode).toMatch(/className="chatFullReply sessionFullThinkingBubble"/)
    expect(fullCode).toMatch(/sessionFullThinkingDots/)
    const css = readFileSync(resolve(__dirname, '../theme.css'), 'utf8')
    expect(css).toMatch(/@keyframes sessionFullThinkingDot/)
    // Staggered, or it reads as three things blinking together.
    expect(css).toMatch(/nth-child\(2\)\s*\{\s*\n\s*animation-delay/)
  })
})

describe('SessionFullScreen screen actions', () => {
  it('spells the go-to button exactly as the sheet does', () => {
    for (const copy of ['Open on Mac', 'Window not found']) {
      expect(sheet).toContain(copy)
      expect(full).toContain(copy)
    }
  })

  it('toggles the screen from a labelled header icon', () => {
    expect(full).toContain("'Hide Mac screen' : 'Share Mac screen'")
  })

  it('gates go-to on a resolvable origin, the same predicate the sheet uses', () => {
    // Both call sites in SessionList must ask isOriginResolvable; a full screen
    // that offers the button where the sheet does not is a dead end.
    const calls = list.match(/isOriginResolvable\(open\.origin\)/g) ?? []
    expect(calls.length).toBe(2)
  })
})
