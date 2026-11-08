// Landscape tuner -- ONE device, live values, measured gaps.
//
// WHY THIS EXISTS, separately from viewer.js: the viewer answers "is any device
// broken?" across a grid of ten decks. That is the wrong tool for "which value
// moves this edge?", because every experiment costs an edit + a rebuild + a
// full-grid remeasure, and the answer arrives as a pass/fail verdict rather
// than a number. The user spent a session on the landscape safe zone that way and
// the answer was still a guess (a flat 10px swapped for a flat 14px -- same
// class of bug, a constant where a relationship belongs).
//
// So this page inverts all three: one device (fast), sliders that rewrite CSS
// custom properties INSIDE the running bundle (no rebuild -- a var write
// restyles in the same frame), and a table of gaps MEASURED off live rects.
//
// The measured/typed distinction is the whole point. A row shows what you asked
// for AND what the DOM actually did. When those disagree, the disagreement is
// the finding: it means some other rule owns that edge, and the variable you
// are dragging is not the one in play. Restating the inputs as if they were
// results is how a harness manufactures a fake failure mode (memory
// `harness-must-measure-not-assume`).
//
// Landscape-first by default, since that is the orientation with the open bug,
// but portrait works and is worth flipping to -- a landscape fix that breaks
// portrait is the recurring shape here.

const BUNDLE = '../dist/index.html'

// Same table as viewer.js. Duplicated deliberately rather than imported: these
// two pages are separate entry points with no build step, and a shared module
// would need one. If a device's insets change, change both -- the numbers are
// documented at their source in viewer.js.
//
// safeSide is the LANDSCAPE left/right inset. iOS reports the notch inset on
// BOTH sides once rotated, so one number covers the pair. It equals the
// device's portrait safeTop on notched phones, and is 0 on the SE.
const DEVICES = [
  { name: 'iPhone SE',         w: 375, h: 667, safeTop: 20, safeBottom: 0,  safeSide: 0,  safeBottomLandscape: 0 },
  { name: 'iPhone 13 mini',    w: 375, h: 812, safeTop: 50, safeBottom: 34, safeSide: 50, safeBottomLandscape: 21 },
  { name: 'iPhone 14',         w: 390, h: 844, safeTop: 47, safeBottom: 34, safeSide: 47, safeBottomLandscape: 21 },
  { name: 'iPhone 15 Pro',     w: 393, h: 852, safeTop: 59, safeBottom: 34, safeSide: 59, safeBottomLandscape: 21 },
  { name: 'iPhone 15 Pro Max', w: 430, h: 932, safeTop: 59, safeBottom: 34, safeSide: 59, safeBottomLandscape: 21 }
]

/* ---- The tunables ----------------------------------------------------------

   `theme` is the value theme.css ships TODAY, read from the file and restated
   here. It is the baseline a row lights up against and what "Reset" returns to,
   so a stale entry would quietly redefine "unchanged" -- the `src` field names
   the line to check when one looks wrong.

   Every var here is a real custom property the deck already reads. Nothing in
   this list is invented for the harness: a slider that moved a variable no rule
   consumes would swing freely and prove nothing, which is the trap that makes a
   tuner worse than useless. `--pro-cell-pad-*` are the exception and are
   handled below -- see CELL_PAD_VARS. */
const VARS = [
  { key: 'inset', css: '--pro-inset', label: 'Screen-edge inset',
    hint: 'pad + cluster margin off the bezel', theme: 14, min: 0, max: 48,
    src: 'theme.css:4721' },
  { key: 'gutter', css: '--pro-gutter', label: 'Mirror↔pad gutter',
    hint: 'gap between the two columns', theme: 18, min: 0, max: 60,
    src: 'theme.css:5880' },
  { key: 'band', css: '--pro-header-band-land', label: 'Header band (landscape)',
    hint: 'height reserved for the top bar', theme: 34, min: 0, max: 80,
    src: 'theme.css:5870' },
  { key: 'gap', css: '--pro-header-gap', label: 'Header gap',
    hint: 'breathing room under the band', theme: 12, min: 0, max: 48,
    src: 'theme.css:5871' },
  { key: 'cellPad', css: null, label: 'Cluster side padding',
    hint: 'edge of the cell → the buttons; the contested one', theme: 14, min: 0, max: 48,
    src: 'theme.css:5965' }
]

/* The insets. Separate from VARS because they are not custom properties at all
   -- they are a SIMULATION of env(safe-area-inset-*), which has no JS setter
   and resolves to 0 in an iframe on a Mac no matter what the parent does. Each
   one seeds from the device row and can then be dragged, which is what makes
   "does this hold at a bigger inset?" a two-second question instead of a new
   device row. */
