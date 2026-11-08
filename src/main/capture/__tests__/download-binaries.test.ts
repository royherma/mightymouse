import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'

// The checksum branch is the only thing between a user and a silently corrupt
// ffmpeg, and a corrupt one fails at RECORD time — long after the setup row went
// green — so it is exercised here rather than trusted by reading.
//
// https.get and the write stream are faked, so a test can assert the real
// contract: on any failure NOTHING is renamed into place.

const BODY = Buffer.from('a pretend ffmpeg binary')

const httpsGet = vi.fn()
const renameSync = vi.fn()
const unlinkSync = vi.fn()
const chmodSync = vi.fn()
const clearBinaryCache = vi.fn()

/** The write stream handed out by the most recent createWriteStream() call. */
let currentFile: (EventEmitter & { close: (cb?: () => void) => void }) | null = null

vi.mock('https', () => ({ get: (url: string, cb: (res: unknown) => void) => httpsGet(url, cb) }))

vi.mock('fs', () => ({
  createWriteStream: () => {
    const s = Object.assign(new EventEmitter(), {
      close: (cb?: () => void) => cb?.()
    })
    currentFile = s
    return s
  },
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  renameSync: (a: string, b: string) => renameSync(a, b),
  unlinkSync: (p: string) => unlinkSync(p),
  chmodSync: (p: string, m: number) => chmodSync(p, m)
}))

vi.mock('../../store/paths', () => ({ PATHS: { BIN: '/home/u/MightyMouse/bin' } }))
vi.mock('../../platform', () => ({ clearBinaryCache: () => clearBinaryCache() }))
// Recomputed inside the factory: vi.mock is hoisted above the consts above.
vi.mock('../../../shared/config', () => {
  const body = Buffer.from('a pretend ffmpeg binary')
  return {
    CONFIG: {
      FFMPEG_DOWNLOAD: {
        arm64: {
          url: 'https://example.test/ffmpeg-arm64',
          sha256: createHash('sha256').update(body).digest('hex'),
          bytes: body.length
        }
      },
      WHISPER_DOWNLOAD: {
        arm64: {
          url: 'https://example.test/whisper-cli-arm64',
          sha256: createHash('sha256').update(body).digest('hex'),
          bytes: body.length
        }
      }
    }
  }
})

import {
  downloadManagedFfmpeg,
  downloadManagedWhisper,
  downloadFailureReason
} from '../download-binaries'

/**
 * Serve one fake HTTPS response.
 *
 * `contentLength` is stated separately from `body` on purpose: sending fewer
 * bytes than promised is how a truncated download is simulated, and that case
 * ends the stream cleanly — only the byte count catches it.
 */
function serve(body: Buffer, contentLength = body.length, statusCode = 200): void {
  httpsGet.mockImplementation((_url: string, cb: (res: unknown) => void) => {
    const res = Object.assign(new EventEmitter(), {
      statusCode,
      headers: { 'content-length': String(contentLength) },
      resume: () => {},
      // Stand in for res.pipe(file): hand the body over, then fire the write
      // stream's 'finish', which is what the downloader actually waits on.
      pipe: () => {
        setImmediate(() => {
          res.emit('data', body)
          currentFile?.emit('finish')
        })
      }
    })
    cb(res)
    return new EventEmitter()
  })
}

