import { app, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import type {
  BrowserModResult,
  BrowserTaskFailure,
  ModShareStatus,
  SharedMod,
  SharedModRequest,
  SharedModResult,
  SiteModAction,
  SiteModState
} from '../../shared/types'
import { modFingerprint, modHostBlocked, modHostTooBroad, type ModVerdict } from '../../shared/site-mod-check'
import {
  SharedModError,
  countSharedModAdd,
  fetchSharedMod,
  linkedMod,
  loadLinkedMod,
  loadSharedModsFor,
  modLinkId,
  modLinkUrl,
  publishMod,
  reportSharedMod,
  sharedModStatuses,
  sharedModsFor,
  unpublishMod
} from './shared-mods'
import { draftText, recheckModCode, syntaxError, verdictOf, withTimeout, writeModCode, type ModCode } from './site-mods-writer'
import { MOD_WORLD_LOCK } from './site-mods-lock'
import { X_QUICK_REPLY } from './site-mods-x'

const TASK = CONFIG.BROWSER_TASK
const BUILT_INS = [X_QUICK_REPLY]
const STARTERS: Array<{ host: string; prompt: string }> = [
  { host: X_QUICK_REPLY.host, prompt: X_QUICK_REPLY.prompt },
  { host: 'youtube.com', prompt: 'Hide Shorts everywhere on YouTube' },
  { host: 'linkedin.com', prompt: 'Hide promoted posts in my feed' },
  { host: 'reddit.com', prompt: 'Hide the right sidebar so posts use the full width' },
  { host: 'news.ycombinator.com', prompt: 'Make the text bigger and easier to read' },
  { host: 'github.com', prompt: 'Make code and pull request pages use the full window width' }
]
const ONGOING =
  /\b(always|never|every ?time|whenever|each time|from now on|permanently|every visit|on this site|mod|by default|hide|bigger|smaller|wider|narrower|full[- ]?width|dark|light mode|font|colou?rs?|layout|sidebar|mute|blur|highlight)\b|^(add an?|put an?|make (the|it|this|all|every|pages?|code|text|posts?|videos?|repository|repo)|change the|turn the|remove the)\b/i
const ONE_TIME = /^(find|search|look up|book|buy|order|fill|sign|log ?in|send|reply|post|summari[sz]e|compare|download|show me|tell me|what|which|how|why|open|go to|click)\b/i
const OUTBOX_SIGNAL = '__mm_mod_outbox__'
const MAX_SHARED_CODE = 60_000
const RUNS_CODE = 'runs its own code on this site'

interface SiteMod extends ModCode {
  id: string
  host: string
  prompt: string
  on: boolean
  builtIn?: string
  broken?: string
  pulled?: string
  shared?: { id: string; maker: string; verified: boolean; mine: boolean; status: ModShareStatus; fingerprint?: string }
}

let saved: SiteMod[] | null = null
const previews = new Map<number, SiteMod>()
const asks = new Map<number, number[]>()

function file(): string {
  const dir = join(app.getPath('userData'), 'side-browser')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'mods.json')
}

function all(): SiteMod[] {
  if (saved) return saved
  try {
    const list = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as SiteMod[]) : []
    saved = list.map((m) => {
      const code = BUILT_INS.find((b) => b.prompt === m.builtIn)
      return code ? { ...m, css: code.css, js: code.js } : m
    })
  } catch (err) {
    devLog.warn('[site-mods] unreadable mods.json:', (err as Error).message)
    saved = []
  }
  return saved
}