const INSETS = [
  { key: 'safeSide', label: 'Side inset (landscape)',
    hint: 'the notch, once rotated — both sides', min: 0, max: 90 },
  { key: 'safeBottomLandscape', label: 'Bottom inset (landscape)',
    hint: 'home indicator on its side', min: 0, max: 60 },
  { key: 'safeTop', label: 'Top inset (portrait)', hint: 'portrait only', min: 0, max: 90 },
  { key: 'safeBottom', label: 'Bottom inset (portrait)', hint: 'portrait only', min: 0, max: 60 }
]

const state = {
  device: 'iPhone 15 Pro',
  orient: 'landscape',
  keysPosition: 'bottom',
  handedness: 'right',
  deckMode: 'stacked',
  mirror: false,
  skin: 'proII',
  boxes: true,
  safe: true,
  gaps: true,
  // Overrides only. A key absent here means "whatever theme.css says", which is
  // what lets Reset be a delete rather than a write-back-the-default -- the
  // latter would pin the value and mask a later theme.css change.
  vars: {},
  insets: {}
}

/* ---- URL state -------------------------------------------------------------
   A tuned state is a link. That matters more here than in the viewer: the
   output of this page is a set of NUMBERS, and a number you cannot send to
   someone (or reopen tomorrow) has to be re-derived by dragging. Vars and
   insets serialise as one compact `v=`/`s=` pair each rather than a param per
   slider, which would make the address bar unreadable at nine of them. */
const SIMPLE_PARAMS = {
  device: 'dev', orient: 'orient', keysPosition: 'keys', handedness: 'hand',
  deckMode: 'deck', skin: 'skin'
}
const BOOL_PARAMS = { mirror: 'mirror', boxes: 'boxes', safe: 'safe', gaps: 'gaps' }

function readUrlState() {
  const q = new URLSearchParams(location.search)
  for (const [key, param] of Object.entries(SIMPLE_PARAMS)) {
    const raw = q.get(param)
    if (raw !== null) state[key] = raw
  }
  for (const [key, param] of Object.entries(BOOL_PARAMS)) {
    const raw = q.get(param)
    if (raw !== null) state[key] = raw !== '0' && raw !== 'false'
  }
  // `v=inset:20,gutter:24`. Unknown keys and non-numbers are dropped rather
  // than stored: a typo must not create an override no slider can reach or
  // reset, or the page and the URL describe different layouts.
  const parsePairs = (raw, valid) => {
    const out = {}
    for (const part of (raw || '').split(',')) {
      const [k, v] = part.split(':')
      const n = Number(v)
      if (valid.includes(k) && Number.isFinite(n)) out[k] = n
    }
    return out
  }
  state.vars = parsePairs(q.get('v'), VARS.map((v) => v.key))
  state.insets = parsePairs(q.get('s'), INSETS.map((i) => i.key))
}

function writeUrlState() {
  const q = new URLSearchParams()
  const defaults = { device: 'iPhone 15 Pro', orient: 'landscape', keysPosition: 'bottom',
    handedness: 'right', deckMode: 'stacked', skin: 'proII',
    mirror: false, boxes: true, safe: true, gaps: true }
  for (const [key, param] of Object.entries(SIMPLE_PARAMS))
    if (state[key] !== defaults[key]) q.set(param, state[key])
  for (const [key, param] of Object.entries(BOOL_PARAMS))
    if (state[key] !== defaults[key]) q.set(param, state[key] ? '1' : '0')
  const ser = (obj) => Object.entries(obj).map(([k, v]) => `${k}:${v}`).join(',')
  if (Object.keys(state.vars).length) q.set('v', ser(state.vars))
  if (Object.keys(state.insets).length) q.set('s', ser(state.insets))
  const qs = q.toString()
  // replaceState: dragging a slider is not a navigation, and 200 near-identical
  // entries make Back unusable.
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
}

const dev = () => DEVICES.find((d) => d.name === state.device) || DEVICES[3]
const isLandscape = () => state.orient === 'landscape'
/** The effective value of a tunable: the override if one is set, else the
 *  value theme.css ships. Reading through one accessor is what keeps the
 *  overlay, the injected CSS, and the "dirty" highlight from ever disagreeing. */
const varVal = (key) => {
  const d = VARS.find((v) => v.key === key)
  return state.vars[key] ?? d.theme
}
const insetVal = (key) => state.insets[key] ?? dev()[key]

/* ---- Booting the real bundle ---------------------------------------------- */

let bundleHtml = null
async function loadBundleHtml() {
  if (bundleHtml) return bundleHtml
  const res = await fetch(BUNDLE)
  if (!res.ok) throw new Error(`no built bundle at ${BUNDLE} — run: npm run build:phone-remote`)
  let html = await res.text()
  // Every relative URL in the bundle (./assets/*, ./cork.webp) must still
  // resolve once the document is written into an iframe whose own URL is this
  // folder. A <base> is the one-line fix and leaves the bundle untouched.
  html = html.replace('<head>', '<head><base href="../dist/">')
  bundleHtml = html
  return html
}

