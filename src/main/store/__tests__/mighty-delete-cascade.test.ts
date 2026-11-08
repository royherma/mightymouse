import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'
import type { MightyJob, MightyTurn } from '../../../shared/types'

// Same pattern as mighty-live-turn.test.ts: PATHS derives every path from os.homedir()
// at module-eval time, so the temp home must exist and the mock must be active BEFORE
// mighty.ts (→ paths.ts) is first imported.
const HOME = mkdtempSync(join(tmpdir(), 'mm-delete-cascade-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'mighty'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

let MIGHTY: typeof import('../mighty').MIGHTY
let sessionsPath: string
let jobsPath: string
let registryPath: string

const turn = (q: string): MightyTurn => ({
  source: 'chat',
  q,
  a: 'answered',
  ts: '2026-08-04T01:00:00Z',
  ok: true,
  backend: 'ollama'
})

const job = (id: string, sessionId: string): MightyJob => ({
  id,
  name: `job-${id}`,
  prompt: 'do the thing',
  schedule: 'daily',
  hour: 9,
  enabled: true,
  lastRun: '',
  created: '2026-08-04T00:00:00Z',
  sessionId
})

// Deleting a conversation used to leave two kinds of dangling pointer behind. The job
// one is the damaging half: appendTurn's `if (!session)` branch silently MINTS a fresh
// session for an unknown id, so a job pointing at a deleted session spawned a new
// orphan every single run and never accumulated history again.
describe('MIGHTY.deleteSession cascade', () => {
  beforeAll(async () => {
    MIGHTY = (await import('../mighty')).MIGHTY
    const paths = (await import('../paths')).PATHS
    sessionsPath = paths.MIGHTY_SESSIONS
    jobsPath = paths.MIGHTY_JOBS
    registryPath = paths.MIGHTY_REGISTRY
  })

  beforeEach(() => {
    rmSync(sessionsPath, { force: true })
    rmSync(jobsPath, { force: true })
    rmSync(registryPath, { force: true })
  })

  it('clears the sessionId of every job that pointed at the deleted session', () => {
    const id = MIGHTY.appendTurn(undefined, turn('scheduled report'))
    MIGHTY.upsertJob(job('j1', id))
    MIGHTY.upsertJob(job('j2', id))
    MIGHTY.upsertJob(job('j3', 'some-other-session'))

    expect(MIGHTY.deleteSession(id)).toBe(true)

    const jobs = MIGHTY.listJobs()
    expect(jobs.find((j) => j.id === 'j1')!.sessionId).toBe('')
    expect(jobs.find((j) => j.id === 'j2')!.sessionId).toBe('')
    // An unrelated job must not be touched by the sweep.
    expect(jobs.find((j) => j.id === 'j3')!.sessionId).toBe('some-other-session')
  })

  it('keeps the job itself — only the pointer is cleared, never the schedule', () => {
    const id = MIGHTY.appendTurn(undefined, turn('daily digest'))
    MIGHTY.upsertJob(job('j1', id))

    MIGHTY.deleteSession(id)

    const j = MIGHTY.listJobs().find((x) => x.id === 'j1')!
    expect(j.name).toBe('job-j1')
    expect(j.prompt).toBe('do the thing')
    expect(j.enabled).toBe(true)
    expect(j.hour).toBe(9)
  })

  it('clears an artifact row sessionId but keeps the artifact and its prompt', () => {
    const id = MIGHTY.appendTurn(undefined, turn('build a dashboard'))
    MIGHTY.addArtifact({
      path: join(HOME, 'dash.html'),
      ts: '2026-08-04T01:00:00Z',
      sessionId: id,
      prompt: 'build a dashboard'
    })

    MIGHTY.deleteSession(id)

    const rows = MIGHTY.listArtifacts()
    expect(rows).toHaveLength(1)
    // Deleting a conversation must never delete something Mighty MADE.
    expect(rows[0].prompt).toBe('build a dashboard')
    expect(rows[0].path).toBe(join(HOME, 'dash.html'))
    expect(rows[0].sessionId).toBe('')
  })

  it('leaves other sessions intact', () => {
    const keep = MIGHTY.appendTurn(undefined, turn('keep me'))
    const drop = MIGHTY.appendTurn(undefined, turn('drop me'))

    MIGHTY.deleteSession(drop)

    expect(MIGHTY.getSession(drop)).toBeNull()
    expect(MIGHTY.getSession(keep)!.turns[0].q).toBe('keep me')
  })

  it('no-ops on an unknown id', () => {
    const id = MIGHTY.appendTurn(undefined, turn('still here'))
    MIGHTY.upsertJob(job('j1', id))

    expect(MIGHTY.deleteSession('never-existed')).toBe(false)

    expect(MIGHTY.listJobs().find((j) => j.id === 'j1')!.sessionId).toBe(id)
    expect(MIGHTY.getSession(id)).not.toBeNull()
  })
})