function persist(): void {
  writeFileSync(file(), JSON.stringify(all(), null, 2))
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const sameSite = (host: string, modHost: string): boolean => host === modHost || host.endsWith(`.${modHost}`)

function blocked(url: string): boolean {
  const host = hostOf(url)
  if (!host) return true
  let path = ''
  try {
    path = new URL(url).pathname
  } catch {
    return true
  }
  return modHostBlocked(host) || TASK.MOD_BLOCKED_PATHS.test(path)
}

function modsFor(url: string): SiteMod[] {
  const host = hostOf(url)
  return host ? all().filter((m) => sameSite(host, m.host)) : []
}

function stateOf(m: SiteMod): SiteModState {
  const verdict = verdictFor(m)
  return {
    id: m.id,
    name: m.name,
    host: m.host,
    on: m.on,
    kind: verdict.kind,
    asks: verdict.asks,
    ...(m.broken ? { broken: m.broken } : {}),
    ...(m.builtIn ? { builtIn: true } : {}),
    ...(m.pulled ? { pulled: m.pulled } : {}),
    ...(m.shared ? { shared: { ...m.shared, url: modLinkUrl(m.shared.id) } } : {})
  }
}

export function siteModState(wc: WebContents): {
  mods: SiteModState[]
  modSuggestion: string | undefined
  sharedMods: SharedMod[]
  modLink: SharedMod | undefined
} {
  const url = wc.getURL()
  const mods = modsFor(url).map(stateOf)
  const host = hostOf(url)
  const off = blocked(url)
  const starter = STARTERS.find((s) => sameSite(host, s.host))
  const suggest = starter && !mods.length && !previews.has(wc.id) && !off
  const have = new Set(all().flatMap((m) => (m.shared ? [m.shared.id] : [])))
  const linkId = modLinkId(url)
  const link = linkId ? linkedMod(linkId) : undefined
  return {
    mods,
    modSuggestion: suggest ? starter.prompt : undefined,
    sharedMods: off ? [] : sharedModsFor(host).filter((m) => !have.has(m.id)),
    modLink: link && !have.has(link.id) ? link : undefined
  }
}

const BRIDGE = `if (!window.__mm) {
  const outbox = []
  const waits = new Map()
  let seq = 0
  window.__mm = {
    outbox,
    deliver(id, text, error) {
      const w = waits.get(id)
      waits.delete(id)
      if (w) error ? w.reject(new Error(error)) : w.resolve(text)
    },
    send(kind, modId, payload) {
      const id = ++seq
      outbox.push({ id, kind, modId, payload: String(payload).slice(0, 4000) })
      console.debug(${JSON.stringify(OUTBOX_SIGNAL)})
      return new Promise((resolve, reject) => waits.set(id, { resolve, reject }))
    }
  }
}`

function wrap(mod: SiteMod): string {
  const flag = JSON.stringify(`__mmMod_${mod.id}`)
  const id = JSON.stringify(mod.id)
  return `(() => { 'use strict'
${BRIDGE}
${mod.builtIn ? '' : MOD_WORLD_LOCK}
if (window[${flag}]) return; window[${flag}] = true
let reported = false
const mm = {
  ask: (prompt) => window.__mm.send('ask', ${id}, prompt),
  broken: (why) => { if (reported) return; reported = true; window.__mm.send('broken', ${id}, why).catch(() => {}) }
}
try {
${mod.js}
} catch (err) { mm.broken('it crashed: ' + (err && err.message)) } })()`
}

const MOD_WORLDS = [TASK.MOD_WORLD_ID, TASK.MOD_BUILT_IN_WORLD_ID]
const worldOf = (mod: SiteMod): number => (mod.builtIn ? TASK.MOD_BUILT_IN_WORLD_ID : TASK.MOD_WORLD_ID)
const verdicts = new Map<string, ModVerdict>()

export function verdictFor(mod: { css: string; js: string }): ModVerdict {
  const key = `${mod.css}\u0000${mod.js}`
  const known = verdicts.get(key)
  if (known) return known
  const verdict = verdictOf(mod)
  verdicts.set(key, verdict)
  return verdict
}

async function inject(wc: WebContents, mod: SiteMod): Promise<void> {
  if (wc.isDestroyed()) return
  const bad = mod.js.trim() ? syntaxError(mod.js) : null
  if (bad) {
    devLog.warn(`[site-mods] ${mod.name} has a syntax error: ${bad}`)
    mod.broken = 'its code has an error'
    return
  }
  const verdict = mod.builtIn ? null : verdictFor(mod)
  if (verdict?.level === 'refuse') {
    devLog.warn(`[site-mods] ${mod.name} refused: ${verdict.refused.join(', ')}`)
    mod.broken = `it was stopped for safety: it ${verdict.refused[0]}`
    return
  }
  const css = verdict ? verdict.css : mod.css
  try {
    if (css.trim()) await withTimeout(wc.insertCSS(css), TASK.MOD_PAGE_CALL_MS, '')
    if (mod.js.trim())
      await withTimeout(
        wc.executeJavaScriptInIsolatedWorld(worldOf(mod), [{ code: wrap(mod) }]),
        TASK.MOD_PAGE_CALL_MS,
        null
      )
  } catch (err) {
    devLog.warn(`[site-mods] ${mod.name} failed on ${hostOf(wc.getURL())}:`, (err as Error).message)
  }
}

export function applySiteMods(wc: WebContents): void {
  const url = wc.getURL()
  if (blocked(url)) return
  const preview = previews.get(wc.id)
  const live = modsFor(url).filter((m) => m.on && m.id !== preview?.id)
  for (const mod of preview && sameSite(hostOf(url), preview.host) ? [...live, preview] : live) void inject(wc, mod)
}

function deliver(wc: WebContents, world: number, id: number, text: string | null, error?: string): void {
  if (wc.isDestroyed()) return
  const call = `window.__mm && window.__mm.deliver(${id}, ${JSON.stringify(text)}, ${JSON.stringify(error ?? null)})`
  void wc.executeJavaScriptInIsolatedWorld(world, [{ code: call }]).catch(() => undefined)
}

function allowAsk(wc: WebContents): boolean {
  const now = Date.now()
  const recent = (asks.get(wc.id) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= TASK.MOD_ASKS_PER_MINUTE) return false
  asks.set(wc.id, [...recent, now])
  return true
}

interface OutboxItem {
  id: number
  kind: string
  modId: string
  payload: string
}

async function drainOutbox(wc: WebContents, world: number, onChange: () => void): Promise<void> {
  if (wc.isDestroyed()) return
  const items = (await wc
    .executeJavaScriptInIsolatedWorld(world, [{ code: 'window.__mm ? window.__mm.outbox.splice(0) : []' }])
    .catch(() => [])) as OutboxItem[]
  for (const item of items) {
    const mod = previews.get(wc.id)?.id === item.modId ? previews.get(wc.id) : all().find((m) => m.id === item.modId)
    if (!mod || worldOf(mod) !== world) continue
    if (item.kind === 'broken') {
      mod.broken = item.payload || 'it could not find what it needs'
      if (all().includes(mod)) persist()
      deliver(wc, world, item.id, '')
      onChange()
    } else if (item.kind === 'ask') {
      if (!allowAsk(wc)) {
        deliver(wc, world, item.id, null, 'Too many requests, try again in a minute')
        continue
      }
      void draftText(item.payload).then(({ text }) =>
        deliver(wc, world, item.id, text, text ? undefined : 'The AI did not answer')
      )
    }
  }
}

let syncedAt = 0

export async function syncSharedMods(): Promise<boolean> {
  const mine = all().filter((m) => m.shared)
  if (!mine.length) return false
  let changed = false
  try {
    const statuses = await sharedModStatuses(mine.map((m) => m.shared?.id ?? ''))
    for (const mod of mine) {
      const now = statuses.find((s) => s.id === mod.shared?.id)
      if (!now || !mod.shared) continue
      if (!mod.pulled && mod.shared.fingerprint && now.fingerprint !== mod.shared.fingerprint) {
        mod.on = false
        mod.pulled = 'This mod changed after you added it'
        changed = true
        continue
      }
      if (now.status === mod.shared.status) continue
      mod.shared.status = now.status
      const stopped = now.status === 'pulled' || (now.status === 'pending' && !mod.shared.mine)
      if (stopped) {
        mod.on = false
        mod.pulled = now.statusReason ?? 'MightyMouse turned this mod off'
      } else mod.pulled = undefined
      changed = true
    }
  } catch (err) {
    devLog.warn('[site-mods] status check failed:', (err as Error).message)
  }
  if (changed) persist()
  return changed
}

function refreshShared(wc: WebContents, onChange: () => void): void {
  const url = wc.getURL()
  const host = hostOf(url)
  if (!/^https?:/.test(url) || !host) return
  const linkId = modLinkId(url)
  if (linkId && !linkedMod(linkId)) void loadLinkedMod(linkId).then((found) => found && onChange())
  if (!blocked(url)) void loadSharedModsFor(host).then((found) => found && onChange())
  if (Date.now() - syncedAt < TASK.MOD_SYNC_EVERY_MS) return
  syncedAt = Date.now()
  void syncSharedMods().then((changed) => {
    if (!changed) return
    onChange()
    if (!wc.isDestroyed() && modsFor(wc.getURL()).some((m) => m.pulled)) wc.reload()
  })
}

export function watchSiteMods(wc: WebContents, onChange: () => void): void {
  wc.on('did-navigate', () => refreshShared(wc, onChange))
  wc.on('dom-ready', () => applySiteMods(wc))
  wc.on('console-message', (event) => {
    if (event.message === OUTBOX_SIGNAL) for (const world of MOD_WORLDS) void drainOutbox(wc, world, onChange)
  })
}

export function isModRequest(wc: WebContents, instruction: string, editMod?: string): boolean {
  if (editMod || previews.has(wc.id)) return true
  const host = hostOf(wc.getURL())
  const text = instruction.trim()
  if (STARTERS.some((s) => sameSite(host, s.host) && s.prompt === text)) return true
  return ONGOING.test(text) && !ONE_TIME.test(text)
}

export async function previewSiteMod(
  wc: WebContents,
  instruction: string,
  onLine: (line: string) => void,
  editMod?: string
): Promise<BrowserModResult | BrowserTaskFailure> {
  const started = Date.now()
  const url = wc.getURL()
  const host = hostOf(url)
  if (blocked(url))
    return { ok: false, reason: 'Mods are turned off on sign-in, payment and banking pages', ms: 0 }
  const before = previews.get(wc.id) ?? (editMod ? all().find((m) => m.id === editMod) : undefined)
  const builtIn = !before && BUILT_INS.find((b) => sameSite(host, b.host) && b.prompt === instruction.trim())
  let code: ModCode | null = builtIn ? { name: builtIn.name, summary: builtIn.summary, css: builtIn.css, js: builtIn.js } : null
  let costUsd = 0
  if (!code) {
    onLine(before ? `Changing ${before.name}` : `Writing a mod for ${host}`)
    const prior = before ? { name: before.name, summary: before.summary, css: before.css, js: before.js } : undefined
    const res = await writeModCode(wc, host, instruction, prior)
    costUsd = res.costUsd
    if (!res.code) return { ok: false, reason: `Could not make that change: ${res.reason}`, ms: Date.now() - started }
    code = res.code
  }
  const mod: SiteMod = {
    id: before?.id ?? randomUUID(),
    host: before?.host ?? (builtIn ? builtIn.host : host),
    prompt: before ? `${before.prompt}\n${instruction}` : instruction,
    on: true,
    ...(builtIn ? { builtIn: builtIn.prompt } : {}),
    ...code
  }
  previews.set(wc.id, mod)
  onLine('Trying it on this page')
  if (before) wc.reload()
  else await inject(wc, mod)
  if (!builtIn) {
    await new Promise((resolve) => setTimeout(resolve, TASK.MOD_RECHECK_WAIT_MS + (before ? TASK.MOD_RECHECK_WAIT_MS : 0)))
    onLine('Checking it worked')
    const check = await recheckModCode(wc, instruction, code)
    costUsd += check.costUsd
    if (check.code && previews.get(wc.id) === mod) {
      Object.assign(mod, check.code)
      onLine('Fixing what it missed')
      wc.reload()
    }
  }
  return { ok: true, kind: 'mod', name: mod.name, summary: mod.summary, ms: Date.now() - started, costUsd }
}

export function siteModAction(wc: WebContents | null, action: SiteModAction, id?: string, name?: string): SiteModState[] {
  const here = wc ? hostOf(wc.getURL()) : ''
  if (wc && (action === 'keep' || action === 'undo')) {
    const preview = previews.get(wc.id)
    previews.delete(wc.id)
    if (preview && action === 'keep') {
      saved = [...all().filter((m) => m.id !== preview.id), { ...preview, broken: undefined }]
      persist()
    } else if (preview) wc.reload()
  }
  const mod = all().find((m) => m.id === id)
  if (mod && (action === 'toggle' || action === 'remove' || action === 'rename')) {
    if (action === 'toggle') {
      if (mod.pulled) return [...all()].map(stateOf)
      mod.on = !mod.on
      mod.broken = undefined
    }
    else if (action === 'remove') saved = all().filter((m) => m.id !== id)
    else if (name?.trim()) mod.name = name.trim().slice(0, 40)
    persist()
    if (wc && action !== 'rename' && sameSite(here, mod.host)) wc.reload()
  }
  return [...all()]
    .sort((a, b) => Number(sameSite(here, b.host)) - Number(sameSite(here, a.host)) || a.host.localeCompare(b.host))
    .map(stateOf)
}

async function share(modId: string, makerName?: string): Promise<SharedModResult> {
  const mod = all().find((m) => m.id === modId)
  if (!mod || mod.builtIn || (mod.shared && !mod.shared.mine)) return { ok: false, message: 'Only a mod you made can be shared.' }
  const verdict = verdictFor(mod)
  if (verdict.level === 'refuse') return { ok: false, message: `This mod cannot be shared: it ${verdict.refused.join(' and ')}.` }
  const { host, name, summary, prompt, js } = mod
  if (modHostTooBroad(host)) return { ok: false, message: 'Pick one site, not a whole group of sites.' }
  const card = await publishMod({ host, name, summary, prompt, css: verdict.css, js }, makerName)
  mod.shared = { id: card.id, maker: card.maker.name, verified: card.maker.verified, mine: true, status: card.status }
  persist()
  return { ok: true, url: modLinkUrl(card.id), status: card.status, message: card.statusReason ?? undefined }
}

async function add(wc: WebContents | null, sharedId: string, yes: boolean): Promise<SharedModResult> {
  const got = await fetchSharedMod(sharedId)
  if (got.status !== 'live' || typeof got.css !== 'string' || typeof got.js !== 'string')
    return { ok: false, message: got.statusReason ?? 'This mod is not ready to add yet.' }
  if (got.id?.toUpperCase() !== sharedId.toUpperCase() || typeof got.fingerprint !== 'string' || got.css.length > MAX_SHARED_CODE || got.js.length > MAX_SHARED_CODE)
    return { ok: false, message: 'This mod could not be checked, so it was not added.' }
  if (typeof got.host !== 'string' || modHostTooBroad(got.host) || modHostBlocked(got.host)) return { ok: false, message: 'Mods are turned off on sign-in, payment and banking sites.' }
  const verdict = verdictFor({ css: got.css, js: got.js })
  if (verdict.level === 'refuse') return { ok: false, message: `MightyMouse stopped this mod: it ${verdict.refused.join(' and ')}.` }
  if ((await modFingerprint({ host: got.host, css: got.css, js: got.js })) !== got.fingerprint)
    return { ok: false, message: 'This mod changed after it was shared, so it was not added.' }
  if ((verdict.level === 'ask' || verdict.kind === 'code') && !yes) return { ok: false, needsYes: verdict.asks.length ? verdict.asks : [RUNS_CODE] }
  const shared = { id: got.id, maker: got.maker.name, verified: got.maker.verified, mine: false, status: got.status, fingerprint: got.fingerprint }
  const known = all().find((m) => m.shared?.id === got.id)
  if (known) Object.assign(known, { on: true, pulled: undefined, broken: undefined, css: verdict.css, js: got.js, shared })
  else
    saved = [
      ...all(),
      { id: randomUUID(), host: got.host, prompt: got.prompt ?? '', on: true, name: got.name, summary: got.summary, css: verdict.css, js: got.js, shared }
    ]
  persist()
  countSharedModAdd(got.id)
  if (wc && !wc.isDestroyed() && sameSite(hostOf(wc.getURL()), got.host)) wc.reload()
  return { ok: true }
}

export async function sharedModAction(wc: WebContents | null, request: SharedModRequest): Promise<SharedModResult> {
  try {
    if (request.do === 'share') return await share(request.modId, request.makerName)
    if (request.do === 'add') return await add(wc, request.sharedId, request.yes === true)
    if (request.do === 'report') {
      await reportSharedMod(request.sharedId, request.reason)
      return { ok: true }
    }
    if (request.do === 'unshare') {
      const mod = all().find((m) => m.id === request.modId)
      if (!mod?.shared?.mine) return { ok: false, message: 'This mod is not shared.' }
      await unpublishMod(mod.shared.id)
      mod.shared = undefined
      persist()
      return { ok: true }
    }
    const changed = await syncSharedMods()
    if (changed && wc && !wc.isDestroyed() && modsFor(wc.getURL()).some((m) => m.pulled)) wc.reload()
    return { ok: true }
  } catch (err) {
    if (!(err instanceof SharedModError)) throw err
    return { ok: false, message: err.message, canRetry: err.code === 'offline', ...(err.code === 'maker_name' ? { needsName: true } : {}) }
  }
}

export function forgetSiteModPreview(wc: WebContents): void {
  previews.delete(wc.id)
  asks.delete(wc.id)
}
