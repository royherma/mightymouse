import { useCallback, useEffect, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'
import type { AgentRelayStatus } from '@shared/types'
import type {
  RelayRequestWire,
  RelayResponseWire,
  RelayTapMissReason,
  RelayTapOutcome,
  RelayVerbWire
} from '@shared/phone-remote-protocol'
import { DEFAULT_RELAY_TURN_END_PING } from '@shared/relay-push-filter'
import type { RelayNotifyPushLevel, RelayPushFilter } from '@shared/relay-push-filter'
import type { RelayRefusal } from '@shared/relay-cards'
import { suggestWireKey } from '@shared/swipe-suggest'
import type { Suggestion } from '@shared/swipe-suggest'
import type { SocketBus } from '../socket-bus'
import { currentDeviceCredential } from '../useHostDiscovery'
import { nativeBridge } from '../native-bridge'
import type { UseConnectionResult } from './use-connection'

interface UseRelayArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  /** A picked photo's bytes. Separate from `send` because the wire pairs a JSON
   *  meta frame with the blob that follows it, by arrival order. */
  sendBinary: UseConnectionResult['sendBinary']
  showToast: (
    text: string,
    historyId?: string | null,
    persist?: boolean,
    failed?: boolean,
    offline?: boolean
  ) => void
}

