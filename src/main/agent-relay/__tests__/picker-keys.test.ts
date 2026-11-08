import { describe, expect, it, vi, beforeEach } from 'vitest'

let calls: string[][] = []
let captureOut = ''
// Successive capture-pane results, for tests that need the pane to CHANGE
// between reads (the burst polls it to prove the picker advanced). Empty =
// every read returns `captureOut`, which is what every other test wants.
let captureQueue: string[] = []
let sendOk = true
let psOut: string | null = 'ttys016'
let writeErr: Error | null = null
let writes: { path: string; data: string }[] = []

vi.mock('child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string) => void
  ) => {
    calls.push([cmd, ...args])
    if (cmd === '/bin/ps') {
      if (psOut === null) {
        cb(new Error('no such process'), '')
        return
      }
      cb(null, psOut)
      return
    }
    if (args.includes('capture-pane')) {
      cb(null, captureQueue.length ? (captureQueue.shift() as string) : captureOut)
      return
    }
    cb(sendOk ? null : new Error('send-keys refused'), '')
  }
}))

vi.mock('fs', () => ({
  writeFile: (path: string, data: string, cb: (err: Error | null) => void) => {
    writes.push({ path, data })
    cb(writeErr)
  }
}))

vi.mock('../../platform', () => ({
  resolveBinary: vi.fn(() => '/opt/homebrew/bin/tmux'),
  input: { pressKeys: async () => undefined }
}))

vi.mock('../origin-resolver', () => ({ resolveOrigin: async () => 'tmux' }))

import { answerStartup, capturePaneTail, multiSelectKeys, sendPaneText, sendPickerAnswer } from '../picker-keys'
import { resolveBinary } from '../../platform'

describe('Codex hooks overview answers', () => {
  it.each([[0, 'Enter'], [1, 't'], [2, 'Escape']] as const)(
    'sends shortcut %s as %s instead of counting picker rows',
    async (index, key) => {
      calls = []
      captureQueue = [
        '  Hooks\n\n  ⚠ 2 hooks need review before they can run.\n\n' +
        '  Press t to trust all; enter to review hooks; esc to close'
      ]
      captureOut = ''
      sendOk = true
      vi.mocked(resolveBinary).mockReturnValue('/opt/homebrew/bin/tmux')
      await expect(answerStartup('%7', index)).resolves.toBe(true)
      expect(calls.filter((args) => args.includes('send-keys'))).toEqual([
        ['/opt/homebrew/bin/tmux', 'send-keys', '-t', '%7', key]
      ])
    }
  )
})

describe('multiSelectKeys', () => {
  it('walks Down to each pick, Space to toggle, then on to Submit (verified live)', () => {
    expect(multiSelectKeys(3, [0, 2], true)).toEqual([
      'Space',
      'Down',
      'Down',
      'Space',
      'Down',
      'Down',
      'Enter'
    ])
  })

  it('lands Submit right after the last option with no text row', () => {
    expect(multiSelectKeys(2, [1], false)).toEqual(['Down', 'Space', 'Down', 'Enter'])
  })

  it('de-dupes and sorts out-of-order picks', () => {
    expect(multiSelectKeys(3, [2, 0, 2], false)).toEqual(multiSelectKeys(3, [0, 2], false))
  })

  it('sends nothing for no options or no picks', () => {
    expect(multiSelectKeys(0, [0], true)).toEqual([])
    expect(multiSelectKeys(3, [], true)).toEqual([])
  })
})

