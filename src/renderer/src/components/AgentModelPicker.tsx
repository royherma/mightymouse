import { JSX, useEffect, useState } from 'react'
import { Brain, Check, ChevronDown, Columns3, Minus, Plus, SlidersHorizontal } from 'lucide-react'
import { Button } from './Button'
import { Switch } from './Switch'
import { ProviderIcon, type ProviderIconId } from './ProviderIcon'
import { CONFIG } from '../../../shared/config'
import type { AgentModelChoice, AgentModelOption, AgentSetupProgress } from '../../../shared/types'
import { opencodeAccountName } from '../../../shared/model-label'
import {
  PLAN_BACKENDS,
  isPlanLoginOpen,
  planTierLabel,
  type PlanBackend,
  type PlanLogin,
  type PlanLoginPicks
} from '../../../shared/plan-logins'
import { MODEL_SOURCES, PLAN_ARGS, isReasoningEffort, type ReasoningEffort } from '../../../shared/model-sources'
import { ThinkingDial, type DialLevel } from '../../../shared/model-picker/ThinkingDial'
import {
  MenuList,
  ModelMenu as SharedModelMenu,
  PickerIcon,
  PickerPop,
  SIDE_W,
  usePopover,
  WIDE_MENU_MAX_H,
  WIDE_MENU_W,
  type MenuGroup,
  type MenuItem,
  type MenuSetupRow,
  type ModelMenuProps
} from '../../../shared/model-picker/ModelMenu'

export { WIDE_MENU_MAX_H, WIDE_MENU_W, type MenuGroup, type MenuItem, type MenuSetupRow }

export function ModelMenu(props: ModelMenuProps): JSX.Element {
  return (
    <PickerIcon.Provider value={ProviderIcon}>
      <SharedModelMenu {...props} />
    </PickerIcon.Provider>
  )
}

// Chat has its own picker (mighty/ChatModelPicker.tsx) - a model-list change is a decision for both.

type Harness = AgentModelChoice['harness']

export const HARNESS_NAME: Record<Harness, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  ollama: 'Local (Ollama)'
}

const harnessIcon = (h: Harness): ProviderIconId => (h === 'ollama' || h === 'cursor' ? MODEL_SOURCES[h].icon : h)

const CODE_THINK_KEY = 'mm.code.think'
const CODE_EFFORT_KEY = 'mm.code.efforts'
const CODE_PLAN_KEY = 'mm.code.plan'
type ReasoningChoice = ReasoningEffort | 'default'

function readCodeThink(): boolean | undefined {
  try {
    const saved = localStorage.getItem(CODE_THINK_KEY)
    return saved === null ? undefined : saved !== '0'
  } catch {
    return undefined
  }
}

function readCodePlan(): boolean {
  try {
    return localStorage.getItem(CODE_PLAN_KEY) === '1'
  } catch {
    return false
  }
}

function readCodeEfforts(): Record<string, ReasoningChoice> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CODE_EFFORT_KEY) ?? '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(Object.entries(saved).filter(([, effort]) => effort === 'default' || isReasoningEffort(effort)))
  } catch {
    return {}
  }
}

const EFFORT_LABELS: Record<ReasoningChoice, { label: string; hint: string }> = {
  default: { label: 'Default', hint: 'Your CLI setting' },
  none: { label: 'None', hint: 'Quickest replies' },
  minimal: { label: 'Minimal', hint: 'Less thinking' },
  low: { label: 'Low', hint: 'Quick tasks' },
  medium: { label: 'Medium', hint: 'Everyday work' },
  high: { label: 'High', hint: 'Hard problems' },
  xhigh: { label: 'Extra high', hint: 'Deeper reasoning' },
  max: { label: 'Max', hint: 'Hardest problems' },
  ultra: { label: 'Ultra', hint: 'With delegation' }
}

export function ReasoningChip({ value, choices, onChange }: {
  value: ReasoningChoice
  choices: ReasoningEffort[]
  onChange: (choice: ReasoningChoice) => void
}): JSX.Element {
  const levels: ReasoningChoice[] = ['default', ...choices]
  return (
    <ModelMenu
      groups={[{ key: 'reasoning', name: 'Reasoning' }]}
      items={levels.map((level) => ({ id: level, group: 'reasoning', ...EFFORT_LABELS[level] }))}
      selectedId={value}
      onPick={(level) => { if (level === 'default' || isReasoningEffort(level)) onChange(level) }}
      ariaLabel="Reasoning level"
      searchable={false}
      title="Choose how much the agent thinks. Higher levels can take longer and use more tokens."
      triggerClassName="inline-flex w-fit items-center gap-1 rounded-lg border border-surface3 bg-surface2 px-2 py-1 text-xs font-medium text-on-surface hover:bg-surface1"
      trigger={<>
        <Brain size={12} strokeWidth={2.25} className="shrink-0 text-muted" />
        <span className="agent-chip-label">{EFFORT_LABELS[value].label}</span>
        <ChevronDown size={12} className="shrink-0 text-muted" strokeWidth={2.5} />
      </>}
    />
  )
}

