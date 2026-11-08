import { ACTION_PREFS } from '../store/action-prefs'
import { systemCapability } from './capabilities/system'
import { shortcutsCapability } from './capabilities/shortcuts'
import { uiCapability } from './capabilities/ui'
import { inputCapability } from './capabilities/input'
import { computerUseCapability } from './computer-use/loop'
import { loadPluginCapabilities, pluginLoadErrors } from './plugin-loader'
import type {
  ActionContextSnapshot,
  ActionDefinition,
  ActionTrigger,
  Capability,
  CapabilityInfo
} from '../../shared/action-engine'

const CAPABILITY_TIMEOUT_MS = 1_500

export const CAPABILITIES: readonly Capability[] = [
  systemCapability,
  shortcutsCapability,
  uiCapability,
  inputCapability,
  computerUseCapability
]

function allCapabilities(): Capability[] {
  return [...CAPABILITIES, ...loadPluginCapabilities()]
}

async function listWithBudget(
  capability: Capability,
  ctx: ActionContextSnapshot
): Promise<{ actions: ActionDefinition[]; error: string }> {
  const timeout = new Promise<ActionDefinition[]>((_, reject) => {
    setTimeout(() => reject(new Error('timed out')), CAPABILITY_TIMEOUT_MS)
  })
  try {
    const actions = await Promise.race([capability.listActions(ctx), timeout])
    return { actions, error: '' }
  } catch (err) {
    const error = (err as Error).message
    // A dropped capability is an action the user asked for that never got
    // offered, and it reads as the feature being broken. Name it.
    console.log(`[actions] capability ${capability.id} dropped: ${error}`)
    return { actions: [], error }
  }
}

export async function listAllActions(
  ctx: ActionContextSnapshot,
  trigger: ActionTrigger
): Promise<ActionDefinition[]> {
  const capabilities = allCapabilities().filter((c) => ACTION_PREFS.isCapabilityEnabled(c.id))
  const started = Date.now()
  const results = await Promise.all(
    capabilities.map((c) => listWithBudget(c, ctx).then((r) => ({ ...r, ms: Date.now() - started })))
  )
  console.log(`[actions] list ${results.map((r, i) => `${capabilities[i].id}=${r.ms}ms`).join(' ')}`)

  const seen = new Set<string>()
  const out: ActionDefinition[] = []
  for (const { actions } of results) {
    for (const action of actions) {
      if (!action.triggers.includes(trigger)) continue
      if (seen.has(action.id)) continue
      seen.add(action.id)
      out.push(action)
    }
  }
  return out
}

export async function describeCapabilities(): Promise<CapabilityInfo[]> {
  const capabilities = allCapabilities()
  const emptyCtx: ActionContextSnapshot = {
    frontApp: '',
    bundleId: '',
    windowTitle: '',
    urlHost: '',
    hasSelection: false,
    selectionText: '',
    selectionKind: 'none',
    recentApps: [],
    recentActionIds: []
  }
  const results = await Promise.all(capabilities.map((c) => listWithBudget(c, emptyCtx)))
  const pluginErrors = pluginLoadErrors()

  const infos = capabilities.map((c, i) => ({
    id: c.id,
    title: c.title,
    blurb: c.blurb,
    icon: c.icon,
    source: c.source,
    enabled: ACTION_PREFS.isCapabilityEnabled(c.id),
    actionCount: results[i].actions.length,
    error: results[i].error
  }))

  for (const [fileName, reason] of Object.entries(pluginErrors)) {
    infos.push({
      id: fileName,
      title: fileName,
      blurb: '',
      icon: 'plug',
      source: 'plugin',
      enabled: false,
      actionCount: 0,
      error: reason
    })
  }

  return infos
}
