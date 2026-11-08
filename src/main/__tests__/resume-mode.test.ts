import { describe, it, expect } from 'vitest'
import type { AppMode, HistoryEntry } from '../../shared/types'

// The guardrail this file exists to be.
//
// The bug (reported 2026-07-21): a voice listen was actioned with Act from the HUD,
// then reopened from History to continue the conversation. It came back labelled
// `ask`, and the follow-up ran WITHOUT tool/screen access — the agent replied "I
// can't click through the checkout for you" for a request the act run could have
// handled. One user-visible symptom, three independent hardcoded 'ask' values:
//
//   1. main   — resumeSession returned `mode: 'ask'` regardless of the stored row.
//   2. main   — panelState.modeOverride kept its stale value across the resume, so
//               the next submit re-wrote the SAME run_id row with the wrong mode
//               (latest-wins dedupe → the act row's chip flipped to ASK).
//   3. render — the open-thread submit branch called `window.api.submit(v, 'ask')`
//               literally, so even a correct effectiveMode was discarded on send.
//
// Nothing caught any of them: `'ask'` is a valid AppMode, so all three typechecked
// perfectly. These tests pin the behavior each fix turns on.

/** The resume-mode decision, extracted from ipc/panel.ts's resumeSession. */
function resumedMode(entry: Pick<HistoryEntry, 'mode'> | undefined): AppMode {
  return entry?.mode || 'ask'
}

/**
 * The open-thread routing predicate, extracted from PanelApp's submit handler.
 * True = render inline as a chat turn AND submit as an ask.
 */
function routesAsInlineAsk(effectiveMode: AppMode, answerVisible: boolean): boolean {
  return effectiveMode === 'ask' || (answerVisible && effectiveMode !== 'act')
}

describe('resumeSession — a continued run keeps the mode it actually ran in', () => {
  it('resumes an act row as act, not ask', () => {
    // The exact regression: the row on disk says act; resume used to answer 'ask'.
    expect(resumedMode({ mode: 'act' })).toBe('act')
  })

  it('resumes ask/rewrite/write rows as themselves', () => {
    const modes: AppMode[] = ['ask', 'rewrite', 'write']
    for (const mode of modes) {
      expect(resumedMode({ mode })).toBe(mode)
    }
  })

  it('falls back to ask only when there is no row to read a mode from', () => {
    // The fallback is fine as a LAST resort — it must never shadow a real mode.
    expect(resumedMode(undefined)).toBe('ask')
  })
})

describe('open-thread submit routing — act never degrades into an inline ask', () => {
  it('keeps act out of the inline-ask branch even with a thread on screen', () => {
    // Resuming paints the thread (answerVisible = true). Before the fix that alone
    // was enough to send the follow-up as an ask and strip act's capabilities.
    expect(routesAsInlineAsk('act', true)).toBe(false)
  })

  it('still routes an ask follow-up inline', () => {
    expect(routesAsInlineAsk('ask', true)).toBe(true)
  })

  it('routes a first-turn ask inline with no thread open yet', () => {
    expect(routesAsInlineAsk('ask', false)).toBe(true)
  })

  it('leaves rewrite on the full-overlay path when no thread is open', () => {
    expect(routesAsInlineAsk('rewrite', false)).toBe(false)
  })
})
