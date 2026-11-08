import './index.css'
import { createRoot } from 'react-dom/client'
import CanvasApp from './CanvasApp'
import { injectTheme } from './theme'
import {
  CANVAS_SANDBOX,
  EMPTY_CANVAS,
  localTags,
  type CanvasBubble,
  type CanvasState,
  type CanvasThinkResult
} from '../../shared/canvas'
import type {
  MightyChatResult,
  MightyProject,
  MightySession,
  RunFailReason
} from '../../shared/types'

// ?state=full|empty|n10|n40|long|many|tall  ?ai=ok|signed_out|out_of_credits|timeout|broken|chaterror|empty
injectTheme()
const q = new URLSearchParams(location.search)
const state = q.get('state') ?? 'full'
const ai = q.get('ai') ?? 'ok'
const t = '2026-10-05T04:00:00.000Z'
const project = (id: string, name: string, icon: string, updated: string): MightyProject => ({
  id,
  name,
  icon,
  created: t,
  updated
})
const LONG = 'A project with a really long name that keeps going and going'
const projects = [
  project(
    'mm',
    state === 'long' ? `${LONG} (MightyMouse)` : 'ShowAndTell',
    'rocket',
    '2026-10-05T04:00:00.000Z'
  ),
  project(
    'gk',
    state === 'long' ? `${LONG} (GoKuna)` : 'GoKuna',
    'globe',
    '2026-10-05T03:50:00.000Z'
  ),
  project('ts', 'techguyver-side-projects', 'folder', '2026-10-05T03:40:00.000Z'),
  project('tg', 'Techguyver Site', 'palette', '2026-10-05T03:30:00.000Z'),
  project('to', 'techno-optimists', 'bot', '2026-10-05T03:20:00.000Z'),
  project('pf', 'petfomo', 'cart', '2026-10-05T03:00:00.000Z'),
  project('os', 'OpenString', 'music', '2026-10-04T03:00:00.000Z'),
  ...(state === 'many'
    ? 'Atlas Bramble Cinder Dune Ember Fjord Grove Harbor Iris Juniper Kestrel Lumen'
        .split(' ')
        .map((n, i) => ({
          ...project(`x${i}`, n, 'folder', `2026-10-03T0${i % 10}:00:00.000Z`),
          pinned: true
        }))
    : [])
]
const turn = (
  q: string,
  a: string,
  backend: string,
  model?: string
): MightySession['turns'][0] => ({
  source: 'chat' as MightySession['turns'][0]['source'],
  q,
  a,
  ts: t,
  ok: true,
  backend,
  model
})
const session = (
  id: string,
  title: string,
  projectId: string,
  turns: MightySession['turns'] = []
): MightySession => ({
  schema_version: 1,
  id,
  created: t,
  updated: t,
  title,
  turns,
  projectId
})
const sessions: MightySession[] = [
  session('s1', 'Blank canvas ideation system', 'mm', [
    turn('ideas for a canvas', 'Here are some', 'claude', 'opus')
  ]),
  session('s2', 'Instagram reel viral remake', 'pf', [
    turn('remake this reel', 'Done', 'codex', 'gpt-5.5')
  ]),
  session('s3', 'Pricing page copy for Pro', 'mm', [
    turn('rewrite pricing', 'Here it is', 'claude', 'opus')
  ]),
  session('s4', 'Which dog breeds buy the most raincoats', 'pf', [
    turn('breeds?', 'Dachshunds', 'claude', 'opus')
  ])
]

// Spread fixture times over a morning plus a day-earlier batch so Timeline has gaps to fold.
const GAPS_MIN = [0, 12, 9, 40, 6, 25, 1500, 14, 8, 30, 5, 18]
let made = 0
const spreadTime = (): string =>
  new Date(
    Date.parse(t) -
      26 * 3_600_000 +
      GAPS_MIN.slice(0, (made++ % GAPS_MIN.length) + 1).reduce((a, b) => a + b, 0) * 60_000
  ).toISOString()

