// Rotation probe -- the one thing the deck viewer structurally cannot test.
//
// viewer.js mounts each orientation as its OWN fresh iframe, so every cell it
// renders is a cold boot into a fixed viewport. That makes it blind to any bug
// that lives in the TRANSITION between orientations: a cold-booted portrait
// deck is always correct, which is exactly why the stale-clip-path bug shipped
// green through a harness built to catch pad-over-button regressions.
//
// This boots ONE frame and resizes it, portrait -> landscape -> portrait, the
// way a real rotation does. The measurement is deliberately NOT the deck
// viewer's "does the pad cover a button" -- in the reported screenshot no button was
// covered. The pad was carved to a LANDSCAPE-width shape while the phone was
// portrait, leaving bare steel down the right side and slicing the
// DRAG/TAP/SCROLL hint mid-word. So the quantity that matters is how far the
// painted clip-path's right edge falls short of the pad's own layout box.
//
// Measured, never assumed (memory `harness-must-measure-not-assume`): the
// verdict below comes from the real `d` attribute and real rects, and the probe
// says so loudly when it cannot measure rather than reporting a passing number.

const BUNDLE = '../dist/index.html'
const PORTRAIT = { w: 393, h: 852 }
const LANDSCAPE = { w: 852, h: 393 }
// The notch's own timings (useNotchPath: ENTRANCE_DELAY 120 + ENTRANCE 620,
// MORPH 190, SETTLE_DEBOUNCE 32, MIRROR_SETTLE 1200). Measuring earlier than
// the slowest of these reports a shape still on its way somewhere else, which
// is indistinguishable from the bug.
const SETTLE_MS = 1500

