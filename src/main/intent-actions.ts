/**
 * The verbs an App Intent can fire at the Mac with nobody at the keyboard.
 *
 * Deliberately a SMALL closed table, not a bridge to the ~70 phone-remote verbs
 * (mac-as-an-intent-target PRD §4b). Siri hands us an opaque string off the
 * network; anything that is not one of these names must fail before it reaches
 * a synthesis call, so the table is the allowlist and there is no default arm.
 *
 * Why accessibility and not a hotkey: ChatGPT.app exposes real buttons with
 * real labels ("Start voice chat" in the composer, "Start new voice chat" in
 * the sidebar), both AXPress-able. A hotkey would need the user to bind one in
 * ChatGPT (it ships Off) and then retype the same combo here -- two chances to
 * be wrong, and the press would fire blind. AXPress reports what it did, and
 * we can read the tree afterwards to prove the session actually started.
 *
 * Verified live on 2026-09-15 against ChatGPT 26.908.40834: pressing "Start
 * voice chat" replaced it with "Stop voice chat" and added "Voice chat active"
 * and "Mute microphone" to the tree.
 */
import { context } from './platform'
import type { AxPressResult } from './platform/contract'
import { devLog } from '../shared/env'
import { askMacAboutScreen, MacAnswerError } from './mac-answer'
import { isCurtainVisible } from './phone-remote/privacy-curtain'
import { isAwayModeHeld } from './phone-remote/away-mode'
import { sendToPhone } from './phone-remote/server-runtime'
import { SETTINGS } from './store/settings'
import { PREFS } from './store/prefs'

/** The one app this ships for. Verified live: `com.openai.codex` is ChatGPT.app
 *  (the Codex-based build), not a Codex-only sibling. */
export const CHATGPT_BUNDLE_ID = 'com.openai.codex'

/**
 * The only label that reliably says whether a call is live.
 *
 * Not "Start voice chat": starting navigates the window to a separate voice
 * view where that button no longer exists, so its absence means either "a call
 * is running" or "we're on a screen that never had one". Stop is present if and
 * only if there is a call to stop, in every view -- so it is both the
 * post-condition for starting and the already-guard for starting twice.
 */
const VOICE_LIVE_LABEL = 'Stop voice chat'

/** Both entry points to the same action. ChatGPT puts one in the composer and
 *  one in the sidebar, and which exists depends on the current view. */
const VOICE_START_LABELS = ['Start voice chat', 'Start new voice chat']

export type IntentActionName = 'startChatGptVoice' | 'stopChatGptVoice' | 'screen'

export type IntentActionFailure =
  | 'unknown-action'
  | 'app-missing'
  | 'named-app-missing'
  | 'control-missing'
  | 'unverified'
  | 'failed'
  | 'screen-off'
  | 'no-screen'
  | 'model-failed'

export type IntentActionResult =
  | { ok: true; spoken: string; meta: IntentActionMeta }
  | { ok: false; reason: IntentActionFailure; meta?: IntentActionMeta }

/** Either kind of account an action can give. A press reports which control it
 *  hit; a model answer reports how long the two calls took. Forcing the second
 *  into the first's shape would mean a bundleId and a `pressed` label on a run
 *  that pressed nothing. */
export type IntentActionMeta = AxActionMeta | ScreenActionMeta | RoutedActionMeta

/**
 * What a routed sentence did (intent-router.ts).
 *
 * Kept apart from the two above because the question it has to answer is
 * different: those record how ONE known verb ran, this records which verb a
 * sentence turned into. When a spoken request does the wrong thing, the
 * classification is the suspect, so `said` and `verb` are the log line -- an
 * AxActionMeta from the verb that ran would show a perfect press of the wrong
 * button and explain nothing.
 */
export interface RoutedActionMeta {
  action: 'say'
  kind: 'routed'
  /** The sentence as the phone heard it. The only way to tell a misheard word
   *  from a misrouted verb after the fact. */
  said: string
  /** Which verb the model picked, or 'unknown'. */
  verb: string
  /** Time spent classifying, separate from `ms` so the router's overhead can be
   *  measured against Siri's ceiling without re-running it by hand. */
  routeMs: number
  ms: number
}

/**
 * The machine-readable half of every outcome, for logs and for the phone.
 *
 * Exists because "it didn't work" is the least useful thing an automated
 * action can report. With this, a failure says which app, which control it
 * looked for, which one it pressed, what proved the change, and how long it
 * took -- enough to tell a missing app from a renamed button from a slow one
 * without reproducing it.
 */
