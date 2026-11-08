/**
 * Turn one spoken sentence into one verb the Mac can run.
 *
 * The closed table in intent-actions.ts is still the whole execution surface --
 * this does not widen it. What it removes is the requirement that the USER say
 * a phrase Siri already knows. Siri only has to recognise "tell my Mac ...";
 * everything after that is free text, and the MODEL on the Mac decides which
 * verb it meant.
 *
 * Why the mapping runs on the Mac and not the phone: the phone has no idea what
 * verbs exist. Keeping VERBS here means adding a capability is one entry in one
 * file -- no iOS rebuild, no App Store review, no Siri phrase to re-teach. That
 * is the whole reason this file exists rather than ten more AppShortcuts.
 *
 * Why a model and not a keyword match: "kill the chatgpt call", "shut the voice
 * thing up", "end it" are all stopChatGptVoice, and no keyword list survives
 * contact with how people actually talk. The model gets a closed list and must
 * answer with one of its names or `unknown` -- it never invents a verb, because
 * the answer is looked up in VERBS and an unrecognised string fails closed.
 */
import { randomUUID } from 'crypto'
import { context } from './platform'
import { devLog } from '../shared/env'
import { askMac } from './mac-answer'
import { setSystemVolume, getSystemVolume } from './platform/macos/system-volume'
import { proposeActions, runProposal, expireProposals } from './actions/engine'
import {
  startChatGptVoice,
  stopChatGptVoice,
  screenAnswer,
  type IntentActionResult,
  type RoutedActionMeta
} from './intent-actions'

/**
 * Every verb the router can reach, with the sentence that teaches the model
 * when to pick it. `when` is prompt text, not documentation -- it is pasted
 * into the classifier prompt verbatim, so it is written for a model to read.
 *
 * `arg` is the one free-text slot a verb may take. Verbs without it get
 * nothing, which keeps the model's job to "name a verb" in almost every case.
 */
export interface Verb {
  when: string
  arg?: string
  run: (arg: string) => Promise<IntentActionResult>
}

/** Volume arrives as words ("way up", "half") as often as numbers, so the model
 *  is asked for a 0-100 integer and anything unreadable falls back to a middle
 *  setting rather than failing the whole request. */
function volumeFrom(arg: string): number {
  const n = Number(arg.trim())
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 50
}

/** A verb that presses nothing and has no press to describe. The router
 *  overwrites `meta` with the routing account before this leaves the file, so
 *  these placeholder fields never reach a caller. */
function ok(spoken: string): IntentActionResult {
  return { ok: true, spoken, meta: BLANK_META }
}

const BLANK_META: RoutedActionMeta = {
  action: 'say',
  kind: 'routed',
  said: '',
  verb: '',
  routeMs: 0,
  ms: 0
}

export const VERBS: Record<string, Verb> = {
  startChatGptVoice: {
    when: 'start, open or begin ChatGPT voice mode / voice chat / a call with ChatGPT',
    run: () => startChatGptVoice()
  },
  stopChatGptVoice: {
    when: 'stop, end, close, hang up or kill ChatGPT voice mode',
    run: () => stopChatGptVoice()
  },
  screen: {
    when: "read, look at, describe or answer a question about what is on the Mac's screen",
    arg: 'the question the user asked about the screen, reworded as a direct question',
    run: (arg) => screenAnswer(arg || undefined)
  },
  openApp: {
    when: 'open, launch, switch to or bring up a named Mac application',
    arg: "the app's name exactly as a user would say it, e.g. Safari, Spotify, Slack",
    run: async (arg) => {
      const bundleId = await resolveBundleId(arg)
      if (!bundleId) return { ok: false, reason: 'named-app-missing' }
      const fronted = context.activateApp(bundleId)
      const { spawnSync } = await import('child_process')
      // `open -b` even when already fronted: it launches a closed app AND gives a running app with no window a window.
      const r = spawnSync('open', ['-b', bundleId], { timeout: 5000, encoding: 'utf8' })
      return fronted || r.status === 0
        ? ok(`Opened ${arg} on your Mac.`)
        : { ok: false, reason: 'named-app-missing' }
    }
  },
  setVolume: {
    when: 'change, raise, lower or mute the Mac volume',
    arg: 'the target volume as an integer 0-100 (mute is 0, "all the way up" is 100)',
    run: async (arg) => {
      const volume = volumeFrom(arg)
      await setSystemVolume(volume)
      // Read back rather than echo the request: some outputs (AirPlay, a DAC)
      // ignore the set, and reporting the number we asked for would be a lie.
      const now = getSystemVolume()
      return ok(volume === 0 ? 'Muted your Mac.' : `Volume is at ${now?.volume ?? volume}.`)
    }
  },
  sleep: {
    when: 'sleep, lock or put the Mac to sleep',
    run: async () => {
      // `sleep` on the Mac has no undo and no confirmation, so it is the one
      // verb where a misheard sentence costs the user real work. The model is
      // told to prefer unknown when unsure (see PROMPT) rather than guess here.
      const { spawnSync } = await import('child_process')
      const r = spawnSync('osascript', ['-e', 'tell application "System Events" to sleep'], {
        timeout: 3000,
        encoding: 'utf8'
      })
      return r.status === 0 ? ok('Putting your Mac to sleep.') : { ok: false, reason: 'failed' }
    }
  }
}

