/**
 * The burst refuses to type question K+1 until the pane proves it left question
 * K: one wrong Down-count silently mis-answers everything after it.
 * tmux is mocked at the execFile boundary, so a "pane" is a scripted sequence of
 * capture-pane outputs -- exactly what the real code reads.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

/** Every tmux invocation the code under test made, in order. */
let calls: string[][] = []
/** capture-pane returns shift() off this; the last value repeats forever. */
let screens: string[] = []
/** send-keys failure injection, keyed by how many sends have happened. */
let failSendAt = -1
let sendCount = 0

vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void
  ) => {
    calls.push(args)
    if (args.includes('capture-pane')) {
      const screen = screens.length > 1 ? screens.shift()! : (screens[0] ?? '')
      cb(null, screen)
      return
    }
    const failed = sendCount++ === failSendAt
    cb(failed ? new Error('send-keys refused') : null, '')
  }
}))

vi.mock('../../platform', () => ({
  resolveBinary: () => '/opt/homebrew/bin/tmux',
  input: { pressKeys: async () => undefined }
}))

// Focusing the pane is a courtesy the burst does once; it must not be what the
// test is measuring, and it must not touch a real window server.
vi.mock('../origin-resolver', () => ({ resolveOrigin: async () => 'tmux' }))

const TEXT_ROW = '  3. Type something else'

/** A pane showing `question` plus the free-text row. */
function pane(question: string): string {
  return `? ${question}\n  1. alpha\n  2. beta\n${TEXT_ROW}\n`
}

interface BurstCase {
  questions: Array<{ question: string; options?: string[] }>
  buffered: Array<{ index: number; answer: string; picks?: number[] }>
}

function makeRequest(c: BurstCase): unknown {
  return {
    id: 'req_1',
    verb: 'ask',
    status: 'resolved',
    buffered: c.buffered,
    response: { answer: c.buffered[0]?.answer },
    params: {
      question: c.questions[0].question,
      options: c.questions[0].options,
      questions: c.questions,
      origin: { tmuxPane: '%7' }
    }
  }
}

/** Down-count + Enter per send-keys call, in order. Enter/`-l` land as their own
 *  calls, which is what lets a test see WHERE a burst stopped. */
function sentKeys(): string[] {
  return calls
    .filter((a) => a.includes('send-keys'))
    .map((a) => a[a.length - 1])
}

async function runBurst(c: BurstCase): Promise<string> {
  const { sendPickerAnswer } = await import('../picker-keys')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sendPickerAnswer(makeRequest(c) as any)
}

