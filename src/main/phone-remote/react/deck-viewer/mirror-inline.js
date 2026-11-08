/* mirror-inline.js — does putting the screen mirror INSIDE the trackpad buy
 * enough pad back to be worth building for real?
 *
 * Shipped portrait layout stacks three boxes down the deck: .mirrorPane (fixed,
 * aspect-derived height), the zoom bar, then .proTouchpad, whose `top` is
 * computed from all of it (TouchpadLayout.tsx:1136). The pad pays the mirror's
 * full height. The experiment overlays them instead: video fills the pad, the
 * offset math is neutralized, and the pad reclaims the deck.
 *
 * Both cells run the REAL bundle, and the pad box is read from a live
 * getBoundingClientRect() -- a hand-derived number would manufacture whatever
 * verdict the author expected. The verdict line is pad-area delta, because
 * "more of both" is a measurable claim, not a taste one.
 *
 * Nothing here touches the app, the server, or a shipped file: the inline
 * layout is injected as a <style> into the iframe, so no user can reach it.
 */

const BUNDLE = '../dist/index.html'

// Portrait is the whole point -- landscape already sits side by side, so it has
// no stacking problem to fix. Landscape is offered only to prove the inline
// branch does not disturb it.
const DEVICES = [
  { name: 'iPhone SE',         w: 375, h: 667, safeTop: 20, safeBottom: 0,  safeSide: 0,  safeBottomLandscape: 0 },
  { name: 'iPhone 14',         w: 390, h: 844, safeTop: 47, safeBottom: 34, safeSide: 47, safeBottomLandscape: 21 },
  { name: 'iPhone 15 Pro',     w: 393, h: 852, safeTop: 59, safeBottom: 34, safeSide: 59, safeBottomLandscape: 21 },
  { name: 'iPhone 15 Pro Max', w: 430, h: 932, safeTop: 59, safeBottom: 34, safeSide: 59, safeBottomLandscape: 21 }
]

const SKINS = ['proII', 'default']

// A 16:10 Mac display: the shape that drives the tallest portrait pane, so the
// stacked layout is measured at its WORST, not at a flattering aspect.
const MAC_ASPECT = 16 / 10

// Fallbacks only -- the live values are read off the deck in applyMirror().
// Never copy a constant the bundle already ships (a stale hardcoded
// PAD_MIN_WIDTH cost three rounds of chasing a fixed bug, viewer.js:277).
const PRO_INSET = 14
// CONFIG.PHONE_REMOTE.MIRROR_TRACKPAD_GAP (config.ts:2146) -- the breathing
// room the shipped stacked layout puts between pane and pad.
const MIRROR_TRACKPAD_GAP = 10

const state = {
  device: 'iPhone 15 Pro',
  skin: 'proII',
  orient: 'portrait',
  boxes: true
}

/* ── prefs the bundle reads at first paint ──────────────────────────────── */

function prefs() {
  return {
    skin: state.skin,
    keysPosition: 'bottom',
    handedness: 'right',
    deckMode: 'stacked',
    virtualKeyboard: true,
    showCursor: true,
    appRing: false,
    renderMarkup: false
  }
}

let bundleHtml = null
async function loadBundleHtml(force = false) {
  if (bundleHtml && !force) return bundleHtml
  const res = await fetch(BUNDLE, force ? { cache: 'reload' } : undefined)
  if (!res.ok) throw new Error(`no built bundle at ${BUNDLE} — run: npm run build:phone-remote`)
  let html = await res.text()
  // Relative URLs (./assets/*, ./cork.webp) must resolve from ../dist/ once the
  // document is written into an iframe whose own URL is this folder.
  html = html.replace('<head>', `<head><base href="../dist/">`)
  bundleHtml = html
  return html
}

/** Inject prefs before the bundle's deferred module script runs. Rewriting the
 *  HTML wins that race deterministically; srcdoc would break asset paths.
 *
 *  __MM_PREVIEW__ is not optional: without it the app renders the bootGate
 *  splash instead of the deck (App.tsx:4975 -- a load that never connects is
 *  exactly what a harness is), so both cells sit at "Connecting to your Mac…"
 *  and measure nothing. */
