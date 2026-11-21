import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'
import type { MightyProject } from '../../../shared/types'

// PATHS reads os.homedir() at import time, so the temp home must be mocked before mighty.ts loads.
const HOME = mkdtempSync(join(tmpdir(), 'mm-project-order-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'mighty', 'workspace'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

let MIGHTY: typeof import('../mighty').MIGHTY
let onProjectsWritten: typeof import('../mighty').onProjectsWritten
let PREFS: typeof import('../prefs').PREFS
let projectsPath: string

const project = (id: string, created: string, extra: Partial<MightyProject> = {}): MightyProject => ({
  id,
  name: `project-${id}`,
  created,
  updated: created,
  ...extra
})

const ids = (): string[] => MIGHTY.listProjects().map((p) => p.id)
const lineCount = (): number => (existsSync(projectsPath) ? readFileSync(projectsPath, 'utf-8').trim().split('\n').length : 0)

describe('project order (drag to reorder)', () => {
  const writes = vi.fn()

  beforeAll(async () => {
    const mod = await import('../mighty')
    MIGHTY = mod.MIGHTY
    onProjectsWritten = mod.onProjectsWritten
    PREFS = (await import('../prefs')).PREFS
    projectsPath = (await import('../paths')).PATHS.MIGHTY_PROJECTS
  })

  beforeEach(() => {
    rmSync(projectsPath, { force: true })
    PREFS.setIncognito(false)
    MIGHTY.upsertProject(project('a', '2026-11-01T00:00:00Z'))
    MIGHTY.upsertProject(project('b', '2026-11-02T00:00:00Z'))
    MIGHTY.upsertProject(project('c', '2026-11-03T00:00:00Z'))
    writes.mockClear()
    onProjectsWritten(writes)
  })
  afterEach(() => PREFS.setIncognito(false))

  it('lists oldest first when nobody has dragged anything', () => {
    expect(ids()).toEqual(['a', 'b', 'c'])
  })

  it('saves the dragged order and lists projects in it', () => {
    expect(MIGHTY.reorderProjects(['c', 'a', 'b'])).toBe(true)
    expect(ids()).toEqual(['c', 'a', 'b'])
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('a project missing from the dragged list keeps its place after the listed ones', () => {
    MIGHTY.reorderProjects(['c', 'b'])
    expect(ids()).toEqual(['c', 'b', 'a'])
  })

  it('ignores ids that are not projects', () => {
    MIGHTY.reorderProjects(['ghost', 'b', 'a', 'c'])
    expect(ids()).toEqual(['b', 'a', 'c'])
    expect(MIGHTY.getProject('ghost')).toBeNull()
  })

  it('a project created after a drag lands at the bottom, not the top', () => {
    MIGHTY.reorderProjects(['c', 'a', 'b'])
    MIGHTY.upsertProject(project('new', '2026-11-04T00:00:00Z'))
    expect(ids()).toEqual(['c', 'a', 'b', 'new'])
  })

  it('a project that already has an order sorts ahead of one with none, whatever its age', () => {
    MIGHTY.upsertProject(project('old', '2020-01-01T00:00:00Z'))
    MIGHTY.upsertProject({ ...project('c', '2026-11-03T00:00:00Z'), order: 0 })
    expect(ids()[0]).toBe('c')
    expect(ids().slice(1)).toEqual(['old', 'a', 'b'])
  })

  it('the same order twice writes nothing and reports no change', () => {
    MIGHTY.reorderProjects(['c', 'a', 'b'])
    writes.mockClear()
    const before = lineCount()
    expect(MIGHTY.reorderProjects(['c', 'a', 'b'])).toBe(false)
    expect(lineCount()).toBe(before)
    expect(writes).not.toHaveBeenCalled()
  })

  it('rewrites only the projects whose position moved', () => {
    MIGHTY.reorderProjects(['a', 'b', 'c'])
    const before = lineCount()
    MIGHTY.reorderProjects(['a', 'c', 'b'])
    expect(lineCount()).toBe(before + 2)
  })

  it('stamps a moved project as newer, so the cloud sync sends the new order', () => {
    MIGHTY.reorderProjects(['c', 'a', 'b'])
    const moved = MIGHTY.getProject('c')!
    expect(Date.parse(moved.updated!)).toBeGreaterThan(Date.parse('2026-11-03T00:00:00Z'))
    expect(moved.order).toBe(0)
    expect(moved.name).toBe('project-c')
  })

  it('under incognito, "changed" is only reported when the new order was really saved', () => {
    PREFS.setIncognito(true)
    const changed = MIGHTY.reorderProjects(['c', 'a', 'b'])
    expect(changed).toBe(ids().join() === 'c,a,b')
  })
})
