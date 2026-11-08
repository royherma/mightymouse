// Deck viewer -- see the phone-remote deck at every device size and orientation
// on the Mac, before touching a phone.
//
// WHY THIS EXISTS: the trackpad's shape is a clip-path computed at runtime from
// the MEASURED rects of the button rows (useNotchPath.ts). That makes it
// invisible to typecheck, invisible to the unit tests (they feed frozen
// three-row fixtures), and previously only checkable by loading it on a real
// iPhone -- which is also the one thing we must not do casually, since a second
// client kicks the real phone off its socket. So a pad-over-buttons regression
// could only be caught by Roy noticing it on his device.
//
// This runs the REAL built bundle in an iframe per device, which means the real
// notch algorithm against real rects, and then MEASURES whether the clipped pad
// actually covers any button. Two seams make that possible without a server:
// `window.__MM_LAYOUT_PREFS__` (App.tsx:81, read at first paint) and
// `window.__MM_PREVIEW__` (App.tsx:419, suppresses the reconnect banner) --
// both already used by the skin pipeline's preview.py.
//
// Measured, never assumed: a harness that hand-derives geometry invents failure
// modes the app does not have (memory `harness-must-measure-not-assume`).

// Devices worth checking, as CSS pixel viewports. The pad's shape depends on
// the pad's own width (MIN_STEP_FRAC scales the sliver threshold to it), so
// small/large matters, not just orientation.
//
// safeSide is the LANDSCAPE left/right inset. iOS reports the notch inset on
// both sides once rotated (it does not hand the safe side a 0), so one number
// covers the pair and the deck stays symmetric whichever way the phone turned.
// It equals the device's portrait safeTop on notched phones and is 0 on the SE,
// whose bezel needs no carve. safeBottomLandscape is the shorter home-indicator
// band -- 34px upright becomes 21px on its side.
const DEVICES = [
  { name: 'iPhone SE',        w: 375, h: 667, safeTop: 20, safeBottom: 0,  safeSide: 0,  safeBottomLandscape: 0 },
  { name: 'iPhone 13 mini',   w: 375, h: 812, safeTop: 50, safeBottom: 34, safeSide: 50, safeBottomLandscape: 21 },
  { name: 'iPhone 14',        w: 390, h: 844, safeTop: 47, safeBottom: 34, safeSide: 47, safeBottomLandscape: 21 },
  { name: 'iPhone 15 Pro',    w: 393, h: 852, safeTop: 59, safeBottom: 34, safeSide: 59, safeBottomLandscape: 21 },
  { name: 'iPhone 15 Pro Max',w: 430, h: 932, safeTop: 59, safeBottom: 34, safeSide: 59, safeBottomLandscape: 21 }
]

// Built-in ids only. Remote/image skins need their CSS installed on the device,
// which this static viewer deliberately does not do.
const SKINS = ['proII', 'default']

/** A stand-in for what the Mac pushes over the socket.
 *
 *  The app-context bar renders from `appContextState`, a socket message a
 *  never-connected harness can never receive -- so without this the bar is
 *  simply absent here, and the profile sheet (the surface that has been wrong
 *  twice) could only be checked on a real phone.
 *
 *  Modelled on Roy's actual Chrome, because the two failure modes are both
 *  about REAL data: four profiles open and twenty dormant ones, names that
 *  repeat, and a display name carrying its own parentheses. A tidy fixture of
 *  three short names would render beautifully and prove nothing.
 *
 *  Icons are deliberately '' -- the monogram fallback is the branch worth
 *  seeing, and base64 avatars would bloat this file for no extra coverage. */
const FAKE_CONTEXT = {
  adapterId: 'chrome',
  appName: 'Google Chrome',
  bundleId: 'com.google.Chrome',
  appIconPngBase64: '',
  activeGroupId: 'Default',
  groups: [
    { id: 'Default', name: 'Person 1', iconPngBase64: '', subtitle: 'dev@example.com', itemCount: 10, active: true },
    { id: 'Profile 16', name: "TechGuyver (my socials)", iconPngBase64: '', subtitle: 'dev2@example.com', itemCount: 14, active: true },
    { id: 'Profile 25', name: 'sidecar', iconPngBase64: '', subtitle: 'dev3@example.com', itemCount: 2, active: true },
    { id: 'Profile 15', name: 'acme.example', iconPngBase64: '', subtitle: 'alex@acme.example', itemCount: 1, active: true },
    // The idle half of the split. "Roy" is the impostor that used to win the
    // title match despite having no window open.
    { id: 'Profile 9', name: 'Roy', iconPngBase64: '', subtitle: '', itemCount: 0, active: false },
    { id: 'Profile 3', name: 'studio.example', iconPngBase64: '', subtitle: 'alex@studio.example', itemCount: 0, active: false },
    { id: 'Profile 7', name: 'studio.example', iconPngBase64: '', subtitle: 'support@studio.example', itemCount: 0, active: false }
  ],
  items: [
    { id: '1', title: 'MightyMouse — bring frontier AI into everyday life', subtitle: 'https://getmightymouse.com', active: true, iconPngBase64: '' },
    { id: '2', title: 'Inbox (12)', subtitle: 'https://mail.google.com/mail/u/0', active: false, iconPngBase64: '' },
    { id: '3', title: 'ShowAndTell', subtitle: 'https://github.com/roy/showandtell', active: false, iconPngBase64: '' }
  ]
}

// The global toggles are DEFAULTS for new cells, not a filter over them: each
// cell owns its own keys/hand once rendered, so two configs can sit side by
// side. Comparing "keys top vs bottom" by flipping one global toggle means
// never seeing them together, which is the comparison that actually answers
// "did this move break the other position?".
const state = {
  skin: 'proII',
  orient: 'both',
  keysPosition: 'bottom',
  handedness: 'right',
  // Landscape-only: one control cluster ('stacked', as shipped) or one per
  // thumb ('split'). Portrait ignores it, so a portrait cell renders the same
  // either way -- that is the app's behavior, not a viewer bug.
  deckMode: 'stacked',
  // Which split shape, when deckMode is 'split'. Ignored by the stacked deck,
  // exactly as the app ignores it.
  splitConcept: 'fan',
  mirror: false,
  // The app-switch ring around the control cluster. Ships OFF, so the viewer
  // defaults to OFF too -- a harness that previews a non-default state hides
  // whatever the default actually looks like.
  appRing: false,
  boxes: true,
  safe: false,
  // 'one' = one deck per device at the global keys/hand/deck. 'corners' = all
  // four keys×hand combos per device at the global deck mode. 'decks' = the
  // stacked-vs-split comparison at the global keys/hand, which is the view that
  // answers "is split actually more reachable on THIS phone?" -- a question you
  // cannot answer by flipping one global toggle and losing the other side.
  // 'concepts' = all four split shapes side by side at the global keys/hand,
  // which is the only view that compares them against each other rather than
  // against the stacked deck.
  mode: 'one',
  // Which overlay to open on every deck after it boots. These are React state
  // inside App.tsx, not layout prefs, so there is no seam to inject -- the
  // viewer opens them the way a finger does, by clicking the real trigger.
  // That also means what you see is the real code path, not a mock.
  overlay: 'none'
}

