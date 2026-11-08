import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() }
}))
vi.mock('../store/paths', () => ({ PATHS: { TMP: '/tmp/mm-test-unused' } }))
vi.mock('../store/prefs', () => ({ PREFS: { getOsScreenshots: () => false } }))
vi.mock('../capture/os-screenshots', () => ({ screenshotDir: () => null }))
vi.mock('../agent-relay/mcp/http-listener', () => ({ listedAgentSessions: () => [] }))

import { CHANNELS } from '../../shared/ipc'
import type { FileReadResult, FileWriteResult } from '../../shared/types'
import { registerFilesHandlers } from '../files-ipc'

const ROOT = mkdtempSync('/tmp/mm-files-ipc-')
const read = (path: string, limit?: number) =>
  handlers.get(CHANNELS.filesRead)!({}, path, limit) as Promise<FileReadResult>
const write = (path: string, text: string, expectMtimeMs: number) =>
  handlers.get(CHANNELS.filesWrite)!({}, path, text, expectMtimeMs) as Promise<FileWriteResult>

beforeAll(() => registerFilesHandlers())
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('files read', () => {
  it('reads a text file under /tmp with its size and mtime', async () => {
    const path = join(ROOT, 'notes.md')
    writeFileSync(path, '# hello')
    const r = await read(path)
    expect(r).toMatchObject({ path, text: '# hello', size: 7, mtimeMs: statSync(path).mtimeMs })
    expect(r.error).toBeUndefined()
  })

  it('refuses a .env file and returns no text', async () => {
    const path = join(ROOT, '.env.local')
    writeFileSync(path, 'STRIPE_KEY=sk_live_x')
    const r = await read(path)
    expect(r.error).toBe('secret')
    expect(r.text).toBeUndefined()
  })

  it('refuses paths outside home and tmp, including prefix tricks and ..', async () => {
    const outside = join(tmpdir(), `mm-files-ipc-outside-${process.pid}.txt`)
    writeFileSync(outside, 'x')
    try {
      for (const path of ['/etc/hosts', '/tmpx/a.txt', `${ROOT}/../../etc/hosts`, 'relative/a.txt', outside]) {
        const r = await read(path)
        expect(r.error, path).toBe('outside')
        expect(r.text, path).toBeUndefined()
      }
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('flags binary content instead of returning it as text', async () => {
    const path = join(ROOT, 'blob.bin')
    writeFileSync(path, Buffer.from([0x50, 0x4b, 0x00, 0x03]))
    const r = await read(path)
    expect(r.binary).toBe(true)
    expect(r.text).toBeUndefined()
  })

  it('honours a byte limit', async () => {
    const path = join(ROOT, 'long.txt')
    writeFileSync(path, 'abcdefghij')
    expect((await read(path, 4)).text).toBe('abcd')
  })

  it('reports missing files and directories', async () => {
    expect((await read(join(ROOT, 'nope.txt'))).error).toBe('missing')
    expect((await read(ROOT)).error).toBe('directory')
  })

  it('refuses an SSH private key (no secret-looking suffix)', async () => {
    mkdirSync(join(ROOT, '.ssh'), { recursive: true })
    const path = join(ROOT, '.ssh', 'id_ed25519')
    writeFileSync(path, '-----BEGIN OPENSSH PRIVATE KEY-----')
    const r = await read(path)
    expect(r.text).toBeUndefined()
    expect(r.error).toBe('secret')
  })

  it('refuses a harmless-looking symlink that points at a .env file', async () => {
    const secret = join(ROOT, '.env')
    const link = join(ROOT, 'readme.txt')
    writeFileSync(secret, 'OPENAI_API_KEY=sk-x')
    symlinkSync(secret, link)
    const r = await read(link)
    expect(r.text).toBeUndefined()
  })
})

describe('files write', () => {
  it('saves when the file has not changed since it was opened', async () => {
    const path = join(ROOT, 'edit.md')
    writeFileSync(path, 'v1')
    const opened = await read(path)
    const r = await write(path, 'v2', opened.mtimeMs)
    expect(r.ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('v2')
    if (r.ok) expect(r.mtimeMs).toBe(statSync(path).mtimeMs)
  })

  it('refuses to overwrite a newer write from an agent, leaving it intact', async () => {
    const path = join(ROOT, 'race.md')
    writeFileSync(path, 'mine')
    const opened = await read(path)
    writeFileSync(path, 'agent wrote this')
    const later = opened.mtimeMs + 5_000
    const { utimesSync } = await import('fs')
    utimesSync(path, later / 1000, later / 1000)
    expect(await write(path, 'stale editor buffer', opened.mtimeMs)).toEqual({ ok: false, reason: 'conflict' })
    expect(readFileSync(path, 'utf8')).toBe('agent wrote this')
  })

  it('creates a new file and leaves no temp file behind', async () => {
    const path = join(ROOT, 'fresh.txt')
    expect((await write(path, 'hi', 0)).ok).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('hi')
    expect(existsSync(join(ROOT, `.fresh.txt.mm-${process.pid}.tmp`))).toBe(false)
  })

  it('never writes a secret file or outside home/tmp', async () => {
    const secret = join(ROOT, 'prod.pem')
    const outside = join(tmpdir(), `mm-files-ipc-w-${process.pid}.txt`)
    expect(await write(secret, 'x', 0)).toEqual({ ok: false, reason: 'forbidden' })
    expect(await write(outside, 'x', 0)).toEqual({ ok: false, reason: 'forbidden' })
    expect(existsSync(secret)).toBe(false)
    expect(existsSync(outside)).toBe(false)
  })
})
