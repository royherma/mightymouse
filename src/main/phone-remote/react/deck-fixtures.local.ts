/**
 * Fixture sessions + requests for the swipe-deck harness.
 *
 * These are inputs to the REAL `buildDeck`, not hand-written `SwipeCard`s. That
 * matters: the shipped bug this deck already had (suggestions never rendering)
 * lived in the derivation between a session and its card, not in the card's
 * markup. Fixtures that skip `buildDeck` cannot catch its successor.
 *
 * Never imported by the app. Reachable only from deck-harness.local.tsx.
 */

import type { AgentRelaySessionInfo } from '@shared/types'
import type { RelayRequestWire } from '@shared/phone-remote-protocol'
import type { Suggestion } from '@shared/swipe-suggest'

export const NOW = Date.UTC(2026, 7, 16, 14, 0, 0)
const MINUTE = 60_000

function session(over: Partial<AgentRelaySessionInfo> & { label: string }): AgentRelaySessionInfo {
  return {
    since: NOW - 12 * MINUTE,
    sessionId: `sess-${over.label}`,
    agent: 'claude',
    model: 'Opus 5',
    effort: 'high',
    canWrapUp: true,
    // `sessionCanReply` is `origin?.tmuxPane || pid`, and it gates the ENTIRE
    // suggestion branch plus "Type your own". A real relay session always has a
    // pid, so a fixture without one silently renders a card that can never show
    // a chip -- which reads exactly like the suggestion bug this harness exists
    // to catch.
    pid: 4242,
    // A deck card draws the meter off the session, so without a number here the
    // harness renders the one state that proves nothing: the absent one.
    progress: 0.52,
    ...over
  }
}

function request(
  over: Partial<RelayRequestWire> & { verb: RelayRequestWire['verb']; from: string }
): RelayRequestWire {
  const { from, ...rest } = over
  return {
    id: rest.id ?? `req-${from}-${rest.verb}`,
    verb: rest.verb,
    params: { from, ...(rest.params ?? {}) },
    createdAt: rest.createdAt ?? NOW - 4 * MINUTE,
    timeoutMs: rest.timeoutMs ?? 10 * MINUTE,
    status: rest.status ?? 'pending',
    response: rest.response ?? null
  }
}

/** Each scenario is one deck: what it is for, and the two arrays `buildDeck`
 *  turns into cards. Kept as inputs so a scenario can be read as "this is the
 *  world", not "this is the card I wanted". */
export interface DeckScenario {
  id: string
  label: string
  /** What this scenario is here to catch — the reason it earns a row. */
  note: string
  sessions: AgentRelaySessionInfo[]
  requests: RelayRequestWire[]
  /** Keyed by `cardSuggestKey`. Absent means the card must fall back to the
   *  canned actions, which is its own scenario below. */
  suggestions?: Record<string, Suggestion[]>
}

/** An idle session with a declared TLDR. The suggestion key is derived by the
 *  harness at render time via `cardSuggestKey`, so this deck's chips are wired
 *  in the harness rather than guessed here. */
const IDLE_WITH_TLDR = session({
  label: 'mm-dev-735 - ShowAndTell/dev',
  stated: 'mm-dev-735',
  tldr: 'Porting the swipe deck to the Mac',
  idleSince: NOW - 3 * MINUTE
})

const IDLE_NO_TLDR = session({
  label: 'mm-ads-021 - ShowAndTell/growth',
  stated: 'mm-ads-021',
  idleSince: NOW - 8 * MINUTE
})

const ASK_SESSION = session({
  label: 'mm-billing-04 - ShowAndTell/main',
  stated: 'mm-billing-04',
  waiting: 1
})

const INTERVIEW_SESSION = session({
  label: 'mm-onboard-12 - ShowAndTell/dev',
  stated: 'mm-onboard-12',
  waiting: 1
})

const NO_WRAP_SESSION = session({
  label: 'mm-legacy-01 - ShowAndTell/dev',
  stated: 'mm-legacy-01',
  canWrapUp: false,
  idleSince: NOW - 20 * MINUTE
})

