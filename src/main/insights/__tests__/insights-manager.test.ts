import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Suggestion, SuggestState } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'

// The manager pulls in heavy side-effecting modules (spawns runs, opens HUD
// windows, hits disk). Mock them so this test exercises ONLY the manager's own
// state machine: show → bubble active → accept/dismiss → outcome recorded → run
// fired. Each mock records what the manager asked it to do so we can assert it.

const runHudRun = vi.fn()
const startHud = vi.fn()
const pasteTextToApp = vi.fn()
const clipboardWrite = vi.fn()
// The trigger app captureContext() reports as frontmost — overridden per test so the
// focus-intact guard in the 'write' paste path can be exercised both ways.
let frontAppNow = 'X'
const recorded: Array<Record<string, unknown>> = []
const events: Array<{ event: string; props: Record<string, unknown> }> = []

vi.mock('../../backend/hud-run', () => ({ runHudRun: (o: unknown) => runHudRun(o) }))
vi.mock('../../hud-window', () => ({ startHud: (...a: unknown[]) => startHud(...a) }))
// cursor-window pulls in electron's BrowserWindow (CJS) which the test env can't
// resolve as a named ESM export — mock it so the focus-release call is a no-op.
vi.mock('../../cursor-window', () => ({ setCursorFocusable: () => {} }))
vi.mock('../../platform', () => ({
  pasteTextToApp: (t: string, app: string) => pasteTextToApp(t, app),
  captureContext: () => Promise.resolve({ frontApp: frontAppNow })
}))
vi.mock('electron', () => ({ clipboard: { writeText: (t: string) => clipboardWrite(t) } }))
vi.mock('../../backend/context-memory', () => ({ buildMemoryBlob: () => '' }))
vi.mock('../../analytics', () => ({ track: (event: string, props: Record<string, unknown>) => events.push({ event, props }) }))
vi.mock('../../store/events', () => ({ EVENTS: { append: () => {} } }))
vi.mock('../../store/prefs', () => ({
  PREFS: { getBackend: () => 'claude', getExperimentalSuggestions: () => true, getIncognito: () => false }
}))
// Idle path deps — collect/predict are async; keep them deterministic.
vi.mock('../signal-collector', () => ({
  collect: vi.fn(),
  bucketFromSignals: (s: { ctxData: { frontApp: string | null } }) => ({ front_app: s.ctxData.frontApp || '' }),
  signalFingerprint: (s: { selection: string }) => s.selection
}))
vi.mock('../predictor', () => ({ predict: vi.fn() }))
vi.mock('../outcome-store', () => ({
  OutcomeStore: { record: (o: Record<string, unknown>) => recorded.push(o) },
  outcomeTimestamp: () => '2026-06-02T00:00:00.000Z'
}))
vi.mock('../ranker', () => ({
  instructionStem: (s: string) => s.toLowerCase(),
  Ranker: { rerank: (s: Suggestion[]) => s, topAcceptedStems: () => [] }
}))

import {
  startInsightsManager,
  stopInsightsManager,
  setSuggestionSender,
  setCancelArmSender,
  showSuggestionsForDev,
  hasActiveBubble,
  isBubbleVisible,
  armBubbleCancel,
  acceptActiveSuggestion,
  dismissActiveBubble,
  handleCursorSample
} from '../insights-manager'
import { collect } from '../signal-collector'
import { predict, type PredictResult } from '../predictor'

const SUGGESTIONS: Suggestion[] = [
  { label: 'Summarize', instruction: 'Summarize the thread', mode: 'ask' },
  { label: 'Fix grammar', instruction: 'Fix grammar', mode: 'rewrite' },
  { label: 'Reply yes', instruction: 'Draft a yes reply', mode: 'act' }
]

// A full ok:true PredictResult around a suggestion set — carries the backend/model/
// prompts fields the trace log reads, so mocks exercise the real result shape.
const okResult = (suggestions: Suggestion[]): PredictResult => ({
  ok: true,
  suggestions,
  backend: 'claude',
  model: 'test-model',
  prompts: { systemPrompt: '', userPrompt: '', hasRecall: false }
})

let broadcasts: SuggestState[] = []

// The 'ready' state the manager broadcasts when it shows a set.
const ready = (suggestions: Suggestion[]): SuggestState => ({ phase: 'ready', suggestions })
const HIDDEN: SuggestState = { phase: 'hidden' }

beforeEach(() => {
  runHudRun.mockClear()
  startHud.mockClear()
  pasteTextToApp.mockClear()
  clipboardWrite.mockClear()
  frontAppNow = 'X'
  recorded.length = 0
  events.length = 0
  broadcasts = []
  startInsightsManager()
  setSuggestionSender((s) => broadcasts.push(s))
})