/** Owns relay queue, session previews, wrap, refusal, and push filter. */
export function useRelay({ bus, send, sendBinary, showToast }: UseRelayArgs) {
  // Code relay. Both lists are whole-snapshot replacements, never appended:
  // the Mac re-sends all of them on every store change, so a card resolved on
  // the lock screen disappears here without the phone tracking anything.
  const [relayPending, setRelayPending] = useState<RelayRequestWire[]>([])
  const [relayResolved, setRelayResolved] = useState<RelayRequestWire[]>([])
  // Cleared without answering. Its own list, not a flavour of resolved: only
  // these carry `undoable`, and only while the Mac's undo window is open.
  const [relayDismissed, setRelayDismissed] = useState<RelayRequestWire[]>([])
  // Has a relay snapshot ever landed? The Code sheet's empty states read this
  // to tell "nothing to show" from "nothing can reach me", which look
  // identical otherwise. The snapshot is the same message that carries the
  // cards, so receiving one proves the whole relay path -- unlike a bare
  // socket-open flag, which is true across exactly the failure being caught.
  // Sticky on purpose; `relayLinkOk` below ANDs it with the live connState, so
  // a drop reports honestly without a reconnect having to re-prove the path.
  const [relaySnapshotSeen, setRelaySnapshotSeen] = useState(false)
  // Only ever set by the Mac's `relayRefused` push -- the phone drops a card
  // optimistically, so without this an answer that lost the race just looks
  // like the tap worked.
  const [relayRefusal, setRelayRefusal] = useState<RelayRefusal | null>(null)
  // Who is connected, pushed as `relayStatus`. Null until the first push lands:
  // the strip renders nothing rather than claiming zero agents, which on a
  // socket that has not delivered yet would be a wrong number, not an unknown.
  const [relayStatus, setRelayStatus] = useState<AgentRelayStatus | null>(null)
  // Null until the Mac answers -- guessing "all on" would paint a muted verb live.
  const [relayPushFilter, setRelayPushFilter] = useState<RelayPushFilter | null>(null)
  const [relayNotifyLevel, setRelayNotifyLevel] = useState<RelayNotifyPushLevel>('all')
  const [relayTurnEndPing, setRelayTurnEndPing] = useState(DEFAULT_RELAY_TURN_END_PING)
  const [sessionPreviews, setSessionPreviews] = useState<Record<string, string>>({})
  /** What this phone has said to each agent, as the MAC holds it. Not written
   *  optimistically on send: the Mac is what survives a reload, so painting
   *  locally first would put a turn on screen that a refresh then deleted. */
  const [sessionSent, setSessionSent] = useState<Record<string, { text: string; at: number }[]>>({})
  /** Keyed by label AND tldr, not label alone: the answer belongs to what the
   *  agent said it was doing, so a card whose TLDR moved on reads as having none
   *  rather than showing chips written for the previous subject. */
  const [sessionSuggestions, setSessionSuggestions] = useState<Record<string, Suggestion[]>>({})
  const [sessionPreviewAges, setSessionPreviewAges] = useState<Record<string, number>>({})
  // The last peek verdict, stamped so a repeat tap with the same outcome still
  // re-shows the caption. Only the open sheet reads it.
  const [sessionPeekOutcome, setSessionPeekOutcome] = useState<{
    label: string
    outcome: 'changed' | 'unchanged' | 'unavailable'
    at: number
  } | null>(null)
  // Per label, not one flag: one dead origin must not caption every other
  // session's button.
  const [sessionGoToFailed, setSessionGoToFailed] = useState<ReadonlySet<string>>(() => new Set())
  // Stamped, like sessionPeekOutcome: the sheet steps aside so the trackpad is
  // under the thumb, and a second Open on Mac on the same label must land again.
  const [sessionRevealedAt, setSessionRevealedAt] = useState<number | null>(null)
  /** Per-label, because the sheet can be paged between agents while a zoom is
   *  still in flight and a single flag would paint the wrong one. */
  const [sessionZoomed, setSessionZoomed] = useState<Readonly<Record<string, boolean>>>({})
  // Set by a native `openRelayRequest` intent (a notification tap) and
  // cleared once CodeSheet has scrolled to and highlighted that card, so a
  // second tap on the SAME request still re-triggers the scroll.
  const [focusedRelayRequestId, setFocusedRelayRequestId] = useState<string | null>(null)
  const nativeOpenRelayRef = useRef<((requestId: string) => void) | null>(null)
  nativeOpenRelayRef.current = (requestId) => setFocusedRelayRequestId(requestId)

  useEffect(() => {
    const unsubscribers = [
      bus.subscribe('relayPending', (msg) => {
        setRelayPending(msg.pending)
        setRelayResolved(msg.resolved)
        setRelayDismissed(msg.dismissed)
        setRelaySnapshotSeen(true)
      }),
      bus.subscribe('relayStatus', (msg) => {
        setRelayStatus(msg.status)
      }),
      bus.subscribe('relayPushFilter', (msg) => {
        setRelayPushFilter(msg.filter)
        setRelayNotifyLevel(msg.notifyLevel)
        setRelayTurnEndPing(msg.turnEndPing)
      }),
      bus.subscribe('relaySuggestions', (msg) => {
        const key = suggestWireKey(msg.label, msg.tldr)
        const suggestions = msg.suggestions
        setSessionSuggestions((prev) => ({ ...prev, [key]: suggestions }))
      }),
      bus.subscribe('relaySessionSent', (msg) => {
        setSessionSent((prev) => ({ ...prev, [msg.label]: msg.turns }))
      }),
      bus.subscribe('relaySessionPreview', (msg) => {
        // An 'unavailable' answer carries no text -- writing it would blank a
        // preview that is still the best thing we have to show.
        if (msg.preview !== '') {
          setSessionPreviews((prev) => ({ ...prev, [msg.label]: msg.preview }))
        }
        if (msg.changedAt !== undefined) {
          const at = msg.changedAt
          setSessionPreviewAges((prev) => ({ ...prev, [msg.label]: at }))
        }
        if (msg.outcome !== undefined) {
          const outcome = msg.outcome
          setSessionPeekOutcome({ label: msg.label, outcome, at: Date.now() })
        }
      }),
      bus.subscribe('relaySessionRevealed', (msg) => {
        // Both verdicts get a toast. The Mac's screen is the proof, but it is
        // the one screen the person holding the phone is not looking at, so
        // from here a success and a no-op look identical.
        if (msg.ok) {
          showToast(CONFIG.UI_LABELS.CODE_SESSION_GOTO_DONE)
          setSessionRevealedAt(Date.now())
          return
        }
        showToast(CONFIG.UI_LABELS.CODE_SESSION_GOTO_MISSING, null, false, true)
        setSessionGoToFailed((prev) => new Set(prev).add(msg.label))
      }),
      bus.subscribe('relaySessionZoomed', (msg) => {
        // The Mac's answer is authoritative: on a failure it echoes the state
        // the pane is really in, which un-does the optimistic paint.
        setSessionZoomed((prev) => ({ ...prev, [msg.label]: msg.on }))
        if (!msg.ok) showToast(CONFIG.UI_LABELS.CODE_SESSION_ZOOM_MISSING, null, false, true)
      }),
      bus.subscribe('relayRefused', (msg) => {
        setRelayRefusal({ requestId: msg.requestId, kind: msg.kind })
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [bus, showToast])

  const onRelayRespond = useCallback(
    (requestId: string, response: RelayResponseWire) => {
      // Optimistic removal only. The Mac re-broadcasts the whole list on every
      // store change, so if this answer lost the first-answer-wins race the
      // next snapshot puts the card back with someone else's answer on it.
      // A multi-question answer (questionIndex set) leaves the request pending
      // at the next question, so removing it here blanks the card mid-interview
      // until the Mac's snapshot restores it.
      if (response.questionIndex === undefined) {
        setRelayPending((prev) => prev.filter((r) => r.id !== requestId))
      }
      send({ type: 'relayRespond', requestId, response })
    },
    [send]
  )

  // Diagnostic only. A tap landing on the wrong screen is invisible from the
  // Mac, so the phone states where it went and the journal keeps it.
  const onRelayTapTrace = useCallback(
    (requestId: string, outcome: RelayTapOutcome) => {
      send({ type: 'relayTapTrace', requestId, outcome })
    },
    [send]
  )

  // The tap is finished -- it opened the card, or the card is provably gone.
  // Telling Swift is what lets it hold the stashed id until then instead of
  // clearing it on a send it cannot confirm anyone received.
  const onFocusedRelayRequestConsumed = useCallback(() => {
    if (focusedRelayRequestId) nativeBridge.relayIntentHandled(focusedRelayRequestId)
    setFocusedRelayRequestId(null)
  }, [focusedRelayRequestId])

  const onRelayTapMissed = useCallback(
    (reason: RelayTapMissReason) => {
      showToast(
        reason === 'session-gone'
          ? 'That agent stopped running - showing all your sessions'
          : 'That request is gone - it was answered somewhere else'
      )
    },
    [showToast]
  )

  const onRelayUndismiss = useCallback(
    (requestId: string) => {
      // No optimistic move: undo puts a card BACK, and the Mac is the only side
      // that knows whether the window is still open. It answers with a fresh
      // snapshot, or with `relayRefused` if it was already too late.
      send({ type: 'relayUndismiss', requestId })
    },
    [send]
  )

  const onSessionPeek = useCallback(
    (label: string) => {
      send({ type: 'relaySessionPeek', label })
    },
    [send]
  )

  const onRequestSuggestions = useCallback(
    (label: string, tldr: string, refresh?: boolean) => {
      // The old answer is dropped HERE, not on arrival: a caller that only asks
      // is showing the cached chips, and leaving them up through a refresh reads
      // as a button that does nothing for as long as the model takes.
      if (refresh) {
        const key = suggestWireKey(label, tldr)
        setSessionSuggestions((prev) => {
          if (!(key in prev)) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
      send({ type: 'relaySuggest', label, tldr, refresh })
    },
    [send]
  )

  // No optimistic write -- the Mac's echo moves the switch, so a dead link
  // refuses to budge instead of lying.
  const onSetRelayPush = useCallback(
    (verb: RelayVerbWire, on: boolean) => {
      send({ type: 'relaySetPushFilter', verb, on })
    },
    [send]
  )

  const onSetRelayNotifyLevel = useCallback(
    (level: RelayNotifyPushLevel) => {
      send({ type: 'relaySetNotifyLevel', level })
    },
    [send]
  )

  const onSetRelayTurnEndPing = useCallback(
    (on: boolean) => {
      send({ type: 'relaySetTurnEndPing', on })
    },
    [send]
  )

  const onRequestRelayPush = useCallback(() => {
    send({ type: 'relayGetPushFilter' })
  }, [send])

  const onSessionReply = useCallback(
    (label: string, text: string) => {
      send({ type: 'relaySessionReply', label, text })
    },
    [send]
  )

  const onSessionStop = useCallback(
    (label: string) => {
      send({ type: 'relaySessionStop', label })
    },
    [send]
  )

  const onSessionSentGet = useCallback(
    (label: string) => {
      send({ type: 'relaySessionSentGet', label })
    },
    [send]
  )

  // Cleared on every attempt, so a session that failed once and now resolves
  // stops claiming it can't be found.
  const onSessionGoTo = useCallback(
    (label: string) => {
      setSessionGoToFailed((prev) => {
        if (!prev.has(label)) return prev
        const next = new Set(prev)
        next.delete(label)
        return next
      })
      send({ type: 'relaySessionReveal', label })
    },
    [send]
  )

  // Painted before the Mac answers: a tmux zoom lands in ~30ms, and waiting for
  // the round-trip makes the button feel broken on the tap.
  const onSessionZoom = useCallback(
    (label: string, on: boolean) => {
      setSessionZoomed((prev) => ({ ...prev, [label]: on }))
      send({ type: 'relaySessionZoom', label, on })
    },
    [send]
  )

  // Answers a photos_get card. `requestId` on the meta is the whole routing
  // decision: without it the Mac pastes the image at the cursor, which is what
  // the share sheet does and is not what an agent asked for.
  const onRelayPickPhoto = useCallback(
    async (requestId: string, file: File): Promise<boolean> => {
      // Read BEFORE the meta goes out. `send` drops silently on a closed
      // socket, so a failed read after a delivered meta would leave the Mac
      // holding a pending frame for bytes that never arrive.
      const buf = await file.arrayBuffer()
      send({
        type: 'imageMeta',
        mime: file.type,
        byteLength: buf.byteLength,
        name: file.name,
        requestId
      })
      return sendBinary(buf)
    },
    [send, sendBinary]
  )

  // Attaches a photo to the reply being typed to this agent. Same meta-then-
  // binary transport as the photos_get picker above, and the same read-first
  // ordering for the same reason -- only the routing field differs, because the
  // Mac holds these bytes for the reply instead of resolving a card with them.
  const onSessionAttach = useCallback(
    async (label: string, file: File): Promise<boolean> => {
      const buf = await file.arrayBuffer()
      send({
        type: 'imageMeta',
        mime: file.type,
        byteLength: buf.byteLength,
        name: file.name,
        replyToLabel: label
      })
      return sendBinary(buf)
    },
    [send, sendBinary]
  )

  // Relative on purpose: this page is served BY the Mac that holds the image,
  // so the origin is already correct on LAN and through the tunnel alike.
  const relayImageSrc = useCallback(
    (requestId: string) =>
      `/relay-image?requestId=${encodeURIComponent(requestId)}&credential=${encodeURIComponent(currentDeviceCredential() ?? '')}`,
    []
  )

  return {
    relayPending,
    relayResolved,
    relayDismissed,
    relaySnapshotSeen,
    relayRefusal,
    relayStatus,
    relayPushFilter,
    relayNotifyLevel,
    relayTurnEndPing,
    sessionPreviews,
    sessionSent,
    onSessionSentGet,
    sessionSuggestions,
    sessionPreviewAges,
    sessionPeekOutcome,
    sessionGoToFailed,
    sessionRevealedAt,
    sessionZoomed,
    focusedRelayRequestId,
    nativeOpenRelayRef,
    onRelayRespond,
    onRelayTapTrace,
    onFocusedRelayRequestConsumed,
    onRelayTapMissed,
    onRelayUndismiss,
    onSessionPeek,
    onRequestSuggestions,
    onSetRelayPush,
    onSetRelayNotifyLevel,
    onSetRelayTurnEndPing,
    onRequestRelayPush,
    onSessionReply,
    onSessionStop,
    onSessionAttach,
    onSessionGoTo,
    onSessionZoom,
    onRelayPickPhoto,
    relayImageSrc
  }
}
