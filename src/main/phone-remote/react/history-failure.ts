import { CONFIG } from '@shared/config'
import type { DictationEntry } from '@shared/phone-remote-protocol'
import type { RunFailReason } from '@shared/types'

/** How a history row reads when it didn't succeed; `null` for a normal row. */
export interface RowFailure {
  tone: 'failed' | 'stopped' | 'running'
  chip: string
  message: string
  detail?: string
}

/** A live run arrives `failed: true` -- the store writes `ok: false` at spawn --
 *  so `failed` alone would read "it failed" over a job running fine right now.
 *  Check `runState` before the reason, never after. */
export function rowFailure(entry: DictationEntry): RowFailure | null {
  if (!entry.failed) return null

  if (entry.runState === 'pending') {
    return {
      tone: 'running',
      chip: CONFIG.UI_LABELS.HISTORY_ROW_RUNNING,
      message: CONFIG.UI_LABELS.HISTORY_ROW_RUNNING_HINT
    }
  }
  if (entry.runState === 'interrupted') {
    return {
      tone: 'stopped',
      chip: CONFIG.UI_LABELS.HISTORY_ROW_INTERRUPTED,
      message: CONFIG.UI_LABELS.HISTORY_ROW_INTERRUPTED_TOOLTIP
    }
  }

  const reason = entry.reason
  const message =
    (reason && CONFIG.UI_LABELS.RUN_FAIL_REASON[reason]) || CONFIG.UI_LABELS.RUN_FAIL_UNKNOWN
  return {
    tone: 'failed',
    chip: CONFIG.UI_LABELS.HISTORY_ROW_FAILED,
    message,
    detail: entry.detail
  }
}

/** False when `text` is the INSTRUCTION rather than a result -- pasting one drops
 *  the user's own words into their document as if the run had produced them. */
export function rowIsPasteable(entry: DictationEntry): boolean {
  return rowFailure(entry) === null
}

/** What the toast says when the phone saved a clip but couldn't write out the
 *  words. Always reads as "saved" first: the recording is intact and the Mac
 *  still types it out, so this is a missing preview, not a lost note. */
export function clipPhoneTextFailedCopy(
  reason: keyof typeof CONFIG.UI_LABELS.CLIP_PHONE_TEXT_FAILED
): string {
  return CONFIG.UI_LABELS.CLIP_PHONE_TEXT_FAILED[reason]
}

/** What the toast says when a run lands. The failure text must stand alone: the
 *  toast is the only place the user is looking, and `summary` on a failed run is
 *  raw backend text ("exit 1") that explains nothing on its own. */
export function toastForRunDone(args: {
  ok: boolean
  summary: string
  reason?: RunFailReason
}): { text: string; failed: boolean } {
  if (args.ok) return { text: args.summary || CONFIG.UI_LABELS.RUN_DONE_OK, failed: false }
  const why =
    (args.reason && CONFIG.UI_LABELS.RUN_FAIL_REASON[args.reason]) ||
    CONFIG.UI_LABELS.RUN_FAIL_UNKNOWN
  return { text: `${CONFIG.UI_LABELS.RUN_FAILED_TOAST} ${why}`, failed: true }
}