function withPrefs(html) {
  const script =
    `<script>window.__MM_LAYOUT_PREFS__=${JSON.stringify(prefs())};` +
    `window.__MM_PREVIEW__=true;` +
    // Seed the keyboard pref ON for the same reason viewer.js does: its OFF
    // default focuses a hidden input, which on a Mac just yanks focus between
    // the two cells instead of drawing anything.
    `try{localStorage.setItem('mm-remote-virtual-keyboard','on')}catch(e){}<\/script>`
  return html.replace('</head>', `${script}</head>`)
}

/** Replace the iframe rather than re-writing it: a second doc.write into a
 *  loaded iframe does not reliably re-mount, and comes back as an empty deck. */
async function boot(frame, html) {
  const fresh = frame.cloneNode(false)
  frame.replaceWith(fresh)
  await new Promise((r) => requestAnimationFrame(r))
  const doc = fresh.contentDocument
  doc.open()
  doc.write(html)
  doc.close()
  return fresh
}

/* ── safe area ──────────────────────────────────────────────────────────── */

/** env(safe-area-inset-*) has no JS setter and reports 0 in an iframe, so the
 *  insets are re-added as padding on the children that clear their own edge.
 *  A simulation of the geometry, not of iOS. (Same approach as viewer.js.) */
function safeAreaCss(dev, landscape) {
  const side = landscape ? dev.safeSide : 0
  const top = landscape ? 0 : dev.safeTop
  const pad = `calc(${side}px + var(--pro-inset))`
  return (
    `<style id="mm-harness-safe-area">` +
    `.proRoot{background-color:#000;}` +
    `.proRoot[data-orient='landscape'] .proTouchpad{left:${pad}!important;right:${pad}!important;}` +
    // Portrait: the pane is the top-most box, so it is what must clear the notch.
    `.proRoot[data-orient='portrait'] .mirrorPane{top:calc(${top}px + 8px)!important;}` +
    `</style>`
  )
}

/* ── the layouts ────────────────────────────────────────────────────────── */

/** The four candidates. All three experiments put the pane INSIDE the pad and
 *  drop the stacking offset -- they differ only in how much of the pad the
 *  screen is allowed to claim, which is the actual open question.
 *
 *  Written as !important overrides rather than theme.css edits because this is
 *  a question, not a feature: nothing here is reachable by a user. */
const VARIANTS = [
  {
    id: 'stacked',
    label: 'Stacked (shipped)',
    note: 'Pane on top, pad pushed below. Both boxes small.',
    inline: false
  },
  {
    id: 'bleed',
    label: 'Full-bleed',
    note: 'Screen fills the pad. Most pixels, but the cork and the DRAG hint are gone.',
    inline: true
  },
  {
    id: 'glass',
    label: 'Glass table',
    note: "Screen keeps its own size + aspect, centered under the pad's surface.",
    inline: true
  },
  {
    id: 'inset',
    label: 'Inset',
    note: 'Screen fills the pad width but stops above the key cluster.',
    inline: true
  }
]

/** Shared by every inline variant: un-fix the pane, undo the stacking offset,
 *  move the zoom bar to the pad's bottom edge. */
function inlineBaseCss() {
  return (
    `.proRoot[data-orient='portrait'] .mirrorPane{` +
    `position:absolute!important;height:auto!important;width:auto!important;` +
    `border:0!important;box-shadow:none!important;` +
    // z-index 1, not 0: the pad paints cork + a sheen, and a pane behind them
    // is a mirror you cannot see -- the failure this page must reveal, not
    // reproduce.
    `z-index:1!important;}` +
    // TouchpadLayout sets this offset INLINE from the measured pane height, so
    // only !important can reach it.
    `.proRoot[data-orient='portrait'] .proTouchpad.withMirror{` +
    `top:calc(env(safe-area-inset-top, 0px) + var(--pro-inset))!important;` +
    `position:relative!important;}` +
    `.proRoot[data-orient='portrait'] .proZoomBarWrap{` +
    `top:auto!important;bottom:calc(env(safe-area-inset-bottom, 0px) + 8px)!important;}`
  )
}

