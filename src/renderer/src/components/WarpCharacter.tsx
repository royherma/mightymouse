import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { CONFIG } from '../../../shared/config'
import type { CompanionState } from '../../../shared/companion-state'

/**
 * Live Voice Companion — Option C renderer (PRD §6 `CharacterRenderer`):
 * a single still PORTRAIT deformed live in WebGL. No video generation, no
 * streaming, no per-turn cost — the "talking head WebGL warp rig" technique
 * (2D image-as-texture on a deformable mesh; jaw/eyes/head vertices displaced
 * over time). Same idea as Live2D / Character Animator puppet-warp, hand-rolled
 * lightweight here.
 *
 * Contract is identical to `MouseCharacter` (Option A) — takes `state` +
 * `mouthOpen` and nothing else — so CompanionApp swaps one for the other with a
 * prop-less switch and no call-site change (that's the whole point of the §6
 * seam). Drag-to-reposition is handled by CompanionApp's wrapper, not here.
 *
 * Inputs → deformation:
 *   mouthOpen (0..1, live TTS RMS)  → jaw region pushed down while `talking`
 *   state === listening             → subtle head-tilt toward the "sound"
 *   state === thinking              → slow idle sway + a look-away drift
 *   idle                            → breathing bob + timed blinks (eyelid rows)
 *   reacting                        → a quick bounce on entry
 *
 * Grid warp: the portrait is a texture on an N×N triangle grid. We deform a few
 * named vertex BANDS in clip space (a jaw band low on the face, an eye band, a
 * whole-head translate) rather than a per-pixel shader — cheap, and enough for
 * the "it's alive" read at companion size. All animation runs off a single
 * requestAnimationFrame loop (this is raw WebGL, not r3f — no shared render
 * loop to hook, unlike MouseCharacter).
 *
 * Missing-asset fallback: if the portrait texture can't be loaded (asset not
 * generated yet — see the PRD note that the mouse portrait is blocked on an
 * image-gen credit top-up), the component throws so CompanionApp's
 * CharacterBoundary degrades to the placeholder blob, exactly like a WebGL init
 * failure. It never renders a broken/empty canvas.
 */

// Portrait texture served from renderer/public (loads identically in dev,
// snapshot, and packaged build — a public asset, not a bundled import, so a
// missing file is a runtime 404 we can catch rather than a build error).
const PORTRAIT_SRC = 'companion/mouse-portrait.png'

// Mesh resolution. 16×16 quads is plenty smooth for a head-and-shoulders warp
// at ~180px and keeps the vertex count trivial (~600).
const GRID = 16

export interface WarpCharacterProps {
  state: CompanionState
  /** Live 0..1 mouth-openness from useAudioPlayback's RMS tap. Only moves the
   *  jaw band while `state === 'talking'`. */
  mouthOpen: number
  /** Live 0..1 mic loudness (useMicLevel `norm`) from the USER's voice. Drives
   *  the ear-perk + head-lean while `state === 'listening'` so the mouse visibly
   *  reacts to how loud you're talking. Ignored in every other state. */
  micLevel?: number
}

const VERT_SRC = `
  attribute vec2 a_pos;      // clip-space base position (-1..1)
  attribute vec2 a_uv;       // texture coord (0..1)
  attribute vec2 a_warp;     // per-vertex displacement (added, animated in JS)
  varying vec2 v_uv;
  void main() {
    gl_Position = vec4(a_pos + a_warp, 0.0, 1.0);
    v_uv = a_uv;
  }
`

const FRAG_SRC = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  void main() {
    vec4 c = texture2D(u_tex, v_uv);
    if (c.a < 0.01) discard;   // keep the transparent background transparent
    gl_FragColor = c;
  }
