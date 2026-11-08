import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'mm-recovery-'))
const CAPTURES = join(ROOT, 'captures')
const TMP = join(ROOT, 'tmp')

const notes: Array<{ title: string; body: string }> = []
vi.mock('electron', () => ({
  app: { focus: (): void => {} },
  dialog: {
    showMessageBox: async (o: { message: string; detail: string }) => {
      notes.push({ title: o.message, body: o.detail })
      return { response: 1 }
    }
  }
}))
vi.mock('../../store/paths', async (orig) => ({ PATHS: { ...(await orig<typeof import('../../store/paths')>()).PATHS, CAPTURES } }))

const transcribe = vi.fn()
vi.mock('../whisper', () => ({ transcribe: (...a: unknown[]) => transcribe(...a) }))
const logCapture = vi.fn((e: { folder: string }) => ({ folder: e.folder }))
vi.mock('../capture-actions', () => ({ logCapture: (e: { folder: string }) => logCapture(e) }))
vi.mock('../../mighty/mighty-window', () => ({ getMightyWindow: () => null }))

const { markRecording, recoverInterruptedRecordings, getRecoveredRecordings, dismissRecoveredRecordings } = await import('../recording-recovery')

function wav(dataBytes: number, opts: { extraChunk?: boolean } = {}): Buffer {
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8)
  fmt.writeUInt16LE(1, 10)
  fmt.writeUInt32LE(16000, 12)
  fmt.writeUInt32LE(32000, 16)
  fmt.writeUInt16LE(2, 20)
  fmt.writeUInt16LE(16, 22)
  const list = Buffer.alloc(8 + 10)
  list.write('LIST', 0, 'ascii')
  list.writeUInt32LE(10, 4)
  const dataHead = Buffer.alloc(8)
  dataHead.write('data', 0, 'ascii')
  dataHead.writeUInt32LE(0xffffffff, 4)
  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(0xffffffff, 4)
  riff.write('WAVE', 8, 'ascii')
  return Buffer.concat([riff, fmt, ...(opts.extraChunk ? [list] : []), dataHead, Buffer.alloc(dataBytes, 1)])
}

function captureFolder(name: string): string {
  const dir = join(CAPTURES, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  rmSync(CAPTURES, { recursive: true, force: true })
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(CAPTURES, { recursive: true })
  mkdirSync(TMP, { recursive: true })
  notes.length = 0
  dismissRecoveredRecordings()
  transcribe.mockReset()
  transcribe.mockResolvedValue({ ok: true, text: '  hello from the lost meeting ', wordCount: 5 })
  logCapture.mockClear()
})

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('recoverInterruptedRecordings', () => {
  it('adopts the cut-off audio, fixes its header sizes, transcribes and logs it', async () => {
    const dir = captureFolder('a')
    const tmpAudio = join(TMP, 'a.wav')
    writeFileSync(tmpAudio, wav(64000))
    markRecording(dir, { kind: 'listen', audioTmp: tmpAudio, startedAt: 1 })

    const showHome = vi.fn()
    await recoverInterruptedRecordings([], showHome)

    const audio = join(dir, 'audio.wav')
    expect(existsSync(tmpAudio)).toBe(false)
    expect(existsSync(join(dir, 'recording.json'))).toBe(false)
    const buf = readFileSync(audio)
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8)
    expect(buf.readUInt32LE(40)).toBe(64000)
    expect(transcribe).toHaveBeenCalledWith(audio, join(dir, 'transcript'))
    expect(logCapture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'listen', folder: dir, transcript: 'hello from the lost meeting', durationS: 2 })
    )
    expect(showHome).toHaveBeenCalledTimes(1)
    const { working, items } = getRecoveredRecordings()
    expect(working).toBe(false)
    expect(items).toEqual([{ folder: dir, summary: '2 sec, 5 words', transcript: 'hello from the lost meeting' }])
  })

  it('finds the data chunk behind an extra chunk before it', async () => {
    const dir = captureFolder('b')
    const tmpAudio = join(TMP, 'b.wav')
    writeFileSync(tmpAudio, wav(3200, { extraChunk: true }))
    markRecording(dir, { kind: 'recording', audioTmp: tmpAudio, startedAt: 1 })

    await recoverInterruptedRecordings([], vi.fn())

    const buf = readFileSync(join(dir, 'audio.wav'))
    const dataOff = 12 + 24 + 18
    expect(buf.toString('ascii', dataOff, dataOff + 4)).toBe('data')
    expect(buf.readUInt32LE(dataOff + 4)).toBe(3200)
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8)
  })

  it('adopts the screen video too', async () => {
    const dir = captureFolder('c')
    const tmpAudio = join(TMP, 'c.wav')
    const tmpVideo = join(TMP, 'c.mp4')
    writeFileSync(tmpAudio, wav(320))
    writeFileSync(tmpVideo, 'mp4')
    markRecording(dir, { kind: 'recording', audioTmp: tmpAudio, videoTmp: tmpVideo, startedAt: 1 })

    await recoverInterruptedRecordings([], vi.fn())

    expect(readFileSync(join(dir, 'screen.mp4'), 'utf-8')).toBe('mp4')
    expect(logCapture).toHaveBeenCalledWith(expect.objectContaining({ videoPath: join(dir, 'screen.mp4') }))
  })

  it('still logs and notifies when transcription fails', async () => {
    transcribe.mockResolvedValue({ ok: false, error: 'whisper crashed' })
    const dir = captureFolder('d')
    const tmpAudio = join(TMP, 'd.wav')
    writeFileSync(tmpAudio, wav(320))
    markRecording(dir, { kind: 'listen', audioTmp: tmpAudio, startedAt: 1 })

    await recoverInterruptedRecordings([], vi.fn())

    expect(logCapture).toHaveBeenCalledWith(expect.objectContaining({ transcript: '' }))
    expect(existsSync(join(dir, 'audio.wav'))).toBe(true)
    expect(getRecoveredRecordings().items).toEqual([{ folder: dir, summary: '0 sec', transcript: '' }])
  })

  it('deletes a marked folder whose recording files are all gone', async () => {
    const dir = captureFolder('e')
    markRecording(dir, { kind: 'listen', audioTmp: join(TMP, 'missing.wav'), startedAt: 1 })

    await recoverInterruptedRecordings([], vi.fn())

    expect(existsSync(dir)).toBe(false)
    expect(logCapture).not.toHaveBeenCalled()
    expect(getRecoveredRecordings().items).toHaveLength(0)
  })

  it('leaves an unmarked capture folder alone', async () => {
    const dir = captureFolder('finished')
    writeFileSync(join(dir, 'audio.wav'), wav(320))

    await recoverInterruptedRecordings([], vi.fn())

    expect(readdirSync(dir)).toEqual(['audio.wav'])
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('a corrupt marker in one folder does not stop recovery of the next', async () => {
    const bad = captureFolder('1-bad')
    writeFileSync(join(bad, 'recording.json'), '{not json')
    const good = captureFolder('2-good')
    const tmpAudio = join(TMP, 'g.wav')
    writeFileSync(tmpAudio, wav(320))
    markRecording(good, { kind: 'listen', audioTmp: tmpAudio, startedAt: 1 })

    await recoverInterruptedRecordings([], vi.fn())

    expect(existsSync(join(good, 'audio.wav'))).toBe(true)
    expect(logCapture).toHaveBeenCalledTimes(1)
  })
})
