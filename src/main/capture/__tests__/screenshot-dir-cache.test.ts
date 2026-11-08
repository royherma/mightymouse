import { describe, expect, it, vi } from 'vitest'

const execFileSync = vi.fn(() => '')
vi.mock('child_process', () => ({ execFileSync: () => execFileSync() }))
vi.mock('../../store/paths', () => ({ PATHS: {} }))
vi.mock('../insights', () => ({ readCachedInsights: vi.fn() }))

import { screenshotDir } from '../os-screenshots'

describe('screenshot folder lookup behind every media:// request', () => {
  it('asks `defaults` once for a grid of 100 thumbnails, not once per thumbnail', () => {
    for (let i = 0; i < 100; i++) screenshotDir()
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })
})
