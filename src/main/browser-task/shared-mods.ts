import { CONFIG } from '../../shared/config'
import { IS_DEV, devLog } from '../../shared/env'
import type { ModShareStatus, SharedMod } from '../../shared/types'
import { getSupabase } from '../supabase'

const TASK = CONFIG.BROWSER_TASK
const LINK_ID = /^\/m\/([0-9A-Za-z]{10})\/?$/
const OFFLINE = "We couldn't reach MightyMouse. Check your connection and try again."

export interface SharedModCode extends SharedMod {
  css?: string
  js?: string
  prompt?: string
}

export class SharedModError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message)
  }
}

const siteLists = new Map<string, { at: number; mods: SharedMod[] }>()
const linkCards = new Map<string, SharedMod>()

function endpoint(): string {
  const local = IS_DEV ? process.env.MM_MODS_URL : undefined
  return local || `${CONFIG.BILLING.EDGE_FUNCTION_URL}/${TASK.MODS_FN}`
}

async function call<T>(body: Record<string, unknown>, signedIn = false): Promise<T> {
  const { data } = await getSupabase().auth.getSession()
  const jwt = data.session?.access_token
  if (signedIn && !jwt) throw new SharedModError('Sign in to MightyMouse first.', 'sign_in')
  let resp: Response
  try {
    resp = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TASK.MOD_CALL_TIMEOUT_MS)
    })
  } catch {
    throw new SharedModError(OFFLINE, 'offline')
  }
  const json = (await resp.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!resp.ok) throw new SharedModError(json.message ?? OFFLINE, json.error ?? 'failed')
  return json as T
}

export const modLinkUrl = (id: string): string => `${TASK.MOD_LINK_URL}/${id}`

export function modLinkId(url: string): string | null {
  try {
    const link = new URL(url)
    const ours = link.origin === new URL(TASK.MOD_LINK_URL).origin || (IS_DEV && link.hostname === 'localhost')
    return ours ? (LINK_ID.exec(link.pathname)?.[1].toUpperCase() ?? null) : null
  } catch {
    return null
  }
}

export function publishMod(
  mod: { host: string; name: string; summary: string; prompt: string; css: string; js: string },
  makerName?: string
): Promise<SharedMod> {
  return call<SharedMod>({ action: 'publish', ...mod, ...(makerName ? { makerName } : {}) }, true)
}

export const unpublishMod = (id: string): Promise<unknown> => call({ action: 'remove', id }, true)
export const fetchSharedMod = (id: string): Promise<SharedModCode> => call<SharedModCode>({ action: 'get', id })
export const reportSharedMod = (id: string, reason: string): Promise<unknown> => call({ action: 'report', id, reason }, true)
export const countSharedModAdd = (id: string): void => void call({ action: 'installed', id }, true).catch(() => undefined)

export async function sharedModStatuses(
  ids: string[]
): Promise<Array<{ id: string; status: ModShareStatus; statusReason: string | null; fingerprint: string }>> {
  if (!ids.length) return []
  return (await call<{ mods: Array<{ id: string; status: ModShareStatus; statusReason: string | null; fingerprint: string }> }>({ action: 'status', ids })).mods
}

export const sharedModsFor = (host: string): SharedMod[] => siteLists.get(host)?.mods ?? []
export const linkedMod = (id: string): SharedMod | undefined => linkCards.get(id)

export async function loadSharedModsFor(host: string): Promise<boolean> {
  const known = siteLists.get(host)
  if (known && Date.now() - known.at < TASK.MOD_SITE_LIST_TTL_MS) return false
  siteLists.set(host, { at: Date.now(), mods: known?.mods ?? [] })
  try {
    const { mods } = await call<{ mods: SharedMod[] }>({ action: 'site', host })
    siteLists.set(host, { at: Date.now(), mods })
    return mods.length > 0 || Boolean(known?.mods.length)
  } catch (err) {
    devLog.warn('[shared-mods] site list failed:', (err as Error).message)
    return false
  }
}

export async function loadLinkedMod(id: string): Promise<boolean> {
  try {
    const card = await fetchSharedMod(id)
    delete card.css
    delete card.js
    delete card.prompt
    linkCards.set(id, card)
    return true
  } catch (err) {
    devLog.warn('[shared-mods] link lookup failed:', (err as Error).message)
    return false
  }
}