function variantCss(id) {
  if (id === 'stacked') return ''

  let shape = ''
  if (id === 'bleed') {
    // Edge to edge; inherit the pad's radius so it follows the notch carve.
    shape =
      `.proRoot[data-orient='portrait'] .mirrorPane{` +
      `inset:0!important;border-radius:inherit!important;}` +
      `.proRoot[data-orient='portrait'] .mm-fake-screen{opacity:.88!important;}`
  } else if (id === 'glass') {
    // THE GLASS TABLE: the screen keeps the size and aspect it has today and
    // floats centered in the pad, cork visible all around it. The pad is a
    // sheet of glass with a display underneath -- so the pane must not eat
    // touches (pointer-events:none), which is what makes it read as *under*
    // the surface rather than as a video sitting on it.
    //
    // Centered on the pad's own box via translate, not on the deck: the pad is
    // notch-carved and its centre is not the screen's centre.
    shape =
      `.proRoot[data-orient='portrait'] .mirrorPane{` +
      `top:50%!important;left:50%!important;right:auto!important;bottom:auto!important;` +
      `transform:translate(-50%,-50%)!important;` +
      `width:var(--mm-glass-w)!important;height:var(--mm-glass-h)!important;` +
      `border-radius:10px!important;pointer-events:none!important;` +
      // Under glass: dimmed, slightly cool, and softly shadowed into the cork
      // so it sits BELOW the surface instead of on it.
      `opacity:.72!important;` +
      `box-shadow:0 2px 14px rgba(0,0,0,.45) inset, 0 1px 3px rgba(255,255,255,.18)!important;}` +
      // The pane must not cover the DRAG hint -- that text is the thing telling
      // the user this is still a trackpad.
      `.proRoot[data-orient='portrait'] .proTouchpad::after{z-index:2!important;}`
  } else if (id === 'inset') {
    // Full width, stopping above the cluster so no key ever overlaps the
    // screen. 62% is the pad height left once the cluster is excluded.
    shape =
      `.proRoot[data-orient='portrait'] .mirrorPane{` +
      `top:0!important;left:0!important;right:0!important;bottom:auto!important;` +
      `height:62%!important;border-radius:inherit!important;}` +
      `.proRoot[data-orient='portrait'] .mm-fake-screen{opacity:.9!important;}`
  }

  return `<style id="mm-harness-inline-mirror">${inlineBaseCss()}${shape}</style>`
}

/** A stand-in for the Mac's desktop, drawn in CSS.
 *
 *  It has to READ as a screen at a glance -- menu bar, a window, a dock -- or
 *  the judgement this page exists for ("does the mirror still feel big enough
 *  inside the pad?") is being made against a grey rectangle. Pure CSS keeps it
 *  a text file: a base64 screenshot would bloat the harness and date instantly.
 */
function fakeScreenCss() {
  return (
    `.mm-fake-screen{position:absolute;inset:0;overflow:hidden;` +
    `background:linear-gradient(160deg,#2f5d84 0%,#3b7ba6 45%,#6aa9c4 100%);}` +
    // Menu bar.
    `.mm-fake-screen::before{content:'';position:absolute;top:0;left:0;right:0;` +
    `height:7%;min-height:9px;background:rgba(255,255,255,.22);` +
    `border-bottom:1px solid rgba(255,255,255,.18);}` +
    // Dock.
    `.mm-fake-screen::after{content:'';position:absolute;bottom:3%;` +
    `left:50%;transform:translateX(-50%);width:52%;height:7%;min-height:8px;` +
    `border-radius:6px;background:rgba(255,255,255,.28);` +
    `border:1px solid rgba(255,255,255,.3);}` +
    // A window, so there is something with edges to judge sharpness against.
    `.mm-fake-win{position:absolute;left:12%;top:20%;width:62%;height:52%;` +
    `border-radius:5px;background:#f4f1ec;box-shadow:0 6px 18px rgba(0,0,0,.35);` +
    `overflow:hidden;}` +
    `.mm-fake-win::before{content:'';position:absolute;top:0;left:0;right:0;` +
    `height:16%;min-height:6px;background:#dcd7d0;}` +
    // Text lines in the window.
    `.mm-fake-win::after{content:'';position:absolute;left:8%;top:28%;width:74%;` +
    `height:44%;background:repeating-linear-gradient(180deg,` +
    `#c9c3ba 0 2px,transparent 2px 7px);}`
  )
}

