import { execFile } from 'child_process'
import { resolveBinary } from '../../platform'
import { CONFIG } from '../../../shared/config'
import { devLog } from '../../../shared/env'
import type {
  ActionDefinition,
  ActionRunInput,
  ActionRunResult,
  ActionSlotOption,
  Capability
} from '../../../shared/action-engine'

const SHORTCUTS_LIST_CACHE_MS = 60_000
const SHORTCUTS_LIST_TIMEOUT_MS = 1_500
const SHORTCUTS_RUN_TIMEOUT_MS = CONFIG.ACTIONS.RUN_TIMEOUT_MS

let listCache: ActionSlotOption[] = []
let listCacheAt = 0

function listShortcuts(bin: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['list'],
      { timeout: SHORTCUTS_LIST_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          devLog.warn('[shortcuts] list failed:', err.message)
          resolve([])
          return
        }
        resolve(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '')
        )
      }
    )
  })
}

async function shortcutOptions(): Promise<{ bin: string | null; options: ActionSlotOption[] }> {
  const bin = resolveBinary('shortcuts')
  if (!bin) return { bin: null, options: [] }

  const now = Date.now()
  if (now - listCacheAt < SHORTCUTS_LIST_CACHE_MS && listCache.length > 0) {
    return { bin, options: listCache }
  }

  const names = await listShortcuts(bin)
  listCache = names.map((name) => ({ value: name, label: name }))
  listCacheAt = now
  return { bin, options: listCache }
}

function runShortcut(bin: string, name: string, input: string): Promise<ActionRunResult> {
  return new Promise((resolve) => {
    const args = ['run', name]
    const child = execFile(
      bin,
      args,
      { timeout: SHORTCUTS_RUN_TIMEOUT_MS, encoding: 'utf8' },
      (err) => {
        resolve(err ? { ok: false, line: `${name} failed.` } : { ok: true, line: `Ran ${name}.` })
      }
    )
    if (input) {
      child.stdin?.write(input)
    }
    child.stdin?.end()
  })
}

export const shortcutsCapability: Capability = {
  id: 'shortcuts',
  title: 'Shortcuts',
  blurb: 'Run any macOS Shortcut by name.',
  icon: 'workflow',
  source: 'builtin',
  async listActions(): Promise<ActionDefinition[]> {
    const { bin, options } = await shortcutOptions()
    if (!bin || options.length === 0) return []

    return [
      {
        id: 'shortcuts.run',
        capabilityId: 'shortcuts',
        title: 'Run Shortcut',
        when: 'The user names one of their macOS Shortcuts to run.',
        icon: 'workflow',
        runKind: 'builtin',
        safety: 'safe',
        triggers: ['voice', 'phone'],
        slots: [
          { kind: 'choice', key: 'name', label: 'Shortcut', ask: 'Which shortcut?', options }
        ],
        async run(input: ActionRunInput): Promise<ActionRunResult> {
          const name = String(input.slots.name ?? '')
          if (!name) return { ok: false, line: 'No shortcut chosen.' }
          return runShortcut(bin, name, input.transcript)
        }
      }
    ]
  }
}
