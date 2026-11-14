import { CONFIG } from '../../shared/config'
import type { MightyProject, MightySession, MightySettings } from '../../shared/types'

const state = new URLSearchParams(location.search).get('state') ?? 'default'
const modelPreview = new URLSearchParams(location.search).has('models')
const updateReady = new URLSearchParams(location.search).get('update') === 'ready'
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString()

const projects: MightyProject[] =
  state === 'empty'
    ? []
    : [
        { id: 'pr1', name: 'Online shop', created: ago(9000), updated: ago(30), pinned: true },
        { id: 'pr2', name: 'Taxes 2025', created: ago(8000), updated: ago(600) },
        { id: 'pr3', name: 'Marketing site', created: ago(7000), updated: ago(2000) }
      ]

const turn = (q: string, a: string, min: number): MightySession['turns'][number] => ({
  source: 'chat',
  q,
  a,
  ts: ago(min),
  ok: true,
  backend: 'claude'
})
const session = (id: string, title: string, min: number, projectId?: string, turns = [turn(title, 'Done. I made the change and checked it works.', min)]): MightySession => ({
  schema_version: 1,
  id,
  created: ago(min + 5),
  updated: ago(min),
  title,
  turns,
  projectId
})

const sessions: MightySession[] =
  state === 'empty'
    ? []
    : [
        session(
          's1',
          'Fix the checkout button',
          4,
          'pr1',
          [
            turn(
              'Why does the checkout button do nothing on my phone?',
              'The button sits under the cookie banner on small screens, so taps never reach it. I moved the banner to the bottom and the button now responds. Try it again on your phone.',
              4
            )
          ]
        ),
        session('s2', 'Write a thank-you email to a customer', 55, 'pr1'),
        session('s3', 'Sort last year receipts by month', 300, 'pr2'),
        session('s4', 'Shorten the homepage headline', 1500, 'pr3'),
        session('s5', 'Plan a weekend in Lisbon', 2900)
      ]

const settings: MightySettings = {
  name: '',
  instructions: '',
  outputFormat: 'auto' as MightySettings['outputFormat'],
  tabNameFormat: 'pretty',
  linksOpenIn: 'app' as MightySettings['linksOpenIn'],
  importedFoundProjects: true
}

const noop = (): void => undefined
const done = Promise.resolve(undefined)

const prefs = {
  backend: 'claude',
  selectedModel: '',
  thinkingEnabled: false,
  soundEnabled: true,
  historyFilterHidden: [] as string[],
  mightySourceFilterHidden: [] as string[],
  mightyShowEmpty: false,
  incognito: false,
  advancedMenu: false,
  phoneRemoteEnabled: false,
  phoneRemoteSupported: true,
  showTiming: false,
  runTranscript: false,
  decisionCards: true
}

const homeClosed = new URLSearchParams(location.search).has('closed')
const homeLog = <T,>(kind: string, value: T): T => {
  ;((window as unknown as { __homeLog?: unknown[] }).__homeLog ??= []).push({ kind, value })
  return value
}
const trailTitles = state === 'home' ? ['Phone chat edge cases', 'Landing page lock protection', 'Projects icons addition'] : ['Fix login bug', 'Add dark mode', 'Write release notes']
const trailSessions = trailTitles.map((label, i) => ({
  label,
  stated: label,
  tldr: label,
  sessionId: `trail-${i + 1}`,
  cwd: '/Users/me/shop',
  since: Date.now() - (i + 1) * 600_000,
  lastActivityAt: Date.now() - i * 60_000,
  agent: 'claude',
  model: 'Opus 5',
  ...(i === 0 && new URLSearchParams(location.search).has('busy') ? { busySince: Date.now() - 30_000, pid: 4242 } : {})
}))

