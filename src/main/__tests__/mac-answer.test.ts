import { describe, it, expect, vi, beforeEach } from 'vitest'

// These two primitives exist so a caller with NO HUD and NO socket (an App Intent
// answering Siri) can get one string back. The contract that matters there:
//
//   1. a streamed run collapses to one resolved string
//   2. a failing run REJECTS — it never resolves with a half-answer, and never hangs
//   3. no screenshot → a typed 'no-screen' error the caller can speak aloud
//
// (3) is the sleeping-display case (SCK -3815). It's an expected degrade, not a
// crash, so it must be distinguishable from a real backend failure by `kind` and
// never by string-matching the message.

const { runBackend, captureScreenshot, getBackend } = vi.hoisted(() => ({
  runBackend: vi.fn(),
  captureScreenshot: vi.fn(),
  getBackend: vi.fn(() => 'claude')
}))

vi.mock('../backend/runner', () => ({ runBackend }))
vi.mock('../platform', () => ({ captureScreenshot }))
vi.mock('../store/prefs', () => ({ PREFS: { getBackend } }))
vi.mock('../store/paths', () => ({ PATHS: { TMP: '/tmp/mm-test' } }))

import { askMac, askMacAboutScreen, MacAnswerError } from '../mac-answer'

/** Drive the mocked runBackend's onDone with one canned outcome. */
const settleWith = (result: string | null, exitCode = 0, stdErr = ''): void => {
  runBackend.mockImplementation(async (opts: Parameters<typeof runBackend>[0]) => {
    opts.onDone(result, exitCode, '', stdErr, 0, '/tmp/p.txt', '/tmp/o.txt')
  })
}

describe('askMac — a streamed run collapses to one string', () => {
  beforeEach(() => {
    runBackend.mockReset()
    captureScreenshot.mockReset()
    getBackend.mockReset().mockReturnValue('claude')
  })

  it('resolves with the model text, trimmed', async () => {
    settleWith('  Safari, on a PR diff.\n')
    await expect(askMac('what is on screen?')).resolves.toBe('Safari, on a PR diff.')
  })

  it('rejects on a non-zero exit instead of resolving with nothing', async () => {
    settleWith(null, 1, 'out of credits')
    await expect(askMac('hi')).rejects.toMatchObject({ kind: 'backend', message: 'out of credits' })
  })

  it('rejects an empty answer rather than speaking silence', async () => {
    settleWith('   ')
    await expect(askMac('hi')).rejects.toMatchObject({ kind: 'empty' })
  })

  it('defaults to the user-chosen backend, never a forced one', async () => {
    getBackend.mockReturnValue('local')
    settleWith('ok')
    await askMac('hi')
    expect(runBackend.mock.calls[0][0].backend).toBe('local')
  })

  it('ignores a second onDone — one call, one answer', async () => {
    runBackend.mockImplementation(async (opts: Parameters<typeof runBackend>[0]) => {
      opts.onDone('first', 0, '', '', 0, '', '')
      opts.onDone('second', 1, '', 'boom', 0, '', '')
    })
    await expect(askMac('hi')).resolves.toBe('first')
  })
})

describe('askMacAboutScreen — no screen is an expected degrade', () => {
  beforeEach(() => {
    runBackend.mockReset()
    captureScreenshot.mockReset()
    getBackend.mockReset().mockReturnValue('claude')
  })

  it('throws kind "no-screen" when capture returns null (Mac asleep)', async () => {
    captureScreenshot.mockResolvedValue(null)
    const err = await askMacAboutScreen('what is on screen?').catch((e) => e)
    expect(err).toBeInstanceOf(MacAnswerError)
    expect(err.kind).toBe('no-screen')
    expect(runBackend).not.toHaveBeenCalled()
  })

  it('throws kind "no-screen" when capture itself rejects', async () => {
    captureScreenshot.mockRejectedValue(new Error('SCK -3815'))
    await expect(askMacAboutScreen('q')).rejects.toMatchObject({ kind: 'no-screen' })
  })

  it('attaches the shot as an image AND grants its dir to a CLI backend', async () => {
    captureScreenshot.mockResolvedValue('/tmp/mm-shots/shot.png')
    settleWith('A terminal running tests.')

    const out = await askMacAboutScreen('what is on screen?')

    expect(out).toEqual({
      answer: 'A terminal running tests.',
      screenshotPath: '/tmp/mm-shots/shot.png'
    })
    const opts = runBackend.mock.calls[0][0]
    expect(opts.attachments).toEqual([{ path: '/tmp/mm-shots/shot.png', kind: 'image' }])
    // Without the dir grant a shell adapter cannot Read the PNG off disk.
    expect(opts.addDirs).toContain('/tmp/mm-shots')
  })
})
