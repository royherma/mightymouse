import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(tmpdir(), `mm-system-audio-${process.pid}`)
const HELPER = join(ROOT, 'system-audio')
const spawned = vi.hoisted(() => [] as ChildProcess[])

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawn: ((...a: unknown[]) => {
      const proc = (actual.spawn as (...x: unknown[]) => ChildProcess)(...a)
      spawned.push(proc)
      return proc
    }) as typeof actual.spawn
  }
})
vi.mock('../../platform', async () => {
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  return { helpers: { resolve: () => j(t(), `mm-system-audio-${process.pid}`, 'system-audio') } }
})
vi.mock('../../../shared/env', () => ({ devLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { isCapturingSystemAudio, startSystemAudio, stopSystemAudio } from '../system-audio'

const alive = (pid: number | undefined): boolean => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (cond: () => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return cond()
}
const noop = { onPcm: () => {}, onError: () => {} }

const STARTS_SLOWLY = '#!/bin/sh\nsleep 0.4\nprintf "READY\\n"\nexec sleep 32.3\n'
const writeHelper = (script: string): void => {
  writeFileSync(HELPER, script)
  chmodSync(HELPER, 0o755)
}

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true })
})
beforeEach(() => writeHelper(STARTS_SLOWLY))
afterEach(() => {
  stopSystemAudio()
  for (const p of spawned.splice(0)) if (alive(p.pid)) p.kill('SIGKILL')
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('system-audio helper lifecycle', () => {
  it('a stop during startup kills the helper instead of leaving it capturing after READY', async () => {
    const started = startSystemAudio(noop)
    stopSystemAudio()
    await started.catch(() => undefined)

    expect(spawned).toHaveLength(1)
    expect(await waitFor(() => !alive(spawned[0].pid))).toBe(true)
    await new Promise((r) => setTimeout(r, 600))
    expect(isCapturingSystemAudio()).toBe(false)
  })

  it('a second start during startup does not spawn a second helper', async () => {
    const first = startSystemAudio(noop)
    const second = startSystemAudio(noop)
    await Promise.all([first, second])

    expect(spawned).toHaveLength(1)
    expect(isCapturingSystemAudio()).toBe(true)
  })
})

describe('system-audio helper output', () => {
  it('forwards every PCM byte after READY, even when READY is split or shares a chunk with audio', async () => {
    writeHelper('#!/bin/sh\nprintf "warming up\\nREA"\nsleep 0.1\nprintf "DY\\nPCM1"\nsleep 0.1\nprintf "PCM2"\nexec sleep 32.3\n')
    const chunks: Buffer[] = []
    await startSystemAudio({ onPcm: (c) => chunks.push(c), onError: () => {} })
    expect(await waitFor(() => Buffer.concat(chunks).toString() === 'PCM1PCM2')).toBe(true)
  })

  it('says the Mac is too old when the helper exits with the unsupported code', async () => {
    writeHelper('#!/bin/sh\nexit 2\n')
    await expect(startSystemAudio(noop)).rejects.toThrow('requires macOS 13')
    expect(isCapturingSystemAudio()).toBe(false)
  })

  it('tells the phone when the helper dies mid-stream', async () => {
    writeHelper('#!/bin/sh\nprintf "READY\\n"\nsleep 0.2\nexit 5\n')
    const onError = vi.fn()
    await startSystemAudio({ onPcm: () => {}, onError })
    expect(await waitFor(() => onError.mock.calls.length === 1)).toBe(true)
    expect(onError.mock.calls[0][0]).toContain('code 5')
    expect(isCapturingSystemAudio()).toBe(false)
  })
})
