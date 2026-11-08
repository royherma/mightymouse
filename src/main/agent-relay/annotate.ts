/**
 * Draw arrows, circles, boxes and huge text onto a relay card's picture, so a
 * card says "look at THIS" instead of describing where to look.
 *
 * Rendered in Chromium, not by an image library: sharp costs 16 MB of native
 * libvips that is darwin-arm64-only and is NOT in electron-builder's
 * `asarUnpack` (a `.node` inside the asar works in dev and fails packaged), and
 * the zero-dependency rasterizers were both measured dead on this Mac —
 * `qlmanage -t` produced no file for an SVG and ffmpeg answers "no decoder
 * found for: svg". `nativeImage` has no compositing API either (dock.ts:153).
 * The app already ships a browser, so an offscreen window is the free route.
 */
import { BrowserWindow, nativeImage } from 'electron'
import { writeFileSync } from 'fs'
import { dirname, extname, join, basename } from 'path'
import { CONFIG } from '../../shared/config'

export type MarkShape = 'circle' | 'box' | 'arrow' | 'text'
export type MarkColor = 'red' | 'yellow' | 'green' | 'blue' | 'white'

export type Mark = {
  shape: MarkShape
  /** 0-1 fractional, origin top-left. Fractional so a mark survives the
   *  `sips -Z 1600` downscale every capture already goes through. */
  at: { x: number; y: number }
  /** circle/box only. Fraction of the image's LONG edge. */
  size?: number
  /** arrow only: the tail. Defaults to up-and-left of `at`. */
  from?: { x: number; y: number }
  /** Banner text, or a label pinned to a circle/box/arrow. */
  text?: string
  /** Named, never hex: an agent free-handing #FF0000 onto a red UI is the
   *  failure this prevents. These five all read on any screenshot. */
  color?: MarkColor
}

/** A bare string is the banner shorthand — the only mark an agent that has NOT
 *  seen the screenshot can place honestly. */
export type MarkInput = Mark | string

const PALETTE: Record<MarkColor, string> = {
  red: '#FF2D2D',
  yellow: '#FFD400',
  green: '#22C55E',
  blue: '#2D7DFF',
  white: '#FFFFFF'
}

/** Past six marks it is a diagram, not a "look at THIS". */
const MAX_MARKS = 6
const DEFAULT_SIZE = 0.12
/** Arrow tail offset when only a head was given: up-and-left reads as pointing
 *  INTO the target on a phone-sized card. */
const ARROW_TAIL = 0.15

const clamp01 = (n: number): boolean => n >= 0 && n <= 1

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Stroke and type scale off the LONG edge, so a mark is the same visual weight
 *  on a 1600px capture as on a phone-sized crop. */
const strokeFor = (long: number): number => Math.max(4, Math.round(long * 0.005))

function labelFragment(text: string, cx: number, cy: number, long: number, color: string): string {
  const size = Math.round(long * 0.028)
  const pad = Math.round(size * 0.4)
  // Approximate width from the glyph count: measuring text needs a layout pass,
  // and this only has to keep the plate behind the letters.
  const w = Math.round(text.length * size * 0.58) + pad * 2
  const h = size + pad * 2
  const x = Math.round(cx - w / 2)
  const y = Math.round(cy)
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.round(h * 0.25)}" ` +
    `fill="${color}" opacity="0.92"/>` +
    `<text x="${cx}" y="${y + pad + size * 0.8}" font-family="-apple-system, Helvetica, sans-serif" ` +
    `font-size="${size}" font-weight="700" fill="#000" text-anchor="middle">${esc(text)}</text>`
  )
}

function circleMark(m: Mark, w: number, h: number, long: number, color: string): string {
  const r = (m.size ?? DEFAULT_SIZE) * long
  const cx = m.at.x * w
  const cy = m.at.y * h
  const label = m.text ? labelFragment(m.text, cx, cy + r + strokeFor(long), long, color) : ''
  return (
    `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" fill="none" stroke="${color}" ` +
    `stroke-width="${strokeFor(long)}"/>${label}`
  )
}

function boxMark(m: Mark, w: number, h: number, long: number, color: string): string {
  const s = (m.size ?? DEFAULT_SIZE) * long
  const x = m.at.x * w - s
  const y = m.at.y * h - s / 2
  const label = m.text ? labelFragment(m.text, m.at.x * w, y + s + strokeFor(long), long, color) : ''
  return (
    `<rect x="${x}" y="${y}" width="${s * 2}" height="${s}" fill="none" stroke="${color}" ` +
    `stroke-width="${strokeFor(long)}" rx="${Math.round(long * 0.006)}"/>${label}`
  )
}

