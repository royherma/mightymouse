import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawn, execFile: vi.fn() }))
vi.mock('fs', () => ({ existsSync: () => true }))
vi.mock('../helpers', () => ({ resolveHelper: (name: string) => `/bin/${name}` }))

import { zoomMac } from '../input'

beforeEach(() => {
  spawn.mockReset().mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), { kill: vi.fn() })
    queueMicrotask(() => proc.emit('close', 0))
    return proc
  })
})

describe('zoomMac', () => {
  it('zooms in as one Cmd+= press per step, all in a single mm-input spawn', async () => {
    expect(await zoomMac(3)).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]).toEqual(['/bin/mm-input', ['key', 'cmd+=', 'cmd+=', 'cmd+=']])
  })

  it('zooms out as Cmd+- presses, one per notch of a negative step count', async () => {
    await zoomMac(-2)
    expect(spawn.mock.calls[0][1]).toEqual(['key', 'cmd+-', 'cmd+-'])
  })
})