const FAKE_CONTEXT = {
  adapterId: 'chrome', appName: 'Google Chrome', bundleId: 'com.google.Chrome',
  appIconPngBase64: '', activeGroupId: 'Default',
  groups: [{ id: 'Default', name: 'Person 1', iconPngBase64: '',
    subtitle: 'dev@example.com', itemCount: 10, active: true }],
  items: [{ id: '1', title: 'MightyMouse', subtitle: 'https://getmightymouse.com',
    active: true, iconPngBase64: '' }]
}

/** The style block injected into the deck.
 *
 *  Two jobs, and they are different in kind. The VAR half is honest: those are
 *  real custom properties, so writing them is exactly what editing theme.css
 *  would do. The INSET half is a simulation -- env(safe-area-inset-*) has no JS
 *  setter, and the deck reads it at ~28 call sites as
 *  `calc(env(safe-area-inset-X, 0px) + …)`. Restating 28 rules here would drift
 *  the moment one moved, so this overrides the four surfaces that actually have
 *  to clear the notch, mirroring the shape theme.css gives each one.
 *
 *  .proRoot stays FULL-BLEED. Insetting it looked wrong and was: the wood grain
 *  started 50px in and left bare gutters down both edges while the pad, which
 *  insets itself, moved twice. The deck IS the screen; each child clears its
 *  own edge. The SE (side 0) is the control -- it must render identically with
 *  the shim on and off. */
function overrideCss() {
  const land = isLandscape()
  const side = land ? insetVal('safeSide') : 0
  const top = land ? 0 : insetVal('safeTop')
  const bottom = land ? insetVal('safeBottomLandscape') : insetVal('safeBottom')
  const cellPad = varVal('cellPad')

  // Custom properties go on :root so they cascade to every consumer, exactly as
  // the theme.css declarations they shadow.
  const vars = VARS.filter((v) => v.css)
    .map((v) => `${v.css}:${varVal(v.key)}px;`).join('')

  const pad = `calc(${side}px + ${varVal('inset')}px)`
  const mirrorCol = `calc(${side}px + ${varVal('inset')}px + var(--pro-mirror-w,55%) + ${varVal('gutter')}px)`

  return (
    '<style id="mm-tuner">' +
    `:root{${vars}}` +
    // The landscape header tokens are declared ON .proRoot[data-orient] in
    // theme.css, which is more specific than :root -- so the :root copy above
    // would lose. Restate them at the same specificity or the two header
    // sliders move nothing, which reads as "that value does not matter".
    `.proRoot[data-orient='landscape']{--pro-header-band-land:${varVal('band')}px;` +
    `--pro-header-gap:${varVal('gap')}px;}` +
    '.proRoot{background-color:#000;}' +

    // --- portrait insets ---
    // Top only. The bottom is deliberately NOT inset (theme.css:4908 -- the pad
    // runs to the very bottom on purpose, and --pro-safe-bottom already owns
    // that edge with a value that differs per display mode).
    (!land && top > 0
      ? `.proRoot[data-orient='portrait'] .proTouchpad{top:calc(${top}px + var(--pro-header-band) + var(--pro-header-gap))!important;}`
      : '') +

    // --- landscape insets ---
    (land
      ? `.proRoot[data-orient='landscape'] .proTouchpad{` +
        `left:${pad}!important;right:${pad}!important;bottom:${bottom}px!important;}` +
        // The status line centres across the full width and would otherwise sit
        // under the notch on whichever side the phone was rotated toward.
        `.proRoot[data-orient='landscape'] .proStatus{` +
        `padding-left:${side + 16}px!important;padding-right:${side + 16}px!important;}` +
        // The cluster is pinned by BOTH edges, and which edge carries the mirror
        // column flips with handedness -- restating one edge would shove it out
        // from under the pad it shares a corner with. Each handedness gets the
        // same pair theme.css gives it, with env() substituted.
        `.proRoot[data-orient='landscape'] .proControlsCell{bottom:${bottom}px!important;` +
        `padding-left:${cellPad}px!important;padding-right:${cellPad}px!important;}` +
        `.proRoot[data-orient='landscape'][data-hand='right'] .proControlsCell{` +
        `left:${mirrorCol}!important;right:${pad}!important;}` +
        `.proRoot[data-orient='landscape'][data-hand='left'] .proControlsCell{` +
        `left:${pad}!important;right:${mirrorCol}!important;}` +
        // Mirror off is last so it wins over handedness, exactly as in theme.css.
        `.proRoot[data-orient='landscape'][data-mirror='off'] .proTouchpad,` +
        `.proRoot[data-orient='landscape'][data-mirror='off'] .proControlsCell{` +
        `left:${pad}!important;right:${pad}!important;}` +
        // Split mode pins each cell to its OWN outer edge; the inner edges are
        // percentage-capped and carry no inset, so only the outer pair moves.
        `.proRoot[data-orient='landscape'][data-deck='split'][data-hand='right'] .proControlsCellPrimary,` +
        `.proRoot[data-orient='landscape'][data-deck='split'][data-hand='left'] .proControlsCellSecondary{` +
        `left:auto!important;right:${pad}!important;}` +
        `.proRoot[data-orient='landscape'][data-deck='split'][data-hand='right'] .proControlsCellSecondary,` +
        `.proRoot[data-orient='landscape'][data-deck='split'][data-hand='left'] .proControlsCellPrimary{` +
        `right:auto!important;left:${pad}!important;}`
      : '') +
    '</style>'
  )
}

