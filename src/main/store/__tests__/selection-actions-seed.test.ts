import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const DIR = mkdtempSync(join(tmpdir(), 'selection-actions-'))
const FILE = join(DIR, 'selection-bar-actions.json')
vi.mock('../paths', () => ({ PATHS: { SELECTION_ACTIONS: FILE } }))

const { SELECTION_ACTIONS, newActionKey } = await import('../selection-actions')
const { CONFIG } = await import('../../../shared/config')

describe('selection-bar action store', () => {
  beforeEach(() => {
    if (existsSync(FILE)) rmSync(FILE)
  })

  it('seeds the defaults when the file is missing', () => {
    expect(SELECTION_ACTIONS.load().map((a) => a.label)).toEqual(
      CONFIG.SELECTION_BAR.DEFAULT_ACTIONS.map((a) => a.label)
    )
  })

  // The seed must PERSIST, not just return — otherwise "deleted them all" and
  // "never had any" look identical and every delete gets undone on next launch.
  it('writes the seed to disk so a later delete can stick', () => {
    SELECTION_ACTIONS.load()
    expect(existsSync(FILE)).toBe(true)
    expect(JSON.parse(readFileSync(FILE, 'utf-8')).length).toBe(
      CONFIG.SELECTION_BAR.DEFAULT_ACTIONS.length
    )
  })

  it('respects an empty file — deleted chips stay deleted', () => {
    writeFileSync(FILE, '[]')
    expect(SELECTION_ACTIONS.load()).toEqual([])
  })

  // Ask carries instruction:null, which is what makes it open the panel instead
  // of rewriting in place. A validator that rejected null would silently drop it.
  it('keeps a null instruction through a save/load round trip', () => {
    SELECTION_ACTIONS.save([{ key: 'ask', label: 'Ask', instruction: null }])
    expect(SELECTION_ACTIONS.load()[0].instruction).toBeNull()
  })

  it('drops malformed entries instead of handing the bar a broken chip', () => {
    writeFileSync(FILE, JSON.stringify([{ key: 'ok', label: 'Ok', instruction: 'x' }, { nope: 1 }]))
    expect(SELECTION_ACTIONS.load().map((a) => a.key)).toEqual(['ok'])
  })

  it('reset brings the defaults back after everything is deleted', () => {
    writeFileSync(FILE, '[]')
    expect(SELECTION_ACTIONS.resetToDefaults().length).toBe(
      CONFIG.SELECTION_BAR.DEFAULT_ACTIONS.length
    )
    expect(SELECTION_ACTIONS.load().length).toBe(CONFIG.SELECTION_BAR.DEFAULT_ACTIONS.length)
  })

  it('generates unique keys so two chips with the same title never collide', () => {
    const keys = new Set(Array.from({ length: 200 }, newActionKey))
    expect(keys.size).toBe(200)
  })

  // resetToDefaults hands out copies, not the CONFIG array itself — editing a
  // chip must never mutate the seed for the rest of the process.
  it('does not let an edit mutate the shared defaults', () => {
    const first = SELECTION_ACTIONS.resetToDefaults()
    first[0].label = 'Mutated'
    expect(SELECTION_ACTIONS.resetToDefaults()[0].label).not.toBe('Mutated')
  })
})
