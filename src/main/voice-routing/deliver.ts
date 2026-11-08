// deliver.ts — put the transcript into the chosen app.
//
// Two modes, and the difference is only whether your focus moves:
//   paste  — pasteTextToApp() activates the target just long enough to paste.
//   goto   — same, but we leave you there rather than returning you.
// Both optionally press Return, which is what makes this a router rather than a
// clipboard: the text lands in the agent's prompt box and runs.
//
// The text delivered is ALWAYS the verbatim transcript. Nothing in this file
// rewrites it — see the design's "What Jev decides, and what it does not".
import { pasteTextToApp, context, input } from '../platform'
import { devLog } from '../../shared/env'
import type { DesktopSink } from './sinks'

export type DeliverMode = 'paste' | 'goto'

/** Gap between the paste landing and Return. A web compose box (Gmail, an agent
 *  chat) re-renders on paste, and submitting into that frame drops the text. */
const SUBMIT_SETTLE_MS = 120

export interface DeliverResult {
  ok: boolean
  /** True when Return was actually pressed, so the caller's toast can say
   *  "sent" rather than "pasted" honestly. */
  submitted: boolean
  /** Why it failed, in the user's words. Absent on every success, and on the
   *  paths whose only failure mode is already named by the destination. */
  reason?: string
}

/** Press Return into whatever is frontmost, after the plain auto-paste. No
 *  waitForFrontmost guard is possible here — there is no target bundle id,
 *  the paste went wherever the user already was — so the settle delay is the
 *  only thing standing between the paste and the submit. */
export async function submitFrontmost(): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, SUBMIT_SETTLE_MS))
  try {
    return await input.typeText('return', 'key')
  } catch (err) {
    devLog.warn('[routing] submit-after-paste failed:', err)
    return false
  }
}

/**
 * Deliver `text` to `sink`.
 *
 * Never throws: a failed paste is reported, not raised, because the transcript
 * is already on the clipboard by the time we get here — the user can always
 * paste it themselves, which is the floor this feature must not fall below.
 */
export async function deliverToSink(
  text: string,
  sink: DesktopSink,
  mode: DeliverMode,
  submit: boolean
): Promise<DeliverResult> {
  if (text === '') return { ok: false, submitted: false }

  // Remember where we were, so 'paste' mode can put us back. Read BEFORE the
  // paste, since pasteTextToApp activates the target as part of its work.
  const origin = mode === 'paste' ? context.frontmostBundleId() : ''

  try {
    await pasteTextToApp(text, sink.appName)

    // Confirm the target really is frontmost before pressing Return. Activation
    // is asynchronous (see waitForFrontmost's header), and a Return that lands
    // early goes to whatever app we were in — which, for an agent chat, means
    // submitting into the wrong window. A false here means the app never came
    // forward, so we paste and leave the text for the user rather than firing a
    // keystroke blind.
    let landed = false
    if (submit) {
      landed = await context.waitForFrontmost(sink.bundleId)
      if (landed) await new Promise((resolve) => setTimeout(resolve, SUBMIT_SETTLE_MS))
    }
    const pressed = submit && landed ? await input.typeText('return', 'key') : false

    // 'paste' means "send it without moving me": hand focus back to whatever I
    // was in. 'goto' deliberately leaves us in the target app.
    if (mode === 'paste' && origin !== '' && origin !== sink.bundleId) {
      context.activateApp(origin)
    }
    return { ok: true, submitted: pressed }
  } catch (err) {
    devLog.warn(`[routing] delivery to ${sink.appName} failed:`, err)
    return { ok: false, submitted: false }
  }
}