export function useAgentModels(): {
  options: AgentModelOption[]
  selected: AgentModelChoice | null
  choose: (choice: AgentModelChoice) => void
  needsSetup: Harness[]
  setup: Partial<Record<Harness, AgentSetupProgress | 'failed'>>
  setUp: (harness: Harness) => void
  effort: ReasoningChoice
  efforts: ReasoningEffort[]
  setEffort: (choice: ReasoningChoice) => void
  canPlan: boolean
  plan: boolean
  setPlan: (on: boolean) => void
} {
  const [planOn, setPlanOn] = useState(readCodePlan)
  const [savedEfforts, setSavedEfforts] = useState(readCodeEfforts)
  const [legacyThink] = useState(readCodeThink)
  const [options, setOptions] = useState<AgentModelOption[]>([])
  const [selected, setSelected] = useState<AgentModelChoice | null>(null)
  const [needsSetup, setNeedsSetup] = useState<Harness[]>([])
  const [setup, setSetup] = useState<Partial<Record<Harness, AgentSetupProgress | 'failed'>>>({})
  const efforts = options.find((o) => o.harness === selected?.harness && o.model === selected.model)?.reasoningEfforts ?? []
  const key = selected ? `${selected.harness}:${selected.model}` : ''
  const saved = savedEfforts[key] ?? (legacyThink === undefined ? 'default' : legacyThink ? 'high' : 'low')
  const effort = saved !== 'default' && efforts.includes(saved) ? saved : 'default'
  const canPlan = selected !== null && PLAN_ARGS[selected.harness === 'ollama' ? 'claude' : selected.harness] !== undefined
  const plan = canPlan && planOn
  const setPlan = (on: boolean): void => {
    setPlanOn(on)
    try {
      localStorage.setItem(CODE_PLAN_KEY, on ? '1' : '0')
    } catch {
      return
    }
  }
  const setEffort = (choice: ReasoningChoice): void => {
    if (!selected || (choice !== 'default' && !efforts.includes(choice))) return
    const next = { ...savedEfforts, [key]: choice }
    setSavedEfforts(next)
    try {
      localStorage.setItem(CODE_EFFORT_KEY, JSON.stringify(next))
    } catch {
      return
    }
  }
  const load = (): Promise<void> =>
    window.api.codeAgentModels().then((r) => {
      setOptions(r.options)
      setSelected(r.selected)
      setNeedsSetup(r.needsSetup)
    })
  useEffect(() => {
    void load()
    return window.api.onAgentSetupProgress((p) => setSetup((s) => ({ ...s, [p.harness]: p })))
  }, [])
  const choose = (choice: AgentModelChoice): void => {
    setSelected(choice)
    void window.api.codeSetAgentModel(choice)
  }
  const setUp = (harness: Harness): void => {
    setSetup((s) => ({ ...s, [harness]: { harness, message: CONFIG.CODE_PROVIDER_SETUP_COPY.starting, percent: null } }))
    void window.api.codeSetUpAgentProvider(harness).then(async (res) => {
      await load()
      setSetup((s) => {
        const next = { ...s }
        if (res.ok) delete next[harness]
        else next[harness] = 'failed'
        return next
      })
    })
  }
  return { options, selected, choose, needsSetup, setup, setUp, effort, efforts, setEffort, canPlan, plan, setPlan }
}

export function triggerLabel(options: AgentModelOption[], value: AgentModelChoice): string {
  if (value.model === '') return HARNESS_NAME[value.harness]
  return (
    options.find((o) => o.harness === value.harness && o.model === value.model)?.label ??
    value.model
  )
}


export function setupRowFor(
  harness: Harness,
  state: AgentSetupProgress | 'failed' | undefined,
  onSetUp: (harness: Harness) => void
): MenuSetupRow {
  const copy = CONFIG.CODE_PROVIDER_SETUP_COPY
  const sub =
    state === 'failed'
      ? copy.failed
      : state
        ? `${state.message}${state.percent !== null ? ` ${state.percent}%` : ''}…`
        : copy[harness]
  return {
    key: harness,
    name: HARNESS_NAME[harness],
    icon: harnessIcon(harness),
    sub,
    busy: state !== undefined && state !== 'failed',
    onClick: () => onSetUp(harness)
  }
}

