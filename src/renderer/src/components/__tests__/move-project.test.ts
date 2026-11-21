import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MightyProject } from '../../../../shared/types'
import { moveProject } from '../ProjectIcon'

const reorderProjects = vi.fn(async () => true)
vi.stubGlobal('window', { api: { mighty: { reorderProjects } } })

const list = (...ids: string[]): MightyProject[] => ids.map((id) => ({ id, name: id, created: '2026-11-20T00:00:00Z' }))
const ids = (ps: MightyProject[]): string[] => ps.map((p) => p.id)

describe('moveProject: dropping a dragged project in the sidebar', () => {
  beforeEach(() => reorderProjects.mockClear())

  it('drops above the target', () => {
    expect(ids(moveProject(list('a', 'b', 'c', 'd'), 'd', 'b', false))).toEqual(['a', 'd', 'b', 'c'])
  })

  it('drops below the target', () => {
    expect(ids(moveProject(list('a', 'b', 'c', 'd'), 'a', 'c', true))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('drops below the last project', () => {
    expect(ids(moveProject(list('a', 'b', 'c'), 'a', 'c', true))).toEqual(['b', 'c', 'a'])
  })

  it('saves exactly the order the sidebar now shows', () => {
    const next = moveProject(list('a', 'b', 'c'), 'c', 'a', false)
    expect(reorderProjects).toHaveBeenCalledTimes(1)
    expect(reorderProjects).toHaveBeenCalledWith(ids(next))
  })

  it('a drop on itself or on something that is not a project changes nothing and saves nothing', () => {
    const projects = list('a', 'b', 'c')
    expect(moveProject(projects, 'b', 'b', true)).toBe(projects)
    expect(moveProject(projects, 'b', 'gone', false)).toBe(projects)
    expect(moveProject(projects, 'gone', 'a', false)).toBe(projects)
    expect(reorderProjects).not.toHaveBeenCalled()
  })

  it('does not change the list it was given', () => {
    const projects = list('a', 'b', 'c')
    moveProject(projects, 'c', 'a', false)
    expect(ids(projects)).toEqual(['a', 'b', 'c'])
  })
})
