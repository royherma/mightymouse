export const TRANSCRIPT_FORMAT_KEY = 'transcriptFormat:'

export interface TranscriptFormat {
  id: string
  title: string
  hint: string
  defaultOn: boolean
  /** Spoken phrases that switch it on for one dictation. Absent = runs on every dictation. */
  triggers?: string[]
  englishOnly?: boolean
  apply: (text: string) => string
}

const FILLER = String.raw`\b(?:u+m+|u+h+m*|e+rm+|e{2,}r+|h+m{2,}|m{3,})\b`
const LEADING_FILLER = new RegExp(String.raw`(^|[.!?]\s+)(?:${FILLER}[,.]?\s*)+([a-z]?)`, 'gi')
const INNER_FILLER = new RegExp(String.raw`(?:\s*,)?\s*${FILLER}(?:\s*,)?(?=\s|[.!?]|$)`, 'gi')

export function stripFillers(text: string): string {
  return tidy(
    text
      .replace(LEADING_FILLER, (_, lead: string, next: string) => lead + next.toUpperCase())
      .replace(INNER_FILLER, '')
  )
}

export function casual(text: string): string {
  return tidy(text.toLowerCase().replace(/[.,;:!]+(?=\s|$)/g, ''))
}

export function dropLonePeriod(text: string): string {
  const trimmed = text.trimEnd()
  const body = trimmed.replace(/\.+$/, '')
  if (body === trimmed || /[.!?]\s/.test(body)) return text
  return body
}

export const TRANSCRIPT_FORMATS: TranscriptFormat[] = [
  {
    id: 'fillers',
    title: 'Remove ums and uhs',
    hint: 'Your dictation pastes without the um, uh and hmm.',
    defaultOn: true,
    englishOnly: true,
    apply: stripFillers
  },
  {
    id: 'bro',
    title: 'Bro mode',
    hint: 'Say "bro mode" while you talk and it pastes all lowercase with barely any punctuation. Made for texts and Slack.',
    defaultOn: true,
    triggers: ['bro mode', 'bro mod'],
    apply: casual
  },
  {
    id: 'lonePeriod',
    title: 'No period on one-liners',
    hint: 'A single sentence pastes without the period at the end. Question marks and exclamation points stay.',
    defaultOn: true,
    apply: dropLonePeriod
  }
]

export function isFormatOn(f: TranscriptFormat, saved: Record<string, boolean> | undefined): boolean {
  return saved?.[f.id] ?? f.defaultOn
}

function tidy(text: string): string {
  return text
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/^[\s.,;:!?]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function triggerPattern(phrase: string): RegExp {
  const words = phrase.split(/\s+/).map((w) => w.replace(/[^a-z0-9]/gi, ''))
  return new RegExp(String.raw`[,.!?]*\s*\b${words.join(String.raw`[\s\-]*`)}\b[,.!?]*`, 'gi')
}

export function formatTranscript(
  text: string,
  lang: string,
  saved: Record<string, boolean> | undefined
): string {
  let out = text
  const fired: TranscriptFormat[] = []
  for (const f of TRANSCRIPT_FORMATS) {
    if (!isFormatOn(f, saved) || (f.englishOnly && lang !== 'en')) continue
    if (!f.triggers) {
      out = f.apply(out)
      continue
    }
    const before = out
    for (const phrase of f.triggers) out = out.replace(triggerPattern(phrase), ' ')
    if (out !== before) fired.push(f)
  }
  for (const f of fired) out = f.apply(out)
  return fired.length ? tidy(out) : out
}
