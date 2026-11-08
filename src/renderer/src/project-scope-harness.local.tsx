import './index.css'
import './components/AgentProjects.css'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectScopePicker } from './components/ProjectScopePicker'
import { BranchPicker } from './components/BranchPicker'
import { AgentSettingsChip, useAgentModels } from './components/AgentModelPicker'
import { CLAUDE_REASONING_EFFORTS } from '../../shared/model-sources'
import { chatProjectSaveHint } from './project-scope-hint'
import type { AgentModelOption, MightyProject } from '../../shared/types'
import { injectTheme } from './theme'

const stamp = '2026-09-22T00:00:00.000Z'
const projects: MightyProject[] = [
  { id: 'p1', name: 'ShowAndTell', created: stamp, updated: stamp, icon: 'terminal' },
  { id: 'p2', name: 'Marketing', created: stamp, updated: stamp, icon: 'globe' }
]

const options: AgentModelOption[] = [
  { harness: 'codex', model: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { harness: 'codex', model: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
  { harness: 'claude', model: 'opus', label: 'Opus', reasoningEfforts: CLAUDE_REASONING_EFFORTS },
  { harness: 'claude', model: 'haiku', label: 'Haiku', reasoningEfforts: [] },
  { harness: 'codex', model: '', label: 'Default' },
  { harness: 'opencode', model: 'opencode/deepseek-v4-flash-vision-exp', label: 'deepseek-v4-flash-vision-exp' },
  { harness: 'opencode', model: 'openrouter/~deepseek/deepseek-v4-flash-latest-preview', label: '~deepseek/deepseek-v4-flash-latest-preview' }
]

function ModelHarness(): React.ReactElement {
  const models = useAgentModels()
  const [agents, setAgents] = useState(1)
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-surface0 p-8">
      <div className="flex w-full max-w-xl flex-col gap-4 rounded-xl border border-surface3 bg-surface1 p-4">
        <p className="text-sm text-muted">Code model and reasoning controls</p>
        <div className="flex flex-wrap items-center gap-2">
          <ProjectScopePicker projects={projects} valueId="p1" onChange={() => {}} />
          <BranchPicker cwd="/repo" />
          <AgentSettingsChip models={models} agents={{ count: agents, max: 6, onChange: setAgents, onOpenSideBySide: () => {} }} />
        </div>
        <p className="text-xs text-muted">Selected reasoning: {models.effort} · agents: {agents}</p>
      </div>
    </div>
  )
}

let harnessOwnCopy = new URLSearchParams(location.search).has('copy')
const modelPreview = new URLSearchParams(location.search).has('models')
if (new URLSearchParams(location.search).has('open'))
  setTimeout(() => document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click(), 300)
if (modelPreview) Object.assign(window, { api: {
  codeAgentModels: async () => ({ options, selected: { harness: 'codex', model: 'gpt-6.1-sol' }, needsSetup: [] }),
  codeSetAgentModel: async () => true,
  planLoginsList: async () => [
    { id: 'claude-default', backend: 'claude', email: 'dev@example.com', plan: 'max', dir: null, windows: [], checkedAt: null, limitedUntil: null },
    { id: 'claude-2', backend: 'claude', email: 'dev2@example.com', plan: 'pro', dir: '/x', windows: [], checkedAt: null, limitedUntil: Date.now() + 3600_000 },
    { id: 'codex-default', backend: 'codex', email: 'dev@example.com', plan: 'plus', dir: null, windows: [], checkedAt: null, limitedUntil: null }
  ],
  planLoginPicks: async () => ({ claude: 'claude-default', codex: 'codex-default' }),
  planLoginSetPick: async (b: string, id: string) => ({ claude: 'claude-default', codex: 'codex-default', [b]: id }),
  onAgentSetupProgress: () => () => undefined,
  settingsGet: async () => ({ codeOwnCopy: harnessOwnCopy }),
  settingsSave: async (p: { codeOwnCopy: boolean }) => ({ codeOwnCopy: (harnessOwnCopy = p.codeOwnCopy) }),
  repoGitState: async () => ({ branch: 'dev', dirty: Number(new URLSearchParams(location.search).get('dirty') ?? 3), head: { sha: 'abc1234def', subject: '' } })
} })

export function ScopeHarness(): React.ReactElement {
  const params = new URLSearchParams(location.search)
  const initial = params.get('project') ?? undefined
  const [valueId, setValueId] = useState<string | undefined>(initial)
  const name = projects.find((p) => p.id === valueId)?.name
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-surface0 p-8">
      <div className="chat-measure flex w-full max-w-xl flex-col gap-3 rounded-xl border border-surface3 bg-surface1 p-4">
        <p className="text-sm text-muted">{chatProjectSaveHint(name)}</p>
        <ProjectScopePicker
          projects={projects}
          valueId={valueId}
          onChange={setValueId}
          onNewProject={() => {}}
          onEditProject={() => {}}
        />
      </div>
    </div>
  )
}

injectTheme()
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    {modelPreview ? <ModelHarness /> : <ScopeHarness />}
  </StrictMode>
)
