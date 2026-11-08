import React from 'react'

// Shared MightyMouse head glyph — used by the cursor overlay AND the Settings
// preview card so they always match. Proportions echo the app icon: two big
// rounded ears, a tapered angular face, glowing eyes + nose.
//
// eyesRef lets the live overlay animate the eye glow (drop-shadow) per frame.
// laserRef points at a <g> holding the two eye-beams; the overlay rotates and
// scales it toward the direction of travel.
export function MouseGlyph({
  size = 40,
  eyesRef,
  laserRef,
  beam0Ref,
  beam1Ref,
  showLaser = false,
  blue = 'var(--accent-border-subtle)',
  cyan = 'var(--cyan)'
}: {
  size?: number
  eyesRef?: React.Ref<SVGGElement>
  laserRef?: React.Ref<SVGGElement>
  beam0Ref?: React.Ref<SVGRectElement>
  beam1Ref?: React.Ref<SVGRectElement>
  showLaser?: boolean
  blue?: string
  cyan?: string
}): React.ReactElement {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} style={{ overflow: 'visible' }}>
      <defs>
        {/* Beam gradient: bright at the eye, fading out at the tip. */}
        <linearGradient id="mg-laser" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={cyan} stopOpacity="0.95" />
          <stop offset="100%" stopColor={cyan} stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Eye lasers — drawn BEHIND the head so they appear to shoot from the eyes.
          The group is rotated/scaled by the overlay; default (still) state hides it. */}
      <g
        ref={laserRef}
        style={{
          opacity: showLaser ? 0.9 : 0,
          filter: showLaser ? `drop-shadow(0 0 5px ${cyan})` : undefined
        }}
      >
        {/* One beam per eye, each ANCHORED AT ITS OWN EYE so it emits from the
            eye point (not the face center). Authored pointing right (0°) from the
            eye; the overlay rotates each rect about its own eye to aim at the
            pointer, and resizes width for length. Left eye ~(36,54), right ~(64,54). */}
        <rect ref={beam0Ref} x="36" y="52.4" width="40" height="3.2" rx="1.6" fill="url(#mg-laser)" />
        <rect ref={beam1Ref} x="64" y="52.4" width="40" height="3.2" rx="1.6" fill="url(#mg-laser)" />
      </g>

      {/* Ears — big rounded circles, clearly separated like the icon */}
      <circle cx="24" cy="28" r="22" fill="#161c2e" stroke={blue} strokeWidth="1.5" />
      <circle cx="76" cy="28" r="22" fill="#161c2e" stroke={blue} strokeWidth="1.5" />
      <circle cx="24" cy="28" r="12" fill="#0e1320" />
      <circle cx="76" cy="28" r="12" fill="#0e1320" />

      {/* Face — tapered angular head pointing down to the nose */}
      <path
        d="M50 22
           L84 50
           Q86 54 82 60
           L54 92
           Q50 96 46 92
           L18 60
           Q14 54 16 50
           Z"
        fill="#0e1320"
        stroke={blue}
        strokeWidth="2"
      />
      {/* Center crease for the faceted look */}
      <path d="M50 30 L50 86" stroke={blue} strokeWidth="1" opacity="0.5" />

      {/* Eyes — almond shapes, glow group is animatable */}
      <g ref={eyesRef} fill={cyan}>
        <path d="M30 54 Q38 44 46 54 Q38 62 30 54 Z" />
        <path d="M54 54 Q62 44 70 54 Q62 62 54 54 Z" />
      </g>

      {/* Nose */}
      <path d="M44 78 L50 86 L56 78 Z" fill={cyan} opacity="0.85" />
    </svg>
  )
}