/* ---- URL state -------------------------------------------------------------

   Every toggle is also a query param, so a view is a link: `?mode=concepts` or
   `?deck=split&concept=rails&hand=left` boots straight into it instead of five
   taps. The URL is rewritten on every render, so whatever is on screen is
   always the thing the address bar describes -- copy it and you get back here.

   Params are the SHORT name (`hand`, not `handedness`) because these get typed
   by hand. Anything unrecognised is ignored and the default stands: a typo'd
   param must not boot a state no toggle can express, or the buttons and the
   deck disagree with no way to tell which one lied. */
const URL_PARAMS = {
  skin: ['skin', () => SKINS],
  orient: ['orient', () => ['both', 'portrait', 'landscape']],
  mode: ['mode', () => ['one', 'corners', 'decks', 'concepts']],
  keysPosition: ['keys', () => ['bottom', 'top']],
  handedness: ['hand', () => ['right', 'left']],
  deckMode: ['deck', () => DECK_MODES],
  splitConcept: ['concept', () => SPLIT_CONCEPTS],
  overlay: ['overlay', () => [...Object.keys(OVERLAYS), ...Object.keys(NESTED_OVERLAYS)]],
  // Booleans read the string, so `boxes=0` and `boxes=false` both turn it off.
  mirror: ['mirror', null],
  appRing: ['ring', null],
  boxes: ['boxes', null],
  safe: ['safe', null]
}

function readUrlState() {
  const q = new URLSearchParams(location.search)
  for (const [key, [param, valuesOf]] of Object.entries(URL_PARAMS)) {
    const raw = q.get(param)
    if (raw === null) continue
    if (!valuesOf) {
      state[key] = raw !== '0' && raw !== 'false'
      continue
    }
    // Compared as strings: the value lists hold strings, and a param always is.
    if (valuesOf().map(String).includes(raw)) state[key] = raw
  }
}

/** Rewrite the address bar to match `state`, omitting anything still at its
 *  default so a shared link carries only what was deliberately changed. */
function writeUrlState(defaults) {
  const q = new URLSearchParams()
  for (const [key, [param]] of Object.entries(URL_PARAMS)) {
    if (state[key] === defaults[key]) continue
    q.set(param, String(state[key]))
  }
  const qs = q.toString()
  // replaceState, not pushState: a toggle is not a navigation, and filling the
  // back stack with 30 near-identical states makes Back unusable.
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
}

// Each overlay names the control that opens it. Selectors, not refs, because
// the viewer reaches into the iframe's DOM from outside the React tree.
const OVERLAYS = {
  none: null,
  keyboard: '.proKeyPill[aria-label="Keyboard"], .proKeyPill[data-img="keyboard"]',
  switcher: '[aria-label="App switcher"]',
  settings: '[aria-label="Settings"]',
  chat: '.chatBtn',
  history: '.historyBtn'
}

// Overlays reachable only from INSIDE another overlay. The app-context bar
// rides the virtual keyboard, so its dropdowns need the keyboard open first --
// one selector cannot express that, and clicking a chip that has not mounted
// yet is exactly the silent no-op openOverlay() was written to report.
const NESTED_OVERLAYS = {
  profiles: { after: 'keyboard', sel: '.bbProfile' },
  tabs: { after: 'keyboard', sel: '.bbTab' }
}

const CORNERS = [
  { keysPosition: 'top', handedness: 'left' },
  { keysPosition: 'top', handedness: 'right' },
  { keysPosition: 'bottom', handedness: 'left' },
  { keysPosition: 'bottom', handedness: 'right' }
]

const DECK_MODES = ['stacked', 'split']

// The four split shapes from the landscape-split PRD. Order matches the measured
// ranking there -- fan first, because it is the only one that strands no control
// outside the thumb arc.
const SPLIT_CONCEPTS = ['fan', 'pods', 'rails', 'mirror', 'groups']

// Deck sweep: same keys/hand on both cells, so the ONLY difference between them
// is the thing being compared. Inheriting the globals rather than pinning a
// combo means the comparison follows whatever grip you are currently looking at.
const decksFor = (cfg) => DECK_MODES.map((deckMode) => ({ ...cfg, deckMode }))

// Concept sweep forces deckMode: 'split' -- a stacked cell would render the same
// deck four times, which reads as a broken sweep rather than "concept ignored".
const conceptsFor = (cfg) =>
  SPLIT_CONCEPTS.map((splitConcept) => ({ ...cfg, deckMode: 'split', splitConcept }))

const cornerLabel = (c) => `${c.keysPosition}-${c.handedness}`
const deckLabel = (c) => (c.deckMode === 'split' ? 'split · both thumbs' : 'stacked · one side')
const conceptLabel = (c) => c.splitConcept

const $ = (id) => document.getElementById(id)

function toggleRow(host, values, key, labels = {}) {
  host.innerHTML = ''
  for (const v of values) {
    const b = document.createElement('button')
    b.className = 't'
    b.textContent = labels[v] ?? v
    b.setAttribute('aria-pressed', String(state[key] === v))
    b.onclick = () => { state[key] = v; render() }
    host.appendChild(b)
  }
}

// The bundle lives one level up from this folder; the viewer is served from the
// repo so these are plain relative paths.
const BUNDLE = '../dist/index.html'

/** Prefs the app reads at first paint. Shape mirrors App.tsx:61 exactly -- a
 *  missing key falls back to the app's own default, which would silently
 *  preview something other than what the toggles say. */
function prefsFor(cfg = state) {
  return {
    layout: 'pro',
    skin: state.skin,
    colorScheme: 'light',
    handedness: cfg.handedness,
    keysPosition: cfg.keysPosition,
    deckMode: cfg.deckMode,
    splitConcept: cfg.splitConcept,
    showCursor: true,
    appRing: state.appRing,
    renderMarkup: false
  }
}

