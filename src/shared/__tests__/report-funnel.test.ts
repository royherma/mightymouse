import { describe, expect, it } from 'vitest'
import {
  cardTypical,
  parseReportConfig,
  reportFunnel,
  typicalGap,
  withGoal,
  type ProjectReport,
  type ReportCard,
  type ReportCardResult
} from '../reports'
import { metricById } from '../playbooks'

const BUYERS = 'store.visitors-who-buy'
const CARTS_LEFT = 'store.carts-left-behind'
const buyers = metricById(BUYERS)!
const allStores = buyers.benchmarks!.find((b) => !b.niche)!
const petStores = buyers.benchmarks!.find((b) => b.niche === 'Pet supplies')!

const card = (id: string, over: Partial<ReportCard> = {}): ReportCard => ({
  id,
  title: id,
  decides: '',
  run: 'node x.mjs',
  keys: [],
  unit: 'count',
  better: 'up',
  ...over
})

const ok = (value: number): ReportCardResult => ({ ok: true, output: { value }, ranAt: '', ms: 1 })
const failed: ReportCardResult = { ok: false, error: 'boom', ranAt: '', ms: 1 }

const report = (
  cards: ReportCard[],
  results: Record<string, ReportCardResult>,
  niche?: string
): ProjectReport => ({
  projectId: 'p',
  state: 'ready',
  problems: [],
  cards,
  results,
  range: 7,
  envs: [],
  running: false,
  keyNames: [],
  business: ['store'],
  ...(niche ? { brief: { niche } } : {})
})

const SHOP = [
  card('orders', { step: 4, of: 'visitors', rate: BUYERS }),
  card('spend', { step: 1, unit: 'usd' }),
  card('emails', { step: 3 }),
  card('visitors', { step: 2 }),
  card('uptime', { unit: 'percent' })
]
const shopResults = (orders: number): Record<string, ReportCardResult> => ({
  spend: ok(500),
  visitors: ok(1000),
  emails: ok(100),
  orders: ok(orders),
  uptime: ok(99)
})

describe('reportFunnel', () => {
  it('orders the steps by their step number and leaves unnumbered cards out', () => {
    const { steps } = reportFunnel(report(SHOP, shopResults(10)))
    expect(steps.map((s) => s.card.id)).toEqual(['spend', 'visitors', 'emails', 'orders'])
  })

  it('a step after money shows the cost of each one', () => {
    const { steps } = reportFunnel(report(SHOP, shopResults(10)))
    expect(steps[1].each).toBe(0.5)
    expect(steps[1].share).toBeUndefined()
  })

  it('a step is a share of the step before it, or of the step it names', () => {
    const { steps } = reportFunnel(report(SHOP, shopResults(10)))
    expect(steps[2].share).toMatchObject({ value: 10 })
    expect(steps[2].share?.of.id).toBe('visitors')
    expect(steps[3].share).toMatchObject({ value: 1 })
    expect(steps[3].share?.of.id).toBe('visitors')
  })

  it('bar widths scale to the biggest count, with a floor so a tiny step stays visible', () => {
    const { steps } = reportFunnel(report(SHOP, shopResults(10)))
    expect(steps.map((s) => s.width)).toEqual([100, 100, 10, 7])
  })

  it('names the step losing the most people against typical as the leak', () => {
    const { steps, leak } = reportFunnel(report(SHOP, shopResults(10)))
    expect(leak?.card.id).toBe('orders')
    expect(steps[3].typical).toMatchObject({ benchmark: allStores, behind: true })
    expect(steps[3].typical?.expected).toBeCloseTo((1000 * allStores.value) / 100, 6)
  })

  it('measures against the project niche when it has one', () => {
    const { steps } = reportFunnel(report(SHOP, shopResults(10), 'pet supplies'))
    expect(steps[3].typical?.benchmark).toBe(petStores)
    expect(steps[3].typical?.expected).toBeCloseTo((1000 * petStores.value) / 100, 6)
  })

  it('reports no leak when the step beats typical', () => {
    const { steps, leak } = reportFunnel(report(SHOP, shopResults(40)))
    expect(steps[3].typical?.behind).toBe(false)
    expect(leak).toBeUndefined()
  })

  it('a lower-is-better step can be behind but is never the leak', () => {
    const cards = [
      card('visitors', { step: 1 }),
      card('carts', { step: 2 }),
      card('abandoned', { step: 3, rate: CARTS_LEFT, better: 'down' })
    ]
    const high = reportFunnel(report(cards, { visitors: ok(1000), carts: ok(100), abandoned: ok(95) }))
    expect(high.steps[2].typical?.behind).toBe(true)
    expect(high.leak).toBeUndefined()
    const low = reportFunnel(report(cards, { visitors: ok(1000), carts: ok(100), abandoned: ok(40) }))
    expect(low.steps[2].typical?.behind).toBe(false)
  })

  it('needs three working steps: a failed card drops out and a two-step funnel is not drawn', () => {
    const four = reportFunnel(report(SHOP, { ...shopResults(10), emails: failed }))
    expect(four.steps.map((s) => s.card.id)).toEqual(['spend', 'visitors', 'orders'])
    const two = reportFunnel(report(SHOP, { ...shopResults(10), emails: failed, spend: failed }))
    expect(two).toEqual({ steps: [] })
  })

  it('does not divide by an empty step', () => {
    const none = reportFunnel(report(SHOP, { ...shopResults(10), visitors: ok(0) }))
    expect(none.steps[1].each).toBeUndefined()
    expect(none.steps[2].share).toBeUndefined()
    expect(none.steps[3].share).toBeUndefined()
  })
})

