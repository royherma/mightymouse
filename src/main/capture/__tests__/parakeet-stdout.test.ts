import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(tmpdir(), `mm-parakeet-stdout-${process.pid}`)
const MARKER = join(ROOT, 'wrote-everything')

vi.mock('../../store/paths', async () => {
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  return { PATHS: { BIN: j(t(), `mm-parakeet-stdout-${process.pid}`, 'bin') } }
})
vi.mock('../binaries', async () => {
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  return { whisperModelPathFor: (name: string) => j(t(), `mm-parakeet-stdout-${process.pid}`, name) }
})

import { CONFIG } from '../../../shared/config'
import { disposeParakeetServer, ensureParakeetServer } from '../parakeet-server'

const BIN = join(ROOT, 'bin', CONFIG.PARAKEET_BIN_SUBPATH)

beforeAll(() => {
  mkdirSync(join(BIN, '..'), { recursive: true })
  writeFileSync(BIN, `#!/bin/sh\nhead -c 300000 /dev/zero\ntouch "${MARKER}"\nexec sleep 34.6\n`)
  chmodSync(BIN, 0o755)
  writeFileSync(join(ROOT, CONFIG.PARAKEET_MODEL_NAME), '')
  vi.stubGlobal('fetch', async () => {
    throw new Error('no server in tests')
  })
})
afterAll(() => {
  disposeParakeetServer()
  rmSync(ROOT, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('parakeet server that logs heavily to stdout', () => {
  it('is never blocked on a full stdout pipe nobody reads', async () => {
    expect(ensureParakeetServer()).toBe(true)
    const end = Date.now() + 2000
    while (!existsSync(MARKER) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(MARKER)).toBe(true)
  })
})