/** Fake a live screen mirror.
 *
 *  The mirror is NOT a layout pref -- it is a runtime state driven by a WebRTC
 *  stream, which is why passing `mirror` in __MM_LAYOUT_PREFS__ did nothing at
 *  all. But the pad's landscape geometry reads only two things (theme.css
 *  :5222-5241): the `data-mirror` attribute on .proRoot, and the
 *  `--pro-mirror-w` custom property App.tsx writes on <html> from the stream's
 *  aspect ratio. Both are reachable without a stream, so the exact pad box a
 *  real mirror produces is reproducible here -- and that box is what
 *  useNotchPath measures.
 *
 *  Width follows sizeMirrorPane's landscape branch: aspect-derived at the
 *  column height, then capped so the pad keeps its floor. A 16:10 Mac display
 *  is the default because that is the shape that first overflowed. */
const MAC_ASPECT = 16 / 10
// Fallbacks only. --pro-inset/--pro-gutter are read from the live document in
// applyMirror; PAD_MIN_WIDTH is scraped from the bundle by padMinWidth() below.
//
// A hardcoded copy of PRO_LANDSCAPE_PAD_MIN_WIDTH sat here at 244 while
// config.ts said 256, so the viewer kept rendering the PRE-FIX geometry and
// reported "pad 242" on a build that had already been fixed -- three rounds of
// "it's back!" chasing a stale duplicate (Roy, 2026-07-26). Never copy a
// constant the bundle already ships.
const PRO_INSET = 14
const PRO_GUTTER = 18
const PAD_MIN_WIDTH_FALLBACK = 256

