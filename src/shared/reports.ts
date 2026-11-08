import { GOAL_LIVE, type BusinessType, type ProjectBrief } from './infra'
import { KEYCHAIN_SERVICE } from './keys'
import {
  BUSINESS_PLAYBOOKS,
  metricById,
  projectFacts,
  typicalFor,
  type Benchmark,
  type BusinessMetric
} from './playbooks'

export const REPORTS_CONFIG_PATH = '.mightymouse/reports.json'
export const REPORTS_SCRIPTS_DIR = '.mightymouse/reports'
export const REPORT_RANGES = [7, 30] as const
export const REPORT_STALE_MS = 15 * 60_000
export const REPORT_CARD_TIMEOUT_MS = 20_000
export const REPORT_MAX_CARDS = 12
export const REPORT_ROWS_SHOWN = 6
const WORSE_THRESHOLD = 0.1

export type ReportRange = (typeof REPORT_RANGES)[number]
export type ReportUnit = 'count' | 'usd' | 'percent' | 'ms'
export type ReportBetter = 'up' | 'down'

export interface ReportCard {
  id: string
  title: string
  decides: string
  run: string
  keys: string[]
  unit: ReportUnit
  better: ReportBetter
  hero?: boolean
  target?: number
  metric?: string
  step?: number
  of?: string
  rate?: string
  provider?: string
  link?: string
}

export interface ReportOutput {
  value: number
  previous?: number
  target?: number
  note?: string
  series?: [string, number][]
  rows?: [string, number][]
}

export type ReportCardResult =
  | { ok: true; output: ReportOutput; ranAt: string; ms: number }
  | {
      ok: false
      error: string
      missingKey?: string
      ranAt: string
      ms: number
      lastGood?: { output: ReportOutput; ranAt: string }
    }

export type ReportState = 'no-folder' | 'none' | 'invalid' | 'ready'

export interface ProjectReport {
  projectId: string
  state: ReportState
  problems: string[]
  cards: ReportCard[]
  results: Record<string, ReportCardResult>
  range: ReportRange
  envs: string[]
  env?: string
  refreshedAt?: string
  running: boolean
  keyNames: string[]
  business: BusinessType[]
  brief?: ProjectBrief
}

export type ReportCardStatus = 'broken' | 'off-target' | 'worse' | 'ok' | 'waiting'

const UNITS: ReportUnit[] = ['count', 'usd', 'percent', 'ms']
const ID_RE = /^[a-z0-9][a-z0-9-_]{0,39}$/i
const KEY_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const ENV_RE = /^[a-z][a-z0-9-]{0,19}$/

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function parseReportConfig(
  raw: string,
  env?: string
): { cards: ReportCard[]; problems: string[]; envs: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return {
      cards: [],
      envs: [],
      problems: [`${REPORTS_CONFIG_PATH} is not valid JSON: ${(e as Error).message}`]
    }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { cards?: unknown })?.cards
  if (!Array.isArray(list))
    return { cards: [], envs: [], problems: [`${REPORTS_CONFIG_PATH} has no "cards" list.`] }
  const envs = envList((parsed as { envs?: unknown })?.envs)
  const active = env && envs.includes(env) ? env : envs[0]

  const problems: string[] = []
  const cards: ReportCard[] = []
  const seen = new Set<string>()
  for (const [i, c] of (list as Record<string, unknown>[]).entries()) {
    const where = `Card ${i + 1}`
    const id = text(c?.id, 40)
    const title = text(c?.title, 60)
    const run = text(c?.run, 2000)
    const problem = !ID_RE.test(id)
      ? `${where} needs an "id" (letters, numbers, dashes).`
      : seen.has(id)
        ? `${where}: "${id}" is used twice.`
        : !title
          ? `${where} ("${id}") needs a "title".`
          : !run
            ? `${where} ("${id}") needs a "run" command.`
            : null
    if (problem) {
      problems.push(problem)
      continue
    }
    seen.add(id)
    const cardEnvs = envList(c.envs)
    if (active && cardEnvs.length && !cardEnvs.includes(active)) continue
    const keys = keyList(c.keys, active)
    const link = text(c.link, 500)
    cards.push({
      id,
      title,
      run,
      decides: text(c.decides, 140),
      keys,
      unit: UNITS.includes(c.unit as ReportUnit) ? (c.unit as ReportUnit) : 'count',
      better: c.better === 'down' ? 'down' : 'up',
      hero: c.hero === true || undefined,
      target: finite(c.target) ? c.target : undefined,
      metric: metricById(text(c.metric, 60))?.id,
      step: finite(c.step) ? c.step : undefined,
      of: text(c.of, 40) || undefined,
      rate: metricById(text(c.rate, 60))?.id,
      provider: text(c.provider, 40) || undefined,
      link: /^https:\/\//.test(link) ? link : undefined
    })
  }
  if (!cards.length && !problems.length) problems.push(`${REPORTS_CONFIG_PATH} has no cards yet.`)
  if (cards.length > REPORT_MAX_CARDS)
    problems.push(`Only the first ${REPORT_MAX_CARDS} cards are shown.`)
  return { cards: cards.slice(0, REPORT_MAX_CARDS), problems, envs }
}

