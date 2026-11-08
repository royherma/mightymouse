import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_ROOT = join(tmpdir(), 'mm-agent-relay-decision-test')

vi.mock('../../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../store/paths')>()
  return {
    ...actual,
    PATHS: { ...actual.PATHS, ROOT: TEST_ROOT, AGENT_RELAY_LOG: join(TEST_ROOT, 'agent-relay-log.jsonl') }
  }
})

vi.mock('../../relay-send', () => ({
  agentRelayOffReason: () => null,
  sendRelayPush: async () => ({ ok: true, deviceLabel: "Pat's iPhone" })
}))
vi.mock('../../../platform', () => ({ captureScreenshot: async () => null }))

const RAMP = {
  weights: { fast: 20, cheap: 25, undo: 15, lasts: 30, handsoff: 10 },
  scores: [
    [80, 75, 55, 80, 80],
    [75, 50, 95, 60, 75],
    [100, 40, 90, 20, 100]
  ]
}
const OPTIONS = ['sqlite', 'postgres', 'json file']

describe('ask with weights and scores', () => {
  let mod: typeof import('../verbs')
  let store: typeof import('../../store')

  beforeEach(async () => {
    rmSync(TEST_ROOT, { recursive: true, force: true })
    mkdirSync(TEST_ROOT, { recursive: true })
    vi.useFakeTimers()
    vi.resetModules()
    store = await import('../../store')
    mod = await import('../verbs')
  })

  afterEach(() => {
    store.relayRequestStore.resetForTests()
    vi.useRealTimers()
    rmSync(TEST_ROOT, { recursive: true, force: true })
  })

  const ask = (extra: Record<string, unknown>) =>
    mod.VERB_HANDLERS.ask!.run({ question: 'which db?', options: OPTIONS, ...extra } as never)

  it('weights without scores is refused before anything reaches the phone', async () => {
    const result = await ask({ weights: RAMP.weights })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('together')
    expect(store.relayRequestStore.listPending()).toHaveLength(0)
  })

  it('weights that do not add up to 100 are refused in plain words', async () => {
    const result = await ask({ ...RAMP, weights: { ...RAMP.weights, fast: 10 } })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe('weights add up to 90. They must add up to 100.')
    expect(store.relayRequestStore.listPending()).toHaveLength(0)
  })

  it('one score row per option, or it is refused', async () => {
    const result = await ask({ ...RAMP, scores: RAMP.scores.slice(0, 2) })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('scores has 2 rows but there are 3 options')
  })

  it('scores on a multi-question ask are refused', async () => {
    const questions = [
      { question: 'db?', options: ['a', 'b'] },
      { question: 'host?', options: ['c', 'd'] }
    ]
    const result = await ask({ ...RAMP, questions })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('single question')
  })

  it('a valid payload reaches the card with the % already computed', async () => {
    void ask(RAMP)
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(1))
    const d = store.relayRequestStore.listPending()[0]!.params.decision!
    expect(d.pcts).toEqual([79, 17, 4])
    expect(d.best).toBe(0)
    expect(d.weights).toEqual(RAMP.weights)
  })

  it('the answer the user picked is learned from; test asks are not', async () => {
    void ask(RAMP)
    void ask({ ...RAMP, test: true })
    await vi.waitFor(() => expect(store.relayRequestStore.listPending()).toHaveLength(2))
    const [real, test] = store.relayRequestStore.listPending()
    const realReq = real!.params.test ? test! : real!
    const testReq = real!.params.test ? real! : test!
    store.relayRequestStore.resolve(realReq.id, { answer: 'postgres' }, 'device-a', 'chip')
    store.relayRequestStore.resolve(testReq.id, { answer: 'json file' }, 'device-a', 'chip')

    vi.resetModules()
    const fresh = await import('../../store')
    expect(fresh.relayRequestStore.recentScoredPicks()).toEqual([{ scores: RAMP.scores, picked: 1, best: 0 }])
  })

  it('with decision cards off, a normal ask has every scoring field stripped', () => {
    const args = { question: 'q', options: OPTIONS, context: 'c', notes: { fast: 'x' }, test_you_usually: 1, ...RAMP }
    expect(mod.askArgsWithoutDecisions(args)).toEqual({ question: 'q', options: OPTIONS })
  })

  it('with decision cards off, a test ask still scores, and a bad one gets the reason back', () => {
    const good = mod.askArgsWithoutDecisions({ question: 'q', options: OPTIONS, test: true, ...RAMP })
    expect(good).toMatchObject({ weights: RAMP.weights, scores: RAMP.scores })
    const bad = mod.askArgsWithoutDecisions({ question: 'q', options: OPTIONS, test: true, weights: RAMP.weights, scores: [[150, 0, 0, 0, 0]] })
    expect(typeof bad).toBe('string')
    expect(bad).toContain('scores.0.0')
  })

  it('the plain ask tool hides the scoring fields and the hint', () => {
    const plain = mod.askWithoutDecisions()
    expect(plain.description).not.toContain('`weights`')
    const shape = (plain.inputSchema as unknown as { shape: Record<string, unknown> }).shape
    for (const k of ['context', 'weights', 'scores', 'notes', 'test_you_usually']) expect(shape).not.toHaveProperty(k)
    expect(shape).toHaveProperty('question')
  })
})
