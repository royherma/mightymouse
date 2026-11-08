/**
 * The Mac swipe deck window: one live agent per card, decided with a swipe or a
 * key.
 *
 * The deck itself is `@shared/swipe-deck` -- the same component the phone
 * mounts. This file is the Mac's half: IPC instead of a socket, hyphenated class
 * names instead of camelCase, a keyboard instead of a thumb, and no haptics.
 *
 * The arming store is per-window rather than persisted. On the phone it is
 * localStorage because which action the user tends to pick is a property of the
 * person holding it; here the window is opened to clear a queue and closed
 * again, so a session-lived memory is the whole useful lifetime.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import './deck.css'
import SwipeDeck from '@shared/swipe-deck'
import type { DeckArming, SwipeDeckClasses } from '@shared/swipe-deck'
import { buildDeck, mergeDeck, removeCard } from '@shared/swipe-triage'
import type { SwipeAffirm, SwipeCard } from '@shared/swipe-triage'
import { relayStatusLine } from '@shared/relay-status'
import { suggestWireKey } from '@shared/swipe-suggest'
import type { Suggestion } from '@shared/swipe-suggest'
import type { RelayRequestWire } from '@shared/phone-remote-protocol'
import type { AgentRelayStatus } from '@shared/types'

/** The hyphenated half of the pair. The phone's camelCase copy is
 *  `PHONE_DECK_CLASSES`; neither host may reach for the other's names. */
const MAC_DECK_CLASSES: SwipeDeckClasses = {
  scrim: 'deck-scrim',
  root: 'deck-root',
  rootOpen: 'deck-open',
  header: 'deck-header',
  title: 'deck-title',
  headerBtn: 'deck-header-btn',
  headerBtns: 'deck-header-btns',
  headerBack: 'deck-header-back',
  count: 'deck-count',
  jumpAnchor: 'deck-jump-anchor',
  jump: 'deck-jump',
  jumpRow: 'deck-jump-row',
  jumpWho: 'deck-jump-who',
  jumpName: 'deck-jump-name',
  jumpWhat: 'deck-jump-what',
  jumpDot: 'deck-jump-dot',
  empty: 'deck-empty',
  emptyTitle: 'deck-empty-title',
  emptyBody: 'deck-empty-body',
  passed: 'deck-passed',
  again: 'deck-again',
  stage: 'deck-stage',
  stamp: 'deck-stamp',
  card: 'deck-card',
  cardBehind: 'deck-card-behind',
  cardRising: 'deck-card-rising',
  cardLeaving: 'deck-card-leaving',
  head: 'deck-head',
  who: 'deck-who',
  name: 'deck-name',
  place: 'deck-place',
  age: 'deck-age',
  goTo: 'deck-goto',
  subject: 'deck-subject',
  subjectMuted: 'deck-subject-muted',
  subjectTag: 'deck-subject-tag',
  facts: 'deck-facts',
  last: 'deck-last',
  ask: 'deck-ask',
  askLabel: 'deck-ask-label',
  askText: 'deck-ask-text',
  failed: 'deck-failed',
  more: 'deck-more',
  note: 'deck-note',
  actions: 'deck-actions',
  actionsNudge: 'deck-actions-nudge',
  chip: 'deck-chip',
  chipEmoji: 'deck-chip-emoji',
  chipSkeleton: 'deck-chip-skeleton',
  composer: 'deck-composer',
  input: 'deck-input',
  rail: 'deck-rail',
  railBtn: 'deck-rail-btn',
  status: 'deck-status',
  statusDot: 'deck-status-dot',
  statusText: 'deck-status-text'
}

/** Window-lived, not persisted: see the header. A module-level Map so a React
 *  remount does not forget mid-triage. */
const armingMemory = new Map<string, string>()
const MAC_ARMING: DeckArming = {
  recall: (key) => (key ? armingMemory.get(key) : undefined),
  remember: (key, value) => {
    if (key && value) armingMemory.set(key, value)
  }
}