function inject(html) {
  html = html.replace('</head>', overrideCss() + '</head>')
  const prefs = {
    layout: 'touchpad', skin: state.skin, keysPosition: state.keysPosition,
    handedness: state.handedness, deckMode: state.deckMode,
    mirror: state.mirror, showCursor: true
  }
  const script =
    `<script>window.__MM_LAYOUT_PREFS__=${JSON.stringify(prefs)};` +
    'window.__MM_PREVIEW__=true;' +
    `window.__MM_APP_CONTEXT__=${JSON.stringify(FAKE_CONTEXT)};` +
    // The Keyboard pill's default is OFF, which focuses a hidden <input> to
    // summon the OS keyboard. On a Mac that draws nothing and just yanks focus.
    "try{localStorage.setItem('mm-remote-virtual-keyboard','on')}catch(e){}<\/script>"
  return html.replace('</head>', script + '</head>')
}

/** Rewrite the override block in the LIVE document.
 *
 *  This is what makes a slider feel like a slider: replacing the <style> text
 *  restyles in the same frame, where a re-boot would remount React, replay the
 *  notch measurement, and cost ~400ms per drag step. Only changes that alter
 *  the app's own PREFS (skin, hand, deck…) need the full re-boot below. */
function applyLive(frame) {
  const doc = frame?.contentDocument
  const old = doc?.getElementById('mm-tuner')
  if (!old) return false
  const tmp = doc.createElement('div')
  tmp.innerHTML = overrideCss()
  old.replaceWith(tmp.firstElementChild)
  return true
}

let frameEl = null
async function boot() {
  const html = inject(await loadBundleHtml())
  const host = document.getElementById('phone')
  const d = dev()
  const w = isLandscape() ? d.h : d.w
  const h = isLandscape() ? d.w : d.h
  host.style.width = w + 'px'
  host.style.height = h + 'px'

  // A SECOND doc.write into an already-loaded iframe does not reliably re-mount
  // the app -- the deck comes back empty on every re-boot after the first.
  // Replacing the element gives each boot a genuinely fresh document.
  const fresh = document.createElement('iframe')
  fresh.width = w
  fresh.height = h
  const prev = host.querySelector('iframe')
  if (prev) prev.replaceWith(fresh)
  else host.insertBefore(fresh, host.firstChild)
  await new Promise((r) => requestAnimationFrame(r))
  const doc = fresh.contentDocument
  doc.open()
  doc.write(html)
  doc.close()
  frameEl = fresh
  // The deck mounts, then useNotchPath measures and re-clips on the next frame.
  // Measuring before that reports "NO notch path" on a perfectly good deck.
  await new Promise((r) => setTimeout(r, 420))
  refresh()
}

/* ---- Measurement -----------------------------------------------------------

   Everything below reads the DOM. Nothing here recomputes a value from the
   sliders -- if a number in the table matches what you typed, that is a fact
   about the layout, not an echo of the input. */

/** Rect intersection area. Zero when they merely touch. */
function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

/** Fraction of a control's box that the CLIPPED pad actually covers.
 *
 *  The pad's bounding box always overlaps the buttons -- the notch is a
 *  clip-path, so the element's rect stays rectangular while the painted shape
 *  has a bite taken out of it. Comparing boxes would report a collision on a
 *  correct deck. The honest test is whether a point is inside the clip PATH.
 *  `pathDs` is every path in the chain: split mode nests two, and nesting
 *  INTERSECTS, so the pad paints only where a point is inside ALL of them. */