// Read the real constant out of the built bundle rather than duplicating it.
// It is minified, but the property NAME survives as `PAD_MIN_WIDTH:<n>` because
// it is a config object key, so one regex over the JS is enough.
let padMinWidthCache = null
async function padMinWidth() {
  if (padMinWidthCache !== null) return padMinWidthCache
  try {
    const html = await loadBundleHtml()
    const src = html.match(/assets\/index-[^"']+\.js/)?.[0]
    const js = src ? await (await fetch(`../dist/${src}`)).text() : ''
    const hit = js.match(/PAD_MIN_WIDTH:\s*(\d+)/)
    padMinWidthCache = hit ? Number(hit[1]) : PAD_MIN_WIDTH_FALLBACK
    if (!hit) console.warn('[deck-viewer] PAD_MIN_WIDTH not found in bundle; using fallback')
  } catch {
    padMinWidthCache = PAD_MIN_WIDTH_FALLBACK
  }
  return padMinWidthCache
}

/** Poll until the deck mounts, then apply. A fixed delay silently no-ops when
 *  the bundle is slow, and a no-op here looks exactly like "mirror changes
 *  nothing" -- the very bug this is meant to reproduce. */
function applyMirrorWhenReady(frame, landscape, tries = 40) {
  if (frame.contentDocument?.querySelector('.proRoot')) return applyMirror(frame, landscape)
  if (tries <= 0) return
  setTimeout(() => applyMirrorWhenReady(frame, landscape, tries - 1), 25)
}

/** Open the selected overlay by clicking its real trigger.
 *
 *  Polls for the control because the deck mounts asynchronously, and reports a
 *  miss to the console rather than failing silently -- a toggle that quietly
 *  does nothing is indistinguishable from a working one that found nothing, and
 *  that exact ambiguity already cost a round trip on the mirror toggle. */
function openOverlay(frame, overlay = state.overlay, tries = 40) {
  return new Promise((resolve) => {
    const nested = NESTED_OVERLAYS[overlay]
    const sel = nested ? nested.sel : OVERLAYS[overlay]
    if (!sel) return resolve(true)
    const attempt = (left) => {
      const doc = frame.contentDocument
      // Wait for the DECK, not just the trigger: clicking into a half-mounted
      // tree is what left cells blank. `.proRoot` is the mount signal every
      // other reader here already uses.
      const el = doc?.querySelector('.proRoot') ? doc.querySelector(sel) : null
      if (el) {
        // preventScroll keeps ten simultaneous opens from fighting over focus
        // and scrolling the parent page around; blur returns focus to the page
        // so the last deck opened does not sit holding a caret.
        el.focus?.({ preventScroll: true })
        el.click()
        el.blur?.()
        return resolve(true)
      }
      if (left <= 0) {
        console.warn(`[deck-viewer] overlay "${overlay}": no element matches ${sel}`)
        return resolve(false)
      }
      setTimeout(() => attempt(left - 1), 25)
    }
    attempt(tries)
  })
}

/** Open a nested overlay by opening its parent FIRST and awaiting it.
 *
 *  Sequential, not fire-and-forget: the app-context bar mounts only once the
 *  keyboard is focused, so polling for `.bbProfile` in the same tick races a
 *  trigger that does not exist yet. It would usually win on a fast machine and
 *  lose under ten simultaneous boots -- the intermittent kind of harness bug
 *  that reads as "the sheet is broken" rather than "the harness is early". */
async function openOverlayChain(frame) {
  const nested = NESTED_OVERLAYS[state.overlay]
  if (!nested) return openOverlay(frame)
  if (await openOverlay(frame, nested.after)) await openOverlay(frame)
}

function applyMirror(frame, landscape) {
  const doc = frame.contentDocument
  const root = doc.querySelector('.proRoot')
  if (!root) return
  root.setAttribute('data-mirror', state.mirror ? 'on' : 'off')
  if (!state.mirror || !landscape) {
    doc.documentElement.style.removeProperty('--pro-mirror-w')
    return
  }
  const win = frame.contentWindow
  // Read the real vars off the live deck rather than trusting the copies above
  // -- theme.css owns these numbers and has changed them before.
  const cs = win.getComputedStyle(root)
  const px = (name, fallback) => parseFloat(cs.getPropertyValue(name)) || fallback
  const inset = px('--pro-inset', PRO_INSET)
  const gutter = px('--pro-gutter', PRO_GUTTER)
  // Resolved by padMinWidth() during boot, so this stays synchronous.
  const PAD_MIN_WIDTH = padMinWidthCache ?? PAD_MIN_WIDTH_FALLBACK
  // The column's height is what CSS pins; width follows from the aspect ratio.
  const ideal = (win.innerHeight - inset * 2) * MAC_ASPECT
  const available = win.innerWidth - inset * 2 - gutter - PAD_MIN_WIDTH
  const width = Math.max(0, Math.min(ideal, available))
  doc.documentElement.style.setProperty('--pro-mirror-w', `${width}px`)
}

/** Boot the real bundle inside `frame` with our prefs injected before its
 *  module script runs. Fetching + rewriting the HTML (rather than pointing the
 *  iframe at index.html and racing it) is the only way to win that race
 *  deterministically: a module script is deferred, but srcdoc would break every
 *  relative asset path, so we write into the same-origin document instead. */
async function boot(frame, html) {
  // A SECOND doc.write into an already-loaded iframe does not reliably re-mount
  // the app -- the deck comes back empty ("no deck") on every re-boot after the
  // first. Replacing the iframe element gives each boot a genuinely fresh
  // document, which is what the per-cell top/bottom buttons need.
  const fresh = frame.cloneNode(false)
  frame.replaceWith(fresh)
  await new Promise((r) => requestAnimationFrame(r))
  const doc = fresh.contentDocument
  doc.open()
  doc.write(html)
  doc.close()
  return fresh
}

let bundleHtml = null
async function loadBundleHtml() {
  if (bundleHtml) return bundleHtml
  const res = await fetch(BUNDLE)
  if (!res.ok) throw new Error(`no built bundle at ${BUNDLE} — run: npm run build:phone-remote`)
  let html = await res.text()
  // Every relative URL in the bundle (./assets/*, ./cork.webp) must still
  // resolve once the document is written into an iframe whose own URL is this
  // folder. A <base> is the one-line fix and leaves the bundle untouched.
  html = html.replace('<head>', `<head><base href="../dist/">`)
  bundleHtml = html
  return html
}

/** Simulate a device's safe-area insets inside the iframe.
 *
 *  WHY THIS IS NOT JUST A PREF: `env(safe-area-inset-*)` is a platform value
 *  with no JS setter and no override -- an iframe on a Mac reports 0 on all
 *  four edges no matter what the parent does. So until now the harness DREW a
 *  pink band where the notch would be while the deck inside it resolved every
 *  inset to 0. The overlay and the layout under it disagreed, and the one bug
 *  the band exists to catch (content running under the notch in landscape) was
 *  invisible by construction.
 *
 *  The deck reads the insets as `calc(env(safe-area-inset-X, 0px) + ...)` at 28
 *  call sites (theme.css), all going through the same two shapes. Rather than
 *  restate 28 rules here -- which would drift the moment one moves -- this
 *  redefines the FALLBACK path: every call site already passes `0px` as the
 *  fallback, so a real device substitutes its inset and this harness cannot.
 *  What it CAN do is add the inset back as padding on the root, which is what
 *  the insets mean geometrically: keep content off that edge.
 *
 *  This is a simulation, not the platform. It proves whether a layout leaves
 *  room, not that iOS reports these exact numbers -- those come from the device
 *  table above. Anything that reads env() in JS still sees 0 here. */
function safeAreaCss(dev, landscape) {
  const side = landscape ? dev.safeSide : 0
  const top = landscape ? 0 : dev.safeTop
  const bottom = landscape ? dev.safeBottomLandscape : dev.safeBottom
  // .proRoot stays FULL-BLEED. Insetting it was wrong and looked it: the deck's
  // wood grain started 50px in and left bare gutters down both edges, while the
  // pad -- which insets itself -- moved twice. theme.css:4906 already reads the
  // insets on .proTouchpad, and :4908 says the pad runs to the very bottom on
  // purpose, so the deck is the SCREEN and each child clears its own edge.
  // Overriding the children is also what makes the SE (side 0) prove the shim:
  // it must render identically to no shim at all.
  const pad = `calc(${side}px + var(--pro-inset))`
  return (
    `<style id="mm-harness-safe-area">` +
    `.proRoot{background-color:#000;}` +
    // The pad and the cluster are the two surfaces that must clear the notch.
    // Bottom stays untouched: it is deliberately not inset (theme.css:4908).
    `.proRoot[data-orient='landscape'] .proTouchpad{` +
    `left:${pad}!important;right:${pad}!important;}` +
    // The status line centres across the full width and would otherwise sit
    // under the notch on the side the phone was rotated toward.
    `.proRoot[data-orient='landscape'] .proStatus{` +
    `padding-left:${side + 16}px!important;padding-right:${side + 16}px!important;}` +
    // The cluster is pinned by BOTH edges (theme.css:5989-6006), and which edge
    // carries the mirror column flips with handedness -- so restating one edge
    // would shove it out from under the pad it shares a corner with. Each
    // handedness gets the same pair theme.css gives it, with env() substituted.
    `.proRoot[data-orient='landscape'][data-hand='right'] .proControlsCell{` +
    `left:calc(${side}px + var(--pro-inset) + var(--pro-mirror-w,55%) + var(--pro-gutter))!important;` +
    `right:${pad}!important;}` +
    `.proRoot[data-orient='landscape'][data-hand='left'] .proControlsCell{` +
    `left:${pad}!important;` +
    `right:calc(${side}px + var(--pro-inset) + var(--pro-mirror-w,55%) + var(--pro-gutter))!important;}` +
    // Mirror off is last so it wins over handedness, exactly as in theme.css.
    `.proRoot[data-orient='landscape'][data-mirror='off'] .proControlsCell{` +
    `left:${pad}!important;right:${pad}!important;}` +
    `</style>`
  )
}

function inject(html, prefs, dev, landscape) {
  if (dev) html = html.replace('</head>', safeAreaCss(dev, landscape) + '</head>')
  const script =
    `<script>window.__MM_LAYOUT_PREFS__=${JSON.stringify(prefs)};` +
    `window.__MM_PREVIEW__=true;` +
    `window.__MM_APP_CONTEXT__=${JSON.stringify(FAKE_CONTEXT)};` +
    // The scroll rail opens on a gesture no iframe can perform, so seed it open.
    `window.__MM_RAIL_OPEN__=true;` +
    // The Keyboard pill dispatches on a phone-local pref (virtual-keyboard-pref.ts),
    // and its default -- OFF -- focuses a hidden <input> to summon the OS keyboard.
    // On a Mac that draws no overlay at all, just yanks focus, so ten decks racing
    // to focus their own input read as a page full of dead phones. Seed the pref ON
    // so the pill opens the in-page keyboard, which is the thing worth looking at.
    `try{localStorage.setItem('mm-remote-virtual-keyboard','on')}catch(e){}<\/script>`
  return html.replace('</head>', script + '</head>')
}

/** Rect intersection area. Zero when they merely touch. */
function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

/** Does the CLIPPED pad actually paint over this button?
 *
 *  The pad's bounding box always overlaps the buttons -- the notch is a
 *  clip-path, so the element's rect stays rectangular while the painted shape
 *  has a bite taken out of it. Comparing bounding boxes would therefore report
 *  a collision on a perfectly correct deck. The only honest test is to ask
 *  whether a point is inside the clip PATH, which is what isPointInPath on the
 *  real `d` answers. Sampling a grid over the button (not just its centre)
 *  because a centre-only check passes a button whose top half is covered
 *  (memory `hit-target-centre-check-passes-dead-targets`). */
/** Fraction of a control's box that the CLIPPED pad actually covers.
 *
 *  `pathDs` is every path in the clip chain. Split mode nests two <clipPath>s,
 *  and nesting INTERSECTS -- so the pad is painted where a point is inside ALL
 *  of them. Testing only the first path would report every off-hand control as
 *  buried under the pad, because that corner is carved by the second path and
 *  the first one knows nothing about it. */
function padCoversButton(win, padEl, pathDs, btnRect) {
  const ds = (Array.isArray(pathDs) ? pathDs : [pathDs]).filter(Boolean)
  if (!ds.length) return 0
  const pad = padEl.getBoundingClientRect()
  // The path is authored in the pad's UNSCALED local space (userSpaceOnUse),
  // so screen rects must be converted back the same way useNotchPath does.
  const scale = pad.width / (padEl.offsetWidth || pad.width)
  const paths = ds.map((d) => new win.Path2D(d))
  const ctx = win.document.createElement('canvas').getContext('2d')
  let covered = 0
  let total = 0
  const STEPS = 7
  for (let i = 0; i <= STEPS; i++) {
    for (let j = 0; j <= STEPS; j++) {
      const x = btnRect.left + (btnRect.width * i) / STEPS
      const y = btnRect.top + (btnRect.height * j) / STEPS
      total++
      const lx = (x - pad.left) / scale
      const ly = (y - pad.top) / scale
      if (paths.every((p) => ctx.isPointInPath(p, lx, ly))) covered++
    }
  }
  return covered / total
}

/** Is every point of this control actually the topmost element there?
 *
 *  A control can pass the notch check (nothing clipped over it) and still be
 *  dead, because some OTHER fixed element -- a bar, a sheet edge, an invisible
 *  full-bleed overlay -- sits on top. This deck has several independently
 *  `position: fixed` layers with no shared coordinate system, so two
 *  individually-correct rules still collide (CLAUDE.md, 2026-07-18).
 *
 *  Walks the whole box rather than the centre: a centre-only probe passes a
 *  target whose top half is covered (memory
 *  `hit-target-centre-check-passes-dead-targets`). Returns the covering element
 *  when one is found, since "what is on top" is the part that takes debugging
 *  time -- "it's blocked" alone sends you looking at the wrong layer. */
function topmostBlocker(doc, el, r) {
  const STEP = 4
  // These controls are pills (border-radius ~50%), so the corners of the
  // bounding box are OUTSIDE the painted shape and elementFromPoint there
  // legitimately returns whatever is behind -- normally the button's own card.
  // Sampling from the box edge reported `.proCard`, a full-bleed ANCESTOR, as a
  // blocker on every landscape cell. Inset past the corner radius and probe the
  // area a finger can actually land on.
  const inset = Math.min(r.width, r.height) * 0.25
  const x0 = r.left + inset
  const x1 = r.right - inset
  const y0 = r.top + inset
  const y1 = r.bottom - inset
  for (let y = y0; y <= y1; y += STEP) {
    for (let x = x0; x <= x1; x += STEP) {
      const hit = doc.elementFromPoint(x, y)
      if (!hit) continue
      // The control itself or its own descendants (icon, label) are a pass...
      if (hit === el || el.contains(hit)) continue
      // ...and so is any ANCESTOR of it. A parent showing through is the normal
      // stacking order, not an element covering the control -- treating it as
      // one is what produced the false positive above.
      if (hit.contains(el)) continue
      const tag = hit.getAttribute('aria-label') ||
        hit.className?.toString?.().split(' ').filter(Boolean)[0] ||
        hit.tagName.toLowerCase()
      return { at: `${Math.round(x - r.left)},${Math.round(y - r.top)}`, by: tag }
    }
  }
  return null
}

/** Do two fixed layers overlap where neither is meant to cover the other?
 *
 *  Reported as raw intersecting pairs rather than a pass/fail, because a sheet
 *  legitimately covers the deck while it is open -- the verdict text already
 *  says when an overlay is up, so the reader can tell an intentional cover from
 *  a collision. */
function fixedLayerCollisions(win, doc) {
  const layers = [...doc.querySelectorAll('body *')].filter((el) => {
    const cs = win.getComputedStyle(el)
    if (cs.position !== 'fixed') return false
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    if (parseFloat(cs.opacity || '1') === 0) return false
    // Pointer-transparent scrims are painted on purpose and collide with
    // everything by design; they are not what this is hunting.
    if (cs.pointerEvents === 'none') return false
    const r = el.getBoundingClientRect()
    return r.width > 2 && r.height > 2
  })
  const pairs = []
  for (let i = 0; i < layers.length; i++) {
    for (let j = i + 1; j < layers.length; j++) {
      const a = layers[i]
      const b = layers[j]
      if (a.contains(b) || b.contains(a)) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const area = overlapArea(ra, rb)
      if (area <= 4) continue
      const name = (el) =>
        el.className?.toString?.().split(' ').filter(Boolean)[0] || el.tagName.toLowerCase()
      pairs.push(`${name(a)}∩${name(b)} ${Math.round(area)}px²`)
    }
  }
  return pairs
}

/** Measure one booted frame. Returns a verdict plus the boxes to draw. */
function measure(frame) {
  const win = frame.contentWindow
  const doc = frame.contentDocument
  const padEl = doc.querySelector('.proTouchpad')
  if (!padEl) return { state: 'wait', note: 'deck not mounted yet' }
  // Both bites. The B path exists only in split mode; absent, the chain is the
  // single shipped path and this collapses to the stacked-mode measurement.
  const pathDs = ['proNotchDynamicPath', 'proNotchDynamicPathB']
    .map((id) => doc.getElementById(id)?.getAttribute('d') ?? null)
    .filter(Boolean)

  // The key rows are DIV.proKeyPill, not <button> -- a `button` selector finds
  // only the icon row's 4 buttons and silently reports "clear" while never
  // testing the very rows the notch exists to clear. Target the leaf controls
  // in both rows explicitly.
  const buttons = [
    ...doc.querySelectorAll('.proKeyPill, .proIconBtn, .proMicBtn')
  ].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })

  const boxes = []
  const hits = []
  const padRect = padEl.getBoundingClientRect()
  boxes.push({ cls: 'pad', r: padRect })

  // Why a hit happened, not just that it did. useNotchPath snaps any level
  // whose inner edge sits within minStepX of the pad edge (MIN_STEP_FRAC .045
  // of the pad width, floor 8), and merges neighbouring levels closer than
  // that -- both are width-dependent, so a pad narrowed by the mirror crosses
  // thresholds a full-width pad never does. Reporting the numbers turns "the
  // clamp probably fired" into something checkable.
  // offsetWidth IS the unscaled local width -- the same quantity useNotchPath
  // calls `w` after unscaling.
  const padW = padEl.offsetWidth || padRect.width
  const minStepX = Math.max(padW * 0.045, 8)

  const blocked = []
  for (const el of buttons) {
    const r = el.getBoundingClientRect()
    const frac = padCoversButton(win, padEl, pathDs, r)
    const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 12) || 'btn'
    // How far this control's inner edge sits from the pad's -- the quantity
    // both clamps are compared against.
    const inset = Math.round(r.left - padRect.left)
    if (frac > 0) hits.push({ label, frac, inset })
    // Only worth asking when the notch already cleared this control: if the pad
    // covers it, the pad IS the blocker and the hit list already says so.
    if (frac === 0) {
      const blk = topmostBlocker(doc, el, r)
      if (blk) blocked.push({ label, ...blk })
    }
    boxes.push({ cls: frac > 0 || blocked.some((b) => b.label === label) ? 'hit' : 'btn', r })
  }

  // What the RING measures, drawn rather than inferred. Mirrors controlsRect()
  // in useAppRing.ts: the leaf buttons plus the floating context bar, which is a
  // sibling of the cluster cell and so needs a card-wide lookup. Drawing both
  // boxes is what turned "the arc must be clearing the bar" into a visible no.
  const barEl = doc.querySelector('.floatingContextBar')
  if (barEl) {
    const br = barEl.getBoundingClientRect()
    if (br.width > 0 && br.height > 0) boxes.push({ cls: 'bar', r: br })
  }
  const wrapEls = [...buttons, ...(barEl ? [barEl] : [])]
  if (wrapEls.length) {
    let l = Infinity, t = Infinity, rr = -Infinity, bb = -Infinity
    for (const el of wrapEls) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      l = Math.min(l, r.left); t = Math.min(t, r.top)
      rr = Math.max(rr, r.right); bb = Math.max(bb, r.bottom)
    }
    if (Number.isFinite(l)) boxes.push({ cls: 'wrap', r: { left: l, top: t, width: rr - l, height: bb - t } })
  }

  const collisions = fixedLayerCollisions(win, doc)

  // The ring's own numbers: the arc's painted radius against the cluster legs it
  // is supposed to clear. `wrap` is what the radius must reach to miss the
  // controls; a radius under it is an arc drawn through them, which is the whole
  // failure this readout exists to make visible without a screenshot.
  const ringEl = doc.querySelector('.proAppRing .proAppRingTrack')
  let ringGeom = ''
  let ringTrace = null
  if (ringEl) {
    const d = ringEl.getAttribute('d') || ''
    const m = d.match(/A\s+([\d.]+)/)
    const r = m ? Number(m[1]) : null
    // Trace the arc into the overlay's own coordinates. The ring's SVG sits
    // inside the deck and paints in the skin's colors, which on a cork skin is
    // near-invisible -- so the path is redrawn on top in a color nothing else
    // uses. Without this the ring cannot be told apart from the notch carve,
    // which is exactly the confusion that cost this session two rounds.
    const svgEl = ringEl.ownerSVGElement || ringEl.closest('svg')
    if (svgEl) {
      const sr = svgEl.getBoundingClientRect()
      ringTrace = { d, left: sr.left, top: sr.top, width: sr.width, height: sr.height,
        strokeWidth: Number(win.getComputedStyle(ringEl).strokeWidth.replace('px', '')) || 2 }
    }
    const wrapBox = boxes.find((b) => b.cls === 'wrap')
    if (r !== null && wrapBox) {
      // Cluster legs measured from the corner the arc is centred on -- the pad
      // corner nearest the cluster, which is the wrap box's outer corner.
      const legX = Math.round(wrapBox.r.width)
      const legY = Math.round(wrapBox.r.height)
      const need = Math.max(legX, legY)
      ringGeom = ` · ring r=${Math.round(r)} vs cluster ${legX}×${legY} (needs ≥${need}${r < need ? ' ✗ CUTS THROUGH' : ' ✓'})`
    }
  }

  // The scroll rail's own clearance: the gap from the island's bottom to the
  // topmost thing it has to stack above on that edge. Negative means it landed
  // ON the bar/ring/buttons, which is exactly what a screenshot of a dark skin
  // hides. `railFaults` feeds the same fault list the notch checks use.
  const railEl = doc.querySelector('.proScrollRail')
  const railFaults = []
  let railGeom = ''
  if (railEl) {
    const rr2 = railEl.getBoundingClientRect()
    let obstacle = null
    for (const sel of ['.floatingContextBar', '.proAppRingTrack', '.proKeyPill', '.proIconBtn', '.proMicBtn']) {
      for (const el of doc.querySelectorAll(sel)) {
        const b = el.getBoundingClientRect()
        if (b.height < 1 || b.right <= rr2.left || b.left >= rr2.right) continue
        if (!obstacle || b.top < obstacle.top) obstacle = { top: b.top, sel }
      }
    }
    boxes.push({ cls: 'bar', r: rr2 })
    railGeom = ` · rail ${Math.round(rr2.width)}×${Math.round(rr2.height)}`
    // The ✕ is 26px and the grip needs room to read as a track. Below this the
    // island is a stub the thumb can't drag, which no overlap check catches --
    // it's correctly placed and still useless.
    if (rr2.height < 96 && rr2.width < rr2.height) {
      railFaults.push(`rail only ${Math.round(rr2.height)}px tall -- too short to drag`)
    }
    if (obstacle) {
      const gap = Math.round(obstacle.top - rr2.bottom)
      railGeom += ` · gap ${gap}px over ${obstacle.sel}${gap < 0 ? ' ✗ OVERLAPS' : ' ✓'}`
      if (gap < 0) railFaults.push(`rail overlaps ${obstacle.sel} by ${-gap}px`)
    }
  }

  const geom =
    `pad ${Math.round(padRect.width)}×${Math.round(padRect.height)}` +
    ` · minStepX ${minStepX.toFixed(1)}` +
    ringGeom +
    railGeom +
    // An open sheet covers the deck, so an overlap verdict is about a surface
    // nobody can currently touch. Say that rather than let a stale-looking
    // "clear" read as proof the notch is fine.
    (state.overlay === 'none' ? '' : ` · ${state.overlay} open (notch verdict n/a)`)

  // A control covered by another layer is as dead as one under the pad, so it
  // fails the cell too -- reporting it as a footnote under an "ok" verdict is
  // how a shipped overlap goes unread.
  const faults = [
    ...hits.map((h) => `${h.label} ${(h.frac * 100).toFixed(0)}% under pad (inset ${h.inset})`),
    ...blocked.map((b) => `${b.label} blocked by ${b.by} at +${b.at}`),
    ...railFaults
  ]

  return {
    state: faults.length ? 'bad' : 'ok',
    note: faults.length
      ? faults.join('\n') + `\n${geom}` +
        (collisions.length ? `\nfixed overlaps: ${collisions.join(', ')}` : '')
      : `${buttons.length} buttons clear, none blocked · ${geom}` +
        // Split mode carves TWO bites, so "a path exists" is not the same as
        // "the notch is complete" -- name the count, or a half-built clip reads
        // as a pass.
        (pathDs.length ? ` · ${pathDs.length} notch path(s)` : ' · NO notch path') +
        // Surfaced on a passing cell as information, not a fault: an open sheet
        // covering the deck is a legitimate overlap.
        (collisions.length ? `\nfixed overlaps: ${collisions.join(', ')}` : ''),
    boxes,
    ringTrace
  }
}