const delegating = state === 'delegate'
const delegateDone = delegating && new URLSearchParams(location.search).has('done')
const delegateSessions = [
  { label: 'Build the checkout page', agent: 'claude', model: 'Opus 5', busy: !delegateDone },
  { label: 'Helping Claude Code: review the checkout page for bugs', agent: 'codex', model: 'GPT-6.1', busy: !delegateDone },
  { label: 'Write release notes', agent: 'claude', model: 'Opus 5', busy: false }
].map((row, i) => ({
  label: row.label,
  stated: row.label,
  tldr: row.label,
  sessionId: `trail-${i + 1}`,
  cwd: '/Users/me/shop',
  since: Date.now() - (3 - i) * 300_000,
  lastActivityAt: Date.now() - 5_000,
  agent: row.agent,
  model: row.model,
  ...(row.busy ? { busySince: Date.now() - 40_000, pid: 4242 + i } : {})
}))
const delegateTurns = [
  { role: 'you', at: Date.now() - 600_000, text: 'Build the new checkout page. When it works, get Codex to double-check it before we ship.' },
  { role: 'tool', at: Date.now() - 400_000, text: 'Edit · src/checkout/CheckoutPage.tsx' },
  { role: 'tool', at: Date.now() - 300_000, text: 'Bash · npm test checkout' },
  { role: 'agent', at: Date.now() - 60_000, text: 'The checkout page is built and all 14 checkout tests pass.\n\nHanding it to **Codex** for a second look before you ship it.' },
  { role: 'tool', at: Date.now() - 40_000, text: 'Asked Codex · Review the checkout page for bugs and send back what you find' },
  ...(delegateDone
    ? [
        { role: 'agent', at: Date.now() - 20_000, text: 'Codex found 2 bugs I missed:\n\n1. The discount code was applied twice when the page reloaded\n2. The Pay button stayed clickable while the card was still loading' },
        { role: 'tool', at: Date.now() - 15_000, text: 'Edit · src/checkout/cart.ts' },
        { role: 'tool', at: Date.now() - 10_000, text: 'Bash · npm test checkout' },
        { role: 'agent', at: Date.now() - 5_000, text: 'Fixed both and added a test for each. **16 checkout tests pass.** Ready to ship.' }
      ]
    : [])
]
const delegateScreens: Record<string, string> = {
  'trail-1': [
    ' ▐▛███▜▌   Claude Code',
    '▝▜█████▛▘  Opus 5 · ~/shop',
    '',
    '> Build the new checkout page. When it works, get Codex to double-check it.',
    '',
    '● Write(src/checkout/CheckoutPage.tsx)',
    '  ⎿  Wrote 186 lines',
    '● Bash(npm test checkout)',
    '  ⎿  14 passed',
    '',
    '● The checkout page is built and all 14 checkout tests pass.',
    '',
    '● mightymouse-code - delegate (agent: "codex")',
    '  ⎿  Codex is reviewing the checkout page…',
    '',
    '✻ Waiting for Codex… (41s)'
  ].join('\n'),
  'trail-2': [
    '>_ OpenAI Codex',
    '   model: GPT-6.1 · ~/shop',
    '',
    '› Review the checkout page for bugs and send back what you find',
    '',
    '• Read src/checkout/CheckoutPage.tsx',
    '• Read src/checkout/cart.ts',
    '• Ran npm test checkout',
    '  └ 14 passed',
    '',
    '• Found 2 issues:',
    '  1. Discount code is applied twice when the page reloads',
    '  2. Pay button stays enabled while the card is still loading',
    '',
    '◦ Working (38s • esc to interrupt)'
  ].join('\n')
}
const helperTurns = [
  { role: 'you', at: Date.now() - 40_000, text: 'Review the checkout page for bugs and send back what you find' },
  { role: 'tool', at: Date.now() - 35_000, text: 'Read · src/checkout/CheckoutPage.tsx' },
  { role: 'tool', at: Date.now() - 30_000, text: 'Read · src/checkout/cart.ts' },
  { role: 'tool', at: Date.now() - 25_000, text: 'Bash · npm test checkout' },
  { role: 'agent', at: Date.now() - 20_000, text: 'Found 2 bugs:\n\n1. The discount code is applied twice when the page reloads (`cart.ts:42`)\n2. The Pay button stays clickable while the card is still loading (`CheckoutPage.tsx:118`)' }
]
const delegateHelpers = delegateDone ? [] : [{ task: 'Codex', doing: 'Review the checkout page for bugs and send back what you find', since: Date.now() - 40_000, agent: 'codex' }]

