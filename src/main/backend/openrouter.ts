import { CONFIG } from '../../shared/config'
import type { BackendTestResult } from '../../shared/types'
import { RUN_EVENT } from '../../shared/types'
import { KEYS } from '../keys/store'
import { loadImagesForVision } from './image-vision'
import { splitAttachments, inlineFilesForPrompt } from './attachments'
import { trimToTokenBudget, PRIOR_MESSAGES_TOKEN_BUDGET } from './adapters'
import type { BackendAdapter, HttpRunCtx, Phase } from './adapters'

export const OPENROUTER_KEY_NAME = 'OPENROUTER_API_KEY'
const API = 'https://openrouter.ai/api/v1'
const ATTRIBUTION = { 'HTTP-Referer': CONFIG.WEB_URL, 'X-OpenRouter-Title': CONFIG.PRODUCT_NAME }

async function readKey(): Promise<string> {
  return (await KEYS.getValue(OPENROUTER_KEY_NAME)) ?? process.env[OPENROUTER_KEY_NAME] ?? ''
}

function money(n: number): string {
  return `$${n.toFixed(2)}`
}

export async function hasOpenRouterKey(): Promise<boolean> {
  return (await readKey()) !== ''
}

let modelIds: string[] = []
const reasoningKind = new Map<string, 'effort' | 'toggle'>()

export function openRouterThinks(model: string): boolean {
  return reasoningKind.has(model)
}

function reasoningFor(model: string, think: boolean): Record<string, unknown> | undefined {
  const kind = reasoningKind.get(model)
  if (!kind) return undefined
  if (think) return { effort: 'high' }
  // Models taking reasoning_effort refuse enabled:false (muse-spark: "Reasoning is mandatory").
  return kind === 'effort' ? { effort: 'minimal' } : { enabled: false }
}

export async function listOpenRouterModels(): Promise<string[]> {
  if (modelIds.length > 0) return modelIds
  try {
    const res = await fetch(`${API}/models`, { signal: AbortSignal.timeout(10000) })
    const body = (await res.json()) as { data?: Array<{ id: string; supported_parameters?: string[] }> }
    for (const m of body.data ?? []) {
      const p = m.supported_parameters ?? []
      if (p.includes('reasoning')) reasoningKind.set(m.id, p.includes('reasoning_effort') ? 'effort' : 'toggle')
    }
    modelIds = (body.data ?? []).map((m) => m.id).sort()
  } catch (err) {
    console.error('OpenRouter model list failed:', err)
  }
  return modelIds
}

