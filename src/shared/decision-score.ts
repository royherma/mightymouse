export const DECISION_ANGLES = ['fast', 'cheap', 'undo', 'lasts', 'handsoff'] as const
export type DecisionAngle = (typeof DECISION_ANGLES)[number]
export type DecisionWeights = Record<DecisionAngle, number>

export const DECISION_ANGLE_LABEL: Record<DecisionAngle, string> = {
  fast: 'Fast',
  cheap: 'Cheap',
  undo: 'Undoable',
  lasts: 'Lasts',
  handsoff: 'Hands-off'
}

export const DECISION_ANGLE_HINT: Record<DecisionAngle, string> = {
  fast: 'Done today?',
  cheap: 'Costs anything extra?',
  undo: 'Easy to walk back?',
  lasts: 'Right way long term?',
  handsoff: 'How much of your time'
}

export const YOU_USUALLY_MIN_DECISIONS = 20
const SOFTMAX_TEMPERATURE = 5
const LEARN_PRIOR = 2

export interface DecisionInput {
  weights: DecisionWeights
  scores: number[][]
  notes?: Partial<Record<DecisionAngle, string>>
}

export interface DecisionWire extends DecisionInput {
  totals: number[]
  pcts: number[]
  best: number
  lead: number
  youIdx?: number
  youWeights?: DecisionWeights
  history?: { agreed: number; of: number }
}

export interface DecisionScore {
  totals: number[]
  pcts: number[]
  best: number
  lead: number
}

export function totalsFor(weights: DecisionWeights, scores: number[][]): number[] {
  return scores.map((row) => DECISION_ANGLES.reduce((sum, a, i) => sum + (row[i] ?? 0) * weights[a] / 100, 0))
}

export function scoreDecision(weights: DecisionWeights, scores: number[][]): DecisionScore {
  const totals = totalsFor(weights, scores)
  const top = Math.max(...totals)
  const exps = totals.map((t) => Math.exp((t - top) / SOFTMAX_TEMPERATURE))
  const sumExp = exps.reduce((a, b) => a + b, 0)
  const pcts = exps.map((e) => Math.round((e / sumExp) * 100))
  const best = totals.indexOf(top)
  pcts[best] += 100 - pcts.reduce((a, b) => a + b, 0)
  const second = Math.max(...totals.filter((_, i) => i !== best), -Infinity)
  const lead = Number.isFinite(second) ? Math.round(top - second) : 0
  return { totals, pcts, best, lead }
}

export function decisionInputError(
  optionCount: number,
  weights: Partial<Record<string, number>>,
  scores: number[][]
): string | null {
  const missing = DECISION_ANGLES.filter((a) => typeof weights[a] !== 'number')
  if (missing.length) return `weights is missing ${missing.join(', ')}. Send all five: ${DECISION_ANGLES.join(', ')}.`
  const sum = DECISION_ANGLES.reduce((s, a) => s + (weights[a] ?? 0), 0)
  if (Math.abs(sum - 100) > 1) return `weights add up to ${sum}. They must add up to 100.`
  if (optionCount < 2) return 'scores needs at least 2 options to compare.'
  if (scores.length !== optionCount) {
    return `scores has ${scores.length} rows but there are ${optionCount} options. Send one row per option, in the same order.`
  }
  const bad = scores.findIndex((row) => row.length !== DECISION_ANGLES.length)
  if (bad !== -1) return `scores row ${bad + 1} has ${scores[bad].length} numbers. Each row needs 5: ${DECISION_ANGLES.join(', ')}.`
  return null
}

export function learnYourWeights(rows: { scores: number[][]; picked: number }[]): DecisionWeights {
  const lift = DECISION_ANGLES.map((_, a) => {
    if (!rows.length) return 0
    const sum = rows.reduce((acc, { scores, picked }) => {
      const mean = scores.reduce((s, r) => s + (r[a] ?? 0), 0) / scores.length
      return acc + Math.max(0, (scores[picked]?.[a] ?? 0) - mean)
    }, 0)
    return sum / rows.length
  })
  const withPrior = lift.map((v) => v + LEARN_PRIOR)
  const total = withPrior.reduce((a, b) => a + b, 0)
  return Object.fromEntries(DECISION_ANGLES.map((a, i) => [a, Math.round((withPrior[i] / total) * 100)])) as DecisionWeights
}

export function radarPoints(values: number[], cx: number, cy: number, r: number): [number, number][] {
  return values.map((v, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / DECISION_ANGLES.length
    return [
      Math.round((cx + Math.cos(angle) * r * v / 100) * 10) / 10,
      Math.round((cy + Math.sin(angle) * r * v / 100) * 10) / 10
    ]
  })
}

export function anglesByWeight(weights: DecisionWeights): DecisionAngle[] {
  return DECISION_ANGLES.map((a, i) => ({ a, i })).sort((x, y) => weights[y.a] - weights[x.a] || x.i - y.i).map((x) => x.a)
}

export function joinAnd(xs: string[]): string {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

export function winsLine(d: DecisionWire, cmp: number, keys: string[]): string {
  const won = DECISION_ANGLES.filter((_, a) => d.scores[d.best][a] > d.scores[cmp][a]).map((a) => DECISION_ANGLE_LABEL[a])
  const lost = DECISION_ANGLES.filter((_, a) => d.scores[d.best][a] < d.scores[cmp][a]).map((a) => DECISION_ANGLE_LABEL[a])
  return `${keys[d.best]} wins on ${joinAnd(won) || 'nothing'}${lost.length ? `. ${keys[cmp]} wins on ${joinAnd(lost)}.` : '.'}`
}

export function youLine(d: DecisionWire, keys: string[]): string {
  if (d.youIdx === undefined) return ''
  const w = d.youWeights
  const top = w ? DECISION_ANGLE_LABEL[anglesByWeight(w)[0]].toLowerCase() : null
  if (d.youIdx === d.best) return top ? `You usually weigh ${top} most, and so does ${keys[d.best]}.` : ''
  return top ? `You usually weigh ${top} most - so ${keys[d.youIdx]} gets the You usually tag.` : ''
}

export function historyLine(d: DecisionWire): string {
  return d.history ? `You went with the model's pick in ${d.history.agreed} of your last ${d.history.of} decisions.` : ''
}