function envList(v: unknown): string[] {
  return Array.isArray(v)
    ? [...new Set(v.filter((e): e is string => typeof e === 'string' && ENV_RE.test(e)))]
    : []
}

function keyList(v: unknown, env: string | undefined): string[] {
  const list = Array.isArray(v)
    ? v
    : v && typeof v === 'object' && env
      ? (v as Record<string, unknown>)[env]
      : []
  return Array.isArray(list)
    ? list.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k))
    : []
}

function pairs(v: unknown, max: number): [string, number][] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter(
      (p): p is [unknown, number] =>
        Array.isArray(p) && p.length >= 2 && p[0] != null && p[0] !== '' && finite(p[1])
    )
    .map(([k, n]) => [String(k).slice(0, 80), n] as [string, number])
  return out.length ? out.slice(-max) : undefined
}

export function parseReportOutput(stdout: string): ReportOutput | string {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (!finite(parsed.value)) return 'The script printed JSON without a number in "value".'
    return {
      value: parsed.value,
      previous: finite(parsed.previous) ? parsed.previous : undefined,
      target: finite(parsed.target) ? parsed.target : undefined,
      note: text(parsed.note, 80) || undefined,
      series: pairs(parsed.series, 400),
      rows: pairs(parsed.rows, 50)?.sort((a, b) => b[1] - a[1])
    }
  }
  return lines.length
    ? 'The script did not print a JSON line like {"value": 12}.'
    : 'The script printed nothing.'
}

export function reportDelta(output: ReportOutput): number | null {
  if (output.previous === undefined) return null
  if (output.previous === 0) return output.value === 0 ? 0 : null
  return (output.value - output.previous) / Math.abs(output.previous)
}

export function reportTarget(card: ReportCard, output: ReportOutput): number | undefined {
  return output.target ?? card.target
}

export function meetsTarget(card: ReportCard, output: ReportOutput): boolean | null {
  const target = reportTarget(card, output)
  if (target === undefined) return null
  return card.better === 'up' ? output.value >= target : output.value <= target
}

export function cardStatus(
  card: ReportCard,
  result: ReportCardResult | undefined
): ReportCardStatus {
  if (!result) return 'waiting'
  if (!result.ok) return 'broken'
  if (meetsTarget(card, result.output) === false) return 'off-target'
  const delta = reportDelta(result.output)
  if (delta !== null && (card.better === 'up' ? -delta : delta) >= WORSE_THRESHOLD) return 'worse'
  return 'ok'
}

export function heroCard(cards: ReportCard[]): ReportCard | undefined {
  return cards.find((c) => c.hero) ?? cards[0]
}

export function withGoal(cards: ReportCard[], brief: ProjectBrief | undefined): ReportCard[] {
  const goal = brief?.goal
  if (!goal || !cards.some((c) => c.metric === goal.metric)) return cards
  return cards.map((c) =>
    c.metric === goal.metric
      ? { ...c, hero: true, target: goal.target ?? c.target }
      : { ...c, hero: undefined }
  )
}