/** Build the mirror pane ourselves.
 *
 *  THE THING THAT BLOCKED THIS PAGE: `mirrorOn` is runtime state derived from a
 *  live WebRTC track, and TouchpadLayout.tsx:984 gates the pane behind it --
 *  `{mirrorOn && <div className="mirrorPane">}`. With no Mac there is no track,
 *  so the element is never in the DOM at all and `data-mirror='on'` has nothing
 *  to style. viewer.js gets away with attribute-only faking because it measures
 *  the PAD's landscape geometry, which reads a CSS var; a portrait pane has to
 *  actually exist.
 *
 *  So the harness constructs the element the app would have built, with the
 *  same class names, inside the same parent (.proCard). Real theme.css rules
 *  then apply to it exactly as they would on device -- which is what keeps this
 *  a test of the LAYOUT rather than of a mock. */
function mountPane(doc, inline) {
  const card = doc.querySelector('.proCard')
  if (!card || card.querySelector('.mirrorPane')) return card?.querySelector('.mirrorPane') ?? null

  if (!doc.getElementById('mm-fake-screen-css')) {
    const st = doc.createElement('style')
    st.id = 'mm-fake-screen-css'
    st.textContent = fakeScreenCss()
    doc.head.appendChild(st)
  }

  const pane = doc.createElement('div')
  pane.className = 'mirrorPane proMirrorPane'
  const screen = doc.createElement('div')
  screen.className = 'mm-fake-screen'
  screen.appendChild(doc.createElement('div')).className = 'mm-fake-win'
  pane.appendChild(screen)

  // Inline mounts INSIDE the pad so the video inherits the pad's notch-clipped
  // shape; stacked is a sibling in .proCard, exactly as the app builds it.
  const pad = doc.querySelector('.proTouchpad')
  if (inline && pad) pad.insertBefore(pane, pad.firstChild)
  else card.insertBefore(pane, card.firstChild)
  return pane
}

/** Fake a live mirror without a stream. Mounts the pane, then sizes it the way
 *  the app does: portrait height is aspect-derived from the pane's own width
 *  (what loadedmetadata drives on device); landscape width comes from
 *  --pro-mirror-w, which is all the stylesheet reads there. */
