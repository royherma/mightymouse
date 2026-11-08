/**
 * Pins how a history row reads when its run didn't succeed. Before this, the
 * phone got no failure signal at all: a failed run rendered identically to a
 * successful one, and tapping it pasted the user's own instruction as if it
 * were the result.
 */
import { describe, it, expect } from 'vitest'
import { CONFIG } from '@shared/config'
import type { DictationEntry } from '@shared/phone-remote-protocol'
import { rowFailure, rowIsPasteable, toastForRunDone } from './history-failure'

const base: DictationEntry = { id: 'r1', text: 'summarize this', kind: 'act', at: 0 }

describe('rowFailure', () => {
  it('leaves a successful row alone', () => {
    expect(rowFailure(base)).toBeNull()
    expect(rowIsPasteable(base)).toBe(true)
  })

  it('explains each known reason in the user`s words', () => {
    for (const reason of Object.keys(CONFIG.UI_LABELS.RUN_FAIL_REASON) as Array<
      keyof typeof CONFIG.UI_LABELS.RUN_FAIL_REASON
    >) {
      const f = rowFailure({ ...base, failed: true, reason })
      expect(f?.tone).toBe('failed')
      expect(f?.message).toBe(CONFIG.UI_LABELS.RUN_FAIL_REASON[reason])
    }
  })

  // Every row written before the reason field existed lands here.
  it('falls back to plain copy when the row carries no reason', () => {
    const f = rowFailure({ ...base, failed: true })
    expect(f?.message).toBe(CONFIG.UI_LABELS.RUN_FAIL_UNKNOWN)
    expect(f?.message).not.toMatch(/undefined/)
  })

  it('carries the stderr detail through for the expandable', () => {
    const f = rowFailure({ ...base, failed: true, reason: 'error', detail: 'command not found' })
    expect(f?.detail).toBe('command not found')
  })

  // The store writes ok:false at SPAWN and freezes it that way, so a live run
  // arrives flagged as failed. Calling that "failed" would be a lie about a job
  // that is working fine right now.
  it('reads a pending run as running, not failed', () => {
    const f = rowFailure({ ...base, failed: true, runState: 'pending' })
    expect(f?.tone).toBe('running')
    expect(f?.chip).toBe(CONFIG.UI_LABELS.HISTORY_ROW_RUNNING)
  })

  it('reads an interrupted run as stopped early, blaming the app not the agent', () => {
    const f = rowFailure({ ...base, failed: true, runState: 'interrupted' })
    expect(f?.tone).toBe('stopped')
    expect(f?.chip).toBe(CONFIG.UI_LABELS.HISTORY_ROW_INTERRUPTED)
  })

  it('never pastes a row that has no result behind it', () => {
    expect(rowIsPasteable({ ...base, failed: true })).toBe(false)
    expect(rowIsPasteable({ ...base, failed: true, runState: 'pending' })).toBe(false)
    expect(rowIsPasteable({ ...base, failed: true, runState: 'interrupted' })).toBe(false)
  })
})

describe('toastForRunDone', () => {
  it('passes a successful summary through untouched', () => {
    const t = toastForRunDone({ ok: true, summary: 'Rewrote 3 lines' })
    expect(t).toEqual({ text: 'Rewrote 3 lines', failed: false })
  })

  it('falls back to a plain ack when a success carries no summary', () => {
    expect(toastForRunDone({ ok: true, summary: '' }).text).toBe(CONFIG.UI_LABELS.RUN_DONE_OK)
  })

  // The whole point of the change: before this, a failure showed the raw backend
  // summary and read exactly like a success, so nothing told you it had failed.
  it('leads with the failure and appends the reason', () => {
    const t = toastForRunDone({ ok: false, summary: 'exit 1', reason: 'out_of_credits' })
    expect(t.failed).toBe(true)
    expect(t.text).toContain(CONFIG.UI_LABELS.RUN_FAILED_TOAST)
    expect(t.text).toContain(CONFIG.UI_LABELS.RUN_FAIL_REASON.out_of_credits)
  })

  it('never leaks raw backend text in place of a reason', () => {
    const t = toastForRunDone({ ok: false, summary: 'exit 1' })
    expect(t.text).toBe(`${CONFIG.UI_LABELS.RUN_FAILED_TOAST} ${CONFIG.UI_LABELS.RUN_FAIL_UNKNOWN}`)
    expect(t.text).not.toContain('exit 1')
    expect(t.text).not.toMatch(/undefined/)
  })

  it('explains every known reason on the toast too', () => {
    for (const reason of Object.keys(CONFIG.UI_LABELS.RUN_FAIL_REASON) as Array<
      keyof typeof CONFIG.UI_LABELS.RUN_FAIL_REASON
    >) {
      const t = toastForRunDone({ ok: false, summary: '', reason })
      expect(t.text).toContain(CONFIG.UI_LABELS.RUN_FAIL_REASON[reason])
    }
  })
})
