import './index.css'
import './mighty/desktop-comfort.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AllProjectsModal } from './mighty/AllProjectsModal'
import { ProjectSettingsModal } from './mighty/MightySessionNavigation'
import type { MightyProject } from '../../shared/types'
import { injectTheme } from './theme'

// ?state=loading | empty | loadfail | savefail | noagents | settings | fillfail  (default: full list)
const state = new URLSearchParams(location.search).get('state') ?? 'full'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const stamp = '2026-09-21T00:00:00.000Z'

let projects: MightyProject[] =
  state === 'empty'
    ? []
    : [
        {
          id: 'c1',
          name: 'MightyMouse',
          created: stamp,
          updated: stamp,
          repoFolder: '/Users/roy/Development/ShowAndTell',
          agentProjectId: 'p1'
        },
        {
          id: 'c2',
          name: 'Marketing site with a very long name that has to truncate',
          created: stamp,
          updated: stamp
        },
        { id: 'c3', name: 'Taxes 2025', created: stamp, updated: stamp, archived: true }
      ]
const sessions = [
  { id: 's1', projectId: 'c1' },
  { id: 's2', projectId: 'c1' },
  { id: 's3', projectId: 'c2' }
]
const agentSession = (id: string, project: string, cwd: string, stale: boolean): object => ({
  id,
  project,
  cwd,
  stale
})
const snapshot = {
  enabled: state !== 'noagents',
  projects: [
    { id: 'p1', name: 'ShowAndTell', state: 'active' },
    { id: 'p2', name: 'hyperframes', state: 'active' },
    { id: 'p3', name: 'old-experiment', state: 'archived' }
  ],
  sessions: [
    agentSession('a1', 'p1', '/Users/roy/Development/ShowAndTell', false),
    agentSession('a2', 'p1', '/Users/roy/Development/ShowAndTell', false),
    agentSession('b1', 'p2', '/Users/roy/Development/hyperframes', false)
  ]
}

Object.assign(window, {
  api: {
    mighty: {
      listProjects: async () => {
        await wait(state === 'loading' ? 600_000 : 150)
        if (state === 'loadfail') throw new Error('harness')
        return projects
      },
      listSessions: async () => sessions,
      upsertProject: async (p: MightyProject) => {
        await wait(400)
        if (state === 'savefail') return null
        projects = [...projects.filter((x) => x.id !== p.id), p]
        return p
      },
      deleteProject: async (id: string) => {
        projects = projects.filter((x) => x.id !== id)
        return true
      },
      pickProjectFolder: async (known?: string) => ({
        repoFolder: known ?? '/Users/roy/Development/picked-folder',
        agentProjectId: known ? 'p2' : 'p9'
      }),
      pickProjectImage: async (id: string) => {
        const p = projects.find((x) => x.id === id)
        if (!p) return null
        const next = { ...p, imagePath: '/tmp/harness-project.png', updated: stamp }
        projects = [...projects.filter((x) => x.id !== id), next]
        return next
      },
      clearProjectImage: async (id: string) => {
        const p = projects.find((x) => x.id === id)
        if (!p) return null
        const { imagePath: _, ...rest } = p
        const next = { ...rest, updated: stamp }
        projects = [...projects.filter((x) => x.id !== id), next]
        return next
      },
      getSettings: async () => ({ importedFoundProjects: true }),
      discoverProjectImages: async () => 0
    },
    infra: {
      list: async () => [
        { projectId: 'c1', record: { skip: [], services: {}, business: ['saas', 'app'] } }
      ],
      setBrief: async () => ({ projectId: 'c1', record: { skip: [], services: {} } }),
      draftBrief: async () => {
        await wait(1200)
        return state === 'fillfail'
          ? { fail: 'signed_out' }
          : { brief: { what: 'Mac and phone AI helper', audience: 'People who build with AI', niche: 'AI tools' } }
      }
    },
    getModelCatalog: async () => [],
    onModelCatalogChanged: () => () => {},
    coordinationGet: async () => snapshot,
    coordinationArchiveProject: async (id: string, archived: boolean) => {
      const hit = snapshot.projects.find((p) => p.id === id)
      if (hit) hit.state = archived ? 'archived' : 'active'
      return snapshot
    }
  }
})

injectTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {state === 'settings' || state === 'fillfail' ? (
      <ProjectSettingsModal project={projects[0]} onCancel={() => {}} onSave={() => {}} onDelete={() => {}} />
    ) : (
      <AllProjectsModal onClose={() => {}} onChanged={() => {}} />
    )}
  </StrictMode>
)
