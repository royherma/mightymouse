import { THEME_TOKENS } from './config/theme-tokens'

export type InkTool = 'pen' | 'highlighter' | 'pointer'
export type InkStrokeTool = Exclude<InkTool, 'pointer'>
export type InkSurface = 'screen' | 'blank'
export type InkSendTarget = 'copy' | 'open'

export const INK_COLORS = [
  'redRgb',
  'orangeRgb',
  'hideoutAmberRgb',
  'greenRgb',
  'blueRgb',
  'accentSmartRgb',
  'shadowRgb',
  'whiteRgb'
] as const
export type InkColor = (typeof INK_COLORS)[number]

export const INK_COLOR_LABEL: Record<InkColor, string> = {
  redRgb: 'Red',
  orangeRgb: 'Orange',
  hideoutAmberRgb: 'Yellow',
  greenRgb: 'Green',
  blueRgb: 'Blue',
  accentSmartRgb: 'Purple',
  shadowRgb: 'Black',
  whiteRgb: 'White'
}

/** Line width as a share of the screen's width, so a stroke looks the same on the phone and the Mac. */
export const INK_SIZES = [0.0018, 0.0035, 0.007, 0.014] as const
const MIN_SIZE = 0.0005
const MAX_SIZE = 0.06
const HIGHLIGHTER = { widthScale: 4, alpha: 0.35 }

export const INK_POINTER_RGB = THEME_TOKENS.redRgb
export const INK_BLANK_FILL = THEME_TOKENS.surfaceSolid
export const INK_MAX_STROKES = 300
export const INK_MAX_POINTS = 4000

/** Points are flat [x0, y0, x1, y1, …], each 0..1 of the Mac's screen. */
export interface InkStroke {
  id: string
  tool: InkStrokeTool
  color: InkColor
  size: number
  pts: number[]
}

export interface InkScene {
  surface: InkSurface
  strokes: InkStroke[]
}

export type InkOp =
  | { op: 'snapshot' }
  | { op: 'scene'; scene: InkScene }
  | { op: 'points'; id: string; tool: InkStrokeTool; color: InkColor; size: number; pts: number[] }
  | { op: 'pointer'; nx: number; ny: number }
  | { op: 'pointerOff' }
  | { op: 'undo' }
  | { op: 'clear' }
  | { op: 'close' }

export const EMPTY_INK_SCENE: InkScene = { surface: 'screen', strokes: [] }

const isUnit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
const isSurface = (s: unknown): s is InkSurface => s === 'screen' || s === 'blank'
const isStrokeTool = (t: unknown): t is InkStrokeTool => t === 'pen' || t === 'highlighter'
const isColor = (c: unknown): c is InkColor => (INK_COLORS as readonly unknown[]).includes(c)
const isSize = (n: unknown): n is number => typeof n === 'number' && n >= MIN_SIZE && n <= MAX_SIZE
const isId = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 64
const isPoints = (p: unknown): p is number[] =>
  Array.isArray(p) && p.length % 2 === 0 && p.length <= INK_MAX_POINTS * 2 && p.every(isUnit)

export const isInkSendTarget = (t: unknown): t is InkSendTarget => t === 'copy' || t === 'open'

function parseStroke(raw: unknown): InkStroke | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (
    !isId(s.id) ||
    !isStrokeTool(s.tool) ||
    !isColor(s.color) ||
    !isSize(s.size) ||
    !isPoints(s.pts)
  )
    return null
  return { id: s.id, tool: s.tool, color: s.color, size: s.size, pts: s.pts }
}

