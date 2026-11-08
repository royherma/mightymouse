import type { JSX } from 'react'
import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import type { Group, Mesh } from 'three'
import { CONFIG } from '../../../shared/config'
import type { CompanionState } from '../../../shared/companion-state'

/**
 * Live Voice Companion — Phase 3 of the design
 * A small procedural 3D mouse built from
 * plain three.js primitives (sphere body/head/ears, cone snout, cylinder/
 * cone limbs+tail) — NOT a rigged GLTF asset. The design explicitly calls out
 * that no rigged mouse asset exists yet and scopes this phase down to a
 * primitive-based rig instead of sourcing/loading external art, so this
 * component has zero external asset dependency and works the moment it's
 * imported.
 *
 * State machine (driven by `CompanionState` from Phase 0, `companion-state.ts`
 * — the SAME union CompanionApp already cycles through, no new state type):
 *   idle      — gentle breathing bob (slow scale/translate sine)
 *   listening — ears perk up + a small head tilt toward the "sound"
 *   thinking  — head tilts + tail twitches (faster, smaller-amplitude sine)
 *   talking   — jaw (lower snout piece) scales open/closed with mouthOpen (0..1)
 *   reacting  — a quick bounce/hop on entry, then settles back to idle motion
 *
 * All animation runs through r3f's `useFrame` (synced to the shared r3f render
 * loop), never a manual `requestAnimationFrame` — per the design's explicit ask.
 *
 * Drag-to-reposition: since the companion is a real (non click-through) OS
 * window (see companion-window.ts), a pointer-down+move on the canvas moves
 * the ACTUAL BrowserWindow via `companionDragMove` (main applies the delta to
 * `setBounds`), not an in-page CSS transform — the character always stays
 * centered in its own window. Easing convention (dx/dy delta, not absolute
 * position) mirrors CursorApp.tsx's follow math, adapted for direct user-drag:
 * CursorApp eases a follower toward a moving target every frame; here there's
 * no easing needed (the window should track the pointer 1:1, not lag), so we
 * only borrow the "accumulate a delta since last sample, ship it, repeat"
 * shape rather than the eased-interpolation part.
 */

const T = CONFIG.THEME_TOKENS

export interface MouseCharacterProps {
  state: CompanionState
  /** Live 0..1 mouth-openness from useAudioPlayback's RMS tap (Phase 2). Only
   *  consumed while `state === 'talking'`; otherwise the jaw stays closed. */
  mouthOpen: number
}

// Per-state accent tint on the fur — same "state carries its own color"
// convention as CompanionApp's ACCENT map, so the sprite and the 3D character
// never disagree about what color a state is.
const TINT: Record<CompanionState, string> = {
  idle: T.textMutedLight,
  listening: T.accent,
  thinking: T.violet,
  talking: T.blue,
  reacting: T.green
}

const FUR = T.surface3
const EAR_INNER = T.accentBgSubtle

export default function MouseCharacter({ state, mouthOpen }: MouseCharacterProps): JSX.Element {
  return (
    <Canvas
      camera={{ position: [0, 0.4, 3.4], fov: 32 }}
      gl={{ alpha: true, antialias: true }}
      style={{ width: '100%', height: '100%', background: 'transparent' }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        // buttons === 0 means no button is held (pointer capture set above only
        // engages while the primary button is down) — plain hover, not a drag.
        if (e.buttons === 0) return
        window.api.companionDragMove({ dx: e.movementX, dy: e.movementY })
      }}
    >
      <ambientLight intensity={0.85} />
      <directionalLight position={[2, 3, 4]} intensity={0.9} />
      <Mouse state={state} mouthOpen={mouthOpen} />
    </Canvas>
  )
}