type PlanAccounts = {
  logins: PlanLogin[]
  picks: PlanLoginPicks | null
  adding: PlanBackend | null
  error: string
  choose: (backend: PlanBackend, id: string) => void
  add: (backend: PlanBackend) => void
}

function usePlanAccounts(): PlanAccounts {
  const [logins, setLogins] = useState<PlanLogin[]>([])
  const [picks, setPicks] = useState<PlanLoginPicks | null>(null)
  const [adding, setAdding] = useState<PlanBackend | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void Promise.all([window.api.planLoginsList(), window.api.planLoginPicks()]).then(([l, p]) => {
      if (!live) return
      setLogins(l)
      setPicks(p)
    })
    return () => { live = false }
  }, [])
  const choose = (backend: PlanBackend, id: string): void => {
    setPicks((p) => (p ? { ...p, [backend]: id } : p))
    void window.api.planLoginSetPick(backend, id).then(setPicks)
  }
  const add = (backend: PlanBackend): void => {
    setAdding(backend)
    setError('')
    const before = new Set(logins.map((l) => l.id))
    void window.api.planLoginsAdd(backend).then((r) => {
      setAdding(null)
      setLogins(r.logins)
      setError(r.error ?? '')
      const added = r.logins.find((l) => l.backend === backend && !before.has(l.id) && l.email !== '')
      if (added) choose(backend, added.id)
    })
  }
  return { logins, picks, adding, error, choose, add }
}

const isPlanHarness = (h: Harness): h is PlanBackend => (PLAN_BACKENDS as readonly string[]).includes(h)

function AccountSwitch({ backend, accounts }: { backend: PlanBackend; accounts: PlanAccounts }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [now] = useState(() => Date.now())
  const L = CONFIG.UI_LABELS
  const mine = accounts.logins.filter((l) => l.backend === backend && l.email !== '')
  const current = mine.find((l) => l.id === accounts.picks?.[backend]) ?? mine[0]
  if (!current) return null
  return (
    <>
      <Button
        variant="bare"
        className="mm-pick-acct"
        aria-expanded={open}
        title={L.MODEL_PICK_ACCOUNT_TITLE}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current.email}</span>
        <ChevronDown size={10} strokeWidth={2.5} className="shrink-0 text-muted" />
      </Button>
      {open && (
        <div className="mm-pick-accts" role="listbox" aria-label={L.MODEL_PICK_ACCOUNT_TITLE}>
          {mine.map((l) => {
            const on = l.id === current.id
            const out = !isPlanLoginOpen(l, now)
            return (
              <Button
                variant="bare"
                key={l.id}
                role="option"
                aria-selected={on}
                className="mm-pick-row"
                onClick={() => {
                  accounts.choose(backend, l.id)
                  setOpen(false)
                }}
              >
                <span className="mm-pick-name">
                  <span className="mm-pick-label">{l.email}</span>
                  <small className={out ? 'is-out' : undefined}>{out ? L.MODEL_PICK_ACCOUNT_USED_UP : planTierLabel(l.plan) || HARNESS_NAME[backend]}</small>
                </span>
                {on && <span className="mm-pick-check"><Check size={10} strokeWidth={3.5} /></span>}
              </Button>
            )
          })}
          {accounts.adding === backend ? (
            <div className="mm-pick-accts-note">
              {L.MODEL_PICK_ACCOUNT_SIGNING_IN}{' '}
              <Button variant="bare" className="agent-settings-link" onClick={() => void window.api.planLoginsCancel()}>
                {L.MODEL_PICK_ACCOUNT_CANCEL}
              </Button>
            </div>
          ) : (
            <Button variant="bare" className="mm-pick-row" disabled={accounts.adding !== null} onClick={() => accounts.add(backend)}>
              <span className="mm-pick-logo"><Plus size={13} strokeWidth={2} /></span>
              <span className="mm-pick-name"><span className="mm-pick-label">{L.MODEL_PICK_ACCOUNT_ADD}</span></span>
            </Button>
          )}
          {accounts.error && <div className="mm-pick-accts-note">{accounts.error}</div>}
        </div>
      )}
    </>
  )
}

const optionId = (o: AgentModelChoice): string => `${o.harness}:${o.model}`