function drawOverlay(cell, frame, res) {
  const ovl = cell.querySelector('.ovl')
  ovl.innerHTML = ''
  if (!state.boxes || !res.boxes) return
  for (const b of res.boxes) {
    const i = document.createElement('i')
    i.className = b.cls
    i.style.left = b.r.left + 'px'
    i.style.top = b.r.top + 'px'
    i.style.width = b.r.width + 'px'
    i.style.height = b.r.height + 'px'
    ovl.appendChild(i)
  }
  // The ring's centerline, redrawn on top in magenta. Two strokes: a fat
  // translucent one showing the band's real hit width, and a hairline on the
  // centerline itself -- so "the arc passes here" and "a touch this far out
  // still counts" are separately readable.
  if (res.ringTrace) {
    const t = res.ringTrace
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'ringovl')
    Object.assign(svg.style, {
      position: 'absolute', left: t.left + 'px', top: t.top + 'px',
      width: t.width + 'px', height: t.height + 'px', overflow: 'visible',
      pointerEvents: 'none'
    })
    const mk = (w, color, opacity) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      p.setAttribute('d', t.d)
      p.setAttribute('fill', 'none')
      p.setAttribute('stroke', color)
      p.setAttribute('stroke-width', String(w))
      p.setAttribute('opacity', String(opacity))
      return p
    }
    svg.appendChild(mk(t.strokeWidth, '#ff00d4', 0.35))
    svg.appendChild(mk(2, '#ff00d4', 1))
    ovl.appendChild(svg)
  }
}

