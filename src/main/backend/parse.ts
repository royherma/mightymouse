export interface ActResult {
  summary: string
  outputPath?: string | null
}

export function cleanOutput(text: string): string {
  if (!text) return ''
  let cleaned = text.trim()
  // Clean em and en dashes per house style rules
  cleaned = cleaned.replace(/\u2014/g, ' ') // em dash -> space
  cleaned = cleaned.replace(/\u2013/g, '-') // en dash -> hyphen
  return cleaned
}

export function parseClaudeJsonOutput(raw: string): string | null {
  if (!raw || raw.trim() === '') return null
  const trimmed = raw.trim()

  // Try standard JSON array parsing
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const el = parsed[i]
        if (el && el.type === 'result' && typeof el.result === 'string') {
          return el.result
        }
      }
    }
  } catch {}

  // Fallback: try newline-separated JSON (NDJSON)
  try {
    const lines = trimmed.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line === '') continue
      try {
        const el = JSON.parse(line)
        if (el && el.type === 'result' && typeof el.result === 'string') {
          return el.result
        }
      } catch {}
    }
  } catch {}

  return null
}

export function parseActResult(text: string): ActResult | null {
  if (!text) return null
  const lines = text.split('\n')
  let lastLine = ''
  for (const line of lines) {
    if (line.trim().startsWith('ACT_RESULT:')) {
      lastLine = line.trim()
    }
  }
  if (!lastLine) return null

  // Format: "ACT_RESULT: <summary> | OUTPUT: <path>"
  const content = lastLine.substring('ACT_RESULT:'.length)
  const parts = content.split('|')
  let summary = ''
  let outputPath = ''

  if (parts.length >= 1) {
    summary = parts[0].trim()
  }
  if (parts.length >= 2) {
    const outPart = parts[1].trim()
    if (outPart.startsWith('OUTPUT:')) {
      outputPath = outPart.substring('OUTPUT:'.length).trim()
    } else {
      outputPath = outPart
    }
  }

  return {
    summary,
    outputPath: outputPath !== '' ? outputPath : null
  }
}