afterEach(() => {
  setSuggestionSender(null)
  stopInsightsManager()
})

describe('InsightsManager — show + accept flow', () => {
  it('shows an injected set and marks the bubble active', () => {
    expect(hasActiveBubble()).toBe(false)
    showSuggestionsForDev(SUGGESTIONS)
    expect(hasActiveBubble()).toBe(true)
    expect(broadcasts.at(-1)).toEqual(ready(SUGGESTIONS))
  })

  it('accepting an index fires the run for THAT suggestion and clears the bubble', async () => {
    showSuggestionsForDev(SUGGESTIONS)
    const ok = acceptActiveSuggestion(1) // "Fix grammar"
    expect(ok).toBe(true)
    expect(hasActiveBubble()).toBe(false)
    expect(broadcasts.at(-1)).toEqual(HIDDEN) // bubble hidden
    // The run dispatch awaits a fresh captureContext() (click-time trigger app),
    // so it fires on a later microtask — flush before asserting it ran.
    await vi.waitFor(() => expect(runHudRun).toHaveBeenCalledTimes(1))
    const opts = runHudRun.mock.calls[0][0] as { mode: string; instruction: string }
    expect(opts.mode).toBe('rewrite')
    expect(opts.instruction).toBe('Fix grammar')
  })

  it('records the picked suggestion accepted and the others dismissed (the learning signal)', () => {
    showSuggestionsForDev(SUGGESTIONS)
    acceptActiveSuggestion(0) // "Summarize"
    expect(recorded).toHaveLength(3)
    const accepted = recorded.filter((r) => r.accepted === true)
    const rejected = recorded.filter((r) => r.accepted === false)
    expect(accepted).toHaveLength(1)
    expect(accepted[0].instruction_stem).toBe('summarize the thread')
    expect(rejected).toHaveLength(2)
    expect(events.some((e) => e.event === 'suggestion_accepted')).toBe(true)
  })

  it('accepting an out-of-range index is a no-op', () => {
    showSuggestionsForDev(SUGGESTIONS)
    expect(acceptActiveSuggestion(9)).toBe(false)
    expect(hasActiveBubble()).toBe(true) // still up
    expect(runHudRun).not.toHaveBeenCalled()
  })
})

describe('InsightsManager — dismiss', () => {
  it('does NOT dismiss when the cursor moves (Esc is the only dismiss)', () => {
    showSuggestionsForDev(SUGGESTIONS)
    handleCursorSample({ x: 0, y: 0 })
    handleCursorSample({ x: CONFIG.SUGGESTIONS.MOVE_PX + 50, y: 0 }) // big move
    expect(hasActiveBubble()).toBe(true) // bubble stays put
    expect(events.some((e) => e.event === 'suggestion_dismissed')).toBe(false)
  })

  it('dismissActiveBubble (Esc) hides the bubble and records the set dismissed', () => {
    showSuggestionsForDev(SUGGESTIONS)
    const ok = dismissActiveBubble()
    expect(ok).toBe(true)
    expect(hasActiveBubble()).toBe(false)
    expect(broadcasts.at(-1)).toEqual(HIDDEN)
    expect(recorded.filter((r) => r.accepted === false)).toHaveLength(SUGGESTIONS.length)
    expect(events.some((e) => e.event === 'suggestion_dismissed')).toBe(true)
  })

  it('dismissActiveBubble is a no-op when nothing is shown', () => {
    expect(dismissActiveBubble()).toBe(false)
  })
})

describe('InsightsManager — HUD-style cancel (Esc arms, Enter confirms)', () => {
  it('armBubbleCancel fires the arm signal only when a bubble is up', () => {
    const armed: number[] = []
    setCancelArmSender(() => armed.push(1))
    expect(armBubbleCancel()).toBe(false) // nothing shown yet
    expect(armed).toHaveLength(0)

    showSuggestionsForDev(SUGGESTIONS)
    expect(armBubbleCancel()).toBe(true)
    expect(armed).toHaveLength(1)
    setCancelArmSender(null)
  })

  it('isBubbleVisible is true for a ready bubble; dismiss hides it', () => {
    expect(isBubbleVisible()).toBe(false)
    showSuggestionsForDev(SUGGESTIONS)
    expect(isBubbleVisible()).toBe(true)
    expect(dismissActiveBubble()).toBe(true)
    expect(isBubbleVisible()).toBe(false)
    expect(broadcasts.at(-1)).toEqual(HIDDEN)
  })
})