export interface AxActionMeta {
  action: IntentActionName
  kind: 'accessibility'
  /** Which app was driven, so a log line is unambiguous when this table grows. */
  bundleId: string
  /** How the Mac did it. Recorded because the mechanism is a decision that may
   *  change per app, and a log that omits it can't explain a regression. */
  method: 'accessibility'
  /** The binary's own status verbatim -- see AxPressResult. */
  status: AxPressResult['status']
  /** True only when a post-condition was observed, never merely delivered. */
  verified: boolean
  /** Whether the state already held, so nothing was pressed. */
  alreadyInState: boolean
  pressed?: string
  confirmedBy?: string
  ms: number
}

/**
 * What a screen answer has to account for.
 *
 * Split out by timing because the two halves fail differently and only one of
 * them is ours: a slow capture is a machine under load, a slow model is the
 * backend. Siri's timeout is the thing this path lives or dies by (August PRD
 * §10 Q1, still unmeasured), so the numbers that decide it get recorded on
 * every run rather than measured once by hand.
 */
export interface ScreenActionMeta {
  action: 'screen'
  kind: 'screen-answer'
  /** Time to get the bitmap. Separate from the model call because a slow
   *  capture and a slow model have nothing to do with each other. */
  captureMs: number
  /** Time inside runBackend. The half we can shorten with `fast`. */
  modelMs: number
  ms: number
  /** Which backend answered — the user's choice, never forced here. */
  backend: string
  /** Answer length, not the answer: a log that quotes what was on screen
   *  defeats the point of gating the screenshot at all. */
  answerChars: number
}

function metaFrom(action: IntentActionName, result: AxPressResult): AxActionMeta {
  return {
    action,
    kind: 'accessibility',
    bundleId: CHATGPT_BUNDLE_ID,
    method: 'accessibility',
    status: result.status,
    verified: result.verified,
    alreadyInState: result.status === 'already',
    pressed: result.pressed,
    confirmedBy: result.confirmedBy,
    ms: result.ms
  }
}

/** One structured line per attempt. JSON on purpose: these get read after the
 *  fact, often from a user's machine, where a grep for the action name has to
 *  return everything about that attempt and not half of it. */
function logOutcome(meta: IntentActionMeta, ok: boolean): void {
  // `at` because devLog is a bare console.log: without it a line read after
  // the fact cannot be told from one three hours older in the same file, and
  // the whole point of reading this log is "did the attempt I just made work".
  devLog.log(`intent-action ${JSON.stringify({ at: new Date().toISOString(), ...meta, ok })}`)
}

/**
 * Front ChatGPT, LAUNCHING it if it isn't running.
 *
 * `activateApp` alone only fronts an app that already has a process, so a
 * closed ChatGPT reported "app-missing" -- the flat failure the hands-free case
 * hits most, since asking Siri from another room is exactly when the app is not
 * already open. Same bug and same fix as `openApp` in intent-router.ts: `open
 * -b` launches or fronts, so it covers both halves.
 *
 * Still returns false for a genuinely absent app, because `open -b` fails on an
 * unknown bundle id -- so "app-missing" keeps meaning what it says.
 *
 * `launched` tells the caller which path ran, because a cold start needs a
 * longer verify budget on the press (see COLD_PRESS_TIMEOUT_MS).
 */
async function frontChatGpt(): Promise<{ ok: boolean; launched: boolean }> {
  if (context.activateApp(CHATGPT_BUNDLE_ID)) return { ok: true, launched: false }
  const { spawnSync } = await import('child_process')
  const r = spawnSync('open', ['-b', CHATGPT_BUNDLE_ID], { timeout: 5000, encoding: 'utf8' })
  return { ok: r.status === 0, launched: true }
}

/**
 * Verify budget for a press against a JUST-LAUNCHED ChatGPT, vs mm-ax's 6000ms
 * default. The window and its buttons are there within ~400ms of `open -b`
 * (measured 374ms), so the press itself lands -- but the app is still restoring
 * its session, and the voice UI that confirms it takes longer to swap in. A
 * cold run measured 2026-09-15 came back {"status":"unverified","pressed":
 * "Start new voice chat"} at 8000ms and {"verified":true} on a later retry with
 * no other change, so the press had worked both times and only the confirmation
 * was late. Unverified is the expensive answer here: the session IS live and we
 * tell the user it failed, so they say it again and hang up the call they just
 * started.
 *
 * Only the cold path pays it, and mm-ax returns as soon as the label appears --
 * a warm press still answers in its usual ~1s.
 */
const COLD_PRESS_TIMEOUT_MS = 20000