function Mouse({ state, mouthOpen }: MouseCharacterProps): JSX.Element {
  const root = useRef<Group>(null)
  const head = useRef<Group>(null)
  const earL = useRef<Mesh>(null)
  const earR = useRef<Mesh>(null)
  const tail = useRef<Mesh>(null)
  const jaw = useRef<Mesh>(null)

  // When `state` last became 'reacting' — the bounce is a one-shot envelope
  // timed off this, not a continuous animation (see the useFrame body).
  const reactStartedAt = useRef(0)
  const prevState = useRef<CompanionState>(state)
  if (prevState.current !== state) {
    if (state === 'reacting') reactStartedAt.current = performance.now()
    prevState.current = state
  }

  const tint = useMemo(() => TINT[state], [state])

  useFrame((_, delta) => {
    const t = performance.now() / 1000
    const r = root.current
    const h = head.current
    if (!r || !h) return

    // Base idle motion: always running underneath every state so nothing ever
    // looks frozen — a slow breathing bob + a barely-there head sway.
    const breathe = Math.sin(t * 1.6) * 0.035
    r.position.y = breathe
    h.rotation.z = Math.sin(t * 1.1) * 0.03

    if (state === 'listening') {
      // Ears perk up (rotate outward/up) + a small attentive head tilt.
      const perk = 0.35
      if (earL.current) earL.current.rotation.z += (perk - earL.current.rotation.z) * 0.15
      if (earR.current) earR.current.rotation.z += (-perk - earR.current.rotation.z) * 0.15
      h.rotation.x += (-0.12 - h.rotation.x) * 0.12
    } else if (state === 'thinking') {
      // Head tilts to one side + tail twitches faster than the idle sway.
      h.rotation.z += (0.22 - h.rotation.z) * 0.1
      h.rotation.x += (0.05 - h.rotation.x) * 0.1
      if (tail.current) tail.current.rotation.y = Math.sin(t * 6) * 0.4
      if (earL.current) earL.current.rotation.z += (0.15 - earL.current.rotation.z) * 0.15
      if (earR.current) earR.current.rotation.z += (-0.15 - earR.current.rotation.z) * 0.15
    } else if (state === 'talking') {
      // Jaw (lower snout piece) scales open/closed driven directly by the live
      // mouth-openness signal — no viseme set, matches the design's non-goal.
      h.rotation.x += (0 - h.rotation.x) * 0.1
      h.rotation.z += (0 - h.rotation.z) * 0.1
      if (jaw.current) {
        const openScale = 1 + mouthOpen * 1.8
        jaw.current.scale.y += (openScale - jaw.current.scale.y) * 0.5
        jaw.current.position.y = -0.16 - mouthOpen * 0.08
      }
      if (earL.current) earL.current.rotation.z += (0 - earL.current.rotation.z) * 0.1
      if (earR.current) earR.current.rotation.z += (0 - earR.current.rotation.z) * 0.1
    } else if (state === 'reacting') {
      // One-shot bounce/hop envelope: a damped sine over REACT_MS, then this
      // branch naturally stops contributing once elapsed exceeds the window
      // (the base idle breathing keeps going regardless).
      const elapsed = performance.now() - reactStartedAt.current
      const REACT_MS = 480
      if (elapsed < REACT_MS) {
        const decay = 1 - elapsed / REACT_MS
        const hop = Math.abs(Math.sin((elapsed / REACT_MS) * Math.PI * 2)) * 0.25 * decay
        r.position.y = breathe + hop
      }
    } else {
      // idle — ears and jaw relax back to rest.
      if (earL.current) earL.current.rotation.z += (0 - earL.current.rotation.z) * 0.08
      if (earR.current) earR.current.rotation.z += (0 - earR.current.rotation.z) * 0.08
      if (jaw.current) {
        jaw.current.scale.y += (1 - jaw.current.scale.y) * 0.2
        jaw.current.position.y += (-0.16 - jaw.current.position.y) * 0.2
      }
      h.rotation.x += (0 - h.rotation.x) * 0.08
    }

    // Tail idle sway (thinking's twitch above overrides this each frame it's
    // active — this branch just keeps it alive the rest of the time).
    if (state !== 'thinking' && tail.current) {
      tail.current.rotation.y = Math.sin(t * 1.4) * 0.12
    }

    void delta // useFrame's delta isn't needed (t is derived from wall clock above)
  })

  return (
    <group ref={root}>
      {/* Body */}
      <mesh position={[0, -0.35, 0]} scale={[1, 0.8, 1.15]}>
        <sphereGeometry args={[0.62, 24, 18]} />
        <meshStandardMaterial color={FUR} />
      </mesh>

      {/* Head group — everything above rotates together for the tilt/perk */}
      <group ref={head} position={[0, 0.28, 0.28]}>
        <mesh>
          <sphereGeometry args={[0.42, 24, 18]} />
          <meshStandardMaterial color={FUR} />
        </mesh>

        {/* Snout */}
        <mesh position={[0, -0.08, 0.38]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.16, 0.28, 16]} />
          <meshStandardMaterial color={FUR} />
        </mesh>

        {/* Jaw — the piece that scales open while talking */}
        <mesh ref={jaw} position={[0, -0.16, 0.34]}>
          <sphereGeometry args={[0.11, 12, 10]} />
          <meshStandardMaterial color={tint} />
        </mesh>

        {/* Nose tip */}
        <mesh position={[0, -0.06, 0.52]}>
          <sphereGeometry args={[0.045, 8, 8]} />
          <meshStandardMaterial color={tint} />
        </mesh>

        {/* Eyes */}
        <mesh position={[-0.15, 0.06, 0.36]}>
          <sphereGeometry args={[0.055, 10, 8]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
        <mesh position={[0.15, 0.06, 0.36]}>
          <sphereGeometry args={[0.055, 10, 8]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>

        {/* Ears — rotate about their base to "perk" (listening/thinking) */}
        <mesh ref={earL} position={[-0.32, 0.32, -0.02]}>
          <sphereGeometry args={[0.18, 16, 12]} />
          <meshStandardMaterial color={FUR} />
        </mesh>
        <mesh position={[-0.32, 0.32, 0.09]}>
          <sphereGeometry args={[0.1, 12, 10]} />
          <meshStandardMaterial color={EAR_INNER} />
        </mesh>
        <mesh ref={earR} position={[0.32, 0.32, -0.02]}>
          <sphereGeometry args={[0.18, 16, 12]} />
          <meshStandardMaterial color={FUR} />
        </mesh>
        <mesh position={[0.32, 0.32, 0.09]}>
          <sphereGeometry args={[0.1, 12, 10]} />
          <meshStandardMaterial color={EAR_INNER} />
        </mesh>
      </group>

      {/* Tail — a slim tapered cylinder trailing off the back, twitches while
          thinking, gentle idle sway otherwise (see useFrame). */}
      <mesh ref={tail} position={[0, -0.32, -0.62]} rotation={[Math.PI / 2.4, 0, 0]}>
        <cylinderGeometry args={[0.015, 0.05, 0.85, 8]} />
        <meshStandardMaterial color={tint} />
      </mesh>

      {/* Feet — small flattened spheres, purely decorative (no per-foot anim) */}
      <mesh position={[-0.28, -0.74, 0.18]} scale={[1, 0.5, 1.3]}>
        <sphereGeometry args={[0.16, 12, 10]} />
        <meshStandardMaterial color={FUR} />
      </mesh>
      <mesh position={[0.28, -0.74, 0.18]} scale={[1, 0.5, 1.3]}>
        <sphereGeometry args={[0.16, 12, 10]} />
        <meshStandardMaterial color={FUR} />
      </mesh>
    </group>
  )
}
