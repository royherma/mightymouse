import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { nativeMicLevel } from './native-bridge'

/**
 * Which of the two looks renders. Flip to 'sine' to revert -- both paths are
 * live code and share the same audio tap, so this is a one-word rollback.
 *
 * 'bars' is the landing-page demo's look, adopted because the sine version is
 * near-invisible on a light skin: thin red lines with no plate behind them
 * read as a stray scribble threaded through the Cancel/Stop buttons rather
 * than as level. The demo hit the same wall first (web/phone-demo-v3.js:135).
 */
const WAVEFORM_STYLE: 'bars' | 'sine' = 'bars'

/** Bar count. The demo uses 7, but it has a 210px plate to spend; this one is
 *  68px wide to clear Cancel/Stop, and 7 bars there left ~2px of gap that read
 *  as a solid block. 5 is what fits with real air between the rods. Must stay
 *  ODD so there is a true centre bar for the mirror to work around. */
const BAR_COUNT = 5

/** Both render paths read level identically; only the source differs. Also the
 *  silence gate on App's long-press arm, so "voice" means one thing. */
export function readRms(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128
    sum += v * v
  }
  return Math.sqrt(sum / buf.length)
}

/**
 * Live mic waveform for the phone-remote recording HUD, sitting in the gap
 * between the Cancel and Stop buttons so the speaker gets real-time feedback
 * that their voice is landing.
 *
 * Both render paths tap the SAME stream: the desktop's WaveformViz opens its
 * own mic via useMicLevel, but here MediaRecorder already holds a live one, and
 * a second getUserMedia on iOS Safari can interrupt the in-flight recording (as
 * well as prompting again). So we read MediaRecorder's stream instead.
 *
 * The stream arrives asynchronously (getUserMedia resolves after this mounts),
 * so we poll the ref until it lands rather than requiring it at mount.
 */
export function MicWaveform({
  streamRef
}: {
  streamRef: RefObject<MediaStream | null>
}): React.JSX.Element {
  return WAVEFORM_STYLE === 'bars' ? (
    <MicWaveformBars streamRef={streamRef} />
  ) : (
    <MicWaveformSine streamRef={streamRef} />
  )
}

/**
 * Bars: BAR_COUNT vertical rods whose height tracks live voice RMS, on a dark
 * plate. Ported from the demo's voiceBeat, with the synthesised envelope
 * swapped for the real analyser level -- the demo fakes it because an embed has
 * no microphone, which is the one thing this does have.
 *
 * Heights are written as a CSS custom property per bar rather than as inline
 * `height`, so the plate/glow/sizing all stay in theme.css where every skin can
 * override them.
 */
function MicWaveformBars({
  streamRef
}: {
  streamRef: RefObject<MediaStream | null>
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const bars = [...box.querySelectorAll<HTMLElement>('i')]

    let raf = 0
    let phase = 0
    let disposed = false
    let level = 0

    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let buf: Uint8Array<ArrayBuffer> | null = null

    function attach(stream: MediaStream): void {
      try {
        const Ctor: typeof AudioContext =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        audioCtx = new Ctor()
        // iOS Safari hands back a SUSPENDED context, and a suspended analyser
        // reads all zeros forever -- flat bars that look like a dead mic. The
        // mic tap is a real gesture, so this resume is allowed.
        if (audioCtx.state === 'suspended') void audioCtx.resume()
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        source = audioCtx.createMediaStreamSource(stream)
        source.connect(analyser)
        buf = new Uint8Array(analyser.fftSize)
      } catch {
        // Web Audio unavailable/blocked -- the bars still breathe on the idle
        // floor below, so the UI degrades to "alive but flat" instead of dead.
        analyser = null
      }
    }

    function draw(): void {
      if (disposed) return
      if (!analyser && streamRef.current) attach(streamRef.current)

      // No stream means Swift holds the mic (native capture keeps recording
      // when the app backgrounds; a getUserMedia track does not). Same unit,
      // so the smoothing and gain below are shared rather than re-tuned.
      const rms = analyser && buf ? readRms(analyser, buf) : nativeMicLevel()
      // Runs on 0 too: silence, and the reset on nativeMicStopped, are real
      // levels to decay TOWARD. Skipping them froze the bars at the last loud
      // value instead of letting them fall.
      // Asymmetric on purpose, same as the sine path: attack outruns release,
      // because a symmetric filter leaves the bars hanging high after you stop
      // talking and that trailing hang is what actually feels sluggish.
      const k = rms > level ? 0.75 : 0.4
      level += (rms - level) * k

      phase += 0.24

      // GAIN: speech RMS on a phone mic mostly lands in 0.02-0.15, so the raw
      // value only ever drove the bars through the bottom of their range and
      // normal talking read as barely-moving. The 0.55 exponent (was 0.7) lifts
      // quiet input harder, and the gain multiplies before the clamp so a loud
      // voice still tops out rather than being scaled down to fit.
      const shaped = Math.min(1, Math.pow(level * 3.4, 0.55))

      const mid = (bars.length - 1) / 2
      for (let i = 0; i < bars.length; i++) {
        // Distance from centre, 0 at the middle bar -> 1 at the ends.
        const d = Math.abs(i - mid) / mid

        // The silhouette is tall in the middle and short at the ends AT ALL
        // TIMES, including silence. Folding the taper into --mmA instead (the
        // first cut) made every bar collapse to the same flat 10% floor when
        // quiet, which reads as a row of identical dashes rather than as a
        // waveform at rest.
        const shape = 1 - 0.55 * d * d

        // Ripple keyed to DISTANCE FROM CENTRE, never to the bar index. Using
        // `phase + i * 0.7` made this a travelling wave sweeping left to right,
        // so bar 0 and bar 6 were out of phase and the cluster never read as
        // symmetric -- the "doesn't mirror from the middle" report. Keying on
        // `d` means the two bars either side of centre share a value exactly,
        // so the whole thing breathes outward from the middle.
        const ripple = 0.8 + 0.2 * Math.sin(phase - d * 2.2)

        // The shape multiplies the FLOOR as well as the level, so the
        // tall-in-the-middle silhouette survives silence. Multiplying only the
        // level (the previous cut) meant `shaped == 0` erased the shape and
        // every bar sat at an identical resting height -- flat dashes, which is
        // the thing this is meant to avoid.
        const a = shape * (0.16 + 0.84 * shaped * ripple)
        bars[i].style.setProperty('--mmA', String(Math.min(1, Math.max(0, a))))
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      // Only tear down OUR graph nodes. The stream belongs to MediaRecorder --
      // stopping its tracks here would kill the recording.
      try {
        source?.disconnect()
        analyser?.disconnect()
        void audioCtx?.close()
      } catch {
        /* already torn down */
      }
    }
  }, [streamRef])

  return (
    <div ref={boxRef} className="micWaveform micWaveformBars" aria-hidden="true">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  )
}

