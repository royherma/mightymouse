import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X, Square } from 'lucide-react'
import { MOUSE_FRAMES } from './assets/mouse'
import { CONFIG } from '../../shared/config'
import type { CompanionState } from '../../shared/companion-state'
import { Button } from './components/Button'

const T = CONFIG.THEME_TOKENS

export type PillOutcome = 'done' | 'failed' | null

export const PILL_ACCENT: Record<CompanionState, string> = {
  idle: T.textMutedLight,
  listening: T.accent,
  thinking: T.orange,
  talking: T.blue,
  reacting: T.green
}
const OUTCOME_ACCENT = { done: T.green, failed: T.redLight }

const PILL_WORD: Record<CompanionState, string> = {
  idle: 'Say "Hey Mighty"',
  listening: 'Listening',
  thinking: 'Working',
  talking: 'Talking',
  reacting: 'Say "Hey Mighty"'
}
const PILL_WORD_PAUSED = 'Paused while recording'
const PILL_WORD_DONE = 'Done'
const PILL_WORD_FAILED = "Couldn't do that"
const SHOW_ELAPSED_AFTER_S = 3
export const PILL_DONE_MS = 1_100
export const PILL_FAILED_MS = 2_400

const BAR_WEIGHTS = [0.55, 0.85, 1, 0.85, 0.55]

function VoiceBars({ level }: { level: number | null }): JSX.Element {
  return (
    <span className={`companion-bars${level === null ? ' is-wave' : ''}`} aria-hidden>
      {BAR_WEIGHTS.map((w, i) => (
        <span key={i} style={level === null ? undefined : { transform: `scaleY(${0.2 + Math.min(1, level) * w * 0.8})` }} />
      ))}
    </span>
  )
}

function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000))
}

export interface CompanionPillProps {
  state: CompanionState
  outcome: PillOutcome
  step?: string
  paused: boolean
  micLevel: number
  barsLevel: number | null
  workingSince: number | null
  onStop: () => void
  onClose: () => void
  onContextMenu?: (e: ReactMouseEvent) => void
}

