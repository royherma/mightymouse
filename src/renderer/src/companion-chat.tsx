import type { JSX } from 'react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Check, ArrowUpRight } from 'lucide-react'
import { CONFIG } from '../../shared/config'
import { Button } from './components/Button'

const T = CONFIG.THEME_TOKENS

export interface VoiceTurn {
  id: number
  heard: string
  steps: string[]
  reply?: string
  failed?: boolean
  note?: string
  live?: boolean
}

const STEPS_SHOWN = 3
const TURNS_MAX = 30
const CHAT_HOLD_MS = 8_000

export function useVoiceTurns(): {
  turns: VoiceTurn[]
  steps: string[]
  recent: boolean
  addStep: (say: string) => void
  clearSteps: () => void
  finishTurn: (turn: Pick<VoiceTurn, 'heard' | 'reply' | 'failed'>) => void
} {
  const [turns, setTurns] = useState<VoiceTurn[]>([])
  const [steps, setSteps] = useState<string[]>([])
  const [recent, setRecent] = useState(false)
  const stepsRef = useRef<string[]>([])
  const idRef = useRef(0)
  const recentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addStep = useCallback((say: string) => {
    const prev = stepsRef.current
    if (prev[prev.length - 1] === say) return
    stepsRef.current = [...prev, say]
    setSteps(stepsRef.current)
  }, [])
  const clearSteps = useCallback(() => {
    stepsRef.current = []
    setSteps([])
  }, [])
  const finishTurn = useCallback(
    (turn: Pick<VoiceTurn, 'heard' | 'reply' | 'failed'>) => {
      const reply = turn.reply ?? ''
      idRef.current += 1
      const done: VoiceTurn = {
        ...turn,
        id: idRef.current,
        steps: stepsRef.current.filter((s) => !reply.startsWith(s.replace(/…$/, '')))
      }
      setTurns((prev) => [...prev, done].slice(-TURNS_MAX))
      clearSteps()
      setRecent(true)
      if (recentTimer.current) clearTimeout(recentTimer.current)
      recentTimer.current = setTimeout(() => setRecent(false), CHAT_HOLD_MS)
    },
    [clearSteps]
  )
  return { turns, steps, recent, addStep, clearSteps, finishTurn }
}
// Pixels from the bottom that still count as "reading the newest", so a new row scrolls into view.
const STICK_PX = 24