function padCoversButton(win, padEl, pathDs, r) {
  const ds = (Array.isArray(pathDs) ? pathDs : [pathDs]).filter(Boolean)
  if (!ds.length) return 0
  const svg = padEl.querySelector('svg') || win.document.querySelector('svg')
  if (!svg) return 0
  const padRect = padEl.getBoundingClientRect()
  // The clip is authored in the pad's own unscaled coordinate space.
  const sx = padRect.width / (padEl.offsetWidth || padRect.width)
  const sy = padRect.height / (padEl.offsetHeight || padRect.height)
  const paths = ds.map((d) => {
    const p = win.document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
    return p
  })
  const STEP = 4
  let inside = 0
  let total = 0
  try {
    for (let y = r.top; y <= r.bottom; y += STEP) {
      for (let x = r.left; x <= r.right; x += STEP) {
        total++
        const pt = svg.createSVGPoint()
        pt.x = (x - padRect.left) / sx
        pt.y = (y - padRect.top) / sy
        if (paths.every((p) => p.isPointInFill(pt))) inside++
      }
    }
  } catch {
    // isPointInFill throws on a detached/zero-size SVG. A silent 0 would read
    // as "nothing covered" -- a clean pass built on a dead probe. Report the
    // failure by returning NaN, which the caller renders as a warning row.
    return NaN
  } finally {
    paths.forEach((p) => p.remove())
  }
  return total ? inside / total : 0
}

/** The gaps that are actually being tuned, measured between real rects.
 *
 *  Each entry names WHAT it measures and WHICH slider is supposed to own it, so
 *  a row that does not move when you drag its owner is a self-reporting bug:
 *  it means another rule wins that edge. That is the question this whole page
 *  exists to answer, and it cannot be answered by reading CSS. */
function measureGaps(doc, land) {
  const root = doc.querySelector('.proRoot')
  const pad = doc.querySelector('.proTouchpad')
  const cell = doc.querySelector('.proControlsCell')
  if (!root || !pad) return []
  const R = root.getBoundingClientRect()
  const P = pad.getBoundingClientRect()
  const side = land ? insetVal('safeSide') : 0
  const bottom = land ? insetVal('safeBottomLandscape') : insetVal('safeBottom')

  // The safe edges, in the same coordinate space as the rects. This is the line
  // content must clear -- not the screen edge.
  const safeL = R.left + side
  const safeR = R.right - side
  const safeB = R.bottom - bottom

  const rows = []
  const push = (what, owner, got, want) =>
    rows.push({ what, owner, got: Math.round(got * 10) / 10, want })

  push('pad left → safe edge', 'inset', P.left - safeL, varVal('inset'))
  push('pad right → safe edge', 'inset', safeR - P.right, varVal('inset'))
  push('pad bottom → safe edge', land ? 'bottom inset' : '—', safeB - P.bottom, 0)

  // The buttons are the thing a thumb actually hits, so their distance to the
  // safe edge is the number that matters -- the cell's own edge is an
  // intermediate the user never sees. Taking the extreme button on each side
  // because the cluster's rows have different widths (that staircase is what
  // the notch carves around).
  const btns = [...doc.querySelectorAll('.proKeyPill, .proIconBtn, .proMicBtn')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((b) => b.r.width > 0 && b.r.height > 0)
  if (btns.length) {
    const leftMost = btns.reduce((a, b) => (b.r.left < a.r.left ? b : a))
    const rightMost = btns.reduce((a, b) => (b.r.right > a.r.right ? b : a))
    const lowest = btns.reduce((a, b) => (b.r.bottom > a.r.bottom ? b : a))
    const nm = (b) => b.el.getAttribute('aria-label') || b.el.textContent.trim().slice(0, 10) || 'btn'
    // On the mirror side the nearest thing is the mirror column, not the bezel,
    // so only the OUTER side is a safe-edge question. Both are shown anyway --
    // the inner one moving when it should not is itself worth seeing.
    push(`btn "${nm(leftMost)}" left → safe edge`, 'inset + cluster pad',
      leftMost.r.left - safeL, null)
    push(`btn "${nm(rightMost)}" right → safe edge`, 'inset + cluster pad',
      safeR - rightMost.r.right, null)
    push(`btn "${nm(lowest)}" bottom → safe edge`, 'bottom inset', safeB - lowest.r.bottom, null)
  }

  if (cell) {
    const C = cell.getBoundingClientRect()
    push('cell left → safe edge', 'inset', C.left - safeL, null)
    push('cell right → safe edge', 'inset', safeR - C.right, null)
    // The cell's own padding, measured rather than read back off the slider:
    // if these disagree with "Cluster side padding" then something else is
    // constraining the buttons (a max-width, a flex rule) and the slider is a
    // red herring.
    if (btns.length) {
      const inCell = btns.filter((b) => cell.contains(b.el))
      if (inCell.length) {
        const l = inCell.reduce((a, b) => (b.r.left < a.r.left ? b : a)).r.left
        const r = inCell.reduce((a, b) => (b.r.right > a.r.right ? b : a)).r.right
        push('cell pad left (measured)', 'cellPad', l - C.left, varVal('cellPad'))
        push('cell pad right (measured)', 'cellPad', C.right - r, varVal('cellPad'))
      }
    }
  }
  return rows
}

function measure() {
  const frame = frameEl
  const win = frame?.contentWindow
  const doc = frame?.contentDocument
  const padEl = doc?.querySelector('.proTouchpad')
  if (!padEl) return { state: 'wait', note: 'deck not mounted yet', boxes: [], gaps: [], strips: [] }
  const land = isLandscape()

  const pathDs = ['proNotchDynamicPath', 'proNotchDynamicPathB']
    .map((id) => doc.getElementById(id)?.getAttribute('d') ?? null)
    .filter(Boolean)

  // The key rows are DIV.proKeyPill, not <button> -- a `button` selector finds
  // only the icon row and reports "clear" while never testing the rows the
  // notch exists to clear.
  const buttons = [...doc.querySelectorAll('.proKeyPill, .proIconBtn, .proMicBtn')]
    .filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })

  const padRect = padEl.getBoundingClientRect()
  const boxes = [{ cls: 'pad', r: padRect }]
  const faults = []
  const probeFailed = []
  for (const el of buttons) {
    const r = el.getBoundingClientRect()
    const frac = padCoversButton(win, padEl, pathDs, r)
    const label = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 12) || 'btn'
    if (Number.isNaN(frac)) probeFailed.push(label)
    else if (frac > 0) faults.push(`${label} ${(frac * 100).toFixed(0)}% under pad`)
    boxes.push({ cls: frac > 0 ? 'hit' : 'btn', r })
  }

  const gaps = measureGaps(doc, land)
  // A control off the safe edge is as dead as one under the pad -- so a
  // negative gap fails the cell rather than sitting as a footnote under "ok".
  for (const g of gaps) if (g.got < -0.5) faults.push(`${g.what} is ${g.got}px (past the safe edge)`)

  // padW: offsetWidth IS the unscaled local width, the same quantity
  // useNotchPath calls `w`.
  const padW = padEl.offsetWidth || padRect.width
  const minStepX = Math.max(padW * 0.045, 8)
  const dims = `pad ${Math.round(padRect.width)}×${Math.round(padRect.height)}` +
    ` · minStepX ${minStepX.toFixed(1)} · ${pathDs.length} notch path(s)`

  return {
    state: probeFailed.length ? 'bad' : faults.length ? 'bad' : 'ok',
    note: probeFailed.length
      ? `clip probe FAILED on ${probeFailed.join(', ')} — verdict unreliable`
      : faults.join('\n'),
    dims, boxes, gaps,
    strips: gapStrips(doc, land)
  }
}

