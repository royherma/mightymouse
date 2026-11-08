import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Observation, ScreenItem } from '../computer-use/observe'
import type {
  RunProgress,
  StepDecideFailure,
  StepDecision,
  StepKind
} from '../computer-use/step-decide'

type Scripted = StepDecision | StepDecideFailure

const script = vi.hoisted(() => ({
  screens: [] as unknown[],
  decisions: [] as unknown[],
  written: 'chrome installer',
  acts: [] as string[],
  logRows: [] as Record<string, unknown>[],
  decideCalls: 0,
  writerCalls: 0,
  writerPurposes: [] as string[],
  writerExisting: [] as string[],
  fieldText: '',
  opened: true,
  selectionOffered: [] as boolean[],
  scrollsOffered: [] as number[],
  keydown: null as ((e: { keycode: number }) => void) | null,
  pressEscapeOnDecide: 0
}))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ x: 500, y: 500 }) },
  shell: {
    openExternal: async (url: string) => {
      script.acts.push(`open ${url}`)
    }
  }
}))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawnSync: (_cmd: string, args: string[]) => {
    script.acts.push(`open ${args[args.length - 1]}`)
    return { status: 0 }
  }
}))

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  appendFileSync: (_path: string, line: string) => {
    script.logRows.push(JSON.parse(line) as Record<string, unknown>)
  }
}))

vi.mock('../computer-use/agent-cursor', () => ({
  showAgentCursor: () => {},
  hideAgentCursor: () => {}
}))

vi.mock('../../store/paths', () => ({ PATHS: { COMPUTER_USE_LOG: '/dev/null' } }))
vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => false } }))

vi.mock('../../capture/uiohook-manager', () => ({
  acquire: () => () => {},
  on: (_event: string, cb: (e: { keycode: number }) => void) => {
    script.keydown = cb
    return () => {}
  }
}))

vi.mock('../../intent-router', () => ({
  VERBS: {
    openApp: {
      run: async (name: string) => {
        script.acts.push(`app ${name}`)
        return { ok: script.opened }
      }
    }
  }
}))

vi.mock('../../platform', () => ({
  captureSelection: async () => script.fieldText,
  pasteText: async (text: string) => {
    script.acts.push(`paste ${text}`)
  },
  context: {
    axPress: async (req: { press: string[] }) => {
      script.acts.push(`press ${req.press[0]}`)
      return { status: 'ok' }
    },
    activateApp: () => {},
    readFrontmostScreen: async () => ({ title: 'Hacker News' })
  },
  input: {
    typeText: async (text: string) => {
      script.acts.push(`type ${text}`)
      return true
    },
    pressKeys: async (keys: string[]) => {
      script.acts.push(`keys ${keys.join('+')}`)
      return true
    },
    scrollFast: () => {
      script.acts.push('scroll')
    }
  }
}))

vi.mock('../computer-use/observe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../computer-use/observe')>()),
  observeScreen: async () => {
    const i = Math.min(script.decideCalls, script.screens.length - 1)
    return script.screens[i]
  }
}))

vi.mock('../computer-use/step-decide', () => ({
  decideStep: async (...args: unknown[]) => {
    const progress = args[3] as RunProgress
    script.scrollsOffered.push(progress.scrollsUsed)
    script.selectionOffered.push(progress.hasSelection)
    const i = Math.min(script.decideCalls, script.decisions.length - 1)
    script.decideCalls++
    if (script.pressEscapeOnDecide === script.decideCalls) script.keydown?.({ keycode: 1 })
    return script.decisions[i]
  }
}))

vi.mock('../computer-use/writer', () => ({
  writeText: async (req: { purpose: string; existing?: string }) => {
    script.writerCalls++
    script.writerPurposes.push(req.purpose)
    script.writerExisting.push(req.existing ?? '')
    return {
      ok: true,
      text: script.written,
      ms: 700,
      trail: { headersMs: 0, firstTextMs: 0, serverPreMs: 0, chargedCents: 0, costUsdMicros: 12 }
    }
  }
}))

