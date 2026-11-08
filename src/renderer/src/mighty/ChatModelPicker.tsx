import { JSX, useCallback, useEffect, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import {
  ModelMenu,
  setupRowFor,
  type MenuGroup,
  type MenuItem
} from '../components/AgentModelPicker'
import { ThinkingDial } from '../../../shared/model-picker/ThinkingDial'
import { useModelCatalog } from '../components/ModelPicker'
import { MODELS } from '../SettingsApp'
import { ProviderIcon, providerIconFor } from '../components/ProviderIcon'
import { LOCAL_BACKEND, MLX_BACKEND, localModelLabel, prettyOllamaModel } from '../backend-chip'
import { CONFIG } from '../../../shared/config'
import { opencodeAccountName, opencodeModelLabel } from '../../../shared/model-label'
import { MODEL_SOURCES, showsOn, type SourceModel } from '../../../shared/model-sources'
import type { AgentModelOption, AgentSetupProgress, BackendId } from '../../../shared/types'

// Code has its own picker (components/AgentModelPicker.tsx) - a model-list change is a decision for both.

const ACCOUNTS = 'accounts'
const OPENCODE = 'opencode' satisfies BackendId
const OPENROUTER = 'openrouter' satisfies BackendId
const PLANS = ['claude', 'codex'] as const satisfies readonly BackendId[]
type Plan = (typeof PLANS)[number]
const isPlan = (b: string): b is Plan => PLANS.some((p) => p === b)

interface Prefs {
  ollamaModel: string
  mlxModel: string
  selectedModel: string
  opencodeModel: string
  openrouterModel: string
  planModels: Record<Plan, string>
  think: boolean
}

function modelOf(backend: BackendId, p: Prefs): string {
  if (backend === LOCAL_BACKEND) return p.ollamaModel
  if (backend === MLX_BACKEND) return p.mlxModel
  if (backend === 'mightymouse') return p.selectedModel
  if (backend === OPENCODE) return p.opencodeModel
  if (backend === OPENROUTER) return p.openrouterModel || p.selectedModel
  if (isPlan(backend)) return p.planModels[backend]
  return ''
}

export function ChatModelPicker({
  backend,
  onChoose
}: {
  backend: BackendId
  onChoose: (id: BackendId) => Promise<void>
}): JSX.Element {
  const catalog = useModelCatalog()
  const [prefs, setPrefs] = useState<Prefs>({
    ollamaModel: '',
    mlxModel: '',
    selectedModel: '',
    opencodeModel: '',
    openrouterModel: '',
    planModels: { claude: '', codex: '' },
    think: false
  })
  const [planOptions, setPlanOptions] = useState<AgentModelOption[]>([])
  const [local, setLocal] = useState<string[]>([])
  const [mlx, setMlx] = useState<string[]>([])
  const [sourced, setSourced] = useState<SourceModel[]>([])
  const [setup, setSetup] = useState<AgentSetupProgress | 'failed' | undefined>()

  const load = useCallback(async (): Promise<string[]> => {
    const [p, l, m, picks, src] = await Promise.all([
      window.api.settingsGetPrefs(),
      window.api.settingsListLocalModels(),
      window.api.settingsListMlxModels().catch(() => []),
      window.api.chatModelPicks().catch(() => ({ opencode: '', openrouter: '', claude: '', codex: '' })),
      window.api.chatSourceModels().catch(() => [])
    ])
    const names = l.filter((x) => x.tools).map((x) => x.name)
    setPrefs({
      ollamaModel: p.ollamaModel,
      mlxModel: p.mlxModel,
      selectedModel: p.selectedModel,
      opencodeModel: picks.opencode,
      openrouterModel: picks.openrouter,
      planModels: { claude: picks.claude, codex: picks.codex },
      think: p.thinkingEnabled
    })
    void window.api.codeAgentModels().then((r) => setPlanOptions(r.options.filter((o) => isPlan(o.harness)))).catch(() => undefined)
    setSourced(src)
    setLocal(names)
    setMlx(m.map((x) => x.name))
    return names
  }, [])

  useEffect(() => {
    void load()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    const off = window.api.onAgentSetupProgress((p) => p.harness === 'ollama' && setSetup(p))
    return () => {
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [load])

  const pick = async (id: string): Promise<void> => {
    const [b, ...rest] = id.split(':')
    const next = b as BackendId
    const model = rest.join(':')
    if (next === LOCAL_BACKEND) await window.api.settingsSetOllamaModel(model)
    if (next === MLX_BACKEND) await window.api.settingsSetMlxModel(model)
    if (next === 'mightymouse') await window.api.panelSetSelectedModel(model)
    if (next === OPENCODE || next === OPENROUTER || isPlan(next)) await window.api.chatSetModelPick(next, model)
    setPrefs((p) => ({
      ...p,
      ollamaModel: next === LOCAL_BACKEND ? model : p.ollamaModel,
      mlxModel: next === MLX_BACKEND ? model : p.mlxModel,
      selectedModel: next === 'mightymouse' ? model : p.selectedModel,
      opencodeModel: next === OPENCODE ? model : p.opencodeModel,
      openrouterModel: next === OPENROUTER ? model : p.openrouterModel,
      planModels: isPlan(next) ? { ...p.planModels, [next]: model } : p.planModels
    }))
    await onChoose(next)
  }

  const setUpLocal = (): void => {
    setSetup({
      harness: 'ollama',
      message: CONFIG.CODE_PROVIDER_SETUP_COPY.starting,
      percent: null
    })
    void window.api.codeSetUpAgentProvider('ollama').then(async (res) => {
      const names = await load()
      setSetup(res.ok ? undefined : 'failed')
      if (res.ok && names[0]) await pick(`${LOCAL_BACKEND}:${names[0]}`)
    })
  }

  const setThink = (on: boolean): void => {
    setPrefs((p) => ({ ...p, think: on }))
    void window.api.settingsSetThinkingEnabled(on).then((think) => setPrefs((p) => ({ ...p, think })))
  }

  const L = CONFIG.UI_LABELS
  const mm = CONFIG.BACKEND_META.mightymouse?.label ?? 'MightyMouse'
  const groups: MenuGroup[] = [
    { key: 'mightymouse', name: mm, icon: 'mightymouse' },
    ...PLANS.filter((h) => planOptions.some((o) => o.harness === h)).map((h) => ({
      key: `plan:${h}`,
      name: L.MODEL_PICK_PLAN_GROUP.replace('{name}', CONFIG.BACKEND_META[h]?.label ?? h),
      icon: h
    })),
    { key: ACCOUNTS, name: 'Your subscriptions' },
    ...(showsOn('ollama', 'chat') ? [{ key: LOCAL_BACKEND, name: MODEL_SOURCES.ollama.name, icon: MODEL_SOURCES.ollama.icon }] : []),
    { key: MLX_BACKEND, name: 'Rapid-MLX', icon: 'mlx' },
    { key: OPENROUTER, name: MODEL_SOURCES.openrouter.name, icon: MODEL_SOURCES.openrouter.icon },
    { key: OPENCODE, name: MODEL_SOURCES.opencode.name, icon: MODEL_SOURCES.opencode.icon }
  ]
  const hasOpencode = sourced.some((s) => s.source === OPENCODE)
  const accounts = MODELS.filter(
    (m) =>
      m.value !== 'mightymouse' &&
      m.value !== LOCAL_BACKEND &&
      m.value !== MLX_BACKEND &&
      m.value !== OPENROUTER &&
      !planOptions.some((o) => o.harness === m.value) &&
      (m.value !== OPENCODE || !hasOpencode)
  )
  const items: MenuItem[] = [
    { id: 'mightymouse:', group: 'mightymouse', label: 'Auto', sub: L.MODEL_PICK_AUTO_SUB, hero: true, icon: 'mightymouse' },
    ...catalog.map((c) => ({
      id: `mightymouse:${c.id}`,
      group: 'mightymouse',
      label: c.label,
      icon: providerIconFor(c.id),
      hint: CONFIG.MODEL_TIER_LABEL[c.tier],
      tier: c.tier
    })),
    ...planOptions.map((o) => ({
      id: `${o.harness}:${o.model}`,
      group: `plan:${o.harness}`,
      label: o.label,
      icon: o.harness === 'codex' ? ('codex' as const) : ('claude' as const),
      sub: o.model === '' ? L.MODEL_PICK_CLI_DEFAULT : undefined
    })),
    ...accounts.map((m) => ({ id: `${m.value}:`, group: ACCOUNTS, label: m.label, icon: m.icon })),
    ...(showsOn('ollama', 'chat') ? local : []).map((n) => ({
      id: `${LOCAL_BACKEND}:${n}`,
      group: LOCAL_BACKEND,
      label: prettyOllamaModel(n),
      icon: MODEL_SOURCES.ollama.icon
    })),
    ...mlx.map((n) => ({ id: `${MLX_BACKEND}:${n}`, group: MLX_BACKEND, label: n })),
    ...sourced.map((s) => ({
      id: `${s.source}:${s.model}`,
      group: s.source,
      label: s.label,
      hint: s.source === OPENCODE ? undefined : s.hint,
      section: s.source === OPENCODE ? opencodeAccountName(s.model) : undefined,
      thinks: s.thinks,
      icon: providerIconFor(s.model)
    }))
  ]
  const catalogLabel = catalog.find((c) => c.id === prefs.selectedModel)?.label ?? ''
  const tag =
    backend === 'mightymouse'
      ? catalogLabel
      : backend === OPENROUTER
        ? modelOf(backend, prefs)
        : backend === OPENCODE
          ? opencodeModelLabel(prefs.opencodeModel)
          : isPlan(backend)
            ? prefs.planModels[backend] && (planOptions.find((o) => o.harness === backend && o.model === prefs.planModels[backend])?.label ?? '')
            : localModelLabel(backend, prefs.ollamaModel, prefs.mlxModel)

  const thinks =
    backend === OPENROUTER &&
    sourced.some((s) => s.source === OPENROUTER && s.model === modelOf(backend, prefs) && s.thinks)
  const pickedName =
    backend === 'mightymouse'
      ? catalogLabel
      : backend === OPENROUTER
        ? sourced.find((s) => s.source === OPENROUTER && s.model === modelOf(backend, prefs))?.label ?? tag
        : ''
  const side = thinks ? (
    <ThinkingDial
      levels={[
        { id: 'fast', label: 'Fast', hint: 'Answers right away' },
        { id: 'think', label: 'Think', hint: 'Thinks before answering' }
      ]}
      value={prefs.think ? 'think' : 'fast'}
      onChange={(id) => setThink(id === 'think')}
      label={L.CODE_DRAFT_THINKING}
    >
      <span className="mm-dial-for">
        <span className="mm-pick-logo"><ProviderIcon id={providerIconFor(modelOf(backend, prefs))} size={13} /></span>
        {pickedName}
      </span>
      <p>{L.MODEL_PICK_THINK_NOTE}</p>
    </ThinkingDial>
  ) : undefined
  const footer = !thinks && pickedName ? (
    <div className="mm-pick-note">
      <Brain size={14} strokeWidth={2} />
      {L.MODEL_PICK_NO_THINKING.replace('{name}', pickedName)}
    </div>
  ) : undefined

  return (
    <>
      <ModelMenu
        groups={groups}
        items={items}
        selectedId={`${backend}:${modelOf(backend, prefs)}`}
        onPick={(id) => void pick(id)}
        setupRows={local.length === 0 ? [setupRowFor('ollama', setup, setUpLocal)] : []}
        wide
        footer={footer}
        side={side}
        title={CONFIG.BACKEND_META[backend]?.tip ?? ''}
        triggerClassName="inline-flex w-fit max-w-[14rem] items-center gap-1.5 rounded-lg border border-surface3 bg-surface2 px-2 py-1 text-left text-xs font-medium text-on-surface hover:bg-surface1"
        trigger={
          <>
            <ProviderIcon
              id={MODELS.find((m) => m.value === backend)?.icon ?? 'mightymouse'}
              size={13}
            />
            <span className="min-w-0 truncate">
              {CONFIG.BACKEND_META[backend]?.label ?? backend}
              {tag && <span className="text-muted"> · {tag}</span>}
              {thinks && prefs.think && <span className="text-muted"> · <Brain size={11} strokeWidth={2.25} className="inline align-[-1px]" /> Think</span>}
            </span>
            <ChevronDown size={12} className="shrink-0 text-muted" strokeWidth={2.5} />
          </>
        }
      />
    </>
  )
}
