import type { JSX, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Square, X } from 'lucide-react'
import { MOUSE_FRAMES } from './assets/mouse'
import { CONFIG } from '../../shared/config'
import type { CompanionState } from '../../shared/companion-state'
import { CompanionPill, companionPillCss, PILL_ACCENT, type PillOutcome } from './companion-pill'
import { VoiceChat, companionChatCss, type VoiceTurn } from './companion-chat'
import { TODAY_CSS } from './companion-pill-today.local'

const T = CONFIG.THEME_TOKENS

interface Frame {
  state: CompanionState
  outcome: PillOutcome
  step?: string
  heard?: string
  reply?: string
  failed?: boolean
  ms: number
}

const ASK = 'Hey Mighty, open my X and tweet something I would say'
const POST = 'Shipping beats perfect, every time'
const SLACK = 'Hey Mighty, send that to Sam on Slack'
const SCRIPT: Frame[] = [
  { state: 'idle', outcome: null, ms: 1200 },
  { state: 'listening', outcome: null, heard: ASK, ms: 2200 },
  { state: 'thinking', outcome: null, heard: ASK, ms: 900 },
  { state: 'thinking', outcome: null, step: "I'll open X and write a post in your voice", heard: ASK, ms: 1600 },
  { state: 'thinking', outcome: null, step: 'Opening x.com', heard: ASK, ms: 1400 },
  { state: 'thinking', outcome: null, step: 'Looking at the screen', heard: ASK, ms: 1200 },
  { state: 'thinking', outcome: null, step: 'Clicking', heard: ASK, ms: 900 },
  { state: 'thinking', outcome: null, step: `Typing “${POST}”`, heard: ASK, ms: 1800 },
  { state: 'talking', outcome: 'done', heard: ASK, reply: `Posted it: “${POST}”`, ms: 1100 },
  { state: 'talking', outcome: null, heard: ASK, reply: `Posted it: “${POST}”`, ms: 2400 },
  { state: 'idle', outcome: null, ms: 1200 },
  { state: 'listening', outcome: null, heard: SLACK, ms: 2000 },
  { state: 'thinking', outcome: null, step: 'Opening Slack', heard: SLACK, ms: 1600 },
  { state: 'thinking', outcome: null, step: 'Looking at the screen', heard: SLACK, ms: 1400 },
  { state: 'idle', outcome: 'failed', heard: SLACK, reply: "Couldn't do that", failed: true, ms: 2400 },
  { state: 'idle', outcome: null, ms: 3000 }
]

function chatAt(i: number): VoiceTurn[] {
  const done: VoiceTurn[] = []
  let steps: string[] = []
  for (let k = 0; k <= i; k++) {
    const f = SCRIPT[k]
    if (f.step && steps[steps.length - 1] !== f.step) steps = [...steps, f.step]
    if (f.outcome && !(SCRIPT[k - 1]?.outcome)) {
      done.push({ id: k, heard: f.heard ?? '', steps, reply: f.reply, failed: f.failed })
      steps = []
    }
  }
  const f = SCRIPT[i]
  if (!f.outcome && (f.state === 'listening' || f.state === 'thinking') && f.heard)
    done.push({ id: -1, heard: f.heard, steps: f.state === 'thinking' ? steps : [], live: true })
  return done
}