import type { ComputerUseStatus } from '../../../shared/types'
import {
  onComputerUseStatus,
  onComputerUseStep,
  pauseComputerUse,
  runComputerUse,
  stopComputerUse
} from '../computer-use/loop'

const KIND_COUNT = 12

function item(key: string, label: string, role: string): ScreenItem {
  return { key, label, role }
}

function screen(fingerprint: string, items: ScreenItem[] = []): Observation {
  return {
    bundleId: 'com.google.Chrome',
    appName: 'Google Chrome',
    windowTitle: 'Home / X',
    urlHost: 'x.com',
    pressables: items.filter((i) => !i.role.includes('Text')),
    fields: items.filter((i) => i.role.includes('Text')),
    offscreen: [],
    fingerprint,
    frontIsTarget: true,
    frontMs: 1,
    axMs: 1
  }
}

function decision(kind: StepKind, target: ScreenItem | null = null, confidence = 0.9): Scripted {
  return {
    kind,
    confidence,
    kindCount: KIND_COUNT,
    item: target,
    itemConfidence: 0.9,
    site: kind === 'site' ? { label: 'X', url: 'https://x.com' } : null,
    key: kind === 'key' ? { label: 'Undo', combo: 'cmd+z' } : null,
    latencyMs: 1,
    serverMs: 1,
    jevMs: 1,
    inputTokens: 100
  }
}

async function replay(
  screens: Observation[],
  decisions: Scripted[],
  selection = ''
): Promise<{ ok: boolean; line: string; detail?: string }> {
  script.screens = screens
  script.decisions = decisions
  let settled = false
  const run = runComputerUse({
    runId: 'r1',
    goal: 'a goal',
    bundleId: 'com.google.Chrome',
    recentApps: [],
    selection
  }).finally(() => {
    settled = true
  })
  while (!settled) await vi.advanceTimersByTimeAsync(500)
  return run
}

