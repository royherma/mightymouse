import { JSX, useEffect, useState, useMemo, useCallback, useRef, memo, type CSSProperties } from 'react'
import {
  Image as ImageIcon,
  Video,
  Mic,
  Search,
  FolderOpen,
  Trash2,
  X,
  ScanText,
  Tag,
  SlidersHorizontal,
  Check,
  Monitor,
  Sparkles,
  Loader2,
  Lock,
  AlertCircle,
  RefreshCw,
  StickyNote,
  Play,
  Pause,
  type LucideIcon
} from 'lucide-react'
import { WindowFrame, LoadingBody } from './WindowFrame'
import { Badge } from './components/Badge'
import { AppIcon } from './components/AppIcon'
import { Switch } from './components/Switch'
import { MediaPlayer } from './components/MediaPlayer'
import { RowWaveform } from './components/RowWaveform'
import { ConfirmDialog } from './components/ConfirmDialog'
import { Button } from './components/Button'
import { CopyButton } from './components/CopyButton'
import { useVirtualList } from './hooks/useVirtualList'
import { useInterval } from './hooks/useInterval'
import { useDebouncedValue } from './hooks/useDebouncedValue'
import { CONFIG } from '../../shared/config'
import type { MediaItem, MediaKind, MediaChatResult } from '../../shared/types'
import { builtDay } from '../../shared/built'

type PlayState = { cur: number; dur: number; playing: boolean }
type ListRow = { kind: 'header'; label: string } | { kind: 'item'; item: MediaItem }

// Row and GroupHeader hard-set these; virtualization depends on them matching.
const ROW_H = 84
const HEADER_H = 34
const LIST_OVERSCAN = 16

// ── Kind metadata: one home for icon / label / token color per capture kind ───
const KIND_META: Record<MediaKind, { label: string; color: string; icon: LucideIcon }> = {
  screenshot: { label: 'Screenshot', color: 'cyan', icon: ImageIcon },
  recording: { label: 'Recording', color: 'blue', icon: Video },
  listen: { label: 'Dictation', color: 'violet', icon: Mic }
}

// One home for the media-chat failure copy, keyed by the typed error union so a new
// error variant won't compile until it has a message (see Voice & copy in CLAUDE.md).
const CHAT_ERROR_MSG: Record<NonNullable<MediaChatResult['error']>, string> = {
  timeout: 'That took too long. Try a shorter question.',
  oom_credits: "You've used all your usage. Upgrade or add extra usage to keep asking.",
  failed: 'Something went wrong. Try again.'
}

// Type filter = all + the three kinds. 'all' isn't a MediaKind so it lives here.
type TypeFilter = 'all' | MediaKind
const TYPE_FILTERS: ReadonlyArray<{ id: TypeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'screenshot', label: 'Screenshots' },
  { id: 'recording', label: 'Recordings' },
  { id: 'listen', label: 'Dictation' }
]

