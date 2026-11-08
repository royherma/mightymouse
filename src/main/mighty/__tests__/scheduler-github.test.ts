import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MightyJob } from '../../../shared/types'

const H = vi.hoisted(() => ({
  jobs: [] as MightyJob[],
  items: [] as Array<{ id: string; title: string; url: string }>,
  fetch: vi.fn(),
  upsert: vi.fn(),
  runMighty: vi.fn(),
  startCodeSession: vi.fn()
}))

vi.mock('../run-mighty', () => ({ runMighty: (opts: unknown) => H.runMighty(opts) }))
vi.mock('../../ipc/agent-relay', () => ({ startCodeSession: (input: unknown) => H.startCodeSession(input) }))
vi.mock('../github-trigger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../github-trigger')>()),
  fetchGithubItems: (cwd: string, event: string) => H.fetch(cwd, event)
}))
vi.mock('../../store/mighty', () => ({
  MIGHTY: {
    listJobs: () => H.jobs,
    getJob: (id: string) => H.jobs.find((j) => j.id === id) ?? null,
    upsertJob: (j: MightyJob) => {
      H.upsert(structuredClone(j))
      H.jobs = H.jobs.map((x) => (x.id === j.id ? j : x))
    }
  }
}))
vi.mock('../../store/prefs', () => ({ PREFS: { getMightyName: () => 'Mighty' } }))
vi.mock('electron', () => ({
  Notification: Object.assign(
    class {
      show(): void {}
    },
    { isSupported: () => false }
  )
}))

import { startMightyScheduler, stopMightyScheduler } from '../scheduler'

let n = 0
function githubJob(seen: string[] | undefined, extra: Partial<MightyJob> = {}): MightyJob {
  n++
  return {
    id: `gh-job-${n}`,
    name: 'Review new PRs',
    prompt: 'Review it.',
    schedule: 'manual',
    hour: 0,
    enabled: true,
    lastRun: null,
    created: '2026-11-01T00:00:00Z',
    sessionId: '',
    target: { kind: 'code', cwd: '/tmp/repo', project: 'repo' },
    trigger: { kind: 'github', repoCwd: '/tmp/repo', event: 'pr-opened', seen },
    ...extra
  }
}

const item = (id: string): { id: string; title: string; url: string } => ({ id, title: `PR ${id}`, url: `https://github.com/o/r/pull/${id}` })
const tick = (): void => {
  stopMightyScheduler()
  startMightyScheduler()
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  H.fetch.mockReset().mockImplementation(async () => H.items)
  H.upsert.mockReset()
  H.runMighty.mockReset().mockResolvedValue({ error: null, answer: 'ok' })
  H.startCodeSession.mockReset().mockResolvedValue({ ok: true, pane: '%1' })
})
afterEach(() => stopMightyScheduler())

describe('GitHub-triggered jobs', () => {
  it('the first poll records existing pull requests and starts no agent', async () => {
    H.items = [item('1'), item('2')]
    H.jobs = [githubJob(undefined)]
    tick()
    await vi.waitFor(() => expect(H.upsert).toHaveBeenCalled())
    await settle()
    expect(H.startCodeSession).not.toHaveBeenCalled()
    expect(H.upsert.mock.calls[0][0].trigger.seen).toEqual(['1', '2'])
  })

  it('starts one coding agent per new pull request, at most three per poll, each told which one', async () => {
    H.items = [item('3'), item('4'), item('5'), item('6'), item('7'), item('1')]
    H.jobs = [githubJob(['1'])]
    tick()
    await vi.waitFor(() => expect(H.startCodeSession).toHaveBeenCalledTimes(3))
    await settle()
    expect(H.startCodeSession).toHaveBeenCalledTimes(3)
    expect(H.startCodeSession.mock.calls.map((c) => c[0])).toEqual(
      ['3', '4', '5'].map((id) => ({
        project: 'repo',
        cwd: '/tmp/repo',
        inApp: true,
        message: `A new pull request was opened: PR ${id} https://github.com/o/r/pull/${id}. Review it.`
      }))
    )
    expect(H.upsert.mock.calls[0][0].trigger.seen).toEqual(['1', '3', '4', '5', '6', '7'])
  })

  it('a job with no code target hands the item to Mighty instead', async () => {
    H.items = [item('2'), item('1')]
    H.jobs = [githubJob(['1'], { target: undefined })]
    tick()
    await vi.waitFor(() => expect(H.runMighty).toHaveBeenCalledTimes(1))
    expect(H.runMighty.mock.calls[0][0]).toMatchObject({ message: 'A new pull request was opened: PR 2 https://github.com/o/r/pull/2. Review it.', source: 'job' })
    expect(H.startCodeSession).not.toHaveBeenCalled()
  })

  it('polls GitHub at most once every two minutes per job', async () => {
    H.items = [item('1')]
    H.jobs = [githubJob(undefined)]
    tick()
    await vi.waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(1))
    tick()
    tick()
    await settle()
    expect(H.fetch).toHaveBeenCalledTimes(1)
  })

  it('a disabled trigger job never polls, and a trigger job never fires on the clock', async () => {
    H.items = [item('2')]
    H.jobs = [githubJob(['1'], { enabled: false }), githubJob(undefined, { schedule: 'hourly', lastRun: null })]
    tick()
    await vi.waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(1))
    await settle()
    expect(H.fetch.mock.calls).toHaveLength(1)
    expect(H.startCodeSession).not.toHaveBeenCalled()
    expect(H.runMighty).not.toHaveBeenCalled()
  })
})