/** Paint the insets the deck is supposed to keep clear.
 *
 *  These bands and safeAreaCss() must read the SAME numbers, or the harness
 *  draws one geometry and simulates another -- which is the state this file
 *  shipped in: a landscape band hardcoded to 21px next to an iframe whose
 *  insets were all 0. Both now come off the device row.
 *
 *  Landscape keeps the home indicator on the bottom edge and moves the notch
 *  carve to BOTH sides; the top edge has no inset once rotated. */
function drawSafe(cell, dev, landscape) {
  cell.querySelectorAll('.safe').forEach((e) => e.remove())
  if (!state.safe) return
  const phone = cell.querySelector('.phone')
  const band = (css) => {
    const s = document.createElement('div')
    s.className = 'safe'
    Object.assign(s.style, css)
    phone.appendChild(s)
  }
  const side = landscape ? dev.safeSide : 0
  const top = landscape ? 0 : dev.safeTop
  const bottom = landscape ? dev.safeBottomLandscape : dev.safeBottom
  if (bottom > 0) band({ bottom: '0', left: '0', right: '0', height: bottom + 'px' })
  if (top > 0) band({ top: '0', left: '0', right: '0', height: top + 'px' })
  if (side > 0) {
    band({ top: '0', bottom: '0', left: '0', width: side + 'px' })
    band({ top: '0', bottom: '0', right: '0', width: side + 'px' })
  }
}

