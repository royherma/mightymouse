// Split-hand deck harness -- four landscape two-thumb layouts, measured.
//
// WHY THIS EXISTS: the split variants are a PROPOSAL. They are not in the built
// bundle, so deck-viewer/viewer.html (which boots the real dist/) cannot show
// them. This page renders each proposal as a mockup at real device viewports and
// then MEASURES it, rather than asking anyone to judge an arrangement by eye.
//
// What is real here, and therefore what the verdicts are worth:
//   - viewport sizes + safe-area insets: the same DEVICES table viewer.js uses
//   - control box sizes: scraped from theme.css (pill 108x48, icon 44, mic 60)
//   - landscape anchoring: env(safe-area-inset-bottom) for the deck, SIDE insets
//     for the outer edges -- the two rules the shipped landscape block enforces
// What is NOT real: the paint. No skin tokens, no notch clip-path. This page
// answers "can both thumbs reach these controls, and do they collide with the
// pad" -- not "does it look right". The second question needs the real bundle.
//
// Measured, never assumed (memory `harness-must-measure-not-assume`): every
// verdict below comes from getBoundingClientRect() on the rendered nodes, walked
// at 4px, in BOTH handedness modes. Nothing is derived from the numbers this
// file used to POSITION the controls -- that would only prove the arithmetic
// agrees with itself (memory `hit-target-centre-check-passes-dead-targets`).

// Landscape viewports: the portrait table rotated, since that is the only
// orientation this proposal touches. safeSide is the notch, which becomes a
// LEFT/RIGHT inset when rotated -- the trap the design calls out.
const DEVICES = [
  { name: 'iPhone SE',         w: 667, h: 375, safeSide: 0,  safeBottom: 0 },
  { name: 'iPhone 13 mini',    w: 812, h: 375, safeSide: 50, safeBottom: 21 },
  { name: 'iPhone 14',         w: 844, h: 390, safeSide: 47, safeBottom: 21 },
  { name: 'iPhone 15 Pro',     w: 852, h: 393, safeSide: 59, safeBottom: 21 },
  { name: 'iPhone 15 Pro Max', w: 932, h: 430, safeSide: 59, safeBottom: 21 }
]

// Real control footprints, scraped from theme.css rather than invented:
//   .proKeyPill  min-width 60 + padding 0 24px -> 108 wide, height 48  (:5034)
//   .proIconBtn  44 x 44                                              (:5206)
//   .proMicBtn   60 x 60                                              (:5118)
// A mockup with made-up box sizes would produce reach numbers that describe
// nothing, which is the failure mode this comment exists to prevent.
const PILL = { w: 108, h: 48 }
const ICON = { w: 44, h: 44 }
const MIC = { w: 60, h: 60 }

// Landscape layout constants, from theme.css's [data-orient='landscape'] block.
const PRO_INSET = 14           // --pro-inset, margin off the screen edge
const HEADER_BAND = 34         // --pro-header-band-land
const HEADER_GAP = 12          // --pro-header-gap
const SAFE_BOTTOM_MIN = 10     // env(safe-area-inset-bottom, 10px) fallback

// THE ergonomic threshold. A thumb pivoting at the bottom corner of a phone held
// in landscape sweeps a comfortable arc of roughly 45mm without regripping;
// at ~3.1 CSS px/mm on these devices that is ~140px. Beyond it a control is
// reachable only by shifting grip, which in practice means it does not get used.
//
// This is ONE number and it is a judgment call, so it is named, not buried in a
// comparison: change it here and every verdict on the page moves together.
const THUMB_REACH_PX = 140
// Past this the control is not merely awkward, it needs a second hand.
const THUMB_REACH_HARD_PX = 190

