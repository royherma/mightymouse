import { CONFIG } from '../shared/config'
import { getSupabase } from './supabase'
import { pasteText } from './platform'
import { rewriteUserPrompt } from './backend/prompts'

// Fast mode for the selection bar: one HTTPS round-trip to llm-proxy, then paste
// the result straight over the selection. The slow path spawns the user's CLI and
// opens the panel; here the ~1s the user waits is the model, not process startup.
//
// This deliberately does NOT reuse BACKENDS.mightymouse.runHttp — that carries
// attachments, phases, history and a panel to stream into, none of which exist on
// this path. The proxy still streams (it has no non-streaming mode), so we drain
// the NDJSON and concatenate; nothing is rendered mid-flight.

// The prompt bans em/en dashes, but a prompt rule is a request the model can
// quietly ignore -- it swapped U+2014 for U+2013 the first time we asked. This
// is the guarantee: a dash used as a PAUSE becomes a comma, while a real hyphen
// inside a compound ("AI-generated") is untouched because it has no spaces.
export function stripFancyDashes(text: string): string {
  return text
    // " - " / " -- " as an aside, plus the unicode dashes, all become a comma.
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/\s+-{1,2}\s+/g, ', ')
    // A dash hugging one side only (e.g. "real content– photos") still reads as
    // a pause, so it goes too. A bare compound hyphen never matches these.
    .replace(/\s*[—–]\s*/g, ', ')
}

// The prompt forbids echoing the instruction, but the same logic as the dash
// rule applies: a prompt rule is a request, and this one got ignored on a long
// instruction, which pasted the user's own instruction into their document.
// Only an EXACT leading copy is cut -- anything fuzzier would eat a rewrite that
// legitimately opens with the same words the user asked for.
export function stripEchoedInstruction(text: string, instruction: string): string {
  const want = instruction.trim()
  if (!want) return text

  let out = text.trimStart()
  if (!out.toLowerCase().startsWith(want.toLowerCase())) return text
  out = out.slice(want.length).trimStart()

  // The echo arrives with the separator the old prompt taught: a lone --- line.
  // Dropping it with the echo avoids leaving a dangling rule at the top.
  out = out.replace(/^-{3,}\s*\n/, '').trimStart()
  // An echo that was the WHOLE answer means there is no rewrite to keep, and an
  // empty string here would silently delete the selection on accept.
  return out || text
}

/** Server-side breakage (404/5xx): retrying cannot help until we ship a fix.
 *  Split from 'error' so the bar can say so instead of "try again". */
export type FastRewriteResult =
  | { ok: true; text: string }
  | {
      ok: false
      reason: 'signed_out' | 'out_of_credits' | 'timeout' | 'error' | 'broken'
      message: string
    }

/** Human-facing line for a failure. Kept beside the codes so no caller invents copy. */
export function fastRewriteErrorText(r: Extract<FastRewriteResult, { ok: false }>): string {
  const L = CONFIG.UI_LABELS
  switch (r.reason) {
    case 'signed_out':
      return L.SELECTION_BAR_FAST_SIGNED_OUT
    case 'out_of_credits':
      return L.SELECTION_BAR_FAST_NO_CREDITS
    case 'timeout':
      return L.SELECTION_BAR_FAST_TIMEOUT
    case 'broken':
      return L.SELECTION_BAR_FAST_BROKEN
    default:
      return L.SELECTION_BAR_FAST_FAILED
  }
}

async function getJwt(): Promise<string> {
  try {
    const { data } = await getSupabase().auth.getSession()
    return data.session?.access_token ?? ''
  } catch {
    // A coalesced auto-refresh blip throws here; treat it as signed out rather
    // than crashing the rewrite — the user just sees the sign-in line.
    return ''
  }
}

export interface ProxyAsk {
  system: string
  userPrompt: string
  feature: string
  model: string
  timeoutMs: number
}

/** One non-streamed text answer from llm-proxy. Never throws. */
export async function askProxy(ask: ProxyAsk): Promise<FastRewriteResult> {
  const jwt = await getJwt()
  if (!jwt) return { ok: false, reason: 'signed_out', message: 'no session' }

  const abort = new AbortController()
  const killTimer = setTimeout(() => abort.abort(), ask.timeoutMs)

  let resp: Response
  try {
    resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/llm-proxy`, {
      method: 'POST',
      signal: abort.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        system: ask.system,
        userPrompt: ask.userPrompt,
        feature: ask.feature,
        model: ask.model
      })
    })
  } catch (err) {
    clearTimeout(killTimer)
    if (abort.signal.aborted) return { ok: false, reason: 'timeout', message: 'timed out' }
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'network' }
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(killTimer)
    // 402 is the proxy's out-of-credits code; everything else is a generic failure.
    if (resp.status === 402) return { ok: false, reason: 'out_of_credits', message: 'no credits' }
    if (resp.status === 401) return { ok: false, reason: 'signed_out', message: 'unauthorized' }
    // 404 = a model id or route WE got wrong; 5xx = the proxy is down. Neither
    // clears by retrying, so they must not wear the same copy as a blip.
    if (resp.status === 404 || resp.status >= 500) {
      return { ok: false, reason: 'broken', message: `http ${resp.status}` }
    }
    return { ok: false, reason: 'error', message: `http ${resp.status}` }
  }

  // Drain the Anthropic-shaped NDJSON, keeping only the text deltas.
  let out = ''
  try {
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      // The last element is a partial line until the next chunk completes it.
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let e: { type?: string; delta?: { text?: string }; error?: string }
        try {
          e = JSON.parse(line)
        } catch {
          continue
        }
        if (e.type === 'content_block_delta' && typeof e.delta?.text === 'string') out += e.delta.text
      }
    }
  } catch (err) {
    clearTimeout(killTimer)
    if (abort.signal.aborted) return { ok: false, reason: 'timeout', message: 'stream timed out' }
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : 'stream' }
  }
  clearTimeout(killTimer)

  return { ok: true, text: out.trim() }
}

/** Ask the hosted proxy to rewrite `selection` per `instruction`. Never throws. */
export async function runFastRewrite(
  instruction: string,
  selection: string,
  userPrompt?: string
): Promise<FastRewriteResult> {
  const r = await askProxy({
    system: CONFIG.SYSTEM_PROMPT_REWRITE,
    userPrompt: userPrompt ?? rewriteUserPrompt(instruction, selection),
    feature: 'rewrite',
    model: CONFIG.SELECTION_BAR.FAST_MODEL,
    timeoutMs: CONFIG.SELECTION_BAR.FAST_TIMEOUT_MS
  })
  if (!r.ok) return r
  const text = stripFancyDashes(stripEchoedInstruction(r.text, instruction))
  // A clean 200 with no deltas means the model returned nothing usable; pasting
  // an empty string would silently delete the user's selection.
  if (!text) return { ok: false, reason: 'error', message: 'empty response' }
  return { ok: true, text }
}

/** Rewrite and paste over the live selection. Returns what the caller should report. */
export async function runFastRewriteAndPaste(
  instruction: string,
  selection: string
): Promise<FastRewriteResult> {
  const result = await runFastRewrite(instruction, selection)
  if (result.ok) await pasteText(result.text)
  return result
}