function arrowMark(m: Mark, w: number, h: number, long: number, color: string, id: number): string {
  const tail = m.from ?? { x: m.at.x - ARROW_TAIL, y: m.at.y - ARROW_TAIL }
  const sw = strokeFor(long)
  const label = m.text ? labelFragment(m.text, tail.x * w, tail.y * h - long * 0.05, long, color) : ''
  // One marker def per arrow: `fill` on a marker cannot inherit the line's
  // stroke, so two arrows of different colors sharing an id both take the first.
  return (
    `<defs><marker id="ah${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" ` +
    `markerHeight="5" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker></defs>` +
    `<line x1="${tail.x * w}" y1="${tail.y * h}" x2="${m.at.x * w}" y2="${m.at.y * h}" ` +
    `stroke="${color}" stroke-width="${sw}" stroke-linecap="round" marker-end="url(#ah${id})"/>${label}`
  )
}

function textMark(m: Mark, w: number, h: number, long: number, color: string): string {
  const size = Math.round(long * 0.045)
  const pad = Math.round(size * 0.45)
  const y = m.at.y * h - size / 2 - pad
  // Full-width plate rather than a fitted one: a banner is read at a glance on a
  // lock screen, and a ragged edge over a busy screenshot costs legibility.
  return (
    `<rect x="0" y="${y}" width="${w}" height="${size + pad * 2}" fill="${color}" opacity="0.92"/>` +
    `<text x="${w / 2}" y="${y + pad + size * 0.82}" font-family="-apple-system, Helvetica, sans-serif" ` +
    `font-size="${size}" font-weight="800" fill="#000" text-anchor="middle">${esc(m.text ?? '')}</text>`
  )
}

/** String shorthand -> a top banner. Anything else passes through untouched. */
function normalize(input: MarkInput): Mark {
  if (typeof input !== 'string') return input
  return { shape: 'text', at: { x: 0.5, y: 0.06 }, text: input }
}

/** Drops rather than clamps an out-of-range coordinate: a clamped guess is a
 *  confident lie, and an agent that fired `capture: true` has not seen the
 *  screen it is annotating. */
function usable(m: Mark): boolean {
  if (!m || !m.at || !clamp01(m.at.x) || !clamp01(m.at.y)) return false
  if (m.from && (!clamp01(m.from.x) || !clamp01(m.from.y))) return false
  if (m.shape === 'text' && !m.text) return false
  return true
}