describe('InsightsManager — write suggestion (instant paste, no LLM)', () => {
  const WRITE: Suggestion = {
    label: 'Draft Tweet',
    instruction: 'Draft a punchy tweet',
    mode: 'rewrite',
    kind: 'write',
    text: 'Building apps has never been easier.'
  }

  // Seed a bubble through the idle path so its signals carry a real frontApp (the
  // focus-intact guard needs one). showSuggestionsForDev uses frontApp:null.
  async function showWriteBubble(): Promise<void> {
    vi.mocked(collect).mockResolvedValue({
      ctxData: { frontApp: 'X', windowTitle: 'Home / X', browserURL: 'x.com', screenshotPath: null },
      // Non-empty so the fingerprint mock (keys on selection) doesn't dedupe against
      // the initial empty lastFingerprint and skip the show. Real fingerprints fold
      // in ambient context, so a compose surface with empty selection still fires.
      selection: 'compose-x',
      ambientContext: '',
      recentHistory: [],
      recallBlob: '',
      source: 'idle'
    })
    vi.mocked(predict).mockResolvedValue(okResult([WRITE]))
    handleCursorSample({ x: 0, y: 0 })
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + CONFIG.SUGGESTIONS.IDLE_MS + 1)
    handleCursorSample({ x: 0, y: 0 })
    vi.mocked(Date.now).mockRestore()
    await vi.waitFor(() => expect(hasActiveBubble()).toBe(true))
  }

  it('pastes the drafted text and never runs the backend when focus is intact', async () => {
    await showWriteBubble()
    expect(acceptActiveSuggestion(0)).toBe(true)
    // Pastes the draft AND re-activates the trigger app (so a click-picked chip,
    // which blurs the field, still lands the paste in the right window).
    await vi.waitFor(() => expect(pasteTextToApp).toHaveBeenCalledWith(WRITE.text, 'X'))
    expect(runHudRun).not.toHaveBeenCalled() // the whole point: no LLM round-trip
    expect(hasActiveBubble()).toBe(false)
    expect(events.some((e) => e.event === 'suggestion_write_pasted')).toBe(true)
  })

  it('re-activates the captured trigger app and pastes even when focus moved away', async () => {
    // The intended target is the app frontmost when the bubble showed ('X'), captured
    // at trigger time. pasteTextToApp re-activates it BY NAME before Cmd+V, so the
    // paste lands correctly even though the user is now on Slack (or our own popover
    // holds focus after a Confirm). The old code re-read the front app and bailed to
    // clipboard-only here — which meant a popover-confirmed draft NEVER pasted.
    await showWriteBubble()
    frontAppNow = 'Slack' // user clicked away / popover stole focus before picking
    expect(acceptActiveSuggestion(0)).toBe(true)
    await vi.waitFor(() => expect(pasteTextToApp).toHaveBeenCalledWith(WRITE.text, 'X'))
    expect(events.some((e) => e.event === 'suggestion_write_pasted')).toBe(true)
  })

  it('still records the accept as the learning signal', async () => {
    await showWriteBubble()
    acceptActiveSuggestion(0)
    await vi.waitFor(() => expect(recorded.some((r) => r.accepted === true)).toBe(true))
    expect(events.some((e) => e.event === 'suggestion_accepted')).toBe(true)
  })
})

describe('InsightsManager — idle prediction path', () => {
  it('runs the real collect→predict pipeline and broadcasts the result', async () => {
    vi.mocked(collect).mockResolvedValue({
      ctxData: { frontApp: 'Mail', windowTitle: 'Inbox', browserURL: null, screenshotPath: null },
      selection: 'hello',
      ambientContext: '',
      recentHistory: [],
      recallBlob: '',
      source: 'idle'
    })
    vi.mocked(predict).mockResolvedValue(okResult([SUGGESTIONS[0]]))

    // Sit idle: seed, then cross the idle threshold.
    handleCursorSample({ x: 0, y: 0 })
    // Manually age lastPoint by replaying a sample after the idle window.
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + CONFIG.SUGGESTIONS.IDLE_MS + 1)
    handleCursorSample({ x: 0, y: 0 }) // no move, now idle → predict
    vi.mocked(Date.now).mockRestore()

    // Let the async predict resolve.
    await vi.waitFor(() => expect(broadcasts.some((b) => b.phase === 'ready')).toBe(true))
    expect(broadcasts.at(-1)).toEqual(ready([SUGGESTIONS[0]]))
    expect(hasActiveBubble()).toBe(true)
  })
})