function Steps({ steps, live }: { steps: string[]; live: boolean }): JSX.Element | null {
  const [all, setAll] = useState(false)
  if (steps.length === 0) return null
  const hidden = all ? 0 : Math.max(0, steps.length - STEPS_SHOWN)
  return (
    <ol className="companion-chat-steps">
      {hidden > 0 && (
        <li>
          <Button variant="bare" className="companion-chat-more" onClick={() => setAll(true)}>
            {hidden} earlier {hidden === 1 ? 'step' : 'steps'}
          </Button>
        </li>
      )}
      {steps.slice(hidden).map((s, i, shown) => {
        const current = live && i === shown.length - 1
        return (
          <li key={hidden + i} className={current ? 'is-current' : undefined}>
            {current ? <span className="companion-chat-spin" aria-hidden /> : <Check size={11} strokeWidth={3} aria-hidden />}
            <span>{s}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function VoiceChat({
  turns,
  hidden,
  onOpenChat
}: {
  turns: VoiceTurn[]
  hidden: boolean
  onOpenChat?: () => void
}): JSX.Element | null {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stuck = useRef(true)
  const last = turns[turns.length - 1]
  const tick = `${turns.length}:${last?.steps.length}:${last?.reply ?? ''}:${last?.heard}`
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [tick, hidden])
  if (turns.length === 0) return null
  return (
    <div className={`companion-chat${hidden ? ' is-hidden' : ''}`}>
      <div
        ref={scrollRef}
        className="companion-chat-scroll"
        onScroll={(e) => {
          const el = e.currentTarget
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
        }}
      >
        {turns.map((t) => (
          <div key={t.id} className={`companion-chat-turn${t.note ? ' is-ignored' : ''}`}>
            {t.heard && <p className="companion-chat-heard">{t.heard}</p>}
            {t.note && <p className="companion-chat-note">{t.note}</p>}
            <Steps steps={t.steps} live={!!t.live && !t.reply} />
            {t.reply && <p className={`companion-chat-reply${t.failed ? ' is-failed' : ''}`}>{t.reply}</p>}
          </div>
        ))}
      </div>
      {onOpenChat && (
        <Button variant="bare" className="companion-chat-open" onClick={onOpenChat}>
          Open in chat <ArrowUpRight size={12} strokeWidth={2.5} />
        </Button>
      )}
    </div>
  )
}

export function companionChatCss(): string {
  return `
  .companion-chat {
    display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
    max-width: 100%; min-height: 0;
    transition: opacity 220ms ease, transform 220ms ease;
  }
  .companion-chat.is-hidden { opacity: 0; transform: translateY(6px); pointer-events: none; }
  .companion-chat-scroll {
    display: flex; flex-direction: column; gap: 6px;
    max-height: ${CONFIG.COMPANION.CAPTION_MAX_H - 40}px;
    overflow-y: auto; overscroll-behavior: contain;
    scrollbar-width: none;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 18px);
    mask-image: linear-gradient(to bottom, transparent 0, #000 18px);
    padding-top: 18px;
  }
  .companion-chat-scroll::-webkit-scrollbar { display: none; }
  .companion-chat-turn {
    align-self: flex-end;
    max-width: 100%;
    box-sizing: border-box;
    padding: 9px 12px;
    border-radius: 16px 16px 4px 16px;
    background: ${T.surfaceSolid};
    box-shadow: 0 0 0 1px rgba(${T.shadowRgb}, 0.06), ${T.shadowBubble};
    display: flex; flex-direction: column; gap: 4px;
    font-size: 12px; line-height: 1.4;
    animation: companion-rise 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .companion-chat-turn p { margin: 0; overflow-wrap: anywhere; }
  .companion-chat-heard { color: ${T.onSurface}; font-weight: 500; }
  .companion-chat-turn.is-ignored { opacity: 0.6; }
  .companion-chat-turn.is-ignored .companion-chat-heard { color: ${T.textMutedMedium}; font-weight: 400; }
  .companion-chat-note { font-size: 10px; color: ${T.textMutedMedium}; }
  .companion-chat-reply { color: ${T.textMutedDark}; }
  .companion-chat-reply.is-failed { color: ${T.redLight}; }
  .companion-chat-steps {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 2px;
    font-size: 11px; color: ${T.textMutedMedium};
  }
  .companion-chat-steps li { display: flex; align-items: center; gap: 6px; min-width: 0; animation: companion-rise 200ms ease-out; }
  .companion-chat-steps li > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .companion-chat-steps svg { flex: none; color: ${T.green}; }
  .companion-chat-steps li.is-current { color: ${T.onSurface}; font-weight: 500; }
  .companion-chat-spin {
    flex: none; width: 9px; height: 9px; margin: 0 1px;
    border-radius: 50%;
    border: 1.5px solid color-mix(in srgb, ${T.orange} 25%, transparent);
    border-top-color: ${T.orange};
    animation: companion-chat-spin 700ms linear infinite;
  }
  .companion-chat-more {
    padding: 0; border: none; background: none; cursor: pointer;
    font: inherit; color: ${T.textMutedLight};
    text-decoration: underline; text-underline-offset: 2px;
  }
  .companion-chat-more:hover { color: ${T.textMutedDark}; }
  .companion-chat-open {
    display: inline-flex; align-items: center; gap: 4px;
    height: 24px; padding: 0 10px;
    border: none; border-radius: 999px;
    background: ${T.surfaceSolid};
    box-shadow: 0 0 0 1px rgba(${T.shadowRgb}, 0.08), ${T.shadowBubble};
    font: 600 11px/1 -apple-system, system-ui, sans-serif;
    color: ${T.textMutedDark};
    cursor: pointer;
    transition: color 140ms ease, transform 100ms ease;
  }
  .companion-chat-open:hover { color: ${T.onSurface}; }
  .companion-chat-open:active { transform: scale(0.96); }
  @keyframes companion-chat-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .companion-chat * { animation: none !important; }
  }
  `
}
