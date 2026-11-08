/**
 * The phone's swipe deck: the shared deck plus the two things only a phone has.
 *
 * Everything that decides anything lives in `@shared/swipe-deck` -- this file is
 * the iPhone's half of it: the vibration motor, the localStorage arming memory,
 * and the camelCase class names `theme.css` paints. The Mac window mounts the
 * same deck with a no-op motor and hyphenated names.
 */

import SwipeDeck from '@shared/swipe-deck'
import type { SwipeDeckClasses, DeckHaptics, DeckArming } from '@shared/swipe-deck'
import type { SwipeAffirm, SwipeCard } from '@shared/swipe-triage'
import type { Suggestion } from '@shared/swipe-suggest'
import type { RelayStatusLine } from '@shared/relay-status'
import { recallArming, rememberArming } from './swipe-arming-store'
import { hapticTick, hapticDragRelease, hapticKeyPress, hapticDragEngage } from './haptics'

/** The camelCase half of the pair. Named here so a call site cannot typo one
 *  and lose a single element's styling silently. */
export const PHONE_DECK_CLASSES: SwipeDeckClasses = {
  scrim: 'historyScrim',
  root: 'swipeDeck',
  rootOpen: 'open',
  header: 'chatHeader',
  title: 'chatTitle',
  headerBtn: 'chatHeaderBtn',
  headerBtns: 'chatHeaderBtns',
  headerBack: 'chatHeaderBack',
  count: 'swipeDeckCount',
  jumpAnchor: 'swipeDeckJumpAnchor',
  jump: 'swipeDeckJump',
  jumpRow: 'swipeDeckJumpRow',
  jumpWho: 'swipeDeckJumpWho',
  jumpName: 'swipeDeckJumpName',
  jumpWhat: 'swipeDeckJumpWhat',
  jumpDot: 'swipeDeckJumpDot',
  empty: 'swipeDeckEmpty',
  emptyTitle: 'swipeDeckEmptyTitle',
  emptyBody: 'swipeDeckEmptyBody',
  passed: 'swipeDeckPassed',
  again: 'swipeDeckAgain',
  stage: 'swipeDeckStage',
  stamp: 'swipeDeckStamp',
  card: 'swipeDeckCard',
  cardBehind: 'swipeDeckCardBehind',
  cardRising: 'swipeDeckCardRising',
  cardLeaving: 'swipeDeckCardLeaving',
  head: 'swipeDeckHead',
  who: 'swipeDeckWho',
  name: 'swipeDeckName',
  place: 'swipeDeckPlace',
  age: 'swipeDeckAge',
  goTo: 'swipeDeckGoTo',
  subject: 'swipeDeckSubject',
  subjectMuted: 'swipeDeckSubjectMuted',
  subjectTag: 'codeSessionTldrTag',
  facts: 'swipeDeckFacts',
  last: 'swipeDeckLast',
  ask: 'swipeDeckAsk',
  askLabel: 'swipeDeckAskLabel',
  askText: 'swipeDeckAskText',
  failed: 'swipeDeckFailed',
  more: 'swipeDeckMore',
  note: 'swipeDeckNote',
  actions: 'swipeDeckActions',
  actionsNudge: 'swipeDeckActionsNudge',
  chip: 'swipeDeckChip',
  chipEmoji: 'swipeDeckChipEmoji',
  chipSkeleton: 'swipeDeckChipSkeleton',
  composer: 'swipeDeckComposer',
  input: 'chatInput',
  rail: 'swipeDeckRail',
  railBtn: 'swipeDeckRailBtn',
  status: 'swipeDeckStatus',
  statusDot: 'codeStatusDot',
  statusText: 'codeStatusText'
}

const PHONE_HAPTICS: DeckHaptics = {
  tick: hapticTick,
  dragEngage: hapticDragEngage,
  dragRelease: hapticDragRelease,
  keyPress: hapticKeyPress
}

const PHONE_ARMING: DeckArming = { recall: recallArming, remember: rememberArming }

export default function SwipeDeckSheet(props: {
  open: boolean
  deck: SwipeCard[]
  onClose: () => void
  onAffirm: (affirm: SwipeAffirm, card: SwipeCard) => void
  onOpenSession?: (label: string) => void
  onGoTo?: (label: string) => void
  goToFailed?: ReadonlySet<string>
  failed?: ReadonlySet<string>
  suggestions?: Record<string, Suggestion[]>
  onRequestSuggestions?: (label: string, context: string) => void
  onBack?: () => void
  statusLine?: RelayStatusLine
  island?: {
    on: boolean
    onToggle: () => void
    /** Rendered inside the deck, over the cards. */
    node?: React.ReactNode
  }
  screen?: {
    on: boolean
    onToggle: () => void
    pane?: React.ReactNode
    zoomed?: Readonly<Record<string, boolean>>
    onZoom?: (label: string, on: boolean) => void
  }
}): React.JSX.Element {
  return (
    <SwipeDeck
      {...props}
      archiveSessions
      classes={PHONE_DECK_CLASSES}
      haptics={PHONE_HAPTICS}
      arming={PHONE_ARMING}
    />
  )
}

export { pendingOptions } from '@shared/swipe-deck'