describe('multi-question picker burst', () => {
  beforeEach(() => {
    calls = []
    screens = []
    failSendAt = -1
    sendCount = 0
    vi.resetModules()
  })

  it('types every answer once the pane advances between questions', async () => {
    // Q1 on screen, then Q2 -- the advance check sees Q1's text disappear.
    screens = [pane('Which db?'), pane('Which host?'), pane('Which host?'), pane('all done')]
    const via = await runBurst({
      questions: [
        { question: 'Which db?', options: ['alpha', 'beta'] },
        { question: 'Which host?', options: ['alpha', 'beta'] }
      ],
      buffered: [
        { index: 0, answer: 'beta' },
        { index: 1, answer: 'alpha' }
      ]
    })
    expect(via).toBe('tmux')
    // beta is row 1 -> one Down then Enter; alpha is row 0 -> Enter alone.
    expect(sentKeys()).toEqual(['Down', 'Enter', 'Enter'])
  })

  it('STOPS rather than typing blind when the picker never advances', async () => {
    // The pane keeps showing Q1: every advance poll fails.
    screens = [pane('Which db?')]
    const via = await runBurst({
      questions: [
        { question: 'Which db?', options: ['alpha', 'beta'] },
        { question: 'Which host?', options: ['alpha', 'beta'] }
      ],
      buffered: [
        { index: 0, answer: 'alpha' },
        { index: 1, answer: 'beta' }
      ]
    })
    expect(via).toBe('tmux')
    // Q1's Enter only. Q2's keys would have selected the wrong row on a picker
    // still showing Q1 -- the whole failure this test exists to lock.
    expect(sentKeys()).toEqual(['Enter'])
  })

  it('does not type at all when an answer is missing', async () => {
    screens = [pane('Which db?')]
    const via = await runBurst({
      questions: [
        { question: 'Which db?', options: ['alpha', 'beta'] },
        { question: 'Which host?', options: ['alpha', 'beta'] }
      ],
      buffered: [{ index: 0, answer: 'alpha' }]
    })
    expect(via).toBe('skipped')
    expect(sentKeys()).toEqual([])
  })

  it('sends free text through the "Type something" row', async () => {
    screens = [pane('Which db?'), pane('Which host?'), pane('done')]
    await runBurst({
      questions: [
        { question: 'Which db?', options: ['alpha', 'beta'] },
        { question: 'Which host?', options: ['alpha', 'beta'] }
      ],
      buffered: [
        { index: 0, answer: 'something else entirely' },
        { index: 1, answer: 'alpha' }
      ]
    })
    // Row 2 (past both options) = two Downs, Enter, the literal text, Enter.
    expect(sentKeys()).toEqual([
      'Down',
      'Down',
      'Enter',
      'something else entirely',
      'Enter',
      'Enter'
    ])
  })

  it('stops at a failed send rather than continuing to the next question', async () => {
    screens = [pane('Which db?'), pane('Which host?'), pane('done')]
    failSendAt = 0
    const via = await runBurst({
      questions: [
        { question: 'Which db?', options: ['alpha', 'beta'] },
        { question: 'Which host?', options: ['alpha', 'beta'] }
      ],
      buffered: [
        { index: 0, answer: 'alpha' },
        { index: 1, answer: 'alpha' }
      ]
    })
    expect(via).toBe('skipped')
    expect(sentKeys()).toEqual(['Enter'])
  })

  it('types Space per pick then Enter on Submit for a multiSelect question (§8.2)', async () => {
    screens = [pane('Which db?'), pane('Which host?'), pane('done')]
    const { sendPickerAnswer } = await import('../picker-keys')
    const request = makeRequest({
      questions: [
        { question: 'Which db?', options: ['alpha', 'beta'] },
        { question: 'Which host?', options: ['alpha', 'beta'] }
      ],
      buffered: [
        { index: 0, answer: 'alpha' },
        { index: 1, answer: 'alpha, beta', picks: [0, 1] }
      ]
    }) as { params: { questions: Array<{ multiSelect?: boolean }> } }
    request.params.questions[1].multiSelect = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await sendPickerAnswer(request as any)).toBe('tmux')
    // alpha is row 0 on Q1 -> Enter alone. Both picks on Q2 toggle with Space,
    // then two Downs past the "Type something" row onto Submit.
    expect(sentKeys()).toEqual(['Enter', 'Space', 'Down', 'Space', 'Down', 'Down', 'Enter'])
  })

  it('stops rather than toggling when a multiSelect question has no picks', async () => {
    screens = [pane('Which db?'), pane('Which host?'), pane('done')]
    const { sendPickerAnswer } = await import('../picker-keys')
    const request = makeRequest({
      questions: [
        { question: 'Which db?', options: ['alpha', 'beta'] },
        { question: 'Which host?', options: ['alpha', 'beta'] }
      ],
      buffered: [
        { index: 0, answer: 'alpha' },
        { index: 1, answer: 'alpha, beta' }
      ]
    }) as { params: { questions: Array<{ multiSelect?: boolean }> } }
    request.params.questions[1].multiSelect = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await sendPickerAnswer(request as any)).toBe('tmux')
    expect(sentKeys()).toEqual(['Enter'])
  })

  it('never types when the request is a drill', async () => {
    screens = [pane('Which db?')]
    const { sendPickerAnswer } = await import('../picker-keys')
    const request = makeRequest({
      questions: [
        { question: 'Which db?', options: ['alpha', 'beta'] },
        { question: 'Which host?', options: ['alpha', 'beta'] }
      ],
      buffered: [
        { index: 0, answer: 'alpha' },
        { index: 1, answer: 'beta' }
      ]
    }) as { params: Record<string, unknown> }
    request.params.test = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await sendPickerAnswer(request as any)).toBe('skipped')
    expect(sentKeys()).toEqual([])
  })
})