type SortKey = 'newest' | 'oldest' | 'longest' | 'largest'
const SORTS: ReadonlyArray<{ id: SortKey; label: string }> = [
  { id: 'newest', label: 'Newest' },
  { id: 'oldest', label: 'Oldest' },
  { id: 'longest', label: 'Longest' },
  { id: 'largest', label: 'Largest' }
]

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtDur(s?: number): string {
  if (s == null) return '—'
  if (s < 60) return `${Math.round(s)}s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

function fmtSize(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtTime(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
}

// Local YYYY-MM-DD for the <input type="date"> filter (toISOString would shift TZ).
function localDateKey(iso: string): string {
  const d = new Date(iso)
  const off = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - off).toISOString().slice(0, 10)
}

// Gate heavy media (<img>/<video>) on actual viewport visibility. Virtualization
// already keeps off-screen rows unmounted, but a fast scroll still flickers many
// rows through the DOM — this stops each from firing a media:// fetch until it's
// genuinely visible. Returns false until the element intersects, then sticks true.
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin: '120px' } // warm up just before it scrolls in
    )
    io.observe(el)
    return () => io.disconnect()
  }, [ref, seen])
  return seen
}

// ── Hover thumbnail: image shows, video autoplays muted while hovered ──────────
// Lazy: the real <img>/<video> only mounts once the tile scrolls on-screen.
function Thumb({ item }: { item: MediaItem }): JSX.Element {
  const [hover, setHover] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const visible = useOnScreen(boxRef)
  const Meta = KIND_META[item.kind]

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (hover) void v.play().catch(() => {})
    else {
      v.pause()
      v.currentTime = 0
    }
  }, [hover])

  const box =
    'relative w-16 h-12 rounded-sm overflow-hidden shrink-0 flex items-center justify-center'

  if (item.kind === 'screenshot' && item.imagePath) {
    return (
      <div ref={boxRef} className={box} style={{ background: 'var(--surface2)' }}>
        {visible && (
          <img
            src={window.api.mediaUrl(item.imagePath)}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover"
            alt=""
          />
        )}
      </div>
    )
  }

  if (item.kind === 'recording' && item.videoPath) {
    return (
      <div
        ref={boxRef}
        className={box}
        style={{ background: 'var(--surface2)' }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {visible && (
          <video
            ref={videoRef}
            src={window.api.mediaUrl(item.videoPath)}
            muted
            loop
            playsInline
            preload="metadata"
            className="w-full h-full object-cover"
          />
        )}
        {!hover && <Video size={16} className="absolute text-on-surface opacity-80" />}
      </div>
    )
  }

  // Dictation (or a recording without video) → kind glyph on a tinted tile.
  return (
    <div ref={boxRef} className={box} style={{ background: `var(--${Meta.color}-bg-subtle)` }}>
      <Meta.icon size={18} style={{ color: `var(--${Meta.color})` }} />
    </div>
  )
}

// ── Detail panel (right side, when a row is selected) ──────────────────────────
function Detail({
  item,
  enriching,
  retranscribing,
  retranscribeError,
  onClose,
  onReveal,
  onDelete,
  onEnrich,
  onRetranscribe,
  playRequestId,
  playSeekFrac,
  onProgress
}: {
  item: MediaItem
  enriching: boolean
  retranscribing: boolean
  retranscribeError?: string
  onClose: () => void
  onReveal: () => void
  onDelete: () => void
  onEnrich: () => void
  onRetranscribe: () => void
  playRequestId?: number
  playSeekFrac?: number
  onProgress: (state: PlayState) => void
}): JSX.Element {
  const Meta = KIND_META[item.kind]
  const { date, time } = fmtTime(item.ts)
  const tags = item.insights?.tags ?? []
  const ocrText = item.insights?.ocrText
  // Video OCR is the heavy path — opt in via a button. Other kinds auto-enrich.
  const canExtractVideo = item.kind === 'recording' && !!item.videoPath

  return (
    <div className="flex flex-col h-full border-l border-surface3 bg-surface1">
      <div className="flex items-center justify-between px-4 h-11 border-b border-surface2 shrink-0">
        <Badge color={Meta.color}>
          <Meta.icon size={12} /> {Meta.label}
        </Badge>
        <Button
          variant="bare"
          onClick={onClose}
          className="p-1 rounded hover:bg-surface2 text-muted"
          aria-label="Close preview"
        >
          <X size={16} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {/* Media preview */}
        {item.imagePath && (
          <img
            src={window.api.mediaUrl(item.imagePath)}
            className="w-full rounded-md border border-surface3"
            alt="Screenshot"
          />
        )}
        {item.videoPath && (
          <MediaPlayer
            src={window.api.mediaUrl(item.videoPath)}
            // The screen.mp4 is video-only (silent) — the mic audio lives in a
            // sibling audio.wav. Decode the waveform from the wav AND play it in
            // sync with the muted video so you hear the mic. Falls back to the
            // mp4 alone if there's no separate audio track.
            path={item.audioPath ?? item.videoPath}
            audioSrc={item.audioPath ? window.api.mediaUrl(item.audioPath) : undefined}
            kind="video"
            playRequestId={playRequestId}
            playSeekFrac={playSeekFrac}
            onProgress={onProgress}
          />
        )}
        {item.audioPath && !item.videoPath && (
          <MediaPlayer
            src={window.api.mediaUrl(item.audioPath)}
            path={item.audioPath}
            kind="audio"
            playRequestId={playRequestId}
            playSeekFrac={playSeekFrac}
            onProgress={onProgress}
          />
        )}

        {/* Meta */}
        <div className="text-sm text-on-surface">
          <div className="font-semibold">{date}</div>
          <div className="text-muted">{time}</div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xlg text-muted">
          {item.durationS != null && <span>Duration {fmtDur(item.durationS)}</span>}
          {item.wordCount != null && <span>{item.wordCount} words</span>}
          <span>{fmtSize(item.sizeBytes)}</span>
        </div>

        {/* The note the user left on this capture (why they grabbed it). Joined from
            the feedback store by run_id — high-signal user intent, shown up top. */}
        {item.note && (
          <div>
            <div className="flex items-center gap-1 text-xlg text-muted font-semibold uppercase tracking-wide mb-1">
              <StickyNote size={11} /> Note
            </div>
            <div className="text-sm text-on-surface whitespace-pre-wrap leading-relaxed bg-surface2 rounded-md p-3 border border-surface3">
              {item.note}
            </div>
          </div>
        )}

        {item.frontApp && (
          <div className="flex items-center gap-2 text-xlg text-muted">
            <AppIcon app={item.frontApp} size={16} />
            <span className="min-w-0">
              <span className="font-semibold text-on-surface">{item.frontApp}</span>
              {item.windowTitle ? ` · ${item.windowTitle}` : ''}
            </span>
          </div>
        )}
        {item.browserUrl && (
          <div className="text-xlg text-muted break-all">{item.browserUrl}</div>
        )}

        {/* Tags (keyword chips) */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xlg"
                style={{ background: 'var(--surface2)', color: 'var(--muted)' }}
              >
                <Tag size={10} /> {t}
              </span>
            ))}
          </div>
        )}

        {enriching && (
          <div className="flex items-center gap-2 text-xlg text-muted">
            <span className="w-3 h-3 rounded-full border-2 border-surface3 border-t-accent animate-spin" />
            Reading on-screen text…
          </div>
        )}

        {/* Shown whenever there's audio, even with no transcript — a capture that
            transcribed to nothing is exactly the one you want to re-run. */}
        {item.audioPath && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xlg text-muted font-semibold uppercase tracking-wide">
                Transcript
              </div>
              <div className="flex items-center gap-1">
                {item.transcript && <CopyButton showLabel text={item.transcript} />}
                <Button
                  variant="bare"
                  onClick={onRetranscribe}
                  disabled={retranscribing}
                  className="flex items-center gap-1 text-xlg px-2 py-1 rounded text-muted hover:bg-surface2 hover:text-on-surface disabled:cursor-default disabled:opacity-60"
                  title="Run transcription again on this audio"
                >
                  {retranscribing ? (
                    <span className="w-3 h-3 rounded-full border-2 border-surface3 border-t-accent animate-spin" />
                  ) : (
                    <RefreshCw size={11} />
                  )}
                  {retranscribing ? 'Transcribing…' : 'Re-transcribe'}
                </Button>
              </div>
            </div>
            <div className="text-sm whitespace-pre-wrap leading-relaxed bg-surface2 rounded-md p-3 border border-surface3">
              {item.transcript ? (
                <span className="text-on-surface">{item.transcript}</span>
              ) : (
                <span className="text-muted italic">No transcript.</span>
              )}
            </div>
            {retranscribeError && (
              <div className="text-xlg mt-1" style={{ color: 'var(--red)' }}>
                {retranscribeError}
              </div>
            )}
          </div>
        )}

        {/* Transcript with no audio file (legacy capture) — nothing to re-run. */}
        {item.transcript && !item.audioPath && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xlg text-muted font-semibold uppercase tracking-wide">
                Transcript
              </div>
              <CopyButton showLabel text={item.transcript} />
            </div>
            <div className="text-sm text-on-surface whitespace-pre-wrap leading-relaxed bg-surface2 rounded-md p-3 border border-surface3">
              {item.transcript}
            </div>
          </div>
        )}

        {/* OCR'd on-screen text */}
        {ocrText && (
          <div>
            <div className="text-xlg text-muted font-semibold uppercase tracking-wide mb-1">
              On-screen text{item.insights?.framesOcr ? ` · ${item.insights.framesOcr} frames` : ''}
            </div>
            <div className="text-sm text-on-surface whitespace-pre-wrap leading-relaxed bg-surface2 rounded-md p-3 border border-surface3 max-h-60 overflow-y-auto">
              {ocrText}
            </div>
          </div>
        )}

        {/* Video: explicit opt-in to the heavy frame-OCR pass */}
        {canExtractVideo && !ocrText && !enriching && (
          <Button
            variant="secondary" size="lg"
            onClick={onEnrich}
          >
            <ScanText size={14} /> Extract on-screen text
          </Button>
        )}
      </div>

      <div className="flex gap-2 p-3 border-t border-surface2 shrink-0">
        <Button
          variant="secondary" size="lg"
          onClick={onReveal}
          className="flex-1"
        >
          <FolderOpen size={14} /> Open folder
        </Button>
        <Button
          variant="bare"
          onClick={onDelete}
          className="flex items-center justify-center gap-1.5 text-sm py-2 px-3 rounded-md"
          style={{ background: 'var(--red-bg-subtle)', color: 'var(--red)' }}
        >
          <Trash2 size={14} /> Delete
        </Button>
      </div>
    </div>
  )
}

/**
 * Fill in missing per-row data for the rows on screen, one call at a time. Each call
 * can spawn ffmpeg/OCR in main, so this must never fan out across the whole list.
 */
function useVisibleBackfill(
  visible: MediaItem[],
  needs: (it: MediaItem) => boolean,
  fetch: (it: MediaItem) => Promise<void>
): void {
  const asked = useRef<Set<string>>(new Set())
  const queue = useRef<MediaItem[]>([])
  const busy = useRef(false)

  useEffect(() => {
    queue.current = visible.filter((it) => needs(it) && !asked.current.has(it.folder))
    if (busy.current) return
    busy.current = true
    void (async () => {
      // Never cancel on re-render: each merge re-renders, and a dropped result is never re-asked.
      for (let it = queue.current.shift(); it; it = queue.current.shift()) {
        if (asked.current.has(it.folder)) continue
        asked.current.add(it.folder)
        await fetch(it).catch(() => undefined)
      }
      busy.current = false
    })()
  }, [visible, needs, fetch])
}

const needsWaveform = (it: MediaItem): boolean => !it.waveform && !!(it.audioPath || it.videoPath)
const needsInsights = (it: MediaItem): boolean =>
  !it.insights && (it.kind === 'screenshot' || it.kind === 'listen')

const ROW_TAGS = 3
const waveBarsFor = (listWidth: number): number =>
  listWidth >= 1040 ? 64 : listWidth >= 760 ? 48 : 32

// ── Row ────────────────────────────────────────────────────────────────────────
// memo + folder-arg callbacks: a background enrich/waveform merge touches ONE item,
// so the other visible rows must compare equal and skip. Inline `() => ...` props
// would defeat the memo on every render.
const Row = memo(function Row({
  item,
  selected,
  active,
  playState,
  waveBars,
  onSelect,
  onRequestPlay,
  onRequestDelete
}: {
  item: MediaItem
  selected: boolean
  active: boolean
  playState: PlayState | null
  waveBars: number
  onSelect: (folder: string) => void
  onRequestPlay: (folder: string, seekFrac?: number) => void
  onRequestDelete: (item: MediaItem) => void
}): JSX.Element {
  const { time } = fmtTime(item.ts)
  const preview = item.transcript || item.windowTitle || item.frontApp || '—'
  const hasMedia = !!(item.audioPath || item.videoPath)
  const playing = active && !!playState?.playing
  const tags = item.insights?.tags ?? []
  const seek = useCallback(
    (frac: number) => onRequestPlay(item.folder, frac),
    [onRequestPlay, item.folder]
  )

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item.folder)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || (e.key === ' ' && !hasMedia)) {
          e.preventDefault()
          onSelect(item.folder)
        } else if (e.key === ' ') {
          e.preventDefault()
          onRequestPlay(item.folder)
        }
      }}
      style={{ height: ROW_H }}
      className={`group w-full flex items-start gap-3.5 px-3 py-2 rounded-md text-left cursor-pointer border-0 outline-none transition-colors duration-150 motion-reduce:transition-none focus-visible:shadow-focus ${
        selected || playing
          ? 'bg-surface2'
          : 'hover:bg-[color-mix(in_srgb,var(--surface2)_55%,transparent)] active:bg-surface2'
      }`}
    >
      <span className="w-[72px] shrink-0 pt-0.5 text-sm font-semibold text-on-surface tabular-nums whitespace-nowrap">
        {time}
      </span>
      <div className="min-w-0 flex-1">
        <div className="max-w-[760px]">
          <p className="text-sm leading-snug text-on-surface line-clamp-2 m-0">{preview}</p>
          <div className="flex items-center gap-2.5 mt-1.5 min-w-0 overflow-hidden text-xs text-muted">
            {item.frontApp && (
              <span className="flex items-center gap-1.5 shrink-0">
                <AppIcon app={item.frontApp} size={12} />
                {item.frontApp}
              </span>
            )}
            {tags.slice(0, ROW_TAGS).map((t) => (
              <span
                key={t}
                className="px-1.5 py-0.5 rounded text-[11px] shrink-0 whitespace-nowrap"
                style={{ background: 'var(--surface3)' }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
      {hasMedia && (
        <div className="flex items-center gap-3 shrink-0 self-center">
          <RowWaveform
            peaks={item.waveform ?? []}
            bars={waveBars}
            color={`var(--${KIND_META[item.kind].color})`}
            cur={playing ? playState?.cur : undefined}
            dur={(active && playState?.dur) || item.durationS}
            onSeek={seek}
          />
          <Button
            variant="bare"
            onClick={(e) => {
              e.stopPropagation()
              onRequestPlay(item.folder)
            }}
            aria-label={playing ? 'Pause' : 'Play'}
            className={`relative flex items-center justify-center w-8 h-8 rounded-full shrink-0 transition-[transform,background-color,color,box-shadow] duration-150 motion-reduce:transition-none active:scale-95 before:absolute before:-inset-1.5 before:content-[''] ${
              playing
                ? 'bg-on-surface text-bg'
                : 'text-muted shadow-[inset_0_0_0_1px_var(--border-dark)] group-hover:bg-on-surface group-hover:text-bg group-hover:shadow-none'
            }`}
          >
            {playing ? (
              <Pause size={13} fill="currentColor" />
            ) : (
              <Play size={13} fill="currentColor" className="translate-x-px" />
            )}
          </Button>
        </div>
      )}
      <Button
        variant="bare"
        onClick={(e) => {
          e.stopPropagation()
          onRequestDelete(item)
        }}
        aria-label="Delete capture"
        title="Delete"
        className="shrink-0 self-center p-1 rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-red"
      >
        <Trash2 size={14} />
      </Button>
    </div>
  )
})

// ── Source card (under a chat answer) ──────────────────────────────────────────
// Compact, fixed-width, clickable card for a cited capture. Click → opens the
// detail pane. Lives in a horizontal-scroll row so several fit without stealing
// the answer's vertical space.
function SourceCard({
  item,
  selected,
  onSelect
}: {
  item: MediaItem
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const Meta = KIND_META[item.kind]
  const { date, time } = fmtTime(item.ts)

  return (
    <Button
      variant="bare"
      onClick={onSelect}
      style={{
        background: 'var(--surface1)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--surface3)'}`
      }}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-left shrink-0 w-52 transition-colors hover:bg-surface2"
      title={item.transcript || item.windowTitle || item.frontApp || Meta.label}
    >
      <Thumb item={item} />
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Meta.icon size={12} style={{ color: `var(--${Meta.color})` }} />
          {item.frontApp && <AppIcon app={item.frontApp} size={12} />}
          <span className="text-xlg font-semibold text-on-surface truncate">{date}</span>
        </div>
        <span className="text-[10px] text-muted truncate mt-0.5">
          {time}
          {item.durationS != null && ` · ${fmtDur(item.durationS)}`}
        </span>
      </div>
    </Button>
  )
}