/** Wire input is untrusted: anything that is not exactly an InkOp comes back null. */
export function parseInkOp(raw: unknown): InkOp | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  switch (o.op) {
    case 'scene': {
      const scene = o.scene as Record<string, unknown> | null
      if (!scene || !isSurface(scene.surface) || !Array.isArray(scene.strokes)) return null
      if (scene.strokes.length > INK_MAX_STROKES) return null
      const strokes = scene.strokes.map(parseStroke)
      if (strokes.some((s) => s === null)) return null
      return { op: 'scene', scene: { surface: scene.surface, strokes: strokes as InkStroke[] } }
    }
    case 'points': {
      const stroke = parseStroke(o)
      return stroke ? { op: 'points', ...stroke } : null
    }
    case 'pointer':
      return isUnit(o.nx) && isUnit(o.ny) ? { op: 'pointer', nx: o.nx, ny: o.ny } : null
    case 'snapshot':
    case 'pointerOff':
    case 'undo':
    case 'clear':
    case 'close':
      return { op: o.op }
    default:
      return null
  }
}

export function applyInkOp(scene: InkScene, op: InkOp): InkScene {
  switch (op.op) {
    case 'scene':
      return op.scene
    case 'points': {
      const last = scene.strokes[scene.strokes.length - 1]
      if (last && last.id === op.id) {
        if (last.pts.length >= INK_MAX_POINTS * 2) return scene
        const grown = { ...last, pts: last.pts.concat(op.pts) }
        return { ...scene, strokes: [...scene.strokes.slice(0, -1), grown] }
      }
      const { id, tool, color, size, pts } = op
      return {
        ...scene,
        strokes: [...scene.strokes, { id, tool, color, size, pts }].slice(-INK_MAX_STROKES)
      }
    }
    case 'undo':
      return { ...scene, strokes: scene.strokes.slice(0, -1) }
    case 'clear':
      return { ...scene, strokes: [] }
    case 'close':
      return EMPTY_INK_SCENE
    default:
      return scene
  }
}

export function inkRgba(color: InkColor, alpha: number): string {
  return `rgba(${THEME_TOKENS[color]}, ${alpha})`
}

export function inkLineWidth(tool: InkStrokeTool, size: number, w: number): number {
  return Math.max(1.5, size * w * (tool === 'highlighter' ? HIGHLIGHTER.widthScale : 1))
}

export function drawInkStroke(
  ctx: CanvasRenderingContext2D,
  stroke: InkStroke,
  w: number,
  h: number
): void {
  const p = stroke.pts
  if (p.length < 2) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = inkRgba(stroke.color, stroke.tool === 'highlighter' ? HIGHLIGHTER.alpha : 1)
  ctx.fillStyle = ctx.strokeStyle
  ctx.lineWidth = inkLineWidth(stroke.tool, stroke.size, w)
  ctx.beginPath()
  if (p.length === 2) {
    ctx.arc(p[0] * w, p[1] * h, ctx.lineWidth / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    return
  }
  ctx.moveTo(p[0] * w, p[1] * h)
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = ((p[i] + p[i + 2]) / 2) * w
    const my = ((p[i + 1] + p[i + 3]) / 2) * h
    ctx.quadraticCurveTo(p[i] * w, p[i + 1] * h, mx, my)
  }
  ctx.lineTo(p[p.length - 2] * w, p[p.length - 1] * h)
  ctx.stroke()
  ctx.restore()
}

/** `backdrop` is drawn under the ink on the screen surface; blank paints the page instead. */
export function drawInkScene(
  ctx: CanvasRenderingContext2D,
  scene: InkScene,
  w: number,
  h: number,
  backdrop?: CanvasImageSource | null
): void {
  ctx.clearRect(0, 0, w, h)
  if (scene.surface === 'blank') {
    ctx.fillStyle = INK_BLANK_FILL
    ctx.fillRect(0, 0, w, h)
  } else if (backdrop) {
    ctx.drawImage(backdrop, 0, 0, w, h)
  }
  for (const s of scene.strokes) drawInkStroke(ctx, s, w, h)
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** The largest box of aspect aw:ah that fits centred inside `box`. */
export function fitBox(box: Box, aw: number, ah: number): Box | null {
  if (!aw || !ah || box.width <= 0 || box.height <= 0) return null
  const aspect = aw / ah
  if (aspect > box.width / box.height) {
    const height = box.width / aspect
    return { left: box.left, top: box.top + (box.height - height) / 2, width: box.width, height }
  }
  const width = box.height * aspect
  return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height }
}