export const SCENARIOS: DeckScenario[] = [
  {
    id: 'idle-suggestions',
    label: 'Idle — model chips',
    note: 'The happy path the shipped bug broke: real chips, not "Keep going."',
    // The `notify` is what earns the card, not what blocks it: `buildDeck` skips
    // a session with no activity at all, and `pendingFor` excludes `notify` on
    // purpose -- so this is an IDLE card with history, which is the only shape
    // the suggestion path is reachable from.
    sessions: [IDLE_WITH_TLDR],
    requests: [
      request({ verb: 'notify', from: 'mm-dev-735', params: { title: 'Your turn' } })
    ]
  },
  {
    id: 'idle-canned',
    label: 'Idle — canned fallback',
    note: 'No suggestions supplied. Must degrade to the canned three, never blank.',
    sessions: [IDLE_NO_TLDR],
    requests: [
      request({ verb: 'notify', from: 'mm-ads-021', params: { title: 'Your turn' } })
    ]
  },
  {
    id: 'ask',
    label: 'Pending ask',
    note: 'A blocking question. Options come from the ask; "Wrap up" must NOT join them.',
    sessions: [ASK_SESSION],
    requests: [
      request({
        verb: 'ask',
        from: 'mm-billing-04',
        params: {
          question: 'The live Stripe key can write now. Roll it, or gate the callers?',
          options: ['Roll the key', 'Gate the callers']
        }
      })
    ]
  },
  {
    id: 'interview',
    label: 'Multi-question interview',
    note: 'moreQuestions:true — must render the tap-through, not half-answerable options.',
    sessions: [INTERVIEW_SESSION],
    requests: [
      request({
        verb: 'ask',
        from: 'mm-onboard-12',
        params: {
          // `questions` is ADDITIVE: `question`/`options` still carry question 0
          // (protocol comment at phone-remote-protocol.ts:60-62), so a fixture
          // that sets only the array renders as a card with no question at all.
          question: 'Which surface hosts the deck?',
          options: ['HUD', 'New window'],
          questions: [
            { question: 'Which surface hosts the deck?', options: ['HUD', 'New window'] },
            { question: 'Keyboard or drag?', options: ['Both', 'Keyboard only'] },
            { question: 'Share the CSS?', options: ['Fork it', 'Share it'] }
          ]
        }
      })
    ]
  },
  {
    id: 'no-wrap',
    label: 'Cannot wrap up',
    note: 'canWrapUp:false (shim too old to report the agent pid). The action must be absent.',
    sessions: [NO_WRAP_SESSION],
    requests: [
      request({ verb: 'notify', from: 'mm-legacy-01', params: { title: 'Your turn' } })
    ]
  },
  {
    id: 'stack',
    label: 'Full stack — 5 cards',
    note: 'Ghosts behind the top card, depth counter, jump list. Pending sorts above idle.',
    sessions: [ASK_SESSION, IDLE_WITH_TLDR, IDLE_NO_TLDR, INTERVIEW_SESSION, NO_WRAP_SESSION],
    requests: [
      request({
        verb: 'ask',
        from: 'mm-billing-04',
        params: { question: 'Roll the live key?', options: ['Roll it', 'Leave it'] }
      }),
      request({
        verb: 'ask',
        from: 'mm-onboard-12',
        params: {
          question: 'Which surface?',
          options: ['HUD', 'New window'],
          questions: [
            { question: 'Which surface?', options: ['HUD', 'New window'] },
            { question: 'Keyboard or drag?', options: ['Both', 'Keyboard only'] }
          ]
        }
      }),
      request({ verb: 'notify', from: 'mm-dev-735', params: { title: 'Your turn' } }),
      request({ verb: 'notify', from: 'mm-ads-021', params: { title: 'Your turn' } }),
      request({ verb: 'notify', from: 'mm-legacy-01', params: { title: 'Your turn' } })
    ]
  },
  {
    id: 'empty',
    label: 'Empty — nothing to do',
    note: 'The calm state. Must read as finished, not as a broken deck.',
    sessions: [],
    requests: []
  },
  /* Real names off the user's phone, not invented ones: every other fixture here is
     ~12 chars (`mm-dev-735`), which fits with room to spare and is why the
     session card's title overflowed its border on device while this harness
     stayed green. The first has no state chip and still overflowed, so a
     chip-only fix does not cover this scenario. */
  {
    id: 'long-names',
    label: 'Long names — title overflow',
    note: 'Titles must ellipsize INSIDE the card. Nothing may cross the border.',
    sessions: [
      session({
        label: 'impeccable-skill-landing-page-see-guest - ShowAndTell/dev',
        stated: 'impeccable-skill-landing-page-see-guest',
        idleSince: NOW - 8 * MINUTE
      }),
      session({
        label: 'impeccable-scale-empty-screens - ShowAndTell/dev',
        stated: 'impeccable-scale-empty-screens',
        tldr: 'Impeccable scale design across MightyMouse screens',
        waiting: 1
      }),
      session({
        label: 'handed-back-chip-ui - ShowAndTell/dev',
        stated: 'handed-back-chip-ui',
        tldr: 'UI layout changes for handed-back status timing',
        waiting: 1
      })
    ],
    requests: [
      request({ verb: 'notify', from: 'impeccable-scale-empty-screens', params: { title: 'Your turn' } }),
      request({ verb: 'notify', from: 'handed-back-chip-ui', params: { title: 'Your turn' } })
    ]
  }
]
