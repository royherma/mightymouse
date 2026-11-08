import { useMemo, useRef, useState, type JSX } from 'react'
import { CONFIG } from '../../../shared/config'
import { COMPANION_DEBUG_MAX_EVENTS, type CompanionStageEvent } from '../../../shared/companion-debug'
import type { CompanionState } from '../../../shared/companion-state'
import { Button } from './Button'

/**
 * Stage — the full-screen companion renderer, built to be read off a PHONE
 * MIRROR at roughly 1/6 scale rather than on the Mac itself. That single
 * constraint drives every choice here: type starts at 40px, contrast is
 * maximal, and nothing carries meaning by colour alone.
 *
 * It is a peer of MouseCharacter/WarpCharacter under the companion-renderers.ts
 * seam, so it takes the same `state` + `mouthOpen` props — plus the stage-event
 * feed, which is what makes an act run legible: one chip per action, and the
 * screenshot the agent is actually looking at.
 *
 * Click-through is owned by the WINDOW (companion-window.ts applyCompanionRenderer),
 * not by this component: the agent clicks the real apps underneath while this
 * covers the screen. The one exception is the interactive column, which asks for
 * pointer events back on enter — see onPointerEnter below.
 */

const T = CONFIG.THEME_TOKENS

/** Everything on Stage is sized for a mirror, not a monitor. */
const TYPE = {
  bubble: 44,
  who: 24,
  chip: 26,
  empty: 32
}

/** How many step chips stay on screen. Older ones scroll off rather than
 *  shrinking the strip — a chip too small to read is worse than an absent one. */
const MAX_CHIPS = 8

export interface StageViewProps {
  state: CompanionState
  transcript: string
  reply: string
  events: CompanionStageEvent[]
  /** Pointer entered/left something interactive; main flips click-through. */
  onInteractiveChange?: (interactive: boolean) => void
  /** A typed instruction was submitted. Runs the same turn a spoken one does. */
  onSubmitText?: (text: string) => void
  /** The input gained/lost focus. The host pauses VAD while it is focused so
   *  typing a sentence out loud in a noisy room can't start a second turn. */
  onTypingChange?: (typing: boolean) => void
  /** Collapse to the corner puck. The conversation keeps running — this only
   *  gives the screen back. */
  onMinimize?: () => void
}

/** The emoji prefix that tells a step apart at a glance on a small mirror. */
function chipIcon(event: CompanionStageEvent): string {
  if (event.imagePath) return '📷'
  const detail = event.detail ?? ''
  if (detail.startsWith('type') || detail.startsWith('key')) return '⌨'
  return '●'
}

export function StageView({
  state,
  transcript,
  reply,
  events,
  onInteractiveChange,
  onSubmitText,
  onTypingChange,
  onMinimize
}: StageViewProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Only `step` events belong on the strip; the pipeline stages (response,
  // speech-output…) are debug-panel material and would bury the actions.
  const steps = useMemo(
    () => events.filter((e) => e.stage === 'step').slice(-MAX_CHIPS),
    [events]
  )

  // The most recent frame the agent looked at. Searched from the end so a run
  // that took ten screenshots shows the current one, not the first.
  const shot = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].imagePath) return events[i]
    }
    return null
  }, [events])

  // Guard against a runaway feed: the buffer is capped in main, but a renderer
  // that somehow accumulated more would silently drop frames instead of janking.
  const overflowed = useRef(false)
  if (events.length > COMPANION_DEBUG_MAX_EVENTS) overflowed.current = true

  const waiting = !transcript && !reply && steps.length === 0

  const submit = (): void => {
    const said = draft.trim()
    if (!said) return
    setDraft('')
    onSubmitText?.(said)
  }

  return (
    <div className="stage-root">
      <style>{stageCss()}</style>

      {/* Nothing has happened yet: say what to do rather than showing an empty
          frame, which on a mirror is indistinguishable from a crash. */}
      {waiting ? (
        <div className="stage-empty">Say something and I&apos;ll show you every step.</div>
      ) : (
        <div className="stage-column">
          {transcript && (
            <div className="stage-bubble is-user">
              <span className="stage-who">You</span>
              <span className="stage-text">{transcript}</span>
            </div>
          )}

          {reply && (
            <div className="stage-bubble is-mouse">
              <span className="stage-who">Mighty</span>
              <span className="stage-text">{reply}</span>
            </div>
          )}

          {steps.length > 0 && (
            <div className="stage-steps">
              {steps.map((event, i) => (
                <span
                  key={`${event.ts}-${i}`}
                  className={`stage-chip${i === steps.length - 1 ? ' is-latest' : ''}`}
                >
                  <span className="stage-chip-icon">{chipIcon(event)}</span>
                  {event.detail}
                </span>
              ))}
            </div>
          )}

          {shot?.imagePath && (
            <div className="stage-shot">
              <img src={window.api.mediaUrl(shot.imagePath)} alt="what Mighty is looking at" />
            </div>
          )}
        </div>
      )}

      {/* Pinned input bar — the one interactive region. Pointer events are
          requested on enter and released on leave, so everything else on Stage
          stays click-through for the agent driving the apps underneath. */}
      <div
        className="stage-footer"
        onPointerEnter={() => onInteractiveChange?.(true)}
        onPointerLeave={() => onInteractiveChange?.(false)}
      >
        <input
          ref={inputRef}
          className="stage-input"
          type="text"
          value={draft}
          placeholder="Tell it what to do…"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => onTypingChange?.(true)}
          onBlur={() => onTypingChange?.(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              submit()
              return
            }
            // Esc hands the mic back: blur resumes VAD via onTypingChange, so
            // the user can go straight back to talking without a second click.
            if (e.key === 'Escape') inputRef.current?.blur()
          }}
        />
        <Button variant="bare" className="stage-send" onClick={submit} disabled={!draft.trim()}>
          Send
        </Button>
        {/* Lives in the footer rather than a corner because the footer is the
            only region that already holds pointer events — a corner button on a
            click-through overlay would not be clickable. */}
        <Button
          variant="bare"
          className="stage-minimize"
          onClick={() => onMinimize?.()}
          title="Minimize"
          aria-label="Minimize"
        >
          ⌄
        </Button>
      </div>

      <div className={`stage-state is-${state}`} aria-hidden />
    </div>
  )
}