function modelMenuParts(
  options: AgentModelOption[],
  onChange: (choice: AgentModelChoice) => void,
  accounts?: PlanAccounts
): { groups: MenuGroup[]; items: MenuItem[]; pick: (id: string) => void } {
  const harnesses = [...new Set(options.map((o) => o.harness))]
  return {
    groups: harnesses.map((h) => ({
      key: h,
      name: HARNESS_NAME[h],
      icon: harnessIcon(h),
      accessory: accounts && isPlanHarness(h) ? <AccountSwitch backend={h} accounts={accounts} /> : undefined
    })),
    items: options.map((o) => ({
      id: optionId(o),
      group: o.harness,
      label: o.label,
      icon: harnessIcon(o.harness),
      sub: o.model === '' ? CONFIG.UI_LABELS.MODEL_PICK_CLI_DEFAULT : undefined,
      thinks: (o.reasoningEfforts?.length ?? 0) > 0,
      section: o.harness === 'opencode' ? opencodeAccountName(o.model) : undefined
    })),
    pick: (id) => {
      const o = options.find((x) => optionId(x) === id)
      if (o) onChange({ harness: o.harness, model: o.model })
    }
  }
}

export function AgentModelPicker({
  options,
  value,
  onChange,
  needsSetup = [],
  setup = {},
  onSetUp
}: {
  options: AgentModelOption[]
  value: AgentModelChoice | null
  onChange: (choice: AgentModelChoice) => void
  needsSetup?: Harness[]
  setup?: Partial<Record<Harness, AgentSetupProgress | 'failed'>>
  onSetUp?: (harness: Harness) => void
}): JSX.Element | null {
  if (options.length === 0 && (needsSetup.length === 0 || !onSetUp)) return null
  const { groups, items, pick } = modelMenuParts(options, onChange)
  return (
    <ModelMenu
      groups={groups}
      items={items}
      selectedId={value ? optionId(value) : null}
      onPick={pick}
      setupRows={onSetUp ? needsSetup.map((h) => setupRowFor(h, setup[h], onSetUp)) : []}
      title="Model the new agent runs on"
      triggerClassName="inline-flex w-fit max-w-[13rem] items-center gap-1.5 rounded-lg border border-surface3 bg-surface2 px-2 py-1 text-left text-xs font-medium text-on-surface hover:bg-surface1"
      trigger={
        <>
          {value && <ProviderIcon id={harnessIcon(value.harness)} size={13} />}
          <span className="agent-chip-label min-w-0 truncate">{value ? triggerLabel(options, value) : 'Set up a model'}</span>
          <ChevronDown size={12} className="shrink-0 text-muted" strokeWidth={2.5} />
        </>
      }
    />
  )
}

const effortLevels = (efforts: ReasoningEffort[]): DialLevel[] =>
  (['default', ...efforts] as ReasoningChoice[]).map((id) => ({
    id,
    ...EFFORT_LABELS[id],
    short: id === 'xhigh' ? 'X-high' : undefined
  }))

export function EffortBars({ filled, of }: { filled: number; of: number }): JSX.Element {
  return (
    <span className="mm-effort-bars" aria-hidden>
      {Array.from({ length: of }, (_, i) => <i key={i} data-on={i < filled || undefined} style={{ height: 4 + i * 2 }} />)}
    </span>
  )
}

