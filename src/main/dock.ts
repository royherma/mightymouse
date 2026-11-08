/**
 * Dock icon visibility (macOS).
 *
 * MightyMouse ships as a tray-first app and hid its Dock icon unconditionally at
 * startup. This module makes that a user pref instead.
 *
 * Why it can toggle live: the bundle sets NO `LSUIElement` in its Info.plist, so
 * the Dock icon is hidden purely at runtime by `app.dock.hide()`. macOS honors
 * show/hide any time — no rebuild, no relaunch. If `LSUIElement` is ever added to
 * electron-builder.yml, that stops being true and this becomes restart-only.
 *
 * Trade-off worth knowing: a visible Dock icon promotes the app from accessory to
 * regular — it gains its own menu bar and joins ⌘-Tab. That's macOS behavior, not
 * something we opt into separately. The tray item is unaffected either way.
 *
 * Lives in its own module (not index.ts) so `ipc/settings.ts` can import it
 * without the ipc/ → index.ts → ipc/ cycle that a re-export would create.
 */
import { app, nativeImage } from 'electron'
import { PREFS } from './store/prefs'
import { IS_DEV, IS_DEVTEST, devLog } from '../shared/env'
import { CONFIG } from '../shared/config'
import iconAsset from '../../resources/icon.png?asset'

const isMac = process.platform === 'darwin'
let dockPolicyGeneration = 0
let requestedDockVisible = true

/** Rendered size of the composited dev icon. 512 is the largest size the Dock uses. */
const DEV_ICON_SIZE = 512
/** Badge diameter + edge inset, as a fraction of DEV_ICON_SIZE. */
const BADGE_SIZE_RATIO = 0.34
const BADGE_INSET_RATIO = 0.02

/**
 * Build the dev Dock icon: the real app icon with a "D" badge in the corner, so a
 * dev build is instantly distinguishable from an installed prod one in the Dock.
 *
 * Why this exists at all: an unpackaged dev build runs from Electron.app, so macOS
 * shows Electron's generic atom icon — `build/icon.icns` is only applied when
 * electron-builder packages the app. `dock.setIcon()` is the runtime override.
 *
 * Everything is drawn into a raw BGRA bitmap by hand. Two dead ends ruled this in:
 * sharp is a native module whose dynamic .node require can't be statically bundled
 * by electron-vite's rollup (importing it crashes main on load), and nativeImage
 * silently refuses to rasterize SVG data URLs — createFromDataURL returns an EMPTY
 * image, so the badge vanishes with no error. Hand-drawing needs neither.
 *
 * Returns null on any failure — a cosmetic dev nicety must never break startup.
 */
function buildDevIcon(): Electron.NativeImage | null {
  try {
    const base = nativeImage.createFromPath(iconAsset)
    if (base.isEmpty()) return null

    const d = Math.round(DEV_ICON_SIZE * BADGE_SIZE_RATIO)
    const inset = Math.round(DEV_ICON_SIZE * BADGE_INSET_RATIO)
    const badge = drawBadge(d)

    // Bottom-right corner, mirroring how macOS badges its own Dock icons.
    const merged = nativeImage
      .createFromBuffer(base.toPNG())
      .resize({ width: DEV_ICON_SIZE, height: DEV_ICON_SIZE })
    const composited = nativeImage.createFromBuffer(
      compositeCorner(merged, badge, DEV_ICON_SIZE - d - inset, DEV_ICON_SIZE - d - inset)
    )
    return composited.isEmpty() ? null : composited
  } catch (err) {
    devLog.warn('Failed to build dev dock icon:', err)
    return null
  }
}

/** Badge palette. Literal, not THEME_TOKENS: composited outside the renderer (no
 *  CSS vars), and it must stay legible against any wallpaper behind the Dock. */
const BADGE_FILL = IS_DEVTEST ? { b: 235, g: 111, r: 47 } : { b: 77, g: 72, r: 229 } // red #E5484D, Dev Test blue #2F6FEB, BGRA
const BADGE_INK = { b: 255, g: 255, r: 255 }

