import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'
import type { MightyJob, MightyProject, MightyTurn } from '../../../shared/types'

// Same pattern as mighty-delete-cascade.test.ts: PATHS derives every path from
// os.homedir() at module-eval time, so the temp home must exist and the mock must be
// active BEFORE mighty.ts / prefs.ts (→ paths.ts) is first imported.
const HOME = mkdtempSync(join(tmpdir(), 'mm-incognito-delete-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

let MIGHTY: typeof import('../mighty').MIGHTY
let PREFS: typeof import('../prefs').PREFS
let sessionsPath: string
let jobsPath: string
let registryPath: string
let projectsPath: string

const turn = (q: string): MightyTurn => ({
  source: 'chat',
  q,
  a: 'answered',
  ts: '2026-08-15T01:00:00Z',
  ok: true,
  backend: 'ollama'
})

const job = (id: string): MightyJob => ({
  id,
  name: `job-${id}`,
  prompt: 'do the thing',
  schedule: 'daily',
  hour: 9,
  enabled: true,
  lastRun: '',
  created: '2026-08-15T00:00:00Z',
  sessionId: ''
})

const project = (id: string): MightyProject => ({
  id,
  name: `project-${id}`,
  created: '2026-08-15T00:00:00Z'
})

// rewriteFile() used to silently no-op under incognito while callers had already
// computed `true` — see docs/gotchas.md "A store function's return value must reflect...".
describe('Mighty deletes are not silently swallowed by incognito', () => {
  beforeAll(async () => {
    MIGHTY = (await import('../mighty')).MIGHTY
    PREFS = (await import('../prefs')).PREFS
    const paths = (await import('../paths')).PATHS
    sessionsPath = paths.MIGHTY_SESSIONS
    jobsPath = paths.MIGHTY_JOBS
    registryPath = paths.MIGHTY_REGISTRY
    projectsPath = paths.MIGHTY_PROJECTS
  })

  beforeEach(() => {
    rmSync(sessionsPath, { force: true })
    rmSync(jobsPath, { force: true })
    rmSync(registryPath, { force: true })
    rmSync(projectsPath, { force: true })
    PREFS.setIncognito(false)
  })
  afterEach(() => PREFS.setIncognito(false))

  it('deleteSession persists the removal and reports true while incognito is on', () => {
    const id = MIGHTY.appendTurn(undefined, turn('scheduled report'))
    PREFS.setIncognito(true)

    expect(MIGHTY.deleteSession(id)).toBe(true)
    expect(MIGHTY.getSession(id)).toBeNull()
  })

  it('deleteJob persists the removal and reports true while incognito is on', () => {
    PREFS.setIncognito(false)
    MIGHTY.upsertJob(job('j1'))
    PREFS.setIncognito(true)

    expect(MIGHTY.deleteJob('j1')).toBe(true)
    expect(MIGHTY.listJobs().find((j) => j.id === 'j1')).toBeUndefined()
  })

  it('deleteProject persists the removal and reports true while incognito is on', () => {
    PREFS.setIncognito(false)
    MIGHTY.upsertProject(project('p1'))
    PREFS.setIncognito(true)

    expect(MIGHTY.deleteProject('p1')).toBe(true)
    expect(MIGHTY.listProjects().find((p) => p.id === 'p1')).toBeUndefined()
  })

  it('removeArtifact persists the removal and reports true while incognito is on', () => {
    const path = join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace', 'report.html')
    PREFS.setIncognito(false)
    MIGHTY.addArtifact({ path, ts: '2026-08-15T01:00:00Z', sessionId: 's1', prompt: 'make a report' })
    PREFS.setIncognito(true)

    expect(MIGHTY.removeArtifact(path)).toBe(true)
    expect(MIGHTY.isRegisteredArtifact(path)).toBe(false)
  })

  // mightyDeleteArtifact's IPC handler only rmSync's when removeArtifact() returns
  // true — proving that return is truthful here is what makes that call site safe.
  it('a file backing a registered artifact is never orphaned by a suppressed rewrite', () => {
    const path = join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace', 'keepsake.html')
    writeFileSync(path, '<html>real file</html>')
    PREFS.setIncognito(false)
    MIGHTY.addArtifact({ path, ts: '2026-08-15T01:00:00Z', sessionId: 's1', prompt: 'keepsake' })
    PREFS.setIncognito(true)

    const removed = MIGHTY.removeArtifact(path)
    // The IPC handler's contract: only unlink the real file when removeArtifact
    // genuinely persisted the registry removal. Simulate that gate here.
    if (removed) rmSync(path, { force: true })

    expect(removed).toBe(true)
    // Under the fix the registry row really is gone, so unlinking here is correct —
    // this locks in that removed=true and "row actually gone" never disagree again.
    expect(MIGHTY.isRegisteredArtifact(path)).toBe(false)
    expect(existsSync(path)).toBe(false)
  })
})