function useFakeMic(): number {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number): void => {
      const t = (now - t0) / 1000
      const syllable = Math.max(0, Math.sin(t * 9.5)) * (0.55 + 0.45 * Math.sin(t * 2.3))
      setLevel(Math.min(1, Math.max(0, syllable)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return level
}

function useScript(playing: boolean, run: number): { frame: Frame; since: number; i: number } {
  const [i, setI] = useState(0)
  const [since, setSince] = useState(Date.now())
  useEffect(() => { setI(0); setSince(Date.now()) }, [run])
  useEffect(() => {
    if (!playing) return
    const id = setTimeout(() => {
      const next = (i + 1) % SCRIPT.length
      setI(next)
      if (SCRIPT[next].state === 'thinking' && SCRIPT[i].state !== 'thinking') setSince(Date.now())
    }, SCRIPT[i].ms)
    return () => clearTimeout(id)
  }, [i, playing, run])
  return { frame: SCRIPT[i], since, i }
}

function Shadow({ css, children }: { css: string; children: ReactNode }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [root, setRoot] = useState<ShadowRoot | null>(null)
  useLayoutEffect(() => {
    if (host.current) setRoot(host.current.shadowRoot ?? host.current.attachShadow({ mode: 'open' }))
  }, [])
  return (
    <div ref={host} className="shadow-host">
      {root && createPortal(<><style>{css}</style>{children}</>, root as unknown as Element)}
    </div>
  )
}

function TodayPill({ frame, mic }: { frame: Frame; mic: number }): JSX.Element {
  const state = frame.state
  const listening = state === 'listening'
  const working = state === 'thinking' || state === 'talking'
  const word = { idle: 'Say "Hey Mighty"', listening: 'Listening', thinking: 'Working', talking: 'Talking', reacting: '' }[state]
  const bars = listening || state === 'talking' || state === 'idle'
  const level = listening ? Math.sqrt(mic) : state === 'talking' ? Math.sqrt(mic) * 0.8 : 0
  return (
    <div className={`companion-pill is-${state}`} style={{ ['--accent' as string]: PILL_ACCENT[state], ['--swell' as string]: listening ? `${1 + mic * 0.14}` : '1' }}>
      {!working && <span className="companion-pill-off"><X size={11} strokeWidth={3} /></span>}
      {working && (
        <span className="companion-pill-stop">
          <Square size={10} fill="currentColor" strokeWidth={0} />
          {state === 'thinking' && <kbd>esc</kbd>}
        </span>
      )}
      {bars && (
        <span className="companion-bars">
          {[0.55, 0.85, 1, 0.85, 0.55].map((w, k) => <span key={k} style={{ transform: `scaleY(${0.2 + level * w * 0.8})` }} />)}
        </span>
      )}
      {state === 'thinking' && <span className="companion-dots"><span /><span /><span /></span>}
      <span key={word} className="companion-pill-word">{word}</span>
      <span className="companion-pill-avatar">
        <span className="companion-pill-ring" style={{ opacity: listening ? 0.45 + mic * 0.55 : undefined }} />
        <img src={MOUSE_FRAMES.front} alt="" />
      </span>
    </div>
  )
}

function AfterPill({ frame, mic, since }: { frame: Frame; mic: number; since: number }): JSX.Element {
  const listening = frame.state === 'listening'
  const bars = listening ? Math.sqrt(mic) : frame.state === 'talking' ? Math.sqrt(mic) * 0.8 : 0
  return (
    <CompanionPill
      state={frame.state}
      outcome={frame.outcome}
      step={frame.step}
      paused={false}
      micLevel={listening ? mic : 0}
      barsLevel={bars}
      workingSince={frame.state === 'thinking' ? since : null}
      onStop={() => {}}
      onClose={() => {}}
    />
  )
}

function Bubble({ frame, today }: { frame: Frame; today: boolean }): JSX.Element | null {
  const showFail = frame.failed && today
  if (!frame.heard) return null
  return (
    <div className="h-bubble" key={frame.heard}>
      <p>{frame.heard}</p>
      {frame.reply && (!frame.failed || showFail) && <p className={frame.failed ? 'is-failed' : 'is-reply'}>{frame.reply}</p>}
    </div>
  )
}

function Stage({ label, today, frame, mic, since, i }: { label: string; today: boolean; frame: Frame; mic: number; since: number; i: number }): JSX.Element {
  return (
    <div className="h-stage">
      <div className="h-tag">{label}</div>
      <div className="h-stage-col">
        {today ? <Bubble frame={frame} today /> : <VoiceChat turns={chatAt(i)} hidden={false} onOpenChat={() => {}} />}
        {today ? (
          <Shadow css={TODAY_CSS}><TodayPill frame={frame} mic={mic} /></Shadow>
        ) : (
          <AfterPill frame={frame} mic={mic} since={since} />
        )}
      </div>
    </div>
  )
}

const CELLS: { name: string; frame: Frame }[] = [
  { name: 'Listening', frame: { state: 'listening', outcome: null, ms: 0 } },
  { name: 'Working', frame: { state: 'thinking', outcome: null, step: 'Opening Google Docs', ms: 0 } },
  { name: 'Done', frame: { state: 'talking', outcome: 'done', ms: 0 } },
  { name: 'Failed', frame: { state: 'idle', outcome: 'failed', failed: true, reply: "Couldn't do that", heard: ' ', ms: 0 } },
  { name: 'Talking', frame: { state: 'talking', outcome: null, ms: 0 } }
]

const WHAT_CHANGED: Record<string, string> = {
  Listening: 'Pill glow and ring grow with your voice; mouse leans in',
  Working: 'One light runs round the pill; shows the actual step and seconds',
  Done: 'Green flash, check draws in, mouse hops',
  Failed: 'Pill shakes red with a ! badge - today it just goes back to idle',
  Talking: 'Same as today'
}

function DoneReplay({ children }: { children: (k: number) => ReactNode }): JSX.Element {
  const [k, setK] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setK((x) => x + 1), 2600)
    return () => clearInterval(id)
  }, [])
  return <>{children(k)}</>
}