/** Sine: the original three drifting layers whose amplitude tracks voice RMS,
 *  ported from the desktop renderer's WaveformViz. Kept intact behind the flag. */
function MicWaveformSine({
  streamRef
}: {
  streamRef: RefObject<MediaStream | null>
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Match the recording accent (the red the Stop button + mic label use)
    // rather than the brand orange -- this only ever shows while recording.
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--red-rgb').trim() ||
      '255, 90, 90'

    const dpr = window.devicePixelRatio || 1
    const cssW = canvas.clientWidth || 96
    const cssH = canvas.clientHeight || 36
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    ctx.scale(dpr, dpr)

    let raf = 0
    let phase = 0
    let disposed = false
    let level = 0

    // Web Audio graph, built once the recording stream shows up.
    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let source: MediaStreamAudioSourceNode | null = null
    // Explicit ArrayBuffer generic: getByteTimeDomainData won't accept a
    // SharedArrayBuffer-backed view under TS's tightened TypedArray types.
    let buf: Uint8Array<ArrayBuffer> | null = null

    function attach(stream: MediaStream): void {
      try {
        const Ctor: typeof AudioContext =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        audioCtx = new Ctor()
        // iOS Safari hands back a SUSPENDED context, and a suspended analyser
        // reads all zeros forever -- flat bars that look like a dead mic. The
        // mic tap is a real gesture, so this resume is allowed.
        if (audioCtx.state === 'suspended') void audioCtx.resume()
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 512
        source = audioCtx.createMediaStreamSource(stream)
        source.connect(analyser)
        buf = new Uint8Array(analyser.fftSize)
      } catch {
        // Web Audio unavailable/blocked -- the idle ripple below still draws,
        // so the UI degrades to "alive but flat" instead of dead.
        analyser = null
      }
    }

    const layers = [
      { off: 0, freq: 1.6, alpha: 0.9, w: 2 },
      { off: 2.1, freq: 2.4, alpha: 0.55, w: 1.5 },
      { off: 4.3, freq: 1.0, alpha: 0.35, w: 1.5 }
    ]

    function draw(): void {
      if (disposed) return

      // Late-binding the stream: getUserMedia resolves after mount.
      if (!analyser && streamRef.current) attach(streamRef.current)

      // No stream means Swift holds the mic -- see the bars path.
      const rms = analyser && buf ? readRms(analyser, buf) : nativeMicLevel()
      if (analyser || rms > 0) {
        // Far snappier than the desktop waveform's 0.18 -- tuned by eye on a
        // real phone, where anything slower reads as lag. Asymmetric on
        // purpose: attack outruns release, because a symmetric filter leaves
        // the wave hanging open after you stop talking, and that trailing
        // hang is what actually feels sluggish.
        const k = rms > level ? 0.75 : 0.4
        level += (rms - level) * k
      }

      // Drift speed. The desktop's 0.05 looked sleepy in this small 96px box --
      // the same angular step covers far less visible distance, so it needs a
      // much bigger one to feel equally alive at this size.
      phase += 0.24
      ctx!.clearRect(0, 0, cssW, cssH)
      const mid = cssH / 2
      const shaped = Math.pow(level, 0.7)
      const amp = (0.12 + shaped * 3.0) * (cssH / 2)
      const clamped = Math.min(amp, cssH / 2 - 1)

      for (const L of layers) {
        ctx!.beginPath()
        for (let x = 0; x <= cssW; x += 2) {
          const t = x / cssW
          const env = Math.sin(Math.PI * t)
          const y = mid + Math.sin(t * Math.PI * 2 * L.freq + phase + L.off) * clamped * env
          if (x === 0) ctx!.moveTo(x, y)
          else ctx!.lineTo(x, y)
        }
        ctx!.strokeStyle = `rgba(${accent}, ${L.alpha})`
        ctx!.lineWidth = L.w
        ctx!.lineJoin = 'round'
        ctx!.stroke()
      }

      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      // Only tear down OUR graph nodes. The stream itself belongs to
      // MediaRecorder -- stopping its tracks here would kill the recording.
      try {
        source?.disconnect()
        analyser?.disconnect()
        void audioCtx?.close()
      } catch {
        /* already torn down */
      }
    }
  }, [streamRef])

  return <canvas ref={canvasRef} className="micWaveform" aria-hidden="true" />
}