// The eight controls, tagged by how often they get used. The frequency split is
// what the fan/pod variants sort on -- "which row was it in before" is the wrong
// axis, and sorting by it is exactly what option A is criticised for.
const CONTROLS = [
  { id: 'mic',      label: 'mic',   size: MIC,  freq: 'high', kind: 'mic' },
  { id: 'keyboard', label: '⌨',     size: PILL, freq: 'high', kind: 'pill' },
  { id: 'enter',    label: 'Enter', size: PILL, freq: 'high', kind: 'pill' },
  { id: 'tab',      label: 'Tab',   size: PILL, freq: 'mid',  kind: 'pill' },
  { id: 'esc',      label: 'Esc',   size: PILL, freq: 'mid',  kind: 'pill' },
  { id: 'switcher', label: '▦',     size: ICON, freq: 'mid',  kind: 'icon' },
  { id: 'prev',     label: '⇄',     size: ICON, freq: 'mid',  kind: 'icon' },
  { id: 'settings', label: '⚙',     size: ICON, freq: 'low',  kind: 'icon' }
]

const byId = (id) => CONTROLS.find((c) => c.id === id)

const state = {
  variant: 'all',
  hand: 'right',
  mirror: false,
  show: 'arcs'
}

// ---------------------------------------------------------------------------
// Variants. Each returns absolute boxes in DECK-LOCAL px, plus the pad box it
// leaves over. Pad is computed as "whatever the deck does not claim", which is
// the rule the app already follows in both orientations -- so a variant that
// eats more screen shows a smaller pad here automatically, without anyone
// remembering to shrink it.
// ---------------------------------------------------------------------------

/** Geometry shared by every variant: where the usable band starts and ends
 *  once the header, the safe-area insets and the standard inset are honored. */
function frame(dev) {
  return {
    left: dev.safeSide + PRO_INSET,
    right: dev.w - dev.safeSide - PRO_INSET,
    top: HEADER_BAND + HEADER_GAP,
    bottom: dev.h - Math.max(dev.safeBottom, SAFE_BOTTOM_MIN)
  }
}

/** The shipped layout, rendered here for comparison. Everything in one bottom
 *  corner on the data-hand side: 2x2 pill grid over a 4-wide icon row. */
function stacked(dev, hand) {
  const f = frame(dev)
  const gap = 8
  const clusterW = PILL.w * 2 + gap
  const rowW = MIC.w + ICON.w * 3 + gap * 3
  const w = Math.max(clusterW, rowW)
  const x0 = hand === 'right' ? f.right - w : f.left
  const rowY = f.bottom - ICON.h
  const gridY = rowY - gap - PILL.h * 2 - gap

  const ctls = [
    { ...byId('esc'), x: x0, y: gridY },
    { ...byId('keyboard'), x: x0 + PILL.w + gap, y: gridY },
    { ...byId('tab'), x: x0, y: gridY + PILL.h + gap },
    { ...byId('enter'), x: x0 + PILL.w + gap, y: gridY + PILL.h + gap }
  ]
  // Icon row: mic leads on the data-hand side, matching BottomIconRow's order.
  const rowIds = ['mic', 'switcher', 'prev', 'settings']
  let rx = x0
  for (const id of rowIds) {
    const c = byId(id)
    ctls.push({ ...c, x: rx, y: rowY + (ICON.h - c.size.h) / 2 })
    rx += c.size.w + gap
  }
  // Pad spans the column beside the cluster; the cluster overlays its corner,
  // which is why the shipped build carves a notch.
  return { ctls, pad: { x: f.left, y: f.top, w: f.right - f.left, h: f.bottom - f.top } }
}

/** A -- mirror split. The two existing rows detached and pinned to opposite
 *  bottom corners. Smallest diff; the 4-wide icon row is the weak point. */
