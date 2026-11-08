import './index.css'
import { createRoot } from 'react-dom/client'
import { RailModeSwitch, SideBrowser } from './components/side-browser'
import { injectTheme } from './theme'

const params = new URLSearchParams(location.search)
const width = Number(params.get('w') ?? 360)
const state = params.get('state') ?? 'page'
const key = `harness-${state}`

const TABS = [
  { url: 'http://localhost:5173/dashboard', title: 'Dashboard - Acme' },
  { url: 'https://docs.stripe.com/payments/checkout', title: 'Stripe Checkout docs' },
  { url: 'https://github.com/acme/web/pull/412', title: 'Fix signup redirect #412' }
]
localStorage.setItem(
  'mm.sideBrowser.' + key,
  JSON.stringify({ urls: state === 'empty' ? [] : TABS, active: 0 })
)

let next = 0
const noop = (): (() => void) => () => {}
const stubbed = (api: Record<string, unknown>): Record<string, unknown> =>
  new Proxy(api, {
    get: (t, p: string) => (p in t ? t[p] : p.startsWith('on') ? noop : async () => undefined)
  })
const now = Date.now()
const agents = [
  { label: 'acme/web', sessionId: 's1', tldr: 'Fix signup redirect', project: { name: 'acme' }, cwd: '/Users/roy/acme', since: now - 3600000, pid: 101, agent: 'claude', model: 'Opus 5' },
  { label: 'acme/docs', sessionId: 's2', tldr: 'Checkout docs pass', project: { name: 'acme' }, cwd: '/Users/roy/acme', since: now - 900000, pid: 102, agent: 'claude', model: 'Opus 5', busySince: now - 40000 }
]
const talk: Record<string, unknown[]> = {
  s1: [
    { role: 'you', at: now - 900000, text: 'Take the first three seconds of this video and make it loop with Runway.' },
    { role: 'agent', at: now - 600000, text: 'Downloaded the post with yt-dlp, cut 0:00-0:03, and sent it to Runway. The loop is at ~/Downloads/roadster-loop.mp4.' }
  ]
}
const base = (window as unknown as { api?: Record<string, unknown> }).api ?? {}
const relay = {
  agentRelayGetStatus: async () => ({ enabled: true, running: true, agentCount: agents.length, agentSessions: agents }),
  agentRelayListClients: async () => [],
  agentRelayGetRequests: async () => ({ pending: [], resolved: [], dismissed: [] }),
  onAgentRelayRequestsChanged: noop,
  onAgentRelayStatusChanged: noop,
  agentRelaySessionTranscript: async (ref: string) => talk[ref] ?? [],
  agentRelaySessionSent: async () => [],
  agentRelaySessionHelpers: async () => [],
  agentRelaySuggest: async () => [],
  agentRelaySessionReply: async () => ({ ok: true, via: 'tmux' }),
  settingsGetPrefs: async () => ({}),
  codeAgentModels: async () => ({
    options: [{ harness: 'claude', model: 'opus', label: 'Opus 5.5' }],
    selected: { harness: 'claude', model: 'opus' },
    needsSetup: []
  }),
  codeNoProjectFolder: async () => '/Users/roy/MightyMouse',
  codeStartAgent: async () => ({ ok: true, pane: '%9' }),
  codeStartupPeek: async () => ({ alive: true, tail: [] }),
  settingsGet: async () => ({ codeOwnCopy: false }),
  mighty: stubbed({
    listSessions: async () => [],
    listProjects: async () => [{ id: 'p1', name: 'acme', repoFolder: '/Users/roy/acme' }],
    getSettings: async () => ({})
  })
}
Object.assign(window, {
  api: stubbed({
    ...base,
    ...relay,
    sideBrowser: stubbed({
      open: async (url: string) => ({
        id: `v${next++}`,
        url,
        title: TABS.find((t) => t.url === url)?.title ?? '',
        loading: state === 'loading',
        canGoBack: true,
        canGoForward: false,
        sitePermissions: state === 'perms' ? [{ kind: 'geo', label: 'your location', origin: url, allowed: true }] : []
      }),
      navigate: async () => {},
      command: async () => {},
      place: async () => {},
      close: async () => {},
      permission: async () => {},
      find: async () => {},
      onState: noop,
      onPopup: noop,
      onShortcut: noop,
      onOpenUrl: noop,
      takeUrl: async () => null,
      importSources: async () => [],
      importCookies: async () => ({ ok: true }),
      suggest: async () => [],
      topSites: async () => [
        { url: 'https://github.com', title: 'GitHub' },
        { url: 'https://vercel.com', title: 'Vercel' },
        { url: 'http://localhost:5173', title: 'Local' }
      ],
      recent: async () => [{ url: 'https://docs.stripe.com/payments/checkout', title: 'Stripe Checkout docs' }],
      forgetRecent: async () => {},
      forgetTopSite: async () => {}
    })
  })
})

const click = params.get('click')
if (click) setTimeout(() => (document.querySelector(click) as HTMLElement | null)?.click(), 800)

injectTheme()
createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="mighty-chat-layout" style={{ display: 'flex', height: '100vh', background: 'var(--bg)' }}>
    <div style={{ flex: 1, padding: 16 }}>Chat</div>
    <div className="chat-rail" data-mode="browser" style={{ width }}>
      <SideBrowser
        conversationKey={key}
        chatAim="s1"
        cwd={state === 'files' ? '/Users/roy/acme' : undefined}
        head={<RailModeSwitch mode="browser" onMode={() => {}} />}
      />
    </div>
  </div>
)