export async function probeOpenRouter(): Promise<BackendTestResult> {
  const label = CONFIG.BACKEND_CHECK.apiKey.label
  const key = await readKey()
  if (!key) {
    return {
      ok: false,
      checks: [{ label, ok: false, detail: 'No key saved' }],
      advice: 'Paste your OpenRouter key under the OpenRouter card.'
    }
  }
  let resp: Response
  try {
    resp = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${key}` } })
  } catch {
    return {
      ok: false,
      checks: [{ label, ok: false, detail: 'OpenRouter not reachable' }],
      advice: 'Check your internet connection, then try again.'
    }
  }
  if (!resp.ok) {
    return {
      ok: false,
      checks: [{ label, ok: false, detail: `Key rejected (${resp.status})` }],
      advice: 'That key did not work. Paste a new one from openrouter.ai/keys.'
    }
  }
  const { data } = (await resp.json().catch(() => ({}))) as {
    data?: { limit_remaining?: number | null; usage?: number; is_free_tier?: boolean }
  }
  const left = data?.limit_remaining
  const empty = typeof left === 'number' && left <= 0
  const detail =
    typeof left === 'number'
      ? `${money(left)} left`
      : `Key works · ${money(data?.usage ?? 0)} used`
  return {
    ok: !empty,
    checks: [{ label, ok: !empty, detail }],
    advice: empty ? 'This key has no credit left. Top up at openrouter.ai.' : null
  }
}

export const openrouter: BackendAdapter = {
  id: 'openrouter',
  label: CONFIG.BACKEND_META.openrouter.label,
  capabilities: { vision: true, fileAttachments: false, toolCalls: false, deniableTools: false, thinking: false },
  transport: 'http',
  modelName: CONFIG.OPENROUTER_DEFAULT_MODEL,
  hasEnvelope: false,

  parseOutput(stdout) {
    return stdout
  },

  parsePhase(line): Phase | null {
    let e: { choices?: Array<{ delta?: { content?: string } }> }
    try {
      e = JSON.parse(line)
    } catch {
      return null
    }
    const content = e.choices?.[0]?.delta?.content
    if (content === undefined) return null
    return { phase: content ? 'Writing' : 'Starting', detail: '' }
  },

  async runHttp(ctx: HttpRunCtx): Promise<void> {
    const { systemPrompt, userPrompt, priorMessages, attachments, onPhase, onEvent, onDone } = ctx
    const startedAt = Date.now()
    const duration = (): number => (Date.now() - startedAt) / 1000
    const model = ctx.selectedModel || CONFIG.OPENROUTER_DEFAULT_MODEL

    const key = await readKey()
    if (!key) {
      onDone(null, -1, '', 'No OpenRouter key saved. Paste one in Settings → AI Model.', 0, '', '')
      return
    }

    const { images, files } = splitAttachments(attachments)
    const imageUrls = loadImagesForVision(images.map((a) => a.path))
    const userText = userPrompt + inlineFilesForPrompt(files)
    const userContent =
      imageUrls.length > 0
        ? [{ type: 'text', text: userText }, ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))]
        : userText

    onPhase('Starting', 'connecting to OpenRouter')
    ctx.onModelResolved?.(model)
    await listOpenRouterModels()
    const reasoning = reasoningFor(model, ctx.thinkingEnabled)

    const abort = new AbortController()
    const killTimer = ctx.timeoutMs && ctx.timeoutMs > 0 ? setTimeout(() => abort.abort(), ctx.timeoutMs) : null
    const timedOut = (): boolean => abort.signal.aborted
    const finish = (text: string | null, code: number, err: string): void => {
      if (killTimer) clearTimeout(killTimer)
      onDone(text, code, '', err, duration(), '', '')
    }

    let resp: Response
    try {
      resp = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...ATTRIBUTION },
        body: JSON.stringify({
          model,
          stream: true,
          ...(reasoning ? { reasoning } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            ...trimToTokenBudget(priorMessages, PRIOR_MESSAGES_TOKEN_BUDGET),
            { role: 'user', content: userContent }
          ]
        })
      })
    } catch (err) {
      if (timedOut()) return finish(null, -3, 'timed_out')
      return finish(null, -1, err instanceof Error ? err.message : 'OpenRouter not reachable')
    }

    if (!resp.ok || !resp.body) {
      const body = await resp.text().catch(() => '')
      return finish(null, -1, body || `OpenRouter request failed (${resp.status})`)
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let result = ''
    let streamError = ''

    const consume = (raw: string): void => {
      const line = raw.trim()
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') return
      const ph = this.parsePhase(payload)
      if (ph) onPhase(ph.phase, ph.detail)
      try {
        const e = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
          error?: { message?: string }
        }
        if (e.error?.message) streamError = e.error.message
        const chunk = e.choices?.[0]?.delta?.content
        if (typeof chunk === 'string') result += chunk
        if (e.usage) {
          onEvent?.({
            kind: RUN_EVENT.usage,
            inputTokens: e.usage.prompt_tokens ?? 0,
            outputTokens: e.usage.completion_tokens ?? 0,
            costUsd: e.usage.cost
          })
        }
      } catch {
        return
      }
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          consume(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
        }
      }
      if (buf.trim()) consume(buf)
    } catch (err) {
      if (timedOut()) return finish(null, -3, 'timed_out')
      return finish(null, -1, err instanceof Error ? err.message : 'Stream read error')
    }

    finish(result || null, result ? 0 : -1, result ? '' : streamError || 'OpenRouter returned no text')
  }
}
