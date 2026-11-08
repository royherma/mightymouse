import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'
import type { HistoryEntry } from '../../../shared/types'

// paths.ts captures os.homedir() at import time, so the temp home must exist and
// homedir() must return it BEFORE capture-actions.ts (→ run-folder → paths) loads.
const HOME = mkdtempSync(join(tmpdir(), 'mm-logcapture-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'runs'), { recursive: true })
mkdirSync(join(HOME, CONFIG.APP_NAME, 'captures'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

// capture-actions transitively imports the HUD/run pipeline (→ electron). logCapture
// touches none of it, so stub those modules out to keep this a pure store-level test.
vi.mock('../../hud-window', () => ({ runningHud: vi.fn(), failHud: vi.fn() }))
vi.mock('../../backend/hud-run', () => ({ runHudRun: vi.fn(), clearHudThread: vi.fn() }))
vi.mock('../../store/events', () => ({ EVENTS: { append: vi.fn() } }))

// Stub the two stores logCapture touches so the test asserts behavior, not I/O.
let incognito = false
const appended: HistoryEntry[] = []
vi.mock('../../store/prefs', () => ({
  PREFS: { getIncognito: () => incognito, getBackend: () => 'claude' }
}))
vi.mock('../../store/history', async () => {
  const actual = await vi.importActual<typeof import('../../store/history')>('../../store/history')
  return {
    ...actual,
    HISTORY: { append: (e: HistoryEntry) => appended.push(e) }
  }
})

// The conversation store. appendTurn returns the session id it wrote into, exactly
// like the real one — that id is what logCapture must hand forward to the follow-up.
vi.mock('../../store/mighty', () => ({
  MIGHTY: { appendTurn: vi.fn(() => 'sess-1') }
}))

// Only runCaptureAction touches these (logCapture doesn't) — stub so the module loads.
vi.mock('../../estimator/duration-estimator', () => ({ estimateDuration: () => ({ etaMs: 0 }) }))
vi.mock('../../backend/context-memory', () => ({ buildMemoryBlob: () => '' }))

const RUNS = join(HOME, CONFIG.APP_NAME, 'runs')
const CAPTURES = join(HOME, CONFIG.APP_NAME, 'captures')

let logCapture: typeof import('../capture-actions').logCapture
let runCaptureAction: typeof import('../capture-actions').runCaptureAction
let runHudRun: ReturnType<typeof vi.fn>
let mightyAppendTurn: ReturnType<typeof vi.fn>

/** A populated capture folder, the way a real capture leaves one on disk. */
function makeCaptureFolder(name: string, withScreenshot = false): string {
  const dir = join(CAPTURES, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), '{}\n')
  if (withScreenshot) writeFileSync(join(dir, 'shot.png'), 'png')
  return dir
}

describe('logCapture', () => {
  beforeAll(async () => {
    const mod = await import('../capture-actions')
    logCapture = mod.logCapture
    runCaptureAction = mod.runCaptureAction
    runHudRun = (await import('../../backend/hud-run')).runHudRun as ReturnType<typeof vi.fn>
    mightyAppendTurn = (await import('../../store/mighty')).MIGHTY.appendTurn as ReturnType<
      typeof vi.fn
    >
  })
  beforeEach(() => {
    appended.length = 0
    incognito = false
    runHudRun.mockClear()
    mightyAppendTurn.mockClear()
  })
  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
  })

  it('moves the capture folder into runs/ and writes one history row tagged with the kind', () => {
    const src = makeCaptureFolder('listen-001')
    const { folder } = logCapture({
      runId: 'cap1',
      kind: 'listen',
      folder: src,
      transcript: 'hello world'
    })

    // Folder moved out of captures/ into the unified runs/ home.
    expect(existsSync(src)).toBe(false)
    expect(folder.startsWith(RUNS)).toBe(true)
    expect(folder).toContain('-listen-hello-world-cap1')
    expect(existsSync(join(folder, 'events.jsonl'))).toBe(true)

    // Exactly one row, carrying the real kind on capture_kind + the moved run_dir.
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      run_id: 'cap1',
      capture_kind: 'listen',
      instruction: 'hello world',
      source: 'capture',
      run_dir: folder,
      ok: true
    })
  })

  it('falls back to the kind label when there is no transcript', () => {
    const src = makeCaptureFolder('shot-001', true)
    const { folder, screenshotPath } = logCapture({
      runId: 'cap2',
      kind: 'screenshot',
      folder: src,
      screenshotPath: join(src, 'shot.png')
    })

    expect(appended[0].instruction).toBe(CONFIG.CAPTURE_HISTORY_LABEL.screenshot)
    // Screenshot path rewritten to its new home so the panel thumbnail still loads.
    expect(appended[0].screenshot_path).toBe(join(folder, 'shot.png'))
    expect(existsSync(appended[0].screenshot_path!)).toBe(true)
    // The returned media path is re-homed too (the HUD preview loads THIS, not the
    // emptied pre-move path) — points at the moved file and it exists on disk.
    expect(screenshotPath).toBe(join(folder, 'shot.png'))
    expect(existsSync(screenshotPath!)).toBe(true)
  })

  it('incognito returns the original folder and writes no row', () => {
    incognito = true
    const src = makeCaptureFolder('listen-incog')
    const { folder } = logCapture({ runId: 'cap3', kind: 'listen', folder: src })

    expect(folder).toBe(src)
    expect(existsSync(src)).toBe(true)
    expect(appended).toHaveLength(0)
  })
})