/** The green strips drawn over the phone. A number in a table says a gap is
 *  14px; a strip says WHICH 14px, which is the part that resolves an argument
 *  about whether the right edge even moved. */
function gapStrips(doc, land) {
  if (!state.gaps) return []
  const root = doc.querySelector('.proRoot')
  const pad = doc.querySelector('.proTouchpad')
  if (!root || !pad) return []
  const R = root.getBoundingClientRect()
  const P = pad.getBoundingClientRect()
  const side = land ? insetVal('safeSide') : 0
  const out = []
  const safeL = R.left + side
  const safeR = R.right - side
  if (P.left - safeL > 0.5)
    out.push({ left: safeL, top: P.top, width: P.left - safeL, height: P.height,
      label: `${Math.round(P.left - safeL)}` })
  if (safeR - P.right > 0.5)
    out.push({ left: P.right, top: P.top, width: safeR - P.right, height: P.height,
      label: `${Math.round(safeR - P.right)}` })
  const btns = [...doc.querySelectorAll('.proKeyPill, .proIconBtn, .proMicBtn')]
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
  if (btns.length) {
    const rightMost = btns.reduce((a, b) => (b.right > a.right ? b : a))
    if (safeR - rightMost.right > 0.5)
      out.push({ left: rightMost.right, top: rightMost.top,
        width: safeR - rightMost.right, height: rightMost.height,
        label: `${Math.round(safeR - rightMost.right)}` })
    const leftMost = btns.reduce((a, b) => (b.left < a.left ? b : a))
    if (leftMost.left - safeL > 0.5 && leftMost.left - safeL < 200)
      out.push({ left: safeL, top: leftMost.top, width: leftMost.left - safeL,
        height: leftMost.height, label: `${Math.round(leftMost.left - safeL)}` })
  }
  return out
}

/* ---- Rendering ------------------------------------------------------------ */