async function render() {
  writeUrlState(STATE_DEFAULTS)
  toggleRow($('skins'), SKINS, 'skin', { proII: 'Pro II', default: 'Plain' })
  toggleRow($('orients'), ['both', 'portrait', 'landscape'], 'orient')
  toggleRow($('mode'), ['one', 'corners', 'decks', 'concepts'], 'mode', {
    one: 'single',
    corners: 'all 4',
    decks: 'stacked vs split',
    concepts: 'all 4 splits'
  })
  toggleRow($('vpos'), ['bottom', 'top'], 'keysPosition')
  toggleRow($('hand'), ['right', 'left'], 'handedness')
  toggleRow($('deck'), DECK_MODES, 'deckMode', { stacked: 'one side', split: 'both thumbs' })
  toggleRow($('concept'), SPLIT_CONCEPTS, 'splitConcept')
  toggleRow($('mirror'), [false, true], 'mirror', { false: 'off', true: 'on' })
  toggleRow($('ring'), [false, true], 'appRing', { false: 'off', true: 'on' })
  toggleRow(
    $('overlay'),
    [...Object.keys(OVERLAYS), ...Object.keys(NESTED_OVERLAYS)],
    'overlay',
    { none: 'none', profiles: 'profiles ▸', tabs: 'tabs ▸' }
  )

  // A sweep mode already varies the axis it sweeps, so that axis's global row
  // has nothing left to select -- dim it rather than leave live-looking buttons
  // that change nothing. Each mode dims only what it actually owns: the deck
  // sweep still takes its keys/hand from the globals, which is the point.
  const corners = state.mode === 'corners'
  const decks = state.mode === 'decks'
  const concepts = state.mode === 'concepts'
  // The concept row is also dead whenever no split deck is on screen at all --
  // a live-looking toggle that changes nothing reads as a broken control.
  const dimmed = {
    vpos: corners,
    hand: corners,
    deck: decks || concepts,
    concept: concepts || (state.deckMode !== 'split' && !decks)
  }
  for (const [id, off] of Object.entries(dimmed)) {
    $(id).style.opacity = off ? '.35' : '1'
    $(id).style.pointerEvents = off ? 'none' : 'auto'
  }

  const grid = $('grid')
  grid.innerHTML = ''

  let baseHtml
  try {
    baseHtml = await loadBundleHtml()
    // Resolve the pad floor from the bundle before any cell boots, so
    // applyMirror can stay synchronous and never reads a stale default.
    await padMinWidth()
  } catch (e) {
    grid.innerHTML = `<p style="color:#ff9aa8">${e.message}</p>`
    return
  }

  const orients = state.orient === 'both' ? ['portrait', 'landscape'] : [state.orient]

  for (const dev of DEVICES) {
    for (const o of orients) {
      const base = {
        keysPosition: state.keysPosition,
        handedness: state.handedness,
        deckMode: state.deckMode,
        splitConcept: state.splitConcept
      }
      const configs = corners
        ? CORNERS.map((c) => ({ ...c, deckMode: state.deckMode, splitConcept: state.splitConcept }))
        : decks
          ? decksFor(base)
          : concepts
            ? conceptsFor(base)
            : [base]
      // Corners mode groups a device's 4 combos in one bordered block so they
      // read as one comparison, instead of wrapping into the neighbours.
      let host = grid
      if (corners || decks || concepts) {
        const g = document.createElement('section')
        g.className = 'group'
        g.innerHTML = `<h2>${dev.name} · ${o} · ${state.skin}</h2><div class="groupGrid"></div>`
        grid.appendChild(g)
        host = g.querySelector('.groupGrid')
      }
      for (const cfg of configs) {
        buildCell(host, baseHtml, dev, o, { ...cfg })
      }
    }
  }
}

