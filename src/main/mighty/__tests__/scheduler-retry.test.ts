import { describe, it, expect, vi, beforeEach } from 'vitest'

// A scheduled job must fire ONCE per due window — even when the run fails.
//
// lastRun is the only marker isJobDue reads to decide a window is handled. The
// scheduler used to stamp it on success only, so a failing job stayed permanently
// due and re-fired on every 60s tick, forever. A real "Morning report" job did
// exactly that. These tests pin the attempt-stamp on all three exit paths.

const runMighty = vi.fn()
vi.mock('../run-mighty', () => ({
  runMighty: (opts: unknown) => runMighty(opts)
}))

const upsertJob = vi.fn()
const H = vi.hoisted(() => ({ jobs: [] as unknown[] }))
vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    listJobs: () => H.jobs,
    getJob: (id: string) => H.jobs.find((j) => (j as { id: string }).id === id) ?? null,
    upsertJob: (j: unknown) => upsertJob(j)
  }
}))

vi.mock('../../store/prefs', () => ({
  PREFS: { getMightyName: () => 'Mighty' }
}))

vi.mock('electron', () => ({
  Notification: Object.assign(
    class {
      show(): void {}
    },
    { isSupported: () => false }
  )
}))

import { runJobNow } from '../scheduler'

const JOB = {
  id: 'job-1',
  name: 'Morning report',
  prompt: 'do the thing',
  schedule: 'weekdays' as const,
  hour: 8,
  enabled: true,
  lastRun: null,
  created: '2026-08-01T00:00:00Z',
  sessionId: 'sess-1'
}

function stampedRuns(): unknown[] {
  return upsertJob.mock.calls.map((c) => c[0])
}

describe('scheduler stamps lastRun per ATTEMPT, not per success', () => {
  beforeEach(() => {
    runMighty.mockReset()
    upsertJob.mockReset()
    H.jobs = [{ ...JOB }]
  })

  it('stamps lastRun when the run succeeds', async () => {
    runMighty.mockResolvedValue({ error: null, answer: 'done' })
    await runJobNow('job-1')
    expect(stampedRuns()).toHaveLength(1)
    expect((stampedRuns()[0] as { lastRun: string }).lastRun).toBeTruthy()
  })

  // The regression: an errored result left lastRun null → still due → refire next tick.
  it('stamps lastRun when the run returns an error', async () => {
    runMighty.mockResolvedValue({ error: 'backend blew up', answer: '' })
    await runJobNow('job-1')
    expect(stampedRuns()).toHaveLength(1)
    expect((stampedRuns()[0] as { lastRun: string }).lastRun).toBeTruthy()
  })

  // The second half of the same hole: a THROWN run skipped the stamp entirely.
  it('stamps lastRun when the run throws', async () => {
    runMighty.mockRejectedValue(new Error('spawn failed'))
    await runJobNow('job-1')
    expect(stampedRuns()).toHaveLength(1)
    expect((stampedRuns()[0] as { lastRun: string }).lastRun).toBeTruthy()
  })

  it('leaves every other job field untouched when stamping', async () => {
    runMighty.mockResolvedValue({ error: 'nope', answer: '' })
    await runJobNow('job-1')
    expect(stampedRuns()[0]).toMatchObject({
      id: 'job-1',
      name: 'Morning report',
      prompt: 'do the thing',
      enabled: true,
      sessionId: 'sess-1'
    })
  })
})
