import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as string[][], mouseFlags: '11\n' as string | null }))

vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    h.calls.push([cmd, ...args])
    if (args.includes('display-message')) {
      if (h.mouseFlags === null) return cb(new Error('no pane'), '')
      return cb(null, h.mouseFlags)
    }
    cb(null, '')
  }
}))

vi.mock('../../platform', () => ({
  resolveBinary: vi.fn(() => '/opt/homebrew/bin/tmux'),
  input: { pressKeys: async () => undefined }
}))

vi.mock('../origin-resolver', () => ({ resolveOrigin: async () => 'tmux' }))

import { sendPaneKeys } from '../picker-keys'

const origin = { tmuxPane: '%5' } as never

const hex = (s: string): string[] => [...Buffer.from(s)].map((b) => b.toString(16).padStart(2, '0'))
const sends = (): string[][] => h.calls.filter((c) => c.includes('send-keys') || c.includes('set-buffer'))

beforeEach(() => {
  h.calls = []
  h.mouseFlags = '11\n'
})

describe('sendPaneKeys wheel passthrough', () => {
  it('sends wheel-up as an SGR mouse report at the 1-based cell', async () => {
    await expect(sendPaneKeys(origin, [{ wheel: 'up', col: 0, row: 0 }])).resolves.toBe(true)
    expect(sends()).toEqual([
      ['/opt/homebrew/bin/tmux', 'send-keys', '-t', '%5', '-H', ...hex('\x1b[<64;1;1M')]
    ])
  })

  it('sends wheel-down as button 65 and rounds fractional cells', async () => {
    await sendPaneKeys(origin, [{ wheel: 'down', col: 11.6, row: 4.2 }])
    expect(sends()[0].slice(5)).toEqual(hex('\x1b[<65;13;5M'))
  })

  it('clamps the cell into the 1..999 range an SGR report can carry', async () => {
    await sendPaneKeys(origin, [{ wheel: 'up', col: -20, row: 5000 }])
    expect(sends()[0].slice(5)).toEqual(hex('\x1b[<64;1;999M'))
  })

  it('chains several notches into one tmux call', async () => {
    await sendPaneKeys(origin, [
      { wheel: 'up', col: 2, row: 3 },
      { wheel: 'up', col: 2, row: 3 }
    ])
    const send = h.calls.filter((c) => c.includes('send-keys'))
    expect(send).toHaveLength(1)
    const bytes = hex('\x1b[<64;3;4M')
    expect(send[0]).toEqual(['/opt/homebrew/bin/tmux', 'send-keys', '-t', '%5', '-H', ...bytes, ';', 'send-keys', '-t', '%5', '-H', ...bytes])
  })

  it.each([
    ['mouse mode off', '00\n'],
    ['mouse on but not SGR encoding', '10\n'],
    ['the pane cannot be read', null]
  ])('sends nothing when %s, so the escape bytes never land as typed text', async (_name, flags) => {
    h.mouseFlags = flags
    await expect(sendPaneKeys(origin, [{ wheel: 'up', col: 1, row: 1 }])).resolves.toBe(false)
    expect(sends()).toEqual([])
  })

  it('does not ask about mouse mode for plain keys', async () => {
    h.mouseFlags = '00\n'
    await expect(sendPaneKeys(origin, [{ key: 'Enter' }])).resolves.toBe(true)
    expect(h.calls.some((c) => c.includes('display-message'))).toBe(false)
  })

  it('reads mouse mode on the session socket when the pane has one', async () => {
    await sendPaneKeys({ tmuxPane: '%5', tmuxSocket: '/tmp/s' } as never, [{ wheel: 'down', col: 0, row: 0 }])
    expect(h.calls[0]).toEqual(['/opt/homebrew/bin/tmux', '-S', '/tmp/s', 'display-message', '-p', '-t', '%5', '#{mouse_any_flag}#{mouse_sgr_flag}'])
    expect(h.calls[1].slice(0, 3)).toEqual(['/opt/homebrew/bin/tmux', '-S', '/tmp/s'])
  })
})
