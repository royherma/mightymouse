import { ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { CHANNELS } from '../shared/ipc'
import { devLog } from '../shared/env'
import {
  HIDEOUT_FULL,
  HIDEOUT_NAME,
  HIDEOUT_HOP,
  HIDEOUT_SIDE,
  isHideoutFull,
  voiceHop,
  hideoutAsks,
  hideoutStuck,
  planHideout,
  projectOf,
  type HideoutAsk,
  type HideoutCommand,
  type HideoutControl,
  type HideoutHop,
  type HideoutPlace,
  type HideoutState,
  type HideoutWorld
} from '../shared/hideout'
import type { AgentRelaySessionInfo, SpokenWord } from '../shared/types'
import type { LiveTurnResult } from '../shared/companion-state'
import { currentStatus } from './ipc/agent-relay'
import { relaySnapshot } from './agent-relay/wire'
import { relayRequestStore } from './agent-relay/store'
import { stateFor } from './agent-relay/session-pulse'
import { placeCompanionHideout, sendToCompanion, setCompanionHideout } from './companion-window'
import { speakLocal } from './audio/tts'
import { playSound } from './sound-window'
import { startVitals, stopVitals } from './hideout-vitals'
import { PATHS } from './store/paths'
import { newsBetween, recapToday, sinceLastLook, takeLook, type HideoutLook, type HideoutNews } from './hideout-news'
import { resolveSessionRef } from './agent-relay/session-control'
import { sendToSession } from './ipc/phone-remote-chat'

const FEED_MAX = 12
const NEWS_EVERY_MS = 4000
const NEWS_GAP_MS = 8000
const HELLO_REPLIES = ['Loud and clear.', 'I hear you.', 'Right here.', "Yep, I'm listening."]
const SHOWS = new Set<HideoutCommand['kind']>(['show', 'needs', 'next'])
const VERDICT_WORDS: Record<string, string> = {
  on_track: 'on track',
  done: 'done',
  needs_you: 'waiting on you',
  looping: 'going in circles',
  off_goal: 'drifting off the goal',
  thin_proof: 'light on proof',
  risky: 'doing something risky'
}

const state: HideoutState = {
  open: false,
  paused: false,
  place: { ...HIDEOUT_FULL },
  focus: null,
  heard: '',
  reply: '',
  voiced: false,
  words: null,
  chain: [],
  firstSoundMs: null,
  steps: [],
  feed: [],
  ...loadToday(),
  verdicts: {},
  scores: {},
  vitals: null
}
let lastSaid = ''
let lastLook: HideoutLook | null = null
let newsLook: HideoutLook | null = null
let newsTimer: ReturnType<typeof setInterval> | null = null
const newsQueue: HideoutNews[] = []
const announced = new Set<string>()
let quietUntil = 0
let watching: string | null = null

function dayKey(): string {
  return new Date().toLocaleDateString('en-CA')
}

function loadToday(): Pick<HideoutState, 'today' | 'spend'> {
  const empty = { today: { day: dayKey(), usd: 0, answers: 0, free: 0 }, spend: [] }
  try {
    const saved = JSON.parse(readFileSync(PATHS.HIDEOUT_TODAY, 'utf8')) as Pick<HideoutState, 'today' | 'spend'>
    return saved.today?.day === empty.today.day && Array.isArray(saved.spend) ? saved : empty
  } catch {
    return empty
  }
}

function rollDay(): void {
  if (state.today.day === dayKey()) return
  state.today = { day: dayKey(), usd: 0, answers: 0, free: 0 }
  state.spend = []
}

export const isHideoutOpen = (): boolean => state.open
export const isHideoutPaused = (): boolean => state.paused

function sessions(): AgentRelaySessionInfo[] {
  return (currentStatus().agentSessions ?? []).filter((s) => !s.stale)
}

function pulses(list: AgentRelaySessionInfo[]): void {
  state.verdicts = {}
  state.scores = {}
  for (const s of list) {
    if (!s.sessionId) continue
    const rows = stateFor(s.sessionId).rows
    if (!rows.length) continue
    state.verdicts[s.sessionId] = rows[rows.length - 1].verdict
    state.scores[s.sessionId] = rows[rows.length - 1].scores
  }
}

function world(): { w: HideoutWorld; list: AgentRelaySessionInfo[] } {
  const list = sessions()
  pulses(list)
  const w: HideoutWorld = {
    open: state.open,
    paused: state.paused,
    projects: [...new Set(list.map(projectOf))],
    stuck: hideoutStuck(list, state.verdicts),
    asks: hideoutAsks(relaySnapshot().pending, list),
    focus: state.focus,
    place: state.place
  }
  return { w, list }
}

function push(): void {
  sendToCompanion(CHANNELS.hideoutState, state)
}

function note(text: string): void {
  state.feed = [{ at: Date.now(), text }, ...state.feed].slice(0, FEED_MAX)
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function orList(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`
}

function brief(w: HideoutWorld): string {
  if (!w.projects.length) return 'No agents are running right now.'
  const parts = [`${plural(w.projects.length, 'agent', 'agents')} working.`]
  parts.push(w.asks.length ? `${plural(w.asks.length, 'thing needs', 'things need')} you.` : 'Nothing needs you.')
  if (w.stuck) parts.push(`${w.stuck} looks stuck.`)
  return parts.join(' ')
}

function readAsk(a: HideoutAsk): string {
  state.focus = { kind: 'ask', id: a.id }
  const who = a.project ?? 'An agent'
  const pick = a.approve ? '' : ` I'd pick ${a.options[a.recommended]}.`
  return `${who} asks: ${a.question.replace(/[.?!]*$/, '?')} ${orList(a.options)}.${pick}`
}

function describe(project: string, w: HideoutWorld, list: AgentRelaySessionInfo[]): string {
  state.focus = { kind: 'agent', project }
  const s = list.find((x) => projectOf(x) === project)
  const verdict = s?.sessionId ? VERDICT_WORDS[state.verdicts[s.sessionId] ?? ''] : undefined
  const parts = [`${project}: ${s?.tldr ?? 'working'}.`]
  if (s?.progress !== undefined) parts.push(`${Math.round(s.progress * 100)} percent done.`)
  if (verdict) parts.push(`Looks ${verdict}.`)
  const ask = w.asks.find((a) => a.project === project)
  if (ask) parts.push(`It's waiting on you: ${ask.question}`)
  return parts.join(' ')
}

function answer(askId: string, option: number, w: HideoutWorld): string {
  const a = w.asks.find((x) => x.id === askId)
  if (!a || !a.options[option]) return 'That one is already answered.'
  const response = a.approve ? { approved: option === 0 } : { answer: a.options[option] }
  const outcome = relayRequestStore.resolve(a.id, response, null, 'chip')
  devLog.log('[hideout] answer', { askId, option, outcome })
  if (outcome !== 'resolved' && outcome !== 'buffered') return 'That one was already answered somewhere else.'
  playSound('success')
  const who = a.project ?? 'the agent'
  note(`You told ${who}: ${a.options[option]}`)
  if (state.focus?.kind === 'ask' && state.focus.id === a.id) state.focus = null
  return `Done. Told ${who}: ${a.options[option]}.`
}

function label(c: HideoutCommand, w: HideoutWorld): string {
  if (c.kind === 'show') return `Show ${c.project}`
  if (c.kind === 'watch') return `Watch ${c.project}`
  if (c.kind === 'tell') return `Tell ${c.project ?? c.name}`
  if (c.kind === 'noProject') return `No project called ${c.name}`
  if (c.kind === 'place') return c.name.replace(/\.$/, '')
  if (c.kind === 'answer') {
    const a = w.asks.find((x) => x.id === c.askId)
    return a ? `${a.project ?? 'Agent'}: ${a.options[c.option]}` : 'Answer'
  }
  return c.kind[0].toUpperCase() + c.kind.slice(1)
}

function run(c: HideoutCommand): string {
  const { w, list } = world()
  switch (c.kind) {
    case 'open':
      state.open = true
      state.paused = false
      state.focus = null
      setReply('', '', [], false)
      rollDay()
      setCompanionHideout(true)
      startVitals((v) => {
        state.vitals = v
        push()
      })
      note(`${HIDEOUT_NAME} opened`)
      return opening(w, list)
    case 'close':
      return closeHideout()
    case 'pause':
      state.paused = true
      note('Paused')
      return 'Paused. Say resume when you want me back.'
    case 'resume':
      state.paused = false
      note('Resumed')
      return "I'm back."
    case 'needs':
      if (!w.asks.length) return 'Nothing needs you right now.'
      return `${plural(w.asks.length, 'thing needs', 'things need')} you. ${readAsk(w.asks[0])}`
    case 'next': {
      const f = state.focus
      if (f?.kind === 'agent' && w.projects.length) {
        return describe(w.projects[(w.projects.indexOf(f.project) + 1) % w.projects.length], w, list)
      }
      if (f?.kind === 'ask' && w.asks.length > 1) {
        return readAsk(w.asks[(w.asks.findIndex((a) => a.id === f.id) + 1) % w.asks.length])
      }
      return w.asks.length ? readAsk(w.asks[0]) : 'Nothing else needs you.'
    }
    case 'back':
      state.focus = null
      watching = null
      return 'Back to everything.'
    case 'status':
      return brief(w)
    case 'help':
      return "Ask me anything and I'll hand it to an agent. Quick ones answer instantly, like what needs me, how's a project doing, or ship it."
    case 'hello': {
      const fresh = HELLO_REPLIES.filter((r) => r !== lastSaid)
      return fresh[Math.floor(Math.random() * fresh.length)]
    }
    case 'repeat':
      return lastSaid || "I haven't said anything yet."
    case 'show':
      return describe(c.project, w, list)
    case 'watch':
      watching = c.project
      if (isHideoutFull(state.place)) place({ ...HIDEOUT_SIDE })
      return `Watching ${c.project}. ${describe(c.project, w, list)}`
    case 'tell':
      return tell(c, w, list)
    case 'recap':
      return recapToday(list)
    case 'answer':
      return answer(c.askId, c.option, w)
    case 'place':
      place(c.place)
      return c.name
    case 'noProject':
      return `I don't see ${c.name}. ${w.projects.length ? `You have ${orList(w.projects)}.` : 'No agents are running.'}`
  }
}

function opening(w: HideoutWorld, list: AgentRelaySessionInfo[]): string {
  newsLook = takeLook(list, state.verdicts, w.asks)
  newsQueue.length = 0
  quietUntil = Date.now() + NEWS_GAP_MS
  if (newsTimer) clearInterval(newsTimer)
  newsTimer = setInterval(newsTick, NEWS_EVERY_MS)
  const since = lastLook ? sinceLastLook(lastLook, newsLook) : null
  return since ? `${since} ${brief(w)}` : brief(w)
}

function newsTick(): void {
  if (!state.open) return
  const { w, list } = world()
  const now = takeLook(list, state.verdicts, w.asks)
  if (newsLook) {
    for (const n of newsBetween(newsLook, now, w.asks)) {
      if (!announced.has(n.key) && (!watching || n.project === watching)) newsQueue.push(n)
      announced.add(n.key)
    }
  }
  newsLook = now
  const next = !state.paused && Date.now() >= quietUntil ? newsQueue.shift() : undefined
  if (next) void announce(next)
}

async function announce(n: HideoutNews): Promise<void> {
  quietUntil = Date.now() + NEWS_GAP_MS
  lastSaid = n.line
  setReply('', n.detail ? `${n.line} ${n.detail}` : n.line, [], false)
  note(n.line)
  push()
  const spoken = await speakLocal(n.line)
  if (spoken.audio) sendToCompanion(CHANNELS.companionAck, { audio: spoken.audio, mimeType: spoken.mimeType, text: n.line, announce: true })
}

function tell(c: Extract<HideoutCommand, { kind: 'tell' }>, w: HideoutWorld, list: AgentRelaySessionInfo[]): string {
  const project = c.project
  if (!project) return `Which agent? ${w.projects.length ? `You have ${orList(w.projects)}.` : 'No agents are running.'}`
  const info = list.filter((s) => projectOf(s) === project && s.sessionId).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
  const session = info?.sessionId ? resolveSessionRef(info.sessionId) : undefined
  if (!session || session.staleSince !== undefined) return `I can't reach ${project} right now.`
  state.focus = { kind: 'agent', project }
  note(`You told ${project}: ${c.message}`)
  void sendToSession(session, c.message, [])
    .then((via) => {
      if (via === 'skipped') void announce({ key: `tell:${Date.now()}`, project, line: `That didn't reach ${project}. Its terminal won't take typing.` })
    })
    .catch((e) => devLog.log('[hideout] tell failed', e))
  return `Told ${project}: ${c.message}.`
}

function place(p: HideoutPlace): void {
  state.place = p
  placeCompanionHideout(p)
}

function closeHideout(): string {
  const { w, list } = world()
  lastLook = takeLook(list, state.verdicts, w.asks)
  if (newsTimer) clearInterval(newsTimer)
  newsTimer = null
  watching = null
  state.open = false
  state.paused = false
  state.focus = null
  state.vitals = null
  stopVitals()
  setCompanionHideout(false)
  note(`${HIDEOUT_NAME} closed`)
  return `Closing the ${HIDEOUT_NAME}.`
}

function setReply(said: string, reply: string, steps: string[], voiced: boolean): void {
  if (said) quietUntil = Math.max(quietUntil, Date.now() + NEWS_GAP_MS)
  state.heard = said
  state.reply = reply
  state.voiced = voiced
  state.words = null
  state.chain = []
  state.firstSoundMs = null
  state.steps = steps
}

type HideoutTurn = { result: LiveTurnResult; commands: number; hops: HideoutHop[] }

async function speakHideoutReply(said: string, reply: string, commands: number, labels: string[], hereMs: number): Promise<HideoutTurn> {
  lastSaid = reply
  setReply(said, reply, labels, true)
  push()
  const voiceAt = Date.now()
  const spoken = await speakLocal(reply)
  const voice = voiceHop(spoken.provider, Date.now() - voiceAt)
  if (spoken.words) setHideoutWords(spoken.words)
  return {
    commands,
    hops: [{ ...HIDEOUT_HOP.here, ms: hereMs, usd: 0 }, ...(voice ? [voice] : [])],
    result: {
      ok: true,
      transcript: said,
      reply,
      ...(spoken.audio ? { audio: spoken.audio, audioMimeType: spoken.mimeType, spokenText: reply } : {})
    }
  }
}

export async function runHideoutTurn(said: string, addressed: boolean): Promise<HideoutTurn | null> {
  const startedAt = Date.now()
  const { w } = world()
  const plan = planHideout(said, w)
  if (!plan.complete) return null
  if (!addressed && !plan.commands.every((c, i) => c.kind !== 'answer' || state.focus || plan.commands.slice(0, i).some((p) => SHOWS.has(p.kind)))) return null
  const labels = plan.commands.map((c) => label(c, w))
  const lines = plan.commands.map(run)
  const reply = lines[lines.length - 1]
  return speakHideoutReply(said, reply, plan.commands.length, labels, Date.now() - startedAt)
}

export function showHideoutTurn(said: string, reply: string, steps: string[], voiced = false): void {
  if (!state.open) return
  setReply(said, reply, steps, voiced)
  push()
}

export function setHideoutWords(words: SpokenWord[]): void {
  if (!state.open) return
  state.words = words
  push()
}

export function openHideout(): void {
  if (state.open) setCompanionHideout(true)
  else run({ kind: 'open' })
  push()
}

export function recordHideoutTurn(hops: HideoutHop[], firstSoundMs: number | null): void {
  if (!state.open || !hops.length) return
  state.chain = hops
  state.firstSoundMs = firstSoundMs
  rollDay()
  const usd = hops.reduce((n, h) => n + (h.usd ?? 0), 0)
  state.today.answers++
  state.today.usd += usd
  if (!usd) state.today.free++
  for (const { key, icon, model, label, local, usd = 0 } of hops) {
    const row = state.spend.find((r) => r.key === key)
    if (row) {
      row.turns++
      row.usd += usd
    } else state.spend.push({ key, icon, model, label, local, turns: 1, usd })
  }
  try {
    writeFileSync(PATHS.HIDEOUT_TODAY, JSON.stringify({ today: state.today, spend: state.spend }))
  } catch (e) {
    devLog.log('[hideout] today save failed', e)
  }
  push()
}

function control(c: HideoutControl): HideoutState {
  const { w } = world()
  if (c.kind === 'pause' || c.kind === 'resume') run({ kind: c.kind })
  else if (c.kind === 'close') closeHideout()
  else if (c.kind === 'back') {
    state.focus = null
    watching = null
  }
  else if (c.kind === 'focus') state.focus = c.focus
  else if (c.kind === 'place') place(c.place)
  else if (c.kind === 'answer') setReply(state.heard, answer(c.askId, c.option, w), [], false)
  if (c.kind !== 'get') push()
  return state
}

export function registerHideoutIpc(): void {
  ipcMain.handle(CHANNELS.hideoutControl, (_e, c: HideoutControl) => control(c))
}
