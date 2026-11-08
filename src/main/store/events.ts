import { appendFileSync } from 'fs'
import { PATHS } from './paths'
import { PREFS } from './prefs'

function yamlNeedsQuoting(s: string): boolean {
  if (s === '') return true
  if (s.startsWith(' ') || s.endsWith(' ')) return true
  const lower = s.toLowerCase()
  if (
    lower === 'true' ||
    lower === 'false' ||
    lower === 'null' ||
    lower === 'yes' ||
    lower === 'no' ||
    lower === 'on' ||
    lower === 'off'
  ) {
    return true
  }
  if (!isNaN(Number(s))) return true
  if (/[#:\n"'{}[\]&*!|>%@,]/.test(s)) return true
  return false
}

function yamlEscape(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
  return `"${escaped}"`
}

export const EVENTS = {
  append(data: Record<string, any>): void {
    if (PREFS.getIncognito()) return
    try {
      const ts = data.ts || new Date().toISOString().replace(/\.\d+Z$/, '')
      const item: Record<string, unknown> = { ts, ...data }
      const lines = ['---']

      const writeKV = (k: string, v: any): void => {
        if (v === undefined || v === null) return
        let vs: string | undefined
        if (typeof v === 'boolean') {
          vs = v ? 'true' : 'false'
        } else if (typeof v === 'number') {
          vs = String(v)
        } else if (typeof v === 'string') {
          vs = yamlNeedsQuoting(v) ? yamlEscape(v) : v
        } else {
          vs = yamlEscape(JSON.stringify(v))
        }
        if (vs !== undefined) {
          lines.push(`${k}: ${vs}`)
        }
      }

      // Priority keys
      const priority = ['ts', 'run_id', 'event']
      for (const k of priority) {
        if (k in item) {
          writeKV(k, item[k])
        }
      }

      // Rest of keys
      const rest = Object.keys(item)
        .filter((k) => !priority.includes(k))
        .sort()
      for (const k of rest) {
        writeKV(k, item[k])
      }

      appendFileSync(PATHS.EVENTS, lines.join('\n') + '\n', 'utf-8')
    } catch (err) {
      console.error('Failed to log event:', err)
    }
  }
}
