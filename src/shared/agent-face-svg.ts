/** The `AgentFace` mark as a standalone SVG document, for surfaces with no DOM.
 *
 *  `agent-face-view.tsx` is the same picture as React, and stays the canonical
 *  one -- this exists because two consumers cannot mount a component: the iOS
 *  notification avatar (rasterized to PNG on the Mac, sent as bytes) and
 *  anything else that needs a file rather than an element. Both files draw from
 *  `avatarFor()`, so a face is identical wherever it appears.
 *
 *  The colours differ from the React path by necessity. `AGENT_FACE_COLORS`
 *  holds `var(--accent)`-style tokens, which resolve against a stylesheet that
 *  does not exist in a bare SVG handed to `sips` -- an unresolved `var()` paints
 *  nothing, so the face would rasterize as two white bars on transparency.
 *  `FACE_HEX` below maps each token to its literal from `CONFIG.THEME_TOKENS`.
 */

import { avatarFor, AGENT_FACE_COLORS, type AgentShape } from './agent-face'
import { CONFIG } from './config'

const T = CONFIG.THEME_TOKENS

/** Keyed by the token strings in `AGENT_FACE_COLORS`, in that same order. The
 *  two literals there carry no token and pass through unchanged. */
const FACE_HEX: Record<string, string> = {
  'var(--accent)': T.accent,
  'var(--orange)': T.orange,
  'var(--yellow)': T.yellow,
  'var(--violet)': T.violet,
  'var(--blue)': T.blue,
  'var(--cyan)': T.cyan,
  'var(--rose)': T.rose
}

/** SVG 1.1 has no `rgba()` -- a fill written that way is INVALID, and `sips`
 *  drops the whole declaration rather than erroring, so the shape rasterizes as
 *  two floating white bars on transparency. Every value in `THEME_TOKENS` is
 *  `rgba()`, so this conversion is not an edge case, it is the normal path.
 *  Alpha is discarded: every face colour is fully opaque. */
function toSvgColor(value: string): string {
  const m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/)
  if (!m) return value
  return `rgb(${Math.round(+m[1])}, ${Math.round(+m[2])}, ${Math.round(+m[3])})`
}

/** A token with no mapping would paint nothing, so fall back to the accent
 *  rather than emit a `var()` the rasterizer silently drops. */
export function faceColorLiteral(color: string): string {
  const literal = color.startsWith('var(') ? (FACE_HEX[color] ?? T.accent) : color
  return toSvgColor(literal)
}

/** Same geometry as `ShapeGeom` in `agent-face-view.tsx`, on the same 32x32
 *  viewBox. Kept in step by `agent-face-svg.test.ts`. */
function shapeMarkup(shape: AgentShape, fill: string): string {
  switch (shape) {
    case 'circle':
      return `<circle cx="16" cy="16" r="15" fill="${fill}"/>`
    case 'squircle':
      return `<rect x="1" y="1" width="30" height="30" rx="10" fill="${fill}"/>`
    case 'quatrefoil':
      return (
        `<circle cx="16" cy="9.5" r="8.5" fill="${fill}"/>` +
        `<circle cx="22.5" cy="16" r="8.5" fill="${fill}"/>` +
        `<circle cx="16" cy="22.5" r="8.5" fill="${fill}"/>` +
        `<circle cx="9.5" cy="16" r="8.5" fill="${fill}"/>`
      )
    case 'hexagon':
      return `<polygon points="16,1.5 29.5,9 29.5,23 16,30.5 2.5,23 2.5,9" fill="${fill}"/>`
    case 'diamond':
      return `<polygon points="16,1.5 30.5,16 16,30.5 1.5,16" fill="${fill}"/>`
  }
}

/** Coloured shape, white eyes, transparent ground -- the same read as the React
 *  mark, because that contrast IS the identity. A first attempt drew the shape
 *  as a pale inset on an opaque plate of its own colour, to survive iOS's
 *  circular crop; rasterized, the light colours (yellow, cyan) lost the shape
 *  almost entirely. The crop is the lesser cost: it rounds a hexagon's corners,
 *  while the colour still separates the face at a glance. */
export function agentFaceSvg(id: string, size = 128): string {
  const { shape, color } = avatarFor(id)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">` +
    `${shapeMarkup(shape, faceColorLiteral(color))}` +
    `<rect x="11.2" y="11.5" width="3" height="7" rx="1.5" fill="white"/>` +
    `<rect x="17.8" y="11.5" width="3" height="7" rx="1.5" fill="white"/>` +
    `</svg>`
  )
}

/** Exported so a test can assert every token in the palette has a literal. */
export const FACE_COLOR_TOKENS = AGENT_FACE_COLORS