const bubble = (
  id: string,
  planet: string,
  text: string,
  extra: Partial<CanvasBubble> = {}
): CanvasBubble => ({
  id,
  kind: 'idea',
  text,
  planet,
  tags: localTags(text),
  by: 'you',
  created: spreadTime(),
  ...extra
})
const full: CanvasState = {
  version: 1,
  bubbles: [
    bubble('b1', 'mm', 'Let people share a canvas as a link', {
      directions: [
        'Let coaches share a plan with a client',
        'Make sharing a paid feature',
        'Show who opened the link'
      ]
    }),
    bubble('b2', 'mm', 'Voice note straight onto the canvas from the phone'),
    bubble('b3', 'mm', 'Onboarding: show the canvas before the paywall?', { kind: 'question' }),
    bubble('b4', 'mm', 'Blank canvas ideation system', {
      kind: 'thread',
      sessionId: 's1',
      by: 'ai'
    }),
    bubble('b5', 'pf', 'Dog raincoat for the rainy-day reel'),
    bubble('b6', 'pf', 'Instagram reel viral remake', {
      kind: 'thread',
      sessionId: 's2',
      by: 'ai'
    }),
    bubble('b7', 'os', 'Practice mode that listens and scores your timing'),
    bubble('b8', CANVAS_SANDBOX, 'Start a podcast about building with AI'),
    bubble('b9', CANVAS_SANDBOX, 'Podcast guests: indie app makers'),
    bubble('s1', 'mm', 'Start read-only: the link shows, nobody can edit', {
      kind: 'step',
      parent: 'b1'
    })
  ],
  links: [
    { id: 'l1', from: 'b1', to: 'b4', why: 'same idea, already started', by: 'ai' },
    { id: 'l2', from: 'b5', to: 'b6', why: "tomorrow's post?", by: 'ai' },
    { id: 'l3', from: 'b2', to: 'b1', why: 'you linked these', by: 'you' },
    { id: 'l4', from: 'b8', to: 'b9', why: 'same podcast', by: 'ai' },
    { id: 'l5', from: 'b1', to: 's1', why: '', by: 'you' }
  ]
}

const IDEAS = [
  'Weekly email digest of what changed',
  'Dark mode for the phone remote',
  'Price test: annual plan at two months free',
  'Record a 30 second demo for the landing page',
  'What do people search before they find us?',
  'Let the dog model wear seasonal outfits',
  'Ask five users what they would pay',
  'Short tutorial series on YouTube',
  'Referral reward: one free month for both',
  'Can the canvas read my calendar?',
  'Cat bandana bundle for spring',
  'Metronome that speeds up when you nail it',
  'Chord chart export to PDF',
  'Pet birthday reminder emails',
  'Offline mode for the practice app',
  'Founder story video for the about page',
  'Bulk discount for dog walkers',
  'Show the AI model next to each answer',
  'Waitlist page for the iPad version',
  'Use real customer photos in ads',
  'Weekly leaderboard for practice streaks',
  'Hire a part-time video editor',
  'Pricing page FAQ about refunds',
  'Collar with a QR code for lost pets',
  'Slow-down button for tricky passages',
  'Trackpad gestures cheat sheet',
  'Partner with a vet clinic',
  'Holiday gift guide post',
  'Fix the onboarding drop-off on step 2',
  'Apple Watch tap tempo',
  'Instagram carousel: before and after grooming',
  'Keyboard shortcut to open the canvas',
  'Song of the week challenge',
  'Ship a Windows beta?',
  'Shopify upsell at checkout',
  'Monthly community call',
  'Voice notes that file themselves',
  'Lesson plans for guitar teachers',
  'Rainy day indoor games for dogs',
  'Track which ad brought each signup'
]
const topic = (text: string): string =>
  /dog|cat|pet|collar|vet|groom|shopify|bandana|walker/i.test(text)
    ? 'pf'
    : /practice|chord|metronome|guitar|song|lesson|tempo|passage|streak/i.test(text)
      ? 'os'
      : /canvas|phone|trackpad|onboarding|voice|model|keyboard|windows|ipad|pricing|referral|digest|landing|signup|ad brought|demo|users|search|refund|founder|editor|community|youtube|annual|ads/i.test(
            text
          )
        ? 'mm'
        : CANVAS_SANDBOX