// ── Filter + sort popover (top-right) ──────────────────────────────────────────
// Collapses type filter, sort, and date into one pop-over so the list gets the
// full window height. The trigger shows a dot when any non-default filter is on.
function FilterMenu({
  type,
  setType,
  sort,
  setSort,
  day,
  setDay,
  apps,
  app,
  setApp,
  osOn,
  setOsOn
}: {
  type: TypeFilter
  setType: (t: TypeFilter) => void
  sort: SortKey
  setSort: (s: SortKey) => void
  day: string
  setDay: (d: string) => void
  apps: ReadonlyArray<{ name: string; count: number }>
  app: string // '' = any app
  setApp: (a: string) => void
  osOn: boolean
  setOsOn: (on: boolean) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const active = type !== 'all' || sort !== 'newest' || day !== '' || app !== ''

  // Click-outside / Esc to close.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const Section = ({ label, children }: { label: string; children: JSX.Element }): JSX.Element => (
    <div className="flex flex-col gap-1.5">
      <span className="text-xlg text-muted font-semibold uppercase tracking-wide">{label}</span>
      {children}
    </div>
  )

  const Choice = <T extends string>({
    items,
    value,
    onPick
  }: {
    items: ReadonlyArray<{ id: T; label: string }>
    value: T
    onPick: (id: T) => void
  }): JSX.Element => (
    <div className="flex flex-col">
      {items.map((it) => (
        <Button
          variant="bare"
          key={it.id}
          onClick={() => onPick(it.id)}
          className="flex items-center justify-between px-2 py-1.5 rounded text-sm hover:bg-surface2 text-on-surface text-left"
        >
          {it.label}
          {value === it.id && <Check size={14} style={{ color: 'var(--accent)' }} />}
        </Button>
      ))}
    </div>
  )

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="secondary" size="lg"
        onClick={() => setOpen((o) => !o)}
        className="relative"
      >
        <SlidersHorizontal size={14} /> Filter
        {active && (
          <span
            className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full"
            style={{ background: 'var(--accent)' }}
          />
        )}
      </Button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 z-20 w-60 rounded-lg p-3 flex flex-col gap-3 max-h-[70vh] overflow-y-auto"
          style={{
            background: 'var(--surface1)',
            border: '1px solid var(--surface3)',
            boxShadow: 'var(--shadow-card)'
          }}
        >
          <Section label="Sources">
            <label className="flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm cursor-pointer text-on-surface">
              <span className="flex flex-col min-w-0">
                <span className="flex items-center gap-2">
                  <Monitor size={14} className="text-muted" /> System screenshots
                </span>
                <span className="text-xlg text-muted">Your Mac's own screenshots & recordings</span>
              </span>
              <Switch on={osOn} onChange={setOsOn} />
            </label>
          </Section>
          <div className="border-t border-surface2" />
          <Section label="Type">
            <Choice items={TYPE_FILTERS} value={type} onPick={setType} />
          </Section>
          <div className="border-t border-surface2" />
          <Section label="Sort">
            <Choice items={SORTS} value={sort} onPick={setSort} />
          </Section>
          <div className="border-t border-surface2" />
          <Section label="Date">
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={day}
                onChange={(e) => setDay(e.target.value)}
                className="flex-1 text-xlg px-2 py-1.5 rounded-md bg-surface2 border border-surface3 text-on-surface cursor-pointer"
              />
              {day && (
                <Button
                  variant="bare"
                  onClick={() => setDay('')}
                  className="text-xlg text-muted"
                >
                  Clear
                </Button>
              )}
            </div>
          </Section>
          {apps.length > 0 && (
            <>
              <div className="border-t border-surface2" />
              <Section label="App">
                <div className="flex flex-col max-h-52 overflow-y-auto">
                  <Button
                    variant="bare"
                    onClick={() => setApp('')}
                    className="flex items-center justify-between px-2 py-1.5 rounded text-sm hover:bg-surface2 text-on-surface text-left"
                  >
                    <span className="flex items-center gap-2">
                      <Monitor size={14} className="text-muted" /> All apps
                    </span>
                    {app === '' && <Check size={14} style={{ color: 'var(--accent)' }} />}
                  </Button>
                  {apps.map((a) => (
                    <Button
                      variant="bare"
                      key={a.name}
                      onClick={() => setApp(a.name)}
                      className="flex items-center justify-between px-2 py-1.5 rounded text-sm hover:bg-surface2 text-on-surface text-left"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <AppIcon app={a.name} size={16} />
                        <span className="truncate">{a.name}</span>
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className="text-xlg text-muted">{a.count}</span>
                        {app === a.name && <Check size={14} style={{ color: 'var(--accent)' }} />}
                      </span>
                    </Button>
                  ))}
                </div>
              </Section>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── App ──────────────────────────────────────────────────────────────────────
/**
 * The Media Library itself — list, search, filters, detail panel. No window chrome,
 * so it mounts either inside the standalone window or as the composer's Library tab.
 * Fills its parent (flex-1/min-h-0); the parent owns the height.
 */
export function MediaLibraryBody({
  focusRequest,
  style = { height: 'calc(100vh - 2.75rem)' }
}: {
  /** Root style — must carry a BOUNDED height. The inner list
   *  virtualizes off its scroll container's clientHeight, so an unbounded parent makes
   *  the container grow to the full list, the viewport measure the whole list, and the
   *  page scroll as one giant block (tab bar included). Defaults to the standalone
   *  window's chrome offset; the composer passes its own tab-bar offset. */
  style?: CSSProperties
  /** Capture to select, set by whoever owns the routing (the composer's Library tab,
   *  or the standalone window's own query-param read). A NEW object re-selects even
   *  when it names the same folder — that's why it isn't a bare string. */
  focusRequest?: { folder: string } | null
} = {}): JSX.Element {
  const [items, setItems] = useState<MediaItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [type, setType] = useState<TypeFilter>('all')
  const [sort, setSort] = useState<SortKey>('newest')
  const [day, setDay] = useState('') // YYYY-MM-DD or '' for any date
  const [app, setApp] = useState('') // frontApp name or '' for any app
  const [osOn, setOsOnState] = useState(false) // include the user's macOS screenshots
  // Seeded from the initial focus request so a capture opened from its HUD card is
  // already selected on first paint — no flash of an unselected list.
  const [selected, setSelected] = useState<string | null>(focusRequest?.folder ?? null)
  const [enriching, setEnriching] = useState<string | null>(null) // folder being enriched
  const [retranscribing, setRetranscribing] = useState<string | null>(null)
  const [retranscribeError, setRetranscribeError] = useState<{ folder: string; message: string } | null>(null)
  // Chat-with-media: Enter on a question answers from the captures (vs. typing, which
  // filters live). `chat` holds the last answered question + result; null = filter mode.
  const [chat, setChat] = useState<{ q: string; result: MediaChatResult } | null>(null)
  const [chatLoading, setChatLoading] = useState(false)

  const load = useCallback(() => {
    void window.api.mediaList().then((next) => {
      setItems((prev) => {
        if (!prev) return next
        // Skip the state swap when the capture set is identical (the common poll
        // case) so we don't re-render the list or clobber an in-place enrich merge.
        // Keys are folder paths; same set + same order = nothing changed.
        if (prev.length === next.length && prev.every((it, i) => it.folder === next[i].folder)) {
          return prev
        }
        // Set changed (capture added/removed). Carry over any enrichment we merged
        // locally for folders that still exist — the scan doesn't always re-read it.
        const enriched = new Map(prev.filter((it) => it.insights).map((it) => [it.folder, it.insights]))
        return next.map((it) => (enriched.has(it.folder) ? { ...it, insights: enriched.get(it.folder) } : it))
      })
    })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Restore the OS-screenshots toggle from the persisted pref on open.
  useEffect(() => {
    void window.api.mediaGetOsScreenshots().then(setOsOnState)
  }, [])

  // A later focus request (HUD card clicked while the Library is already mounted)
  // selects that capture. Re-list too: a just-finished recording usually isn't in
  // the current list yet. Skips the first run — useState already seeded it.
  const seededFocus = useRef(focusRequest)
  useEffect(() => {
    if (!focusRequest || focusRequest === seededFocus.current) return
    setSelected(focusRequest.folder)
    load()
  }, [focusRequest, load])

  // Persist the toggle, then re-scan so OS items appear/disappear immediately.
  // Flip local state first (snappy switch); the re-list reflects the new source.
  const setOsOn = useCallback(
    (on: boolean) => {
      setOsOnState(on)
      void window.api.mediaSetOsScreenshots(on).then(load)
    },
    [load]
  )

  // Auto-refresh so captures made while the window is open show up on their own.
  // `load()` swaps the whole list, but `selected`/`current` key off `folder`, so
  // a refresh never loses the open item or the scroll position. Poll on a slow
  // interval + re-pull on focus (the common case: record, then click back here).
  useInterval(load, CONFIG.MEDIA_REFRESH_MS)
  useEffect(() => {
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])

  // Merge decoded peaks into the row so it repaints with its waveform.
  const applyPeaks = useCallback((folder: string, peaks: number[]) => {
    setItems(
      (prev) => prev?.map((it) => (it.folder === folder ? { ...it, waveform: peaks } : it)) ?? null
    )
  }, [])

  // Merge a background-enriched row into state. Separate from `enrich` because it
  // deliberately never sets `enriching` — the backfill must stay invisible.
  const applyInsights = useCallback((folder: string, updated: MediaItem) => {
    setItems((prev) => prev?.map((it) => (it.folder === folder ? updated : it)) ?? null)
  }, [])

  // Compute (or read cached) free local enrichment for one capture, merge into state.
  const enrich = useCallback(async (folder: string, force = false) => {
    setEnriching(folder)
    try {
      const updated = await window.api.mediaEnrich(folder, force)
      if (updated) setItems((prev) => prev?.map((it) => (it.folder === folder ? updated : it)) ?? null)
    } finally {
      setEnriching((f) => (f === folder ? null : f))
    }
  }, [])

  // Re-run whisper on one capture and swap in the refreshed row. Keyed by folder
  // like `enriching` so switching selection mid-run can't strand the spinner on
  // the wrong item. The error is per-folder for the same reason.
  const retranscribe = useCallback(async (folder: string) => {
    setRetranscribing(folder)
    setRetranscribeError(null)
    try {
      const res = await window.api.mediaRetranscribe(folder)
      if (res.ok && res.item) {
        setItems((prev) => prev?.map((it) => (it.folder === folder ? res.item! : it)) ?? null)
      } else {
        setRetranscribeError({ folder, message: res.error ?? 'Transcription failed.' })
      }
    } finally {
      setRetranscribing((f) => (f === folder ? null : f))
    }
  }, [])

  // Run a chat turn against the media library. Answered from the user's own captures
  // via the selected backend; the result carries the cited capture folders.
  const runChat = useCallback(async (question: string) => {
    const q = question.trim()
    if (q === '' || chatLoading) return
    setChatLoading(true)
    try {
      const result = await window.api.mediaChatWith(q)
      setChat({ q, result })
    } finally {
      setChatLoading(false)
    }
  }, [chatLoading])

  // Distinct apps present in the captures, most-frequent first, for the filter.
  const apps = useMemo(() => {
    if (!items) return []
    const counts = new Map<string, number>()
    for (const it of items) {
      if (it.frontApp) counts.set(it.frontApp, (counts.get(it.frontApp) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }))
  }, [items])

  // Sorting is order-only, so it runs on the ORDERED set once and the filter runs
  // over that — splitting them means typing a query re-filters without re-sorting
  // 4000+ items, and changing the sort doesn't re-run the keyword scan.
  const sorted = useMemo(() => {
    if (!items) return []
    return [...items].sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return a.ts < b.ts ? -1 : 1
        case 'longest':
          return (b.durationS ?? 0) - (a.durationS ?? 0)
        case 'largest':
          return b.sizeBytes - a.sizeBytes
        default:
          return a.ts < b.ts ? 1 : -1
      }
    })
  }, [items, sort])

  // The input stays on the raw `query` so typing never feels laggy; only the scan
  // over every transcript waits for the typist to settle.
  const settledQuery = useDebouncedValue(query, CONFIG.MEDIA_SEARCH_DEBOUNCE_MS)

  const filtered = useMemo(() => {
    const q = settledQuery.trim().toLowerCase()
    return sorted.filter((it) => {
      if (type !== 'all' && it.kind !== type) return false
      if (app && it.frontApp !== app) return false
      if (day && localDateKey(it.ts) !== day) return false
      if (q) {
        const hay = [
          it.transcript,
          it.frontApp,
          it.windowTitle,
          it.browserUrl,
          KIND_META[it.kind].label,
          it.insights?.ocrText,
          ...(it.insights?.tags ?? [])
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [sorted, settledQuery, type, day, app])

  // Resolve the open item against the FULL set, not the filtered list — a chat
  // source card can be selected while the keyword filter has the list at 0 results,
  // so the detail pane must still find it.
  const current = items?.find((it) => it.folder === selected) ?? null

  // The cited captures as real MediaItems, in ranked order, for the source cards
  // under a chat answer. Built from the full set so they resolve regardless of filter.
  const chatSources = useMemo(() => {
    if (!chat || !items) return []
    const byFolder = new Map(items.map((it) => [it.folder, it]))
    return chat.result.citedFolders.map((f) => byFolder.get(f)).filter((x): x is MediaItem => !!x)
  }, [chat, items])

  // Virtualize: only render the rows in (or near) the viewport.
  const listRows = useMemo((): ListRow[] => {
    if (sort !== 'newest') return filtered.map((item) => ({ kind: 'item', item }))
    const now = Date.now()
    const out: ListRow[] = []
    let last = ''
    for (const item of filtered) {
      const label = builtDay(item.ts, now)
      if (label !== last) out.push({ kind: 'header', label })
      last = label
      out.push({ kind: 'item', item })
    }
    return out
  }, [filtered, sort])
  const rowHeights = useMemo(() => listRows.map((r) => (r.kind === 'header' ? HEADER_H : ROW_H)), [listRows])

  const { scrollRef, onScroll, start, end, totalHeight, offsetY } = useVirtualList<HTMLDivElement>(
    listRows.length,
    rowHeights,
    LIST_OVERSCAN
  )

  // The rows actually on screen. Shared by the render below and the waveform
  // backfill, so peaks are only ever decoded for what the user can see.
  const visibleRows = useMemo(() => listRows.slice(start, end), [listRows, start, end])
  const onScreen = useMemo(
    () => visibleRows.flatMap((r) => (r.kind === 'item' ? [r.item] : [])),
    [visibleRows]
  )

  const [playReq, setPlayReq] = useState<{ folder: string; n: number; seekFrac?: number } | null>(null)
  const [playState, setPlayState] = useState<PlayState | null>(null)
  useEffect(() => setPlayState(null), [selected])
  const selectRow = useCallback((folder: string) => {
    setPlayReq(null)
    setSelected(folder)
  }, [])
  const requestPlay = useCallback((folder: string, seekFrac?: number) => {
    setSelected(folder)
    setPlayReq((p) => ({ folder, n: (p?.n ?? 0) + 1, seekFrac }))
  }, [])

  const [waveBars, setWaveBars] = useState(() => waveBarsFor(0))
  const listObserver = useRef<ResizeObserver | null>(null)
  const listColRef = useCallback((el: HTMLDivElement | null) => {
    listObserver.current?.disconnect()
    if (!el) return
    listObserver.current = new ResizeObserver(([entry]) => setWaveBars(waveBarsFor(entry.contentRect.width)))
    listObserver.current.observe(el)
  }, [])
  const fetchPeaks = useCallback(
    async (it: MediaItem) => {
      const peaks = await window.api.mediaWaveform((it.audioPath || it.videoPath)!)
      if (peaks.length > 0) applyPeaks(it.folder, peaks)
    },
    [applyPeaks]
  )
  useVisibleBackfill(onScreen, needsWaveform, fetchPeaks)

  // Auto-enrich the cheap kinds (screenshot OCR, dictation tags) for the rows on
  // screen, so tags and keyword search are there before the user clicks anything.
  const fetchInsights = useCallback(
    async (it: MediaItem) => {
      const updated = await window.api.mediaEnrich(it.folder, false)
      if (updated) applyInsights(it.folder, updated)
    },
    [applyInsights]
  )
  useVisibleBackfill(onScreen, needsInsights, fetchInsights)

  // Deleting is irreversible for app captures (OS ones go to Trash), so every
  // entry point parks the item here first and the dialog is the only caller of
  // the IPC. `pendingDelete` holds the item so the prompt can name what it is.
  const [pendingDelete, setPendingDelete] = useState<MediaItem | null>(null)

  const handleDelete = useCallback(async (folder: string) => {
    setPendingDelete(null)
    const ok = await window.api.mediaDelete(folder)
    if (ok) {
      setItems((prev) => prev?.filter((it) => it.folder !== folder) ?? null)
      setSelected((s) => (s === folder ? null : s))
    }
  }, [])

  if (!items) return <LoadingBody label="Scanning captures…" />

  return (
    <div className="flex min-h-0" style={style}>
        {/* Left: search + virtualized list */}
        <div ref={listColRef} className="flex flex-col flex-1 min-w-0">
          <div className="p-4 pb-2 flex flex-col gap-2 shrink-0">
            <div className="flex items-center gap-2">
              {/* Search */}
              <div
                className="flex items-center gap-2 px-3 rounded-md flex-1"
                style={{ background: 'var(--surface2)', border: '1px solid var(--surface3)' }}
              >
                <Search size={15} className="text-muted shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && query.trim()) {
                      e.preventDefault()
                      void runChat(query)
                    }
                  }}
                  placeholder="Search what you said, or ask a question about it"
                  className="flex-1 bg-transparent border-0 outline-none py-2.5 text-base text-on-surface placeholder:text-muted"
                />
                {(query || chat) && (
                  <Button
                    variant="bare"
                    onClick={() => {
                      setQuery('')
                      setChat(null)
                    }}
                    className="text-muted p-0.5"
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </Button>
                )}
              </div>
              {/* Ask: answer the typed question from the captures (same as Enter).
                  Mirrors the Filter pill's geometry, accent-filled to read as the
                  primary action. Hidden until there's a question to ask. */}
              {query.trim() && (
                <Button
                  size="lg"
                  onClick={() => void runChat(query)}
                  disabled={chatLoading}
                  aria-label="Ask the media library"
                  title="Ask this question of your captures (Enter)"
                >
                  {chatLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  Ask
                </Button>
              )}
              <FilterMenu
                type={type}
                setType={setType}
                sort={sort}
                setSort={setSort}
                day={day}
                setDay={setDay}
                apps={apps}
                app={app}
                setApp={setApp}
                osOn={osOn}
                setOsOn={setOsOn}
              />
            </div>

            {/* Chat answer: shows above the list after asking a question. Plain
                keyword typing leaves this untouched, so search + chat coexist. */}
            {(chatLoading || chat) && (
              <div
                className="rounded-md p-3 flex flex-col gap-2"
                style={{ background: 'var(--surface2)', border: '1px solid var(--surface3)' }}
              >
                <div className="flex items-start gap-2">
                  <Sparkles size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--accent)' }} />
                  {chatLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted">
                      <Loader2 size={13} className="animate-spin" />
                      Reading your captures…
                    </div>
                  ) : chat && chat.result.error ? (
                    <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                      <div className="text-xlg text-muted truncate">{chat.q}</div>
                      <div className="flex items-center gap-1.5 text-sm text-on-surface">
                        <AlertCircle size={13} className="shrink-0" style={{ color: 'var(--red)' }} />
                        {CHAT_ERROR_MSG[chat.result.error]}
                      </div>
                      <Button
                        onClick={() => void runChat(chat.q)}
                        className="self-start"
                      >
                        <RefreshCw size={12} /> Retry
                      </Button>
                    </div>
                  ) : chat ? (
                    <div className="flex flex-col gap-1 min-w-0 flex-1">
                      <div className="text-xlg text-muted truncate">{chat.q}</div>
                      <div className="text-sm text-on-surface whitespace-pre-wrap max-h-44 overflow-y-auto pr-1">
                        {chat.result.answer || 'No answer. Try rephrasing or recording more first.'}
                      </div>
                    </div>
                  ) : null}
                </div>
                {/* Cited captures → real, clickable source cards below the answer.
                    Click opens the detail pane (resolves against the full set, so it
                    works even with the keyword list filtered to 0). */}
                {chatSources.length > 0 && (
                  <div className="flex flex-col gap-1.5 border-t border-surface2 pt-2">
                    <span className="text-xlg text-muted font-semibold uppercase tracking-wide pl-6">
                      Sources · ranked
                    </span>
                    <div className="flex gap-2 overflow-x-auto pb-1 pl-6">
                      {chatSources.map((it) => (
                        <SourceCard
                          key={it.folder}
                          item={it}
                          selected={selected === it.folder}
                          onSelect={() => setSelected(it.folder)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="text-xlg text-muted px-1 flex items-center gap-1">
              <Lock size={11} className="opacity-70" />
              <span>
                {filtered.length === items.length
                  ? `${items.length.toLocaleString()} ${items.length === 1 ? 'capture' : 'captures'}, all kept on this Mac`
                  : `${filtered.length.toLocaleString()} of ${items.length.toLocaleString()} captures`}
              </span>
              {chat && <span className="ml-auto">Showing all captures · clear to exit chat</span>}
            </div>
          </div>

          {/* Virtualized list — only on-screen rows mount */}
          {filtered.length === 0 ? (
            items.length === 0 ? (
              <div className="text-center text-muted text-sm mt-10">
                No captures yet. Recordings and screenshots from {CONFIG.PRODUCT_NAME} show up here.
              </div>
            ) : query.trim().length >= 3 && !chatLoading ? (
              // Keyword search came up empty but the user typed a real query — offer
              // AI instead of a dead end. The answer reads transcripts/OCR the literal
              // filter can't (e.g. "twitter yesterday" → a clip that never says "twitter").
              <div className="flex flex-col items-center gap-3 text-center mt-12 px-6">
                <Sparkles size={22} style={{ color: 'var(--accent)' }} />
                <div className="text-sm text-on-surface">No exact matches for “{query.trim()}”.</div>
                <div className="text-xlg text-muted max-w-[280px]">
                  Ask {CONFIG.PRODUCT_NAME} to search your captures by meaning, not just keywords.
                </div>
                <Button
                  size="lg"
                  onClick={() => void runChat(query)}
                >
                  <Sparkles size={14} /> Search with AI
                </Button>
              </div>
            ) : (
              <div className="text-center text-muted text-sm mt-10">
                Nothing matches these filters.
              </div>
            )
          ) : (
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="flex-1 overflow-y-auto px-2 pb-3"
            >
              <div style={{ height: totalHeight, position: 'relative' }}>
                <div style={{ transform: `translateY(${offsetY}px)` }}>
                  {visibleRows.map((r) =>
                    r.kind === 'header' ? (
                      <div
                        key={`h:${r.label}`}
                        style={{ height: HEADER_H }}
                        className="flex items-end px-3 pb-1.5 text-xlg font-semibold text-muted"
                      >
                        {r.label}
                      </div>
                    ) : (
                      <Row
                        key={r.item.folder}
                        item={r.item}
                        selected={r.item.folder === selected}
                        active={r.item.folder === selected}
                        playState={r.item.folder === selected ? playState : null}
                        waveBars={waveBars}
                        onSelect={selectRow}
                        onRequestPlay={requestPlay}
                        onRequestDelete={setPendingDelete}
                      />
                    )
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right: detail */}
        {current && (
          <div className="w-[380px] shrink-0">
            <Detail
              item={current}
              enriching={enriching === current.folder}
              retranscribing={retranscribing === current.folder}
              retranscribeError={
                retranscribeError?.folder === current.folder ? retranscribeError.message : undefined
              }
              onClose={() => setSelected(null)}
              onReveal={() => void window.api.mediaReveal(current.folder)}
              onDelete={() => setPendingDelete(current)}
              onEnrich={() => void enrich(current.folder, true)}
              onRetranscribe={() => void retranscribe(current.folder)}
              playRequestId={playReq?.folder === current.folder ? playReq.n : undefined}
              playSeekFrac={playReq?.folder === current.folder ? playReq.seekFrac : undefined}
              onProgress={setPlayState}
            />
          </div>
        )}

        {/* The one gate in front of mediaDelete. Copy tells the truth about where
            the file goes: OS captures are trashed (recoverable), app captures are
            removed outright. */}
        {pendingDelete && (
          <ConfirmDialog
            title={`Delete this ${KIND_META[pendingDelete.kind].label.toLowerCase()}?`}
            body={
              pendingDelete.source === 'os'
                ? 'It moves to the Trash, so you can still get it back.'
                : "This one's gone for good. There's no undo."
            }
            confirmLabel="Delete"
            onConfirm={() => void handleDelete(pendingDelete.folder)}
            onCancel={() => setPendingDelete(null)}
          />
        )}
    </div>
  )
}

/**
 * Standalone Media Library window (?window=media). Thin chrome wrapper around the
 * same body the composer's Library tab renders — one implementation, two mounts.
 * Kept for the tray entry + as the target when the composer isn't the right home.
 */
export default function MediaLibraryApp(): JSX.Element {
  // This window owns its own routing (the composer's Library tab does the same for
  // its mount): ?focus=<folder> selects a capture on arrival.
  const [focusRequest] = useState(() => {
    const folder = new URLSearchParams(window.location.search).get('focus')
    return folder ? { folder } : null
  })
  return (
    <WindowFrame title="Media Library">
      <MediaLibraryBody focusRequest={focusRequest} />
    </WindowFrame>
  )
}

