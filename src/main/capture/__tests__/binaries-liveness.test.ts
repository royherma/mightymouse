import { describe, it, expect, beforeEach, vi } from 'vitest'

// A binary that exists on disk but dies on launch (a Homebrew ffmpeg whose
// x265 dylib was upgraded out from under it) read as "installed" for a full day
// on a real user's Mac, which hid the only button that could have replaced it.
// `found` must mean "runs", not "is a file".

const existsSync = vi.fn<(p: string) => boolean>()
const execFile = vi.fn()

vi.mock('fs', () => ({
  existsSync: (p: string) => existsSync(p),
  statSync: () => ({ size: 1 }),
  createWriteStream: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  statfsSync: vi.fn()
}))
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFile(...args),
  spawn: vi.fn()
}))
vi.mock('../../store/settings', () => ({
  SETTINGS: {
    get: () => ({
      ffmpegPath: '/opt/homebrew/bin/ffmpeg',
      whisperPath: '/opt/homebrew/bin/whisper-cli',
      whisperModelPath: '/none'
    })
  }
}))
vi.mock('../../store/paths', () => ({
  PATHS: { BIN: '/tmp/mm-bin', WHISPER_CACHE_DIR: '/tmp/mm-whisper' }
}))
vi.mock('../../platform', () => ({
  resolveNpm: vi.fn(),
  resolveBrewBin: vi.fn(),
  npmPrefixWritable: vi.fn(),
  clearBinaryCache: vi.fn()
}))

import { getBinaryStatuses } from '../binaries'

type Cb = (err: Error | null, stdout: string, stderr: string) => void

describe('getBinaryStatuses liveness', () => {
  beforeEach(() => {
    existsSync.mockReset()
    execFile.mockReset()
    existsSync.mockImplementation((p) => p !== '/none')
  })

  it('reads a binary that runs as found', async () => {
    execFile.mockImplementation((_bin: string, _a: string[], _o: unknown, cb: Cb) =>
      cb(null, 'ffmpeg version 7.1\n', '')
    )
    const [ffmpeg, whisper] = await getBinaryStatuses()
    expect(ffmpeg.found).toBe(true)
    expect(whisper.found).toBe(true)
  })

  // whisper-cli 1.8.2 writes nothing to stdout and starts its stderr usage
  // block with a newline, so line[0] is empty -- a live binary read as dead.
  it('reads a live binary whose output starts with a blank line as found', async () => {
    execFile.mockImplementation((_bin: string, _a: string[], _o: unknown, cb: Cb) =>
      cb(null, '', '\nusage: whisper-cli [options] file0 file1 ...\n')
    )
    const [, whisper] = await getBinaryStatuses()
    expect(whisper.found).toBe(true)
  })

  it('reads a binary that exists but crashes on launch as NOT found', async () => {
    execFile.mockImplementation((_bin: string, _a: string[], _o: unknown, cb: Cb) =>
      cb(new Error('dyld: Library not loaded: libx265.215.dylib'), '', '')
    )
    const [ffmpeg, whisper] = await getBinaryStatuses()
    expect(ffmpeg.found).toBe(false)
    expect(whisper.found).toBe(false)
  })
})