export function cardTypical(
  card: ReportCard,
  niche?: string
): { metric: BusinessMetric; typical: Benchmark } | undefined {
  const metric = metricById(card.metric)
  const typical = metric && metric.unit === card.unit ? typicalFor(metric, niche) : undefined
  return metric && typical ? { metric, typical } : undefined
}

const CURVE_POINTS = 40
const CURVE_TOP_QUARTER_Z = 0.674
const CURVE_SPREAD = 0.45
const CURVE_REACH = 2.4

export interface StandCurve {
  path: string
  x: (value: number) => number
  y: (value: number) => number
}

export function standCurve(you: number, typical: number, top?: number): StandCurve {
  const spread =
    (top !== undefined ? Math.abs(top - typical) / CURVE_TOP_QUARTER_Z : 0) ||
    Math.abs(typical) * CURVE_SPREAD ||
    1
  const min = Math.min(0, you, typical - CURVE_REACH * spread)
  const max = Math.max(you, top ?? typical, typical + CURVE_REACH * spread)
  const pad = (max - min) * 0.04
  const lo = min < 0 ? min - pad : 0
  const hi = max + pad
  const x = (value: number): number => ((value - lo) / (hi - lo)) * 100
  const y = (value: number): number => 100 - 86 * Math.exp(-0.5 * ((value - typical) / spread) ** 2)
  const path = Array.from({ length: CURVE_POINTS + 1 }, (_, i) => {
    const value = lo + ((hi - lo) * i) / CURVE_POINTS
    return `${i ? 'L' : 'M'}${x(value).toFixed(2)} ${y(value).toFixed(2)}`
  }).join(' ')
  return { path, x, y }
}

export interface FunnelStep {
  card: ReportCard
  output: ReportOutput
  width: number
  share?: { of: ReportCard; value: number }
  each?: number
  typical?: { metric: BusinessMetric; benchmark: Benchmark; expected: number; behind: boolean }
}

const FUNNEL_MIN_STEPS = 3
const FUNNEL_MIN_WIDTH = 7

export function reportFunnel(report: ProjectReport): { steps: FunnelStep[]; leak?: FunnelStep } {
  const live = report.cards
    .filter((c) => c.step !== undefined)
    .sort((a, b) => (a.step as number) - (b.step as number))
    .flatMap((card) => {
      const result = report.results[card.id]
      return result?.ok ? [{ card, output: result.output }] : []
    })
  if (live.length < FUNNEL_MIN_STEPS) return { steps: [] }
  const most = Math.max(...live.filter((s) => s.card.unit === 'count').map((s) => s.output.value), 1)
  const steps = live.map(({ card, output }, i): FunnelStep => {
    const before = live[i - 1]
    const base = live.find((s) => s.card.id === card.of) ?? before
    const counted = card.unit === 'count'
    const width = counted ? Math.max(FUNNEL_MIN_WIDTH, (output.value / most) * 100) : 100
    if (!counted || !base) return { card, output, width }
    if (base.card.unit === 'usd')
      return { card, output, width, each: output.value > 0 ? base.output.value / output.value : undefined }
    if (base.card.unit !== 'count' || base.output.value <= 0) return { card, output, width }
    const metric = metricById(card.rate)
    const benchmark = metric?.unit === 'percent' ? typicalFor(metric, report.brief?.niche) : undefined
    const expected = benchmark ? (base.output.value * benchmark.value) / 100 : 0
    return {
      card,
      output,
      width,
      share: { of: base.card, value: (output.value / base.output.value) * 100 },
      ...(metric && benchmark
        ? {
            typical: {
              metric,
              benchmark,
              expected,
              behind: metric.better === 'down' ? output.value > expected : output.value < expected
            }
          }
        : {})
    }
  })
  const missing = (s: FunnelStep): number =>
    s.typical?.behind && s.typical.metric.better !== 'down'
      ? Math.round(s.typical.expected - s.output.value)
      : 0
  const leak = [...steps].sort((a, b) => missing(b) - missing(a))[0]
  return { steps, leak: leak && missing(leak) >= 1 ? leak : undefined }
}