/**
 * Bring ChatGPT forward, then press its voice button.
 *
 * The activate is not cosmetic: AXPress works on a background window, but Roy's
 * success test is a session he can see and talk to, and an app that isn't
 * running has no tree to search at all -- so raising it first turns a confusing
 * "control-missing" into an honest "app-missing".
 */
export async function startChatGptVoice(): Promise<IntentActionResult> {
  const front = await frontChatGpt()
  if (!front.ok) {
    return { ok: false, reason: 'app-missing' }
  }
  // Resolves on its own timeout too, so the state afterwards is what counts,
  // not the call returning.
  await context.waitForFrontmost(CHATGPT_BUNDLE_ID)

  const result = await context.axPress({
    bundleId: CHATGPT_BUNDLE_ID,
    press: VOICE_START_LABELS,
    verify: [VOICE_LIVE_LABEL],
    already: [VOICE_LIVE_LABEL],
    ...(front.launched ? { timeoutMs: COLD_PRESS_TIMEOUT_MS } : {})
  })
  const meta = metaFrom('startChatGptVoice', result)

  if (result.status === 'already') {
    logOutcome(meta, true)
    return { ok: true, spoken: 'Voice mode is already running on your Mac.', meta }
  }
  if (result.verified) {
    logOutcome(meta, true)
    return { ok: true, spoken: 'Voice mode is on. Go ahead and talk.', meta }
  }

  logOutcome(meta, false)
  return { ok: false, reason: failureFor(result), meta }
}

/**
 * End the call.
 *
 * A first-class verb rather than a nicety: a realtime voice session bills for
 * as long as it is open, so the thing that starts one hands-free must be able
 * to close one hands-free. Roy, on discovering it had been left running:
 * "please turn it off as well ... bc it costs money".
 */
export async function stopChatGptVoice(): Promise<IntentActionResult> {
  const result = await context.axPress({
    bundleId: CHATGPT_BUNDLE_ID,
    press: [VOICE_LIVE_LABEL],
    // No --verify: stopping navigates back to a normal chat view whose labels
    // depend on where the user was, so there is no one string that proves it.
    // The already-guard carries the weight instead -- a second call finds no
    // Stop button and reports not-found, which is the correct answer.
    timeoutMs: 4000
  })
  const meta = metaFrom('stopChatGptVoice', result)

  // Also on `not-found`: the two sides can disagree. A call closed in ChatGPT's
  // own window leaves the phone holding an open mic, and this verb is the only
  // thing that ever tells it otherwise.
  if (result.status === 'ok' || result.status === 'not-found') {
    sendToPhone({ type: 'voiceCallEnded' })
  }

  if (result.status === 'not-found') {
    logOutcome(meta, true)
    return { ok: true, spoken: 'Voice mode was already off.', meta }
  }
  if (result.status === 'ok') {
    logOutcome(meta, true)
    return { ok: true, spoken: 'Voice mode is off.', meta }
  }

  logOutcome(meta, false)
  return { ok: false, reason: failureFor(result), meta }
}

/**
 * "Hey Siri, what's on my Mac?" — the ship gate (mac-as-an-intent-target §9.4).
 *
 * The one verb here that reads the screen rather than pressing something, so it
 * is the only one with a privacy gate. Three refusals come BEFORE the capture,
 * never after: a screenshot that was taken and then discarded has already been
 * taken.
 *
 * `siriScreenAnswer` defaults ON (Roy, 2026-09-15). The curtain and away-mode
 * guards below are what actually protect the deliberately-hidden screen, and a
 * default-off switch would make the headline phrase answer "turn me on first"
 * for every new user. Note redact.ts cannot help here — it scrubs TEXT, and
 * this sends a bitmap, so these guards are the whole boundary.
 *
 * `fast: true` on purpose: Siri's patience is unverified (§10 Q1) and a lighter
 * model inside the deadline beats a better answer Siri cuts off. The meta
 * carries captureMs/modelMs so the real budget is measured, not guessed.
 */