function applyMirror(frame, dev, landscape, variantId) {
  const inline = variantId !== 'stacked'
  const doc = frame.contentDocument
  const root = doc.querySelector('.proRoot')
  if (!root) return
  root.setAttribute('data-mirror', 'on')

  const pane = mountPane(doc, inline)
  const win = frame.contentWindow
  const cs = win.getComputedStyle(root)
  const inset = parseFloat(cs.getPropertyValue('--pro-inset')) || PRO_INSET

  if (landscape) {
    const ideal = (win.innerHeight - inset * 2) * MAC_ASPECT
    doc.documentElement.style.setProperty('--pro-mirror-w', `${Math.max(0, ideal * 0.55)}px`)
    return
  }
  doc.documentElement.style.removeProperty('--pro-mirror-w')
  if (!pane) return

  if (inline) {
    // Sized by the pad it lives in; an inline height would fight it.
    pane.style.removeProperty('height')
    // GLASS: the whole point is that the screen keeps the size it has TODAY, so
    // it is measured from the shipped stacked geometry (full deck width at the
    // Mac's aspect) rather than from the pad -- a pad-relative percentage would
    // silently resize the screen on every device and answer a different
    // question than the one asked.
    if (variantId === 'glass') {
      const w = win.innerWidth - inset * 2
      doc.documentElement.style.setProperty('--mm-glass-w', `${Math.round(w)}px`)
      doc.documentElement.style.setProperty('--mm-glass-h', `${Math.round(w / MAC_ASPECT)}px`)
    }
    return
  }
  const w = pane.getBoundingClientRect().width || win.innerWidth - inset * 2
  const h = Math.round(w / MAC_ASPECT)
  pane.style.height = `${h}px`
  // The pad's offset is set INLINE by TouchpadLayout from the measured pane
  // height. That effect never ran (no real mirror), so the pad is still at its
  // no-mirror top and the pane would paint straight over it -- the stacked
  // layout has to be completed here for the comparison to be honest.
  const pad = doc.querySelector('.proTouchpad')
  if (pad) {
    pad.classList.add('withMirror')
    const top = pane.getBoundingClientRect().bottom - root.getBoundingClientRect().top
    pad.style.top = `${Math.round(top + MIRROR_TRACKPAD_GAP)}px`
  }
}

/** Poll for the mount. A fixed delay silently no-ops on a slow bundle, and a
 *  no-op looks exactly like "the inline layout changes nothing". */
function whenReady(frame, fn, tries = 60) {
  if (frame.contentDocument?.querySelector('.proRoot')) return fn()
  if (tries <= 0) return console.warn('[mirror-inline] deck never mounted')
  setTimeout(() => whenReady(frame, fn, tries - 1), 25)
}

/* ── measurement ────────────────────────────────────────────────────────── */

/** Live rects for the two boxes the experiment trades between. Measured, not
 *  derived: the pad's top is set inline from a runtime height in one layout and
 *  by CSS in the other, so only the real rect knows where it ended up. */
function measure(frame) {
  const doc = frame.contentDocument
  const pad = doc?.querySelector('.proTouchpad')
  const pane = doc?.querySelector('.mirrorPane')
  if (!pad) return null
  const p = pad.getBoundingClientRect()
  const m = pane?.getBoundingClientRect() ?? null
  return {
    pad: { x: p.left, y: p.top, w: p.width, h: p.height },
    mirror: m ? { x: m.left, y: m.top, w: m.width, h: m.height } : null
  }
}

