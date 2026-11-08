import { describe, expect, it } from 'vitest'
import { isPrefixKey, paneInDirection, prefixCommand } from '../pane-prefix-keys'

type Mods = { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

const key = (k: string, mods: Mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods })

describe('isPrefixKey', () => {
  it('is Ctrl-B', () => {
    expect(isPrefixKey(key('b', { ctrlKey: true }))).toBe(true)
  })

  it('is still Ctrl-B with caps lock on', () => {
    expect(isPrefixKey(key('B', { ctrlKey: true }))).toBe(true)
  })

  it.each([
    ['plain b', key('b')],
    ['Cmd-B', key('b', { metaKey: true })],
    ['Ctrl-Cmd-B', key('b', { ctrlKey: true, metaKey: true })],
    ['Ctrl-Alt-B', key('b', { ctrlKey: true, altKey: true })],
    ['Ctrl-Shift-B', key('B', { ctrlKey: true, shiftKey: true })],
    ['Ctrl-V', key('v', { ctrlKey: true })]
  ])('is not %s', (_name, e) => {
    expect(isPrefixKey(e)).toBe(false)
  })
})

describe('prefixCommand', () => {
  it.each([
    ['ArrowLeft', { kind: 'move', dir: 'left' }],
    ['ArrowRight', { kind: 'move', dir: 'right' }],
    ['ArrowUp', { kind: 'move', dir: 'up' }],
    ['ArrowDown', { kind: 'move', dir: 'down' }],
    ['q', { kind: 'numbers' }],
    ['z', { kind: 'zoom' }],
    ['o', { kind: 'next-pane' }],
    ['x', { kind: 'close' }],
    ['c', { kind: 'new-tab' }],
    ['n', { kind: 'tab', step: 1 }],
    ['p', { kind: 'tab', step: -1 }]
  ])('%s', (k, cmd) => {
    expect(prefixCommand(key(k))).toEqual(cmd)
  })

  it.each([
    ['%', { kind: 'split' }],
    ['"', { kind: 'split' }],
    ['?', { kind: 'help' }]
  ])('%s, which needs Shift to type', (k, cmd) => {
    expect(prefixCommand(key(k, { shiftKey: true }))).toEqual(cmd)
  })

  it('1 jumps to the first pane and 9 to the ninth', () => {
    expect(prefixCommand(key('1'))).toEqual({ kind: 'jump', index: 0 })
    expect(prefixCommand(key('9'))).toEqual({ kind: 'jump', index: 8 })
  })

  it.each(['0', 'a', 'Escape', 'Enter', ' ', '10'])('does nothing for %j', (k) => {
    expect(prefixCommand(key(k))).toBeNull()
  })

  it.each([
    ['Cmd', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['Alt', { altKey: true }]
  ])('leaves %s shortcuts alone', (_name, mods) => {
    expect(prefixCommand(key('x', mods))).toBeNull()
    expect(prefixCommand(key('ArrowLeft', mods))).toBeNull()
    expect(prefixCommand(key('1', mods))).toBeNull()
  })
})

describe('paneInDirection', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom })

  const grid = [
    { id: 'top-left', box: box(0, 0, 400, 300) },
    { id: 'top-right', box: box(408, 0, 808, 300) },
    { id: 'bottom-left', box: box(0, 308, 400, 608) },
    { id: 'bottom-right', box: box(408, 308, 808, 608) }
  ]

  it.each([
    ['top-left', 'right', 'top-right'],
    ['top-left', 'down', 'bottom-left'],
    ['top-right', 'left', 'top-left'],
    ['top-right', 'down', 'bottom-right'],
    ['bottom-left', 'up', 'top-left'],
    ['bottom-left', 'right', 'bottom-right'],
    ['bottom-right', 'up', 'top-right'],
    ['bottom-right', 'left', 'bottom-left']
  ] as const)('in a 2x2 grid, %s going %s lands on %s', (from, dir, to) => {
    expect(paneInDirection(grid, from, dir)).toBe(to)
  })

  it.each([
    ['top-left', 'left'],
    ['top-left', 'up'],
    ['bottom-right', 'right'],
    ['bottom-right', 'down']
  ] as const)('stays put at the edge: %s going %s', (from, dir) => {
    expect(paneInDirection(grid, from, dir)).toBeNull()
  })

  it('picks the nearest pane in a row of three', () => {
    const row = [
      { id: 'a', box: box(0, 0, 400, 600) },
      { id: 'b', box: box(408, 0, 808, 600) },
      { id: 'c', box: box(816, 0, 1216, 600) }
    ]
    expect(paneInDirection(row, 'a', 'right')).toBe('b')
    expect(paneInDirection(row, 'c', 'left')).toBe('b')
    expect(paneInDirection(row, 'b', 'right')).toBe('c')
  })

  it('from a tall pane, goes to the neighbour closer to its middle', () => {
    const layout = [
      { id: 'tall', box: box(0, 0, 400, 600) },
      { id: 'small-top', box: box(408, 0, 808, 100) },
      { id: 'big-bottom', box: box(408, 108, 808, 600) }
    ]
    expect(paneInDirection(layout, 'tall', 'right')).toBe('big-bottom')
    expect(paneInDirection(layout, 'small-top', 'left')).toBe('tall')
    expect(paneInDirection(layout, 'big-bottom', 'left')).toBe('tall')
  })

  it('still finds a neighbour whose edge overlaps by under a pixel', () => {
    const touching = [
      { id: 'a', box: box(0, 0, 400.4, 600) },
      { id: 'b', box: box(399.6, 0, 800, 600) }
    ]
    expect(paneInDirection(touching, 'a', 'right')).toBe('b')
    expect(paneInDirection(touching, 'b', 'left')).toBe('a')
    expect(paneInDirection(touching, 'a', 'left')).toBeNull()
  })

  it('returns null with one pane, or when the starting pane is gone', () => {
    expect(paneInDirection([grid[0]], 'top-left', 'right')).toBeNull()
    expect(paneInDirection(grid, 'closed-pane', 'right')).toBeNull()
    expect(paneInDirection([], 'top-left', 'right')).toBeNull()
  })
})