export function AgentSettingsChip({
  models,
  agents
}: {
  models: ReturnType<typeof useAgentModels>
  agents?: { count: number; max: number; onChange: (n: number) => void; onOpenSideBySide?: (n: number) => void }
}): JSX.Element {
  const { options, selected, choose, needsSetup, setup, setUp, effort, efforts, setEffort, canPlan, plan, setPlan } = models
  const hasDial = selected !== null && efforts.length > 0
  const { open, setOpen, btnRef, menuRef, pos } = usePopover(WIDE_MENU_W + (hasDial ? SIDE_W : 0), WIDE_MENU_MAX_H, 'left', `${options.length}:${efforts.length}:${selected?.model}`)
  const accounts = usePlanAccounts()
  const { groups, items, pick } = modelMenuParts(options, choose, accounts)
  const setupRows = needsSetup.map((h) => setupRowFor(h, setup[h], setUp))
  const hasModels = items.length > 0 || setupRows.length > 0
  const L = CONFIG.UI_LABELS
  const label = selected ? triggerLabel(options, selected) : hasModels ? 'Set up a model' : L.CODE_DRAFT_AGENTS
  const agentCount = agents && agents.count > 1 ? L.CODE_DRAFT_AGENTS_COUNT.replace('{n}', String(agents.count)) : ''

  return (
    <PickerIcon.Provider value={ProviderIcon}>
      <Button
        variant="bare"
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={L.CODE_DRAFT_SETTINGS_TITLE}
        className="agent-settings-chip inline-flex w-fit max-w-[18rem] items-center gap-1.5 rounded-lg border border-surface3 bg-surface2 px-2 py-1 text-left text-xs font-medium text-on-surface hover:bg-surface1"
        data-open={open ? '' : undefined}
      >
        {selected ? <ProviderIcon id={harnessIcon(selected.harness)} size={13} /> : <SlidersHorizontal size={12} strokeWidth={2.25} className="shrink-0 text-muted" />}
        <span className="agent-chip-label inline-flex min-w-0 items-center gap-1 truncate">
          <span className="truncate">{label}</span>
          {effort !== 'default' && (
            <>
              <span className="text-muted">·</span>
              <EffortBars filled={efforts.indexOf(effort) + 1} of={efforts.length} />
              <span>{EFFORT_LABELS[effort].label}</span>
            </>
          )}
          {plan && <span className="text-muted"> · {L.CODE_DRAFT_PLAN}</span>}
          {agentCount && <span className="text-muted"> · {agentCount}</span>}
        </span>
        <ChevronDown size={12} className="agent-settings-caret shrink-0 text-muted" strokeWidth={2.5} />
      </Button>
      {open && (
        <PickerPop
          menuRef={menuRef}
          pos={pos}
          role="dialog"
          ariaLabel={L.CODE_DRAFT_SETTINGS_TITLE}
          side={hasDial && selected && (
              <ThinkingDial
                levels={effortLevels(efforts)}
                value={effort}
                onChange={(id) => { if (id === 'default' || isReasoningEffort(id)) setEffort(id) }}
                label={L.CODE_DRAFT_THINKING}
              >
                <span className="mm-dial-for">
                  <span className="mm-pick-logo"><ProviderIcon id={harnessIcon(selected.harness)} size={13} /></span>
                  {label}
                </span>
                <p>{L.CODE_DRAFT_THINKING_NOTE}</p>
              </ThinkingDial>
          )}
        >
          {hasModels && (
            <div role="listbox" aria-label="Model" className="flex min-h-0 flex-1 flex-col pt-1">
              <MenuList
                groups={groups}
                items={items}
                selectedId={selected ? optionId(selected) : null}
                onPick={pick}
                setupRows={setupRows}
                searchable={items.length > 8}
              />
            </div>
          )}
          <div className="mm-pick-foot">
            {canPlan && (
              <label className="mm-pick-agents">
                <span>{L.CODE_DRAFT_PLAN_FIRST}</span>
                <Switch on={plan} onChange={setPlan} label={L.CODE_DRAFT_PLAN_FIRST} />
              </label>
            )}
            {selected && selected.model !== '' && efforts.length === 0 && (
              <div className="mm-pick-note">
                <Brain size={14} strokeWidth={2} />
                {L.MODEL_PICK_NO_THINKING.replace('{name}', label)}
              </div>
            )}
            {agents && (
              <div className="mm-pick-agents">
                {agents.onOpenSideBySide ? (
                  <Button
                    variant="bare"
                    className="agent-settings-link"
                    onClick={() => {
                      setOpen(() => false)
                      agents.onOpenSideBySide?.(agents.count)
                    }}
                  >
                    <Columns3 size={13} strokeWidth={1.75} />
                    {L.CODE_DRAFT_AGENTS_OPEN}
                  </Button>
                ) : <span>{L.CODE_DRAFT_AGENTS}</span>}
                <span className="agent-draft-stepper">
                  <Button
                    variant="bare"
                    onClick={() => agents.onChange(Math.max(1, agents.count - 1))}
                    disabled={agents.count <= 1}
                    aria-label={L.CODE_DRAFT_AGENTS_FEWER}
                  >
                    <Minus size={11} strokeWidth={2} />
                  </Button>
                  <b>{agents.count}</b>
                  <Button
                    variant="bare"
                    onClick={() => agents.onChange(Math.min(agents.max, agents.count + 1))}
                    disabled={agents.count >= agents.max}
                    aria-label={L.CODE_DRAFT_AGENTS_MORE}
                  >
                    <Plus size={11} strokeWidth={2} />
                  </Button>
                </span>
              </div>
            )}
          </div>
        </PickerPop>
      )}
    </PickerIcon.Provider>
  )
}