const SEARCH = item('f1', 'Search', 'AXTextField')
const POST_BOX = item('f1', 'Post text', 'AXTextArea')
const PASSWORD = item('f1', 'Password', 'AXSecureTextField')
const POST = item('c1', 'Post', 'AXButton')
const NEXT = item('c1', 'Next', 'AXButton')
const DELETE = item('c1', 'Delete forever', 'AXButton')

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(script, {
    screens: [],
    decisions: [],
    written: 'chrome installer',
    acts: [],
    logRows: [],
    decideCalls: 0,
    writerCalls: 0,
    writerPurposes: [],
    writerExisting: [],
    fieldText: '',
    opened: true,
    selectionOffered: [],
    scrollsOffered: [],
    keydown: null,
    pressEscapeOnDecide: 0
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('computer-use loop, replayed from scripted screens', () => {
  it('runs site, type, Return, done in order and reports the step count', async () => {
    const lines: string[] = []
    const off = onComputerUseStep((p) => {
      if (!p.pending) lines.push(p.line)
    })
    const result = await replay(
      [screen('a'), screen('b', [SEARCH]), screen('c', [SEARCH]), screen('d')],
      [decision('site'), decision('type', SEARCH), decision('enter'), decision('done')]
    )
    off()

    expect(script.acts).toEqual([
      'open https://x.com',
      'press Search',
      'keys cmd+a',
      'type chrome installer',
      'keys return'
    ])
    expect(result.ok).toBe(true)
    expect(result.line).toMatch(/^Done - 3 steps, /)
    expect(lines).toEqual(['Opened X', 'Typed "chrome installer"', 'Pressed Return'])
  })

  it('sums the tokens of every decide call into the run row', async () => {
    await replay([screen('a')], [decision('site'), decision('done')])
    const runRow = script.logRows.find((row) => row.event === 'run')
    expect(runRow).toMatchObject({ stopReason: 'done', steps: 1, jevCalls: 2, inputTokens: 200 })
  })

  it('records the full screen and decision of every step, labels included', async () => {
    await replay([screen('a', [NEXT]), screen('b')], [decision('click', NEXT), decision('done')])
    const recorded = script.logRows.filter((row) => row.event === 'recording')
    expect(recorded).toHaveLength(2)
    expect(recorded[0]).toMatchObject({
      goal: 'a goal',
      step: 1,
      seen: { pressables: [NEXT] },
      decision: { kind: 'click', item: NEXT },
      line: 'Pressed Next'
    })
  })

  it('opens a site that is not in the list at the address the writer gives', async () => {
    script.written = 'news.ycombinator.com'
    const other = { ...decision('site'), site: { label: '', url: '' } }
    await replay([screen('a'), screen('b')], [other, decision('done')])
    expect(script.writerPurposes).toEqual(['site'])
    expect(script.acts).toEqual(['open https://news.ycombinator.com'])
  })

  it('opens nothing when the writer gives something that is not a web address', async () => {
    script.written = 'javascript:alert(1)'
    const other = { ...decision('site'), site: { label: '', url: '' } }
    await replay([screen('a')], [other, decision('done')])
    expect(script.acts).toEqual([])
  })

  it('reports what is open, the tokens and a cost that is not rounded to zero', async () => {
    const result = await replay(
      [screen('a'), screen('b', [SEARCH]), screen('c')],
      [decision('site'), decision('type', SEARCH), decision('done')]
    )
    expect(result).toMatchObject({ detail: 'Now open: Hacker News - 300 tokens - $0.00002' })
  })

  it('tells the decider how many scrolls the run has used', async () => {
    await replay(
      [screen('a', [NEXT]), screen('b', [NEXT]), screen('c', [NEXT])],
      [decision('scroll_down'), decision('scroll_down'), decision('done')]
    )
    expect(script.scrollsOffered).toEqual([0, 1, 2])
  })

  it('rewrites the text already in a field instead of adding to it', async () => {
    script.fieldText = 'hey can u send the file'
    script.written = 'Hi - could you send the file when you get a moment?'
    const lines: string[] = []
    const off = onComputerUseStep((p) => {
      if (!p.pending) lines.push(p.line)
    })
    await replay(
      [screen('a', [POST_BOX]), screen('b')],
      [decision('type', POST_BOX), decision('done')]
    )
    off()
    expect(script.writerExisting).toEqual(['hey can u send the file'])
    expect(script.acts).toEqual(['press Post text', 'keys cmd+a', `type ${script.written}`])
    expect(lines[0]).toMatch(/^Changed the text to "/)
  })

  it('adds to the end of a long document rather than replacing it', async () => {
    script.fieldText = 'x'.repeat(2_001)
    await replay(
      [screen('a', [POST_BOX]), screen('b')],
      [decision('type', POST_BOX), decision('done')]
    )
    expect(script.writerExisting).toEqual([''])
    expect(script.acts).toEqual([
      'press Post text',
      'keys cmd+a',
      'keys right',
      'type chrome installer'
    ])
  })

  it('pastes long or multi-line text in one go', async () => {
    script.written = 'line one\nline two'
    await replay(
      [screen('a', [POST_BOX]), screen('b')],
      [decision('type', POST_BOX), decision('done')]
    )
    expect(script.acts).toEqual(['press Post text', 'keys cmd+a', 'paste line one\nline two'])
  })

  it('rewrites the selected text once, then stops offering it', async () => {
    script.written = 'A shorter version.'
    await replay(
      [screen('a'), screen('b')],
      [decision('selection'), decision('done')],
      'A long version of the text.'
    )
    expect(script.writerExisting).toEqual(['A long version of the text.'])
    expect(script.acts).toEqual(['paste A shorter version.'])
    expect(script.selectionOffered).toEqual([true, false])
  })

  it('presses the shortcut it picked', async () => {
    await replay([screen('a'), screen('b')], [decision('key'), decision('done')])
    expect(script.acts).toEqual(['keys cmd+z'])
  })

  it('opens the app the writer names, and says so when there is no such app', async () => {
    script.written = 'Notes'
    await replay([screen('a'), screen('b')], [decision('app'), decision('done')])
    expect(script.writerPurposes).toEqual(['app'])
    expect(script.acts).toEqual(['app Notes'])
  })

  it('hands a drag or a right-click to the user with words for what to do next', async () => {
    const result = await replay([screen('a', [NEXT])], [decision('yours')])
    expect(script.acts).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.line).toMatch(/^Over to you - the next part needs your hands/)
    expect(result.detail).toMatch(/^Drags, right-clicks, double-clicks and sign-ins stay with you/)
  })

  it('types the text but leaves Post to the user', async () => {
    const result = await replay(
      [screen('a', [POST_BOX, POST]), screen('b', [POST_BOX, POST])],
      [decision('type', POST_BOX), decision('click', POST)]
    )
    expect(script.acts).toEqual(['press Post text', 'keys cmd+a', 'type chrome installer'])
    expect(result).toMatchObject({ ok: true })
    expect(result.line).toMatch(/^Over to you - press Post yourself/)
  })

  it('never presses Delete, even when nothing was typed', async () => {
    const result = await replay([screen('a', [DELETE])], [decision('click', DELETE)])
    expect(script.acts).toEqual([])
    expect(result.line).toMatch(/^Over to you - press Delete forever yourself/)
  })

  it('presses a control that is not on screen, and still never presses Delete there', async () => {
    const view = item('o1', 'View', 'AXMenuBarItem')
    const pressed = await replay(
      [{ ...screen('a'), offscreen: [view] }, screen('b')],
      [decision('press_offscreen', view), decision('done')]
    )
    expect(pressed).toMatchObject({ ok: true })
    expect(script.logRows.find((row) => row.event === 'recording')).toMatchObject({
      line: 'Pressed View'
    })

    const trash = item('o1', 'Delete forever', 'AXMenuItem')
    const refused = await replay(
      [{ ...screen('a'), offscreen: [trash] }],
      [decision('press_offscreen', trash)]
    )
    expect(script.acts).toEqual(['press View'])
    expect(refused.line).toMatch(/^Over to you - press Delete forever yourself/)
  })

  it('stops at a password field without asking for any text', async () => {
    const result = await replay([screen('a', [PASSWORD])], [decision('type', PASSWORD)])
    expect(script.writerCalls).toBe(0)
    expect(script.acts).toEqual([])
    expect(result.ok).toBe(false)
    expect(result.line).toMatch(/^Over to you - this needs your password/)
  })

  it('stops after pressing the same control three times on a page that keeps changing', async () => {
    const result = await replay(
      [screen('a', [NEXT]), screen('b', [NEXT]), screen('c', [NEXT]), screen('d', [NEXT])],
      [decision('click', NEXT)]
    )
    expect(script.acts).toEqual(['press Next', 'press Next', 'press Next'])
    expect(result.line).toMatch(/^Stopped - it kept repeating the same step/)
  })

  it('stops when two presses in a row change nothing', async () => {
    const result = await replay([screen('same', [NEXT])], [decision('click', NEXT)])
    expect(script.acts).toEqual(['press Next', 'press Next'])
    expect(result.line).toMatch(/^Stopped - the screen stopped changing/)
  })

  it('does nothing when the pick is no better than chance', async () => {
    const result = await replay([screen('a', [NEXT])], [decision('click', NEXT, 1 / KIND_COUNT)])
    expect(script.acts).toEqual([])
    expect(result.line).toMatch(/^Stopped - not sure what to press next/)
  })

  it('does not hop to another app or site on a half-sure pick', async () => {
    script.written = 'Mail'
    const hop = await replay([screen('a')], [decision('app', null, 0.46)])
    expect(script.acts).toEqual([])
    expect(hop.line).toMatch(/^Stopped - not sure what to press next/)
    script.written = 'deliver.kpg.com'
    await replay([screen('a')], [decision('site', null, 0.52)])
    expect(script.acts).toEqual([])
  })

  it('ends the run instead of opening the app that is already in front', async () => {
    script.written = 'google chrome'
    const result = await replay([screen('a')], [decision('app')])
    expect(script.acts).toEqual([])
    expect(result.line).toContain('Google Chrome is already in front')
  })

  it('asks twice, then gives up, when no decision comes back', async () => {
    const result = await replay([screen('a', [NEXT])], [{ failure: 'no answer' }])
    expect(script.decideCalls).toBe(2)
    expect(result.line).toMatch(/^Stopped - could not decide the next step/)
  })

  it('stops on Escape before the step it was about to take', async () => {
    script.pressEscapeOnDecide = 2
    const result = await replay(
      [screen('a', [NEXT]), screen('b', [NEXT])],
      [decision('click', NEXT)]
    )
    expect(script.acts).toEqual(['press Next'])
    expect(result.line).toMatch(/^Stopped - 1 step, /)
  })

  it('stops when it keeps typing into the same field, even with new words each time', async () => {
    const result = await replay(
      ['a', 'b', 'c', 'd', 'e'].map((print) => screen(print, [POST_BOX])),
      [decision('type', POST_BOX)]
    )
    expect(script.acts.filter((act) => act.startsWith('type ')).length).toBe(3)
    expect(result.line).toMatch(/^Stopped - it kept repeating the same step/)
  })

  it('tells the box every step, holds still while paused, and ends with why it stopped', async () => {
    const seen: ComputerUseStatus[] = []
    const off = onComputerUseStatus((status) => seen.push(status))
    script.screens = [screen('a', [NEXT]), screen('b', [NEXT]), screen('c')]
    script.decisions = [decision('click', NEXT), decision('click', NEXT), decision('done')]
    const run = runComputerUse({
      runId: 'r1',
      goal: 'a goal',
      bundleId: '',
      recentApps: [],
      selection: ''
    })
    pauseComputerUse(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(script.acts).toEqual([])
    expect(seen.at(-1)).toMatchObject({ state: 'paused', line: 'Paused' })
    pauseComputerUse(false)
    let settled = false
    void run.finally(() => (settled = true))
    while (!settled) await vi.advanceTimersByTimeAsync(500)
    off()
    expect(script.acts).toEqual(['press Next', 'press Next'])
    expect(seen.at(-1)?.state).toBe('ended')
    expect(seen.at(-1)?.line).toBe((await run).line)
  })

  it('Stop while paused ends the run with nothing pressed', async () => {
    script.screens = [screen('a', [NEXT])]
    script.decisions = [decision('click', NEXT)]
    const run = runComputerUse({
      runId: 'r1',
      goal: 'a goal',
      bundleId: '',
      recentApps: [],
      selection: ''
    })
    pauseComputerUse(true)
    await vi.advanceTimersByTimeAsync(1_000)
    stopComputerUse()
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await run).line).toMatch(/^Stopped/)
    expect(script.acts).toEqual([])
  })

  it('a pause that outlasts the run limit ends the run with nothing pressed', async () => {
    const off = onComputerUseStatus((s) => {
      if (s.state === 'running' && s.step === 1) pauseComputerUse(true)
    })
    const result = await replay([screen('a', [NEXT])], [decision('click', NEXT)])
    off()
    expect(script.acts).toEqual([])
    expect(result.ok).toBe(false)
  })

  it('refuses a second run while one is going', async () => {
    script.screens = [screen('a')]
    script.decisions = [decision('done')]
    const request = { runId: 'r1', goal: 'a goal', bundleId: '', recentApps: [], selection: '' }
    const first = runComputerUse(request)
    const second = await runComputerUse(request)
    expect(second).toEqual({ ok: false, line: 'Already doing something - stop that first.' })
    await vi.advanceTimersByTimeAsync(500)
    await first
  })
})
