import type { CSSProperties, JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'
import { HideoutVitalsCard } from './HideoutVitals'
import { HideoutChain, HideoutReply, SpendRows, money, type PlaybackClock } from './HideoutReply'
import { HideoutOrb, ORB_BOX_PX, ORB_R, ORB_STATES, type HideoutOrbState } from './HideoutOrb'
import { ProjectIcon } from '../../../shared/project-icons'
import { useAgentRelay } from '../hooks/useAgentRelay'
import { PULSE_AXES } from '../../../shared/session-pulse'
import { HIDEOUT_FULL, HIDEOUT_NAME, HIDEOUT_SIDE, HIDEOUT_STUCK_VERDICTS, hideoutAsks, isHideoutFull, projectOf, type HideoutAsk, type HideoutControl, type HideoutState } from '../../../shared/hideout'
import type { CompanionState } from '../../../shared/companion-state'
import type { AgentChecklist, AgentRelaySessionInfo } from '../../../shared/types'
import './HideoutView.css'

const HOURS = 8
const HOUR_MS = 3_600_000
const STILL_MS = 2500
const BOOT_MS = 1300
const RAIL_BELOW_PX = 900
const RAIL = { W: 420, orbY: 150, orbK: 0.4, voiceTop: 236, colsTop: 450 }
const LETTERS = 'ABCDEFGH'
const PALETTE = [
  CONFIG.THEME_TOKENS.hideoutOrange,
  CONFIG.THEME_TOKENS.hideoutAmber,
  CONFIG.THEME_TOKENS.hideoutCyan,
  CONFIG.THEME_TOKENS.hideoutGreen,
  CONFIG.THEME_TOKENS.hideoutViolet
]
const RANK = { stuck: 3, needs_you: 2, on_track: 1, done: 0 }
type Tone = keyof typeof RANK
export type HideoutMic = 'on' | 'busy' | 'blocked'

const MIC_WORD: Record<HideoutMic | 'muted', string> = {
  on: 'Mic on',
  muted: 'Mic muted',
  busy: 'Mic busy with dictation',
  blocked: 'Mic blocked - allow it in System Settings'
}

const STATUS_WORD: Record<HideoutOrbState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  talking: 'Speaking',
  reacting: 'Done',
  paused: 'Paused'
}

const VERDICT_WORD: Record<string, string> = {
  on_track: 'On track',
  done: 'Done',
  needs_you: 'Needs you',
  looping: 'Going in circles',
  off_goal: 'Drifting',
  thin_proof: 'Light on proof',
  risky: 'Risky'
}

const ICON_CHECK = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M4 10.5l4 4 8-9" />
  </svg>
)
const ICON_RING = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <circle cx="10" cy="10" r="7" opacity=".3" />
    <path d="M10 3a7 7 0 0 1 7 7" />
  </svg>
)
const ICON_MIC = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <rect x="7" y="2.5" width="6" height="10" rx="3" />
    <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
  </svg>
)
const ICON_DOT = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <circle cx="10" cy="10" r="5" opacity=".45" />
  </svg>
)

interface Group {
  project: string
  sessions: AgentRelaySessionInfo[]
  lead: AgentRelaySessionInfo
  tone: Tone
  word: string
  progress?: number
}

export function useHideout(): HideoutState | null {
  const [hideout, setHideout] = useState<HideoutState | null>(null)
  useEffect(() => {
    void window.api.hideoutControl({ kind: 'get' }).then(setHideout)
    return window.api.onHideoutState(setHideout)
  }, [])
  return hideout
}

const control = (c: HideoutControl): Promise<HideoutState> => window.api.hideoutControl(c)

