import { exec, execFile } from 'child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { resolveBinary, shell } from '../platform'
import { callMcpTool } from './mcp-runner'
import {
  isActionIconName,
  type ActionDefinition,
  type ActionIconName,
  type ActionRunInput,
  type ActionRunResult,
  type ActionSlotSpec,
  type Capability,
  type PluginActionManifest,
  type PluginManifest,
  type PluginSlotManifest
} from '../../shared/action-engine'

const APPLESCRIPT_TIMEOUT_MS = 5_000
const URL_TIMEOUT_MS = 10_000

interface LoadedPlugin {
  manifest: PluginManifest
  fileName: string
}

interface ScanState {
  atMtime: number
  atListing: string
  plugins: LoadedPlugin[]
  errors: Record<string, string>
  lastScan: number
}

let state: ScanState = { atMtime: 0, atListing: '', plugins: [], errors: {}, lastScan: 0 }

function runAppleScriptTimed(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    const child = exec('osascript', (err, stdout) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(stdout.trim())
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('osascript timed out'))
    }, APPLESCRIPT_TIMEOUT_MS)
    child.stdin?.write(script)
    child.stdin?.end()
  })
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function dirListingSignature(): string {
  try {
    return readdirSync(PATHS.ACTION_PLUGINS_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .join(',')
  } catch {
    return ''
  }
}

function dirMtime(): number {
  try {
    let latest = 0
    for (const f of readdirSync(PATHS.ACTION_PLUGINS_DIR)) {
      if (!f.endsWith('.json')) continue
      const m = statSync(join(PATHS.ACTION_PLUGINS_DIR, f)).mtimeMs
      if (m > latest) latest = m
    }
    return latest
  } catch {
    return 0
  }
}

function validateSlot(raw: unknown, path: string): PluginSlotManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path}: slot must be an object`)
  const s = raw as Record<string, unknown>
  if (typeof s.key !== 'string' || s.key === '') throw new Error(`${path}: slot.key required`)
  if (typeof s.label !== 'string' || s.label === '') throw new Error(`${path}: slot.label required`)

  if (s.kind === 'choice') {
    if (typeof s.ask !== 'string' || s.ask === '') throw new Error(`${path}: choice slot needs ask`)
    if (!Array.isArray(s.options)) throw new Error(`${path}: choice slot needs options[]`)
    const options = s.options.map((o, i) => {
      if (typeof o !== 'object' || o === null) throw new Error(`${path}.options[${i}]: must be an object`)
      const opt = o as Record<string, unknown>
      if (typeof opt.value !== 'string' || typeof opt.label !== 'string') {
        throw new Error(`${path}.options[${i}]: value and label required`)
      }
      return { value: opt.value, label: opt.label }
    })
    return { kind: 'choice', key: s.key, label: s.label, ask: s.ask, options }
  }

  if (s.kind === 'score') {
    if (typeof s.ask !== 'string' || s.ask === '') throw new Error(`${path}: score slot needs ask`)
    if (typeof s.min !== 'number' || typeof s.max !== 'number') {
      throw new Error(`${path}: score slot needs numeric min/max`)
    }
    return {
      kind: 'score',
      key: s.key,
      label: s.label,
      ask: s.ask,
      min: s.min,
      max: s.max,
      unit: typeof s.unit === 'string' ? s.unit : undefined
    }
  }

  if (s.kind === 'transcript' || s.kind === 'selection') {
    return { kind: s.kind, key: s.key, label: s.label }
  }

  throw new Error(`${path}: unknown slot kind "${String(s.kind)}"`)
}

function validateRun(raw: unknown, path: string): PluginActionManifest['run'] {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path}.run: must be an object`)
  const r = raw as Record<string, unknown>
  switch (r.kind) {
    case 'shortcut':
      if (typeof r.name !== 'string' || r.name === '') throw new Error(`${path}.run: shortcut needs name`)
      return { kind: 'shortcut', name: r.name, input: typeof r.input === 'string' ? r.input : undefined }
    case 'applescript':
      if (typeof r.script !== 'string' || r.script === '') throw new Error(`${path}.run: applescript needs script`)
      return { kind: 'applescript', script: r.script }
    case 'shell':
      if (typeof r.command !== 'string' || r.command === '') throw new Error(`${path}.run: shell needs command`)
      return { kind: 'shell', command: r.command }
    case 'url':
      if (typeof r.url !== 'string' || r.url === '') throw new Error(`${path}.run: url needs url`)
      return {
        kind: 'url',
        url: r.url,
        method: r.method === 'POST' ? 'POST' : 'GET',
        body: typeof r.body === 'string' ? r.body : undefined
      }
    case 'mcp':
      if (typeof r.command !== 'string' || r.command === '') throw new Error(`${path}.run: mcp needs command`)
      if (typeof r.tool !== 'string' || r.tool === '') throw new Error(`${path}.run: mcp needs tool`)
      return {
        kind: 'mcp',
        command: r.command,
        args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : undefined,
        tool: r.tool,
        arguments:
          typeof r.arguments === 'object' && r.arguments !== null
            ? (r.arguments as Record<string, string>)
            : undefined
      }
    default:
      throw new Error(`${path}.run: unknown kind "${String(r.kind)}"`)
  }
}