describe('withGoal', () => {
  const cards = [card('revenue', { hero: true }), card('buyers', { metric: BUYERS, target: 2 })]

  it('makes the goal card the headline and gives it the goal number', () => {
    const out = withGoal(cards, { goal: { metric: BUYERS, target: 3.5 } })
    expect(out.find((c) => c.id === 'buyers')).toMatchObject({ hero: true, target: 3.5 })
    expect(out.find((c) => c.id === 'revenue')?.hero).toBeUndefined()
  })

  it('a goal with no number keeps the card target', () => {
    const out = withGoal(cards, { goal: { metric: BUYERS } })
    expect(out.find((c) => c.id === 'buyers')?.target).toBe(2)
  })

  it('leaves the cards alone when no card measures the goal, or there is no goal', () => {
    expect(withGoal(cards, { goal: { metric: CARTS_LEFT, target: 50 } })).toBe(cards)
    expect(withGoal(cards, { what: 'Shop' })).toBe(cards)
    expect(withGoal(cards, undefined)).toBe(cards)
  })
})

describe('cardTypical', () => {
  it('finds the typical value for a tagged card, by niche', () => {
    const tagged = card('buyers', { metric: BUYERS, unit: 'percent' })
    expect(cardTypical(tagged)?.typical).toBe(allStores)
    expect(cardTypical(tagged, 'Pet supplies')?.typical).toBe(petStores)
  })

  it('shows nothing when the card is in a different unit than the benchmark, or untagged', () => {
    expect(cardTypical(card('buyers', { metric: BUYERS, unit: 'count' }))).toBeUndefined()
    expect(cardTypical(card('buyers', { unit: 'percent' }))).toBeUndefined()
  })
})

describe('typicalGap', () => {
  const percent = card('buyers', { unit: 'percent' })

  it('speaks in points for percent cards, singular for exactly one', () => {
    expect(typicalGap(percent, 3.7, 2.7)).toBe('You are 1 point over typical.')
    expect(typicalGap(percent, 1.2, 2.7)).toBe('You are 1.5 points under typical.')
  })

  it('a gap that rounds to nothing is right at typical', () => {
    expect(typicalGap(percent, 2.74, 2.7)).toBe('You are right at typical.')
  })

  it('uses the card unit for anything else', () => {
    expect(typicalGap(card('aov', { unit: 'usd' }), 80, 60)).toBe('You are $20 over typical.')
  })
})

describe('parseReportConfig funnel and benchmark tags', () => {
  const parse = (extra: Record<string, unknown>): ReportCard =>
    parseReportConfig(JSON.stringify({ cards: [{ id: 'a', title: 'A', run: 'node a.mjs', ...extra }] })).cards[0]

  it('keeps a known metric id and drops one the app does not know', () => {
    expect(parse({ metric: BUYERS, rate: CARTS_LEFT })).toMatchObject({ metric: BUYERS, rate: CARTS_LEFT })
    const unknown = parse({ metric: 'store.made-up', rate: 'nope' })
    expect(unknown.metric).toBeUndefined()
    expect(unknown.rate).toBeUndefined()
  })

  it('takes a step only as a number', () => {
    expect(parse({ step: 2, of: ' visitors ' })).toMatchObject({ step: 2, of: 'visitors' })
    expect(parse({ step: '2' }).step).toBeUndefined()
    expect(parse({ step: null }).step).toBeUndefined()
  })

  it('keeps only an https link', () => {
    expect(parse({ link: 'https://dash.example.com/a' }).link).toBe('https://dash.example.com/a')
    for (const link of ['http://dash.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 42]) {
      expect(parse({ link }).link, String(link)).toBeUndefined()
    }
  })
})
