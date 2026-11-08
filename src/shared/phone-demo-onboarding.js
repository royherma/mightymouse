/**
 * <mm-pairing-explainer> — the landing page's phone demo, played inside the
 * onboarding window.
 *
 * Same element, same beats, same timings, same captions: this subclasses
 * MMPhoneDemo and replaces exactly ONE thing — where the phone's screen comes
 * from.
 *
 * The landing page writes the real phone-remote bundle into the iframe and
 * measures it. Onboarding must not: useConnection.ts opens a real WebSocket
 * with a stored credential as soon as the app mounts, and doing that behind an
 * OS permission dialog is the failure this design exists to avoid. So boot()
 * writes a STATIC panel instead — the deck's own markup and class names, no
 * app code, no fetch, no socket.
 *
 * The paint is NOT redrawn: the consumer supplies the app's real stylesheet
 * (theme.css + skins/proII.css) via `MMPairingExplainer.deckCss`, so the panel
 * is pixel-styled by the same rules that style the live deck. Restyle the deck
 * and this follows. The only hand-kept part is the markup skeleton below.
 */

import { MMPhoneDemo, MIRROR_CSS, VOICE_CSS, SAFE_CSS } from './phone-demo-v3.js'

// Inline copies of the lucide icons the deck renders through React
// (lucide-react 1.17.0) — same viewBox/stroke contract, so theme.css sizes
// and colors them identically.
const icon = (size, sw, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
  `fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

const IC = {
  mic: icon(26, 2, '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>'),
  grid: icon(20, 2.25, '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),
  prev: icon(20, 2.25, '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'),
  settings: icon(20, 2.25, '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>'),
  keyboard: icon(18, 2, '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>'),
  chat: icon(19, 2.25, '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/>'),
  history: icon(19, 2.25, '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>')
}

// The live deck's portrait DOM, verbatim in structure and class names
// (TouchpadLayout.tsx / TouchpadControls.tsx, stacked right-handed proII —
// the exact configuration the landing demo boots). theme.css lays it out;
// nothing here carries geometry. data-orient is load-bearing: every rule in
// theme.css, SAFE_CSS and MIRROR_CSS keys on it.
const PANEL =
  `<div class="proRoot" data-orient="portrait" data-mirror="off" data-hand="right" data-skin="proII" data-theme="light">` +
  `<button class="brandWatermark" data-img="mark"><span>🐭</span></button>` +
  `<button class="chatBtn">${IC.chat}</button>` +
  `<button class="historyBtn">${IC.history}</button>` +
  `<div class="proCard">` +
  `<div class="proTouchpad"><div class="proHint"><div class="proHintTitle">DRAG · TAP · SCROLL</div></div></div>` +
  `<div class="proControlsCell">` +
  `<div class="proKeyGrid">` +
  `<div class="proKeyRow"><div class="proKeyPill" data-img="esc">Esc</div>` +
  `<div class="proKeyPill proKeyPillIcon" data-img="keyboard">${IC.keyboard}</div></div>` +
  `<div class="proKeyRow"><div class="proKeyPill" data-img="tab">Tab</div>` +
  `<div class="proKeyPill" data-img="enter">Enter</div></div>` +
  `</div>` +
  `<div class="proIconRow">` +
  `<button class="proMicBtn" data-img="mic">${IC.mic}</button>` +
  `<button class="proIconBtn" data-img="switcher">${IC.grid}</button>` +
  `<button class="proIconBtn" data-img="prev">${IC.prev}</button>` +
  `<button class="proIconBtn" data-img="settings">${IC.settings}</button>` +
  `</div></div></div></div>`

// Shims only — everything visual comes from the injected deck CSS.
const PANEL_CSS =
  `.mmNotchPatch{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}`

class MMPairingExplainer extends MMPhoneDemo {
  /** The app's real stylesheet text (theme.css + active skin css), supplied by
   *  the consumer — a string or a promise of one. Consumers resolve asset
   *  paths first (theme references /cork.webp). Never fetched here: where the
   *  file lives differs per surface (Vite inline import vs harness fetch). */
  static deckCss = ''

  /** CONFIG.THEME_TOKENS, supplied by the consumer. The live bundle injects
   *  these as CSS vars at runtime (main.tsx injectTheme) — fonts, toast and
   *  signal colors all resolve through them, so without them pills size wrong
   *  and the dictation toast loses its chrome. */
  static themeTokens = null

  /** Same key→var algorithm as the bundle's injectTheme(). */
  static tokenCss(tokens) {
    if (!tokens) return ''
    const vars = Object.entries(tokens)
      .map(([k, v]) => `--${k.replace(/([A-Z])/g, '-$1').toLowerCase()}:${v}`)
      .join(';')
    return `:root{${vars}}`
  }

  /** The onboarding column's height budget moves as step content comes and
   *  goes (warnings, extra buttons) — animate the lane/phone into the new size
   *  so the demo breathes instead of snapping. Landing keeps its static box. */
  connectedCallback() {
    super.connectedCallback()
    const s = document.createElement('style')
    s.textContent =
      '.wrapLane,.wrap{transition:height .45s cubic-bezier(.3,.9,.3,1),width .45s cubic-bezier(.3,.9,.3,1)}' +
      // Onboarding has its own step-progress chunks; the demo's beat ticks
      // right under them read as a second, unrelated progress bar.
      ':host([data-no-ticks]) .ticks{display:none}'
    this.shadowRoot?.appendChild(s)
  }

  /** Fit the HEIGHT the onboarding column gives us. The base sizes the phone
   *  from container WIDTH (container queries are inline-size only) capped at a
   *  520px constant — right for the landing hero, but a short onboarding strip
   *  crops the phone's bottom half. The parent's height is measured, not the
   *  host's: the host is content-sized, so reading it back would feed on
   *  itself and ratchet the phone smaller every fit. */
  fit() {
    const budget = this.parentElement?.clientHeight || 0
    if (budget > 140) {
      // 72 ≈ the stack's non-phone height: HUD lane (30) + caption strip (34) + slack.
      // Deferred + write-on-change: fit() runs inside a ResizeObserver on the
      // host, and a same-cycle layout write there fires Chrome's benign
      // "ResizeObserver loop" error event — which the dev overlay treats as
      // fatal. The rAF pushes the write into the next frame; the guard makes
      // it converge instead of ping-ponging.
      const v = `${budget - 72}px`
      if (this.style.getPropertyValue('--mm-max-h') !== v) {
        requestAnimationFrame(() => {
          this.style.setProperty('--mm-max-h', v)
          // Re-fit INSIDE the same frame as the write. super.fit() pins
          // lane.style.width from the lane's measured height, so running it
          // only before the write pins the pre-shrink height for good — the
          // phone then shrinks with --mm-max-h while the laptop, sized 74% of
          // that stale lane width, does not. That divergence is the bug.
          super.fit()
        })
      }
    }
    super.fit()
  }

  /**
   * Write the static panel where the base class writes the bundle.
   *
   * Same shape as MMPhoneDemo.boot — replace the iframe, write, wait for
   * .proRoot, remount the injected chrome — minus the two fetches and minus the
   * app's own <script>, so there is nothing here that could open a socket.
   */
  async boot() {
    // Drops the skin beats: buildTimeline maps over this list, so empty means
    // those beats never exist. Also means boot() is called exactly once (only a
    // skin beat re-boots), which is why it ignores the skin argument.
    this.skins = []
    // Replace rather than re-write, for the base class's reason: a second write
    // into a loaded iframe does not reliably re-mount.
    const fresh = /** @type {HTMLIFrameElement} */ (this.frame.cloneNode(false))
    this.frame.replaceWith(fresh)
    this.frame = fresh
    this.fit()
    await new Promise((r) => requestAnimationFrame(r))
    const deckCss = await MMPairingExplainer.deckCss
    if (!deckCss) console.warn('mm-pairing-explainer: deckCss not set — panel will render unstyled')
    const tokenCss = MMPairingExplainer.tokenCss(await MMPairingExplainer.themeTokens)
    const doc = this.frame.contentDocument
    if (!doc) return false
    doc.open()
    // Deck CSS first, tokens over it (the live app injects them as inline vars
    // on <html>, which beat the stylesheet), overrides last — the same
    // effective order the landing iframe gets.
    doc.write(
      `<!doctype html><meta charset="utf-8"><style>${deckCss}</style>` +
        `<style>${tokenCss}${PANEL_CSS}${SAFE_CSS}${MIRROR_CSS}${VOICE_CSS}</style>${PANEL}`
    )
    doc.close()
    const up = await this.waitForDeck()
    if (up) this.carveNotch()
    this.mirror = null
    this.voice = null
    this._downEl = null
    if (up) this.mountMirror()
    return up
  }

  /** The live pad carves a notch around the control cluster (useNotchPath
   *  measures the rows and clips the pad). A static panel can't run that hook,
   *  so approximate the carve from the OTHER side: paint the cluster's two
   *  row-boxes back in deck color over the pad. Anchored to the cluster (which
   *  never moves), so the carve stays put while the mirror slides the pad. */
  carveNotch() {
    const doc = this.frame.contentDocument
    const card = doc?.querySelector('.proCard')
    const cell = doc?.querySelector('.proControlsCell')
    const grid = doc?.querySelector('.proKeyGrid')
    const row = doc?.querySelector('.proIconRow')
    if (!card || !cell || !grid || !row) return
    const c = card.getBoundingClientRect()
    // fit() scales the iframe with a transform, so measured rects are in
    // visual px while the SVG draws in the card's own layout px — divide the
    // scale back out or the patch lands shrunk toward the top-left.
    const scale = c.width / card.offsetWidth || 1
    const PAD = 10 // breathing room the real carve leaves around the rows
    const R = 18
    const rect = (b) =>
      `<rect x="${((b.left - c.left) / scale - PAD).toFixed(1)}" y="${((b.top - c.top) / scale - PAD).toFixed(1)}" ` +
      `width="${((c.right - b.left) / scale + PAD).toFixed(1)}" height="${((c.bottom - b.top) / scale + PAD).toFixed(1)}" rx="${R}"/>`
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'mmNotchPatch')
    svg.innerHTML = `<g fill="var(--pro-card)">${rect(grid.getBoundingClientRect())}${rect(row.getBoundingClientRect())}</g>`
    card.insertBefore(svg, cell)
  }

  /** Optional beat selection: <mm-pairing-explainer beats="pair,drive,mirror">
   *  keeps only those; `drop="landscape"` keeps everything else. Omitted → all
   *  beats. Unknown names are ignored, so a typo degrades to "plays everything"
   *  rather than a blank box.
   *
   *  drop exists for Landscape specifically: onboarding's column is short and
   *  wide (~480x220), and reserving the square a rotating phone sweeps sizes
   *  the whole scene off that 220 — a 73px phone with 322px of dead width
   *  either side. Nothing else here needs the square. */
  buildTimeline() {
    super.buildTimeline()
    // data-* alias: React's typings reject an unknown bare prop on the cast
    // 'div' this element renders as, but allow any data-attribute.
    const list = (a) =>
      (this.getAttribute(a) || this.getAttribute(`data-${a}`) || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    const drop = list('drop')
    if (drop.length) {
      const kept = this.beats.filter((b) => !drop.includes(b.name.toLowerCase()))
      if (kept.length) this.retime(kept)
    }
    const want = list('beats')
    if (want.length) {
      const keep = this.beats.filter((b) => want.includes(b.name.toLowerCase()))
      if (keep.length) this.retime(keep)
    }
  }

  /** Adopt a beat subset as the timeline, closing the gaps the removed beats
   *  left. t0 is absolute, so a filtered list plays with dead air until every
   *  survivor is restamped. */
  retime(keep) {
    let t = 0
    for (const b of keep) {
      b.t0 = t
      t += b.ms
    }
    this.beats = keep
    this.total = t
    this.buildTicks()
  }

  /** Reduced motion holds the PAIRING frame by name — it is the one beat that
   *  explains the setup, which is the whole job of this surface. By name, not
   *  index: the shared timeline reorders without notice. */
  renderStill() {
    this.buildTimeline()
    const pair = this.beats.find((b) => b.name === 'Pair')
    if (!pair) return super.renderStill()
    this.wrapEl?.classList.remove('gone')
    pair.enter?.()
    pair.at(0.5)
    this.say(pair.cap)
  }
}

export { MMPairingExplainer }

if (!customElements.get('mm-pairing-explainer')) {
  customElements.define('mm-pairing-explainer', MMPairingExplainer)
}