const spread = (n: number): CanvasState => ({
  version: 1,
  bubbles: IDEAS.slice(0, n).map((text, i) => bubble(`g${i}`, topic(text), text)),
  links: Array.from({ length: Math.floor(n / 4) }, (_, i) => ({
    id: `gl${i}`,
    from: `g${i}`,
    to: `g${i + 3}`,
    why: 'related',
    by: 'ai' as const
  }))
})
const ANSWER =
  'Short answer: yes, and the cheapest way to find out is to ship a read-only link first. Most people only want to show the canvas, not co-edit it, so a view link covers the common case. Add editing once three people ask for it. Track opens per link so you can see whether shared canvases bring anyone back.'
const tall: CanvasState = {
  version: 1,
  bubbles: [
    ...full.bubbles,
    ...['mm', 'mm', 'pf', 'os', CANVAS_SANDBOX, 'mm'].map((planet, i) =>
      bubble(`a${i}`, planet, ANSWER, { kind: 'answer', by: 'ai', sessionId: 's1' })
    )
  ],
  links: full.links
}
const many: CanvasState = {
  version: 1,
  bubbles: [
    ...full.bubbles,
    ...projects
      .filter((p) => p.id.startsWith('x'))
      .map((p, i) => bubble(`m${i}`, p.id, IDEAS[i % IDEAS.length]))
  ],
  links: full.links
}
const scenarios: Record<string, CanvasState> = {
  empty: EMPTY_CANVAS,
  full,
  long: full,
  n10: spread(10),
  n40: spread(40),
  tall,
  many
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const FAIL_REASONS = new Set(['signed_out', 'out_of_credits', 'timeout', 'broken'])

// Text cues stand in for the model: "reel remake" continues s2, a question starts a chat.
const think = async (text: string): Promise<CanvasThinkResult> => {
  await delay(ai === 'timeout' ? 2500 : 600)
  if (FAIL_REASONS.has(ai)) return { ok: false, reason: ai as RunFailReason }
  const planet = /pet|dog|reel|shop/i.test(text)
    ? 'pf'
    : /canvas|mighty|phone|share|agent/i.test(text)
      ? 'mm'
      : CANVAS_SANDBOX
  const continues = /remake/i.test(text)
  const command = /^(start|run|fix)\b/i.test(text)
  return {
    ok: true,
    thought: {
      action: continues ? 'continue' : command || /\?/.test(text) ? 'chat' : 'note',
      planet,
      guesses: command && planet === CANVAS_SANDBOX ? ['mm', 'pf'] : [],
      tags: localTags(text),
      related: planet === 'mm' && state !== 'empty' ? [{ id: 'b1', why: 'builds on this' }] : [],
      session: continues ? { id: 's2', why: 'same reel' } : undefined,
      directions: [
        'Try a tiny version this week',
        'Ask 3 people if they would use it',
        'Write down what could go wrong'
      ]
    }
  }
}

const turnListeners = new Set<(p: { sessionId: string }) => void>()
type Live = (p: { sessionId: string; clientRunId?: string; [k: string]: unknown }) => void
const phaseListeners = new Set<Live>()
const eventListeners = new Set<Live>()
const chat = async (
  message: string,
  sessionId?: string,
  _files?: unknown,
  _project?: string,
  _backend?: string,
  clientRunId?: string
): Promise<MightyChatResult> => {
  const id = sessionId ?? `s${sessions.length + 1}`
  let s = sessions.find((x) => x.id === id)
  if (!s) {
    s = session(id, message.slice(0, 40), 'mm')
    sessions.push(s)
  }
  s.turns.push(turn(message, '', 'claude', 'opus'))
  s.runId = 'run'
  turnListeners.forEach((f) => f({ sessionId: id }))
  const live = { sessionId: id, clientRunId }
  for (const phase of ['Reading your notes', 'Writing']) {
    phaseListeners.forEach((f) => f({ ...live, phase }))
    await delay(500)
  }
  for (const text of ['Short version first.', 'Then the detail, one step at a time.']) {
    eventListeners.forEach((f) => f({ ...live, event: { kind: 'text', text } }))
    await delay(700)
  }
  delete s.runId
  const answer =
    ai === 'empty'
      ? ''
      : /paid|price|sharing/i.test(message)
        ? 'Keep viewing free and charge for editing. A read-only link costs you nothing and every shared canvas is a free ad, while co-editing is what teams pay for. Start with free links, watch how many get opened, and put editing in Pro once ten people ask for it.'
        : 'Post the rainy-day raincoat reel tomorrow at 7pm. Open on the dog shaking off water, cut to the raincoat on, end on the shop link. Rain sounds outperform music on pet reels this month.'
  const last = s.turns[s.turns.length - 1]
  last.a = ai === 'chaterror' ? '' : answer
  last.ok = ai !== 'chaterror'
  turnListeners.forEach((f) => f({ sessionId: id }))
  return ai === 'chaterror'
    ? { answer: '', sessionId: id, artifacts: [], error: 'error' }
    : { answer, sessionId: id, artifacts: [] }
}

const opened: string[] = []
const api = {
  pathForFile: (f: File) => f.name,
  mediaUrl: (p: string) => p,
  canvas: {
    load: async () => structuredClone(scenarios[state] ?? full),
    save: async (s: CanvasState) => {
      Object.assign(window, { __cvSaved: s })
    },
    think,
    hide: async () => undefined,
    startNew: async () => EMPTY_CANVAS,
    open: async () => structuredClone(full),
    boards: async () => [
      {
        id: 'c1',
        title: 'Let people share a canvas as a link',
        updated: t,
        count: 9,
        current: true
      },
      {
        id: 'c0',
        title: 'Q4 launch ideas',
        updated: '2026-10-04T04:00:00.000Z',
        count: 14,
        current: false
      }
    ],
    directions: async () => {
      await delay(700)
      if (FAIL_REASONS.has(ai)) return { ok: false as const, reason: ai as RunFailReason }
      return {
        ok: true as const,
        directions: [
          'Links stop working after 7 days',
          'Hide private notes before sharing',
          'Show who opened it'
        ]
      }
    }
  },
  mighty: {
    listProjects: async () => projects,
    listSessions: async () => structuredClone(sessions),
    onProjectsChanged: () => () => undefined,
    onTurnAppended: (f: (p: { sessionId: string }) => void) => {
      turnListeners.add(f)
      return () => turnListeners.delete(f)
    },
    onPhase: (f: Live) => {
      phaseListeners.add(f)
      return () => phaseListeners.delete(f)
    },
    onEvent: (f: Live) => {
      eventListeners.add(f)
      return () => eventListeners.delete(f)
    },
    open: async (_fresh?: boolean, sessionId?: string) => {
      if (sessionId) opened.push(sessionId)
    },
    chat
  }
}
Object.assign(window, { api, __cvOpened: opened })

const embedded = new URLSearchParams(location.search).has('embed')

createRoot(document.getElementById('root')!).render(
  embedded ? (
    <div style={{ display: 'flex', height: '100vh', paddingTop: 44 }}>
      <div style={{ width: 300, flexShrink: 0, background: 'var(--surface1)' }} />
      <div
        style={{ position: 'relative', flex: 1, overflow: 'hidden', transform: 'translateZ(0)' }}
      >
        <CanvasApp />
      </div>
    </div>
  ) : (
    <CanvasApp />
  )
)
