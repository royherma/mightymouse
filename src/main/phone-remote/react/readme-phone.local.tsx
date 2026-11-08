import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import SessionFullScreen from './SessionFullScreen'
import type { AgentRelaySessionInfo } from '@shared/types'
import type { RelayRequestWire } from '@shared/phone-remote-protocol'
import type { Suggestion } from '@shared/swipe-suggest'
import { cardSuggestKey } from '@shared/swipe-suggest'
import { sessionActivity } from '@shared/relay-cards'
import { sessionRow } from '@shared/relay-status'
import './theme.css'

const root = document.documentElement
for (const [key, value] of Object.entries(CONFIG.THEME_TOKENS)) {
  root.style.setProperty(`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, String(value))
}

const NOW = Date.now()
const LABEL = 'acme-shop/fix-checkout-button'

const SESSION = {
  label: LABEL,
  tldr: 'Fix the checkout button',
  project: { name: 'acme-shop', icon: 'cart' },
  cwd: '~/code/acme-shop',
  since: NOW - 40 * 60_000,
  agent: 'claude',
  model: 'Opus 5.5',
  effort: 'medium',
  sessionId: LABEL,
  progress: 0.9,
  origin: { tmuxPane: '%3' }
} as unknown as AgentRelaySessionInfo

const HISTORY: RelayRequestWire[] = [
  {
    id: 'r3',
    verb: 'ask',
    params: {
      from: LABEL,
      question: 'All 12 checkout tests pass. Push the 2 commits on fix-checkout-button and open a pull request into main?'
    },
    createdAt: NOW - 40_000,
    timeoutMs: 600_000,
    status: 'pending',
    response: null
  },
  {
    id: 'r2',
    verb: 'notify',
    params: {
      from: LABEL,
      title: 'Your Turn',
      body: 'Moved the cookie banner below the checkout button and added a tap test for phones.',
      idle: true
    },
    createdAt: NOW - 4 * 60_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 4 * 60_000,
    response: null
  },
  {
    id: 'r1',
    verb: 'ask',
    params: {
      from: LABEL,
      question: 'The cookie banner covers the checkout button on small screens. Move it to the bottom, or let it close itself after 5 seconds?'
    },
    createdAt: NOW - 12 * 60_000,
    timeoutMs: 600_000,
    status: 'resolved',
    resolvedAt: NOW - 11 * 60_000,
    response: { answer: 'Move it to the bottom' }
  }
]

const SUGGESTIONS: Suggestion[] = [
  { text: 'Yes, push it and open the PR', emoji: '🚀' },
  { text: 'Test it on Safari first', emoji: '🧪' },
  { text: 'Show me the diff', emoji: '🔍' }
]

const row = sessionRow(SESSION, NOW)
const subject = sessionActivity(SESSION.stated ?? SESSION.label, HISTORY).derivedSubject ?? row.name ?? row.repo
const key = cardSuggestKey({ label: SESSION.label, session: SESSION, subject })

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <SessionFullScreen
      open
      initialMode="chat"
      session={SESSION}
      history={HISTORY}
      now={NOW}
      onCollapse={() => {}}
      onReply={() => {}}
      onGoTo={() => {}}
      onAttach={async () => true}
      mic={{
        onMicDown: () => {},
        onMicUp: () => {},
        micStreamRef: { current: null },
        dictating: false,
        recording: false,
        draftPatch: null,
        onDraftConsumed: () => {}
      }}
      onRequestSuggestions={() => {}}
      suggestions={key ? { [key]: SUGGESTIONS } : {}}
    />
  </StrictMode>
)
