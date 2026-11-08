import { useEffect, useRef, useState } from 'react'

/**
 * Live mic loudness as a smoothed 0..1 value, plus an auto-NORMALIZED companion.
 * Taps the mic via getUserMedia + a Web Audio AnalyserNode and reports the RMS of
 * the time-domain buffer, smoothed so it swells and settles instead of snapping.
 *
 * Why normalization: raw RMS is tiny and mic/room-dependent (a quiet laptop mic
 * might peak at 0.06, a loud one at 0.4). A fixed gain feels dead on one and clips
 * on another. The normalizer tracks a rolling noise FLOOR and speech CEILING and
 * remaps the live level into that band, so normal speech always swings the full
 * 0..1 regardless of input level — the glow stays reactive everywhere. On top of
 * that it runs an ALWAYS-ON idle breathe (BASE + slow/fast sine), so while active
 * the value never sits at 0 — silence still gently fluctuates; voice rides on top.
 *
 * Read paths (all share one tap, one rAF loop):
 *  - `levelRef` / `normRef` — read inside YOUR rAF loop (canvas) at 60fps, zero
 *    re-renders. WaveformViz uses levelRef.
 *  - `level` / `norm` state — re-renders ~15fps so plain CSS/React can react.
 *    The island glow uses `norm`.
 *
 * `active=false` tears the mic down (reports 0). On mic-denied we stay at 0.
 * `smoothing` = per-frame lerp (higher = snappier). 0.18 is the waveform default.
 */
/**
 * Normalizer tuning. All the magic numbers live here so the feel is one place to
 * tune. AGC = auto-gain: track a rolling noise floor + speech ceiling, remap the
 * live level into that band so any mic/room swings the full 0..1.
 */
const AGC = {
  FLOOR_START: 0.02,
  CEIL_START: 0.12,
  FLOOR_ATTACK: 0.15, // how fast `floor` snaps DOWN to a new quiet
  FLOOR_RELEASE: 0.0015, // how slow `floor` drifts UP (don't eat speech)
  CEIL_ATTACK: 0.3, // how fast `ceil` snaps UP to a new peak
  CEIL_RELEASE: 0.04, // how fast `ceil` decays DOWN (re-tighten after a burst)
  MIN_BAND: 0.008, // floor of (ceil-floor) so quiet rooms still react
  CURVE: 0.45 // <1 expands the low end so soft speech already moves a lot
} as const

/**
 * Idle "alive" baseline. While listening is ON, the glow NEVER sits at 0 — it
 * always breathes around BASE with a slow + fast sine wobble, so silence looks
 * alive (a gently fluctuating ring), not dead. Real voice level adds ON TOP via
 * Math.max, so speaking still dominates. The wobble is always present, not gated
 * on silence, so the ring keeps moving even mid-sentence pauses.
 */
const IDLE = {
  BASE: 0.18, // resting glow when fully silent
  SLOW_AMP: 0.07, // big slow swell
  SLOW_SPEED: 0.025,
  FAST_AMP: 0.035, // small fast shimmer on top
  FAST_SPEED: 0.11
} as const

export function useMicLevel(
  active: boolean,
  smoothing = 0.18
): {
  level: number
  levelRef: React.RefObject<number>
  norm: number
  normRef: React.RefObject<number>
} {
  const levelRef = useRef(0)
  const normRef = useRef(0)
  const [level, setLevel] = useState(0)
  const [norm, setNorm] = useState(0)

  useEffect(() => {
    if (!active) {
      levelRef.current = 0
      normRef.current = 0
      setLevel(0)
      setNorm(0)
      return
    }

    let raf = 0
    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let stream: MediaStream | null = null
    let buf: Uint8Array<ArrayBuffer> | null = null
    let disposed = false
    let lastEmit = 0

    // Rolling normalizer state. floor chases the quietest recent level (noise),
    // ceil chases the loudest (speech peaks). Both decay slowly back toward each
    // other so the band re-tightens after a loud burst — fast attack, slow release.
    let floor = AGC.FLOOR_START
    let ceil = AGC.CEIL_START
    let phase = 0 // drives the always-on idle breathing wobble

    function measure(): number {
      if (!analyser || !buf) return 0
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      return Math.sqrt(sum / buf.length) // RMS
    }

    function tick(t: number): void {
      if (disposed) return
      const target = measure()
      levelRef.current += (target - levelRef.current) * smoothing
      const lv = levelRef.current

      // --- auto-gain normalize (see AGC constants) ---
      // floor: snap down to a new quiet fast, drift up slowly (don't eat speech).
      floor += (lv < floor ? AGC.FLOOR_ATTACK : AGC.FLOOR_RELEASE) * (lv - floor)
      // ceil: snap up to a new peak fast, decay down so the band re-tightens after
      // a loud burst — a soft voice right after still fills the range.
      ceil += (lv > ceil ? AGC.CEIL_ATTACK : AGC.CEIL_RELEASE) * (lv - ceil)
      const band = Math.max(ceil - floor, AGC.MIN_BAND)
      let n = (lv - floor) / band
      n = Math.max(0, Math.min(1, n))
      n = Math.pow(n, AGC.CURVE)

      // Always-on idle breathing (see IDLE constants). This is NOT gated on silence:
      // BASE + slow swell + fast shimmer run every frame, so the ring is ALWAYS
      // fluctuating while active — never flat 0. Real voice (n) rides on top via max,
      // so speaking still drives it harder than the resting breathe.
      phase += IDLE.FAST_SPEED
      const breathe =
        IDLE.BASE +
        IDLE.SLOW_AMP * Math.sin(phase * (IDLE.SLOW_SPEED / IDLE.FAST_SPEED)) +
        IDLE.FAST_AMP * Math.sin(phase)
      normRef.current = Math.max(n, breathe)

      if (t - lastEmit > 50) {
        lastEmit = t
        setLevel(lv)
        setNorm(normRef.current)
      }
      raf = requestAnimationFrame(tick)
    }

    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (disposed) {
          s.getTracks().forEach((track) => track.stop())
          return
        }
        stream = s
        audioCtx = new AudioContext()
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 1024
        buf = new Uint8Array(new ArrayBuffer(analyser.fftSize))
        audioCtx.createMediaStreamSource(s).connect(analyser)
      })
      .catch(() => {
        /* no mic → stays at 0 */
      })

    raf = requestAnimationFrame(tick)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((track) => track.stop())
      audioCtx?.close().catch(() => {})
    }
  }, [active, smoothing])

  return { level, levelRef, norm, normRef }
}
