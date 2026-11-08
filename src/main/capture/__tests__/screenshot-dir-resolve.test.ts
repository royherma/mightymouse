import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOME = join(tmpdir(), `mm-shot-home-${process.pid}`)
const defaults = vi.hoisted(() => ({ out: '' as string | Error }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const { join: j } = await import('path')
  return { ...actual, homedir: () => j(actual.tmpdir(), `mm-shot-home-${process.pid}`) }
})
vi.mock('child_process', () => ({
  execFileSync: () => {
    if (defaults.out instanceof Error) throw defaults.out
    return defaults.out
  }
}))
vi.mock('../../store/paths', () => ({ PATHS: {} }))
vi.mock('../insights', () => ({ readCachedInsights: vi.fn() }))

beforeEach(() => vi.resetModules())
afterAll(() => rmSync(HOME, { recursive: true, force: true }))

const resolve = async (): Promise<string> => (await import('../os-screenshots')).screenshotDir()

describe('where macOS puts screenshots', () => {
  it('expands a ~ location against home', async () => {
    mkdirSync(join(HOME, 'Shots'), { recursive: true })
    defaults.out = '~/Shots\n'
    expect(await resolve()).toBe(join(HOME, 'Shots'))
  })

  it('falls back to the Desktop when the configured folder is gone', async () => {
    defaults.out = join(HOME, 'deleted-folder')
    expect(await resolve()).toBe(join(HOME, 'Desktop'))
  })

  it('falls back to the Desktop when the key was never set', async () => {
    defaults.out = new Error('The domain/default pair does not exist')
    expect(await resolve()).toBe(join(HOME, 'Desktop'))
  })
})