function stageCss(): string {
  return `
  .stage-root {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 20px;
    padding: 40px 48px;
    box-sizing: border-box;
    /* Deliberately NOT a solid fill: the user has to keep seeing the app the
       agent is driving. Dark enough that white text holds up over a bright
       window underneath. */
    background: linear-gradient(
      to top,
      rgba(${T.bgRgb}, 0.92) 0%,
      rgba(${T.bgRgb}, 0.72) 45%,
      rgba(${T.bgRgb}, 0) 100%
    );
    font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
    pointer-events: none;
  }
  .stage-column {
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 1100px;
  }
  .stage-empty {
    font-size: ${TYPE.empty}px;
    color: ${T.textMutedLight};
    text-align: center;
    margin-bottom: 12vh;
  }
  .stage-bubble {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 20px 26px;
    border-radius: ${T.radiusLg};
    box-shadow: ${T.shadowBubble};
    backdrop-filter: blur(12px);
  }
  .stage-bubble.is-user {
    background: ${T.accentBgSubtle};
    border: 1px solid ${T.accentBorderSubtle};
    align-self: flex-start;
  }
  .stage-bubble.is-mouse {
    background: ${T.violetBgSubtle};
    border: 1px solid ${T.violetBorderSubtle};
    align-self: flex-start;
  }
  .stage-who {
    font-size: ${TYPE.who}px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: ${T.textMutedLight};
  }
  .stage-text {
    font-size: ${TYPE.bubble}px;
    line-height: 1.25;
    color: ${T.onSurface};
  }
  .stage-steps {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .stage-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px;
    border-radius: ${T.radiusMd};
    font-size: ${TYPE.chip}px;
    /* Older steps fade but never below readable — the history is the point. */
    color: ${T.textMutedMedium};
    background: rgba(${T.whiteRgb}, 0.06);
    border: 1px solid ${T.borderDark};
  }
  .stage-chip.is-latest {
    color: ${T.onSurface};
    background: ${T.greenBgSubtle};
    border-color: ${T.greenBorderSubtle};
  }
  .stage-chip-icon { font-size: ${TYPE.chip}px; }
  .stage-shot {
    width: 45%;
    min-width: 420px;
    border-radius: ${T.radiusMd};
    overflow: hidden;
    border: 1px solid ${T.borderDark};
    box-shadow: ${T.shadowCard};
  }
  .stage-shot img { display: block; width: 100%; }
  .stage-footer {
    /* The one interactive region — everything else stays click-through so the
       agent can reach the apps underneath. */
    pointer-events: auto;
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .stage-input {
    flex: 1;
    /* Same floor as the bubbles: this has to be typeable while looking at a
       mirrored phone, not just at the Mac. */
    font-size: ${TYPE.bubble}px;
    font-family: inherit;
    padding: 18px 24px;
    border-radius: ${T.radiusLg};
    border: 1px solid ${T.borderDark};
    background: ${T.surface1};
    color: ${T.onSurface};
    outline: none;
  }
  .stage-input:focus { border-color: ${T.accentBorderSubtle}; }
  .stage-input::placeholder { color: ${T.textMutedLight}; }
  .stage-send {
    font-size: ${TYPE.who}px;
    font-family: inherit;
    font-weight: 600;
    padding: 20px 30px;
    border-radius: ${T.radiusLg};
    border: 1px solid ${T.accentBorderSubtle};
    background: ${T.accentBgSubtle};
    color: ${T.onSurface};
    cursor: pointer;
  }
  .stage-send:disabled { opacity: 0.4; cursor: default; }
  .stage-minimize {
    font-size: ${TYPE.bubble}px;
    font-family: inherit;
    line-height: 1;
    padding: 12px 24px;
    border-radius: ${T.radiusLg};
    border: 1px solid ${T.borderDark};
    background: ${T.surface1};
    color: ${T.onSurface};
    cursor: pointer;
  }
  .stage-minimize:hover { background: ${T.surface2}; }
  `
}