export function CompanionPill(p: CompanionPillProps): JSX.Element {
  const working = p.state === 'thinking' || p.state === 'talking'
  const listening = p.state === 'listening'
  const look = p.outcome ? `is-${p.outcome}` : `is-${p.state}`
  const accent = p.outcome ? OUTCOME_ACCENT[p.outcome] : PILL_ACCENT[p.state]
  const word = p.outcome === 'done'
    ? PILL_WORD_DONE
    : p.outcome === 'failed'
      ? PILL_WORD_FAILED
      : p.paused
        ? PILL_WORD_PAUSED
        : p.state === 'thinking' && p.step
          ? p.step
          : PILL_WORD[p.state]
  const secs = useElapsedSeconds(p.state === 'thinking' && !p.outcome ? p.workingSince : null)
  const level = listening ? Math.min(1, p.micLevel) : 0

  const rowRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    setWidth(row.offsetWidth)
    const ro = new ResizeObserver(() => setWidth(row.offsetWidth))
    ro.observe(row)
    return () => ro.disconnect()
  }, [])

  const showBars = !p.outcome && (listening || p.state === 'talking' || (p.state === 'idle' && !p.paused))
  return (
    <div
      className={`companion-pill ${look}${p.paused ? ' is-paused' : ''}`}
      style={{ width, ['--accent' as string]: accent, ['--level' as string]: level }}
      onContextMenu={p.onContextMenu}
    >
      <div ref={rowRef} className="companion-pill-row">
        {!working && !p.outcome && (
          <Button variant="bare" className="companion-pill-off" onClick={p.onClose} title="Turn off voice mode" aria-label="Turn off voice mode">
            <X size={11} strokeWidth={3} />
          </Button>
        )}
        {working && !p.outcome && (
          <Button variant="bare" className="companion-pill-stop" onClick={p.onStop} title="Stop" aria-label="Stop">
            <Square size={9} fill="currentColor" strokeWidth={0} />
            {p.state === 'thinking' && <kbd>esc</kbd>}
          </Button>
        )}
        {showBars && <VoiceBars level={p.barsLevel} />}
        <span key={word} className="companion-pill-word" role="status" title={word}>
          {word}
        </span>
        {secs >= SHOW_ELAPSED_AFTER_S && <span className="companion-pill-time">{secs}s</span>}
        <span className="companion-pill-avatar">
          <span className="companion-pill-ring" aria-hidden />
          <img src={MOUSE_FRAMES.front} alt="" draggable={false} />
          {p.outcome && (
            <span className="companion-pill-badge" aria-hidden>
              {p.outcome === 'done' ? (
                <svg viewBox="0 0 12 12"><path d="M2.6 6.3 5 8.6 9.5 3.6" /></svg>
              ) : (
                <svg viewBox="0 0 12 12"><path d="M6 3v3.6M6 8.9v.1" /></svg>
              )}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

export function companionPillCss(): string {
  return `
  @property --pill-a { syntax: '<angle>'; initial-value: 0deg; inherits: false; }

  .companion-pill {
    position: relative;
    height: ${CONFIG.COMPANION.PILL_H}px;
    flex: none;
    border-radius: 999px;
    background: ${T.surfaceSolid};
    box-shadow: 0 0 0 1px rgba(${T.shadowRgb}, 0.07), ${T.shadowBubble};
    transition: width 320ms cubic-bezier(0.3, 1.25, 0.4, 1), box-shadow 160ms ease;
    animation: companion-pop 280ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
    -webkit-app-region: no-drag;
  }
  .companion-pill-row {
    position: absolute; top: 0; right: 0; bottom: 0;
    display: flex; align-items: center; gap: 10px;
    width: max-content;
    padding: 0 6px 0 18px;
    box-sizing: border-box;
  }
  .companion-pill:has(.companion-pill-stop) .companion-pill-row { padding-left: 8px; }

  .companion-pill::before, .companion-pill::after {
    content: ''; position: absolute; inset: -2px;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 200ms ease;
  }
  .companion-pill::before {
    padding: 2px;
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
  }
  .companion-pill::after { inset: -6px; filter: blur(10px); z-index: -1; }

  .companion-pill.is-listening {
    box-shadow:
      0 0 0 calc(1.5px + var(--level) * 1.5px) color-mix(in srgb, var(--accent) calc(35% + var(--level) * 50%), transparent),
      0 6px calc(18px + var(--level) * 28px) color-mix(in srgb, var(--accent) calc(18% + var(--level) * 42%), transparent);
    transition: width 320ms cubic-bezier(0.3, 1.25, 0.4, 1), box-shadow 90ms ease-out;
  }
  .companion-pill.is-talking {
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--accent) 40%, transparent),
      0 6px 22px color-mix(in srgb, var(--accent) 28%, transparent);
  }

  .companion-pill.is-thinking { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent), 0 6px 22px color-mix(in srgb, var(--accent) 22%, transparent); }
  .companion-pill.is-thinking::before,
  .companion-pill.is-thinking::after {
    opacity: 1;
    background: conic-gradient(from var(--pill-a), transparent 0deg 250deg,
      color-mix(in srgb, var(--accent) 60%, transparent) 300deg, var(--accent) 340deg, #fff 352deg, transparent 360deg);
    animation: companion-orbit 1.7s linear infinite;
  }
  .companion-pill.is-thinking::after { opacity: 0.55; }

  .companion-pill.is-done::before, .companion-pill.is-failed::before { opacity: 1; background: var(--accent); }
  .companion-pill.is-done::after { background: var(--accent); animation: companion-flash 900ms ease-out both; }
  .companion-pill.is-done { animation: companion-bump 420ms cubic-bezier(0.3, 1.5, 0.5, 1); }
  .companion-pill.is-failed { animation: companion-shake 380ms cubic-bezier(0.36, 0.07, 0.19, 0.97); }

  .companion-pill-word {
    max-width: 132px;
    overflow: hidden; text-overflow: ellipsis;
    font-size: 12.5px; font-weight: 600;
    letter-spacing: -0.01em;
    color: ${T.textMutedDark};
    white-space: nowrap;
    animation: companion-word-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .companion-pill.is-listening .companion-pill-word,
  .companion-pill.is-talking .companion-pill-word { color: ${T.onSurface}; }
  .companion-pill.is-paused .companion-pill-word { color: ${T.textMutedLight}; }
  .companion-pill.is-thinking .companion-pill-word {
    color: transparent;
    background: linear-gradient(90deg, ${T.onSurface} 0 38%, var(--accent) 50%, ${T.onSurface} 62% 100%);
    background-size: 260% 100%;
    -webkit-background-clip: text; background-clip: text;
    animation: companion-word-in 260ms cubic-bezier(0.2, 0.8, 0.2, 1), companion-shimmer 2.2s linear infinite;
  }
  .companion-pill.is-done .companion-pill-word,
  .companion-pill.is-failed .companion-pill-word { color: var(--accent); }

  .companion-pill-time {
    font: 500 11px/1 -apple-system, system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    color: ${T.textMutedLight};
    margin-left: -4px;
    animation: companion-fade 200ms ease-out;
  }

  .companion-pill-avatar {
    position: relative;
    display: flex; align-items: center; justify-content: center;
    width: 40px; height: 40px;
    flex: none;
    border-radius: 50%;
    background: ${T.surface2};
  }
  .companion-pill-avatar img {
    width: 34px; height: 34px; object-fit: contain;
    pointer-events: none;
    transition: filter 200ms ease, opacity 200ms ease, transform 160ms cubic-bezier(0.3, 1.4, 0.5, 1);
  }
  .companion-pill.is-listening .companion-pill-avatar img {
    transform: rotate(-6deg) translateY(-1px) scale(calc(1.02 + var(--level) * 0.08));
  }
  .companion-pill.is-thinking .companion-pill-avatar img { animation: companion-bob 640ms ease-in-out infinite alternate; }
  .companion-pill.is-done .companion-pill-avatar img { animation: companion-hop 460ms cubic-bezier(0.3, 1.5, 0.5, 1); }
  .companion-pill.is-failed .companion-pill-avatar img { transform: rotate(9deg) translateY(1px); filter: saturate(0.6); }
  .companion-pill.is-paused .companion-pill-avatar img { filter: grayscale(1); opacity: 0.55; }

  .companion-pill-ring {
    position: absolute; inset: -3px;
    border-radius: 50%;
    border: 2px solid var(--accent);
    opacity: 0.22;
    transition: opacity 120ms linear, transform 90ms ease-out;
    pointer-events: none;
  }
  .companion-pill.is-listening .companion-pill-ring { opacity: calc(0.45 + var(--level) * 0.55); transform: scale(calc(1 + var(--level) * 0.14)); }
  .companion-pill.is-thinking .companion-pill-ring,
  .companion-pill.is-paused .companion-pill-ring { opacity: 0; }
  .companion-pill.is-talking .companion-pill-ring { animation: companion-breathe ${CONFIG.COMPANION.CYCLE_MS}ms ease-in-out infinite; }
  .companion-pill.is-done .companion-pill-ring,
  .companion-pill.is-failed .companion-pill-ring { opacity: 0; }
  .companion-pill.is-done .companion-pill-ring { animation: companion-ripple 700ms ease-out; }

  .companion-pill-badge {
    position: absolute; right: -3px; bottom: -3px;
    width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px ${T.surfaceSolid};
    animation: companion-badge 360ms cubic-bezier(0.3, 1.6, 0.5, 1) both;
  }
  .companion-pill-badge svg {
    width: 12px; height: 12px;
    fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
  }
  .companion-pill.is-done .companion-pill-badge path {
    stroke-dasharray: 12; stroke-dashoffset: 12;
    animation: companion-draw 280ms 140ms ease-out forwards;
  }

  .companion-pill-off {
    position: absolute; top: -5px; left: -5px;
    width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center;
    padding: 0; border: none; border-radius: 50%;
    background: ${T.surface3};
    color: ${T.textMutedDark};
    box-shadow: ${T.shadowBubble};
    cursor: pointer;
    opacity: 0; transform: scale(0.7);
    transition: opacity 140ms ease, transform 140ms ease, color 140ms ease;
    -webkit-app-region: no-drag;
  }
  .companion-pill:hover .companion-pill-off { opacity: 1; transform: scale(1); }
  .companion-pill-off:hover { color: ${T.redLight}; }

  .companion-pill-stop {
    display: flex; align-items: center; gap: 6px;
    height: 30px; padding: 0 11px;
    border: none; border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    transition: background 140ms ease, transform 100ms ease;
    -webkit-app-region: no-drag;
  }
  .companion-pill-stop:hover { background: color-mix(in srgb, var(--accent) 26%, transparent); }
  .companion-pill-stop:active { transform: scale(0.95); }
  .companion-pill-stop kbd {
    font: 600 10px/1 -apple-system, system-ui, sans-serif;
    color: ${T.textMutedDark};
  }

  .companion-bars {
    display: inline-flex; align-items: center; gap: 3px;
    height: 20px;
  }
  .companion-bars span {
    width: 3px; height: 100%;
    border-radius: 2px;
    background: var(--accent);
    transform: scaleY(0.2);
    transition: transform 90ms ease-out;
  }
  .companion-bars.is-wave span { animation: companion-wave 1s ease-in-out infinite; }
  .companion-bars.is-wave span:nth-child(2) { animation-delay: -0.8s; }
  .companion-bars.is-wave span:nth-child(3) { animation-delay: -0.6s; }
  .companion-bars.is-wave span:nth-child(4) { animation-delay: -0.4s; }
  .companion-bars.is-wave span:nth-child(5) { animation-delay: -0.2s; }

  @keyframes companion-pop {
    from { opacity: 0; transform: translateY(8px) scale(0.92); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes companion-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes companion-word-in {
    from { opacity: 0; transform: translateY(6px); filter: blur(3px); }
    to   { opacity: 1; transform: none; filter: none; }
  }
  @keyframes companion-orbit { to { --pill-a: 360deg; } }
  @keyframes companion-shimmer { from { background-position: 100% 0; } to { background-position: -160% 0; } }
  @keyframes companion-bob { from { transform: translateY(1px); } to { transform: translateY(-2px) rotate(-3deg); } }
  @keyframes companion-hop {
    0% { transform: none; } 40% { transform: translateY(-6px) scale(1.08); } 100% { transform: none; }
  }
  @keyframes companion-bump { 0% { transform: scale(1); } 40% { transform: scale(1.04); } 100% { transform: scale(1); } }
  @keyframes companion-shake {
    20% { transform: translateX(-5px); } 40% { transform: translateX(4px); }
    60% { transform: translateX(-3px); } 80% { transform: translateX(2px); } 100% { transform: none; }
  }
  @keyframes companion-flash { 0% { opacity: 0.9; } 100% { opacity: 0; } }
  @keyframes companion-ripple {
    from { opacity: 0.8; transform: scale(1); } to { opacity: 0; transform: scale(1.5); }
  }
  @keyframes companion-badge { from { transform: scale(0); } to { transform: scale(1); } }
  @keyframes companion-draw { to { stroke-dashoffset: 0; } }
  @keyframes companion-breathe {
    0%, 100% { transform: scale(1); opacity: 0.4; }
    50%      { transform: scale(1.08); opacity: 1; }
  }
  @keyframes companion-wave {
    0%, 100% { transform: scaleY(0.25); }
    50%      { transform: scaleY(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .companion-pill, .companion-pill *, .companion-pill::before, .companion-pill::after { animation: none !important; }
  }
  `
}