function ago(at: number, now: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000))
  return m < 1 ? 'now' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`
}

function colorOf(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function Avatar({ name, session }: { name: string; session?: AgentRelaySessionInfo }): JSX.Element {
  const p = session?.project
  return (
    <span className="av" style={{ '--c': colorOf(name) } as CSSProperties}>
      {p?.imageBase64 ? (
        <img src={`data:image/png;base64,${p.imageBase64}`} alt="" />
      ) : p?.icon ? (
        <ProjectIcon id={p.icon} size={18} />
      ) : (
        name[0]?.toUpperCase()
      )}
    </span>
  )
}

function toneOf(s: AgentRelaySessionInfo, verdicts: Record<string, string>): { tone: Tone; word: string } {
  if ((s.waiting ?? 0) > 0) return { tone: 'needs_you', word: 'Needs you' }
  const v = s.sessionId ? verdicts[s.sessionId] : undefined
  if (!v) return { tone: 'on_track', word: 'Working' }
  if (HIDEOUT_STUCK_VERDICTS.includes(v) || v === 'risky') return { tone: 'stuck', word: VERDICT_WORD[v] }
  if (v === 'needs_you' || v === 'thin_proof') return { tone: 'needs_you', word: VERDICT_WORD[v] }
  return { tone: v === 'done' ? 'done' : 'on_track', word: VERDICT_WORD[v] ?? 'Working' }
}

function groupByProject(sessions: AgentRelaySessionInfo[], verdicts: Record<string, string>): Group[] {
  const by = new Map<string, AgentRelaySessionInfo[]>()
  for (const s of sessions) by.set(projectOf(s), [...(by.get(projectOf(s)) ?? []), s])
  const groups = [...by].map(([project, list]) => {
    const ranked = list
      .map((s) => ({ s, ...toneOf(s, verdicts) }))
      .sort((a, b) => RANK[b.tone] - RANK[a.tone] || (b.s.lastActivityAt ?? 0) - (a.s.lastActivityAt ?? 0))
    const withProgress = list.filter((s) => s.progress !== undefined)
    return {
      project,
      sessions: list,
      lead: ranked[0].s,
      tone: ranked[0].tone,
      word: ranked[0].word,
      progress: withProgress.length ? withProgress.reduce((n, s) => n + (s.progress ?? 0), 0) / withProgress.length : undefined
    }
  })
  return groups.sort((a, b) => RANK[b.tone] - RANK[a.tone] || (b.lead.lastActivityAt ?? 0) - (a.lead.lastActivityAt ?? 0))
}

function OptRows({ ask }: { ask: HideoutAsk }): JSX.Element {
  return (
    <>
      {ask.options.map((o, k) => {
        const pct = ask.pcts[k]
        return (
          <Button key={o} variant="bare" className={`opt ${k === ask.recommended ? 'top' : ''}`} onClick={() => void control({ kind: 'answer', askId: ask.id, option: k })}>
            <span className="k">{LETTERS[k]}</span>
            <span className="l">
              {o}
              {k === ask.recommended && !ask.approve ? <small>Recommended</small> : null}
            </span>
            <span className="p">{pct === undefined ? '' : `${Math.round(pct)}%`}</span>
            {pct === undefined ? null : (
              <span className="fill">
                <i style={{ width: `${Math.max(2, pct)}%` }} />
              </span>
            )}
          </Button>
        )
      })}
    </>
  )
}

function TodayChart({ answered, arrived, hideout, now }: { answered: number[]; arrived: number[]; hideout: HideoutState; now: number }): JSX.Element {
  const bucket = (times: number[]): number[] => {
    const out = new Array<number>(HOURS).fill(0)
    for (const t of times) {
      const i = HOURS - 1 - Math.floor((now - t) / HOUR_MS)
      if (i >= 0 && i < HOURS) out[i]++
    }
    return out
  }
  const a = bucket(answered)
  const r = bucket(arrived)
  const max = Math.max(1, ...a, ...r)
  const { usd, answers, free } = hideout.today
  return (
    <div className="today">
      <div className="bars">
        {a.map((n, i) => (
          <span key={i} className="col" title={`${r[i]} asked, ${n} answered`}>
            <i className="asked" style={{ height: `${(r[i] / max) * 100}%` }} />
            <i className="answered" style={{ height: `${(n / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="legend">
        <span>{HOURS}h ago</span>
        <span>
          <i className="asked" />
          asked
          <i className="answered" />
          answered
        </span>
        <span>now</span>
      </div>
      <div className="cost">
        <b>{usd ? money(usd) : '$0.00'}</b>
        <span>
          across {answers} {answers === 1 ? 'answer' : 'answers'}, {free} free
        </span>
      </div>
      <SpendRows rows={hideout.spend} />
    </div>
  )
}