export default function DeckApp(): React.JSX.Element {
  const [status, setStatus] = useState<AgentRelayStatus | null>(null)
  const [requests, setRequests] = useState<RelayRequestWire[]>([])
  const [deck, setDeck] = useState<SwipeCard[]>([])
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion[]>>({})
  const [goToFailed, setGoToFailed] = useState<ReadonlySet<string>>(new Set())
  // Nothing has loaded yet vs genuinely nothing waiting: the empty screen says
  // "All caught up", which is a lie for the frame before the first snapshot
  // lands (DESIGN.md rule 11 -- gate on `loading`, never `loading && !data`).
  const [loading, setLoading] = useState(true)

  // Both lists, not just `pending`: "has this session ever spoken" and the
  // card's last-summary line are answers about history, and a session with
  // nothing outstanding has an empty `pending` by definition.
  useEffect(() => {
    let live = true
    const applySnapshot = (snap: { pending: RelayRequestWire[]; resolved: RelayRequestWire[] }): void => {
      if (!live) return
      setRequests([...snap.pending, ...snap.resolved])
      setLoading(false)
    }
    void window.api.agentRelayGetRequests().then(applySnapshot)
    void window.api.agentRelayGetStatus().then((s) => {
      if (live) setStatus(s)
    })
    const offRequests = window.api.onAgentRelayRequestsChanged(applySnapshot)
    const offStatus = window.api.onAgentRelayStatusChanged((s) => {
      if (live) setStatus(s)
    })
    return () => {
      live = false
      offRequests()
      offStatus()
    }
  }, [])

  // `clients` is empty on purpose: it only contributes the "no MCP client is
  // configured" advisory line, which belongs on the sessions list, not on a
  // deck you opened because there are cards to clear.
  const line = status ? relayStatusLine(status, []) : null
  const sessions = line?.names ?? []

  // Membership is merged, never replaced: the deck owns its own ORDER (a skip
  // is a local rearrangement), so a card resolving elsewhere must not reshuffle
  // the one under the cursor.
  useEffect(() => {
    const next = buildDeck(sessions, requests, Date.now())
    setDeck((prev) => (prev.length === 0 ? next : mergeDeck(prev, next)))
    // `sessions` is derived fresh each render, so keying on it would re-run
    // every time; `status` is the value that actually changes.
  }, [status, requests])

  /** A send that went nowhere is a dead end the card has to survive: it comes
   *  back carrying the failure rather than vanishing silently. */
  const markFailed = useCallback(
    (label: string) => {
      setFailed((prev) => new Set(prev).add(label))
      setDeck(buildDeck(sessions, requests, Date.now()))
    },
    [sessions, requests]
  )

  const onAffirm = useCallback(
    (affirm: SwipeAffirm, card: SwipeCard): void => {
      // Optimistic: the card goes now and comes back only if the send failed.
      // Same contract the relay cards already use -- main re-broadcasts, so a
      // lost race corrects itself on the next snapshot.
      setDeck((prev) => removeCard(prev, card.label))
      if (affirm.kind === 'respond') {
        void window.api.agentRelayRespond(affirm.requestId, {
          answer: affirm.answer,
          questionIndex: affirm.questionIndex,
          via: affirm.via
        })
        return
      }
      if (affirm.kind === 'reply') {
        void window.api.agentRelaySessionReply(affirm.ref, affirm.text).then((r) => {
          if (!r.ok) markFailed(affirm.label)
        })
        return
      }
      void window.api.agentRelayWrapSession(affirm.ref).then((r) => {
        if (!r.ok) markFailed(affirm.label)
      })
    },
    [markFailed]
  )

  // Same generator the phone reaches over WS, minus the push: invoke resolves
  // with the answer directly, and an empty array ends the skeleton the same way.
  const onRequestSuggestions = useCallback((label: string, context: string): void => {
    void window.api.agentRelaySuggest(label, context).then((s) => {
      setSuggestions((prev) => ({ ...prev, [suggestWireKey(label, context)]: s }))
    })
  }, [])

  const onGoTo = useCallback((label: string, card: SwipeCard): void => {
    // Addressed by id, flagged by label: the failure set keys the CARD.
    void window.api.agentRelayRevealSession(card.session.sessionId ?? label).then((r) => {
      // A reveal focuses the terminal, dropping this window behind it -- from
      // there the deck just looks broken, so leaving means actually leaving.
      if (r.ok) window.close()
      else setGoToFailed((prev) => new Set(prev).add(label))
    })
  }, [])

  const close = useCallback(() => window.close(), [])

  // ── Keyboard ───────────────────────────────────────────────────────────
  // Lives HERE, not in the shared deck: the phone has no keyboard, and the
  // shared component is render-only by construction. It drives the deck the
  // same way a thumb does -- by synthesizing the click the rail button and the
  // chips already handle -- so there is exactly one path from an intent to a
  // send, and a key can never do something a swipe cannot.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = rootRef.current
      if (!el) return
      // A key typed into the composer is text, not a command -- except Enter,
      // which the composer's own handler already claims and sends.
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') {
        if (e.key === 'Escape') close()
        return
      }
      const click = (selector: string): boolean => {
        const btn = el.querySelector<HTMLButtonElement>(selector)
        if (!btn || btn.disabled) return false
        btn.click()
        return true
      }
      switch (e.key) {
        case 'Escape':
          close()
          break
        case 'ArrowRight':
        case 'l':
        case 'Enter':
          if (click('.deck-rail-btn[data-side="affirm"]')) e.preventDefault()
          break
        case 'ArrowLeft':
        case 'h':
          if (click('.deck-rail-btn[data-side="skip"]')) e.preventDefault()
          break
        case 'o':
          if (click('.deck-goto')) e.preventDefault()
          break
        case '1':
        case '2':
        case '3': {
          // Skeletons are not chips: picking "the second one" while the model
          // is still writing would arm whatever lands in that slot.
          const chips = el.querySelectorAll<HTMLButtonElement>('.deck-chip')
          const chip = chips[Number(e.key) - 1]
          if (chip) {
            chip.click()
            e.preventDefault()
          }
          break
        }
        case 'ArrowDown':
        case 'ArrowUp': {
          const chips = [...el.querySelectorAll<HTMLButtonElement>('.deck-chip')]
          if (chips.length === 0) break
          const at = chips.findIndex((c) => c.hasAttribute('data-chosen'))
          const step = e.key === 'ArrowDown' ? 1 : -1
          // Wraps rather than clamping: with one row always armed there is no
          // "nothing selected" edge to stop at, so clamping would just make the
          // last key press do nothing.
          const next = (at + step + chips.length) % chips.length
          chips[next]?.click()
          e.preventDefault()
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <div ref={rootRef}>
      <SwipeDeck
        open={!loading}
        deck={deck}
        classes={MAC_DECK_CLASSES}
        arming={MAC_ARMING}
        onClose={close}
        onAffirm={onAffirm}
        onGoTo={onGoTo}
        suggestions={suggestions}
        onRequestSuggestions={onRequestSuggestions}
        goToFailed={goToFailed}
        failed={failed}
      />
    </div>
  )
}
