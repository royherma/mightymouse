import type { JSX } from 'react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Bug } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { IS_DEV } from '../../../shared/env'
import {
  COMPANION_DEBUG_MAX_EVENTS,
  COMPANION_STAGE_LABEL,
  type CompanionStageEvent,
  type CompanionStageState
} from '../../../shared/companion-debug'
import {
  COMPANION_RENDERERS,
  type CompanionRendererId
} from '../../../shared/companion-renderers'
import { COMPANION_STATE_LABEL, type CompanionState } from '../../../shared/companion-state'
import { useIpcSubscriptions } from '../hooks/useIpcSubscriptions'
import { Button } from './Button'

// Live Voice Companion — Phase 0.5 debug/verify panel (the PRD's §5 "Phase 0.5"
// ship gate: "every later phase is verifiable without guesswork"). Plain HTML/CSS
// list, zero three.js/r3f dependency — usable from Phase 0 day one and unaffected
// by Phase 3's eventual character-renderer swap.
//
// Hard-gated on IS_DEV: this component renders NOTHING (not even a collapsed
// affordance) when IS_DEV is false, so it can never leak into a packaged build.
// Mirrors the devOnly() gating already used for the Component Playground tray item.

const T = CONFIG.THEME_TOKENS

const STATE_COLOR: Record<CompanionStageState, string> = {
  start: T.textMutedLight,
  ok: T.green,
  error: T.red
}

function formatTook(tookMs: number | undefined): string {
  if (tookMs === undefined) return ''
  return tookMs < 1000 ? `${tookMs}ms` : `${(tookMs / 1000).toFixed(1)}s`
}

/** mm:ss.t — a wall clock is what lets you line a row up against the moment you
 *  actually spoke; absolute dates would just eat row width. */
