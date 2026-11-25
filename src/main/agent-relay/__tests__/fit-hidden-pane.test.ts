import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  clients: '' as string,
  panes: '1\n' as string,
  resizeFails: false
}))

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, stdout?: string) => void) => {
    h.calls.push(args)
    if (args.includes('list-clients')) return cb(null, h.clients)
    if (args.includes('#{window_panes}')) return cb(null, h.panes)
    if (args.includes('resize-window') && h.resizeFails) return cb(new Error('no window'))
    return cb(null, '')
  })
}))

vi.mock('../../../shared/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/env')>()),
  devLog: { warn: vi.fn(), log: vi.fn() }
}))

vi.mock('../../platform', () => ({ resolveBinary: vi.fn(() => '/opt/homebrew/bin/tmux') }))
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }))

const { fitHiddenPane } = await import('../origin-resolver')

const origin = { tmuxPane: '%3' } as never

function resizes(): string[][] {
  return h.calls.filter((a) => a.includes('resize-window')).map((a) => [a[a.indexOf('-x') + 1], a[a.indexOf('-y') + 1]])
}
const tiled = (): boolean => h.calls.some((a) => a.includes('select-layout') && a.includes('tiled'))

beforeEach(() => {
  h.calls = []
  h.clients = ''
  h.panes = '1\n'
  h.resizeFails = false
})

describe('fitHiddenPane', () => {
  it('sizes a lone pane to exactly the box', async () => {
    await expect(fitHiddenPane(origin, 100, 30)).resolves.toBe(true)
    expect(resizes()).toEqual([['100', '30']])
    expect(tiled()).toBe(false)
  })

  it.each([
    [2, 1, 2],
    [3, 2, 2],
    [4, 2, 2],
    [5, 2, 3],
    [6, 2, 3],
    [7, 3, 3]
  ])('a window of %i panes grows to a %ix%i tiled grid, each cell the box size plus 1-cell borders', async (count, across, down) => {
    h.panes = `${count}\n`
    await expect(fitHiddenPane(origin, 100, 30)).resolves.toBe(true)
    expect(resizes()).toEqual([[String(across * 100 + across - 1), String(down * 30 + down - 1)]])
    expect(tiled()).toBe(true)
  })

  it('caps a huge split window at 1000x500 cells', async () => {
    h.panes = '9\n'
    await fitHiddenPane(origin, 400, 200)
    expect(resizes()).toEqual([['1000', '500']])
  })

  it('clamps the requested box to 40..400 cols and 10..200 rows', async () => {
    await fitHiddenPane(origin, 5, 2)
    await fitHiddenPane(origin, 9000, 9000)
    expect(resizes()).toEqual([['40', '10'], ['400', '200']])
  })

  it('treats an unreadable pane count as one pane', async () => {
    h.panes = 'garbage'
    await fitHiddenPane(origin, 100, 30)
    expect(resizes()).toEqual([['100', '30']])
    expect(tiled()).toBe(false)
  })

  it('does not re-tile when the resize failed', async () => {
    h.panes = '4\n'
    h.resizeFails = true
    await expect(fitHiddenPane(origin, 100, 30)).resolves.toBe(false)
    expect(tiled()).toBe(false)
  })

  it('never resizes a pane the user has open in their own terminal', async () => {
    h.clients = '\nattached,focused,UTF-8\n'
    h.panes = '4\n'
    await expect(fitHiddenPane(origin, 100, 30)).resolves.toBe(false)
    expect(resizes()).toEqual([])
    expect(tiled()).toBe(false)
  })
})
