/**
 * Dev-only screenshot harness for SessionDetail's reply block.
 *
 * The real component with the real theme.css, mounted at iPhone width against
 * fixtures copied from a device screenshot -- the composer and the suggestion
 * chips are otherwise only reachable by pairing a physical phone to a live
 * agent, which is too slow a loop to judge spacing and color in.
 *
 * Never imported by main.tsx. Reachable only via session-shot.local.html.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import SessionDetail from './SessionDetail'
import SessionFullScreen from './SessionFullScreen'
import type { AgentRelaySessionInfo } from '@shared/types'
import type { RelayRequestWire } from '@shared/phone-remote-protocol'
import type { Suggestion } from '@shared/swipe-suggest'
import { cardSuggestKey } from '@shared/swipe-suggest'
import { sessionActivity } from '@shared/relay-cards'
import { sessionRow } from '@shared/relay-status'
import './theme.css'
import './session-shot.local.css'

/** The server injects these at first paint on device (injectLayoutPrefs), so
 *  theme.css defines almost none of them itself. Without this every
 *  var(--surface1) / var(--accent) computes to nothing and the whole sheet
 *  renders transparent on black text -- which reads as a CSS bug and is not. */
function injectTheme(): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(CONFIG.THEME_TOKENS)) {
    root.style.setProperty(`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, String(value))
  }
}
injectTheme()

const NOW = 1_755_000_000_000

const SESSION = {
  label: 'ios-feedback-review',
  stated: 'iOS code review feedback processing',
  tldr: 'iOS code review feedback processing',
  repo: 'ShowAndTell',
  branch: 'dev',
  cwd: '/Users/roy/Desktop/Development/ShowAndTell',
  since: NOW - 72_000,
  agent: 'claude',
  model: 'opus',
  sessionId: 'fa7b0337-8607-4a9f-9716-e2962d6072ec',
  // Mid-band on purpose: 0.52 is the only value that proves the bar is
  // measuring rather than pinned to an end, and it lands in `underway` so the
  // amber that separates the three bands is the one on screen.
  progress: 0.52,
  origin: { tmuxPane: '%12' }
} as unknown as AgentRelaySessionInfo

/** Stands in for /relay-image, which needs a live Mac holding the file. Same
 *  trick as relay-harness.local.tsx's FAKE_IMAGE -- a data URI renders through
 *  the identical <img src> the device uses, so the bubble's picture is measured
 *  in its real place rather than mocked away. */
const FAKE_SHOT =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
       <rect width="640" height="360" fill="#1d2433"/>
       <rect x="24" y="24" width="360" height="18" rx="9" fill="#3d4a63"/>
       <rect x="24" y="60" width="500" height="18" rx="9" fill="#2c3648"/>
       <rect x="24" y="120" width="592" height="210" rx="10" fill="#131926"/>
       <rect x="44" y="150" width="220" height="14" rx="7" fill="#c2603a"/>
       <rect x="44" y="182" width="420" height="14" rx="7" fill="#2c3648"/>
       <rect x="44" y="214" width="330" height="14" rx="7" fill="#2c3648"/>
     </svg>`
  )

/** A real exchange rather than one wall of text: the whole point of the thread
 *  is that an agent's ask and the answer it got read as two people talking, so
 *  the fixture carries every shape that pairing has to survive -- a typed
 *  answer, an approval, a picture the agent sent, and one still open. Newest
 *  first, the order the sheet actually receives. */
const HISTORY: RelayRequestWire[] = [
  {
    id: 'r4',
    verb: 'ask',
    params: {
      from: 'ios-feedback-review',
      question: 'Want me to push the PiP fix to dev, or hold it for the release branch?'
    },
    createdAt: NOW - 20_000,
    timeoutMs: 600_000,
    status: 'pending',
    response: null
  },
  {
    id: 'r3',
    verb: 'show',
    params: {
      from: 'ios-feedback-review',
      caption: 'Here is the PiP window sitting behind the panel after exitFullscreenMirror.',
      hasImage: true
    },
    createdAt: NOW - 240_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 200_000,
    response: { acked: true }
  },
  {
    id: 'r2',
    verb: 'approve',
    params: {
      from: 'ios-feedback-review',
      action: 'Rewrite the PiP teardown to await the fullscreen exit before releasing the layer',
      risk: 'low'
    },
    createdAt: NOW - 900_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 840_000,
    response: { approved: true }
  },
  {
    id: 'r1',
    verb: 'ask',
    params: {
      from: 'ios-feedback-review',
      question: 'Which of the three review threads should I take first?'
    },
    createdAt: NOW - 3_600_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 3_500_000,
    response: { answer: 'the PiP one' }
  }
]

/** The case the rich fixture above cannot represent, and the one that shipped
 *  broken twice. Every Claude hook's idle ping is `notify` with NO question,
 *  action, caption or title-as-sentence -- `cardSummary` returns '' for all of
 *  these, so a screen of them rendered empty bubbles on device while this
 *  harness stayed green on its four hand-written asks. Fixtures that only carry
 *  the passing shape are why. */
const NOTIFY_HISTORY: RelayRequestWire[] = [
  {
    id: 'n3',
    verb: 'notify',
    params: {
      from: 'phone-remote',
      title: 'Your Turn',
      body: 'Rebuilt the bundle and reloaded -- the composer clears the home indicator now.',
      idle: true
    },
    createdAt: NOW - 30_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 30_000,
    response: { acked: true }
  },
  {
    id: 'n2',
    verb: 'notify',
    params: {
      from: 'phone-remote',
      title: 'Your Turn',
      body: 'Found the notify filter in previousList -- the full screen was reusing the Previous tab list.',
      idle: true
    },
    createdAt: NOW - 400_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 400_000,
    response: { acked: true }
  },
  {
    id: 'n1',
    verb: 'notify',
    params: { from: 'phone-remote', title: 'Your Turn', body: '', idle: true },
    createdAt: NOW - 900_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 900_000,
    response: { acked: true }
  },
  /* A picture in the notify run, because RAW is the reading that dropped it:
     the <img> sat inside the chat-only branch, so toggling to Raw turned a
     `show` card into its caption with nothing under it. The rich HISTORY
     fixture has a `show` too, but it only ever renders in chat mode above --
     nothing exercised the raw path until this row existed. */
  {
    id: 'n0',
    verb: 'show',
    params: {
      from: 'phone-remote',
      caption: 'The composer sitting above the home indicator at 402x874.',
      hasImage: true
    },
    createdAt: NOW - 1_200_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 1_200_000,
    response: { acked: true }
  }
]

/** An agent that declared a recap and minted ZERO relay cards -- the shape that
 *  rendered "It has not sent you anything yet." on a full screen while its sheet
 *  showed a populated RECAP line, which reads as broken. */
const RECAP_ONLY = {
  ...SESSION,
  label: 'audit-ui-noise-removal',
  stated: 'Auditing and removing noise from UI that clutters the user experience',
  tldr: 'Auditing and removing noise from UI that clutters the user experience'
} as unknown as AgentRelaySessionInfo

const SUGGESTIONS: Suggestion[] = [
  { text: 'Update the PRD with the PiP bug', emoji: '📝' },
  { text: 'Show me the exitFullscreenMirror trace', emoji: '🔍' },
  { text: 'Run the phone-remote build and reload', emoji: '🔁' }
]

const row = sessionRow(SESSION, NOW)
const subject =
  sessionActivity(SESSION.stated ?? SESSION.label, HISTORY).derivedSubject ?? row.name ?? row.repo
const key = cardSuggestKey({ label: SESSION.label, session: SESSION, subject })

function Shot(): React.JSX.Element {
  return (
    // Plain box, NOT .proRoot: that is position:fixed and would not constrain
    // the detail's width, so the composer row ran off the right edge here while
    // being fine inside the real sheet.
    <div className="sessionShotFrame">
      {/* The full-screen reading, in both its modes. It is the surface the
          title tap opens, so it is judged here beside the sheet it comes
          from -- the two share .chatFull* CSS and drift apart silently. */}
      <div className="sessionShotSheet">
        <SessionFullScreen
          open
          session={SESSION}
          history={HISTORY}
          now={NOW}
          onCollapse={() => {}}
          imageSrc={() => FAKE_SHOT}
          onAttach={async () => true}
        />
      </div>
      {/* The notify-only agent, BOTH readings side by side. Chat and raw are
          separate mounts because `mode` is internal state -- one frame has to
          answer "do these two look the same", which is the complaint that sent
          this back twice. */}
      <div className="sessionShotSheet">
        <SessionFullScreen
          open
          initialMode="chat"
          session={SESSION}
          history={NOTIFY_HISTORY}
          now={NOW}
          onCollapse={() => {}}
          imageSrc={() => FAKE_SHOT}
          onAttach={async () => true}
        />
      </div>
      <div className="sessionShotSheet">
        <SessionFullScreen
          open
          initialMode="raw"
          session={SESSION}
          history={NOTIFY_HISTORY}
          now={NOW}
          onCollapse={() => {}}
          imageSrc={() => FAKE_SHOT}
          onAttach={async () => true}
        />
      </div>
      {/* Declared a recap, minted zero cards: the empty state that must show
          the recap rather than "it has not sent you anything yet". */}
      <div className="sessionShotSheet">
        <SessionFullScreen
          open
          session={RECAP_ONLY}
          history={[]}
          now={NOW}
          onCollapse={() => {}}
          imageSrc={() => FAKE_SHOT}
          onAttach={async () => true}
        />
      </div>
      {/* The header expanded. `expanded` is internal state, so without the prop
          a capture can only ever show the collapsed half -- and the question
          being judged is whether the facts panel pushes the composer off. */}
      <div className="sessionShotSheet">
        <SessionFullScreen
          open
          initialExpanded
          session={SESSION}
          history={HISTORY}
          now={NOW}
          onCollapse={() => {}}
          imageSrc={() => FAKE_SHOT}
          // The paperclip renders only when a handler exists, so a panel without
          // this one captures the composer as it was before the attach shipped.
          onAttach={async () => true}
        />
      </div>
      <div className="sessionShotSheet">
        <SessionDetail
          session={SESSION}
          history={HISTORY}
          waiting={0}
          now={NOW}
          onBack={() => {}}
          onGoTo={() => {}}
          onOpenScreen={() => {}}
          onArchive={() => true}
          onReply={() => {}}
          // onMicDown + micStreamRef are what gate the mic button's render, and
          // they arrive nested under `mic` -- passing them flat renders no mic.
          mic={{
            onMicDown: () => {},
            onMicUp: () => {},
            micStreamRef: { current: null },
            dictating: false,
            recording: false,
            draftPatch: null,
            onDraftConsumed: () => {}
          }}
          imageSrc={() => FAKE_SHOT}
          onAttach={async () => true}
          onRequestSuggestions={() => {}}
          suggestions={key ? { [key]: SUGGESTIONS } : {}}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Shot />
  </StrictMode>
)