function useChecklist(session: AgentRelaySessionInfo | undefined): AgentChecklist | undefined {
  const ref = session ? (session.sessionId ?? session.label) : undefined
  const [value, setValue] = useState<{ ref?: string; list?: AgentChecklist }>({})
  useEffect(() => {
    if (!ref) return
    let live = true
    const load = (): void => {
      void window.api.agentRelaySessionChecklist(ref).then(
        (list) => live && setValue({ ref, list }),
        () => undefined
      )
    }
    load()
    const poll = setInterval(load, 5000)
    return () => {
      live = false
      clearInterval(poll)
    }
  }, [ref])
  return value.ref === ref ? value.list : undefined
}

function AgentFocus({ group, hideout, now }: { group: Group; hideout: HideoutState; now: number }): JSX.Element {
  const lead = group.lead
  const checklist = useChecklist(lead)
  const scores = lead.sessionId ? hideout.scores[lead.sessionId] : undefined
  const axes = scores
    ? PULSE_AXES.map((a) => ({ label: a.label, v: scores[a.key] ?? 0, color: a.key === 'proof' ? 'var(--violet)' : (scores[a.key] ?? 0) < 50 ? 'var(--red)' : 'var(--cyan)' }))
    : group.progress !== undefined
      ? [{ label: 'Progress', v: Math.round(group.progress * 100), color: 'var(--cyan)' }]
      : []
  const items = checklist?.items ?? []
  return (
    <div className="fcard">
      <div className="fhead">
        <Avatar name={group.project} session={lead} />
        <div>
          <div className="t">{group.project}</div>
          <div className="s">
            {[lead.model, lead.since ? `running ${ago(lead.since, now)}` : '', group.sessions.length > 1 ? `${group.sessions.length} agents` : ''].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className={`verdict ${group.tone}`}>
          <i />
          {group.word}
        </div>
      </div>
      <div className="fgrid">
        <div>
          <h3>{items.length ? 'Its plan' : 'Its agents'}</h3>
          {items.length
            ? items.slice(0, 9).map((it, k) => (
                <div key={k} className={`step ${it.status === 'completed' ? 'did' : it.status === 'in_progress' ? 'now' : ''}`}>
                  {it.status === 'completed' ? ICON_CHECK : it.status === 'in_progress' ? ICON_RING : ICON_DOT}
                  <span>{it.label}</span>
                </div>
              ))
            : group.sessions.slice(0, 6).map((s, k) => (
                <div key={k} className="step now">
                  {ICON_RING}
                  <span>{s.tldr ?? s.stated ?? s.label}</span>
                </div>
              ))}
        </div>
        <div>
          <h3>How it&apos;s going</h3>
          {axes.map((a) => (
            <div key={a.label} className="axis">
              <span>{a.label}</span>
              <span className="fill">
                <i style={{ width: `${a.v}%`, background: a.color }} />
              </span>
              <b>{a.v}</b>
            </div>
          ))}
          {lead.preview || lead.tldr ? (
            <div className="said">
              <span>Last thing it said</span>
              {lead.preview ?? lead.tldr}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function AskFocus({ ask, session, now }: { ask: HideoutAsk; session?: AgentRelaySessionInfo; now: number }): JSX.Element {
  const name = ask.project ?? 'An agent'
  return (
    <div className="fcard decision">
      <div className="fhead">
        <Avatar name={name} session={session} />
        <div>
          <div className="t">{name}</div>
          <div className="s">asked {ago(ask.createdAt, now)} ago</div>
        </div>
        <div className="verdict needs_you">
          <i />
          Needs you
        </div>
      </div>
      <div className="fq">{ask.question}</div>
      <OptRows ask={ask} />
      <div className="fsay">
        Say <q>A</q>, <q>the second one</q>, or <q>back</q>.
      </div>
    </div>
  )
}

function useStage(): { W: number; H: number; s: number; rail: boolean } {
  const measure = (): { W: number; H: number; s: number; rail: boolean } => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (vw < RAIL_BELOW_PX) {
      const W = Math.max(RAIL.W, vw)
      return { W, H: Math.round((W * vh) / vw), s: vw / W, rail: true }
    }
    const W = Math.max(1800, Math.round((1080 * vw) / vh))
    const H = Math.max(1080, Math.round((W * vh) / vw))
    return { W, H, s: Math.min(vw / W, vh / H), rail: false }
  }
  const [layout, setLayout] = useState(measure)
  useEffect(() => {
    const onResize = (): void => setLayout(measure())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return layout
}

export function HideoutView({
  hideout,
  state,
  mic,
  micLevel,
  mouthOpen,
  speaking,
  position
}: {
  hideout: HideoutState
  state: CompanionState
  mic: HideoutMic
  micLevel: number
  mouthOpen: number
  speaking: boolean
  position: PlaybackClock
}): JSX.Element {
  const relay = useAgentRelay()
  const layout = useStage()
  const [now, setNow] = useState(Date.now())
  const [phase, setPhase] = useState<'booting' | 'entering' | 'ready'>('booting')
  const [still, setStill] = useState(false)

  useEffect(() => {
    const enter = setTimeout(() => setPhase('entering'), BOOT_MS)
    const ready = setTimeout(() => setPhase('ready'), BOOT_MS + 1200)
    return () => {
      clearTimeout(enter)
      clearTimeout(ready)
    }
  }, [])

  useEffect(() => {
    let t = setTimeout(() => setStill(true), STILL_MS)
    const onMove = (): void => {
      setStill(false)
      clearTimeout(t)
      t = setTimeout(() => setStill(true), STILL_MS)
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15_000)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void control({ kind: hideout.focus ? 'back' : 'close' })
      if (e.key === ' ') {
        e.preventDefault()
        void control({ kind: hideout.paused ? 'resume' : 'pause' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(tick)
      window.removeEventListener('keydown', onKey)
    }
  }, [hideout.focus, hideout.paused])

  const sessions = useMemo(() => (relay.status.agentSessions ?? []).filter((s) => !s.stale), [relay.status.agentSessions])
  const groups = useMemo(() => groupByProject(sessions, hideout.verdicts), [sessions, hideout.verdicts])
  const asks = useMemo(() => hideoutAsks(relay.pending, sessions), [relay.pending, sessions])
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  const answered = relay.resolved.filter((r) => r.resolvedAt && r.resolvedVia !== 'timeout').map((r) => r.resolvedAt as number)
  const arrived = [...relay.pending, ...relay.resolved].filter((r) => r.verb === 'ask' || r.verb === 'approve').map((r) => r.createdAt)
  const answeredToday = answered.filter((t) => t >= dayStart).length
  const stuck = groups.filter((g) => g.tone === 'stuck').length
  const working = groups.filter((g) => g.tone !== 'done').length

  const focus = hideout.focus
  const focusAsk = focus?.kind === 'ask' ? asks.find((a) => a.id === focus.id) : undefined
  const focusGroup = focus?.kind === 'agent' ? groups.find((g) => g.project === focus.project) : undefined
  const focused = !!(focusAsk || focusGroup)
  const hotProject = focusGroup?.project ?? focusAsk?.project
  const groupOf = (project: string | null): Group | undefined => groups.find((g) => g.project === project)

  const mode: HideoutOrbState = hideout.paused ? 'paused' : state
  const level = hideout.paused ? 0 : state === 'talking' ? mouthOpen : state === 'listening' ? micLevel : 0
  const micState = mic === 'on' && hideout.paused ? 'muted' : mic
  const hearing = micState === 'on'
  const home = layout.rail
    ? { x: layout.W / 2, y: RAIL.orbY, k: RAIL.orbK }
    : focused
      ? { x: layout.W - 170, y: layout.H / 2, k: 56 / ORB_R } : { x: layout.W / 2, y: Math.round(layout.H * 0.435), k: 1 }
  const statusColor = `rgb(${ORB_STATES[mode].rgb.join(',')})`
  const d = new Date(now)
  const hint = hideout.paused ? 'resume' : groups.length ? 'what needs me' : 'help'

  return (
    <div className={`hideout ${phase} ${focused ? 'focus' : ''} ${still && !layout.rail ? 'still' : ''} ${layout.rail ? 'rail' : ''}`}>
      <div className="stage" style={{ width: layout.W, height: layout.H, transform: `translate(-50%, -50%) scale(${layout.s})` }}>
        <div
          className="orb-wrap"
          style={{ width: ORB_BOX_PX, height: ORB_BOX_PX, transform: `translate(${home.x - ORB_BOX_PX / 2}px, ${home.y - ORB_BOX_PX / 2}px) scale(${home.k})` }}
        >
          <HideoutOrb state={mode} level={level} scale={layout.s * home.k} />
        </div>

        <header className="topbar">
          <div className="brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <circle cx="12" cy="12" r="10" opacity=".35" />
              <circle cx="12" cy="12" r="5.5" opacity=".7" />
              <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
            </svg>
            MightyMouse <span className="tag">{HIDEOUT_NAME}</span>
          </div>
          <div className="summary">
            <span>
              <b>{working}</b>working
            </span>
            <span className="needs">
              <b>{asks.length}</b>need you
            </span>
            {stuck ? (
              <span className="stuckn">
                <b>{stuck}</b>stuck
              </span>
            ) : null}
            <span>
              <b>{answeredToday}</b>answered today
            </span>
          </div>
          <div className="clock">
            <div className="t">{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            <div className="d">{d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          </div>
        </header>

        <div className="cols" style={layout.rail ? { top: RAIL.colsTop } : undefined}>
          <aside className="panel agents">
            <section className="agent-list">
              <div className="ph">
                Agents <b>{groups.length}</b>
              </div>
              {groups.length ? (
                groups.slice(0, 8).map((g) => (
                  <Button
                    key={g.project}
                    variant="bare"
                    className={`agent ${g.tone} ${g.project === hotProject ? 'hot' : ''}`}
                    onClick={() => void control({ kind: 'focus', focus: { kind: 'agent', project: g.project } })}
                  >
                    <Avatar name={g.project} session={g.lead} />
                    <span className="name">{g.project}</span>
                    <span className="verdict">
                      <i />
                      {g.word}
                    </span>
                    <span className="doing">{g.lead.tldr ?? g.lead.stated ?? g.lead.label}</span>
                    <span className="meta">
                      {[g.sessions.length > 1 ? `${g.sessions.length} agents` : g.lead.model, g.lead.since ? ago(g.lead.since, now) : ''].filter(Boolean).join(' · ')}
                    </span>
                    <span className="bar">
                      <i style={{ width: `${Math.round((g.progress ?? 0) * 100)}%` }} />
                    </span>
                  </Button>
                ))
              ) : (
                <div className="empty">No agents running. Start one in your terminal and it shows up here.</div>
              )}
            </section>
            <HideoutVitalsCard v={hideout.vitals} />
          </aside>

          <aside className="panel right">
            <section>
              <div className="ph">
                Needs you <b>{asks.length}</b>
              </div>
              {asks.length ? (
                asks.slice(0, 3).map((a, i) => (
                  <div key={a.id} className={`ask ${i ? 'compact' : ''}`}>
                    <div className="who">
                      <Avatar name={a.project ?? 'Agent'} session={groupOf(a.project)?.lead} />
                      {a.project ?? 'An agent'}
                      <span className="age">{ago(a.createdAt, now)}</span>
                    </div>
                    <div className="q">{a.question}</div>
                    <OptRows ask={a} />
                  </div>
                ))
              ) : (
                <div className="empty">Nothing is waiting on you.</div>
              )}
              {asks.length > 3 ? <div className="empty">+{asks.length - 3} more - say next</div> : null}
            </section>
            <section>
              <div className="ph">Today</div>
              <TodayChart answered={answered} arrived={arrived} hideout={hideout} now={now} />
            </section>
            <section>
              <div className="ph">Just now</div>
              {hideout.feed.slice(0, 3).map((f) => (
                <div key={f.at + f.text} className="event">
                  <i className="pip" />
                  <span>{f.text}</span>
                  <time>{ago(f.at, now)}</time>
                </div>
              ))}
            </section>
          </aside>
        </div>

        <div className="voice" style={{ top: layout.rail ? RAIL.voiceTop : Math.round(layout.H * 0.435 + ORB_R * 2.16) }}>
          <div className="status">
            <span className={`mic ${hearing ? 'on' : 'off'}`}>
              {ICON_MIC}
              {MIC_WORD[micState]}
              {hearing ? (
                <span className="meter">
                  {[0.6, 1, 0.8, 0.95, 0.7].map((m, i) => (
                    <i key={i} style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, micLevel * m * 1.6))})` }} />
                  ))}
                </span>
              ) : null}
            </span>
            <span className="state" style={{ color: statusColor }}>
              <i className="dot" />
              {STATUS_WORD[mode]}
            </span>
          </div>
          <div className="heard">{hideout.heard ? `“${hideout.heard}”` : ''}</div>
          {hideout.reply && !hideout.paused ? (
            <HideoutReply
              reply={hideout.reply}
              voiced={hideout.voiced}
              words={hideout.words}
              waiting={state === 'thinking'}
              speaking={speaking}
              position={position}
            />
          ) : hideout.heard && state === 'thinking' ? (
            <div className="reply">
              <span className="hint thinking">Thinking</span>
            </div>
          ) : (
            <div className="reply">
              <span className="hint">
                Say <q>{hint}</q>
                {hideout.paused ? ' or press space' : ''}
              </span>
            </div>
          )}
          <div className="steps">
            {hideout.steps.length > 1
              ? hideout.steps.map((s, i) => (
                  <span key={i} className="chip ok">
                    {ICON_CHECK}
                    {s}
                  </span>
                ))
              : null}
            {hideout.paused ? null : <HideoutChain hops={hideout.chain} firstSoundMs={hideout.firstSoundMs} />}
          </div>
        </div>

        <div className="focus-layer" style={layout.rail ? { top: RAIL.colsTop } : undefined}>
          {focusAsk ? <AskFocus ask={focusAsk} session={groupOf(focusAsk.project)?.lead} now={now} /> : null}
          {focusGroup ? <AgentFocus group={focusGroup} hideout={hideout} now={now} /> : null}
        </div>
      </div>

      <nav className="controls" aria-label={`${HIDEOUT_NAME} controls`}>
        {focused ? (
          <Button variant="bare" onClick={() => void control({ kind: 'back' })}>
            Back
          </Button>
        ) : null}
        <Button variant="bare" onClick={() => void control({ kind: 'place', place: isHideoutFull(hideout.place) ? HIDEOUT_SIDE : HIDEOUT_FULL })}>
          {isHideoutFull(hideout.place) ? 'Side view' : 'Full screen'}
        </Button>
        <Button variant="bare" className={hideout.paused ? 'on' : ''} onClick={() => void control({ kind: hideout.paused ? 'resume' : 'pause' })}>
          {hideout.paused ? 'Resume' : 'Pause'} <kbd>space</kbd>
        </Button>
        <Button variant="bare" onClick={() => void control({ kind: 'close' })}>
          Exit <kbd>esc</kbd>
        </Button>
      </nav>
    </div>
  )
}
