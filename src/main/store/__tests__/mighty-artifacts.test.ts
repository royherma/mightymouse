import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'

// Same pattern as prefs.test.ts: PATHS derives every path from os.homedir() at
// module-eval time, so the temp home must exist and the mock must be active
// BEFORE mighty.ts (→ paths.ts) is first imported.
const HOME = mkdtempSync(join(tmpdir(), 'mm-mighty-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

let MIGHTY: typeof import('../mighty').MIGHTY
let registryPath: string

describe('MIGHTY.isRegisteredArtifact', () => {
  beforeAll(async () => {
    const mod = await import('../mighty')
    MIGHTY = mod.MIGHTY
    registryPath = (await import('../paths')).PATHS.MIGHTY_REGISTRY
  })

  beforeEach(() => {
    rmSync(registryPath, { force: true })
  })

  it('is false for a path never registered — the forged-path case', () => {
    expect(MIGHTY.isRegisteredArtifact('/etc/passwd')).toBe(false)
    expect(MIGHTY.isRegisteredArtifact('/Users/roy/.ssh/id_rsa')).toBe(false)
  })

  it('is true for a path that was registered via addArtifact', () => {
    const path = join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace', 'report.html')
    MIGHTY.addArtifact({ path, ts: '2026-01-01T00:00:00Z', sessionId: 's1', prompt: 'make a report' })
    expect(MIGHTY.isRegisteredArtifact(path)).toBe(true)
  })

  it('is true for a registered path OUTSIDE the workspace — the honored outputPath case', () => {
    // run-mighty.ts intentionally registers an LLM-named outputPath even when it
    // resolves outside PATHS.MIGHTY_WORKSPACE — registry membership, not a root
    // check, is what makes this path legitimate to delete/reveal/open.
    const path = '/Users/roy/Desktop/exported-report.pdf'
    MIGHTY.addArtifact({ path, ts: '2026-01-01T00:00:00Z', sessionId: 's1', prompt: 'export to desktop' })
    expect(MIGHTY.isRegisteredArtifact(path)).toBe(true)
  })

  it('is false again after the artifact is removed from the registry', () => {
    const path = join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace', 'temp.txt')
    MIGHTY.addArtifact({ path, ts: '2026-01-01T00:00:00Z', sessionId: 's1', prompt: 'x' })
    expect(MIGHTY.isRegisteredArtifact(path)).toBe(true)
    MIGHTY.removeArtifact(path)
    expect(MIGHTY.isRegisteredArtifact(path)).toBe(false)
  })
})

describe('MIGHTY.listArtifacts exists flag', () => {
  beforeAll(async () => {
    const mod = await import('../mighty')
    MIGHTY = mod.MIGHTY
    registryPath = (await import('../paths')).PATHS.MIGHTY_REGISTRY
  })

  beforeEach(() => {
    rmSync(registryPath, { force: true })
  })

  // The exact bug this covers: a run registers an artifact but the file never
  // lands on disk (crash mid-write, cleanup, etc). The row must still show up
  // so the user sees it's broken instead of it silently vanishing or opening
  // to nothing.
  it('flags a registered artifact whose file is missing on disk', () => {
    const path = join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace', 'never-saved.html')
    MIGHTY.addArtifact({ path, ts: '2026-01-01T00:00:00Z', sessionId: 's1', prompt: 'x' })
    const rows = MIGHTY.listArtifacts()
    expect(rows).toHaveLength(1)
    expect(rows[0].exists).toBe(false)
  })

  it('marks an artifact whose file is actually on disk as existing', () => {
    const path = join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace', 'saved.html')
    writeFileSync(path, '<html></html>')
    MIGHTY.addArtifact({ path, ts: '2026-01-01T00:00:00Z', sessionId: 's1', prompt: 'x' })
    const rows = MIGHTY.listArtifacts()
    expect(rows).toHaveLength(1)
    expect(rows[0].exists).toBe(true)
  })
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})