function splitMirror(dev, hand) {
  const f = frame(dev)
  const gap = 8
  // Key grid goes to the NON-primary corner, icon row to the primary one, so
  // the mic stays under the dominant thumb.
  const gridRight = hand === 'left'
  const gridW = PILL.w * 2 + gap
  const gridX = gridRight ? f.right - gridW : f.left
  const gridY = f.bottom - PILL.h * 2 - gap

  const ctls = [
    { ...byId('esc'), x: gridX, y: gridY },
    { ...byId('keyboard'), x: gridX + PILL.w + gap, y: gridY },
    { ...byId('tab'), x: gridX, y: gridY + PILL.h + gap },
    { ...byId('enter'), x: gridX + PILL.w + gap, y: gridY + PILL.h + gap }
  ]

  const rowIds = ['mic', 'switcher', 'prev', 'settings']
  const rowW = MIC.w + ICON.w * 3 + gap * 3
  let rx = gridRight ? f.left : f.right - rowW
  // Mic nearest the corner pivot in both mirrorings.
  const ordered = gridRight ? rowIds : [...rowIds].reverse()
  const rowY = f.bottom - MIC.h
  for (const id of ordered) {
    const c = byId(id)
    ctls.push({ ...c, x: rx, y: rowY + (MIC.h - c.size.h) / 2 })
    rx += c.size.w + gap
  }

  const deckH = Math.max(PILL.h * 2 + gap, MIC.h) + 10
  return { ctls, pad: { x: f.left, y: f.top, w: f.right - f.left, h: f.bottom - f.top - deckH } }
}

/** B -- thumb fans. Four controls per corner on an ARC around the pivot, sorted
 *  by frequency rather than by original row. The recommended option. */
function splitFan(dev, hand) {
  const f = frame(dev)
  // Pivot: the bottom corner the thumb actually rotates about. Slightly inside
  // the frame because a thumb's base is not at the literal pixel corner.
  const pivotY = f.bottom + 6

  // Frequency-sorted: the dominant thumb gets mic + keyboard + enter, the other
  // gets navigation. Settings takes the worst slot on the low-frequency side,
  // folding option D's insight in without moving it out of the deck.
  const primary = ['mic', 'keyboard', 'enter', 'settings']
  const secondary = ['esc', 'tab', 'switcher', 'prev']

  // Slot angles measured up from the horizontal, innermost first. Radii stagger
  // so four controls fit inside one arc without overlapping each other.
  const SLOTS = [
    { ang: 26, r: 62 },
    { ang: 58, r: 74 },
    { ang: 86, r: 96 },
    { ang: 8, r: 118 }
  ]

  const ctls = []
  const place = (ids, side) => {
    const pivotX = side === 'right' ? f.right - 4 : f.left + 4
    const dir = side === 'right' ? -1 : 1
    ids.forEach((id, i) => {
      const c = byId(id)
      const s = SLOTS[i]
      const rad = (s.ang * Math.PI) / 180
      const cx = pivotX + dir * Math.cos(rad) * s.r
      const cy = pivotY - Math.sin(rad) * s.r
      ctls.push({ ...c, x: cx - c.size.w / 2, y: cy - c.size.h / 2 })
    })
  }
  place(primary, hand)
  place(secondary, hand === 'right' ? 'left' : 'right')

  // Two shallow corner bites instead of one deep staircase -- the pad keeps its
  // full height in the middle, which is the reclaim this option is chosen for.
  return { ctls, pad: { x: f.left, y: f.top, w: f.right - f.left, h: f.bottom - f.top } }
}

/** C -- edge rails. A vertical 4-stack down each side edge. Symmetric and needs
 *  no notch work, but a rail is the wrong shape for a thumb's sweep. */
function splitRails(dev, hand) {
  const f = frame(dev)
  const gap = 10
  const railW = Math.max(ICON.w, MIC.w)
  const primary = ['mic', 'keyboard', 'enter', 'settings']
  const secondary = ['esc', 'tab', 'switcher', 'prev']

  const ctls = []
  const place = (ids, side) => {
    const cx = side === 'right' ? f.right - railW / 2 : f.left + railW / 2
    // Bottom-up: the nearest slot to the corner gets the most-used control.
    let y = f.bottom
    for (const id of ids) {
      const c = byId(id)
      // Pills would overflow a narrow rail, so a rail renders them icon-width.
      const w = Math.min(c.size.w, railW)
      y -= c.size.h
      ctls.push({ ...c, size: { w, h: c.size.h }, x: cx - w / 2, y })
      y -= gap
    }
  }
  place(primary, hand)
  place(secondary, hand === 'right' ? 'left' : 'right')

  const inset = railW + 12
  return { ctls, pad: { x: f.left + inset, y: f.top, w: f.right - f.left - inset * 2, h: f.bottom - f.top } }
}