const explicit: Record<string, unknown> = {
  settingsGetPrefs: async () => prefs,
  getRecoveredRecordings: async () => ({ working: false, items: [] }),
  getModelCatalog: async () => CONFIG.MODEL_CATALOG,
  settingsListLocalModels: async () => [],
  settingsListMlxModels: async () => [],
  chatModelPicks: async () => ({ opencode: '', openrouter: '' }),
  chatSourceModels: async () => [],
  update: { getState: async () => (updateReady ? { state: 'downloaded', version: '0.50.0' } : { state: 'idle' }) },
  auth: { getSession: async () => ({ email: 'dev2@example.com' }) },
  agentRelayGetStatus: async () =>
    delegating
      ? { enabled: true, running: true, agentSessions: delegateSessions }
      : state === 'trail' || state === 'home'
      ? { enabled: true, running: true, agentSessions: trailSessions }
      : { enabled: false, running: false, agentSessions: [] },
  agentRelayListClients: async () => [],
  codeConductorWorkspaces: async () => [],
  codeRouteTask: (said: string) =>
    new Promise((done) => setTimeout(() => done(homeLog('route', /phone/i.test(said) ? 'trail-1' : null)), 2500)),
  agentRelaySessionReply: async (ref: string, said: string) =>
    homeLog('reply', { ref, said, ok: !homeClosed }) && (homeClosed ? { ok: false } : { ok: true, via: 'tmux' }),
  codeStartupPeek: async () => ({ alive: true, prompt: null, tail: ['Starting Claude Code…'] }),
  codeStartAgent: async (input: { message?: string }) => homeLog('start', { message: input.message }) && { ok: true, pane: '%harness' },
  agentRelaySessionBtw: (_ref: string, question: string) =>
    new Promise((done) => setTimeout(() => done({ ok: true, answer: /url/i.test(question) ? 'The shop runs at http://shop.localhost:4821 - open it now, the login fix is not in yet.' : 'Still on the login fix.' }), 900)),
  skillsList: async () => [],
  agentRelaySessionTranscript: async (ref: string) => (delegating && ref === 'trail-1' ? delegateTurns : delegating && ref === 'trail-2' ? helperTurns : []),
  agentRelaySessionChecklist: async () => null,
  agentRelaySessionKeys: async () => true,
  agentRelaySessionHelpers: async (ref: string) => (delegating && ref === 'trail-1' ? delegateHelpers : []),
  agentRelaySessionSent: async () => [],
  agentRelaySessionScreen: async (ref: string) => ({ text: delegating ? delegateScreens[ref] ?? '' : '', cols: 96, rows: 40, history: 0, alt: false, streamed: true }),
  agentRelaySessionWatch: async () => true,
  agentRelaySessionFit: async () => true,
  agentRelaySessionUsage: async () => ({ output: 0, context: 0, contextWindow: 200_000 }),
  agentRelaySuggest: async () => [],
  agentRelaySessionTools: async () => [],
  agentRelaySessionAffects: async () => ({ surfaces: [], envs: [] }),
  repoGitState: async () => ({ branch: 'main', ahead: 0, dirty: 0, pending: [] }),
  repoGitChanges: async () => [],
  codeAgentModels: async () => ({ options: [], selected: { harness: 'claude', model: 'opus' }, needsSetup: [] }),
  planLoginsList: async () => [],
  planLoginPicks: async () => ({}),
  markupList: async () => [],
  built: { list: async () => [] },
  infra: { list: async () => [] },
  sideBrowser: { recent: async () => [], topSites: async () => [] },
  mcp: { list: async () => [], health: async () => [] },
  agentRelayGetRequests: async () => ({ pending: [], resolved: [], dismissed: [] }),
  mighty: {
    onOpenSession: (cb: (id: string) => void) => {
      if (state === 'chat') setTimeout(() => cb('s1'), 400)
      return noop
    },
    listSessions: async () => sessions,
    getSession: async (id: string) => sessions.find((s) => s.id === id) ?? null,
    listProjects: async () => projects,
    listJobs: async () => [],
    listRegistry: async () => [],
    getSettings: async () => settings,
    getRenderMarkup: async () => true,
    getSpeakReplies: async () => false,
    getDetailMode: async () => false,
    getZoomLevel: async () => 0,
    getSidebarWidth: async () => 260,
    getSidebarShown: async () => true,
    getContextRailShown: async () => false,
    getWorkspaces: async () => [],
    foundProjects: async () => []
  }
}

const layer = (base: unknown, over: unknown): unknown =>
  new Proxy(function () {}, {
    get: (_t, k) => {
      if (typeof k === 'symbol') return undefined
      if (k === 'then') return undefined
      const o = (over as Record<string, unknown> | undefined)?.[k]
      if (o !== undefined && typeof o !== 'function') return layer(undefined, o)
      if (o !== undefined) return o
      if (/^on[A-Z]/.test(k)) return () => noop
      return layer(base, undefined)
    },
    apply: () => done
  })

Object.assign(window, { api: layer(undefined, explicit) })
history.replaceState(null, '', `?window=mighty&state=${state}${modelPreview ? `&models${['copy', 'open'].filter((k) => new URLSearchParams(location.search).has(k)).map((k) => `&${k}`).join('')}` : ''}${updateReady ? '&update=ready' : ''}${state === 'trail' || state === 'home' || delegating ? '&tab=code' : ''}${delegateDone ? '&done' : ''}`)
if (modelPreview) await import('./project-scope-harness.local')
else await import('./main')
