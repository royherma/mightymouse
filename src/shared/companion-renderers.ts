/**
 * SINGLE SOURCE OF TRUTH for the Live Voice Companion's character-RENDERER
 * choices — i.e. WHICH visualization draws the companion, a different axis from
 * `CompanionState` (idle/listening/thinking/talking/reacting), which is WHAT the
 * character is doing. This is the concrete implementation of the PRD's §6
 * `CharacterRenderer` seam: every renderer takes the exact same props
 * (`state` + `mouthOpen`), so swapping one for another touches no call site.
 * (prds/active/2026-07-12-1783824131-live-voice-companion.md §6.)
 *
 * Add a new visualization by (1) appending an entry here and (2) handling its id
 * in CompanionApp.tsx's renderer switch. Everything else (the debug-panel picker,
 * PREFS, IPC) reads this list, so no other file changes when you add one —
 * exactly the pattern cursor-styles.ts uses for cursor looks.
 *
 * Named union + const list (not bare string literals) per the repo's no-magic-
 * strings rule.
 */

export type CompanionRendererId = 'mouse3d' | 'warp2d' | 'placeholder' | 'stage'

export interface CompanionRendererMeta {
  id: CompanionRendererId
  label: string
  description: string
}

export const COMPANION_RENDERERS: CompanionRendererMeta[] = [
  {
    id: 'mouse3d',
    label: '3D mouse',
    description: 'Procedural three.js mouse (Option A). No asset, GPU-drawn.'
  },
  {
    id: 'warp2d',
    label: '2D warp',
    description: 'One still portrait deformed live in WebGL — jaw/blink/head from state + audio. $0/turn (Option C).'
  },
  {
    id: 'placeholder',
    label: 'Blob',
    description: 'CSS glyph blob — the zero-dependency fallback, also the WebGL-failure degrade.'
  },
  {
    id: 'stage',
    label: 'Stage',
    description: 'Full-screen bubbles + live screenshot. Readable on a phone mirror.'
  }
]

/** The one renderer that covers the whole screen and is CLICK-THROUGH, so the
 *  agent can drive the apps underneath it. Every other renderer is a solid
 *  window. companion-window.ts keys pointer behavior off this. */
export const COMPANION_RENDERER_STAGE: CompanionRendererId = 'stage'

export const DEFAULT_COMPANION_RENDERER: CompanionRendererId = 'mouse3d'

export function toCompanionRenderer(value: string | null | undefined): CompanionRendererId {
  const hit = COMPANION_RENDERERS.find((r) => r.id === value)
  return hit ? hit.id : DEFAULT_COMPANION_RENDERER
}
