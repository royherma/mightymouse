// Layout debug tint: paints each stacked container a loud color so a "which
// box is short?" bug is answered by LOOKING instead of by reading CSS and
// inferring. Earned its place -- the pro layout stacks four near-identical
// creams (body / .proRoot / .proCard / .proTouchpad), so a container failing
// to reach an edge shows as a faint seam that's easy to blame on the wrong
// layer. It was blamed on the wrong layer three times before this existed.
//
// The flag is a data attribute on <html> rather than a class on the app root:
// `body` itself is one of the tinted layers, so the selector has to live above
// it. See the "Layout debug tint" block at the end of theme.css for the color
// legend.
//
// Phone-local (localStorage), same reasoning as the haptics prefs: this is a
// property of the debugging session on this device, not app-wide config worth
// round-tripping to the Mac.

import { useSyncExternalStore } from 'react'
import { copyText } from './clipboard'
import { formatKbTrace } from './keyboard-trace'
import { readLastKeySeen } from './last-key-seen'
import { formatNavTrace, readLastNav, readLastNavTarget } from './nav-trace'

const DEBUG_LAYOUT_PREF_KEY = 'mm-remote-debug-layout'
const DEBUG_LAYOUT_ATTR = 'data-debug-layout'

// Stamped by the build, NOT by hand. Without it, "still broken" cannot
// distinguish a fix that failed from a phone still running the previous bundle
// off a cache -- an ambiguity that already cost several round-trips. It was a
// hand-bumped string for exactly that reason and sat at 'arrow-nav-1' across
// every build since, which is the failure mode of any marker whose accuracy
// depends on someone remembering it. Read it before trusting anything else in
// the paste.
const BUILD_STAMP = __PHONE_REMOTE_BUILD__

export function getDebugLayoutEnabled(): boolean {
  try {
    // Default OFF -- absence of the key means "never turned on". Opposite
    // default from the haptics prefs, since this one is visually destructive.
    return localStorage.getItem(DEBUG_LAYOUT_PREF_KEY) === 'on'
  } catch {
    return false
  }
}

// Calling the getter during render reads localStorage, which React cannot
// subscribe to -- so a JSX-gated debug overlay stayed unmounted until a full
// reload while the CSS-only tints appeared instantly. That split is why
// "I don't see any of that color" was true of the ring zones and false of the
// skin corners at the same moment. Components use useDebugLayout instead.
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Re-renders the caller whenever the debug-layout flag flips. */
export function useDebugLayout(): boolean {
  return useSyncExternalStore(subscribe, getDebugLayoutEnabled, () => false)
}

// The status strip calls measureLayers() in its render body, so it repaints only
// when something re-renders it -- and the flag-flip store above changes value
// exactly once. That froze `focus:`/`nav:` at whatever they were when debug mode
// was switched on, which is the one moment they carry no information. On glasses
// that reads as "the readout is broken", not "the readout is stale".
let navVersion = 0

function navSnapshot(): number {
  return navVersion
}

/** Re-renders on every recorded arrow hop. Separate store from the flag: the
 *  snapshot has to CHANGE for useSyncExternalStore to repaint, and the flag's
 *  boolean does not. */
export function useNavTick(): number {
  return useSyncExternalStore(subscribe, navSnapshot, () => 0)
}

/** Injected into nav-trace rather than imported by it -- that module is kept
 *  DOM-free so it can be unit-tested, and importing this one would pull in
 *  localStorage and `document` at import time. */
export function bumpNavTick(): void {
  navVersion += 1
  for (const fn of listeners) fn()
}

/** Reflects the flag onto <html> so the CSS block can key off it. Safe to
 *  call on every boot and on every toggle. */
export function applyDebugLayout(enabled: boolean): void {
  const root = document.documentElement
  if (enabled) root.setAttribute(DEBUG_LAYOUT_ATTR, 'on')
  else root.removeAttribute(DEBUG_LAYOUT_ATTR)
  // After the attribute, so a listener that measures sees the new cascade.
  for (const fn of listeners) fn()
}

/** Dumps the real measured heights of every stacked layer into the status
 *  line, so a "which box is short?" question is answered with NUMBERS rather
 *  than by staring at colors. Reading a rect is the only way to tell a short
 *  container apart from a correctly-sized one that's being clipped by its
 *  parent -- those look identical on screen. */
/** The focused node named the way the nav trace names its hops, so `focus:` and
 *  `nav:` can be compared line to line instead of mentally translated. */
function describeActive(el: Element | null): string {
  if (!el || el === document.body) return 'body'
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') ?? '').split(' ').filter(Boolean)[0]
  const label = el.getAttribute('aria-label')
  const group = el.closest<HTMLElement>('[data-nav-group]')?.dataset.navGroup ?? 'main'
  return `${tag}${cls ? '.' + cls : ''}${label ? `[${label}]` : ''} g:${group}`
}

