import { CONFIG } from '../../../shared/config'
import { getSupabase } from '../../supabase'

export interface WriterTrail {
  headersMs: number
  firstTextMs: number
  serverPreMs: number
  chargedCents: number
  costUsdMicros: number
}

export type WriterResult =
  | { ok: true; text: string; ms: number; trail: WriterTrail }
  | { ok: false; reason: string; ms: number; trail: WriterTrail }

export interface LlmProxyRequest {
  system: string
  userPrompt: string
  feature: string
  model: string
  timeoutMs: number
  maxTokens?: number
}

export interface WriterRequest {
  goal: string
  purpose: 'field' | 'search' | 'site' | 'app'
  fieldLabel: string
  existing?: string
  appName: string
  windowTitle: string
  history: readonly string[]
}

export const OUT_OF_CREDITS = 'out of credits'
const REFUSAL = 'NONE'
const MAX_TEXT_CHARS = 400
const MAX_REWRITE_CHARS = 4_000
const RESULT_EVENT = 'mm_result'
const PRE_TIMING = /pre;dur=(\d+)/

const SYSTEM_PROMPT =
  'You fill in ONE piece of text while an assistant completes a task on a computer for the user. ' +
  'Reply with ONLY the exact text to type - no quotes, no explanation, no trailing punctuation that was not asked for. ' +
  'Keep it as short as the task allows. ' +
  `Never write a password, a PIN, a card number or any secret. If the text needed is one of those, or the goal does not say what to type, reply with exactly ${REFUSAL}.`

function userPrompt(req: WriterRequest): string {
  const targets: Record<WriterRequest['purpose'], string> = {
    search:
      'Write the web search query that lands on the page where this task gets done: the name of the site, page or thing, in a few words. Never a "how to" question.',
    site: 'Write the web address of the website the goal names, host only, like news.ycombinator.com. No https, no path.',
    app: 'Write the name of the Mac app the goal needs next, exactly as it appears in Applications, like Notes or Google Chrome. Speech-to-text may have misheard the name - write the real app that fits the goal. The name only.',
    field: `Write the text for this field: "${req.fieldLabel}".`
  }
  const existing = req.existing ?? ''
  const target =
    existing === ''
      ? targets[req.purpose]
      : `This text is there now:\n<<<\n${existing}\n>>>\nWrite the full text that should be there afterwards - everything, not just the changed part. Keep what the goal does not ask to change.`
  return [
    `Goal: ${req.goal}`,
    `App: ${req.appName}`,
    `Window: ${req.windowTitle}`,
    `Steps so far: ${req.history.length > 0 ? req.history.join(' | ') : 'none'}`,
    target
  ].join('\n')
}

async function getJwt(): Promise<string> {
  try {
    const { data } = await getSupabase().auth.getSession()
    return data.session?.access_token ?? ''
  } catch {
    return ''
  }
}

async function drainText(
  body: ReadableStream<Uint8Array>,
  trail: WriterTrail,
  started: number
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as {
          type?: string
          delta?: { text?: string }
          charged_cents?: number
          cost_usd_micros?: number
        }
        if (e.type === 'content_block_delta' && typeof e.delta?.text === 'string') {
          if (out === '') trail.firstTextMs = Date.now() - started
          out += e.delta.text
        }
        if (e.type === RESULT_EVENT) {
          trail.chargedCents = e.charged_cents ?? 0
          trail.costUsdMicros = e.cost_usd_micros ?? 0
        }
      } catch {
        continue
      }
    }
  }
  return out
}

export async function callLlmProxy(req: LlmProxyRequest): Promise<WriterResult> {
  const started = Date.now()
  const trail: WriterTrail = {
    headersMs: 0,
    firstTextMs: 0,
    serverPreMs: 0,
    chargedCents: 0,
    costUsdMicros: 0
  }
  const fail = (reason: string): WriterResult => ({
    ok: false,
    reason,
    ms: Date.now() - started,
    trail
  })

  const jwt = await getJwt()
  if (!jwt) return fail('signed out')

  const abort = new AbortController()
  const killTimer = setTimeout(() => abort.abort(), req.timeoutMs)
  try {
    const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/llm-proxy`, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        'x-region': CONFIG.BILLING.EDGE_REGION
      },
      body: JSON.stringify({
        system: req.system,
        userPrompt: req.userPrompt,
        feature: req.feature,
        model: req.model,
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {})
      })
    })
    trail.headersMs = Date.now() - started
    trail.serverPreMs = Number(PRE_TIMING.exec(resp.headers.get('server-timing') ?? '')?.[1] ?? 0)
    if (resp.status === 402) return fail(OUT_OF_CREDITS)
    if (!resp.ok || !resp.body) return fail(`http ${resp.status}`)

    const text = await drainText(resp.body, trail, started)
    return { ok: true, text, ms: Date.now() - started, trail }
  } catch (err) {
    if (abort.signal.aborted) return fail('timed out')
    return fail(err instanceof Error ? err.message : 'network')
  } finally {
    clearTimeout(killTimer)
  }
}

export async function writeText(req: WriterRequest): Promise<WriterResult> {
  const result = await callLlmProxy({
    system: SYSTEM_PROMPT,
    userPrompt: userPrompt(req),
    feature: CONFIG.COMPUTER_USE.WRITER_FEATURE,
    model: CONFIG.SELECTION_BAR.FAST_MODEL,
    timeoutMs: CONFIG.COMPUTER_USE.WRITER_TIMEOUT_MS
  })
  if (!result.ok) return result

  const text = result.text.trim().replace(/^["']|["']$/g, '')
  if (text === '' || text === REFUSAL) {
    return { ok: false, reason: 'nothing safe to type', ms: result.ms, trail: result.trail }
  }
  const maxChars = (req.existing ?? '') === '' ? MAX_TEXT_CHARS : MAX_REWRITE_CHARS
  return { ok: true, text: text.slice(0, maxChars), ms: result.ms, trail: result.trail }
}
