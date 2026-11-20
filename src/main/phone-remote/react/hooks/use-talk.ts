import { useCallback, useEffect, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { CONFIG } from '@shared/config'
import { PHONE_AUDIO_TO, type PhoneAudioDestination } from '@shared/types'
import type { TalkOptionWire } from '@shared/phone-remote-protocol'
import { TALK, TALK_LABELS, COMPUTER_OPTION } from '@shared/talk'
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
}

interface UseTalkArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  micDown: (to?: PhoneAudioDestination) => void
  micUp: () => void
  cancelRecording: () => void
  settleClip: (opts?: { keepBlob?: boolean }) => void
  inFlightClipRef: RefObject<{ id: string; to: PhoneAudioDestination } | null>
  recording: boolean
  recordingTo: PhoneAudioDestination
  hearing: boolean
  setTalkOpen: Dispatch<SetStateAction<boolean>>
}

function optionFor(turn: TalkTurnView, id: string): TalkOptionWire {
  return turn.options.find((o) => o.id === id) ?? { ...COMPUTER_OPTION, percent: 100 }
}

export function talkHeadline(turn: TalkTurnView): string {
  const option = optionFor(turn, turn.pick)
  if (option.kind === 'computer') return TALK_LABELS.doing.computer
  const name = option.kind === 'new-agent' ? (option.project?.name ?? option.label) : option.label
  return `${TALK_LABELS.doing[option.kind]} ${name}`
}

function newTalkId(): string {
  return `talk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface TalkState {
  turns: TalkTurnView[]
  listening: boolean
  hearing: boolean
  heardError: string
  onMicDown: () => void
  onMicUp: () => void
  say: (text: string) => boolean
  go: (id: string, target: string) => void
  change: (id: string) => void
  cancel: (id: string) => void
}

export function useTalk({
  bus,
  send,
  micDown,
  micUp,
  cancelRecording,
  settleClip,
  inFlightClipRef,
  recording,
  recordingTo,
  hearing,
  setTalkOpen
}: UseTalkArgs): { openTalk: () => void; closeTalk: () => void; talk: TalkState } {
  const [turns, setTurns] = useState<TalkTurnView[]>([])
  const [heardError, setHeardError] = useState('')

  const patch = useCallback((id: string, change: (turn: TalkTurnView) => TalkTurnView) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? change(t) : t)))
  }, [])

  const addTurn = useCallback((id: string, text: string) => {
    setHeardError('')
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
        target: ''
      }
      return [...prev, turn].slice(-TALK.HISTORY_MAX)
    })
  }, [])

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('talkHeard', (msg) => {
        if (inFlightClipRef.current?.id === msg.id) settleClip()
        addTurn(msg.id, msg.text)
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
          openLabel: msg.openLabel
        }))
      }),
      bus.subscribe('transcribeFailed', (msg) => {
        if (
          inFlightClipRef.current?.id === msg.id &&
          inFlightClipRef.current.to === PHONE_AUDIO_TO.talk
        ) {
          setHeardError(msg.reason)
        }
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [bus, addTurn, patch, settleClip, inFlightClipRef])

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
    (raw: string) => {
      const text = raw.trim().slice(0, TALK.TEXT_MAX_CHARS)
      if (text === '') return false
      const id = newTalkId()
      if (!send({ type: 'talkSend', id, text })) {
        setHeardError(TALK_LABELS.notConnected)
        return false
      }
      addTurn(id, text)
      return true
    },
    [send, addTurn]
  )

  const onTalkMicDown = useCallback(() => {
    setHeardError('')
    micDown(PHONE_AUDIO_TO.talk)
  }, [micDown])

  const openTalk = useCallback(() => setTalkOpen(true), [setTalkOpen])
  const closeTalk = useCallback(() => {
    if (recording && recordingTo === PHONE_AUDIO_TO.talk) cancelRecording()
    setTalkOpen(false)
  }, [recording, recordingTo, cancelRecording, setTalkOpen])

  return {
    openTalk,
    closeTalk,
    talk: {
      turns,
      listening: recording && recordingTo === PHONE_AUDIO_TO.talk,
      hearing,
      heardError,
      onMicDown: onTalkMicDown,
      onMicUp: micUp,
      say,
      go,
      change,
      cancel
    }
  }
}