export function measureLayers(): string {
  const px = (n: number): string => String(Math.round(n))
  const h = (sel: string): string => {
    const el = document.querySelector(sel)
    return el ? px(el.getBoundingClientRect().height) : '--'
  }
  const active = document.activeElement
  // On the glasses this string IS the debugging loop, so the three facts a swipe
  // changes go first and on their own lines. The layer heights below them answer
  // a different question (which box is short) and only get read second.
  if (document.documentElement.dataset.cursorless === 'on') {
    return [
      // The hop's OWN destination, not activeElement. React schedules the
      // repaint after the tick, so by the time this renders the DOM has usually
      // caught up -- but "usually" is the failure: on the glasses the highlight
      // moved instantly while the readout showed the PREVIOUS control, which
      // reads as the ring being slow rather than the readout being late.
      `focus: ${readLastNavTarget() ?? describeActive(active)}`,
      `nav:   ${readLastNav()}`,
      `key:   ${readLastKeySeen()}`,
      `vp:    ${window.innerWidth}x${window.innerHeight}  ptr:${pointerProbe()}`,
      `build: ${BUILD_STAMP}`
    ].join('\n')
  }
  return [
    `win${px(window.innerHeight)}`,
    `vv${px(window.visualViewport?.height ?? 0)}`,
    `root${h('.proRoot')}`,
    `card${h('.proCard')}`,
    `pad${h('.proTouchpad')}`,
    `ctl${h('.proControlsCell')}`,
    // Which host-capability branch the cursorless code actually took. On glasses
    // "the buttons don't respond" and "the gate read false so none of it ran"
    // look identical in the hand, and only this tells them apart.
    `ptr:${pointerProbe()}`,
    // Both the latched boot verdict and the CURRENT size. They disagree
    // whenever the host resizes after load (Meta's simulator does), which is
    // invisible in either number alone.
    `cursorless:${document.documentElement.dataset.cursorless ?? 'off'}`,
    `vp:${window.innerWidth}x${window.innerHeight}`,
    `focus:${active ? active.tagName.toLowerCase() + (active.className ? '.' + String(active.className).split(' ')[0] : '') : 'none'}`,
    `lastkey:${readLastKeySeen()}`,
    `nav:${readLastNav()}`
  ].join(' ')
}

/** Every pointer-ish media query at once -- `any-pointer: none` was a guess, and
 *  if the host reports a coarse/fine pointer instead, the gate is simply wrong. */
function pointerProbe(): string {
  const q = (s: string): string => (window.matchMedia(s).matches ? '1' : '0')
  return `none${q('(any-pointer: none)')}coarse${q('(any-pointer: coarse)')}fine${q('(any-pointer: fine)')}hover${q('(any-hover: hover)')}`
}


/**
 * The real value of env(safe-area-inset-bottom), measured rather than assumed.
 *
 * There's no way to read an env() from JS -- it only resolves inside CSS. So
 * this parks a zero-size probe element whose height IS the inset and reads the
 * rect back. Worth the eight lines: every fix to this layout so far has been
 * reasoned against an ASSUMED ~34px, and the gap being ~59px is what made the
 * arithmetic never quite close.
 */
function measureSafeAreaInset(): string {
  try {
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;bottom:0;left:0;width:0;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden'
    document.body.appendChild(probe)
    const h = probe.getBoundingClientRect().height
    document.body.removeChild(probe)
    return `${Math.round(h)}px`
  } catch {
    return '(probe failed)'
  }
}

/**
 * The full diagnostic dump behind tap-to-copy on the status line.
 *
 * Exists because the status line is one line on a phone screen, but the
 * questions that actually get asked about this layout need more than six
 * numbers -- and the alternative was Roy screenshotting the phone and someone
 * transcribing values out of the image by eye. Three bottom-strip fixes in a
 * row were shipped against WRONG assumptions that a single line of this
 * output would have killed immediately (the decisive fact the third time was
 * `body` measuring 793, not 852 -- nothing in the one-line version showed it).
 *
 * So this reports the two things a layout bug here is ever about:
 *   heights   -- every box in the stack, INCLUDING html and body, which the
 *                one-liner omits and which turned out to be the whole story.
 *   paint     -- the resolved background-color of each layer. "Which color
 *                fills the gap?" is the single most useful question for this
 *                surface, and answering it from a screenshot means guessing
 *                at a JPEG's pixels; the computed value is exact.
 *
 * Plain text, tab-free, one fact per line: it gets pasted into a chat message,
 * so it has to survive markdown and stay readable unstyled.
 */