function Harness(): JSX.Element {
  const mic = useFakeMic()
  const [playing, setPlaying] = useState(true)
  const [run, setRun] = useState(0)
  const { frame, since, i } = useScript(playing, run)
  const [workingSince] = useState(() => Date.now() - 4000)
  return (
    <div className="h-page">
      <header className="h-head">
        <h1>Voice pill</h1>
        <span className="h-now">{frame.outcome ?? frame.state}{frame.step ? ` · ${frame.step}` : ''}</span>
        <button onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
        <button onClick={() => { setRun((r) => r + 1); setPlaying(true) }}>Restart turn</button>
      </header>
      <section className="h-stages">
        <Stage label="OLD: this morning, caption vanishes" today frame={frame} mic={mic} since={since} i={i} />
        <Stage label="AFTER: live steps + scrollable chat" today={false} frame={frame} mic={mic} since={since} i={i} />
      </section>
      <section className="h-grid">
        <div />
        {CELLS.map((c) => <div key={c.name} className="h-col">{c.name}</div>)}
        <div className="h-row">OLD</div>
        {CELLS.map((c) => (
          <div key={c.name} className="h-cell">
            <DoneReplay>
              {(k) => (
                <Shadow key={c.name === 'Done' || c.name === 'Failed' ? k : 0} css={TODAY_CSS}>
                  <TodayPill frame={c.name === 'Done' ? { ...c.frame, outcome: null } : c.name === 'Failed' ? { state: 'idle', outcome: null, ms: 0 } : c.frame} mic={mic} />
                </Shadow>
              )}
            </DoneReplay>
          </div>
        ))}
        <div className="h-row">NEW</div>
        {CELLS.map((c) => (
          <div key={c.name} className="h-cell">
            <DoneReplay>
              {(k) => <AfterPillKeyed k={c.name === 'Done' || c.name === 'Failed' ? k : 0} frame={c.frame} mic={mic} since={workingSince} />}
            </DoneReplay>
          </div>
        ))}
        <div />
        {CELLS.map((c) => <div key={c.name} className="h-why">{WHAT_CHANGED[c.name]}</div>)}
      </section>
    </div>
  )
}

function AfterPillKeyed({ k, ...rest }: { k: number; frame: Frame; mic: number; since: number }): JSX.Element {
  return <div key={k} className="h-keyed"><AfterPill {...rest} /></div>
}

const HARNESS_CSS = `
  html, body, #root { margin: 0; height: 100%; }
  body {
    background: #0e0e10; color: #f2f2f4;
    font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .h-page { max-width: 1440px; margin: 0 auto; padding: 18px 24px 24px; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px; }
  .h-head { display: flex; align-items: center; gap: 12px; }
  .h-head h1 { font-size: 18px; margin: 0; letter-spacing: -0.02em; }
  .h-now { font: 500 12px ui-monospace, monospace; color: #9a9aa3; margin-right: auto; }
  .h-head button {
    font: 600 12px system-ui; color: #f2f2f4; background: #26262b; border: 1px solid #36363d;
    border-radius: 8px; padding: 6px 12px; cursor: pointer;
  }
  .h-head button:hover { background: #303037; }
  .h-stages { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .h-stage {
    position: relative; height: 430px; border-radius: 16px; overflow: hidden;
    background: radial-gradient(120% 90% at 70% 0%, #2a2a31 0%, #121215 60%), #121215;
    border: 1px solid #24242a;
  }
  .h-tag { position: absolute; top: 12px; left: 14px; font: 700 11px system-ui; letter-spacing: 0.04em; color: #9a9aa3; }
  .h-stage-col {
    position: absolute; right: 28px; bottom: 26px; width: 300px;
    display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
  }
  .h-bubble {
    max-width: 100%; padding: 9px 12px; border-radius: 16px 16px 4px 16px;
    background: ${T.surfaceSolid}; color: ${T.onSurface};
    font-size: 12px; line-height: 1.4; display: flex; flex-direction: column; gap: 3px;
    animation: h-rise 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .h-bubble p { margin: 0; }
  .h-bubble p:first-child { font-weight: 500; }
  .h-bubble .is-reply { color: ${T.textMutedDark}; }
  .h-bubble .is-failed { color: ${T.redLight}; }
  @keyframes h-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .h-grid {
    display: grid; grid-template-columns: 70px 1fr 1.3fr 1fr 1fr 1fr; gap: 10px 12px; align-items: center;
  }
  .h-col { font: 700 12px system-ui; color: #c9c9d0; text-align: center; }
  .h-row { font: 700 11px system-ui; letter-spacing: 0.04em; color: #9a9aa3; }
  .h-cell {
    height: 96px; border-radius: 14px; background: #17171b; border: 1px solid #222228;
    display: flex; align-items: center; justify-content: center;
  }
  .h-why { font-size: 11.5px; line-height: 1.35; color: #a6a6ae; text-align: center; padding: 0 6px; }
  .shadow-host { font-family: -apple-system, 'SF Pro Display', system-ui, sans-serif; }
  .shadow-host, .h-keyed { display: flex; justify-content: flex-end; }
`

createRoot(document.getElementById('root') as HTMLElement).render(
  <>
    <style>{HARNESS_CSS + companionPillCss() + companionChatCss() + '@keyframes companion-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }'}</style>
    <Harness />
  </>
)
