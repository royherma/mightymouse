import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { InfraPanel } from './components/InfraPanel'
import type { MightyProject } from '../../shared/types'
import type { KeyRecord, ProjectKeyMap } from '../../shared/keys'
import type { InfraRecord, ProjectInfra } from '../../shared/infra'
import { injectTheme } from './theme'

const stamp = '2026-09-24T09:41:00.000Z'

const projects: MightyProject[] = [
  { id: 'p1', name: 'MightyMouse', created: stamp, updated: stamp, repoFolder: '/Users/roy/dev/mm' },
  { id: 'p2', name: 'petfomo', created: stamp, updated: stamp, repoFolder: '/Users/roy/dev/petfomo' },
  { id: 'p3', name: 'No folder yet', created: stamp, updated: stamp }
]

const mm: InfraRecord = {
  checkedAt: stamp,
  appKinds: ['desktop', 'web'],
  skip: [],
  setups: {
    logging: { provider: 'cf_observability', startedAt: new Date(Date.now() - 3 * 60_000).toISOString(), pane: '%1' },
    health: { provider: 'health_route', startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), pane: '%2' },
    errors: { provider: 'bugsnag', startedAt: new Date(Date.now() - 40 * 60_000).toISOString(), pane: '%3', had: ['sentry', 'electron_crash'] }
  },
  services: {
    product_analytics: [{ provider: 'posthog', foundIn: 'src/main/analytics.ts:12', key: 'POSTHOG_API_KEY' }],
    web_analytics: [{ provider: 'cf_web_analytics', foundIn: 'web/index.html:18' }],
    errors: [
      { provider: 'sentry', foundIn: 'src/main/sentry.ts:4', key: 'SENTRY_DSN' },
      { provider: 'electron_crash', foundIn: 'src/main/index.ts:88' }
    ],
    logging: [],
    auth: [{ provider: 'supabase_auth', foundIn: 'portal/src/auth.ts:31', key: 'SUPABASE_ANON_KEY' }],
    payments: [{ provider: 'stripe', foundIn: 'supabase/functions/stripe-webhook/index.ts:9', key: 'STRIPE_SECRET_KEY' }],
    email: [{ provider: 'resend', foundIn: 'supabase/functions/_shared/email.ts:3', key: 'RESEND_API_KEY' }],
    database: [{ provider: 'supabase', foundIn: 'src/main/cloud.ts:7', key: 'SUPABASE_URL' }],
    hosting: [
      { provider: 'cloudflare', foundIn: 'web/wrangler.toml', key: 'CLOUDFLARE_API_TOKEN' },
      { provider: 'uptime-kuma', label: 'Uptime Kuma', manual: true }
    ]
  }
}

const petfomo: InfraRecord = {
  checkedAt: stamp,
  appKinds: ['mobile', 'worker'],
  skip: ['push'],
  business: ['store'],
  brief: {
    what: 'Online pet store',
    audience: 'Dog owners in Thailand',
    niche: 'Pet supplies',
    goal: { metric: 'store.visitors-who-buy', target: 2.7, by: '2026-12-31' }
  },
  services: {
    errors: [{ provider: 'sentry', foundIn: 'app/_layout.tsx:9', key: 'SENTRY_DSN' }],
    database: [{ provider: 'd1', foundIn: 'worker/wrangler.toml:14' }],
    hosting: [{ provider: 'cloudflare', foundIn: 'worker/wrangler.toml' }]
  }
}

const infra: ProjectInfra[] = [
  { projectId: 'p1', repoFolder: '/Users/roy/dev/mm', record: mm, live: { logging: 'working', health: 'waiting', errors: 'stopped' } },
  { projectId: 'p2', repoFolder: '/Users/roy/dev/petfomo', record: petfomo },
  { projectId: 'p3', record: null, error: 'This project has no folder on this Mac.' }
]

const key = (id: string, name: string, provider: string, status: KeyRecord['status']): KeyRecord => ({
  id,
  name,
  provider,
  routes: ['api'],
  scope: 'global',
  source: 'keychain',
  shape: '…',
  length: 40,
  status,
  addedBy: 'scan',
  updated: stamp
})

const maps: ProjectKeyMap[] = [
  {
    projectId: 'global',
    scannedAt: stamp,
    keys: [
      key('k1', 'POSTHOG_API_KEY', 'posthog', 'ready'),
      key('k2', 'SENTRY_DSN', 'sentry', 'unverified'),
      key('k3', 'STRIPE_SECRET_KEY', 'stripe', 'ready'),
      key('k4', 'SUPABASE_ANON_KEY', 'supabase', 'broken'),
      key('k5', 'CLOUDFLARE_API_TOKEN', 'cloudflare', 'ready')
    ],
    needs: [],
    missing: [],
    cloud: [],
    errors: []
  }
]

const find = (id: string): ProjectInfra => infra.find((p) => p.projectId === id) ?? { projectId: id, record: null }

Object.assign(window, {
  api: {
    mighty: { listProjects: async () => projects },
    infra: {
      list: async () => infra,
      check: async (id: string) => find(id),
      add: async (id: string) => find(id),
      remove: async (id: string) => find(id),
      skip: async (id: string) => find(id),
      setup: async (id: string) => find(id),
      want: async (id: string) => find(id),
      setBusiness: async (id: string) => find(id),
      setBrief: async (id: string) => find(id),
      site: async () => ({ site: null, suggested: 'petfomo' }),
      onSiteProgress: () => () => {},
      onChanged: () => () => {}
    },
    keys: { list: async () => maps, onChanged: () => () => {} },
    codeStartAgent: async () => ({ ok: true }),
    openPath: async () => '',
    favicon: async () => null
  }
})

injectTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex' }}>
      <InfraPanel onOpenAgent={() => {}} />
    </div>
  </StrictMode>
)