/** One device at one orientation and one keys/hand config.
 *
 *  `cfg` is per-cell state, deliberately not read back from the globals: the
 *  cell's own top/bottom + left/right buttons mutate it and re-boot only this
 *  iframe, so a cell keeps its config while its neighbours keep theirs. */
function buildCell(grid, baseHtml, dev, orient, cfg) {
  const landscape = orient === 'landscape'
  const w = landscape ? dev.h : dev.w
  const h = landscape ? dev.w : dev.h

  // In corners mode the group heading already names the device and orientation,
  // so the cell leads with the thing that differs between siblings: the combo.
  const grouped = state.mode !== 'one'
  // Each sweep names its cells by the axis it varies -- labelling a deck sweep
  // "bottom-right / bottom-right" would make the two cells look identical.
  const label =
    state.mode === 'decks' ? deckLabel : state.mode === 'concepts' ? conceptLabel : cornerLabel
  const cell = document.createElement('div')
  cell.className = 'cell'
  cell.innerHTML = `
    <div class="head">
      <span class="name">${grouped ? label(cfg) : dev.name}</span>
      <span class="dims">${grouped ? `${w}×${h}` : `${w}×${h} ${orient}`}</span>
      <span class="verdict v-wait">measuring…</span>
    </div>
    <div class="cellBar">
      <span class="seg" data-key="keysPosition"></span>
      <span class="seg" data-key="handedness"></span>
      <span class="seg" data-key="deckMode"></span>
      <span class="seg" data-key="splitConcept"></span>
    </div>
    <div class="phone" style="width:${w}px;height:${h}px">
      <iframe width="${w}" height="${h}"></iframe>
      <div class="ovl"></div>
    </div>
    <div class="rep"></div>`
  grid.appendChild(cell)

  // Re-read from the DOM each run: boot() swaps the iframe for a fresh element,
  // so a captured reference goes stale the moment a cell button is clicked.
  const frameOf = () => cell.querySelector('iframe')

  const paintBar = () => {
    // The heading names the combo in grouped mode, and the cell's own buttons
    // can change that combo -- repaint it or it goes stale on the first click.
    if (grouped) cell.querySelector('.name').textContent = label(cfg)
    for (const seg of cell.querySelectorAll('.seg')) {
      const key = seg.dataset.key
      const opts =
        key === 'keysPosition'
          ? ['top', 'bottom']
          : key === 'handedness'
            ? ['left', 'right']
            : key === 'deckMode'
              ? DECK_MODES
              : SPLIT_CONCEPTS
      seg.innerHTML = ''
      for (const v of opts) {
        const b = document.createElement('button')
        b.className = 't sm'
        b.textContent = v
        b.setAttribute('aria-pressed', String(cfg[key] === v))
        b.onclick = () => {
          cfg[key] = v
          paintBar()
          run()
        }
        seg.appendChild(b)
      }
    }
  }

  const run = async () => {
    const v = cell.querySelector('.verdict')
    v.className = 'verdict v-wait'
    v.textContent = 'measuring…'
    cell.querySelector('.ovl').innerHTML = ''
    const frame = await boot(frameOf(), inject(baseHtml, prefsFor(cfg), dev, landscape))
    drawSafe(cell, dev, landscape)
    // After the deck mounts, not before -- applyMirror needs .proRoot to exist.
    // Resizing the pad via --pro-mirror-w is what makes useNotchPath's
    // ResizeObserver recompute, so the measured path below is the mirror-on one.
    applyMirrorWhenReady(frame, landscape)
    // Awaited: a two-step chain can still be clicking its second trigger when a
    // fire-and-forget measure runs, which reports the deck WITHOUT the sheet and
    // looks identical to a sheet that failed to open.
    await openOverlayChain(frame)
    // The notch animates in (ENTRANCE_DELAY_MS 120 + ENTRANCE_MS 620), and
    // measuring mid-tween reports a shape on its way somewhere else. Wait past
    // the entrance, then measure the settled path.
    setTimeout(() => {
      let res
      try {
        res = measure(frame)
      } catch (e) {
        res = { state: 'bad', note: 'measure failed: ' + e.message }
      }
      v.className =
        'verdict ' + (res.state === 'ok' ? 'v-ok' : res.state === 'bad' ? 'v-bad' : 'v-wait')
      v.textContent =
        res.state === 'ok' ? 'clear' : res.state === 'bad' ? 'PAD OVER BUTTONS' : 'no deck'
      cell.querySelector('.rep').textContent = res.note
      drawOverlay(cell, frame, res)
    }, 1100)
  }

  paintBar()
  run()
}

// Snapshot the declared defaults BEFORE the URL is applied -- writeUrlState
// diffs against these to keep a shared link minimal, so it must be the code's
// defaults, not whatever the current URL happened to set.
const STATE_DEFAULTS = { ...state }
readUrlState()

$('showBoxes').onchange = (e) => { state.boxes = e.target.checked; render() }
$('showSafe').onchange = (e) => { state.safe = e.target.checked; render() }
$('remeasure').onclick = () => render()

// The checkboxes are plain DOM, not driven by render() -- a URL that sets them
// must move the box too, or the control contradicts what is on screen.
$('showBoxes').checked = state.boxes
$('showSafe').checked = state.safe

render()
