// Splits a local reasoning model's `<think>…</think>` preamble off its actual reply.
//
// Why this exists: the CLI agent backends hand us structured events (adapters.ts emits
// RUN_EVENT.thinking separately), but the local backends — Ollama, Rapid-MLX — stream one
// flat string with the reasoning inline. Nothing stripped it, so a Qwen answer rendered its
// private deliberation as if it were the reply, `</think>` and all, right in the middle of
// the prose. Confirmed live 2026-07-17 (Qwen3.5 9B).
//
// Rendered-mode only, by design: the Raw toggle means RAW, so the raw path shows the tags
// verbatim. This is a display concern — the stored turn keeps the model's full output.
const OPEN = '<think>'
const CLOSE = '</think>'

export interface ThinkSplit {
  /** The model's reasoning, joined if it emitted several blocks. Empty when there was none. */
  reasoning: string
  /** The reply with every think block removed. */
  answer: string
}

/**
 * Pull `<think>…</think>` blocks out of `text`.
 *
 * Handles the case that actually bites: an UNCLOSED trailing `<think>` (the answer is still
 * streaming, or the model never closed the tag). Everything from that opener on is reasoning
 * — treating it as answer text is what puts a bare `</think>` on screen later. A stray CLOSE
 * with no opener is also swallowed, since a model that emits one usually opened the block
 * before the text we were handed.
 */
export function splitThinkBlocks(text: string): ThinkSplit {
  if (!text.includes(OPEN) && !text.includes(CLOSE)) return { reasoning: '', answer: text }

  const reasoning: string[] = []
  let answer = ''
  let rest = text

  // A close with no matching open: everything before it belongs to a block that started
  // upstream of this string. Take it as reasoning, then parse the remainder normally.
  const strayClose = rest.indexOf(CLOSE)
  if (strayClose !== -1 && (rest.indexOf(OPEN) === -1 || strayClose < rest.indexOf(OPEN))) {
    reasoning.push(rest.slice(0, strayClose))
    rest = rest.slice(strayClose + CLOSE.length)
  }

  for (;;) {
    const open = rest.indexOf(OPEN)
    if (open === -1) {
      answer += rest
      break
    }
    answer += rest.slice(0, open)
    const after = rest.slice(open + OPEN.length)
    const close = after.indexOf(CLOSE)
    if (close === -1) {
      // Unclosed: the rest is all reasoning. Nothing left to scan.
      reasoning.push(after)
      break
    }
    reasoning.push(after.slice(0, close))
    rest = after.slice(close + CLOSE.length)
  }

  return { reasoning: reasoning.join('\n\n').trim(), answer: answer.trim() }
}