/**
 * Draw the "D" badge — a white-ringed red disc with a bold D — as a BGRA bitmap.
 * Coverage is sampled per-pixel so the disc and glyph get antialiased edges rather
 * than the jaggies a plain inside/outside test would leave at Dock size.
 */
function drawBadge(size: number): Electron.NativeImage {
  const buf = Buffer.alloc(size * size * 4)
  const c = size / 2
  const rOuter = c * 0.94
  const rInner = rOuter - size * 0.06 // white ring thickness

  // D geometry: a stem plus a bowl, expressed as fractions of the badge box.
  const stemX0 = size * 0.36
  const stemX1 = size * 0.45
  const top = size * 0.3
  const bot = size * 0.7
  const bowlR = (bot - top) / 2
  const bowlCx = stemX1
  const bowlCy = (top + bot) / 2
  const bowlInnerR = bowlR - size * 0.09

  const px = (x: number, y: number): number => (y * size + x) * 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c
      const dy = y + 0.5 - c
      const dist = Math.hypot(dx, dy)
      // Antialias by fading over a 1px band at each edge.
      const disc = clamp01(rOuter - dist)
      if (disc <= 0) continue

      const inRing = clamp01(dist - rInner)
      const inD = glyphCoverage(x + 0.5, y + 0.5, {
        stemX0, stemX1, top, bot, bowlCx, bowlCy, bowlR, bowlInnerR
      })
      // White wins where the ring or the glyph is; red fills the rest of the disc.
      const white = Math.max(inRing, inD)
      const i = px(x, y)
      buf[i] = Math.round(BADGE_INK.b * white + BADGE_FILL.b * (1 - white))
      buf[i + 1] = Math.round(BADGE_INK.g * white + BADGE_FILL.g * (1 - white))
      buf[i + 2] = Math.round(BADGE_INK.r * white + BADGE_FILL.r * (1 - white))
      buf[i + 3] = Math.round(255 * disc)
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/** Antialiased coverage of the "D" glyph at a point: 1 inside, 0 outside, fading between. */
function glyphCoverage(
  x: number,
  y: number,
  g: {
    stemX0: number; stemX1: number; top: number; bot: number
    bowlCx: number; bowlCy: number; bowlR: number; bowlInnerR: number
  }
): number {
  if (y < g.top - 1 || y > g.bot + 1) return 0
  // Vertical stem of the D.
  const stem = Math.min(clamp01(x - g.stemX0), clamp01(g.stemX1 - x), clamp01(y - g.top), clamp01(g.bot - y))
  // Bowl: the filled half-annulus to the right of the stem.
  const dist = Math.hypot(x - g.bowlCx, y - g.bowlCy)
  const bowl = Math.min(
    clamp01(g.bowlR - dist),
    clamp01(dist - g.bowlInnerR),
    clamp01(x - g.stemX1 + 1)
  )
  return Math.max(stem, bowl)
}

export function devTrayIcon(template: Electron.NativeImage): Electron.NativeImage {
  if (!IS_DEV) return template
  try {
    const { width, height } = template.getSize()
    const out = nativeImage.createEmpty()
    for (const scaleFactor of [1, 2]) {
      const w = width * scaleFactor
      const h = height * scaleFactor
      const bmp = template.toBitmap({ scaleFactor })
      if (bmp.length !== w * h * 4) continue
      stampTrayD(bmp, w, h, scaleFactor)
      const png = nativeImage.createFromBitmap(bmp, { width: w, height: h }).toPNG()
      out.addRepresentation({ scaleFactor, width: w, height: h, buffer: png })
    }
    if (out.isEmpty()) return template
    out.setTemplateImage(template.isTemplateImage())
    return out
  } catch (err) {
    devLog.warn('Failed to build dev tray icon:', err)
    return template
  }
}

function stampTrayD(bmp: Buffer, w: number, h: number, gap: number): void {
  const s = Math.round(Math.min(w, h) * 0.5)
  const x0 = w - s
  const y0 = h - s
  const g = {
    stemX0: x0 + s * 0.16, stemX1: x0 + s * 0.4, top: y0 + s * 0.06, bot: y0 + s * 0.94,
    bowlCx: x0 + s * 0.4, bowlCy: y0 + s * 0.5, bowlR: s * 0.44, bowlInnerR: s * 0.2
  }
  for (let y = y0 - gap; y < h; y++) {
    for (let x = x0 - gap; x < w; x++) {
      const i = (y * w + x) * 4
      const ink = glyphCoverage(x + 0.5, y + 0.5, g)
      bmp[i] = bmp[i + 1] = bmp[i + 2] = 0
      bmp[i + 3] = Math.round(255 * ink)
    }
  }
}

/** Map a signed distance (in px) to 0..1 coverage across a 1px antialiasing band. */
function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v
}

