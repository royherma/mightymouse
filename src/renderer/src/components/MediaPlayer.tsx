import { JSX, useEffect, useRef, useState, useCallback } from 'react'
import { Play, Pause } from 'lucide-react'
import { Button } from './Button'

/**
 * MediaPlayer — a custom audio/video player with a real waveform scrubber, used
 * in the Media Library Detail panel. Replaces the native <audio controls> /
 * <video controls> chrome (the "ugly QuickTime" look) with a branded, scrub-by-
 * waveform bar so the user can SEE the audio and click anywhere to seek.
 *
 * This is a SEPARATE component from WaveformViz (which is the LIVE mic-tap canvas
 * for the recording HUD). Don't merge them: this one decodes a finished FILE into
 * static peaks; that one animates a real-time AnalyserNode. Different jobs.
 *
 * How the waveform is drawn: the MAIN process decodes the file (ffmpeg → raw PCM)
 * into N normalized peak bars and hands them over IPC (`window.api.mediaWaveform`).
 * We do NOT decode in the renderer — a cross-origin fetch() from http://localhost
 * to our custom media:// scheme is rejected by CORS even with the right headers
 * (the scheme is opaque to fetch), so renderer-side Web Audio decode never gets
 * the bytes. The <audio>/<video> ELEMENT streams over media:// just fine; only
 * fetch/XHR is blocked. Main-side decode sidesteps the whole problem.
 *
 * Played-past bars use the accent color, upcoming bars a muted color, so the
 * canvas IS the progress bar. Click / drag on it to seek. Empty peaks (no audio
 * track / decode failed) → a flat idle strip that still scrubs.
 *
 * Video: the <video> element renders above the scrubber (no native controls), and
 * the same waveform bar scrubs it. Recordings thus get the exact same control as
 * dictation, just with the picture on top.
 */

const BAR_GAP = 2 // px gap between bars

export function fmt(s: number): string {
  if (!isFinite(s) || s < 0) s = 0
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function WaveformBar({
  peaks,
  progress,
  onSeek
}: {
  peaks: number[] | null
  progress: number // 0..1
  onSeek: (frac: number) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // Bump to force a repaint when the container resizes (panel open / window resize).
  const [tick, setTick] = useState(0)

  // Paint the bars: accent for played, muted for upcoming. Re-runs on peaks /
  // progress change and on resize (tick). Reads CSS size at paint time so the
  // bars always span the full current width — no stale 0-width first paint.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const cssW = wrap.clientWidth || 240
    const cssH = wrap.clientHeight || 48
    canvas.width = cssW * dpr
    canvas.height = cssH * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    // Upcoming bars use --muted, NOT surface3 - that's near-white and washes out.
    const styles = getComputedStyle(document.documentElement)
    const played = styles.getPropertyValue('--on-surface').trim() || 'rgb(28,26,24)'
    const rest = styles.getPropertyValue('--muted').trim() || 'rgb(100,96,90)'

    const bars = peaks && peaks.length ? peaks : new Array(64).fill(0.5) // flat fallback strip
    const slot = cssW / bars.length
    const barW = Math.max(2, slot - BAR_GAP)
    const mid = cssH / 2
    const playedX = progress * cssW

    for (let i = 0; i < bars.length; i++) {
      const x = i * slot
      // Floor each bar so quiet passages still show a tick; use the full height.
      const h = Math.max(3, (0.12 + bars[i] * 0.88) * (cssH - 2))
      ctx.fillStyle = x + barW / 2 < playedX ? played : rest
      ctx.globalAlpha = x + barW / 2 < playedX ? 1 : 0.55
      ctx.beginPath()
      ctx.roundRect?.(x, mid - h / 2, barW, h, 1.5)
      if (!ctx.roundRect) ctx.rect(x, mid - h / 2, barW, h)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }, [peaks, progress, tick])

  // Repaint when the bar's box changes size (detail panel mount, window resize).
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => setTick((t) => t + 1))
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      onSeek(frac)
    },
    [onSeek]
  )

  // Drag to scrub: track move/up on the window so the drag survives leaving the bar.
  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent): void => seekFromEvent(e.clientX)
    const up = (): void => setDragging(false)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [dragging, seekFromEvent])

  return (
    <div
      ref={wrapRef}
      onMouseDown={(e) => {
        setDragging(true)
        seekFromEvent(e.clientX)
      }}
      className="relative w-full h-16 cursor-pointer"
    >
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  )
}