// The bug: a capture wrote a HISTORY row and nothing else, so the spoken words never
// became a conversation message — and an Act bound no session at all. Result: you did
// a listen, acted on it, then found no conversation to open. These lock the capture and
// its follow-up into ONE session.
describe('capture → follow-up conversation continuity', () => {
  beforeEach(() => {
    appended.length = 0
    incognito = false
    runHudRun.mockClear()
    mightyAppendTurn.mockClear()
  })

  it('opens a conversation with the capture itself as the first turn', () => {
    logCapture({
      runId: 'cap-a',
      kind: 'listen',
      folder: makeCaptureFolder('listen-conv-a'),
      transcript: 'summarize my meeting notes'
    })

    expect(mightyAppendTurn).toHaveBeenCalledTimes(1)
    const [sessionId, turn] = mightyAppendTurn.mock.calls[0]
    // undefined session id = mint a new one; the spoken words ARE the message.
    expect(sessionId).toBeUndefined()
    expect(turn).toMatchObject({ source: 'listen', q: 'summarize my meeting notes', a: '' })
  })

  it('tags a silent screenshot capture as capture, not listen', () => {
    logCapture({
      runId: 'cap-b',
      kind: 'screenshot',
      folder: makeCaptureFolder('shot-conv-b', true)
    })

    expect(mightyAppendTurn.mock.calls[0][1]).toMatchObject({
      source: 'capture',
      q: CONFIG.CAPTURE_HISTORY_LABEL.screenshot
    })
  })

  it('runs the follow-up Act into the SAME session the capture opened', () => {
    logCapture({
      runId: 'cap-c',
      kind: 'listen',
      folder: makeCaptureFolder('listen-conv-c'),
      transcript: 'rename these files'
    })
    runCaptureAction('cap-c', 'act')

    expect(runHudRun).toHaveBeenCalledTimes(1)
    const opts = runHudRun.mock.calls[0][0]
    // Appends to the capture's session instead of minting a second conversation.
    expect(opts.sessionId).toBe('sess-1')
    // The agent still gets the full spoken command...
    expect(opts.instruction).toBe('rename these files')
    // ...but the DISPLAYED question isn't a second copy of the same sentence.
    expect(opts.turnQ).toBe(CONFIG.CAPTURE_TURN_Q.act)
  })

  // The in-memory `captures` map dies with the run, so a REPLAY (the phone's act-on-a-
  // history-row) has only the history row left to find the session by. Without the id
  // on the row the replay ran session-less, the voice note kept its empty answer, and
  // the phone's picker — which hides single-bubble sessions — dropped the very thread
  // the user had just acted on.
  it('stamps the capture history row with the session it opened', () => {
    logCapture({
      runId: 'cap-g',
      kind: 'listen',
      folder: makeCaptureFolder('listen-conv-g'),
      transcript: 'draft a content plan'
    })

    expect(appended).toHaveLength(1)
    expect(appended[0].session_id).toBe('sess-1')
  })

  // A screenshot capture opens a session too, so its row must carry the id as well —
  // the replay path keys off the row, not off what kind of capture wrote it.
  it('stamps a screenshot capture row the same way', () => {
    logCapture({
      runId: 'cap-h',
      kind: 'screenshot',
      folder: makeCaptureFolder('shot-conv-h', true)
    })

    expect(appended[0].session_id).toBe('sess-1')
  })

  it('shows a typed follow-up verbatim rather than relabeling it', () => {
    logCapture({
      runId: 'cap-d',
      kind: 'listen',
      folder: makeCaptureFolder('listen-conv-d'),
      transcript: 'some spoken words'
    })
    runCaptureAction('cap-d', 'ask', 'what did I just say?')

    const opts = runHudRun.mock.calls[0][0]
    expect(opts.instruction).toBe('what did I just say?')
    // Typed text is the user's own question — never replaced by a label.
    expect(opts.turnQ).toBe('what did I just say?')
  })

  // Incognito must not persist a conversation. The store's appendLine already no-ops,
  // but newSession would still hand back an id for a session that was never written —
  // a follow-up appending into THAT would silently vanish. So no id is bound at all.
  it('incognito binds no session, so a follow-up cannot append into a phantom', () => {
    incognito = true
    logCapture({
      runId: 'cap-e',
      kind: 'listen',
      folder: makeCaptureFolder('listen-conv-e'),
      transcript: 'private thought'
    })

    expect(mightyAppendTurn).not.toHaveBeenCalled()
  })

  // A follow-up on a capture that was remembered WITHOUT a session (incognito, or a
  // live HUD card stashed by rememberCapture before logCapture ran) must still work —
  // it just mints its own session downstream, exactly as it did before this change.
  it('a session-less capture still runs its follow-up, unbound', async () => {
    const { rememberCapture } = await import('../capture-actions')
    rememberCapture('cap-f', { folder: makeCaptureFolder('listen-conv-f'), kind: 'listen' })
    runCaptureAction('cap-f', 'act')

    const opts = runHudRun.mock.calls[0][0]
    expect(opts.sessionId).toBeUndefined()
    // No session to duplicate a question into, so the instruction shows verbatim.
    expect(opts.turnQ).toBe(opts.instruction)
  })
})
