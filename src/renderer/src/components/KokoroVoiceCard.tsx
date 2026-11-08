import { useEffect, useRef, useState, type JSX } from 'react'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'
import { ProgressBar } from './ProgressBar'

/**
 * Install/remove UI for the free offline voice (Kokoro).
 *
 * Its own component rather than more inline JSX in SettingsApp because the download
 * owns real state: a progress subscription, a derived speed/ETA, and four visible
 * states (unsupported / not installed / downloading / installed).
 *
 * Speed and ETA are derived from a short rolling window instead of the whole
 * download. A ~550MB fetch that starts fast and then throttles would otherwise show
 * an average that stays optimistic for minutes — the number people use to decide
 * "is this stuck?" has to reflect the last few seconds, not the run.
 */

/** Bytes → "412 MB". Whole MB: a decimal on a 550MB download is noise. */
function mb(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`
}

/** Seconds → "2m 40s" / "45s". Undefined while there is no usable rate yet. */
function eta(secs: number | undefined): string {
  if (secs === undefined || !Number.isFinite(secs) || secs <= 0) return ''
  if (secs < 60) return `${Math.round(secs)}s left`
  return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s left`
}

interface Status {
  supported: boolean
  installed: boolean
  enabled: boolean
  hasPayload: boolean
  provider: string
}

/**
 * Payload size, from CONFIG so the copy can never disagree with the artifact.
 * The fallback only covers a build with no payload published yet, where the
 * pitch still has to state a size.
 */
const sizeBytes = CONFIG.COMPANION.KOKORO_DOWNLOAD.sizeBytes || 549_000_000

export function KokoroVoiceCard(): JSX.Element | null {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [freed, setFreed] = useState(0)
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null)
  const [rate, setRate] = useState<number | null>(null)

  // Rolling window of recent samples, for a speed that tracks the last few seconds.
  const samples = useRef<{ t: number; bytes: number }[]>([])

  const refresh = (): void => {
    void window.api.kokoro.status().then(setStatus)
  }

  useEffect(() => {
    refresh()
    const off = window.api.kokoro.onProgress((p) => {
      setProgress({ received: p.receivedBytes, total: p.totalBytes })
      const now = Date.now()
      const s = samples.current
      s.push({ t: now, bytes: p.receivedBytes })
      // Keep ~8s of history; older samples make a stall look like throughput.
      while (s.length > 2 && now - s[0].t > 8000) s.shift()
      const first = s[0]
      const spanMs = now - first.t
      if (spanMs > 1500) setRate(((p.receivedBytes - first.bytes) / spanMs) * 1000)
    })
    return off
  }, [])

  if (!status) return null

  // Intel Macs and non-Macs can't run MLX at all, so offering the install would be
  // a dead end. Say what they get instead rather than showing a disabled button.
  if (!status.supported) {
    return (
      <div className="text-muted text-sm">
        The free voice needs an Apple Silicon Mac. Yours uses the built-in system
        voice, which works everywhere.
      </div>
    )
  }

  const install = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setProgress({ received: 0, total: sizeBytes })
    samples.current = []
    setRate(null)
    const res = await window.api.kokoro.install()
    setBusy(false)
    setProgress(null)
    if (!res.ok) setError(res.error || 'Install failed.')
    refresh()
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    const res = await window.api.kokoro.remove()
    setBusy(false)
    setFreed(res.bytesFreed)
    refresh()
  }

  const pct =
    progress && progress.total ? Math.min(100, (progress.received / progress.total) * 100) : 0
  const remaining = progress && progress.total ? progress.total - progress.received : 0
  const secsLeft = rate && rate > 0 && remaining > 0 ? remaining / rate : undefined

  return (
    <div className="max-w-[380px] flex flex-col gap-3">
      <div className="text-muted text-sm">
        A human-sounding voice that runs on your Mac. No account, no cost, and it
        works offline. Takes about {mb(sizeBytes)} of disk space.
      </div>

      {busy && progress ? (
        <div className="flex flex-col gap-1.5">
          {/* ProgressBar is `flex-1 h-2`, so it MUST sit in a flex ROW. Dropped
              straight into this column, flex-1 resolves against the vertical axis
              (basis 0), beats h-2, and the track renders 0px tall — invisible. */}
          <div className="flex">
            <ProgressBar pct={pct} />
          </div>
          <div className="text-muted text-sm flex gap-2">
            <span>
              {Math.round(pct)}% of {mb(progress.total)}
            </span>
            {rate && rate > 0 ? <span>{mb(rate)}/s</span> : null}
            {eta(secsLeft) ? <span>{eta(secsLeft)}</span> : null}
          </div>
        </div>
      ) : status.installed ? (
        <div className="flex items-center gap-3">
          <span className="text-sm">Installed and ready.</span>
          <Button variant="ghost" onClick={remove} disabled={busy}>
            Remove voice
          </Button>
        </div>
      ) : !status.hasPayload ? (
        // The build has no published payload yet: never show a button that cannot work.
        <div className="text-muted text-sm">
          The free voice isn&apos;t available in this version yet.
        </div>
      ) : (
        <div>
          <Button onClick={install} disabled={busy}>
            Get the free voice
          </Button>
        </div>
      )}

      {/* A paid key wins the ladder, so say so — otherwise installing looks broken. */}
      {status.installed && status.provider === 'elevenlabs' ? (
        <div className="text-muted text-sm">
          Your ElevenLabs key is being used instead. Remove the key to use this voice.
        </div>
      ) : null}

      {freed > 0 ? <div className="text-muted text-sm">Freed {mb(freed)}.</div> : null}
      {error ? (
        <div className="text-sm" style={{ color: 'var(--red-light)' }}>
          {error}
        </div>
      ) : null}
    </div>
  )
}