`

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('WarpCharacter: createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`WarpCharacter: shader compile failed: ${log}`)
  }
  return sh
}

export default function WarpCharacter({ state, mouthOpen, micLevel = 0 }: WarpCharacterProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Latest inputs, read inside the rAF loop without re-subscribing it.
  const stateRef = useRef<CompanionState>(state)
  stateRef.current = state
  const mouthRef = useRef(mouthOpen)
  mouthRef.current = mouthOpen
  const micRef = useRef(micLevel)
  micRef.current = micLevel
  // Set when the entry bounce for `reacting` began, so it can decay.
  const reactAtRef = useRef(0)
  const prevStateRef = useRef<CompanionState>(state)
  // Surfaced to React so a load/GL failure re-renders into the thrown-error path
  // (throwing straight from an effect wouldn't reach the error boundary).
  const [fatal, setFatal] = useState<Error | null>(null)

  useEffect(() => {
    if (stateRef.current === 'reacting' && prevStateRef.current !== 'reacting') {
      reactAtRef.current = performance.now()
    }
    prevStateRef.current = stateRef.current
  }, [state])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true })
    if (!ctx) {
      setFatal(new Error('WarpCharacter: WebGL unavailable'))
      return
    }
    // Non-null alias so the rAF closure below keeps the narrowing (TS doesn't
    // carry the early-return guard into a nested function).
    const gl: WebGLRenderingContext = ctx

    let raf = 0
    let disposed = false
    let program: WebGLProgram | null = null
    let texture: WebGLTexture | null = null

    // Build the grid geometry: base positions + UVs are static; the warp buffer
    // is rewritten each frame. Positions map the [0..1] grid onto clip space,
    // Y-flipped so the image is upright.
    const positions: number[] = []
    const uvs: number[] = []
    const indices: number[] = []
    for (let y = 0; y <= GRID; y++) {
      for (let x = 0; x <= GRID; x++) {
        const u = x / GRID
        const v = y / GRID
        positions.push(u * 2 - 1, (1 - v) * 2 - 1)
        uvs.push(u, v)
      }
    }
    const stride = GRID + 1
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const a = y * stride + x
        const b = a + 1
        const c = a + stride
        const d = c + 1
        indices.push(a, b, c, b, d, c)
      }
    }
    const warp = new Float32Array((stride * stride) * 2)

    try {
      const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC)
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
      program = gl.createProgram()
      if (!program) throw new Error('WarpCharacter: createProgram failed')
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`WarpCharacter: link failed: ${gl.getProgramInfoLog(program)}`)
      }
      gl.useProgram(program)
    } catch (err) {
      setFatal(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const posBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uvBuf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW)
    const aUv = gl.getAttribLocation(program, 'a_uv')
    gl.enableVertexAttribArray(aUv)
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0)

    const warpBuf = gl.createBuffer()
    const aWarp = gl.getAttribLocation(program, 'a_warp')
    gl.enableVertexAttribArray(aWarp)

    const idxBuf = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)

    // Load the portrait; a 404 / decode error is fatal → boundary fallback.
    const img = new Image()
    img.onload = () => {
      if (disposed) return
      texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      raf = requestAnimationFrame(frame)
    }
    img.onerror = () => {
      if (!disposed) setFatal(new Error(`WarpCharacter: portrait failed to load (${PORTRAIT_SRC})`))
    }
    img.src = PORTRAIT_SRC

    // Grid coordinate helpers (0..1 across the face).
    function frame(now: number): void {
      if (disposed || !program) return
      const t = now / 1000
      const st = stateRef.current
      const mouth = st === 'talking' ? mouthRef.current : 0
      // User's live voice level, only while listening. Smoothed already by
      // useMicLevel's AGC; drives the ear-perk + head-lean so louder = more react.
      const mic = st === 'listening' ? micRef.current : 0

      // Whole-head motion. Amplitudes are in clip space (canvas half-width =
      // 1.0), so 0.03 ≈ 6px at 400px — these are tuned to read clearly at
      // companion size, NOT be subtle. Earlier values (~0.006) were ~1px and
      // looked frozen.
      //   breatheY  : slow vertical bob, always on (life sign even when idle)
      //   breatheX  : a lazy horizontal sway, so idle never looks perfectly still
      //   sway      : bigger horizontal head drift while listening/thinking
      //   headTilt  : shear the head left/right (top moves opposite the bottom)
      const breatheY = Math.sin(t * 1.5) * 0.02
      const breatheX = Math.sin(t * 0.8) * 0.012
      const sway =
        st === 'listening'
          ? Math.sin(t * 2.2) * 0.05
          : st === 'thinking'
            ? Math.sin(t * 1.1) * 0.05
            : 0
      const headTilt = st === 'listening' ? 0.05 : st === 'thinking' ? Math.sin(t * 0.9) * 0.05 : 0
      // Listening "alert" lift: the whole head rises a touch, MORE the louder you
      // talk — so the mouse visibly "leans in" the instant you speak. Applied as a
      // negative dy on the top-of-head band below (v < 0.5), pivoting so the chin
      // barely moves. Base 0.02 (always a clear perk while listening) + mic ride.
      const listenLift = st === 'listening' ? 0.02 + mic * 0.05 : 0
      const reactAge = (now - reactAtRef.current) / 1000
      const bounce =
        reactAtRef.current > 0 && reactAge < 0.6
          ? Math.sin((reactAge * Math.PI) / 0.6) * 0.09 * (1 - reactAge / 0.6)
          : 0

      // Timed blink: quick eyelid squash. Blinks ~every 2.8s; the squash window
      // is wide enough (8% of the cycle) to actually be seen. 0 = open, 1 = shut.
      const blinkPhase = (t % 2.8) / 2.8
      const blink = blinkPhase > 0.92 ? Math.sin(((blinkPhase - 0.92) / 0.08) * Math.PI) : 0

      for (let gy = 0; gy <= GRID; gy++) {
        for (let gx = 0; gx <= GRID; gx++) {
          const i = (gy * stride + gx) * 2
          const v = gy / GRID // 0 = top of image, 1 = bottom
          const u = gx / GRID // 0 = left edge, 1 = right edge
          // headTilt + sway shear the head: the top of the head moves opposite
          // the chin, pivoting around mid-face, for a real "tilt" not a slide.
          let dx = breatheX + sway + headTilt * (0.5 - v)
          let dy = breatheY + bounce

          // Listening lift: raise the upper head (v < 0.5), most at the crown,
          // fading to nothing by mid-face so the jaw stays put. Negative = up.
          if (listenLift > 0 && v < 0.5) {
            dy -= listenLift * (0.5 - v) * 2
          }
          // Mic-reactive EARS: the top corners (a mouse's ears sit high + wide)
          // perk UP and slightly OUTWARD with the user's live voice level. Only
          // the outer-top region moves, so it reads as ears twitching, not the
          // whole head. Base 0.35 while listening (always alive) + mic ride.
          if (st === 'listening' && v < 0.28) {
            const earSide = Math.abs(u - 0.5) // 0 center → 0.5 at edges
            if (earSide > 0.26) {
              const ear = (earSide - 0.26) / 0.24 // 0..1 across the ear zone
              const top = (0.28 - v) / 0.28 // 0..1, strongest at the very top
              const perk = (0.35 + mic * 0.65) * ear * top
              dy -= perk * 0.09
              dx += (u < 0.5 ? -1 : 1) * perk * 0.03
            }
          }

          // Jaw band: lower third opens with mouthOpen. Soft falloff so the chin
          // moves most, cheeks barely. Bigger gain so a talking mouth is obvious.
          if (v > 0.55) {
            const jaw = (v - 0.55) / 0.45
            dy -= mouth * 0.22 * jaw
          }
          // Eye band: upper-middle. Blink pinches the band vertically (top edge
          // down, bottom edge up = lids meeting).
          if (v > 0.28 && v < 0.46) {
            const eye = 1 - Math.abs(v - 0.37) / 0.09
            dy += blink * 0.06 * eye * (v < 0.37 ? -1 : 1)
          }
          warp[i] = dx
          warp[i + 1] = dy
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, warpBuf)
      gl.bufferData(gl.ARRAY_BUFFER, warp, gl.DYNAMIC_DRAW)
      gl.vertexAttribPointer(aWarp, 2, gl.FLOAT, false, 0, 0)

      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0)
      raf = requestAnimationFrame(frame)
    }

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      if (texture) gl.deleteTexture(texture)
      if (program) gl.deleteProgram(program)
    }
  }, [])

  // Throwing during render is the only way a functional component reaches the
  // class error boundary — surface a load/GL failure as the placeholder.
  if (fatal) throw fatal

  return (
    <canvas
      ref={canvasRef}
      width={CONFIG.COMPANION.WIDTH}
      height={CONFIG.COMPANION.HEIGHT}
      style={{ width: '100%', height: '100%', display: 'block', background: 'transparent' }}
      aria-label="Companion character"
    />
  )
}