function formatClock(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${mm}:${ss}.${Math.floor(d.getMilliseconds() / 100)}`
}

interface CompanionDebugPanelProps {
  /** Currently-selected visualization; highlights the active picker button. */
  renderer: CompanionRendererId
  /** Fired when a renderer button is pressed — CompanionApp swaps + persists. */
  onRendererChange: (next: CompanionRendererId) => void
  /** Current state-machine state — the same value driving the character. */
  state: CompanionState
  /** Live 0..1 mouth openness (TTS playback RMS). Drives the jaw in both renderers. */
  mouthOpen: number
  /** Live 0..1 user mic loudness. Drives ear-perk + the ring swell. */
  micLevel: number
  /** True while VAD hears speech — distinguishes "mic is loud" from "VAD agrees". */
  speaking: boolean
  /** True while a TTS clip is actually playing, so a flat mouthOpen is readable:
   *  flat + playing = a gain/signal problem, flat + not playing = no audio at all. */
  playing: boolean
  /** The model that answered the last turn, as `runLabel()` renders it
   *  ("Claude Code · Opus 5"). Empty until a turn has run. The SAME string the
   *  agent is told it is, so what it says it is can't drift from what ran. */
  model: string
}

/** Peak-hold decay per render tick — a bare live number on a 20fps signal is
 *  unreadable, so each meter keeps a slowly-falling high-water mark beside it. */
const PEAK_DECAY = 0.98

/** Live 0..1 signal meter: filled bar + numeric value + a decaying peak marker. */
function SignalRow({
  label,
  value,
  color,
  peak
}: {
  label: string
  value: number
  color: string
  peak: number
}): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div className="companion-debug-signal">
      <span className="companion-debug-signal-label">{label}</span>
      <span className="companion-debug-meter">
        <span className="companion-debug-meter-fill" style={{ width: `${pct}%`, background: color }} />
        <span className="companion-debug-meter-peak" style={{ left: `${Math.round(peak * 100)}%` }} />
      </span>
      <span className="companion-debug-signal-value">{value.toFixed(2)}</span>
    </div>
  )
}

/** Where a dragged panel's corner is remembered. localStorage, not PREFS: this
 *  is a dev-only window-chrome position, so it doesn't earn a row in the settings
 *  store or the 4-file IPC lockstep a real pref costs. */
const POSITION_KEY = 'companion-debug-position'

interface PanelPosition {
  x: number
  y: number
}

function loadPosition(): PanelPosition {
  try {
    const raw = localStorage.getItem(POSITION_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelPosition>
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return { x: parsed.x, y: parsed.y }
      }
    }
  } catch {
    // Corrupt/absent entry is not worth a console line — fall through to the default.
  }
  return { x: 12, y: 12 }
}

export default function CompanionDebugPanel({
  renderer,
  onRendererChange,
  state,
  mouthOpen,
  micLevel,
  speaking,
  playing,
  model
}: CompanionDebugPanelProps): JSX.Element | null {
  const [events, setEvents] = useState<CompanionStageEvent[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [position, setPosition] = useState<PanelPosition>(loadPosition)
  const [dragging, setDragging] = useState(false)
  // Pointer-to-panel-corner offset, captured on mousedown. Without it the panel
  // teleports so its corner sits under the cursor on the first move.
  const grabOffset = useRef<PanelPosition>({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Peak-hold high-water marks. Kept in refs (not state) so tracking them costs
  // no extra render — they're read during the render the incoming signal already
  // triggered. Answers "did this signal EVER move?", which a live 20fps number
  // flicking past can't: a peak stuck at 0.00 is the tell for a dead signal.
  const mouthPeak = useRef(0)
  const micPeak = useRef(0)
  mouthPeak.current = Math.max(mouthOpen, mouthPeak.current * PEAK_DECAY)
  micPeak.current = Math.max(micLevel, micPeak.current * PEAK_DECAY)

  useIpcSubscriptions(() => [
    window.api.onCompanionStageEvent((event) => {
      setEvents((prev) => [event, ...prev].slice(0, COMPANION_DEBUG_MAX_EVENTS))
    })
  ])

  // Grab starts on the header only, so every button inside the panel still
  // clicks normally. preventDefault stops the browser starting a text selection
  // that would fight the drag.
  const handleGrab = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    e.preventDefault()
    grabOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    setDragging(true)
  }, [])

  // Listeners live on `window`, not the panel: a fast drag outruns the element
  // and the pointer ends up over the character, where a panel-scoped mousemove
  // never fires and the panel sticks mid-drag.
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent): void => {
      const rect = panelRef.current?.getBoundingClientRect()
      const w = rect?.width ?? 0
      const h = rect?.height ?? 0
      // Clamped to the window so the panel can never be dragged somewhere it
      // can't be dragged back from — the header must stay grabbable.
      setPosition({
        x: Math.max(0, Math.min(e.clientX - grabOffset.current.x, window.innerWidth - w)),
        y: Math.max(0, Math.min(e.clientY - grabOffset.current.y, window.innerHeight - h))
      })
    }
    const onUp = (): void => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  // Written on release rather than per-move: a drag fires mousemove at screen
  // rate, and localStorage is synchronous.
  useEffect(() => {
    if (dragging) return
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    } catch {
      // A full/blocked store just means the position won't survive a reload.
    }
  }, [dragging, position])

  // Gate LAST, after the hooks — hooks must run unconditionally every render,
  // but nothing below this line executes (and nothing renders) outside dev.
  if (!IS_DEV) return null

  return (
    <>
      <style>{debugPanelCss()}</style>
      <div
        ref={panelRef}
        className={`companion-debug${dragging ? ' is-dragging' : ''}`}
        style={{ left: position.x, top: position.y }}
      >
        {/* Header is both the drag handle and the collapse toggle: mousedown
            starts a drag, a click that never moved still collapses. */}
        <div
          className="companion-debug-header"
          onMouseDown={handleGrab}
          role="button"
          tabIndex={0}
          onClick={() => setCollapsed((c) => !c)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setCollapsed((c) => !c)
          }}
        >
          <Bug size={12} />
          <span>Companion debug</span>
          <span className="companion-debug-count">{events.length}</span>
          {collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </div>
        {!collapsed && (
          <div className="companion-debug-renderers" role="group" aria-label="Character renderer">
            {COMPANION_RENDERERS.map((r) => (
              <Button
                variant="bare"
                key={r.id}
                title={r.description}
                className={`companion-debug-renderer${r.id === renderer ? ' is-active' : ''}`}
                onClick={() => onRendererChange(r.id)}
              >
                {r.label}
              </Button>
            ))}
          </div>
        )}
        {!collapsed && (
          <div className="companion-debug-signals">
            <div className="companion-debug-flags">
              <span className="companion-debug-flag is-on" style={{ color: T.onSurface }}>
                {COMPANION_STATE_LABEL[state]}
              </span>
              <span className={`companion-debug-flag${speaking ? ' is-on' : ''}`}>VAD</span>
              <span className={`companion-debug-flag${playing ? ' is-on' : ''}`}>TTS</span>
              <span className="companion-debug-flag is-on">{renderer}</span>
            </div>
            {/* Which model actually answered — the same string the agent is told
                it is, so the panel and the model can't disagree. Own row: a
                label like "Claude Code · Opus 5" is far wider than a flag chip
                and would push the rest of the row off. */}
            <div className="companion-debug-model" title="Model that answered the last turn">
              {model === '' ? 'no turn yet' : model}
            </div>
            <SignalRow label="mouth" value={mouthOpen} color={T.blue} peak={mouthPeak.current} />
            <SignalRow label="mic" value={micLevel} color={T.accent} peak={micPeak.current} />
          </div>
        )}
        {!collapsed && (
          <div className="companion-debug-list">
            {events.length === 0 ? (
              <div className="companion-debug-empty">Waiting for stage events…</div>
            ) : (
              events.map((event, i) => (
                <div className="companion-debug-row" key={`${event.ts}-${i}`}>
                  <div className="companion-debug-row-main">
                    <span
                      className="companion-debug-dot"
                      style={{ background: STATE_COLOR[event.state] }}
                    />
                    <span className="companion-debug-clock">{formatClock(event.ts)}</span>
                    <span className="companion-debug-stage">
                      {COMPANION_STAGE_LABEL[event.stage]}
                    </span>
                    <span className="companion-debug-provider">{event.provider}</span>
                    <span className="companion-debug-took">{formatTook(event.tookMs)}</span>
                  </div>
                  {/* `detail` is where the actual payload lives — the error text,
                      the transcript, the barge-in note. It was captured on every
                      event but never rendered, which is what made errors read as
                      a bare red dot with no cause. */}
                  {event.detail && (
                    <div
                      className="companion-debug-detail"
                      style={event.state === 'error' ? { color: T.red } : undefined}
                    >
                      {event.detail}
                    </div>
                  )}
                  {event.imagePath && (
                    <img
                      className="companion-debug-shot"
                      src={window.api.mediaUrl(event.imagePath)}
                      alt={event.detail ?? 'screenshot'}
                    />
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </>
  )
}

function debugPanelCss(): string {
  return `
  /* Wide enough to tell which window was frontmost, small enough that a
     40-step run still scrolls. */
  .companion-debug-shot {
    display: block;
    width: 100%;
    max-height: 90px;
    object-fit: cover;
    object-position: top left;
    margin-top: 4px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  /* Free-floating and DRAGGABLE: absolutely positioned inside .companion-top
     (which is now a full-window positioning context, not a top strip), with
     left/top driven by React state. Width is capped rather than 100% — the old
     full-bleed panel spanned the whole window and buried the character behind
     a wall of debug rows. Capped height with an internal scroll on the list so
     a long event stream never grows past the cap. */
  .companion-debug {
    position: absolute;
    width: 320px;
    max-width: calc(100% - 24px);
    /* Tall enough that the fixed header + picker + signal block leave the event
       stream a usable window (~14 rows). The 150px cap this replaces predated
       the signal block and left the list about two rows tall. */
    max-height: 420px;
    display: flex;
    flex-direction: column;
    background: ${T.surface1};
    border: 1px solid ${T.surfaceBorderAlt};
    border-radius: ${T.radiusMd};
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
    overflow: hidden;
    -webkit-app-region: no-drag;
  }

  /* Lifts while held so it's obvious the panel is being moved, not resized. */
  .companion-debug.is-dragging {
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.42);
    border-color: ${T.accent};
  }

  /* grab/grabbing is the whole drag affordance — the header carries no other
     hint that it's the handle. user-select:none stops a drag that starts on the
     title from selecting the text instead of moving the panel. */
  .companion-debug-header {
    display: flex;
    align-items: center;
    gap: ${T.space2};
    padding: ${T.space2} ${T.space3};
    background: transparent;
    border: none;
    color: ${T.onSurface};
    font-size: 11px;
    font-weight: 600;
    letter-spacing: -0.01em;
    cursor: grab;
    user-select: none;
    text-align: left;
    flex: none;
  }

  .companion-debug.is-dragging .companion-debug-header { cursor: grabbing; }

  /* Muted + truncating: it's context for the rows below, not a headline, and a
     long OpenRouter slug would otherwise wrap the panel wider. */
  .companion-debug-model {
    font-size: 10px;
    font-weight: 600;
    color: ${T.textMutedMedium};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .companion-debug-count {
    margin-left: auto;
    color: ${T.textMutedMedium};
    font-weight: 500;
  }

  /* Renderer picker: a compact segmented row of the visualization choices.
     Sits between the header and the event stream. */
  .companion-debug-renderers {
    display: flex;
    gap: ${T.space1};
    padding: 6px ${T.space3};
    border-top: 1px solid ${T.surfaceBorderAlt};
  }

  .companion-debug-renderer {
    flex: 1;
    padding: 4px 6px;
    background: transparent;
    border: 1px solid ${T.surfaceBorderAlt};
    border-radius: ${T.radiusSm};
    color: ${T.textMutedMedium};
    font-size: 10px;
    font-weight: 600;
    letter-spacing: -0.01em;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
  }

  .companion-debug-renderer:hover { color: ${T.onSurface}; }

  .companion-debug-renderer.is-active {
    color: ${T.onSurface};
    border-color: ${T.accent};
    background: ${T.surface2};
  }

  /* Live signal block: the state/flag chips + the two 0..1 meters. Fixed height
     (no scroll) so it never competes with the event list for the panel's cap. */
  .companion-debug-signals {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px ${T.space3};
    border-top: 1px solid ${T.surfaceBorderAlt};
    flex: none;
  }

  .companion-debug-flags {
    display: flex;
    gap: ${T.space1};
    margin-bottom: 2px;
  }

  /* Off = dim outline, on = accent-lit. A flag that never lights is the fastest
     read on which stage of the chain is dead. */
  .companion-debug-flag {
    padding: 1px 5px;
    border: 1px solid ${T.surfaceBorderAlt};
    border-radius: ${T.radiusSm};
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: ${T.textMutedLight};
  }

  .companion-debug-flag.is-on {
    color: ${T.onSurface};
    border-color: ${T.accent};
  }

  .companion-debug-signal {
    display: flex;
    align-items: center;
    gap: ${T.space2};
    font-size: 10px;
    color: ${T.textMutedMedium};
  }

  .companion-debug-signal-label {
    min-width: 34px;
    font-weight: 600;
  }

  .companion-debug-meter {
    position: relative;
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: ${T.surface2};
    overflow: hidden;
  }

  .companion-debug-meter-fill {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 3px;
  }

  /* Decaying high-water mark — sits ON the bar so a signal that spikes and
     falls back still leaves a visible trace for a beat. */
  .companion-debug-meter-peak {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: ${T.onSurface};
    opacity: 0.65;
  }

  .companion-debug-signal-value {
    min-width: 28px;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: ${T.onSurface};
  }

  /* Takes every pixel the fixed rows above don't. min-height:0 is what actually
     lets it scroll — without it a flex child refuses to shrink below its content
     and the overflow lands on the panel instead of the list. */
  .companion-debug-list {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 90px;
    overflow-y: auto;
    border-top: 1px solid ${T.surfaceBorderAlt};
  }

  .companion-debug-empty {
    padding: ${T.space3};
    font-size: 11px;
    color: ${T.textMutedLight};
  }

  /* A row is now a column: the one-line summary, plus an optional detail line
     under it. flex:none stops long rows being squashed by the list's flex:1. */
  .companion-debug-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px ${T.space3};
    font-size: 11px;
    color: ${T.onSurface};
    border-bottom: 1px solid ${T.surfaceBorderAlt};
    flex: none;
  }

  .companion-debug-row:last-child { border-bottom: none; }

  .companion-debug-row-main {
    display: flex;
    align-items: center;
    gap: ${T.space2};
  }

  .companion-debug-clock {
    color: ${T.textMutedLight};
    font-variant-numeric: tabular-nums;
    font-size: 10px;
    flex: none;
  }

  /* Wraps rather than truncating — an error message cut at one line is the
     thing you most need to read in full. Capped so one huge payload can't
     scroll the rest of the stream off. */
  .companion-debug-detail {
    padding-left: 14px;
    font-size: 10px;
    line-height: 1.35;
    color: ${T.textMutedMedium};
    max-height: 44px;
    overflow-y: auto;
    overflow-wrap: anywhere;
  }

  .companion-debug-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
  }

  .companion-debug-stage {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .companion-debug-provider {
    color: ${T.textMutedMedium};
  }

  .companion-debug-took {
    color: ${T.textMutedLight};
    font-variant-numeric: tabular-nums;
    min-width: 32px;
    text-align: right;
  }
  `
}
