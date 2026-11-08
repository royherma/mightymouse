import { app } from 'electron'
import { execFile } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveHelper } from './platform/macos/helpers'
import type { SideBrowserPermission } from '../shared/types'

const ALWAYS_ALLOWED = new Set(['clipboard-sanitized-write', 'fullscreen'])
const ASKABLE: Record<string, string> = {
  geolocation: 'your location',
  media: 'your camera and microphone',
  notifications: 'to send notifications',
  'clipboard-read': 'to read your clipboard'
}

type Saved = Record<string, Record<string, boolean>>
interface Pending {
  origin: string
  kind: string
  answer: ((allow: boolean) => void)[]
}

const LOCATION_FRESH_MS = 60_000
const LOCATION_TIMEOUT_MS = 70_000

const pending = new Map<number, Pending>()
let saved: Saved | null = null
let lastFix: { at: number; fix: LocationFix } | null = null
let locating: Promise<LocationFix> | null = null

export type LocationFix =
  | { latitude: number; longitude: number; accuracy: number }
  | { error: string }

function file(): string {
  return join(app.getPath('userData'), 'side-browser', 'permissions.json')
}

function load(): Saved {
  if (saved) return saved
  try {
    saved = JSON.parse(readFileSync(file(), 'utf8')) as Saved
  } catch {
    saved = {}
  }
  return saved
}

function save(): void {
  mkdirSync(join(app.getPath('userData'), 'side-browser'), { recursive: true })
  writeFileSync(file(), JSON.stringify(load(), null, 2))
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin
    return o === 'null' ? null : o
  } catch {
    return null
  }
}

export function installPermissionHandlers(sess: Electron.Session, onAsk: (wc: Electron.WebContents) => void): void {
  sess.setPermissionCheckHandler((_wc, perm, requestingOrigin) => {
    if (ALWAYS_ALLOWED.has(perm)) return true
    return load()[requestingOrigin]?.[perm] === true
  })
  sess.setPermissionRequestHandler((wc, perm, cb, details) => {
    if (ALWAYS_ALLOWED.has(perm)) return cb(true)
    ask(wc, details.requestingUrl ?? wc.getURL(), perm, cb, onAsk)
  })
}

function ask(
  wc: Electron.WebContents,
  url: string,
  kind: string,
  cb: (allow: boolean) => void,
  onAsk: (wc: Electron.WebContents) => void
): void {
  const origin = originOf(url)
  if (!ASKABLE[kind] || !origin) return cb(false)
  const known = load()[origin]?.[kind]
  if (known !== undefined) return cb(known)
  const open = pending.get(wc.id)
  if (open && open.origin === origin && open.kind === kind) return void open.answer.push(cb)
  open?.answer.forEach((a) => a(false))
  pending.set(wc.id, { origin, kind, answer: [cb] })
  wc.once('destroyed', () => pending.delete(wc.id))
  onAsk(wc)
}

export async function siteLocation(
  wc: Electron.WebContents,
  onAsk: (wc: Electron.WebContents) => void
): Promise<LocationFix> {
  const allowed = await new Promise<boolean>((resolve) => ask(wc, wc.getURL(), 'geolocation', resolve, onAsk))
  if (!allowed) return { error: 'denied' }
  if (lastFix && Date.now() - lastFix.at < LOCATION_FRESH_MS) return lastFix.fix
  locating ??= locate().finally(() => (locating = null))
  return locating
}

function locate(): Promise<LocationFix> {
  const dir = mkdtempSync(join(tmpdir(), 'mm-location-'))
  const out = join(dir, 'fix.json')
  return new Promise<LocationFix>((resolve) => {
    execFile(
      'open',
      ['-W', '-n', '-g', '--stdout', out, resolveHelper('MightyMouseLocation.app')],
      { timeout: LOCATION_TIMEOUT_MS },
      () => {
        let fix: LocationFix
        try {
          fix = JSON.parse(readFileSync(out, 'utf8')) as LocationFix
        } catch {
          fix = { error: 'unavailable' }
        }
        rmSync(dir, { recursive: true, force: true })
        if (!('error' in fix)) lastFix = { at: Date.now(), fix }
        resolve(fix)
      }
    )
  })
}

export function permissionState(wc: Electron.WebContents): {
  ask?: SideBrowserPermission
  sitePermissions: SideBrowserPermission[]
} {
  const p = pending.get(wc.id)
  const origin = originOf(wc.getURL())
  const site = origin ? (load()[origin] ?? {}) : {}
  return {
    ask: p ? { origin: p.origin, kind: p.kind, label: ASKABLE[p.kind] } : undefined,
    sitePermissions: Object.entries(site).map(([kind, allowed]) => ({
      origin: origin!,
      kind,
      label: ASKABLE[kind] ?? kind,
      allowed
    }))
  }
}

export function decidePermission(
  wc: Electron.WebContents,
  kind: string,
  decision: 'allow' | 'block' | 'reset'
): void {
  const p = pending.get(wc.id)
  const origin = p?.kind === kind ? p.origin : originOf(wc.getURL())
  if (!origin) return
  const all = load()
  if (decision === 'reset') {
    delete all[origin]?.[kind]
    if (all[origin] && !Object.keys(all[origin]).length) delete all[origin]
  } else {
    all[origin] = { ...all[origin], [kind]: decision === 'allow' }
  }
  save()
  if (p?.kind === kind) {
    pending.delete(wc.id)
    p.answer.forEach((a) => a(decision === 'allow'))
  }
}

export function dropStaleAsk(wc: Electron.WebContents): void {
  const p = pending.get(wc.id)
  if (!p || p.origin === originOf(wc.getURL())) return
  pending.delete(wc.id)
  p.answer.forEach((a) => a(false))
}