describe('downloadManagedFfmpeg', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentFile = null
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
  })

  it('rejects a body whose checksum does not match, and leaves nothing behind', async () => {
    serve(Buffer.from('a pretend ffmpeg binary!'), 24)
    const out = await downloadManagedFfmpeg()
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/checksum mismatch/)
    // A corrupt binary at the destination would look installed and then fail at
    // record time, so the partial must be deleted and never renamed.
    expect(renameSync).not.toHaveBeenCalled()
    expect(unlinkSync).toHaveBeenCalled()
  })

  it('rejects a truncated body even though the stream ended cleanly', async () => {
    serve(BODY.subarray(0, 5), BODY.length)
    const out = await downloadManagedFfmpeg()
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/incomplete download/)
    expect(renameSync).not.toHaveBeenCalled()
  })

  it('accepts a good body: chmod +x, atomic rename, resolver cache cleared', async () => {
    serve(BODY)
    const out = await downloadManagedFfmpeg()
    expect(out.ok).toBe(true)
    expect(chmodSync).toHaveBeenCalledWith(expect.stringMatching(/\.part$/), 0o755)
    expect(renameSync).toHaveBeenCalledWith(
      expect.stringMatching(/\.part$/),
      expect.not.stringMatching(/\.part$/)
    )
    // Without this the startup "not found" stays memoised and the app keeps
    // reporting a missing ffmpeg that is sitting on disk.
    expect(clearBinaryCache).toHaveBeenCalled()
  })

  it('reports a non-200 rather than saving the error page as a binary', async () => {
    serve(Buffer.from('404 not found'), 13, 404)
    const out = await downloadManagedFfmpeg()
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/HTTP 404/)
    expect(renameSync).not.toHaveBeenCalled()
  })

  it('fails cleanly on an architecture we publish no binary for', async () => {
    Object.defineProperty(process, 'arch', { value: 'ppc64', configurable: true })
    const out = await downloadManagedFfmpeg()
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/no managed ffmpeg/)
  })

  it('reports progress as a percentage of the total', async () => {
    serve(BODY)
    const pcts: number[] = []
    await downloadManagedFfmpeg((p) => pcts.push(p))
    expect(pcts.at(-1)).toBe(100)
  })
})

describe('downloadManagedWhisper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentFile = null
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
  })

  // Both wrappers call the same downloader, so the failure paths above already
  // cover it. What is whisper-specific is the pair the wrapper picks: the wrong
  // filename installs an engine resolveBinary('whisper-cli') never finds, and
  // the wrong spec would fetch ffmpeg's bytes under whisper's name.
  it('fetches the whisper URL and installs it as whisper-cli, not ffmpeg', async () => {
    serve(BODY)
    const out = await downloadManagedWhisper()
    expect(out.ok).toBe(true)
    expect(httpsGet).toHaveBeenCalledWith(
      'https://example.test/whisper-cli-arm64',
      expect.anything()
    )
    expect(out.path).toBe('/home/u/MightyMouse/bin/whisper-cli')
    expect(renameSync).toHaveBeenCalledWith(
      '/home/u/MightyMouse/bin/whisper-cli.part',
      '/home/u/MightyMouse/bin/whisper-cli'
    )
  })

  it('names whisper-cli in the unsupported-arch error, so analytics buckets it', async () => {
    Object.defineProperty(process, 'arch', { value: 'ppc64', configurable: true })
    const out = await downloadManagedWhisper()
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/no managed whisper-cli/)
    expect(downloadFailureReason(out.error)).toBe('unsupported-arch')
  })
})

describe('downloadFailureReason', () => {
  // The bucket drives a product decision — `checksum` means a bad release and
  // every user is broken; `network` means one user should retry — so a bucket
  // that silently collapsed into the catch-all would misreport that.
  it.each([
    ['checksum mismatch (expected abc123def456…)', 'checksum'],
    ['incomplete download (5 of 23 bytes)', 'truncated'],
    ['HTTP 404', 'http'],
    ['could not save: EACCES', 'disk'],
    ['no managed ffmpeg for ppc64', 'unsupported-arch'],
    ['getaddrinfo ENOTFOUND github.com', 'network']
  ])('buckets %j as %j', (error, bucket) => {
    expect(downloadFailureReason(error)).toBe(bucket)
  })

  it('reports no error as none, not as a failure bucket', () => {
    expect(downloadFailureReason(undefined)).toBe('none')
  })

  it('never leaks the raw message, which embeds $HOME via the .part path', () => {
    const raw = 'could not save: EACCES /Users/jane.doe/MightyMouse/bin/ffmpeg.part'
    expect(downloadFailureReason(raw)).toBe('disk')
    expect(downloadFailureReason(raw)).not.toContain('jane.doe')
  })
})
