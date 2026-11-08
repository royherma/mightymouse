import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { KeysPanel } from './components/KeysPanel'
import type { MightyProject } from '../../shared/types'
import type { ProjectKeyMap, KeySetPayload } from '../../shared/keys'
import { injectTheme } from './theme'

const stamp = '2026-09-22T00:00:00.000Z'
const soon = new Date(Date.now() + 9 * 86_400_000).toISOString()

const projects: MightyProject[] = [
  { id: 'c1', name: 'MightyMouse', created: stamp, updated: stamp, repoFolder: '/Users/roy/dev/mm' },
  { id: 'c2', name: 'No folder yet', created: stamp, updated: stamp }
]

const globalMap: ProjectKeyMap = {
  projectId: 'global',
  scannedAt: stamp,
  keys: [
    {
      id: 'k1',
      name: 'ANTHROPIC_API_KEY',
      provider: 'anthropic',
      routes: ['api', 'cli'],
      scope: 'global',
      source: 'keychain',
      shape: 'sk-ant-…',
      length: 107,
      status: 'ready',
      addedBy: 'scan',
      updated: stamp
    },
    {
      id: 'k2',
      name: 'GITHUB_TOKEN',
      provider: 'github',
      routes: ['cli'],
      scope: 'global',
      source: 'cli-login',
      shape: 'ghp_…',
      length: 40,
      status: 'ready',
      addedBy: 'scan',
      updated: stamp
    },
    {
      id: 'k3',
      name: 'STRIPE_SECRET_KEY',
      provider: 'stripe',
      routes: ['api'],
      scope: 'global',
      source: 'env-file',
      sourcePath: '/Users/roy/dev/mm/.env',
      shape: 'sk_live_…',
      length: 107,
      status: 'expiring',
      expiresAt: soon,
      addedBy: 'scan',
      updated: stamp
    },
    {
      id: 'k4',
      name: 'OLD_UNUSED_KEY',
      provider: 'other',
      routes: [],
      scope: 'global',
      source: 'manual',
      shape: 'xx…',
      length: 12,
      status: 'unverified',
      hidden: true,
      addedBy: 'user',
      updated: stamp
    }
  ],
  needs: [],
  missing: [
    {
      name: 'OPENAI_API_KEY',
      provider: 'openai',
      routes: ['api'],
      evidence: ['src/main/backend/adapters.ts:42']
    },
    {
      name: 'RESEND_API_KEY',
      provider: 'resend',
      routes: ['api'],
      evidence: ['supabase/functions/notify/index.ts:12']
    }
  ],
  cloud: [{ host: 'supabase', target: 'mm-prod', names: ['SERVICE_ROLE_KEY', 'DB_URL'] }],
  errors: []
}

const projectMap: ProjectKeyMap = {
  ...globalMap,
  projectId: 'c1',
  repoFolder: '/Users/roy/dev/mm',
  keys: [],
  missing: []
}

const maps = [globalMap, projectMap]

Object.assign(window, {
  api: {
    mighty: { listProjects: async () => projects },
    keys: {
      scan: async () => maps[0],
      list: async () => maps,
      set: async (_p: KeySetPayload) => null,
      update: async () => null,
      remove: async () => true,
      probe: async (id: string) => ({ id, status: 'ready', detail: 'Responded 200', checkedAt: stamp }),
      copy: async () => true,
      onChanged: () => () => {}
    }
  }
})

injectTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex' }}>
      <KeysPanel variant="tab" />
    </div>
  </StrictMode>
)
