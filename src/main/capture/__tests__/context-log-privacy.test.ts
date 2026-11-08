import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const DIR = join(tmpdir(), `mm-context-privacy-${process.pid}`)
const handlers = vi.hoisted(() => new Map<string, (e: Record<string, number>) => void>())
const env = vi.hoisted(() => ({ incognito: false, private: false }))

vi.mock('../../store/paths', async () => {
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const dir = j(t(), `mm-context-privacy-${process.pid}`)
  return { PATHS: { CONTEXT_LOG_DIR: dir, CONTEXT_LOG_LATEST: j(dir, 'latest.txt') } }
})
vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => env.incognito } }))
vi.mock('../../platform', () => ({
  captureContext: async () => ({ frontApp: 'Google Chrome', windowTitle: 'Bank', browserURL: 'https://bank.example' })
}))
vi.mock('../private-window', () => ({ isPrivateContext: async () => env.private }))
vi.mock('../uiohook-manager', () => ({
  isAvailable: () => true,
  acquire: () => () => {},
  on: (type: string, fn: (e: Record<string, number>) => void) => {
    handlers.set(type, fn)
    return () => handlers.delete(type)
  }
}))

import { startContextLogging, stopContextLogging } from '../context-logger'

const rows = (): string[] => {
  if (!existsSync(DIR)) return []
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(DIR, f), 'utf8').split('\n').filter(Boolean))
}

async function session(): Promise<void> {
  startContextLogging()
  await new Promise((r) => setTimeout(r, 20))
  handlers.get('mouseup')!({ x: 1, y: 2, button: 1 })
  handlers.get('keydown')!({ keycode: 30 })
  stopContextLogging()
}

beforeEach(() => rmSync(DIR, { recursive: true, force: true }))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('ambient context log privacy', () => {
  it('logs focus and clicks in a normal window', async () => {
    Object.assign(env, { incognito: false, private: false })
    await session()
    expect(rows().some((r) => r.includes('"type":"focus"'))).toBe(true)
    expect(rows().some((r) => r.includes('"type":"click"'))).toBe(true)
  })

  it('writes nothing at all for an incognito browser window', async () => {
    Object.assign(env, { incognito: false, private: true })
    await session()
    expect(rows()).toEqual([])
  })

  it('writes nothing at all while the app is in Incognito mode', async () => {
    Object.assign(env, { incognito: true, private: false })
    await session()
    expect(rows()).toEqual([])
  })
})