function drawOverlay(res) {
  const ovl = document.getElementById('ovl')
  ovl.innerHTML = ''
  const d = dev()
  const land = isLandscape()
  if (state.safe) {
    const side = land ? insetVal('safeSide') : 0
    const top = land ? 0 : insetVal('safeTop')
    const bottom = land ? insetVal('safeBottomLandscape') : insetVal('safeBottom')
    const band = (css) => {
      const s = document.createElement('div')
      s.className = 'safe'
      Object.assign(s.style, css)
      ovl.appendChild(s)
    }
    if (bottom > 0) band({ bottom: '0', left: '0', right: '0', height: bottom + 'px' })
    if (top > 0) band({ top: '0', left: '0', right: '0', height: top + 'px' })
    if (side > 0) {
      band({ top: '0', bottom: '0', left: '0', width: side + 'px' })
      band({ top: '0', bottom: '0', right: '0', width: side + 'px' })
    }
  }
  if (state.boxes) {
    for (const b of res.boxes || []) {
      const i = document.createElement('i')
      i.className = b.cls
      Object.assign(i.style, { left: b.r.left + 'px', top: b.r.top + 'px',
        width: b.r.width + 'px', height: b.r.height + 'px' })
      ovl.appendChild(i)
    }
  }
  for (const g of res.strips || []) {
    const s = document.createElement('div')
    s.className = 'gap'
    Object.assign(s.style, { left: g.left + 'px', top: g.top + 'px',
      width: g.width + 'px', height: g.height + 'px' })
    s.innerHTML = `<b>${g.label}</b>`
    ovl.appendChild(s)
  }
}

function renderMeasurements(res) {
  const t = document.getElementById('meas')
  const rows = res.gaps || []
  t.innerHTML =
    '<tr><th>measured gap</th><th>owner</th><th class="n">got</th><th class="n">asked</th></tr>' +
    rows.map((g) => {
      // Three states worth distinguishing: past the safe edge (bad), asked-for
      // and got-it disagree (warn -- another rule owns this edge), and fine.
      const cls = g.got < -0.5 ? 'badRow'
        : g.want != null && Math.abs(g.got - g.want) > 1 ? 'warnRow' : ''
      return `<tr class="${cls}"><th>${g.what}</th><td>${g.owner}</td>` +
        `<td class="n">${g.got}</td><td class="n">${g.want == null ? '' : g.want}</td></tr>`
    }).join('')
  document.getElementById('dims').textContent = res.dims || ''
  const v = document.getElementById('verdict')
  v.className = 'verdict v-' + (res.state === 'ok' ? 'ok' : res.state === 'bad' ? 'bad' : 'wait')
  v.textContent = res.state === 'ok' ? 'clear' : res.state === 'bad' ? 'FAULT' : 'booting…'
  document.getElementById('rep').textContent = res.note || ''
}

/** The CSS you would actually write, for the values that differ from theme.css.
 *  Emitting only the diff, and naming the source line for each, so this can be
 *  pasted without re-deriving which rule to open. */
function renderCssDiff() {
  const out = []
  for (const v of VARS) {
    if (!(v.key in state.vars) || state.vars[v.key] === v.theme) continue
    if (v.css) out.push(`/* ${v.src} */\n${v.css}: ${state.vars[v.key]}px;  /* was ${v.theme}px */`)
    else out.push(`/* ${v.src} — .proRoot[data-orient='landscape'] .proControlsCell */\n` +
      `padding-left: ${state.vars[v.key]}px;\npadding-right: ${state.vars[v.key]}px;  /* was ${v.theme}px */`)
  }
  const insetDiff = INSETS.filter((i) => i.key in state.insets && state.insets[i.key] !== dev()[i.key])
  if (insetDiff.length)
    out.push('/* simulated insets — NOT css, these describe the device:\n   ' +
      insetDiff.map((i) => `${i.key} ${dev()[i.key]} → ${state.insets[i.key]}`).join(', ') + ' */')
  document.getElementById('css').value = out.join('\n\n')
}

/* ---- Controls ------------------------------------------------------------- */

/** A slider row. The number box and the range share one value, and BOTH write
 *  through the same setter -- two inputs with two handlers is how a tuner ends
 *  up showing one number while the deck renders another. */
function sliderRow(host, { label, hint, min, max, get, set, base }) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    `<span class="k">${label}<small>${hint}</small></span>` +
    `<input type="range" min="${min}" max="${max}" step="1">` +
    '<input type="number">' +
    '<button class="rst" title="reset">⟲</button>'
  const [range, num] = row.querySelectorAll('input')
  const sync = () => {
    const v = get()
    range.value = v
    num.value = v
    row.classList.toggle('dirty', v !== base())
  }
  const onInput = (e) => {
    const n = Number(e.target.value)
    if (!Number.isFinite(n)) return
    set(n)
    sync()
    apply()
  }
  range.addEventListener('input', onInput)
  num.addEventListener('input', onInput)
  row.querySelector('.rst').addEventListener('click', () => { set(null); sync(); apply() })
  host.appendChild(row)
  sync()
  return sync
}