/** D -- corner pods. Three per corner, settings demoted to the header band.
 *  Tightest reach; costs a header that differs by orientation. */
function splitPods(dev, hand) {
  const f = frame(dev)
  const gap = 8
  const primary = ['mic', 'keyboard', 'enter']
  const secondary = ['esc', 'tab', 'switcher']

  const ctls = []
  const place = (ids, side) => {
    // A pod is a tight triangle: two on the bottom row, one above the inner one.
    const first = byId(ids[0])
    const second = byId(ids[1])
    const third = byId(ids[2])
    const bottomY = f.bottom - Math.max(first.size.h, second.size.h)
    if (side === 'right') {
      const x1 = f.right - first.size.w
      const x2 = x1 - gap - second.size.w
      ctls.push({ ...first, x: x1, y: bottomY })
      ctls.push({ ...second, x: x2, y: bottomY + (first.size.h - second.size.h) })
      ctls.push({ ...third, x: f.right - third.size.w, y: bottomY - gap - third.size.h })
    } else {
      const x1 = f.left
      const x2 = x1 + first.size.w + gap
      ctls.push({ ...first, x: x1, y: bottomY })
      ctls.push({ ...second, x: x2, y: bottomY + (first.size.h - second.size.h) })
      ctls.push({ ...third, x: f.left, y: bottomY - gap - third.size.h })
    }
  }
  place(primary, hand)
  place(secondary, hand === 'right' ? 'left' : 'right')

  // Settings rides the header band with history/chat. Deliberately measured
  // like every other control, so the page reports honestly that it is out of
  // both thumb arcs -- that is the trade this option is making, not a bug.
  const s = byId('settings')
  ctls.push({ ...s, x: f.right - s.size.w, y: 2, size: { w: 30, h: 30 }, inHeader: true })

  return { ctls, pad: { x: f.left, y: f.top, w: f.right - f.left, h: f.bottom - f.top } }
}

const VARIANTS = [
  { id: 'stacked', name: 'Shipped (stacked)', fn: stacked,
    note: 'today: all eight in one corner' },
  { id: 'split-mirror', name: 'A — mirror split', fn: splitMirror,
    note: 'existing rows, opposite corners' },
  { id: 'split-fan', name: 'B — thumb fans', fn: splitFan,
    note: 'arc per corner, frequency-sorted' },
  { id: 'split-rails', name: 'C — edge rails', fn: splitRails,
    note: 'vertical stack down each edge' },
  { id: 'split-pods', name: 'D — corner pods', fn: splitPods,
    note: '3 per corner, settings to header' }
]

// ---------------------------------------------------------------------------
// Measurement. Reads the RENDERED nodes back out of the DOM -- not the numbers
// the variant functions produced. Scoring against its own inputs would only
// prove the arithmetic is self-consistent and would pass a layout whose CSS
// moved the boxes somewhere else entirely.
// ---------------------------------------------------------------------------

/** Worst-case distance from a thumb pivot to any point on a control's box.
 *  The FULL box, walked at 4px -- a centre-point check passes a control whose
 *  far half is out of reach, which is the same defect the hit-test rule in
 *  phone-remote/CLAUDE.md was written for. */
function farthestPoint(box, pivot) {
  let worst = 0
  for (let x = box.left; x <= box.right; x += 4) {
    for (let y = box.top; y <= box.bottom; y += 4) {
      const d = Math.hypot(x - pivot.x, y - pivot.y)
      if (d > worst) worst = d
    }
  }
  // Corners exactly, in case the 4px walk skipped them.
  for (const x of [box.left, box.right]) {
    for (const y of [box.top, box.bottom]) {
      const d = Math.hypot(x - pivot.x, y - pivot.y)
      if (d > worst) worst = d
    }
  }
  return worst
}

function rectsOverlap(a, b) {
  const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
  const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
  return x * y
}

/** Score one rendered deck. Returns the numbers the verdict pill and the
 *  failure overlay are both drawn from, so the picture cannot disagree with
 *  the words. */
