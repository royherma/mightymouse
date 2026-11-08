// The ONLY place the action-decide call leaves the app. Always goes through
// the decide Worker (workers/decide) — the device never holds a TypeSafe API key.
import { net } from 'electron'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { getSupabase } from '../supabase'

export interface DecideBody {
  state: Record<string, unknown>
  questions: Record<string, unknown>
}

export interface DecideResult {
  answers: Record<string, unknown>
  latencyMs: number
  via: 'proxy'
  inputTokens: number
  serverMs: number
  jevMs: number
}

let lastFailure = ''

async function getJwt(): Promise<string> {
  try {
    const { data } = await getSupabase().auth.getSession()
    return data.session?.access_token ?? ''
  } catch {
    return ''
  }
}

function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403
}

async function callProxy(
  body: DecideBody,
  jwt: string,
  timeoutMs: number
): Promise<DecideResult | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  const payload = JSON.stringify(body)
  const sizes = Object.entries(body.state)
    .map(([k, v]) => `${k}=${JSON.stringify(v ?? '').length}`)
    .join(' ')
  devLog.log(
    `[decide] body ${payload.length}B state[${sizes}] ` +
      `q=${Object.keys(body.questions).length}/${JSON.stringify(body.questions).length}B`
  )
  try {
    const res = await net.fetch(CONFIG.ACTIONS.DECIDE_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: payload
    })
    if (!res.ok) {
      devLog.warn(
        `[decide] proxy failed: HTTP ${res.status}${isAuthFailure(res.status) ? ' (auth)' : ''}`
      )
      lastFailure = isAuthFailure(res.status)
        ? 'Sign in again to use voice commands.'
        : `The ranking service returned an error (${res.status}).`
      return null
    }
    const json = (await res.json()) as {
      answers?: Record<string, unknown>
      usage?: { input_tokens?: number }
      timing?: { total_ms?: number; upstream_ms?: number }
    }
    if (!json.answers || typeof json.answers !== 'object') return null
    devLog.log(
      `[decide] ${Date.now() - started}ms pop=${res.headers.get('cf-ray')?.split('-')[1]} ${res.headers.get('server-timing')}`
    )
    return {
      answers: json.answers,
      latencyMs: Date.now() - started,
      via: 'proxy',
      inputTokens: json.usage?.input_tokens ?? 0,
      serverMs: json.timing?.total_ms ?? 0,
      jevMs: json.timing?.upstream_ms ?? 0
    }
  } catch (err) {
    devLog.warn('[decide] proxy call threw:', err)
    lastFailure =
      err instanceof Error && err.name === 'AbortError'
        ? 'The ranking took too long.'
        : "Couldn't reach the ranking service."
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Returns null on total failure so callers treat it exactly like no ranking.
export async function callJev(body: DecideBody, timeoutMs: number): Promise<DecideResult | null> {
  const jwt = await getJwt()
  if (jwt === '') {
    lastFailure = 'Sign in to use voice commands.'
    console.log('[actions] decide skipped: not signed in')
    return null
  }
  lastFailure = ''
  const result = await callProxy(body, jwt, timeoutMs)
  if (result === null && lastFailure === '') lastFailure = "Couldn't reach the ranking service."
  jevInputTokens += result?.inputTokens ?? 0
  return result
}

// Consumed, not just read: a successful ranking leaves the flag set from an
// EARLIER failed call otherwise, and the card renders that stale error in place
// of rows the user could have clicked.
export function takeDecideFailure(): string {
  const failure = lastFailure
  lastFailure = ''
  return failure
}

let jevInputTokens = 0

export function takeJevInputTokens(): number {
  const tokens = jevInputTokens
  jevInputTokens = 0
  return tokens
}

export async function canDecide(): Promise<boolean> {
  return (await getJwt()) !== ''
}

let lastWarmAt = 0
const WARM_INTERVAL_MS = 20_000

// Fire-and-forget connection warm-up; never throws.
export function warmJev(): void {
  const now = Date.now()
  if (now - lastWarmAt < WARM_INTERVAL_MS) return
  lastWarmAt = now

  void (async () => {
    try {
      await net.fetch(CONFIG.ACTIONS.DECIDE_URL, { method: 'OPTIONS' })
    } catch (err) {
      devLog.warn('[decide] warm call failed (harmless):', err)
    }
  })()
}
