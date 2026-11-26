import { describe, it, expect, vi, beforeEach } from 'vitest'

const runMighty = vi.hoisted(() => vi.fn())
const abortRun = vi.hoisted(() => vi.fn(() => true))
const setCompanionRunActive = vi.hoisted(() => vi.fn())

vi.mock('../mighty/run-mighty', () => ({ runMighty }))
vi.mock('../backend/runner', () => ({ abortRun, resolveRunModel: () => 'sonnet' }))
vi.mock('../store/prefs', () => ({
  PREFS: { getBackend: () => 'claude', getLiveActs: () => false, getCompanionModel: () => 'claude-haiku-5-5' }
}))
vi.mock('../audio/tts', () => ({
  speak: vi.fn(async () => ({ audio: null, mimeType: 'audio/mpeg', provider: 'silent-no-key' })),
  resolvedTtsProvider: () => 'silent-no-key'
}))
vi.mock('../companion-window', () => ({ sendCompanionStageEvent: vi.fn(), setCompanionRunActive }))
vi.mock('../capture/screenshot', () => ({ fireScreenshot: vi.fn() }))

import { abortCompanionTurn, runCompanionAskTurn } from '../companion-orchestrator'

type Opts = { onRunId?: (id: string) => void; model?: string; recipe?: string }

function controlledRun(): { opts: Promise<Opts>; finish: () => void } {
  let finish: () => void = () => {}
  let gotOpts: (o: Opts) => void = () => {}
  const opts = new Promise<Opts>((r) => (gotOpts = r))
  runMighty.mockImplementationOnce((o: Opts) => {
    gotOpts(o)
    return new Promise((r) => (finish = () => r({ answer: 'ok', sessionId: 's', artifacts: [] })))
  })
  return { opts, finish: () => finish() }
}

beforeEach(() => {
  runMighty.mockReset()
  abortRun.mockClear()
  setCompanionRunActive.mockClear()
  abortCompanionTurn()
  abortRun.mockClear()
})

describe('Hey Mighty stop reaches the right run', () => {
  it('kills a run whose id arrives after the user already stopped', async () => {
    const a = controlledRun()
    const pending = runCompanionAskTurn('open my calendar')
    const opts = await a.opts

    abortCompanionTurn()
    opts.onRunId?.('run-a')

    expect(abortRun).toHaveBeenCalledWith('run-a')
    a.finish()
    await pending
  })

  it("an interrupted run finishing late does not clear the new run's stop", async () => {
    const a = controlledRun()
    const first = runCompanionAskTurn('open my calendar')
    ;(await a.opts).onRunId?.('run-a')

    abortCompanionTurn()
    const b = controlledRun()
    const second = runCompanionAskTurn('no, the other tab')
    ;(await b.opts).onRunId?.('run-b')

    a.finish()
    await first
    abortRun.mockClear()
    abortCompanionTurn()

    expect(abortRun).toHaveBeenCalledWith('run-b')
    b.finish()
    await second
  })

  it('an interrupted run finishing late leaves the new run marked active', async () => {
    const a = controlledRun()
    const first = runCompanionAskTurn('open my calendar')
    ;(await a.opts).onRunId?.('run-a')
    abortCompanionTurn()
    const b = controlledRun()
    const second = runCompanionAskTurn('no, the other tab')
    ;(await b.opts).onRunId?.('run-b')
    setCompanionRunActive.mockClear()

    a.finish()
    await first

    expect(setCompanionRunActive).not.toHaveBeenCalledWith(false, false, expect.anything())
    b.finish()
    await second
  })

  it('runs Claude voice turns on the Brain picked in Settings', async () => {
    runMighty.mockResolvedValue({ answer: 'ok', sessionId: 's', artifacts: [] })
    const result = await runCompanionAskTurn('hello', undefined, 'RECIPE')

    expect(runMighty).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-haiku-5-5', recipe: 'RECIPE' }))
    expect(result.answeredBy.model).toBe('claude-haiku-5-5')
  })
})
