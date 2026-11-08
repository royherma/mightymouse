import { CONFIG } from '../../shared/config'
import appIcon from './assets/app-icon.png'
import { CLAUDE_REASONING_EFFORTS } from '../../shared/model-sources'
import type { AgentRelaySessionInfo, AgentTranscriptTurn, MightyProject, MightySession, MightySettings } from '../../shared/types'

const state = new URLSearchParams(location.search).get('state') ?? 'readme'
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

const readme = state === 'readme'
const shot = new URLSearchParams(location.search).get('shot') ?? 'code'
const repo = (name: string): string => `~/code/${name}`
const readmeProjects: MightyProject[] = [
  { id: 'rp1', name: 'acme-shop', created: ago(9000), updated: ago(3), pinned: true, imagePath: appIcon, repoFolder: repo('acme-shop') },
  { id: 'rp2', name: 'docs-site', created: ago(8000), updated: ago(40), icon: 'globe', repoFolder: repo('docs-site') },
  { id: 'rp3', name: 'mobile-app', created: ago(7000), updated: ago(300), icon: 'phone', repoFolder: repo('mobile-app') },
  { id: 'rp4', name: 'api-server', created: ago(6000), updated: ago(900), icon: 'database', repoFolder: repo('api-server') },
  { id: 'rp5', name: 'design-system', created: ago(5000), updated: ago(1400), icon: 'palette', repoFolder: repo('design-system') }
]
const now = Date.now()
let sessionIndex = 0
const agentSession = (
  label: string,
  cwd: string,
  agent: string,
  model: string,
  tldr: string,
  extra: Partial<AgentRelaySessionInfo> = {}
): AgentRelaySessionInfo => ({
  label,
  cwd,
  agent,
  model,
  tldr,
  sessionId: label,
  since: now - (25 + 70 * sessionIndex++) * 60_000,
  pid: 4242,
  canWrapUp: true,
  hostAppName: 'Terminal',
  origin: { tmuxPane: '%3' },
  lastActivityAt: now - 20_000,
  ...extra
})
const readmeAgents: AgentRelaySessionInfo[] = [
  agentSession('acme-shop/fix-checkout-button', repo('acme-shop'), 'claude', 'Opus 5.5', 'Checkout button works on phones again', {
    effort: 'high',
    idleSince: now - 60_000,
    handedBackAt: now - 60_000,
    lastTurnEndedAt: now - 60_000,
    progress: 1
  }),
  agentSession('acme-shop/add-coupon-field', repo('acme-shop'), 'codex', 'GPT-6.1 Sol', 'Coupon code field on the cart page', {
    busySince: now - 3 * 60_000,
    progress: 0.6
  }),
  agentSession('docs-site/new-pricing-page', repo('docs-site'), 'cursor', 'Composer 2', 'Pricing page with three plans', {
    idleSince: now - 6 * 60_000,
    handedBackAt: now - 6 * 60_000,
    lastTurnEndedAt: now - 6 * 60_000,
    progress: 1
  }),
  agentSession('docs-site/fix-broken-links', repo('docs-site'), 'claude', 'Sonnet 5.5', 'Fix 14 broken links in the guides', {
    busySince: now - 2 * 60_000,
    progress: 0.8
  }),
  agentSession('acme-shop/faster-search', repo('acme-shop'), 'claude', 'Opus 5.5', 'Product search answers in under 100ms', {
    effort: 'high',
    busySince: now - 12 * 60_000,
    progress: 0.45
  }),
  agentSession('acme-shop/order-emails', repo('acme-shop'), 'codex', 'GPT-6.1 Sol', 'Order confirmation emails with tracking links', {
    idleSince: now - 18 * 60_000,
    handedBackAt: now - 18 * 60_000,
    lastTurnEndedAt: now - 18 * 60_000,
    progress: 1
  }),
  agentSession('acme-shop/refund-button', repo('acme-shop'), 'cursor', 'Composer 2', 'One-click refunds in the admin', {
    busySince: now - 5 * 60_000,
    progress: 0.2
  }),
  agentSession('docs-site/api-reference', repo('docs-site'), 'claude', 'Haiku 5.5', 'API reference pages from the OpenAPI file', {
    busySince: now - 4 * 60_000,
    progress: 0.55
  }),
  agentSession('mobile-app/push-alerts', repo('mobile-app'), 'claude', 'Opus 5.5', 'Push alert when an order ships', {
    effort: 'high',
    idleSince: now - 25 * 60_000,
    handedBackAt: now - 25 * 60_000,
    lastTurnEndedAt: now - 25 * 60_000,
    progress: 1
  }),
  agentSession('mobile-app/dark-mode', repo('mobile-app'), 'codex', 'GPT-6.1 Sol', 'Dark mode for the settings screen', {
    busySince: now - 8 * 60_000,
    progress: 0.3
  })
]
const esc = (code: string): string => `\x1b[${code}m`
const dim = (s: string): string => `${esc('2')}${s}${esc('22')}`
const bold = (s: string): string => `${esc('1')}${s}${esc('22')}`
const green = (s: string): string => `${esc('32')}${s}${esc('39')}`
const red = (s: string): string => `${esc('31')}${s}${esc('39')}`
const orange = (s: string): string => `${esc('38;5;209')}${s}${esc('39')}`
const readmeScreen = [
  `${orange('>')} The checkout button does nothing on my phone. Can you fix it?`,
  '',
  `${orange('●')} I'll look at the checkout button and how it renders on small screens.`,
  '',
  `${green('●')} ${bold('Read')}(src/checkout/Button.tsx)`,
  `  ${dim('⎿  Read 84 lines')}`,
  '',
  `${green('●')} ${bold('Read')}(src/layout/CookieBanner.tsx)`,
  `  ${dim('⎿  Read 41 lines')}`,
  '',
  `${orange('●')} Found it. On screens under 420px the cookie banner sits on top of the`,
  '  checkout button with a higher z-index, so taps land on the banner.',
  '',
  `${green('●')} ${bold('Update')}(src/layout/CookieBanner.tsx)`,
  `  ${dim('⎿  Updated src/layout/CookieBanner.tsx with 3 additions and 2 removals')}`,
  `     ${dim('18')}    <div`,
  `     ${dim('19')} ${red('-    className="fixed top-0 z-50 w-full"')}`,
  `     ${dim('19')} ${green('+    className="fixed bottom-0 z-40 w-full"')}`,
  `     ${dim('20')} ${green('+    style={{ paddingBottom: \'env(safe-area-inset-bottom)\' }}')}`,
  '',
  `${green('●')} ${bold('Update')}(src/checkout/Button.tsx)`,
  `  ${dim('⎿  Updated src/checkout/Button.tsx with 4 additions and 1 removal')}`,
  '',
  `${green('●')} ${bold('Bash')}(npm test -- checkout)`,
  `  ${dim('⎿  PASS  src/checkout/Button.test.tsx')}`,
  `     ${dim('Tests: 12 passed, 12 total')}`,
  '',
  `${orange('●')} Fixed. The banner now sits at the bottom of the screen and below the`,
  '  button, so taps reach checkout again. All 12 checkout tests pass.',
  '',
  `${dim('─'.repeat(78))}`,
  `${orange('>')} `,
  `${dim('─'.repeat(78))}`,
  `  ${dim('? for shortcuts')}`
].join('\n')
const readmeTranscript: AgentTranscriptTurn[] = [
  { role: 'you', at: now - 14 * 60_000, text: 'The checkout button does nothing on my phone. Can you fix it?' },
  { role: 'agent', at: now - 13 * 60_000, text: "I'll check how the checkout button renders on small screens." },
  { role: 'tool', at: now - 13 * 60_000, text: 'Read src/checkout/Button.tsx', files: ['src/checkout/Button.tsx'] },
  { role: 'tool', at: now - 12 * 60_000, text: 'Read src/layout/CookieBanner.tsx', files: ['src/layout/CookieBanner.tsx'] },
  {
    role: 'agent',
    at: now - 11 * 60_000,
    text: 'Found it. On screens under 420px the cookie banner sits on top of the checkout button, so every tap lands on the banner instead.'
  },
  { role: 'tool', at: now - 9 * 60_000, text: 'Edited src/layout/CookieBanner.tsx', files: ['src/layout/CookieBanner.tsx'] },
  { role: 'tool', at: now - 8 * 60_000, text: 'Edited src/checkout/Button.tsx', files: ['src/checkout/Button.tsx'] },
  { role: 'tool', at: now - 6 * 60_000, text: 'Ran npm test -- checkout' },
  {
    role: 'agent',
    at: now - 5 * 60_000,
    text: 'Fixed. The banner now sits at the bottom of the screen, below the button, so taps reach checkout again. All 12 checkout tests pass.',
    files: ['src/layout/CookieBanner.tsx', 'src/checkout/Button.tsx', 'src/checkout/Button.test.tsx'],
    recap: 'Checkout button works on phones again'
  },
  { role: 'you', at: now - 3 * 60_000, text: 'Great, commit it and open a PR.' },
  { role: 'tool', at: now - 2 * 60_000, text: 'Ran git commit and gh pr create' },
  { role: 'agent', at: now - 60_000, text: 'Done. Two commits are on fix-checkout-button and PR #128 is open against main.' }
]
const readmeChanges = {
  base: 'main',
  files: [
    { path: 'src/checkout/Button.tsx', added: 4, removed: 1 },
    { path: 'src/layout/CookieBanner.tsx', added: 3, removed: 2 },
    { path: 'src/checkout/Button.test.tsx', added: 18, removed: 0 }
  ],
  patch: [
    'diff --git a/src/layout/CookieBanner.tsx b/src/layout/CookieBanner.tsx',
    '--- a/src/layout/CookieBanner.tsx',
    '+++ b/src/layout/CookieBanner.tsx',
    '@@ -16,7 +16,8 @@ export function CookieBanner() {',
    '   return (',
    '     <div',
    '-      className="fixed top-0 z-50 w-full"',
    '+      className="fixed bottom-0 z-40 w-full"',
    "+      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}",
    '     >',
    ''
  ].join('\n'),
  truncated: false
}
const readmeChats: MightySession[] = [
  session('rc1', 'Fix the checkout button', 4, 'rp1', [
    turn(
      'Why does the checkout button do nothing on my phone?',
      'The cookie banner sits on top of the checkout button on small screens, so taps never reach it. Move the banner to the bottom of the screen and the button works again.',
      4
    )
  ]),
  session('rc2', 'Write a thank-you email to a customer', 55, 'rp1'),
  session('rc3', 'Draft the pricing page copy', 300, 'rp2'),
  session('rc4', 'Plan a weekend in Lisbon', 2900)
]
const caps = { vision: false, tools: true, thinking: true }
const readmeApps: Array<[string, string]> = [
  ['github', 'https://api.githubcopilot.com/mcp/'],
  ['linear', 'https://mcp.linear.app/mcp'],
  ['sentry', 'https://mcp.sentry.dev/mcp'],
  ['figma', 'https://mcp.figma.com/mcp']
]
const readmeModels = [
  { harness: 'claude', model: '', label: 'Default' },
  { harness: 'claude', model: 'fable', label: 'Fable', reasoningEfforts: CLAUDE_REASONING_EFFORTS },
  { harness: 'claude', model: 'opus', label: 'Opus 5.5', reasoningEfforts: CLAUDE_REASONING_EFFORTS },
  { harness: 'claude', model: 'sonnet', label: 'Sonnet 5.5', reasoningEfforts: CLAUDE_REASONING_EFFORTS },
  { harness: 'claude', model: 'haiku', label: 'Haiku 5.5', reasoningEfforts: [] },
  { harness: 'codex', model: '', label: 'Default' },
  { harness: 'codex', model: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { harness: 'opencode', model: 'opencode/qwen3-coder', label: 'qwen3-coder' },
  { harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4', label: 'deepseek/deepseek-v4' }
]
const homeLabels = ['acme-shop/fix-checkout-button', 'acme-shop/add-coupon-field', 'acme-shop/refund-button', 'docs-site/fix-broken-links', 'mobile-app/dark-mode']
const openAgents = shot === 'home' || shot === 'dial' ? readmeAgents.filter((s) => homeLabels.includes(s.label)) : readmeAgents
const readmeApi: Record<string, unknown> = {
  auth: { getSession: async () => ({ email: 'dev@example.com' }) },
  agentRelayGetStatus: async () => ({
    enabled: true,
    running: true,
    deviceLabel: 'iPhone',
    lastAgentAt: now - 20_000,
    agentCount: openAgents.length,
    agentNames: openAgents.map((s) => s.label),
    agentSessions: openAgents
  }),
  agentRelayListClients: async () => [],
  codeConductorWorkspaces: async () => [],
  mcp: {
    list: async () => readmeApps.map(([name, url]) => ({ name, scope: 'user', spec: { transport: 'http', url } })),
    health: async () => readmeApps.map(([name, url]) => ({ name, target: url, status: 'connected', detail: '' }))
  },
  mediaUrl: (path: string) => path,
  built: { list: async () => [] },
  infra: { list: async () => [] },
  sideBrowser: { recent: async () => [], topSites: async () => [] },
  markupList: async () => [],
  agentRelaySessionScreen: async () => ({ text: readmeScreen, cols: 96, rows: 40, history: 0, alt: false, streamed: true }),
  agentRelaySessionWatch: async () => true,
  agentRelaySessionFit: async () => true,
  agentRelaySessionUsage: async () => ({ output: 18_400, context: 61_000, contextWindow: 200_000 }),
  agentRelaySessionTranscript: async () => readmeTranscript,
  agentRelaySessionChecklist: async () => ({
    goal: 'Checkout button works on phones',
    items: [
      { label: 'Find why taps miss the button', status: 'completed' },
      { label: 'Move the cookie banner out of the way', status: 'completed' },
      { label: 'Add a tap test for the button', status: 'completed' },
      { label: 'Open a pull request', status: 'completed' }
    ],
    done: 4
  }),
  agentRelaySessionHelpers: async () => [],
  agentRelaySessionSent: async () => [],
  agentRelaySuggest: async () => [{ text: 'Merge it' }, { text: 'Test it on Safari too' }, { text: 'Write the release note' }],
  agentRelaySessionTools: async () => [],
  agentRelaySessionAffects: async () => ({ surfaces: [], envs: [] }),
  repoGitState: async () => ({
    branch: shot === 'home' || shot === 'dial' ? 'main' : 'fix-checkout-button',
    upstream: 'origin/fix-checkout-button',
    ahead: 2,
    dirty: 0,
    head: { sha: '4f2a9c1e', subject: 'Move cookie banner below the checkout button' },
    pending: ['Move cookie banner below the checkout button', 'Add checkout button tap test'],
    remoteHost: 'GitHub'
  }),
  repoGitChanges: async () => readmeChanges,
  repoGitPull: async () => ({ url: 'https://github.com/acme/acme-shop/pull/128', number: 128, state: 'open', base: 'main' }),
  codeAgentModels: async () => ({ options: readmeModels, selected: { harness: 'claude', model: 'opus' }, needsSetup: [] }),
  planLoginsList: async () => [
    { id: 'claude-default', backend: 'claude', email: 'you@example.com', plan: 'max', dir: null, windows: [], checkedAt: null, limitedUntil: null }
  ],
  settingsListLocalModels: async () => [
    { name: 'qwen3-coder:30b', sizeBytes: 18e9, ...caps },
    { name: 'gpt-oss:20b', sizeBytes: 13e9, ...caps }
  ],
  settingsListMlxModels: async () => [{ name: 'qwen3-8b-4bit', sizeBytes: 0, ...caps }],
  chatSourceModels: async () => [
    { source: 'openrouter', model: 'deepseek/deepseek-v4', label: 'DeepSeek V4', thinks: true },
    { source: 'openrouter', model: 'moonshotai/kimi-k2', label: 'Kimi K2' },
    { source: 'opencode', model: 'opencode/qwen3-coder', label: 'qwen3-coder' }
  ],
  planLoginPicks: async () => ({ claude: 'claude-default' }),
  settingsGet: async () => ({ codeOwnCopy: false }),
  mighty: {
    listSessions: async () => readmeChats,
    getSession: async (id: string) => readmeChats.find((c) => c.id === id) ?? null,
    onOpenSession: (cb: (id: string) => void) => {
      if (shot === 'models') setTimeout(() => cb('rc1'), 400)
      return noop
    },
    listProjects: async () => readmeProjects,
    foundProjects: async () => []
  }
}
if (readme) {
  Object.assign(CONFIG, { APP_NAME: 'MightyMouse', BRAND_NAME: 'MightyMouse' })
  localStorage.setItem('mm.picker.collapsed', JSON.stringify(['mightymouse', 'plan:claude', 'plan:codex', 'local', 'mlx', 'openrouter', 'opencode', 'codex']))
  localStorage.setItem('mm.code.efforts', JSON.stringify({ 'claude:opus': 'medium' }))
  localStorage.setItem('mm.code.plan', '0')
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
  agentRelayGetStatus: async () => ({ enabled: false, running: false, agentSessions: [] }),
  agentRelayListClients: async () => [],
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

const api = readme
  ? { ...explicit, ...readmeApi, mighty: { ...(explicit.mighty as object), ...(readmeApi.mighty as object) } }
  : explicit
Object.assign(window, { api: layer(undefined, api) })
const readmeQuery = shot === 'agents' ? '&tab=code&codeTab=sessions' : shot === 'home' || shot === 'dial' ? '&tab=code' : shot === 'models' ? '&mode=chat' : `&tab=code&codeSession=${encodeURIComponent(readmeAgents[0].label)}`
history.replaceState(null, '', `?window=mighty&state=${state}${readme ? readmeQuery : ''}${modelPreview ? `&models${['copy', 'open'].filter((k) => new URLSearchParams(location.search).has(k)).map((k) => `&${k}`).join('')}` : ''}${updateReady ? '&update=ready' : ''}`)
if (modelPreview) await import('./project-scope-harness.local')
else await import('./main')