const out = document.getElementById('out')
const frame = document.getElementById('frame')
const lines = []
const say = (s, cls = '') => {
  lines.push(cls ? `<span class="${cls}">${s}</span>` : s)
  out.innerHTML = lines.join('\n')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PREFS = {
  layout: 'pro',
  skin: 'proII',
  colorScheme: 'light',
  handedness: 'right',
  keysPosition: 'bottom',
  deckMode: 'stacked',
  splitConcept: 'mirror',
  showCursor: true,
  renderMarkup: false
}

async function bundleHtml() {
  const res = await fetch(BUNDLE)
  if (!res.ok) throw new Error(`no built bundle — run: npm run build:phone-remote`)
  let html = await res.text()
  html = html.replace('<head>', `<head><base href="../dist/">`)
  const script =
    `<script>window.__MM_LAYOUT_PREFS__=${JSON.stringify(PREFS)};` +
    `window.__MM_PREVIEW__=true;<\/script>`
  return html.replace('</head>', script + '</head>')
}

/** Set the frame's viewport. This is the rotation: the bundle reads
 *  window.innerWidth/innerHeight and listens for resize, so changing the
 *  iframe's box is genuinely what a device rotation looks like from inside. */
function setViewport(dims) {
  frame.style.width = dims.w + 'px'
  frame.style.height = dims.h + 'px'
}

/** Measure how completely the painted notch fills the pad's layout box.
 *
 *  Returns the gap on the right edge: the distance between the pad element's
 *  own right edge and the rightmost point the clip-path actually paints, at a
 *  height well clear of the notch's bite. On a correct deck that is ~0. In the
 *  screenshot it was ~300px of bare steel. */
function measurePad(win, doc) {
  const padEl = doc.querySelector('.proTouchpad')
  if (!padEl) return { err: 'deck not mounted' }
  const d = doc.getElementById('proNotchDynamicPath')?.getAttribute('d')
  if (!d) return { err: 'NO notch path — clipPath empty, pad paints zero pixels' }

  const rect = padEl.getBoundingClientRect()
  // The clip-path is userSpaceOnUse in the pad's UNSCALED local space, which is
  // what offsetWidth/offsetHeight report. Sampling in local space means the
  // result needs no unscaling.
  const w = padEl.offsetWidth
  const h = padEl.offsetHeight
  const path = new win.Path2D(d)
  const ctx = doc.createElement('canvas').getContext('2d')

  // Sample along a horizontal line in the pad's UPPER area, above the button
  // cluster entirely -- the notch's bite is at the bottom, so up here a correct
  // path should reach the pad's full width.
  const y = Math.round(h * 0.25)
  let rightmost = -1
  for (let x = w - 1; x >= 0; x--) {
    if (ctx.isPointInPath(path, x, y)) {
      rightmost = x
      break
    }
  }
  // Same question vertically, to catch a path that is short rather than narrow.
  const x0 = Math.round(w * 0.25)
  let lowest = -1
  for (let yy = h - 1; yy >= 0; yy--) {
    if (ctx.isPointInPath(path, x0, yy)) {
      lowest = yy
      break
    }
  }
  return {
    padW: Math.round(w),
    padH: Math.round(h),
    rectW: Math.round(rect.width),
    gapRight: rightmost < 0 ? w : Math.round(w - 1 - rightmost),
    gapBottom: lowest < 0 ? h : Math.round(h - 1 - lowest),
    mirrorW: win.getComputedStyle(doc.documentElement).getPropertyValue('--pro-mirror-w').trim() || '(unset)'
  }
}

// The mirror is NOT a layout pref -- it is runtime state driven by a WebRTC
// stream, so seeding it via __MM_LAYOUT_PREFS__ does nothing. But the pad's
// landscape geometry reads exactly two things: `data-mirror` on .proRoot and
// the `--pro-mirror-w` custom property App.tsx writes on <html> from the
// stream's aspect ratio. Both are reachable without a stream.
//
// This matters enormously here: with the mirror OFF, --pro-mirror-w is never
// set in EITHER orientation, so there is no stale value to carry across a
// rotation and the bug is unreachable. The first run of this probe passed for
// exactly that reason. The reported screenshot shows "Live" -- the mirror is on.
const MAC_ASPECT = 16 / 10
let padMinWidth = 256 // resolved from the bundle in main(); never hardcode-and-forget

function applyMirror(landscape) {
  const doc = frame.contentDocument
  const win = frame.contentWindow
  const root = doc.querySelector('.proRoot')
  if (!root) return
  root.setAttribute('data-mirror', 'on')
  if (!landscape) {
    // Portrait genuinely removes it -- App.tsx:1810, sizeMirrorPane's portrait
    // branch. Reproducing that removal is the point: the bug is the notch
    // measuring the LANDSCAPE value before this removal lands.
    doc.documentElement.style.removeProperty('--pro-mirror-w')
    return
  }
  const cs = win.getComputedStyle(root)
  const px = (n, f) => parseFloat(cs.getPropertyValue(n)) || f
  const inset = px('--pro-inset', 14)
  const gutter = px('--pro-gutter', 18)
  const ideal = (win.innerHeight - inset * 2) * MAC_ASPECT
  const available = win.innerWidth - inset * 2 - gutter - padMinWidth
  doc.documentElement.style.setProperty(
    '--pro-mirror-w',
    `${Math.max(0, Math.min(ideal, available))}px`
  )
}

/** Read PRO_LANDSCAPE_PAD_MIN_WIDTH out of the built bundle rather than
 *  duplicating it -- a hardcoded copy drifting from config.ts already cost
 *  three rounds of chasing a stale constant (viewer.js's own note). */
async function resolvePadMinWidth() {
  try {
    const html = await fetch(BUNDLE).then((r) => r.text())
    const src = html.match(/assets\/index-[^"']+\.js/)?.[0]
    if (!src) return
    const js = await fetch(`../dist/${src}`).then((r) => r.text())
    const hit = js.match(/PAD_MIN_WIDTH:\s*(\d+)/)
    if (hit) padMinWidth = Number(hit[1])
    else say('warn: PAD_MIN_WIDTH not found in bundle, using 256', 'dim')
  } catch {
    /* fallback stands */
  }
}

/** One measurement step, reported. */
async function step(label, dims) {
  setViewport(dims)
  // Mirror re-applies on each step the way sizeMirrorPane does on rotation:
  // once the new viewport is in effect, a frame later. Applied BEFORE the
  // settle wait so the notch observes it the way it would on a device.
  await new Promise((r) => requestAnimationFrame(r))
  applyMirror(dims.w > dims.h)
  await sleep(SETTLE_MS)
  const win = frame.contentWindow
  const doc = frame.contentDocument
  const m = measurePad(win, doc)
  if (m.err) {
    say(`${label.padEnd(26)} ERROR: ${m.err}`, 'bad')
    return null
  }
  // A few px of gap is the notch's own corner rounding at this sample height;
  // anything large is the pad failing to reach its own edge.
  const bad = m.gapRight > 24 || m.gapBottom > 24
  say(
    `${label.padEnd(26)} pad ${m.padW}x${m.padH}` +
      `  gapRight ${String(m.gapRight).padStart(4)}` +
      `  gapBottom ${String(m.gapBottom).padStart(4)}` +
      `  --pro-mirror-w ${m.mirrorW}`,
    bad ? 'bad' : 'ok'
  )
  return m
}

async function main() {
  try {
    const html = await bundleHtml()
    setViewport(PORTRAIT)
    const doc = frame.contentDocument
    doc.open()
    doc.write(html)
    doc.close()
    lines.length = 0
    say('Rotating ONE frame, MIRROR ON. gapRight = px the painted pad falls', 'dim')
    say('short of its own right edge, sampled above the notch.', 'dim')
    say('')
    await resolvePadMinWidth()
    await sleep(SETTLE_MS)

    await step('1. cold boot portrait', PORTRAIT)
    await step('2. rotate -> landscape', LANDSCAPE)
    const back = await step('3. rotate -> portrait', PORTRAIT)
    await step('4. rotate -> landscape', LANDSCAPE)
    const back2 = await step('5. rotate -> portrait', PORTRAIT)

    say('')
    const bad = [back, back2].filter((m) => m && m.gapRight > 24)
    if (bad.length) {
      say(`VERDICT: REPRODUCED — pad short by ${bad.map((b) => b.gapRight).join(', ')}px`, 'bad')
      say('after rotating back to portrait. This is the reported screenshot.', 'bad')
    } else {
      say('VERDICT: pad reaches its full width in portrait after rotations.', 'ok')
    }
  } catch (e) {
    say('probe failed: ' + e.message, 'bad')
    say('(this is the PROBE failing, not a verdict about the app)', 'dim')
  }
}

main()