/** Resolve a spoken app name to a bundle id via Launch Services. Spoken names
 *  are not bundle ids and never will be, so this is the seam that makes
 *  "open Spotify" work without a hardcoded table of every Mac app. */
async function resolveBundleId(name: string): Promise<string | null> {
  const { spawnSync } = await import('child_process')
  const r = spawnSync(
    'osascript',
    ['-e', `id of application "${name.replace(/"/g, '')}"`],
    { timeout: 3000, encoding: 'utf8' }
  )
  if (r.status !== 0) return null
  const id = r.stdout.trim()
  return id === '' ? null : id
}

/** The classifier's whole world. Built from VERBS so a new verb is taught to
 *  the model by the same line that implements it -- the drift that would make
 *  a verb unreachable is impossible. */
function verbMenu(): string {
  return Object.entries(VERBS)
    .map(([name, v]) => `- ${name}: ${v.when}${v.arg ? ` | arg = ${v.arg}` : ' | no arg'}`)
    .join('\n')
}

const PROMPT = `You map one spoken request to one command for a Mac.

Commands:
{{MENU}}

Answer with ONLY a JSON object: {"verb":"<name>","arg":"<text or empty>"}
Use the exact verb name from the list. If the request does not clearly match
one of them, answer {"verb":"unknown","arg":""}. Never invent a verb name.
Prefer unknown over a guess -- a wrong command does something the user did not
ask for, which is worse than saying you did not understand.`

/**
 * Measured 2026-09-15 across 11 spoken phrasings, not guessed: 12.5s, 12.7s,
 * 12.8s, 13.6s, 13.6s, 13.8s, 15.4s, 16.4s, 16.4s, 18.8s, 21.8s. Median 13.6s,
 * slowest 21.8s. The first value here was 12000, which would have killed four
 * of those eleven -- every one of which had classified CORRECTLY and was about
 * to run the right verb.
 *
 * 28s clears the slowest measured run with room for a bad day. It is generous
 * on purpose: this sits in front of the real work, so the cost of being wrong
 * is asymmetric -- a slow answer is an answer, a premature timeout throws away
 * a correct classification and speaks a failure.
 *
 * The number to attack is the 12.5s FLOOR, which is the cold `claude` spawn
 * (14.4s measured in intent-actions.ts), not the thinking. Warm-session resume
 * is what moves it; lower this ceiling when a resumed run has been measured,
 * not before.
 */
const ROUTE_TIMEOUT_MS = 28000

export interface RoutedIntent {
  verb: string
  arg: string
}

/** Pull the JSON out of whatever the model wrapped it in. A CLI backend likes
 *  to add a sentence or a ```json fence, and failing the whole request over
 *  formatting would make the router look broken when the classification was
 *  right. */
function parseRoute(raw: string): RoutedIntent {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { verb: 'unknown', arg: '' }
  try {
    const parsed = JSON.parse(match[0]) as { verb?: unknown; arg?: unknown }
    return {
      verb: typeof parsed.verb === 'string' ? parsed.verb : 'unknown',
      arg: typeof parsed.arg === 'string' ? parsed.arg : ''
    }
  } catch {
    return { verb: 'unknown', arg: '' }
  }
}

/**
 * Classify one sentence, then run what it named.
 *
 * Fails closed at two points: the model can only answer with a name from the
 * menu, and the answer is looked up with hasOwnProperty in VERBS. A model that
 * hallucinates a verb, or a prompt-injected screen that tries to name one, both
 * land on the same 'unknown-action' as a typo would.
 */
export async function routeSpokenIntent(text: string): Promise<IntentActionResult> {
  const started = Date.now()
  const said = text.trim()
  let routeMs = 0
  const account = (verb: string, result: IntentActionResult): IntentActionResult => {
    const meta: RoutedActionMeta = {
      action: 'say',
      kind: 'routed',
      said,
      verb,
      routeMs,
      ms: Date.now() - started
    }
    devLog.log(
      `intent-router ${JSON.stringify({ at: new Date().toISOString(), ...meta, ok: result.ok })}`
    )
    return { ...result, meta }
  }

  if (said === '') return account('empty', { ok: false, reason: 'unknown-action' })

  const runId = randomUUID()
  const card = await proposeActions(runId, 'phone', said)
  const top = card?.proposals[0]
  if (top?.preselected) {
    routeMs = Date.now() - started
    const result = await runProposal(runId, top.proposalId)
    return account(top.actionId, result.ok ? ok(result.line) : { ok: false, reason: 'failed' })
  }
  // The phone has no card to pick from, so anything short of preselected falls
  // through to the classifier and the proposals would sit in the pending map forever.
  if (card) expireProposals(runId)

  let route: RoutedIntent
  try {
    const raw = await askMac(said, {
      systemPrompt: PROMPT.replace('{{MENU}}', verbMenu()),
      fast: true,
      timeoutMs: ROUTE_TIMEOUT_MS
    })
    routeMs = Date.now() - started
    route = parseRoute(raw)
  } catch (err) {
    routeMs = Date.now() - started
    devLog.warn('[intent-router] classify failed:', (err as Error).message)
    return account('classify-failed', { ok: false, reason: 'model-failed' })
  }

  const verb = Object.prototype.hasOwnProperty.call(VERBS, route.verb)
    ? VERBS[route.verb]
    : undefined
  if (!verb) return account(route.verb, { ok: false, reason: 'unknown-action' })

  return account(route.verb, await verb.run(route.arg))
}