export function buildSvg(marks: MarkInput[], w: number, h: number): string {
  const long = Math.max(w, h)
  const body = marks
    .map(normalize)
    .filter(usable)
    .slice(0, MAX_MARKS)
    .map((m, i) => {
      const color = PALETTE[m.color ?? 'red'] ?? PALETTE.red
      if (m.shape === 'circle') return circleMark(m, w, h, long, color)
      if (m.shape === 'box') return boxMark(m, w, h, long, color)
      if (m.shape === 'arrow') return arrowMark(m, w, h, long, color, i)
      if (m.shape === 'text') return textMark(m, w, h, long, color)
      return ''
    })
    .join('')
  if (!body) return ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`
}

/** Sentinels the page writes into document.title. Distinct strings so a failed
 *  decode is a fast fallback rather than a wait for the timeout. */
const READY = 'mm-annotate-ready'
const FAILED = 'mm-annotate-failed'
/** Paint budget. A local data: URL that has not painted in 3s is broken, not
 *  slow, and the caller gets the un-annotated picture. */
const PAINT_TIMEOUT_MS = 3000

/** Resolves once both images have DECODED and a frame has been presented.
 *  `loadURL` resolves too early -- capturing on its promise produced a fully
 *  black JPEG (measured 2026-08-22, not assumed). */
function waitForPaint(win: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      win.webContents.off('page-title-updated', onTitle)
      resolve(ok)
    }
    const onTitle = (_e: unknown, title: string): void => {
      if (title === READY) finish(true)
      else if (title === FAILED) finish(false)
    }
    const timer = setTimeout(() => finish(false), PAINT_TIMEOUT_MS)
    win.webContents.on('page-title-updated', onTitle)
    // The title can land before the listener attaches on a warm window.
    if (win.getTitle() === READY) finish(true)
  })
}

/** One hidden window, reused. Modelled on `sound-window.ts` — a persistent
 *  `show:false` BrowserWindow that main-process code drives. Reused rather than
 *  per-call because the spin-up, not the paint, is the cost. */
let annotator: BrowserWindow | null = null

function annotatorWindow(w: number, h: number): BrowserWindow {
  if (annotator && !annotator.isDestroyed()) {
    annotator.setBounds({ x: 0, y: 0, width: w, height: h })
    return annotator
  }
  annotator = new BrowserWindow({
    width: w,
    height: h,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    // zoomFactor 1 pins the capture to CSS pixels. capturePage otherwise returns
    // at the display's scale factor, and a Retina Mac silently handed back a
    // 3200x2068 file for a 1600x1034 source -- undoing item 3's whole point.
    useContentSize: true,
    // No preload and no node: this window renders a data: URL built here and
    // talks to nothing. Keeping it inert means an agent-supplied string can
    // never reach an API. `javascript` stays ON only because the page has to
    // signal that both <img>s have DECODED -- loadURL resolves before that, and
    // capturing early produced a fully black frame (measured, not assumed).
    // `offscreen` is load-bearing for GEOMETRY, not just for staying hidden: an
    // ordinary window's content area is clamped to the physical display, so a
    // 1600x1034 source captured back at 1600x974 with the bottom 60px missing.
    // An offscreen window renders the full requested size regardless of screen.
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, zoomFactor: 1 }
  })
  annotator.on('closed', () => {
    annotator = null
  })
  return annotator
}

/** The page: the capture at natural size with the SVG laid exactly over it.
 *  Both are inlined as data: URIs, so this never touches the `media://` root
 *  allowlist and an `image_path` anywhere on disk works. */
function pageHtml(imgDataUrl: string, svg: string, w: number, h: number): string {
  const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  // `document.title` is the ready signal: it needs no preload, no IPC and no
  // node integration, and main can await it. decode() rather than onload
  // because a decoded-but-unpainted image still captures black.
  return (
    `<html><body style="margin:0;padding:0;background:#000;width:${w}px;height:${h}px;overflow:hidden">` +
    `<img id="a" src="${imgDataUrl}" width="${w}" height="${h}" style="position:absolute;top:0;left:0">` +
    `<img id="b" src="${svgUrl}" width="${w}" height="${h}" style="position:absolute;top:0;left:0">` +
    `<script>Promise.all([a.decode(),b.decode()])` +
    `.then(()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{document.title='${READY}'})))` +
    `.catch(()=>{document.title='${FAILED}'})</script>` +
    `</body></html>`
  )
}

/**
 * Draw `marks` onto `imagePath` and return the NEW file's path.
 *
 * Returns the ORIGINAL path on every failure — a bad coordinate, a window that
 * won't paint, an unreadable file. An annotation is a nicety; losing the whole
 * picture over one is the worse outcome, and the card degrades one step at a
 * time (annotated -> plain picture -> text only).
 */
export async function annotate(imagePath: string, marks: MarkInput[]): Promise<string> {
  if (!marks || marks.length === 0) return imagePath
  try {
    const source = nativeImage.createFromPath(imagePath)
    if (source.isEmpty()) return imagePath
    const { width: w, height: h } = source.getSize()
    if (!w || !h) return imagePath

    const svg = buildSvg(marks, w, h)
    // Every mark was dropped by the §6d guard — nothing to draw, so don't pay
    // for a paint or hand back a file that differs only by re-encoding.
    if (!svg) return imagePath

    const win = annotatorWindow(w, h)
    // A reused window still holds the PREVIOUS render's READY title, which the
    // warm-window check below would read as "this one is already painted".
    win.setTitle('')
    await win.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(source.toDataURL(), svg, w, h))
    )
    if (!(await waitForPaint(win))) return imagePath
    // No rect: an explicit one is silently ignored when it exceeds the content
    // area, which is how a mis-sized window returned a black frame rather than
    // an error. Capture whatever painted, then normalise the size below.
    let shot = await win.webContents.capturePage()
    if (shot.isEmpty()) return imagePath
    // capturePage honours the display scale factor, so a Retina Mac returns 2x
    // the requested rect. Resize back rather than trust the geometry.
    const got = shot.getSize()
    if (got.width !== w || got.height !== h) shot = shot.resize({ width: w, height: h })

    const out = join(
      dirname(imagePath),
      `${basename(imagePath, extname(imagePath))}-marked.jpg`
    )
    writeFileSync(out, shot.toJPEG(CONFIG.SCREENSHOT_JPG_QUALITY))
    return out
  } catch (err) {
    console.error('[agent-relay] annotate failed, sending the plain picture:', err)
    return imagePath
  }
}