/**
 * Stamp `overlay` onto `base` at (x, y) by alpha-blending raw BGRA bitmaps.
 * nativeImage has no compositing API, and this is a one-shot 512×512 blend at
 * startup, so a manual loop is simpler than dragging in an image library.
 */
function compositeCorner(
  base: Electron.NativeImage,
  overlay: Electron.NativeImage,
  x: number,
  y: number
): Buffer {
  const bw = base.getSize().width
  const canvas = base.toBitmap() // BGRA, 4 bytes/px
  const o = overlay.getSize()
  const ob = overlay.toBitmap()

  for (let row = 0; row < o.height; row++) {
    for (let col = 0; col < o.width; col++) {
      const si = (row * o.width + col) * 4
      const alpha = ob[si + 3] / 255
      if (alpha === 0) continue
      const di = ((y + row) * bw + (x + col)) * 4
      if (di < 0 || di + 3 >= canvas.length) continue
      for (let ch = 0; ch < 3; ch++) {
        canvas[di + ch] = Math.round(ob[si + ch] * alpha + canvas[di + ch] * (1 - alpha))
      }
      canvas[di + 3] = Math.max(canvas[di + 3], ob[si + 3])
    }
  }
  return nativeImage.createFromBitmap(canvas, base.getSize()).toPNG()
}

/**
 * Give the dev build a real-looking Dock icon (app icon + "D" badge) instead of
 * Electron's generic atom. No-op in a packaged build, where electron-builder has
 * already baked in the correct icon.
 */
export function applyDevDockIcon(): void {
  if (!isMac || !app.dock || !IS_DEV) return
  const image = buildDevIcon()
  if (!image) return
  app.dock.setIcon(image)
  // The Dock tooltip/app-switcher name still comes from Electron.app's plist; this
  // at least labels the About menu correctly while running unpackaged.
  app.setName(`${CONFIG.APP_NAME} (dev)`)
}

/**
 * Apply the Dock-icon pref to the running app. Safe to call any time.
 * Pass `visible` to force a state (e.g. a deep link raising an accessory app to
 * the front); omit it to follow the stored pref.
 */
export function applyDockIcon(visible = PREFS.getDockIcon()): void {
  const generation = ++dockPolicyGeneration
  requestedDockVisible = visible
  if (!isMac || !app.dock) return
  app.setActivationPolicy(visible ? 'regular' : 'accessory')
  if (!visible) {
    app.dock.hide()
    devLog.log(`Dock icon: requested hidden, actual=${app.dock.isVisible()}`)
    return
  }

  void app.dock.show().then(() => {
    if (generation !== dockPolicyGeneration) {
      applyDockIcon(requestedDockVisible)
      return
    }
    const dockVisible = app.dock?.isVisible() ?? false
    devLog.log(`Dock icon: requested visible, actual=${dockVisible}`)
    if (!dockVisible) devLog.warn('Dock icon: macOS did not show the icon')
  }).catch((err: unknown) => {
    if (generation !== dockPolicyGeneration) {
      applyDockIcon(requestedDockVisible)
      return
    }
    devLog.warn('Dock icon: macOS failed to show the icon', err)
  })
}
