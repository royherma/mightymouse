import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Point PATHS.RUNS + PATHS.CAPTURES at throwaway dirs so the scanner reads real
// folders we lay down per test — no global ~/MightyMouse access.
const dirs = vi.hoisted(() => ({ RUNS: '', CAPTURES: '' }))
vi.mock('../../store/paths', () => ({
  get PATHS() {
    return dirs
  }
}))

// Import after the mock so the module binds to the mocked PATHS.
import { listMedia, deleteMedia } from '../media-library'

function writeWav(path: string, dataBytes: number): void {
  // 44-byte header + N data bytes; the scanner only reads the size, not content.
  writeFileSync(path, Buffer.alloc(44 + dataBytes))
}

describe('media-library scanner', () => {
  beforeEach(() => {
    dirs.RUNS = mkdtempSync(join(tmpdir(), 'mm-runs-'))
    dirs.CAPTURES = mkdtempSync(join(tmpdir(), 'mm-captures-'))
  })
  afterEach(() => {
    rmSync(dirs.RUNS, { recursive: true, force: true })
    rmSync(dirs.CAPTURES, { recursive: true, force: true })
  })

  // Make a folder under one of the roots and return its absolute path.
  function folder(root: string, name: string): string {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('picks kind from the media on disk, not the run name', () => {
    // New runs/ layout: name says "ask"/"act", but content decides the kind.
    const shot = folder(dirs.RUNS, '2026-05-29T08-20-41-566Z-ask-look-at-this-r-1a')
    writeFileSync(join(shot, 'screenshot.png'), Buffer.alloc(10))
    writeFileSync(join(shot, 'run.json'), JSON.stringify({ ts: '2026-05-29T08:20:41.566Z' }))

    const rec = folder(dirs.RUNS, '2026-05-30T10-00-00-000Z-recording-clip-r-2b')
    writeFileSync(join(rec, 'screen.mp4'), Buffer.alloc(10))
    writeFileSync(join(rec, 'run.json'), JSON.stringify({ ts: '2026-05-30T10:00:00.000Z' }))

    const voice = folder(dirs.RUNS, '2026-05-31T12-30-15-250Z-listen-note-l-3c')
    writeWav(join(voice, 'audio.wav'), 16000 * 2)
    writeFileSync(join(voice, 'run.json'), JSON.stringify({ ts: '2026-05-31T12:30:15.250Z' }))

    const items = listMedia()
    expect(items).toHaveLength(3)
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]))
    expect(byKind.screenshot.ts).toBe('2026-05-29T08:20:41.566Z')
    expect(byKind.recording.ts).toBe('2026-05-30T10:00:00.000Z')
    expect(byKind.listen.ts).toBe('2026-05-31T12:30:15.250Z')
  })

  it('skips text-only runs that have no media file', () => {
    const textRun = folder(dirs.RUNS, '2026-06-01T09-00-00-000Z-rewrite-fix-grammar-r-9z')
    writeFileSync(join(textRun, 'run.json'), JSON.stringify({ ts: '2026-06-01T09:00:00.000Z' }))
    writeFileSync(join(textRun, 'out-1.txt'), 'the rewritten text')
    expect(listMedia()).toHaveLength(0)
  })

  it('still reads the legacy captures/ layout (kind + ts from the name)', () => {
    const shot = folder(dirs.CAPTURES, 'shot-2026-05-29T08-20-41-566Z')
    writeFileSync(join(shot, 'screenshot.png'), Buffer.alloc(10))
    const rec = folder(dirs.CAPTURES, 'rec-2026-05-30T10-00-00-000Z')
    writeFileSync(join(rec, 'screen.mp4'), Buffer.alloc(10))
    const listen = folder(dirs.CAPTURES, 'listen-2026-05-31T12-30-15-250Z')
    writeWav(join(listen, 'audio.wav'), 16000 * 2)

    const items = listMedia()
    expect(items).toHaveLength(3)
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]))
    expect(byKind.screenshot.ts).toBe('2026-05-29T08:20:41.566Z')
    expect(byKind.recording.ts).toBe('2026-05-30T10:00:00.000Z')
    expect(byKind.listen.ts).toBe('2026-05-31T12:30:15.250Z')
  })

  it('merges both roots and sorts newest first', () => {
    const legacy = folder(dirs.CAPTURES, 'shot-2026-05-29T08-20-41-566Z')
    writeFileSync(join(legacy, 'screenshot.png'), Buffer.alloc(10))
    const fresh = folder(dirs.RUNS, '2026-06-01T08-20-41-566Z-screenshot-x-r-4d')
    writeFileSync(join(fresh, 'screenshot.png'), Buffer.alloc(10))
    writeFileSync(join(fresh, 'run.json'), JSON.stringify({ ts: '2026-06-01T08:20:41.566Z' }))

    const items = listMedia()
    expect(items).toHaveLength(2)
    expect(items[0].ts).toBe('2026-06-01T08:20:41.566Z') // newest first
  })

  it('ignores folders with no media (manifests, junk dirs)', () => {
    const shot = folder(dirs.RUNS, '2026-05-29T08-20-41-566Z-screenshot-x-r-5e')
    writeFileSync(join(shot, 'screenshot.png'), Buffer.alloc(10))
    folder(dirs.RUNS, 'backups')
    folder(dirs.CAPTURES, 'rec-not-a-timestamp') // no media file inside
    expect(listMedia()).toHaveLength(1)
  })

  it('attaches media paths, transcript, word count, and context', () => {
    const dir = folder(dirs.RUNS, '2026-05-31T12-30-15-250Z-listen-note-l-6f')
    writeWav(join(dir, 'audio.wav'), 16000 * 2 * 3) // 3 seconds @ 16kHz mono 16-bit
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ ts: '2026-05-31T12:30:15.250Z' }))
    writeFileSync(join(dir, 'transcript.txt'), 'hello there friend')
    writeFileSync(
      join(dir, 'context-listen-start.txt'),
      '# listen\nts: x\nfront_app: Safari\nwindow_title: Tab\nbrowser_url: https://example.com\n'
    )

    const [item] = listMedia()
    expect(item.kind).toBe('listen')
    expect(item.audioPath).toBe(join(dir, 'audio.wav'))
    expect(item.durationS).toBe(3)
    expect(item.transcript).toBe('hello there friend')
    expect(item.wordCount).toBe(3)
    expect(item.frontApp).toBe('Safari')
    expect(item.browserUrl).toBe('https://example.com')
    expect(item.sizeBytes).toBeGreaterThan(0)
  })

  it('returns [] when neither media root exists', () => {
    rmSync(dirs.RUNS, { recursive: true, force: true })
    rmSync(dirs.CAPTURES, { recursive: true, force: true })
    expect(listMedia()).toEqual([])
  })

  it('deletes a folder under a media root and rejects paths outside them', async () => {
    const dir = folder(dirs.RUNS, '2026-05-29T08-20-41-566Z-screenshot-x-r-7g')
    writeFileSync(join(dir, 'screenshot.png'), Buffer.alloc(10))
    // A path that's neither under a media root NOR in the OS screenshot dir is
    // rejected outright — never rm'd, never trashed. (deleteMedia is async now:
    // OS items go to the Trash, so the whole fn returns a Promise.)
    expect(await deleteMedia('/etc/passwd')).toBe(false)
    expect(await deleteMedia(join(dirs.RUNS, '..', 'escape'))).toBe(false)
    expect(existsSync(dir)).toBe(true)

    expect(await deleteMedia(dir)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})
