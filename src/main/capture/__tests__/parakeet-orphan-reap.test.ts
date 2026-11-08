import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn as realSpawn, spawnSync as realSpawnSync, type ChildProcess } from 'child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(tmpdir(), `mm parakeet (reap).v1+${process.pid}`)
const calls = vi.hoisted(() => [] as string[][])

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawnSync: ((cmd: string, args: string[], ...rest: unknown[]) => {
      calls.push([cmd, ...args])
      return (actual.spawnSync as (...a: unknown[]) => unknown)(cmd, args, ...rest)
    }) as typeof actual.spawnSync,
    spawn: ((cmd: string, args: string[], ...rest: unknown[]) => {
      calls.push([cmd, ...args])
      return (actual.spawn as (...a: unknown[]) => unknown)(cmd, args, ...rest)
    }) as typeof actual.spawn
  }
})
vi.mock('../../store/paths', async () => {
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  return { PATHS: { BIN: j(t(), `mm parakeet (reap).v1+${process.pid}`, 'bin') } }
})
vi.mock('../binaries', async () => {
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  return { whisperModelPathFor: (name: string) => j(t(), `mm parakeet (reap).v1+${process.pid}`, name) }
})

import { CONFIG } from '../../../shared/config'
import { disposeParakeetServer, ensureParakeetServer } from '../parakeet-server'

const BIN = join(ROOT, 'bin', CONFIG.PARAKEET_BIN_SUBPATH)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

function startOrphan(): number {
  const out = realSpawnSync('/bin/sh', ['-c', `"${BIN}" serve --left-by-a-killed-app >/dev/null 2>&1 & echo $!`], {
    encoding: 'utf8'
  })
  return Number(out.stdout.trim())
}

const ppidOf = (pid: number): number =>
  Number(realSpawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim())

describe('parakeet server reaps servers orphaned by a SIGKILLed app before spawning', () => {
  let orphans: number[] = []
  let ours: ChildProcess | null = null

  beforeAll(() => {
    mkdirSync(join(BIN, '..'), { recursive: true })
    writeFileSync(BIN, `#!${process.execPath}\nsetTimeout(() => {}, 60_000)\n`)
    chmodSync(BIN, 0o755)
    writeFileSync(join(ROOT, CONFIG.PARAKEET_MODEL_NAME), '')
    vi.stubGlobal('fetch', async () => {
      throw new Error('no server in tests')
    })
  })

  afterAll(() => {
    disposeParakeetServer()
    ours?.kill('SIGKILL')
    for (const pid of orphans) if (alive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(ROOT, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('runs pkill on launchd-parented copies of this exact binary, before the new spawn', () => {
    expect(ensureParakeetServer()).toBe(true)
    const pkill = calls.findIndex((c) => c[0] === 'pkill')
    const spawned = calls.findIndex((c) => c[0] === BIN)
    expect(pkill).toBeGreaterThanOrEqual(0)
    expect(pkill).toBeLessThan(spawned)
    const [, flagP, ppid, flagF, pattern] = calls[pkill]
    expect([flagP, ppid, flagF]).toEqual(['-P', '1', '-f'])
    const re = new RegExp(pattern)
    expect(re.test(`${BIN} serve --port 1`)).toBe(true)
    expect(re.test(BIN.replace('(reap).v1+', '(reap)Xv11'))).toBe(false)
    disposeParakeetServer()
  })

  it.runIf(process.platform === 'darwin')('kills 3 real orphans and spares a server this app still owns', async () => {
    calls.length = 0
    orphans = [startOrphan(), startOrphan(), startOrphan()]
    expect(await until(() => orphans.every((pid) => ppidOf(pid) === 1))).toBe(true)
    ours = realSpawn(BIN, ['serve', '--still-owned'], { stdio: 'ignore' })
    expect(await until(() => alive(ours!.pid!))).toBe(true)

    expect(ensureParakeetServer()).toBe(true)

    expect(await until(() => orphans.every((pid) => !alive(pid)))).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    expect(ours.signalCode).toBeNull()
    expect(ours.exitCode).toBeNull()
    disposeParakeetServer()
  })
})
