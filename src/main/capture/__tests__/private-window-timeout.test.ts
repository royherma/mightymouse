import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BIN = join(tmpdir(), `mm-private-window-${process.pid}`)
const savedPath = process.env.PATH

vi.mock('../../../shared/config', () => ({ CONFIG: { OSASCRIPT_TIMEOUT_MS: 300 } }))

import { isPrivateContext } from '../private-window'

beforeAll(() => {
  mkdirSync(BIN, { recursive: true })
  writeFileSync(join(BIN, 'osascript'), '#!/bin/sh\nexec sleep 31.7\n')
  chmodSync(join(BIN, 'osascript'), 0o755)
  process.env.PATH = `${BIN}:${savedPath}`
})
afterAll(() => {
  process.env.PATH = savedPath
  rmSync(BIN, { recursive: true, force: true })
})

describe('incognito check against a browser that never answers Apple events', () => {
  it('gives up within the osascript timeout instead of waiting forever', async () => {
    const started = Date.now()
    const verdict = await Promise.race([
      isPrivateContext({ frontApp: 'Google Chrome', windowTitle: 'Inbox', browserURL: null }),
      new Promise((r) => setTimeout(() => r('still waiting'), 3000))
    ])
    expect(verdict).toBe(false)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
