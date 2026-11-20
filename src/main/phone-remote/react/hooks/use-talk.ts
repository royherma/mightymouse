import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { CONFIG } from '@shared/config'
import type { TalkMediaWire, TalkOptionWire } from '@shared/phone-remote-protocol'
import { TALK, TALK_LABELS, COMPUTER_OPTION, talkHeadline as talkHeadlineOf } from '@shared/talk'
import { appendStep, type ChatStep } from '../chat-steps'
import { hapticTick } from '../haptics'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

export type TalkPhase = 'deciding' | 'choosing' | 'counting' | 'running' | 'done' | 'failed'

export interface TalkTurnView {
  id: string
  text: string
  phase: TalkPhase
  pick: string
  options: TalkOptionWire[]
  goAt: number
  steps: ChatStep[]
  streamed: string
  reply: string
  target: string
  openLabel?: string
  media?: TalkMediaWire
  photo?: string
}

interface UseTalkArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  sendBinary: UseConnectionResult['sendBinary']
  setTalkOpen: Dispatch<SetStateAction<boolean>>
}

function optionFor(turn: TalkTurnView, id: string): TalkOptionWire {
  return turn.options.find((o) => o.id === id) ?? { ...COMPUTER_OPTION, percent: 100 }
}

export function talkHeadline(turn: TalkTurnView): string {
  return talkHeadlineOf(turn.options, turn.pick)
}

function newTalkId(): string {
  return `talk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface TalkState {
  turns: TalkTurnView[]
  ideas: readonly string[]
  say: (text: string, file?: File | null) => boolean
  go: (id: string, target: string) => void
  change: (id: string) => void
  cancel: (id: string) => void
}

export function useTalk({
  bus,
  send,
  sendBinary,
  setTalkOpen
}: UseTalkArgs): { openTalk: () => void; closeTalk: () => void; talk: TalkState } {
  const [turns, setTurns] = useState<TalkTurnView[]>([])
  const [ideas, setIdeas] = useState<readonly string[]>(TALK_LABELS.ideas)

  const patch = useCallback((id: string, change: (turn: TalkTurnView) => TalkTurnView) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? change(t) : t)))
  }, [])

  const addTurn = useCallback((id: string, text: string, photo?: string) => {
    setTurns((prev) => {
      if (prev.some((t) => t.id === id)) return prev.map((t) => (t.id === id ? { ...t, text } : t))
      const turn: TalkTurnView = {
        id,
        text,
        phase: 'deciding',
        pick: TALK.COMPUTER_ID,
        options: [],
        goAt: 0,
        steps: [],
        streamed: '',
        reply: '',
        target: '',
        photo
      }
      return [...prev, turn].slice(-TALK.HISTORY_MAX)
    })
  }, [])

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('talkIdeas', (msg) => {
        if (msg.ideas.length > 0) setIdeas(msg.ideas)
      }),
      bus.subscribe('talkRoute', (msg) => {
        hapticTick()
        patch(msg.id, (t) =>
          t.phase !== 'deciding'
            ? t
            : {
                ...t,
                pick: msg.pick,
                options: msg.options,
                phase: msg.auto ? 'counting' : 'choosing',
                goAt: msg.auto ? Date.now() + TALK.AUTO_GO_MS : 0
              }
        )
      }),
      bus.subscribe('talkStep', (msg) => {
        patch(msg.id, (t) => ({
          ...t,
          steps:
            msg.phase !== undefined
              ? appendStep(
                  t.steps,
                  msg.phase,
                  msg.detail ?? '',
                  CONFIG.PHONE_REMOTE.CHAT_STEP_LIMIT
                )
              : t.steps,
          streamed: msg.chunk !== undefined ? t.streamed + msg.chunk : t.streamed
        }))
      }),
      bus.subscribe('talkDone', (msg) => {
        patch(msg.id, (t) => ({
          ...t,
          phase: msg.ok ? 'done' : 'failed',
          reply: msg.reply,
          target: msg.target || t.target,
          openLabel: msg.openLabel,
          media: msg.media
        }))
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [bus, patch])

  const go = useCallback(
    (id: string, target: string) => {
      const sent = send({ type: 'talkGo', id, target })
      patch(id, (t) => {
        if (!sent) return { ...t, phase: 'failed', reply: TALK_LABELS.notConnected }
        const option = optionFor(t, target)
        return { ...t, pick: target, phase: 'running', target: option.label, goAt: 0 }
      })
    },
    [send, patch]
  )

  const counting = turns.find((t) => t.phase === 'counting')
  const countId = counting?.id ?? ''
  const countPick = counting?.pick ?? ''
  const countAt = counting?.goAt ?? 0
  useEffect(() => {
    if (countId === '') return
    const timer = window.setTimeout(() => go(countId, countPick), Math.max(0, countAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [countId, countPick, countAt, go])

  const change = useCallback(
    (id: string) => patch(id, (t) => ({ ...t, phase: 'choosing', goAt: 0 })),
    [patch]
  )

  const cancel = useCallback(
    (id: string) => {
      send({ type: 'talkCancel', id })
      patch(id, (t) =>
        t.phase === 'running' ? t : { ...t, phase: 'failed', reply: TALK_LABELS.cancelled, goAt: 0 }
      )
    },
    [send, patch]
  )

  const say = useCallback(
    (raw: string, file?: File | null) => {
      const text = raw.trim().slice(0, TALK.TEXT_MAX_CHARS)
      if (text === '' && !file) return false
      const id = newTalkId()
      if (!file) {
        if (!send({ type: 'talkSend', id, text })) return false
        addTurn(id, text)
        return true
      }
      const attachLabel = `${TALK.ATTACH_PREFIX}${id}`
      addTurn(id, text, URL.createObjectURL(file))
      void file.arrayBuffer().then((buf) => {
        const sent =
          send({ type: 'imageMeta', mime: file.type, byteLength: buf.byteLength, name: file.name, replyToLabel: attachLabel }) &&
          sendBinary(buf) &&
          send({ type: 'talkSend', id, text, attachLabel })
        if (!sent) patch(id, (t) => ({ ...t, phase: 'failed', reply: TALK_LABELS.notConnected }))
      })
      return true
    },
    [send, sendBinary, addTurn, patch]
  )

  const openTalk = useCallback(() => {
    send({ type: 'talkIdeasGet' })
    setTalkOpen(true)
  }, [send, setTalkOpen])
  const closeTalk = useCallback(() => setTalkOpen(false), [setTalkOpen])

  return {
    openTalk,
    closeTalk,
    talk: {
      turns,
      ideas,
      say,
      go,
      change,
      cancel
    }
  }
}
