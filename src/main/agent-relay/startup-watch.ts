import { mkdirSync } from 'fs'
import { devLog } from '../../shared/env'
import type { StartupPrompt } from '../../shared/types'
import { PATHS } from '../store/paths'
import { liveAgentSessions } from './mcp/http-listener'
import { answerStartup, peekStartup } from './picker-keys'
import { sendRelayPush } from './relay-send'
import { relayRequestStore } from './store'

const POLL_MS = 1000
const QUIET_MS = 10 * 60_000
const CARD_MS = 60 * 60_000
const TYPE_ROW = /^Type something/
const TRUST_YES = /^Yes\b.*\btrust/i

interface Card {
  id: string
  question: string
  options: string[]
}

const watched = new Set<string>()

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export function noProjectFolder(): string {
  mkdirSync(PATHS.CODE_NO_PROJECT, { recursive: true })
  return PATHS.CODE_NO_PROJECT
}

function registered(pane: string): boolean {
  return liveAgentSessions().some((s) => s.origin?.tmuxPane === pane)
}

async function ask(prompt: StartupPrompt, from: string, cwd: string): Promise<Card> {
  const request = relayRequestStore.mint(
    'ask',
    {
      question: prompt.question,
      context: prompt.detail || undefined,
      options: prompt.options.filter((option) => !TYPE_ROW.test(option)),
      from,
      cwd
    },
    CARD_MS
  )
  const sent = await sendRelayPush(request)
  if (!sent.ok) devLog.warn('[startup-watch] push failed', sent.detail)
  return { id: request.id, question: prompt.question, options: prompt.options }
}

type Verdict = { kind: 'waiting' } | { kind: 'picked'; index: number } | { kind: 'left' }

function verdict(card: Card): Verdict {
  const request = relayRequestStore.get(card.id)
  if (!request) return { kind: 'left' }
  if (request.status === 'pending' || relayRequestStore.undoPending(card.id)) return { kind: 'waiting' }
  const index = card.options.indexOf(request.response?.answer ?? '')
  return request.status === 'resolved' && index !== -1 ? { kind: 'picked', index } : { kind: 'left' }
}

async function watch(pane: string, from: string, cwd: string): Promise<void> {
  const quietBy = Date.now() + QUIET_MS
  let card: Card | null = null
  for (;;) {
    await delay(POLL_MS)
    const peek = await peekStartup(pane)
    const prompt = peek.alive ? peek.prompt : null
    if (card && prompt?.question !== card.question) {
      relayRequestStore.resolve(card.id, {}, null, 'screen')
      card = null
    }
    if (!peek.alive) return
    if (!prompt) {
      if (registered(pane) || Date.now() > quietBy) return
      continue
    }
    if (card) {
      const said = verdict(card)
      if (said.kind === 'waiting') continue
      if (said.kind === 'left') return
      await answerStartup(pane, said.index)
      card = null
      continue
    }
    const trust = cwd === PATHS.CODE_NO_PROJECT ? prompt.options.findIndex((option) => TRUST_YES.test(option)) : -1
    if (trust !== -1) await answerStartup(pane, trust)
    else card = await ask(prompt, from, cwd)
  }
}

export function watchStartup(input: { pane: string; from: string; cwd: string }): void {
  if (watched.has(input.pane)) return
  watched.add(input.pane)
  void watch(input.pane, input.from, input.cwd)
    .catch((err) => devLog.error('[startup-watch] failed', err))
    .finally(() => watched.delete(input.pane))
}