export function buildDebugReport(): string {
  const px = (n: number): string => String(Math.round(n))
  const rect = (sel: string): string => {
    const el = document.querySelector(sel)
    if (!el) return `${sel}: (absent)`
    const r = el.getBoundingClientRect()
    return `${sel}: h=${px(r.height)} top=${px(r.top)} bottom=${px(r.bottom)}`
  }
  const paint = (sel: string): string => {
    const el = document.querySelector(sel)
    if (!el) return `${sel}: (absent)`
    const cs = getComputedStyle(el)
    // background-image is reported in full, data-URIs included -- those run to
    // thousands of chars and would bury everything else in the paste. Presence
    // is the only part that matters here ("is a texture layer painting?").
    const img = cs.backgroundImage && cs.backgroundImage !== 'none' ? ' +img' : ''
    return `${sel}: ${cs.backgroundColor}${img}`
  }
  const root = document.querySelector('.proRoot')
  const theme = root?.getAttribute('data-theme') ?? '(none)'
  const skin = root?.getAttribute('data-skin') ?? '(none)'
  const orient = root?.getAttribute('data-orient') ?? '(none)'

  return [
    `MightyMouse phone-remote debug`,
    `theme=${theme} skin=${skin} orient=${orient} dpr=${window.devicePixelRatio}`,
    `screen=${window.screen.width}x${window.screen.height}`,
    `innerHeight=${px(window.innerHeight)} visualViewport=${px(window.visualViewport?.height ?? 0)}`,
    `standalone=${(window.navigator as { standalone?: boolean }).standalone ?? 'n/a'}`,
    // The shell, not just `standalone` -- the native app reports standalone=n/a
    // AND display-mode=false, so neither line above distinguishes it from plain
    // Safari, which is exactly how the safe-area rules came to miss it.
    `shell=${document.documentElement.dataset.shell ?? '(unset)'} display-mode:standalone=${window.matchMedia('(display-mode: standalone)').matches}`,
    ``,
    `-- heights --`,
    rect('html'),
    rect('body'),
    rect('.proRoot'),
    rect('.proCard'),
    rect('.proTouchpad'),
    rect('.proControlsCell'),
    ``,
    `-- background --`,
    paint('html'),
    paint('body'),
    paint('.proRoot'),
    paint('.proCard'),
    ``,
    `-- safe area --`,
    `env(safe-area-inset-bottom)=${measureSafeAreaInset()}`,
    `--pro-safe-bottom=${root ? getComputedStyle(root).getPropertyValue('--pro-safe-bottom').trim() : '--'}`,
    ``,
    // The band below the viewport is painted by iOS, not by the page, so
    // nothing above this line can describe it -- the first report had six
    // heights and four background colors and still couldn't say what color
    // the visible gap was. These are the inputs iOS actually uses for it.
    `-- OS-painted band (below the ${px(window.innerHeight)}px viewport) --`,
    `gap=${window.screen.height - window.innerHeight}px (screen ${window.screen.height} - viewport ${px(window.innerHeight)})`,
    `meta theme-color=${document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '(absent)'}`,
    // debugLayout tells us whether the orange being reported is the debug
    // tint doing its job or a real seam. Without it every "still orange" is
    // ambiguous, which is how four fixes shipped unverifiable.
    `debugLayout=${document.documentElement.getAttribute('data-debug-layout') ?? 'off'}`,
    `buildStamp=${BUILD_STAMP}`,
    ``,
    // The keyboard lifecycle is the one thing on this surface that cannot be
    // photographed: it resolves in ~200ms and leaves only its outcome. Four
    // fixes shipped guessing at this ordering. It rides along in the same paste
    // so there is one thing to send, not two.
    `-- keyboard trace (oldest first) --`,
    formatKbTrace(),
    ``,
    `-- arrow nav trace (oldest first) --`,
    formatNavTrace()
  ].join('\n')
}

/**
 * The manifest's colors, prefetched at module load.
 *
 * They're the OTHER input iOS uses to paint the band below the viewport (the
 * fallback when theme-color is absent), and they live in a separate file the
 * page never otherwise reads -- so a report built purely from the DOM cannot
 * mention them. The value was stale (`#f5f4f2` cream against a steel deck)
 * while four fixes went looking for the seam in CSS.
 *
 * Fetched HERE, at import time, rather than inside the copy handler: awaiting
 * anything between the user's tap and the clipboard write costs Safari's
 * gesture trust and the copy silently fails. That exact mistake shipped once.
 * By the time anyone taps, this has long since resolved.
 */
let manifestColors = 'manifest colors=(not read yet)'
void (async () => {
  const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href')
  if (!href) {
    manifestColors = 'manifest colors=(no manifest link)'
    return
  }
  try {
    const res = await fetch(href, { cache: 'no-store' })
    const m = (await res.json()) as { background_color?: string; theme_color?: string }
    manifestColors = `manifest background_color=${m.background_color ?? '(unset)'} theme_color=${m.theme_color ?? '(unset)'}`
  } catch (err) {
    manifestColors = `manifest colors=(fetch failed: ${String(err)})`
  }
})()

/** Copies the report to the clipboard, returning whether it landed. Must be
 *  called synchronously inside the tap -- see copyText. */
export function copyDebugReport(): boolean {
  return copyText(`${buildDebugReport()}\n${manifestColors}`)
}

export function setDebugLayoutEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(DEBUG_LAYOUT_PREF_KEY, enabled ? 'on' : 'off')
  } catch {
    // Private mode / storage disabled -- the toggle still works for this
    // session via applyDebugLayout below, it just won't survive a reload.
  }
  applyDebugLayout(enabled)
}