function validateAction(raw: unknown, index: number): PluginActionManifest {
  const path = `actions[${index}]`
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path}: must be an object`)
  const a = raw as Record<string, unknown>
  if (typeof a.id !== 'string' || a.id === '') throw new Error(`${path}: id required`)
  if (typeof a.title !== 'string' || a.title === '') throw new Error(`${path}: title required`)
  if (typeof a.when !== 'string' || a.when === '') throw new Error(`${path}: when required`)
  const run = validateRun(a.run, path)
  const slots = Array.isArray(a.slots) ? a.slots.map((s, i) => validateSlot(s, `${path}.slots[${i}]`)) : []
  return {
    id: a.id,
    title: a.title,
    when: a.when,
    icon: typeof a.icon === 'string' ? a.icon : undefined,
    appBundleId: typeof a.appBundleId === 'string' ? a.appBundleId : undefined,
    confirm: a.confirm === true,
    idle: a.idle === true,
    slots,
    run
  }
}

function validateManifest(raw: unknown): PluginManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('manifest must be an object')
  const m = raw as Record<string, unknown>
  if (m.version !== 1) throw new Error('manifest.version must be 1')
  if (typeof m.id !== 'string' || m.id === '') throw new Error('manifest.id required')
  if (typeof m.title !== 'string' || m.title === '') throw new Error('manifest.title required')
  if (!Array.isArray(m.actions) || m.actions.length === 0) throw new Error('manifest.actions must be a non-empty array')
  return {
    version: 1,
    id: m.id,
    title: m.title,
    blurb: typeof m.blurb === 'string' ? m.blurb : undefined,
    icon: typeof m.icon === 'string' ? m.icon : undefined,
    author: typeof m.author === 'string' ? m.author : undefined,
    actions: m.actions.map((a, i) => validateAction(a, i))
  }
}

function seedSampleIfEmpty(): void {
  let files: string[]
  try {
    files = readdirSync(PATHS.ACTION_PLUGINS_DIR)
  } catch {
    return
  }
  if (files.length > 0) return

  const sample: PluginManifest = {
    version: 1,
    id: 'sample',
    title: 'Sample plugin',
    blurb: 'Shows a macOS notification to prove the plugin folder works.',
    icon: 'sparkles',
    actions: [
      {
        id: 'notify',
        title: 'Test my plugin',
        when: 'The user says test my plugin',
        icon: 'sparkles',
        run: {
          kind: 'applescript',
          script: 'display notification "It works!" with title "MightyMouse Plugin"'
        }
      }
    ]
  }
  try {
    writeFileSync(
      join(PATHS.ACTION_PLUGINS_DIR, 'example-open-url.json'),
      JSON.stringify(sample, null, 2),
      'utf-8'
    )
  } catch (err) {
    devLog.warn('[plugin-loader] failed to write sample plugin:', (err as Error).message)
  }
}

function scanIfStale(): void {
  const now = Date.now()
  if (now - state.lastScan < CONFIG.ACTIONS.PLUGIN_RESCAN_MS) return
  state.lastScan = now

  seedSampleIfEmpty()

  const listing = dirListingSignature()
  const mtime = dirMtime()
  if (listing === state.atListing && mtime === state.atMtime && state.plugins.length + Object.keys(state.errors).length > 0) {
    return
  }

  const plugins: LoadedPlugin[] = []
  const errors: Record<string, string> = {}
  let files: string[] = []
  try {
    files = readdirSync(PATHS.ACTION_PLUGINS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    files = []
  }

  for (const fileName of files) {
    try {
      const raw = readFileSync(join(PATHS.ACTION_PLUGINS_DIR, fileName), 'utf-8')
      const manifest = validateManifest(JSON.parse(raw))
      plugins.push({ manifest, fileName })
    } catch (err) {
      errors[fileName] = (err as Error).message
    }
  }

  state = { atMtime: mtime, atListing: listing, plugins, errors, lastScan: now }
}

function pluginIconName(icon: string | undefined): ActionIconName {
  return isActionIconName(icon) ? icon : 'plug'
}

function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '')
}

function slotStringValues(input: ActionRunInput): Record<string, string> {
  const out: Record<string, string> = { transcript: input.transcript, selection: input.selection }
  for (const [key, value] of Object.entries(input.slots)) out[key] = String(value)
  return out
}

async function runShortcutAction(
  run: Extract<PluginActionManifest['run'], { kind: 'shortcut' }>,
  input: ActionRunInput
): Promise<ActionRunResult> {
  const bin = resolveBinary('shortcuts')
  if (!bin) return { ok: false, line: 'Shortcuts CLI not found.' }
  const values = slotStringValues(input)
  const stdinText = run.input ? fillPlaceholders(run.input, values) : input.transcript

  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['run', run.name],
      { timeout: CONFIG.ACTIONS.RUN_TIMEOUT_MS, encoding: 'utf8' },
      (err) => resolve(err ? { ok: false, line: `${run.name} failed.` } : { ok: true, line: `Ran ${run.name}.` })
    )
    if (stdinText) child.stdin?.write(stdinText)
    child.stdin?.end()
  })
}

async function runAppleScriptAction(
  run: Extract<PluginActionManifest['run'], { kind: 'applescript' }>,
  input: ActionRunInput
): Promise<ActionRunResult> {
  const values = slotStringValues(input)
  const script = run.script.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    escapeAppleScriptString(values[key] ?? '')
  )
  try {
    await runAppleScriptTimed(script)
    return { ok: true, line: 'Done.' }
  } catch (err) {
    return { ok: false, line: (err as Error).message === 'osascript timed out' ? 'Timed out.' : 'Script failed.' }
  }
}

function runShellAction(
  run: Extract<PluginActionManifest['run'], { kind: 'shell' }>,
  input: ActionRunInput
): Promise<ActionRunResult> {
  const values = slotStringValues(input)
  const cmd = run.command.replace(/\{\{(\w+)\}\}/g, (_, key: string) => `"$MM_SLOT_${key.toUpperCase()}"`)
  const env: NodeJS.ProcessEnv = { ...shell.env(), MM_TRANSCRIPT: input.transcript, MM_SELECTION: input.selection }
  for (const [key, value] of Object.entries(values)) env[`MM_SLOT_${key.toUpperCase()}`] = value

  return new Promise((resolve) => {
    execFile(
      shell.bin,
      shell.spawnArgs(cmd),
      { timeout: CONFIG.ACTIONS.RUN_TIMEOUT_MS, encoding: 'utf8', env },
      (err) => resolve(err ? { ok: false, line: 'Command failed.' } : { ok: true, line: 'Done.' })
    )
  })
}

async function runUrlAction(
  run: Extract<PluginActionManifest['run'], { kind: 'url' }>,
  input: ActionRunInput
): Promise<ActionRunResult> {
  const values = slotStringValues(input)
  const url = fillPlaceholders(run.url, values)
  const body = run.body ? fillPlaceholders(run.body, values) : undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: run.method ?? 'GET',
      body: run.method === 'POST' ? body : undefined,
      signal: controller.signal
    })
    return { ok: res.ok, line: res.ok ? `Called ${new URL(url).host}.` : `Request failed (${res.status}).` }
  } catch {
    return { ok: false, line: 'Request failed.' }
  } finally {
    clearTimeout(timer)
  }
}

async function runMcpAction(
  run: Extract<PluginActionManifest['run'], { kind: 'mcp' }>,
  input: ActionRunInput
): Promise<ActionRunResult> {
  const values = slotStringValues(input)
  const args: Record<string, string> = {}
  for (const [key, template] of Object.entries(run.arguments ?? {})) args[key] = fillPlaceholders(template, values)
  return callMcpTool(
    { command: run.command, args: run.args, tool: run.tool, arguments: args },
    CONFIG.ACTIONS.RUN_TIMEOUT_MS
  )
}

function toActionDefinition(manifest: PluginManifest, action: PluginActionManifest): ActionDefinition {
  // `url` is scripted too: it interpolates {{transcript}}/{{selection}} into the URL, so an
  // unattended idle fire would send selected text to whatever host the manifest names.
  const isScripted = action.run.kind === 'shell' || action.run.kind === 'applescript' || action.run.kind === 'url'
  const safety = isScripted || action.confirm ? 'confirm' : 'safe'
  const triggers: Array<'voice' | 'idle' | 'phone'> = isScripted || !action.idle ? ['voice', 'phone'] : ['voice', 'idle', 'phone']
  const slots: ActionSlotSpec[] = (action.slots ?? []).map((s) =>
    s.kind === 'score' ? { ...s, unit: s.unit ?? '' } : s
  )

  return {
    id: `${manifest.id}.${action.id}`,
    capabilityId: manifest.id,
    title: action.title,
    when: action.when,
    icon: pluginIconName(action.icon),
    appBundleId: action.appBundleId,
    runKind: action.run.kind,
    safety,
    triggers,
    slots,
    async run(input: ActionRunInput): Promise<ActionRunResult> {
      switch (action.run.kind) {
        case 'shortcut':
          return runShortcutAction(action.run, input)
        case 'applescript':
          return runAppleScriptAction(action.run, input)
        case 'shell':
          return runShellAction(action.run, input)
        case 'url':
          return runUrlAction(action.run, input)
        case 'mcp':
          return runMcpAction(action.run, input)
      }
    }
  }
}

export function loadPluginCapabilities(): Capability[] {
  scanIfStale()
  return state.plugins.map(({ manifest }) => ({
    id: manifest.id,
    title: manifest.title,
    blurb: manifest.blurb ?? '',
    icon: pluginIconName(manifest.icon),
    source: 'plugin' as const,
    async listActions(): Promise<ActionDefinition[]> {
      return manifest.actions.map((a) => toActionDefinition(manifest, a))
    }
  }))
}

export function pluginLoadErrors(): Record<string, string> {
  scanIfStale()
  return state.errors
}

export interface McpServerConfig {
  command: string
  args?: string[]
}

export function listMcpServers(): McpServerConfig[] {
  scanIfStale()
  const seen = new Map<string, McpServerConfig>()
  for (const { manifest } of state.plugins) {
    for (const action of manifest.actions) {
      if (action.run.kind !== 'mcp') continue
      const key = `${action.run.command} ${(action.run.args ?? []).join(' ')}`
      if (!seen.has(key)) seen.set(key, { command: action.run.command, args: action.run.args })
    }
  }
  return [...seen.values()]
}