export function MediaPlayer({
  src,
  path,
  kind,
  audioSrc,
  playRequestId,
  playSeekFrac,
  onProgress
}: {
  /** media:// URL the <audio>/<video> element streams (the picture, for video). */
  src: string
  /** Absolute file path — main decodes this into waveform peaks over IPC. */
  path: string
  kind: 'audio' | 'video'
  /**
   * Separate audio track to play in sync with the video. Screen recordings save
   * a SILENT screen.mp4 + a sibling audio.wav, so the video alone has no sound —
   * we mute the video and play this wav locked to the video's clock. Omit for
   * dictation (the audio element itself is the sound).
   */
  audioSrc?: string
  playRequestId?: number
  playSeekFrac?: number
  onProgress?: (state: { cur: number; dur: number; playing: boolean }) => void
}): JSX.Element {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null) // sidecar audio track (video only)
  // StrictMode runs the play-request effect twice in dev; a second toggle would pause what the first started.
  const toggledFor = useRef<number | null>(null)
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)

  // Decode peaks in main (ffmpeg) once per file. Renderer can't fetch media://.
  useEffect(() => {
    let live = true
    setPeaks(null)
    void window.api.mediaWaveform(path).then((p) => {
      if (live) setPeaks(p)
    })
    return () => {
      live = false
    }
  }, [src])

  // Keep cur/dur/playing in sync with the master media element (video, or the
  // lone audio for dictation).
  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    const report = (): void =>
      onProgress?.({ cur: el.currentTime, dur: el.duration || 0, playing: !el.paused })
    const onTime = (): void => {
      setCur(el.currentTime)
      report()
    }
    const onMeta = (): void => {
      setDur(el.duration || 0)
      report()
    }
    const onPlay = (): void => {
      setPlaying(true)
      report()
    }
    const onPause = (): void => {
      setPlaying(false)
      report()
    }
    const onEnd = (): void => {
      setPlaying(false)
      report()
    }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnd)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnd)
    }
  }, [src, onProgress])

  // Defined on mount toggles immediately - pass undefined unless a play was asked for.
  useEffect(() => {
    if (playRequestId == null) return
    const el = mediaRef.current
    if (!el) return
    if (playSeekFrac == null) {
      if (toggledFor.current === playRequestId) return
      toggledFor.current = playRequestId
      if (el.paused) void el.play().catch(() => {})
      else el.pause()
      return
    }
    const playFromSpot = (): void => {
      el.currentTime = playSeekFrac * el.duration
      void el.play().catch(() => {})
    }
    if (el.duration) return playFromSpot()
    el.addEventListener('loadedmetadata', playFromSpot, { once: true })
    return () => el.removeEventListener('loadedmetadata', playFromSpot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playRequestId])

  // Sidecar sync: mirror the master's play/pause onto the audio element so the
  // mic track plays with the (muted) video. timeupdate also nudges drift back.
  useEffect(() => {
    const a = audioRef.current
    const v = mediaRef.current
    if (!a || !v || !audioSrc) return
    const onPlay = (): void => {
      a.currentTime = v.currentTime
      void a.play().catch(() => {})
    }
    const onPause = (): void => a.pause()
    const onSeeking = (): void => {
      a.currentTime = v.currentTime
    }
    const onTime = (): void => {
      // Re-anchor if the two drift more than ~150ms (decode hiccups, tab throttle).
      if (Math.abs(a.currentTime - v.currentTime) > 0.15) a.currentTime = v.currentTime
    }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('seeking', onSeeking)
    v.addEventListener('timeupdate', onTime)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('seeking', onSeeking)
      v.removeEventListener('timeupdate', onTime)
    }
  }, [audioSrc, src])

  const toggle = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }, [])

  const seek = useCallback(
    (frac: number) => {
      const el = mediaRef.current
      if (!el || !el.duration) return
      el.currentTime = frac * el.duration
      setCur(el.currentTime)
      const a = audioRef.current
      if (a) a.currentTime = el.currentTime
    },
    []
  )

  const progress = dur > 0 ? cur / dur : 0

  // Full-width waveform on its own row; play button + time labels underneath it.
  const controls = (
    <div
      className="flex flex-col gap-2 px-3 py-3 rounded-xl"
      style={{ background: 'var(--surface2)', border: '1px solid var(--surface3)' }}
    >
      <WaveformBar peaks={peaks} progress={progress} onSeek={seek} />
      <div className="flex items-center gap-3">
        <Button
          variant="bare"
          onClick={toggle}
          className="flex items-center justify-center w-9 h-9 rounded-full shrink-0"
          style={{ background: 'var(--on-surface)', color: 'var(--bg)' }}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </Button>
        <span className="text-xlg text-muted tabular-nums">{fmt(cur)}</span>
        <div className="flex-1" />
        <span className="text-xlg text-muted tabular-nums">{fmt(dur)}</span>
      </div>
    </div>
  )

  if (kind === 'video') {
    return (
      <div className="flex flex-col gap-2">
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={src}
          playsInline
          // The mp4 is silent; mute it and let the sidecar wav carry the sound so
          // we never double up. If there's no sidecar, unmute (mp4 may have audio).
          muted={!!audioSrc}
          onClick={toggle}
          className="w-full rounded-md border border-surface3 bg-black cursor-pointer"
        />
        {audioSrc && <audio ref={audioRef} src={audioSrc} preload="auto" />}
        {controls}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={src} preload="metadata" />
      {controls}
    </div>
  )
}