const syncers = []

function seg(hostId, values, key, onChange) {
  const host = document.getElementById(hostId)
  host.innerHTML = ''
  for (const v of values) {
    const b = document.createElement('button')
    b.className = 't'
    b.textContent = String(v)
    b.setAttribute('aria-pressed', String(state[key] === v))
    b.addEventListener('click', () => {
      state[key] = v
      ;[...host.children].forEach((c) => c.setAttribute('aria-pressed', String(c === b)))
      onChange()
    })
    host.appendChild(b)
  }
}

/** Live path: rewrite the style block and re-measure. No re-boot, so a drag
 *  stays at ~60fps and the notch path is NOT recomputed -- which is correct,
 *  since useNotchPath re-measures off a ResizeObserver the var change triggers
 *  anyway. If the deck is not mounted yet, fall back to a boot. */
let pending = null
function apply() {
  writeUrlState()
  renderCssDiff()
  if (!applyLive(frameEl)) { boot(); return }
  // One measure per frame at most. A range input fires per pixel of travel, and
  // measuring inside every one of those turns a smooth drag into a slideshow.
  if (pending) return
  pending = requestAnimationFrame(() => { pending = null; refresh() })
}

/** Full re-boot. Needed only for changes the app reads at first paint (prefs,
 *  device size) -- a var change must never come through here. */
function reboot() {
  writeUrlState()
  renderCssDiff()
  syncers.forEach((s) => s())
  boot()
}

function refresh() {
  const res = measure()
  drawOverlay(res)
  renderMeasurements(res)
}

function buildPanel() {
  const sel = document.getElementById('device')
  sel.innerHTML = DEVICES.map((d) =>
    `<option${d.name === state.device ? ' selected' : ''}>${d.name}</option>`).join('')
  sel.addEventListener('change', () => {
    state.device = sel.value
    // Insets are seeded from the device row, so a device change must drop the
    // overrides -- carrying a 15 Pro's 59px onto an SE would silently simulate
    // a phone that does not exist.
    state.insets = {}
    reboot()
  })

  seg('orient', ['landscape', 'portrait'], 'orient', reboot)
  seg('keys', ['bottom', 'top'], 'keysPosition', reboot)
  seg('hand', ['right', 'left'], 'handedness', reboot)
  seg('deck', ['stacked', 'split'], 'deckMode', reboot)
  seg('skin', ['proII', 'default'], 'skin', reboot)

  const mHost = document.getElementById('mirror')
  mHost.innerHTML = ''
  for (const [lbl, val] of [['off', false], ['on', true]]) {
    const b = document.createElement('button')
    b.className = 't'
    b.textContent = lbl
    b.setAttribute('aria-pressed', String(state.mirror === val))
    b.addEventListener('click', () => {
      state.mirror = val
      ;[...mHost.children].forEach((c) => c.setAttribute('aria-pressed', String(c === b)))
      reboot()
    })
    mHost.appendChild(b)
  }

  const safeHost = document.getElementById('safeRows')
  for (const i of INSETS) {
    syncers.push(sliderRow(safeHost, {
      label: i.label, hint: i.hint, min: i.min, max: i.max,
      get: () => insetVal(i.key),
      base: () => dev()[i.key],
      set: (n) => { if (n === null) delete state.insets[i.key]; else state.insets[i.key] = n }
    }))
  }

  const varHost = document.getElementById('varRows')
  for (const v of VARS) {
    syncers.push(sliderRow(varHost, {
      label: v.label, hint: `${v.hint} · ${v.src}`, min: v.min, max: v.max,
      get: () => varVal(v.key),
      base: () => v.theme,
      set: (n) => { if (n === null) delete state.vars[v.key]; else state.vars[v.key] = n }
    }))
  }

  for (const [id, key] of [['showBoxes', 'boxes'], ['showSafe', 'safe'], ['showGaps', 'gaps']]) {
    const el = document.getElementById(id)
    el.checked = state[key]
    el.addEventListener('change', () => { state[key] = el.checked; writeUrlState(); refresh() })
  }

  document.getElementById('remeasure').addEventListener('click', refresh)
  document.getElementById('resetAll').addEventListener('click', () => {
    state.vars = {}
    state.insets = {}
    syncers.forEach((s) => s())
    apply()
  })
  document.getElementById('copyLink').addEventListener('click', () => {
    navigator.clipboard?.writeText(location.href)
  })
  document.getElementById('copyCss').addEventListener('click', () => {
    navigator.clipboard?.writeText(document.getElementById('css').value)
  })
}

readUrlState()
buildPanel()
renderCssDiff()
boot().catch((e) => {
  document.getElementById('rep').innerHTML = `<b>${e.message}</b>`
})
