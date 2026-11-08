/**
 * Walks the box chain from a leaf up to <body>, reporting per box the rendered
 * width, scrollWidth/clientWidth and right edge -- it names WHICH ancestor grows
 * past the viewport. Desktop harnesses cannot reproduce these (see
 * , 2026-08-17); the phone is the only trustworthy instrument.
 */

// Sink injected from App.tsx (same shape as nav-trace): this module stays
// DOM-only and cannot reach the WS pipe on its own.
let sink: ((line: string) => void) | null = null

export function setWidthProbeSink(fn: ((line: string) => void) | null): void {
  sink = fn
}

// Overflow past the viewport or a horizontal scroll gap under half a CSS px is
// subpixel rounding, not the bug.
const SLOP = 0.5

function line(el: Element, vpW: number): string {
  const r = el.getBoundingClientRect()
  const cls = (el.getAttribute('class') ?? '').split(' ').filter(Boolean)[0]
  const name = `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`
  const over = r.right - vpW > SLOP || el.scrollWidth - el.clientWidth > SLOP
  const scroll =
    el.scrollWidth - el.clientWidth > SLOP ? ` sw${el.scrollWidth}>cw${el.clientWidth}` : ''
  // Computed values, not authored ones: the served CSS says these boxes must
  // shrink and the device lays them out at max-content anyway, so the open
  // question is which rule ACTUALLY applied. cs.width included because a rect
  // wider than the computed width means a transform/scale, not layout.
  const cs = getComputedStyle(el)
  const facts = ` |${cs.display} f:${cs.flexGrow}/${cs.flexShrink}/${cs.flexBasis} mw:${cs.minWidth} as:${cs.alignSelf} w:${cs.width}`
  return `${over ? '⚠' : ' '}${name} w${Math.round(r.width)} R${Math.round(r.right)}${scroll}${facts}`
}

/** True when any box in the chain is wider than the viewport or hides
 *  horizontal overflow -- the condition the readout exists to catch. */
export function chainHasOverflow(report: string): boolean {
  return report.includes('⚠')
}

/**
 * Measures every box from `leaf` to <body>, plus the leaf's in-card siblings
 * that shipped two wrong fixes already (heading, state chip). One line per box,
 * ⚠-flagged where it overflows. Sends through the sink and returns the text.
 */
let lastSent: string | null = null

/**
 * Whole-document sweep, run on an interval from App.tsx: the screenshot shows
 * session cards while the SessionList instance that probes measures w0 inside a
 * display:none sheet -- so either a second mount renders the visible cards, or
 * they are painted by a different webview entirely. Counting every mount in
 * THIS document decides which.
 */
let lastGlobal: string | null = null

export function probeGlobalCards(): void {
  const vpW = window.innerWidth
  const cards = document.querySelectorAll('.codeSession')
  const lines: string[] = [`cards=${cards.length} vp${vpW}`]
  for (const sel of ['.chatSheet', '.codeSessionPane', '.codeSessions']) {
    document.querySelectorAll(sel).forEach((el, i) => {
      const r = el.getBoundingClientRect()
      lines.push(
        ` ${sel}#${i} ${getComputedStyle(el).display} w${Math.round(r.width)} R${Math.round(r.right)}`
      )
    })
  }
  let widest: Element | null = null
  for (const el of document.querySelectorAll('.codeSessionName')) {
    if (el.getBoundingClientRect().width > 0 && (!widest || el.scrollWidth > widest.scrollWidth))
      widest = el
  }
  const report = lines.join('\n')
  if (report !== lastGlobal) {
    lastGlobal = report
    sink?.(`[width-probe global]\n${report}`)
  }
  // A VISIBLE card's chain is the one that matters; the SessionList-local
  // probe only ever reached the hidden mount.
  if (widest) probeWidthChain(widest)
}

export function probeWidthChain(leaf: Element): string {
  const vpW = window.innerWidth
  const lines: string[] = [`vp ${vpW}x${window.innerHeight} dpr${window.devicePixelRatio}`]

  const card = leaf.closest('.codeSession')
  for (const sel of ['.codeSessionName', '.codeSessionHeading', '.codeSessionStateChip']) {
    const el = card?.querySelector(sel)
    if (el && el !== leaf) lines.push(line(el, vpW))
  }

  let el: Element | null = leaf
  while (el && el !== document.documentElement) {
    lines.push(line(el, vpW))
    el = el.parentElement
  }

  const report = lines.join('\n')
  // One WS message, not one per box (the dev log interleaves clients), and only
  // when the numbers CHANGED -- the caller re-measures on every sessions poll.
  if (report !== lastSent) {
    lastSent = report
    sink?.(`[width-probe]\n${report}`)
  }
  return report
}