export function typicalGap(card: ReportCard, value: number, typical: number): string {
  const gap = Math.round((value - typical) * 10) / 10
  if (gap === 0) return 'You are right at typical.'
  const size =
    card.unit === 'percent'
      ? `${Math.abs(gap)} ${Math.abs(gap) === 1 ? 'point' : 'points'}`
      : formatReportValue(Math.abs(gap), card.unit)
  return `You are ${size} ${gap > 0 ? 'over' : 'under'} typical.`
}

export function formatReportValue(value: number, unit: ReportUnit): string {
  const abs = Math.abs(value)
  const compact = (n: number): string =>
    abs >= 1e6
      ? `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
      : abs >= 1e4
        ? `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`
        : n.toLocaleString('en-US', {
            maximumFractionDigits: abs < 10 && !Number.isInteger(n) ? 2 : 0
          })
  if (unit === 'usd') return `${value < 0 ? '-' : ''}$${compact(abs)}`
  if (unit === 'percent')
    return `${Number.isInteger(value) || abs >= 100 ? Math.round(value) : value.toFixed(1)}%`
  if (unit === 'ms') return abs >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`
  return compact(value)
}

export function formatReportDelta(delta: number): string {
  const pct = Math.abs(delta) < 0.01 ? Math.round(delta * 1000) / 10 : Math.round(delta * 100)
  return `${pct > 0 ? '+' : ''}${pct}%`
}

function keychainLine(names: string[]): string {
  if (!names.length) return 'No keys are saved in MightyMouse Keys for this project yet.'
  return `Keys saved in MightyMouse Keys you can use: ${names.join(', ')}. To test with one without printing it: ${names[0]}="$(security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${names[0]} -w)" REPORT_DAYS=7 node ${REPORTS_SCRIPTS_DIR}/<id>.mjs`
}

const OUTPUT_SHAPE =
  '{"value":n,"previous":n,"target":n,"note":"one short line, only if needed","series":[["YYYY-MM-DD",n],...],"rows":[["label",n],...]}'
const CARD_SHAPE = `{"cards":[{"id":"signups","title":"Signups","decides":"Keep or cut the ad spend","run":"node ${REPORTS_SCRIPTS_DIR}/signups.mjs","keys":["POSTHOG_API_KEY"],"unit":"count","better":"up","hero":true,"link":"https://dashboard-url"}]}`

function metricTags(business: BusinessType[], brief: ProjectBrief | undefined): string {
  const known = business.flatMap((type) => BUSINESS_PLAYBOOKS[type].metrics.filter((m) => m.benchmarks))
  if (!known.length) return ''
  const goal = brief?.goal && brief.goal.metric !== GOAL_LIVE ? metricById(brief.goal.metric) : undefined
  return `   When a card measures one of these, add "metric" with its id so the card can show the typical value next to ours, and keep the unit shown: ${known
    .map((m) => `${m.id} = ${m.label} (${m.unit})`)
    .join('; ')}.${goal ? ` The goal is ${goal.label}: build that card first, tag it "${goal.id}" and mark it "hero".` : ''}`
}

