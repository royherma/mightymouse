import type { ActionSlotOption } from './action-engine'

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'my',
  'me',
  'i',
  'can',
  'could',
  'would',
  'please',
  'you',
  'your',
  'for',
  'to',
  'of',
  'on',
  'in',
  'at',
  'it',
  'and',
  'or',
  'is',
  'are',
  'do',
  'does',
  'go'
])

// Coverage, not raw hit count: a 20-word page title that happens to contain
// "this" and "post" scored higher than the 3-word button the user actually
// meant, which put two headline links above "Bookmark this tab".
const HIT_WEIGHT = 20
const COVERAGE_WEIGHT = 100

// Added, not multiplied: a value the transcript never mentions scores 0, and
// any multiplier on 0 is 0, so a learned favourite could never climb.
const HABIT_WEIGHT = 30

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

// Chrome puts newlines in extension labels ("LastPass\nHas access to this site").
export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim()
}

export function overlapScore(said: readonly string[], label: string): number {
  const labelWords = words(label)
  if (labelWords.length === 0) return 0
  const hits = labelWords.filter((w) => said.includes(w)).length
  if (hits === 0) return 0
  return hits * HIT_WEIGHT + (hits / labelWords.length) * COVERAGE_WEIGHT
}

// Typed text is a prefix, not speech: "spar" must reach Spark, where
// overlapScore -- whole words, built for a transcript -- scores it zero.
export function filterOptions(
  options: readonly ActionSlotOption[],
  typed: string,
  limit: number
): ActionSlotOption[] {
  const needle = typed.trim().toLowerCase()
  if (needle === '') return options.slice(0, limit)

  const scored: { opt: ActionSlotOption; score: number; index: number }[] = []
  options.forEach((opt, index) => {
    const label = normalizeLabel(opt.label).toLowerCase()
    if (label.startsWith(needle)) scored.push({ opt, score: 2, index })
    else if (words(label).some((w) => w.startsWith(needle))) scored.push({ opt, score: 1, index })
    else if (label.includes(needle)) scored.push({ opt, score: 0, index })
  })

  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ opt }) => opt)
}

export function rankOptions(
  options: readonly ActionSlotOption[],
  transcript: string,
  limit: number,
  boost?: (value: string) => number
): ActionSlotOption[] {
  const said = words(transcript)

  const counts = new Map<string, number>()
  for (const opt of options) {
    const label = normalizeLabel(opt.label)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  const best = new Map<string, { opt: ActionSlotOption; score: number; index: number }>()

  options.forEach((opt, index) => {
    const label = normalizeLabel(opt.label)
    const raw = said.length === 0 ? 0 : overlapScore(said, label)
    const score = boost === undefined ? raw : raw + (boost(opt.value) - 1) * HABIT_WEIGHT
    const duplicated = (counts.get(label) ?? 0) > 1
    // Delete this and a shared label reaches the executor, which presses an arbitrary match.
    if (duplicated && score === 0) return

    const prior = best.get(label)
    if (prior === undefined || score > prior.score) {
      best.set(label, { opt, score, index })
    }
  })

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ opt }) => opt)
}