describe('capturePaneTail', () => {
  beforeEach(() => {
    calls = []
    captureOut = ''
    vi.mocked(resolveBinary).mockReturnValue('/opt/homebrew/bin/tmux')
  })

  it('returns null when there is no pane to read', async () => {
    expect(await capturePaneTail(undefined)).toBeNull()
    expect(await capturePaneTail({})).toBeNull()
    expect(calls).toEqual([])
  })

  it('keeps the paragraph break, strips trailing space', async () => {
    captureOut = '  keep me  \n\n  also this  \n'
    await expect(capturePaneTail({ tmuxPane: '%7' }, 12, 600)).resolves.toBe(
      '  keep me\n\n  also this'
    )
    expect(calls.some((a) => a.includes('capture-pane') && a.includes('%7'))).toBe(true)
  })

  it('caps a long tail keeping the newest end, not the start', async () => {
    captureOut = 'abcdefghij'
    await expect(capturePaneTail({ tmuxPane: '%7' }, 12, 4)).resolves.toBe('…ghij')
  })

  it('strips Claude Code TUI chrome so the reply text is the preview', async () => {
    captureOut = [
      'Done. Rewrote the picker.',
      '  ⎿ Stop says: [10:33:12 local] reply complete',
      '✱ Worked for 8m 56s',
      '                141469 tokens',
      '────────────────────────────────',
      'image-admin-tab-people ────',
      '❯',
      '────────────────────────────────',
      '🆕 Fresh ¦ 🤖 Opus 5 ¦ 🏷 image-admin-tab-people'
    ].join('\n')
    await expect(capturePaneTail({ tmuxPane: '%7' }, 12, 600)).resolves.toBe(
      'Done. Rewrote the picker.'
    )
  })

  // Verbatim from `tmux capture-pane` on a live v2.1.233 session. The older
  // case above was hand-typed and used ¦ (U+00A6) where the real statusline
  // emits ╎ (U+254E) -- it passed while every phone preview leaked the banner.
  it('strips chrome captured verbatim from a real pane', async () => {
    captureOut = [
      'pat@192 ShowAndTell % clear',
      'claude update && claude --dangerously-skip-permissions',
      ' ▐▛███▜▌   Claude Code v2.1.233',
      '▝▜█████▛▘  Opus 5 · Claude Max',
      ' ⚠ 5 MCP servers need authentication · run /mcp',
      '❯ testing 123',
      '  ⎿  UserPromptSubmit says: [14:16:39 local] user message sent',
      '⏺ Reading you. What do you want to work on?',
      '✻ Cogitated for 4s',
      '                                          67165 tokens',
      '─────────────────────────────────────────── dev-23 ──',
      '❯',
      '──────────────────────────────────────────────────────',
      '  🆕 Fresh ╎ 🤖 Opus 5 ╎ 🏷 dev-23 ╎ 📂 ShowAndTell ╎ 🌿 dev*    /rc',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents'
    ].join('\n')
    await expect(capturePaneTail({ tmuxPane: '%7' }, 12, 600)).resolves.toBe(
      '❯ testing 123\n⏺ Reading you. What do you want to work on?'
    )
  })

  // The spinner verb rotates through a long list, some non-ASCII; the recap
  // footer wraps onto a second line. Both leaked past per-word matching.
  it('strips rotating spinner verbs and the wrapped recap footer', async () => {
    captureOut = [
      'Shipped the fix and verified it.',
      '✻ Sautéed for 4s',
      '※ recap: Goal was parity for the session sheet. (disable recaps',
      'in /config)'
    ].join('\n')
    await expect(capturePaneTail({ tmuxPane: '%7' }, 12, 600)).resolves.toBe(
      'Shipped the fix and verified it.'
    )
  })

  it('reads scrollback, not just the visible screen', async () => {
    captureOut = 'hello'
    await capturePaneTail({ tmuxPane: '%7' })
    const call = calls.find((a) => a.includes('capture-pane'))
    expect(call?.includes('-S')).toBe(true)
  })
})

