import { afterAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const DIR = join(tmpdir(), `mm-context-log-${process.pid}`)
const handlers = vi.hoisted(() => new Map<string, (e: Record<string, number>) => void>())
const pointerWrites = vi.hoisted(() => ({ n: 0 }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    writeFileSync: (...a: Parameters<typeof actual.writeFileSync>) => {
      if (String(a[0]).endsWith('latest.txt')) pointerWrites.n++
      return actual.writeFileSync(...a)
    }
  }
})
vi.mock('../../store/paths', async () => {
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const dir = j(t(), `mm-context-log-${process.pid}`)
  return { PATHS: { CONTEXT_LOG_DIR: dir, CONTEXT_LOG_LATEST: j(dir, 'latest.txt') } }
})
vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => false } }))
vi.mock('../../platform', () => ({ captureContext: () => new Promise(() => {}) }))
vi.mock('../private-window', () => ({ isPrivateContext: async () => false }))
vi.mock('../uiohook-manager', () => ({
  isAvailable: () => true,
  acquire: () => () => {},
  on: (type: string, fn: (e: Record<string, number>) => void) => {
    handlers.set(type, fn)
    return () => handlers.delete(type)
  }
}))

import { startContextLogging, stopContextLogging } from '../context-logger'

afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('context log during a scroll gesture', () => {
  it('writes one wheel row and one pointer write for a burst of wheel ticks, not one per tick', () => {
    expect(startContextLogging()).toBe(true)
    const wheel = handlers.get('wheel')!
    for (let i = 0; i < 50; i++) wheel({ x: 10, y: 20, rotation: 1, direction: 3 })
    stopContextLogging()

    const day = readdirSync(DIR).find((f) => f.endsWith('.jsonl'))!
    const wheelRows = readFileSync(join(DIR, day), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"button":"wheel"'))
    expect(wheelRows).toHaveLength(1)
    expect(pointerWrites.n).toBe(1)
  })
})
