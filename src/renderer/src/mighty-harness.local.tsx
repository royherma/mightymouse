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
  model: 'Opus 5'
}))

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
    state === 'trail' || state === 'home'
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
  agentRelaySessionTranscript: async () => [],
  agentRelaySessionChecklist: async () => null,
  agentRelaySessionKeys: async () => true,
  agentRelaySessionHelpers: async () => [],
  agentRelaySessionSent: async () => [],
  agentRelaySessionScreen: async () => ({ text: '', cols: 96, rows: 40, history: 0, alt: false, streamed: true }),
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
history.replaceState(null, '', `?window=mighty&state=${state}${modelPreview ? `&models${['copy', 'open'].filter((k) => new URLSearchParams(location.search).has(k)).map((k) => `&${k}`).join('')}` : ''}${updateReady ? '&update=ready' : ''}${state === 'trail' || state === 'home' ? '&tab=code' : ''}`)
if (modelPreview) await import('./project-scope-harness.local')
else await import('./main')
