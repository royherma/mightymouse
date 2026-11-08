import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const DIR = mkdtempSync(join(tmpdir(), 'quick-actions-'))
const FILE = join(DIR, 'rewrite-actions.json')
vi.mock('../paths', () => ({ PATHS: { ACTIONS: FILE } }))

const { ACTIONS } = await import('../actions')
const { CONFIG } = await import('../../../shared/config')

describe('quick-action defaults seeding', () => {
  beforeEach(() => {
    if (existsSync(FILE)) rmSync(FILE)
  })

  it('seeds the defaults when the file is missing', () => {
    const loaded = ACTIONS.load()
    expect(loaded.map((a) => a.key)).toEqual(CONFIG.DEFAULT_QUICK_ACTIONS.map((a) => a.key))
  })

  // The seed must PERSIST, not just return — otherwise "deleted them all" and
  // "never had any" look identical and every delete gets undone on next launch.
  it('writes the seed to disk so a later delete can stick', () => {
    ACTIONS.load()
    expect(existsSync(FILE)).toBe(true)
    expect(JSON.parse(readFileSync(FILE, 'utf-8'))).toEqual(CONFIG.DEFAULT_QUICK_ACTIONS)
  })

  it('purges the retired Transcribe seed from an existing install and keeps the rest', () => {
    const mine = { key: 'k', label: 'Mine', mode: 'ask', instruction: 'hi' }
    writeFileSync(FILE, JSON.stringify([{ key: 'default-transcribe', label: 'Transcribe', mode: 'rewrite', instruction: '' }, mine]))
    expect(ACTIONS.load()).toEqual([mine])
    expect(JSON.parse(readFileSync(FILE, 'utf-8'))).toEqual([mine])
  })

  it('respects an empty file — deleted pills stay deleted', () => {
    writeFileSync(FILE, '[]')
    expect(ACTIONS.load()).toEqual([])
  })

  it('leaves existing user actions untouched', () => {
    const mine = [{ key: 'k', label: 'Mine', mode: 'ask', instruction: 'hi' }]
    writeFileSync(FILE, JSON.stringify(mine))
    expect(ACTIONS.load()).toEqual(mine)
  })
})
