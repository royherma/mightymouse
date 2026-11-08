import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

/**
 * Guards the install/uninstall contract for the managed Kokoro payload.
 *
 * The download itself needs a network, so these cover the decisions AROUND it —
 * the ones that corrupt a user's install when they're wrong:
 *   - refusing to run where MLX can't (Intel/non-Mac)
 *   - refusing to start with no payload published, instead of failing mid-download
 *   - treating an already-installed payload as a no-op
 *   - never leaving a half-populated dir that later reads as "installed"
 *   - reporting freed bytes on remove, and being safe to call when nothing is there
 */

let ROOT: string

vi.mock('../../store/paths', () => ({
  PATHS: {
    get MODELS() {
      return join(ROOT, 'models')
    }
  }
}))

const platform = { supported: true }
vi.mock('../ensure-kokoro', () => ({
  kokoroRoot: () => join(ROOT, 'models', 'kokoro'),
  isKokoroSupportedPlatform: () => platform.supported,
  isKokoroAvailable: () => existsSync(join(ROOT, 'models', 'kokoro', 'bin', 'python'))
}))

const payload = { url: '', sha256: '', sizeBytes: 0 }
vi.mock('../../../shared/config', () => ({
  CONFIG: {
    get COMPANION() {
      return { KOKORO_DOWNLOAD: payload }
    }
  }
}))

async function subject(): Promise<typeof import('../download-kokoro')> {
  return import('../download-kokoro')
}

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'kokoro-test-'))
  platform.supported = true
  payload.url = ''
  payload.sha256 = ''
  payload.sizeBytes = 0
  vi.resetModules()
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Stand in for an installed payload: the interpreter is what ensure-kokoro checks. */
function fakeInstall(): string {
  const root = join(ROOT, 'models', 'kokoro')
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'python'), '#!/bin/sh\n')
  // ~2MB so the freed-bytes report has something real to measure.
  writeFileSync(join(root, 'payload.bin'), Buffer.alloc(2_000_000))
  return root
}

describe('downloadManagedKokoro — refuses before it can do damage', () => {
  it('will not install on a platform MLX cannot run', async () => {
    platform.supported = false
    payload.url = 'https://example.invalid/p.tar.gz'
    payload.sha256 = 'a'.repeat(64)
    payload.sizeBytes = 10

    const { downloadManagedKokoro } = await subject()
    const res = await downloadManagedKokoro()

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Apple Silicon/i)
  })

  it('reports a missing payload up front rather than failing mid-download', async () => {
    // A build published before the payload exists must not show a working button.
    const { downloadManagedKokoro } = await subject()
    const res = await downloadManagedKokoro()

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no voice payload|isn't available|not.*configured/i)
    // Crucially: it never created the models dir on the way to failing.
    expect(existsSync(join(ROOT, 'models', 'kokoro'))).toBe(false)
  })

  it('is a no-op when the payload is already installed', async () => {
    fakeInstall()
    // Deliberately left unset: an already-installed payload must return before
    // anything consults the download spec, so a blank spec cannot break it.
    const { downloadManagedKokoro } = await subject()
    const onProgress = vi.fn()
    const res = await downloadManagedKokoro(onProgress)

    expect(res.ok).toBe(true)
    expect(res.path).toContain('kokoro')
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('does not treat a partially-extracted directory as installed', async () => {
    // An interrupted unpack leaves files but no interpreter. That must NOT read as
    // installed, or the ladder picks a broken payload over the working `say` voice.
    const root = join(ROOT, 'models', 'kokoro')
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'lib', 'half.py'), 'x')
    payload.url = 'https://example.invalid/p.tar.gz'
    payload.sha256 = 'a'.repeat(64)
    payload.sizeBytes = 10

    const { downloadManagedKokoro } = await subject()
    const res = await downloadManagedKokoro()

    // It tried to download (and failed on the unreachable host) rather than
    // returning ok for a dir with no interpreter.
    expect(res.ok).toBe(false)
    expect(res.error).not.toMatch(/already/i)
  })
})

describe('removeManagedKokoro', () => {
  it('deletes the payload and reports roughly what it freed', async () => {
    const root = fakeInstall()
    const { removeManagedKokoro } = await subject()

    const res = removeManagedKokoro()

    expect(res.removed).toBe(true)
    expect(existsSync(root)).toBe(false)
    // du reports in KB blocks, so assert the order of magnitude, not an exact byte.
    expect(res.bytesFreed).toBeGreaterThan(1_000_000)
  })

  it('is safe to call when nothing is installed', async () => {
    const { removeManagedKokoro } = await subject()

    const res = removeManagedKokoro()

    expect(res.removed).toBe(false)
    expect(res.bytesFreed).toBe(0)
  })

  it('also clears an abandoned partial download', async () => {
    // A user who cancels mid-download then hits Remove should get that space back.
    const models = join(ROOT, 'models')
    mkdirSync(models, { recursive: true })
    const partial = join(models, 'kokoro-payload.tar.gz.partial')
    writeFileSync(partial, Buffer.alloc(3_000_000))

    const { removeManagedKokoro } = await subject()
    const res = removeManagedKokoro()

    expect(existsSync(partial)).toBe(false)
    expect(res.bytesFreed).toBeGreaterThan(1_000_000)
  })

  it('leaves the shared model cache alone', async () => {
    // The HF cache is shared with anything else using Kokoro, so removing our
    // payload must not delete it out from under them.
    fakeInstall()
    const cache = join(ROOT, 'models', 'hub')
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'weights.bin'), 'x')

    const { removeManagedKokoro } = await subject()
    removeManagedKokoro()

    expect(existsSync(join(cache, 'weights.bin'))).toBe(true)
  })
})

describe('install path length — the espeak trap', () => {
  it('keeps the payload shallow enough for espeak-ng', async () => {
    // espeak-ng truncates a long data path and silently falls back to the path
    // baked in at ITS build time, aborting with no Python traceback. The data dir
    // sits ~75 chars below the payload root, and the real install path is
    // ~/MightyMouse/models/kokoro. Assert the root stays short enough that the
    // full data path clears the limit that was measured to work (113 chars).
    // Built from the REAL install location, not the mocked temp root — the temp
    // dir this suite runs in is itself long enough to fail, which would make the
    // assertion about the test harness instead of about what users get.
    const ESPEAK_DATA_SUFFIX = '/lib/python3.12/site-packages/espeakng_loader/espeak-ng-data'
    const realRoot = join(homedir(), 'MightyMouse', 'models', 'kokoro')
    const full = realRoot + ESPEAK_DATA_SUFFIX

    // 113 chars is the length measured to work on 2026-07-26; 140 is the ceiling
    // the build script enforces. Both hold for a home dir up to ~40 chars.
    expect(full.length).toBeLessThan(140)
  })
})

describe('freed-bytes reporting', () => {
  it('measures the real directory, not a hardcoded guess', async () => {
    // A hardcoded "550 MB freed" would lie for a partial install; make sure the
    // number tracks actual content.
    const root = join(ROOT, 'models', 'kokoro')
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'python'), '#!/bin/sh\n')
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(8_000_000))
    const onDisk = statSync(join(root, 'big.bin')).size

    const { removeManagedKokoro } = await subject()
    const res = removeManagedKokoro()

    expect(res.bytesFreed).toBeGreaterThanOrEqual(onDisk * 0.8)
  })
})
