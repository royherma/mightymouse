import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { CONFIG } from '@shared/config'
import { PHONE_AUDIO_TO, type PhoneAudioDestination } from '@shared/types'
import type { ChatSessionSummary, ChatStep, OpenChatThread } from '../chat-steps'
import { appendStep, runningLabel, RUNNING_FALLBACK } from '../chat-steps'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

interface UseChatArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  showToast: (
    text: string,
    historyId?: string | null,
    persist?: boolean,
    failed?: boolean,
    offline?: boolean
  ) => void
  setStatus: (status: string) => void
  settleClip: (opts?: { keepBlob?: boolean }) => void
  inFlightClipRef: RefObject<{
    id: string
    blob: Blob
    durationMs: number
    to: PhoneAudioDestination
  } | null>
  micDown: (to?: PhoneAudioDestination) => void
  micUp: () => void
  recording: boolean
  micStreamRef: RefObject<MediaStream | null>
  setChatOpen: Dispatch<SetStateAction<boolean>>
  chatOpen: boolean
  connState: UseConnectionResult['connState']
  chatDictating: boolean
  setChatDictating: (value: boolean) => void
}

/** Owns chat sessions, threads, streaming, dictation, and actions. */
export function useChat({
  bus,
  send,
  showToast,
  setStatus,
  settleClip,
  inFlightClipRef,
  micDown,
  micUp,
  recording,
  micStreamRef,
  setChatOpen,
  chatOpen,
  connState,
  chatDictating,
  setChatDictating
}: UseChatArgs) {
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([])
  const sessionPagesRef = useRef<ChatSessionSummary[]>([])
  // sessionId -> the phase that session is on right now. Fed by 'chatSessionPhase'
  // for EVERY running thread, including ones no surface has open -- which is the
  // whole point, since the list is where you look at threads you're not in.
  const [sessionPhases, setSessionPhases] = useState<Record<string, string>>({})
  const [chatThread, setChatThread] = useState<OpenChatThread | null>(null)
  const [chatBusy, setChatBusy] = useState(false)
  const chatBusyRef = useRef(false)
  const steerRef = useRef<{ text: string; projectId?: string } | null>(null)
  const phoneRunRef = useRef(false)
  const nativeChatHandlerRef = useRef<((text: string) => void) | null>(null)
  const nativeOpenChatRef = useRef<(() => void) | null>(null)
  chatBusyRef.current = chatBusy
  const [chatSteps, setChatSteps] = useState<ChatStep[]>([])
  // Mirror for the WS handler, which is registered once on mount and would
  // otherwise close over the empty list forever (same reason chatSessionIdRef
  // exists). Read on chatTurnDone to hand the finished steps to the turn.
  const chatStepsRef = useRef<ChatStep[]>([])
  chatStepsRef.current = chatSteps
  const [chatStreamed, setChatStreamed] = useState('')
  const [chatDraftPatch, setChatDraftPatch] = useState<string | null>(null)
  // The session reply box dictates on the chat pipeline (`to: 'chat'` keeps the
  // transcript out of a run), so the wire cannot say which box asked. Set at
  // mic-down and read when the transcript lands.
  const [sessionDraftPatch, setSessionDraftPatch] = useState<string | null>(null)
  const dictateToSessionRef = useRef(false)
  // The thread the composer targets. Distinct from chatThread?.id: a brand-new
  // chat has no id until the Mac mints one on chatTurnStart, and this is what
  // the next chatSend carries (undefined => "start a new thread").
  const chatSessionIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('chatSessions', (msg) => {
        const prev = msg.offset === 0 ? [] : sessionPagesRef.current
        const seen = new Set(prev.map((s) => s.id))
        sessionPagesRef.current = [...prev, ...msg.sessions.filter((s) => !seen.has(s.id))]
        const next = msg.offset + msg.sessions.length
        if (msg.hasMore && next < CONFIG.PHONE_REMOTE.CHAT_SESSION_LIST_MAX) send({ type: 'chatListSessions', offset: next })
        else setChatSessions(sessionPagesRef.current)
      }),
      bus.subscribe('chatSession', (msg) => {
        setChatThread({
          id: msg.id,
          title: msg.title,
          turns: msg.turns,
          truncated: msg.truncated,
          running: msg.running
        })
        chatSessionIdRef.current = msg.id
        phoneRunRef.current = false
        setChatBusy(msg.running)
        setChatSteps([])
        setChatStreamed('')
      }),
      bus.subscribe('chatTurnStart', (msg) => {
        // The Mac minted (or confirmed) the session — adopt its id so the
        // follow-up lands in the same thread, and its title so a brand-new
        // chat stops saying "New chat" the moment it has one.
        chatSessionIdRef.current = msg.sessionId
        setChatThread((prev) =>
          prev === null
            ? { id: msg.sessionId, title: msg.title, turns: [], truncated: false, running: true }
            : {
                ...prev,
                id: msg.sessionId,
                title: prev.title !== '' ? prev.title : msg.title,
                // The Mac just told us it started a run in this thread.
                running: true
              }
        )
      }),
      bus.subscribe('chatChunk', (msg) => {
        // Ignore events for a thread the user has since navigated away from,
        // or the reply would bleed into whatever is on screen now.
        if (msg.sessionId !== chatSessionIdRef.current) return
        if (msg.phase !== undefined) {
          setChatSteps((prev) =>
            appendStep(prev, msg.phase ?? '', msg.detail ?? '', CONFIG.PHONE_REMOTE.CHAT_STEP_LIMIT)
          )
        }
        if (msg.chunk !== undefined) setChatStreamed((prev) => prev + msg.chunk)
      }),
      bus.subscribe('chatTurnDone', (msg) => {
        if (msg.sessionId !== chatSessionIdRef.current) return
        phoneRunRef.current = false
        setChatBusy(false)
        setChatStreamed('')
        const steps = chatStepsRef.current
        setChatSteps([])
        setChatThread((prev) => {
          if (prev === null) return prev
          const turns = [...prev.turns]
          const lastIndex = turns.length - 1
          if (lastIndex >= 0 && turns[lastIndex].a === '') {
            turns[lastIndex] = { ...turns[lastIndex], a: msg.reply, ok: msg.ok, steps }
            return { ...prev, turns, running: false }
          }
          return { ...prev, running: false }
        })
      }),
      bus.subscribe('chatTranscript', (msg) => {
        // Into the DRAFT, never straight into a run: phone dictation mishears
        // often enough that auto-sending would spend a real agent turn on a
        // typo you never got to see.
        setChatDictating(false)
        setStatus('Live')
        if (msg.ok && msg.text.trim() !== '') {
          settleClip()
          if (dictateToSessionRef.current) setSessionDraftPatch(msg.text.trim())
          else setChatDraftPatch(msg.text.trim())
          return
        }
        if (inFlightClipRef.current !== null) return
        showToast(msg.reason ?? "Couldn't hear that")
      }),
      bus.subscribe('chatSessionPhase', (msg) => {
        // Keyed by session rather than merged into the rows so a list page
        // that arrives later (or replaces page 0) can't drop a phase that's
        // still current. Rows read through it; `running` still gates whether
        // a phase is shown at all, so a stale entry for a settled thread is
        // invisible rather than wrong.
        setSessionPhases((prev) => ({
          ...prev,
          [msg.sessionId]: runningLabel(
            [{ phase: msg.phase, detail: msg.detail ?? '', n: 1 }],
            RUNNING_FALLBACK
          )
        }))
      }),
      bus.subscribe('chatSessionChanged', (msg) => {
        send({ type: 'chatListSessions' })
        if (msg.sessionId === chatSessionIdRef.current && !(chatBusyRef.current && phoneRunRef.current)) {
          send({ type: 'chatGetSession', id: msg.sessionId })
        }
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [bus, inFlightClipRef, send, setChatDictating, setStatus, settleClip, showToast])

  // `closeIfOpen` is what separates the toolbar button from the Ask control:
  // the button toggles, the control means "put me in chat" and must not close
  // a sheet the user already has up.
  const enterChat = useCallback(
    (closeIfOpen: boolean) => {
      setChatOpen((wasOpen) => {
        if (wasOpen) return !closeIfOpen
        send({ type: 'chatListSessions' })
        return true
      })
    },
    [send]
  )

  const onToggleChat = useCallback(() => enterChat(true), [enterChat])
  nativeOpenChatRef.current = () => enterChat(false)

  const onChatOpenSession = useCallback(
    (id: string) => {
      chatSessionIdRef.current = id
      send({ type: 'chatGetSession', id })
    },
    [send]
  )

  const onChatNewSession = useCallback(() => {
    // Purely local: no session exists until the first message is sent, so the
    // Mac has nothing to mint yet. Clearing the id is what makes the next
    // chatSend start a fresh thread.
    chatSessionIdRef.current = undefined
    setChatThread(null)
    setChatBusy(false)
    setChatSteps([])
    setChatStreamed('')
  }, [])

  const onChatSend = useCallback(
    (text: string, projectId?: string) => {
      const liveSessionId = chatSessionIdRef.current
      if (chatBusyRef.current && liveSessionId !== undefined) {
        if (!send({ type: 'chatStop', sessionId: liveSessionId })) {
          showToast("Not sent - your Mac isn't connected", null, false, true)
          return false
        }
        steerRef.current = { text, projectId }
        return true
      }
      if (!send({ type: 'chatSend', sessionId: chatSessionIdRef.current, text, projectId })) {
        showToast("Not sent - your Mac isn't connected", null, false, true)
        return false
      }
      phoneRunRef.current = true
      const ts = new Date().toISOString()
      setChatThread((prev) =>
        prev === null
          ? {
              id: '',
              title: text,
              turns: [{ fromPhone: true, q: text, a: '', ts, ok: true }],
              truncated: false,
              running: true
            }
          : {
              ...prev,
              turns: [...prev.turns, { fromPhone: true, q: text, a: '', ts, ok: true }],
              running: true
            }
      )
      setChatBusy(true)
      setChatSteps([])
      setChatStreamed('')
      return true
    },
    [send, showToast]
  )
  nativeChatHandlerRef.current = onChatSend

  useEffect(() => {
    const steer = steerRef.current
    if (chatBusy || !steer) return
    steerRef.current = null
    onChatSend(steer.text, steer.projectId)
  }, [chatBusy, onChatSend])

  const onStopChat = useCallback(() => {
    const sessionId = chatSessionIdRef.current
    if (sessionId === undefined) return
    send({ type: 'chatStop', sessionId })
  }, [send])

  const onChatMicDown = useCallback(() => {
    dictateToSessionRef.current = false
    micDown(PHONE_AUDIO_TO.chat)
  }, [micDown])

  const onChatMicUp = useCallback(() => {
    micUp()
  }, [micUp])

  const onSessionMicDown = useCallback(() => {
    dictateToSessionRef.current = true
    micDown(PHONE_AUDIO_TO.chat)
  }, [micDown])

  const onSessionDraftConsumed = useCallback(() => setSessionDraftPatch(null), [])

  const sessionMic = useMemo(
    () => ({
      onMicDown: onSessionMicDown,
      onMicUp: onChatMicUp,
      dictating: chatDictating,
      recording,
      micStreamRef,
      draftPatch: sessionDraftPatch,
      onDraftConsumed: onSessionDraftConsumed
    }),
    [
      onSessionMicDown,
      onChatMicUp,
      chatDictating,
      recording,
      micStreamRef,
      sessionDraftPatch,
      onSessionDraftConsumed
    ]
  )

  // The draft handoff is one-shot: ChatSheet reports back once it has taken the
  // text, so a later re-render can't re-apply it over something newly typed.
  const onChatDraftConsumed = useCallback(() => setChatDraftPatch(null), [])

  const onCloseChat = useCallback(() => {
    setChatOpen(false)
  }, [setChatOpen])

  useEffect(() => {
    if (connState.kind !== 'connected' || !chatOpen) return
    const id = chatSessionIdRef.current
    if (id !== undefined && id !== '') send({ type: 'chatGetSession', id })
    send({ type: 'chatListSessions' })
  }, [connState, chatOpen, send])

  // Fold each running session's live phase into its row, so the list ships ONE
  // prop and a row physically cannot disagree with its own phase. Non-running
  // rows never read `phase`, so a leftover entry for a thread that has since
  // settled costs nothing.
  const sessionRows = useMemo(
    () =>
      chatSessions.map((s) =>
        s.running ? { ...s, phase: sessionPhases[s.id] ?? RUNNING_FALLBACK } : s
      ),
    [chatSessions, sessionPhases]
  )

  return {
    chatSessions: sessionRows,
    chatThread,
    chatBusy,
    chatSteps,
    chatStreamed,
    chatDraftPatch,
    onChatMicDown,
    onChatMicUp,
    onChatDraftConsumed,
    sessionMic,
    onToggleChat,
    onCloseChat,
    onChatOpenSession,
    onChatNewSession,
    onChatSend,
    onStopChat,
    nativeChatHandlerRef,
    nativeOpenChatRef
  }
}
