// ── Mouse frame sheet ─────────────────────────────────────────────────────────
// 20 hand-art mouse poses (Apple-style 3D emoji), sliced from a 5×4 sheet into
// transparent PNGs. Named by VIEWING ANGLE — the direction the mouse is FACING
// relative to the viewer. Used by SnailTrail to make the mouse "look" where it's
// crawling, and available in the Playground for free-form direction tests.
//
// Why a glob + typed map: one import that Vite turns into hashed asset URLs, with a
// compile-checked union of frame names so a typo (`fornt`) can't slip through. Add
// or rename a PNG → update MouseFrame + the map; the typechecker flags any caller.

// All 20 frame names, grouped the way the source sheet lays them out.
export type MouseFrame =
  // ground plane (horizontal headings) — what a left/right crawl uses
  | 'front'
  | 'front-left'
  | 'left'
  | 'back-left'
  | 'back'
  | 'back-right'
  | 'right'
  | 'front-right'
  // poles + tilted views — for richer/vertical motion + general tests
  | 'top'
  | 'bottom'
  | 'top-front-left'
  | 'top-front'
  | 'top-front-right'
  | 'top-back-left'
  | 'top-back-right'
  | 'bottom-front-left'
  | 'bottom-front'
  | 'bottom-front-right'
  | 'bottom-back-left'
  | 'bottom-back-right'

// Vite resolves each PNG to a final hashed URL at build time. `eager` so the map is
// a plain object of strings (no async) — these are tiny and always needed together.
const modules = import.meta.glob<{ default: string }>('./*.png', { eager: true })

export const MOUSE_FRAMES = Object.fromEntries(
  Object.entries(modules).map(([path, mod]) => {
    // './front-left.png' → 'front-left'
    const name = path.replace(/^\.\//, '').replace(/\.png$/, '')
    return [name, mod.default]
  })
) as Record<MouseFrame, string>

// The 8 ground-plane headings in clockwise order starting at FRONT (toward viewer),
// each at a 45° step. `headingToFrame(deg)` snaps any travel angle to the nearest.
// Angle convention: 0° = moving RIGHT, 90° = DOWN, 180° = LEFT, 270° = UP (screen
// coords, y-down). We map travel direction → the pose that best "faces" that way:
//   moving right  → 'right',  moving left → 'left',  toward viewer/down → 'front',
//   away/up → 'back'. In-betweens use the diagonal poses.
const GROUND_RING: MouseFrame[] = [
  'right', // 0°   → →
  'front-right', // 45°  ↘
  'front', // 90°  ↓ (toward viewer)
  'front-left', // 135° ↙
  'left', // 180° ←
  'back-left', // 225° ↖
  'back', // 270° ↑ (away)
  'back-right' // 315° ↗
]

/** Snap a travel heading in DEGREES (0=right, CW) to the nearest ground-plane pose. */
export function headingToFrame(deg: number): MouseFrame {
  const norm = ((deg % 360) + 360) % 360
  const idx = Math.round(norm / 45) % 8
  return GROUND_RING[idx]
}

/** Heading from a velocity vector (screen coords). Returns the facing frame. */
export function vectorToFrame(dx: number, dy: number): MouseFrame {
  if (dx === 0 && dy === 0) return 'front'
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI
  return headingToFrame(deg)
}
