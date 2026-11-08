import { randomUUID } from 'node:crypto'
import { CONFIG } from '../../shared/config'
import type { BrowserTaskModel, BrowserTaskModelsState } from '../../shared/types'
import { callLlmProxy, OUT_OF_CREDITS, type LlmProxyRequest, type WriterResult } from '../actions/computer-use/writer'
import { BACKENDS } from '../backend/adapters'
import { EXIT_TIMEOUT, runBackend } from '../backend/runner'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { listAgentModels } from '../voice-routing/agent-models'

type Ask = Omit<LlmProxyRequest, 'model'>

const CLOUD: BrowserTaskModel = { source: 'cloud', model: '' }
// Not haiku: it took 6.3s per step against sonnet's 3.4s.
const CLAUDE_DEFAULT = 'sonnet'

function saved(): BrowserTaskModel | null {
  const [source, ...rest] = PREFS.getBrowserTaskModel().split(':')
  return source === 'cloud' || source === 'claude' ? { source, model: rest.join(':') } : null
}

function picked(): BrowserTaskModel {
  const hasClaude = BACKENDS.claude.binPath !== ''
  const choice = saved()
  if (choice?.source === 'cloud') return CLOUD
  if (choice && hasClaude) return choice
  return hasClaude && PREFS.getBackend() === 'claude' ? { source: 'claude', model: CLAUDE_DEFAULT } : CLOUD
}

export async function taskModelsState(): Promise<BrowserTaskModelsState> {
  const claude = (await listAgentModels()).filter((o) => o.harness === 'claude' && o.model !== '')
  return {
    options: [
      { ...CLOUD, label: CONFIG.BACKEND_META.mightymouse.label },
      ...claude.map((o) => ({ source: 'claude' as const, model: o.model, label: o.label }))
    ],
    selected: picked()
  }
}

export async function setTaskModel(choice: BrowserTaskModel): Promise<BrowserTaskModelsState> {
  const state = await taskModelsState()
  if (!state.options.some((o) => o.source === choice.source && o.model === choice.model)) return state
  PREFS.setBrowserTaskModel(`${choice.source}:${choice.model}`)
  return { ...state, selected: picked() }
}

export function taskModelChain(cloudModels: readonly string[]): BrowserTaskModel[] {
  const pick = picked()
  return pick.source === 'cloud' ? cloudModels.map((model) => ({ source: 'cloud', model })) : [pick]
}

export function taskModelName(pick: BrowserTaskModel): string {
  return pick.source === 'cloud' ? pick.model : `${pick.source}:${pick.model}`
}

function askClaude(model: string, req: Ask): Promise<WriterResult> {
  const started = Date.now()
  const trail = { headersMs: 0, firstTextMs: 0, serverPreMs: 0, chargedCents: 0, costUsdMicros: 0 }
  return new Promise((resolve) => {
    const fail = (reason: string): void => resolve({ ok: false, reason, ms: Date.now() - started, trail })
    runBackend({
      backend: 'claude',
      runId: `browser-task:${randomUUID()}`,
      systemPrompt: req.system,
      userPrompt: req.userPrompt,
      runDir: PATHS.TMP,
      workDir: PATHS.TMP,
      timeoutMs: req.timeoutMs,
      mode: 'ask',
      lean: true,
      disableTools: true,
      model,
      onPhase: () => {},
      onDone: (text, exitCode) => {
        if (text) resolve({ ok: true, text, ms: Date.now() - started, trail })
        else fail(exitCode === EXIT_TIMEOUT ? 'timed out' : 'Claude did not answer')
      }
    }).catch(() => fail('Claude did not answer'))
  })
}

export async function askTaskModel(pick: BrowserTaskModel, req: Ask): Promise<WriterResult> {
  if (pick.source === 'claude') return askClaude(pick.model, req)
  const res = await callLlmProxy({ ...req, model: pick.model })
  if (res.ok || res.reason !== OUT_OF_CREDITS || BACKENDS.claude.binPath === '') return res
  return { ...res, reason: `${OUT_OF_CREDITS} - pick a Claude model next to Go to keep going on your own plan` }
}