function drawBoxes(ovl, rect) {
  ovl.innerHTML = ''
  if (!rect || !state.boxes) return
  const add = (cls, r) => {
    if (!r) return
    const i = document.createElement('i')
    i.className = cls
    i.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`
    ovl.appendChild(i)
  }
  add('mir', rect.mirror)
  add('pad', rect.pad)
}

/* ── rendering ──────────────────────────────────────────────────────────── */

const grid = document.getElementById('grid')
// Both cells' measurements, so the verdict can state a DELTA rather than two
// unrelated numbers. The comparison is the entire point of the page.
const measured = {}

/** Both numbers that matter, against the shipped layout: how much PAD you get
 *  back, and how much SCREEN you give up. Reporting pad alone would score
 *  full-bleed as the obvious winner while hiding that glass shrinks nothing. */
function verdictFor(id, rect) {
  if (!rect) return { cls: 'v-wait', text: 'measuring…' }
  const pad = Math.round((rect.pad.w * rect.pad.h) / 1000)
  const base = measured.stacked
  if (id === 'stacked' || !base) return { cls: 'v-wait', text: `pad ${pad}k px²` }

  const padDelta = Math.round(((pad - (base.pad.w * base.pad.h) / 1000) / ((base.pad.w * base.pad.h) / 1000)) * 100)
  const sign = padDelta > 0 ? '+' : ''
  let text = `pad ${sign}${padDelta}%`
  if (rect.mirror && base.mirror) {
    const m = rect.mirror.w * rect.mirror.h
    const mb = base.mirror.w * base.mirror.h
    const mDelta = Math.round(((m - mb) / mb) * 100)
    text += ` · screen ${mDelta > 0 ? '+' : ''}${mDelta}%`
  }
  return { cls: padDelta > 0 ? 'v-ok' : 'v-bad', text }
}

function refreshVerdicts() {
  for (const v of VARIANTS) {
    const el = document.querySelector(`[data-verdict='${v.id}']`)
    if (!el) continue
    const r = verdictFor(v.id, measured[v.id])
    el.className = `verdict ${r.cls}`
    el.textContent = r.text
  }
}

async function renderCell(variant, dev, landscape, html) {
  const w = landscape ? dev.h : dev.w
  const h = landscape ? dev.w : dev.h

  const cell = document.createElement('div')
  cell.className = 'cell'
  cell.innerHTML =
    `<div class="head">` +
    `<span class="name">${variant.label}</span>` +
    `<span class="dims">${w}×${h}</span>` +
    `<span class="verdict v-wait" data-verdict="${variant.id}">booting…</span>` +
    `</div>` +
    `<div class="phone" style="width:${w}px;height:${h}px">` +
    `<iframe width="${w}" height="${h}"></iframe><div class="ovl"></div></div>` +
    `<p class="note">${variant.note}</p>`
  grid.appendChild(cell)

  let frame = cell.querySelector('iframe')
  const ovl = cell.querySelector('.ovl')

  const doc = withPrefs(html)
    .replace('</head>', `${safeAreaCss(dev, landscape)}</head>`)
    .replace('</head>', `${variantCss(variant.id)}</head>`)

  frame = await boot(frame, doc)
  whenReady(frame, () => {
    applyMirror(frame, dev, landscape, variant.id)
    // One frame for the app's own layout effects (useNotchPath measures the pad
    // and re-clips it) before reading rects -- otherwise the pad is measured
    // mid-transition and the delta is noise.
    requestAnimationFrame(() =>
      setTimeout(() => {
        const rect = measure(frame)
        measured[variant.id] = rect
        drawBoxes(ovl, rect)
        refreshVerdicts()
      }, 120)
    )
  })
}

async function render() {
  grid.innerHTML = ''
  for (const v of VARIANTS) delete measured[v.id]
  const dev = DEVICES.find((d) => d.name === state.device) ?? DEVICES[2]
  const landscape = state.orient === 'landscape'
  let html
  try {
    html = await loadBundleHtml()
  } catch (err) {
    grid.innerHTML = `<p style="color:#ff9aa8">${err.message}</p>`
    return
  }
  // Sequential, stacked first: simultaneous boots race for focus, and every
  // delta is quoted against stacked, so its rect has to land before the rest.
  for (const v of VARIANTS) await renderCell(v, dev, landscape, html)
}

/* ── controls ───────────────────────────────────────────────────────────── */

function seg(host, values, key, labels = {}) {
  host.innerHTML = ''
  for (const v of values) {
    const b = document.createElement('button')
    b.className = 't sm'
    b.textContent = labels[v] ?? v
    b.setAttribute('aria-pressed', String(state[key] === v))
    b.onclick = () => {
      state[key] = v
      seg(host, values, key, labels)
      render()
    }
    host.appendChild(b)
  }
}

seg(document.getElementById('deviceSeg'), DEVICES.map((d) => d.name), 'device')
seg(document.getElementById('orientSeg'), ['portrait', 'landscape'], 'orient')
seg(document.getElementById('boxSeg'), [true, false], 'boxes', { true: 'on', false: 'off' })

const skinSel = document.getElementById('skin')
for (const s of SKINS) {
  const o = document.createElement('option')
  o.value = s
  o.textContent = s
  skinSel.appendChild(o)
}
skinSel.value = state.skin
skinSel.onchange = () => {
  state.skin = skinSel.value
  render()
}

document.getElementById('reload').onclick = async () => {
  await loadBundleHtml(true)
  render()
}

render()
