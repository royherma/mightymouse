export const ACTION_ICON_NAMES = [
  'zap',
  'app-window',
  'volume-2',
  'moon',
  'camera',
  'mic',
  'mic-off',
  'play',
  'terminal',
  'link',
  'workflow',
  'send',
  'sparkles',
  'clipboard',
  'globe',
  'music',
  'mail',
  'calendar',
  'message-square',
  'file-text',
  'search',
  'bot',
  'plug'
] as const

export type ActionIconName = (typeof ACTION_ICON_NAMES)[number]

export function isActionIconName(value: unknown): value is ActionIconName {
  return typeof value === 'string' && (ACTION_ICON_NAMES as readonly string[]).includes(value)
}

export type ActionSafety = 'safe' | 'confirm'
export type ActionTrigger = 'voice' | 'idle' | 'phone'
export type ActionRunKind = 'builtin' | 'shortcut' | 'applescript' | 'shell' | 'url' | 'mcp'
export type ActionOutcomeKind = 'accepted' | 'overrode' | 'dismissed' | 'ignored'
export type SelectionKind = 'none' | 'text' | 'code' | 'url' | 'file'

export interface ActionSlotOption {
  value: string
  label: string
}

export interface ChoiceSlotSpec {
  kind: 'choice'
  key: string
  label: string
  ask: string
  options: readonly ActionSlotOption[]
}

export interface ScoreSlotSpec {
  kind: 'score'
  key: string
  label: string
  ask: string
  min: number
  max: number
  unit: string
}

export interface TextSlotSpec {
  kind: 'transcript' | 'selection'
  key: string
  label: string
}

export type ActionSlotSpec = ChoiceSlotSpec | ScoreSlotSpec | TextSlotSpec

export type ActionSlotValues = Record<string, string | number>

export interface ActionContextSnapshot {
  frontApp: string
  bundleId: string
  windowTitle: string
  urlHost: string
  hasSelection: boolean
  selectionText: string
  selectionKind: SelectionKind
  recentApps: string[]
  recentActionIds: string[]
}

export interface ActionRunInput {
  slots: ActionSlotValues
  transcript: string
  selection: string
  trigger: ActionTrigger
  runId?: string
}

export interface ActionRunResult {
  ok: boolean
  line: string
  detail?: string
}

export interface ActionDefinition {
  id: string
  capabilityId: string
  title: string
  when: string
  icon: ActionIconName
  appBundleId?: string
  runKind: ActionRunKind
  safety: ActionSafety
  triggers: readonly ActionTrigger[]
  slots: readonly ActionSlotSpec[]
  timeoutMs?: number
  run(input: ActionRunInput): Promise<ActionRunResult>
}

export interface Capability {
  id: string
  title: string
  blurb: string
  icon: ActionIconName
  source: 'builtin' | 'plugin'
  listActions(ctx: ActionContextSnapshot): Promise<ActionDefinition[]>
}

export interface ActionHabit {
  actionId: string
  frontApp: string
  acceptRate: number
  shown: number
}

export interface ActionChip {
  key: string
  label: string
  value: string
  options?: ActionSlotOption[]
  confidence?: number
}

export interface ActionProposal {
  proposalId: string
  actionId: string
  capabilityId: string
  title: string
  icon: ActionIconName
  chips: ActionChip[]
  percent: number
  safety: ActionSafety
  preselected: boolean
}

export interface ActionCardPayload {
  runId: string
  trigger: ActionTrigger
  proposals: ActionProposal[]
  isCommand: boolean
  latencyMs: number
  via: 'proxy' | 'direct'
}

export interface ActionRunPayload {
  runId: string
  proposalId: string
}

export interface ActionDismissPayload {
  runId: string
  proposalId: string
}

export interface ActionResultPayload {
  runId: string
  proposalId: string
  ok: boolean
  line: string
  detail?: string
}

export interface ActionStepPayload {
  runId: string
  step: number
  line: string
  pending?: boolean
  ms?: number
}

export interface CapabilityInfo {
  id: string
  title: string
  blurb: string
  icon: ActionIconName
  source: 'builtin' | 'plugin'
  enabled: boolean
  actionCount: number
  error: string
}

export interface ActionsConfig {
  enabled: boolean
  idleEnabled: boolean
  signedIn: boolean
  pluginsDir: string
  capabilities: CapabilityInfo[]
}

export interface ActionsConfigPatch {
  enabled?: boolean
  idleEnabled?: boolean
  capability?: { id: string; enabled: boolean }
}

export interface PluginActionManifest {
  id: string
  title: string
  when: string
  icon?: string
  appBundleId?: string
  confirm?: boolean
  idle?: boolean
  slots?: PluginSlotManifest[]
  run:
    | { kind: 'shortcut'; name: string; input?: string }
    | { kind: 'applescript'; script: string }
    | { kind: 'shell'; command: string }
    | { kind: 'url'; url: string; method?: 'GET' | 'POST'; body?: string }
    | {
        kind: 'mcp'
        command: string
        args?: string[]
        tool: string
        arguments?: Record<string, string>
      }
}

export type PluginSlotManifest =
  | {
      kind: 'choice'
      key: string
      label: string
      ask: string
      options: { value: string; label: string }[]
    }
  | {
      kind: 'score'
      key: string
      label: string
      ask: string
      min: number
      max: number
      unit?: string
    }
  | { kind: 'transcript' | 'selection'; key: string; label: string }

export interface PluginManifest {
  version: 1
  id: string
  title: string
  blurb?: string
  icon?: string
  author?: string
  actions: PluginActionManifest[]
}

export const COMPUTER_USE_ACTION_ID = 'computer.use'