function measure(deckEl, dev) {
  const deckBox = deckEl.getBoundingClientRect()
  const local = (r) => ({
    left: r.left - deckBox.left, right: r.right - deckBox.left,
    top: r.top - deckBox.top, bottom: r.bottom - deckBox.top,
    width: r.width, height: r.height
  })

  const padEl = deckEl.querySelector('.pad')
  const pad = padEl ? local(padEl.getBoundingClientRect()) : null

  // Pivots at the two bottom corners, inside the side safe-area inset -- a
  // thumb cannot pivot under the notch.
  const pivots = {
    left: { x: dev.safeSide, y: dev.h },
    right: { x: dev.w - dev.safeSide, y: dev.h }
  }

  const out = { far: [], hard: [], overlap: [], controls: [] }
  for (const el of deckEl.querySelectorAll('.ctl')) {
    const box = local(el.getBoundingClientRect())
    const id = el.dataset.ctl
    // Nearest thumb owns the control -- a control is only unreachable if BOTH
    // thumbs are too far, which is the whole point of a two-handed grip.
    const dL = farthestPoint(box, pivots.left)
    const dR = farthestPoint(box, pivots.right)
    const d = Math.min(dL, dR)
    const rec = { id, d: Math.round(d), box, header: el.dataset.header === '1' }
    out.controls.push(rec)
    // A control deliberately parked in the header (option D's settings) is
    // reported, but not counted as a reach failure -- it is a stated trade.
    if (!rec.header) {
      if (d > THUMB_REACH_HARD_PX) out.hard.push(rec)
      else if (d > THUMB_REACH_PX) out.far.push(rec)
    }
    if (pad && rectsOverlap(box, pad) > 0) out.overlap.push(rec)
  }
  out.padArea = pad ? Math.round((pad.width * pad.height) / 1000) : 0
  out.pad = pad
  return out
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

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

function buildDeck(dev, variant, hand) {
  const deck = document.createElement('div')
  deck.className = 'deck'

  // Side safe-area shading: rotated, the notch is a LEFT/RIGHT inset. Drawing
  // it on the top (where portrait puts it) would hide the one collision this
  // orientation actually has.
  if (dev.safeSide > 0 && state.show === 'safe') {
    for (const side of ['left', 'right']) {
      const s = document.createElement('div')
      s.className = 'safe'
      s.style.width = dev.safeSide + 'px'
      s.style[side] = '0'
      deck.appendChild(s)
    }
  }

  const hdr = document.createElement('div')
  hdr.className = 'hdr'
  hdr.style.top = '0'
  hdr.innerHTML = `<span class="dot"></span><b>MightyMouse</b><span class="sp"></span><span>⌘</span><span>⋯</span>`
  deck.appendChild(hdr)

  const { ctls, pad } = variant.fn(dev, hand)

  // Mirror claims its half before the pad is drawn, so "mirror on" shrinks the
  // pad here for the same reason it does in the app.
  let padBox = pad
  if (state.mirror) {
    const half = Math.round((pad.w - 18) * 0.52)
    const mir = document.createElement('div')
    mir.className = 'pad'
    mir.style.cssText = `left:${hand === 'right' ? pad.x : pad.x + pad.w - half}px;top:${pad.y}px;width:${half}px;height:${pad.h}px;background:#0f1319;border-color:#232c39`
    mir.innerHTML = '<div class="padHint">MIRROR</div>'
    deck.appendChild(mir)
    padBox = { ...pad, x: hand === 'right' ? pad.x + half + 18 : pad.x, w: pad.w - half - 18 }
  }

  const padEl = document.createElement('div')
  padEl.className = 'pad'
  padEl.style.cssText = `left:${padBox.x}px;top:${padBox.y}px;width:${padBox.w}px;height:${padBox.h}px`
  padEl.innerHTML = '<div class="padHint">DRAG · TAP · SCROLL</div>'
  deck.appendChild(padEl)

  if (state.show === 'arcs') {
    for (const side of ['left', 'right']) {
      const a = document.createElement('div')
      a.className = 'arc ' + side
      const px = side === 'left' ? dev.safeSide : dev.w - dev.safeSide
      a.style.cssText =
        `left:${px - THUMB_REACH_PX}px;top:${dev.h - THUMB_REACH_PX}px;` +
        `width:${THUMB_REACH_PX * 2}px;height:${THUMB_REACH_PX * 2}px`
      deck.appendChild(a)
    }
  }

  for (const c of ctls) {
    const el = document.createElement('div')
    el.className = `ctl ${c.kind}`
    el.dataset.ctl = c.id
    el.dataset.freq = c.freq
    if (c.inHeader) el.dataset.header = '1'
    el.style.cssText =
      `left:${Math.round(c.x)}px;top:${Math.round(c.y)}px;` +
      `width:${c.size.w}px;height:${c.size.h}px`
    el.textContent = c.label
    deck.appendChild(el)
  }

  const ovl = document.createElement('div')
  ovl.className = 'ovl'
  deck.appendChild(ovl)
  return deck
}

function render() {
  toggleRow($('tVariant'), ['all', ...VARIANTS.map((v) => v.id)], 'variant')
  toggleRow($('tHand'), ['right', 'left'], 'hand')
  toggleRow($('tMirror'), [false, true], 'mirror', { false: 'off', true: 'on' })
  toggleRow($('tShow'), ['arcs', 'safe', 'plain'], 'show')

  const grid = $('grid')
  grid.innerHTML = ''

  const variants = state.variant === 'all' ? VARIANTS : VARIANTS.filter((v) => v.id === state.variant)
  // One row per variant across every device, so a variant's behavior at 667px
  // and at 932px is one comparison rather than two page states.
  for (const variant of variants) {
    for (const dev of DEVICES) {
      const cell = document.createElement('div')
      cell.className = 'cell'
      cell.style.width = dev.w + 'px'

      const head = document.createElement('div')
      head.className = 'head'
      head.innerHTML =
        `<span class="name">${variant.name}</span>` +
        `<span class="dims">${dev.name} ${dev.w}×${dev.h}</span>` +
        `<span class="verdict v-wait">measuring…</span>`
      cell.appendChild(head)

      const phone = document.createElement('div')
      phone.className = 'phone'
      phone.style.cssText = `width:${dev.w}px;height:${dev.h}px`
      const deck = buildDeck(dev, variant, state.hand)
      phone.appendChild(deck)
      cell.appendChild(phone)

      const notes = document.createElement('div')
      notes.className = 'notes'
      cell.appendChild(notes)

      grid.appendChild(cell)

      // Measure after layout, from the real rendered rects.
      requestAnimationFrame(() => {
        const m = measure(deck, dev)
        const v = head.querySelector('.verdict')
        const bad = m.hard.length
        const warn = m.far.length
        const over = m.overlap.length
        if (bad) {
          v.className = 'verdict v-bad'
          v.textContent = `${bad} unreachable`
        } else if (warn) {
          v.className = 'verdict v-warn'
          v.textContent = `${warn} past ${THUMB_REACH_PX}px`
        } else {
          v.className = 'verdict v-ok'
          v.textContent = 'all in reach'
        }
        const worst = m.controls
          .filter((c) => !c.header)
          .sort((a, b) => b.d - a.d)
          .slice(0, 3)
          .map((c) => `${c.id} ${c.d}`)
          .join('  ')
        notes.textContent =
          `pad ${m.padArea}k px²   overlap ${over}   worst: ${worst}` +
          (m.controls.some((c) => c.header) ? '\nsettings in header (out of arc by design)' : '')

        // Draw the failures back over the deck from the SAME numbers the
        // verdict used, so the picture and the pill cannot drift apart.
        const ovl = deck.querySelector('.ovl')
        for (const rec of [...m.hard, ...m.far]) {
          const i = document.createElement('i')
          if (!m.hard.includes(rec)) i.className = 'far'
          i.style.cssText =
            `left:${rec.box.left}px;top:${rec.box.top}px;` +
            `width:${rec.box.width}px;height:${rec.box.height}px`
          ovl.appendChild(i)
        }
      })
    }
  }
}

render()