describe('sendPaneText', () => {
  beforeEach(() => {
    calls = []
    writes = []
    sendOk = true
    psOut = 'ttys016'
    writeErr = null
    vi.mocked(resolveBinary).mockReturnValue('/opt/homebrew/bin/tmux')
  })

  it('skips when there is nothing to type or nowhere to type it', async () => {
    expect(await sendPaneText({ tmuxPane: '%7' }, '   ')).toBe('skipped')
    expect(await sendPaneText(undefined, 'hello')).toBe('skipped')
    expect(calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('types the text then Enter into that pane, never the frontmost window', async () => {
    await expect(sendPaneText({ tmuxPane: '%7' }, 'ship it')).resolves.toBe('tmux')
    const sent = calls.filter((a) => a.includes('send-keys'))
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual(expect.arrayContaining(['-t', '%7', '-l', 'ship it']))
    expect(sent[1]).toEqual(expect.arrayContaining(['-t', '%7', 'Enter']))
  })

  it('skips rather than falling back when tmux refuses', async () => {
    sendOk = false
    await expect(sendPaneText({ tmuxPane: '%7' }, 'hello')).resolves.toBe('skipped')
    expect(writes).toEqual([])
  })

  it('prefers the pane over a pid, so tmux sessions never also write a tty', async () => {
    await expect(sendPaneText({ tmuxPane: '%7' }, 'ship it', 4242)).resolves.toBe('tmux')
    expect(calls.some((a) => a[0] === '/bin/ps')).toBe(false)
    expect(writes).toEqual([])
  })

  it('writes the shim tty when there is a pid and no pane', async () => {
    await expect(sendPaneText({ termProgram: 'vscode' }, 'ship it', 4242)).resolves.toBe('tty')
    expect(calls).toEqual([['/bin/ps', '-p', '4242', '-o', 'tty=']])
    expect(writes).toEqual([{ path: '/dev/ttys016', data: 'ship it\r' }])
  })

  it('skips a pid with no tty rather than writing ??', async () => {
    psOut = '??'
    await expect(sendPaneText(undefined, 'hello', 4242)).resolves.toBe('skipped')
    expect(writes).toEqual([])
  })

  it('skips a pid whose tty name is not a pty slave', async () => {
    psOut = 'console'
    await expect(sendPaneText(undefined, 'hello', 4242)).resolves.toBe('skipped')
    psOut = '../passwd'
    await expect(sendPaneText(undefined, 'hello', 4242)).resolves.toBe('skipped')
    expect(writes).toEqual([])
  })

  it('skips when ps cannot see the pid', async () => {
    psOut = null
    await expect(sendPaneText(undefined, 'hello', 4242)).resolves.toBe('skipped')
    expect(writes).toEqual([])
  })

  it('skips when the tty write fails', async () => {
    writeErr = new Error('EACCES')
    await expect(sendPaneText(undefined, 'hello', 4242)).resolves.toBe('skipped')
  })
})

describe('sendPickerAnswer — multi-question burst', () => {
  const questions = [
    { question: 'Which roast do you want today', options: ['Dark', 'Light'] },
    { question: 'Which size should we pour', options: ['Small', 'Large'] },
    { question: 'Which milk goes in it', options: ['Oat', 'None'] }
  ]

  const burst = (buffered: { index: number; answer: string }[]): Parameters<
    typeof sendPickerAnswer
  >[0] =>
    ({
      id: 'r1',
      verb: 'ask',
      status: 'pending',
      params: { questions, origin: { tmuxPane: '%7' } },
      buffered
    }) as unknown as Parameters<typeof sendPickerAnswer>[0]

  const answered = [
    { index: 0, answer: 'Light' },
    { index: 1, answer: 'Large' },
    { index: 2, answer: 'None' }
  ]

  const enters = (): string[][] =>
    calls.filter((a) => a.includes('send-keys') && a.includes('Enter'))

  beforeEach(() => {
    calls = []
    captureQueue = []
    captureOut = ''
    sendOk = true
    vi.mocked(resolveBinary).mockReturnValue('/opt/homebrew/bin/tmux')
  })

  // Copied off a live 2-question picker, the screen that broke the
  // burst: answering Q1 checked EVERY box and jumped straight here.
  const REVIEW = [
    '←  ☒ Roast  ☒ Milk  ✔ Submit  →',
    '',
    'Review your answers',
    '',
    ' ● Which roast do you want today?',
    '   → Light',
    '',
    'Ready to submit your answers?',
    '',
    '❯ 1. Submit answers',
    '  2. Cancel'
  ].join('\n')

  // The bug the user hit twice: the picker was fully filled in and never submitted,
  // because nothing ever landed on the review screen's "Submit answers" row.
  it('lands on Submit answers when the review screen appears', async () => {
    captureQueue = [
      'Which roast do you want today', // Q1 rows
      REVIEW // answering Q1 filled everything in
    ]
    captureOut = REVIEW
    await expect(sendPickerAnswer(burst(answered))).resolves.toBe('tmux')
    // Q1's own Enter, then the submit row's. Without the fix, only the first.
    expect(enters()).toHaveLength(2)
  })

  // Review is row 1 of 2 in every capture so far, but Cancel sits right under
  // it -- counting down to a hardcoded row would eventually cancel the ask.
  it('counts down to Submit answers rather than assuming the first row', async () => {
    const shifted = REVIEW.replace('1. Submit answers', '1. Go back').replace(
      '2. Cancel',
      '2. Submit answers'
    )
    captureQueue = ['Which roast do you want today', shifted]
    captureOut = shifted
    await sendPickerAnswer(burst(answered))
    const sent = calls.filter((a) => a.includes('send-keys')).map((a) => a[a.length - 1])
    // One Down to step off "Go back" before Enter.
    expect(sent.slice(-2)).toEqual(['Down', 'Enter'])
  })

  it('never types a partial interview', async () => {
    await expect(sendPickerAnswer(burst(answered.slice(0, 2)))).resolves.toBe('skipped')
    expect(calls.filter((a) => a.includes('send-keys'))).toEqual([])
  })

  // A CUSTOM answer goes through the picker's own "Type something." row, then
  // still has to reach the review screen to count.
  it('types a custom answer and still submits it', async () => {
    const typed = [
      { index: 0, answer: 'Soy, actually' },
      { index: 1, answer: 'Large' },
      { index: 2, answer: 'Oat' }
    ]
    captureQueue = ['Which roast do you want today\n  3. Type something.', REVIEW]
    captureOut = REVIEW
    await expect(sendPickerAnswer(burst(typed))).resolves.toBe('tmux')
    expect(calls.some((a) => a.includes('-l') && a.includes('Soy, actually'))).toBe(true)
  })
})