export async function screenAnswer(
  question = 'What is on this screen? Answer in one or two short sentences, spoken aloud to someone who cannot see it.'
): Promise<IntentActionResult> {
  const started = Date.now()

  if (SETTINGS.get().siriScreenAnswer === false) {
    return { ok: false, reason: 'screen-off' }
  }
  // Both mean the screen is hidden ON PURPOSE. Capturing past either one would
  // hand Siri exactly the pixels the user covered.
  if (isCurtainVisible() || isAwayModeHeld()) {
    return { ok: false, reason: 'screen-off' }
  }

  const captureStarted = Date.now()
  let captureMs = 0
  try {
    const { answer, backend, modelMs } = await captureAndAsk(question, () => {
      captureMs = Date.now() - captureStarted
    })
    const meta: ScreenActionMeta = {
      action: 'screen',
      kind: 'screen-answer',
      captureMs,
      modelMs,
      ms: Date.now() - started,
      backend,
      answerChars: answer.length
    }
    logOutcome(meta, true)
    return { ok: true, spoken: answer, meta }
  } catch (err) {
    // 'no-screen' is the sleeping display (SCK -3815) and is an expected
    // degrade with its own sentence, not a fault to report as one.
    const reason: IntentActionFailure =
      err instanceof MacAnswerError && err.kind === 'no-screen' ? 'no-screen' : 'model-failed'
    const meta: ScreenActionMeta = {
      action: 'screen',
      kind: 'screen-answer',
      captureMs,
      modelMs: 0,
      ms: Date.now() - started,
      backend: PREFS.getBackend(),
      answerChars: 0
    }
    logOutcome(meta, false)
    return { ok: false, reason, meta }
  }
}

/** Splits the capture from the model call so each is timed on its own. The
 *  callback fires the moment the bitmap exists, which is the only point where
 *  the two phases can be told apart from out here. */
async function captureAndAsk(
  question: string,
  onCaptured: () => void
): Promise<{ answer: string; backend: string; modelMs: number }> {
  const backend = PREFS.getBackend()
  const modelStarted = { at: 0 }
  const { answer } = await askMacAboutScreen(question, {
    backend,
    fast: true,
    timeoutMs: SCREEN_ANSWER_TIMEOUT_MS,
    onCaptured: () => {
      onCaptured()
      modelStarted.at = Date.now()
    }
  })
  return {
    answer,
    backend,
    modelMs: modelStarted.at ? Date.now() - modelStarted.at : 0
  }
}

/** Measured 2026-09-15 on this Mac, not guessed: capture 286-362ms, then the
 *  fast model (claude-sonnet-5) on the same frame at 29.5s, 31.3s and 38.8s --
 *  cold-spawned, which is what the 14.4s CLI floor buys you. 30s would have cut
 *  off two of those three. 45s clears the slowest run measured; the answer
 *  arriving late still beats a refusal for a question the Mac could have
 *  answered. Warm-session resume (captureAndAsk) is what brings this down --
 *  lower the ceiling when a resumed run has been measured, not before. */
const SCREEN_ANSWER_TIMEOUT_MS = 45000

function failureFor(result: AxPressResult): IntentActionFailure {
  switch (result.status) {
    case 'not-running':
      return 'app-missing'
    case 'not-found':
      return 'control-missing'
    case 'unverified':
      return 'unverified'
    default:
      return 'failed'
  }
}

const ACTIONS: Record<IntentActionName, () => Promise<IntentActionResult>> = {
  startChatGptVoice,
  stopChatGptVoice,
  screen: () => screenAnswer()
}

export async function runIntentAction(name: string): Promise<IntentActionResult> {
  // hasOwnProperty, not `name in ACTIONS`: the name arrives off the network and
  // `in` walks the prototype chain, so 'constructor' and '__proto__' would both
  // resolve to a function.
  const action = Object.prototype.hasOwnProperty.call(ACTIONS, name)
    ? ACTIONS[name as IntentActionName]
    : undefined
  if (!action) return { ok: false, reason: 'unknown-action' }
  return action()
}

/** Every failure a caller has to say out loud, in words a user can act on. The
 *  caller speaks these -- never a reason code, and never a stack trace. */
export function describeFailure(reason: IntentActionFailure): string {
  switch (reason) {
    case 'unknown-action':
      return "I don't know how to do that on your Mac yet."
    case 'app-missing':
      return "I couldn't open ChatGPT on your Mac."
    // The ChatGPT case above names its app because only one intent raises it.
    // The router's openApp can name ANY app, so it cannot borrow that string --
    // it spoke "I couldn't open ChatGPT" for a Spotify request (2026-09-15).
    case 'named-app-missing':
      return "I couldn't find that app on your Mac."
    case 'control-missing':
      return "I opened ChatGPT but couldn't find the voice button."
    case 'unverified':
      return "I pressed the voice button but couldn't confirm it started."
    case 'failed':
      return 'Something went wrong on your Mac. MightyMouse may need accessibility permission.'
    case 'screen-off':
      // Deliberately one sentence for the toggle AND the curtain: naming which
      // guard fired would tell whoever is holding the phone that the Mac is
      // covered, which is the state a covered Mac exists to not announce.
      return "I can't see your Mac's screen right now."
    case 'no-screen':
      return "Your Mac is asleep, so I can't see the screen."
    case 'model-failed':
      return "I saw your Mac's screen but couldn't get an answer about it."
  }
}