export function reportsSetupPrompt(
  keyNames: string[],
  business: BusinessType[] = [],
  brief?: ProjectBrief
): string {
  const facts = projectFacts(business, brief)
  const tags = metricTags(business, brief)
  return [
    'Set up MightyMouse Reports for this project: the 3-6 numbers that decide what we do next.',
    ...(facts ? [`${facts} Start from these numbers wherever this project has the data for them.`] : []),
    '1. Read .mightymouse/stack.json if it exists, and the code, to see which analytics, payments and error services this project really uses and has data in.',
    '2. Pick 3-6 numbers from first principles. Each one must drive a decision someone makes this month - write that decision in "decides", e.g. "Keep or cut the Meta ad spend". A number with no decision does not go in: no all-time totals, no numbers that only go up. Mark the one that says whether the project is working as "hero".',
    `3. For each, write ${REPORTS_SCRIPTS_DIR}/<id>.mjs (plain Node 18+, fetch only, no npm installs) whose LAST stdout line is ${OUTPUT_SHAPE}. value = the last REPORT_DAYS days (env var, 7 or 30); previous = the REPORT_DAYS before that; target = the goal for that same range, only if there is an honest one; series = one point per day; rows = a top-N breakdown only if it helps the decision. On any failure print one plain line to stderr and exit 1 - never print 0 for a source that failed.`,
    `4. Read keys only from env vars and list their names in "keys"; the app passes only those. ${keychainLine(keyNames)} The app also reads a missing key from this project's .env files. Never write a key value into a file or this chat.`,
    `5. Write ${REPORTS_CONFIG_PATH} in this shape: ${CARD_SHAPE}. unit is count, usd, percent or ms; better is up or down.`,
    `   If the project has separate environments (e.g. production and staging, each with its own database or Stripe account), add "envs":["prod","staging"] at the top. The app passes REPORT_ENV to every script; make "keys" an object per environment, e.g. {"prod":["STRIPE_LIVE_KEY"],"staging":["STRIPE_TEST_KEY"]}, and give a card "envs":["prod"] if it only exists in one. Test each environment. One environment: leave "envs" out.`,
    ...(tags ? [tags] : []),
    '   If some of the numbers are steps people walk in order (e.g. ad spend, then visitors, then emails, then orders), give those cards "step":1, "step":2 and so on, with unit count for people and usd for money, so the app can draw where people drop off. When a step is a share of an earlier step that is not the one right before it, add "of":"<that card id>". When one of the percent ids above measures that share, add "rate":"<that id>".',
    '6. Run every script once with REPORT_DAYS=7 and show me each value next to the dashboard page where I can check it. Drop a card you cannot make return a real number rather than faking it.',
    'If a key is missing, stop and tell me in one line which key and where to get it; I will save it in MightyMouse Keys.'
  ].join('\n')
}

export function reportsFixPrompt(card: ReportCard, error: string, env?: string): string {
  return [
    `The Reports card "${card.title}" (id ${card.id} in ${REPORTS_CONFIG_PATH}) fails${env ? ` in ${env}` : ''}: ${error}`,
    `Run \`${card.run}\` with REPORT_DAYS=7${env ? ` REPORT_ENV=${env}` : ''}, find why, and fix it so its last stdout line is ${OUTPUT_SHAPE} with the real number. Never print 0 to hide a failure.`,
    card.keys.length ? `It reads ${card.keys.join(', ')}. ${keychainLine(card.keys)}` : '',
    'If a key is missing or expired, stop and tell me in one line which key and where to get it; I will save it in MightyMouse Keys.'
  ]
    .filter(Boolean)
    .join('\n')
}

export function reportsPlanPrompt(card: ReportCard, output: ReportOutput, env?: string): string {
  const target = reportTarget(card, output)
  const delta = reportDelta(output)
  return [
    `The Reports number "${card.title}" (id ${card.id} in ${REPORTS_CONFIG_PATH}) is ${formatReportValue(output.value, card.unit)}${env ? ` in ${env}` : ''}${target !== undefined ? `, target ${formatReportValue(target, card.unit)}` : ''}${delta !== null ? `, ${formatReportDelta(delta)} vs the previous period` : ''}.`,
    `It is there to decide: "${card.decides}".`,
    'Find what drives this number in this project, then give me 2-3 options with the one you recommend and what each costs. Do not change anything until I pick one.'
  ].join('\n')
}

export function reportsConfigFixPrompt(problems: string[]): string {
  return [
    `${REPORTS_CONFIG_PATH} has problems, so MightyMouse Reports shows no numbers:`,
    ...problems.map((p) => `- ${p}`),
    `Fix the file so it matches ${CARD_SHAPE}, run every card's script once with REPORT_DAYS=7, and keep only cards that print a real number.`
  ].join('\n')
}

const ENV_LABELS: Record<string, string> = {
  prod: 'Production',
  production: 'Production',
  staging: 'Staging',
  dev: 'Dev'
}

export function reportEnvLabel(env: string): string {
  return ENV_LABELS[env] ?? env.charAt(0).toUpperCase() + env.slice(1)
}

export function needsDecision(status: ReportCardStatus): boolean {
  return status === 'broken' || status === 'off-target' || status === 'worse'
}
