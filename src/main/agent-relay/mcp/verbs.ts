/**
 * One entry per MCP tool. build-server.ts registers VERB_HANDLERS
 * generically, so adding a verb never touches the transport.
 *
 * Every handler builds its MCP response from the SAME `response` shape
 * `relayRequestStore.resolve()` produces -- that is what makes a phone answer
 * and a HUD answer indistinguishable to the agent, and it is where the
 * store's first-answer-wins guarantee reaches the caller.
 */

import { z } from 'zod'
import { searchPhotos, requestPhotoAccess, fetchPhoto } from '../photo-search'
import { existsSync } from 'fs'
import {
  relayRequestStore,
  onRelayDelivered,
  RELAY_SHOW_TIMEOUT_MS,
  RELAY_NOTIFY_STATES,
  type RelayRequest,
  type RelayVerb,
  type RelayNotifyState
} from '../store'
import { sendRelayPush, agentRelayOffReason } from '../relay-send'
import { annotate, type MarkInput } from '../annotate'
import { captureScreenshot } from '../../platform'
import {
  setAgentSessionTldr,
  setAgentSessionAffects,
  setAgentSessionBusy,
  resolveSessionId,
  listedAgentSessions,
  type AgentOrigin
} from './http-listener'
import { markSessionTldrDeclared, persistSessionTldr, TLDR_MAX } from './session-tldr-file'
import { CONFIG } from '../../../shared/config'
import { AFFECTS_MAX, affectNames, unknownAffects } from '../../../shared/surfaces'
import { INFRA_RECORD_PATH } from '../../../shared/infra'
import { affectsRecordAbove } from '../../infra/scan'
import { startSessionWrap, canWrapUp } from '../session-control'
import { relaySnapshot } from '../wire'
import { buildDeck, actionsFor } from '../../../shared/swipe-triage'
import type { AgentRelaySessionInfo } from '../../../shared/types'
import {
  DECISION_ANGLES,
  YOU_USUALLY_MIN_DECISIONS,
  decisionInputError,
  learnYourWeights,
  scoreDecision,
  totalsFor,
  type DecisionWire
} from '../../../shared/decision-score'

export interface VerbToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** One entry per RelayVerb. `inputSchema` is zod-raw-shape (MCP SDK's
 *  registerTool wants an object of field->ZodType, not a compiled schema).
 *  `run` takes the validated args and returns the MCP tool result. */
export interface VerbHandler<Args extends z.ZodRawShape> {
  description: string
  inputSchema: Args
  /** `cwd`/`origin` are not part of any verb's schema -- the listener attaches
   *  them from the shim's headers (audit-log attribution and the HUD's "go to
   *  session" button, respectively), so both are typed here rather than
   *  declared as agent-supplied input. */
  run: (
    args: z.infer<z.ZodObject<Args>> & {
      cwd?: string
      origin?: AgentOrigin
      /** Attached the same way, for the verbs that address a session rather than
       *  mint a card. Absent for a shim too old to send the header. */
      sessionId?: string
    }
  ) => Promise<VerbToolResult>
}

function textResult(text: string, isError = false): VerbToolResult {
  return { content: [{ type: 'text', text }], isError }
}

/** One sentence appended to every tool description. The description IS the
 *  mechanism -- an agent supplies `from` only if the tool asks it to, and an
 *  unlabelled card is indistinguishable from another agent's on the phone. */
const FROM_HINT =
  ' Always pass `from` with your session name and repo (e.g. "mm-dev-298 - ShowAndTell/dev") ' +
  'so the card says who is asking.'

/** Appended to every verb that takes free text. Same mechanism as FROM_HINT:
 *  the description is the only lever on what an agent actually sends, and what
 *  arrived was terminal prose -- markdown, jargon, a paragraph. sanitizeBody
 *  strips the markup after the fact, but nothing downstream can turn a wall of
 *  text into something worth reading. That has to be asked for here, at the one
 *  point the agent is still writing.
 *
 *  Asks for a shape, NOT a word count. The old "one sentence, ~20 words" cap was
 *  written for the iOS lock screen's three lines; the same string is also the
 *  whole turn in the phone's session thread, where a truncated reason is worse
 *  than a long one. Lead-with-the-answer survives truncation on the card and
 *  still reads as a reply in the thread. */
const PHONE_COPY_HINT =
  ' Write it for a phone, not a terminal: plain words, no markdown, no jargon, the way you ' +
  'would text a friend. "Tests pass, safe to ship" beats "vitest exited 0 across 42 suites". ' +
  'LEAD WITH THE ANSWER, then only the context that changes what they would do. Let the ' +
  'length match what was asked: a yes/no gets a few words, a "why is it broken" gets the ' +
  'couple of sentences it actually takes. Never pad to sound thorough, never truncate a ' +
  'reason they need. Markup is stripped and newlines are collapsed, so carry structure in ' +
  'the sentences themselves rather than in bullets or code ticks.'

/** Derived, not supplied: picking one of four states is a choice an agent gets
 *  right, where wording a status line is one it eventually gets wrong.
 *
 *  The glyph LEADS here, where the level marker trails (see the NSE's notify
 *  branch), so the two never collide and a notify can carry both.
 *
 *  ❓ is reserved for `ask` and appears on NO state below, which is the whole
 *  point of the set: a notify resolves the instant it is minted (store.ts), so
 *  none of these can be answered, and "Waiting on You" over a card with no
 *  reply button read exactly like the one verb that does have them. The glyph
 *  is what separates them on a lock screen, where `ask` says "Your Agent Needs
 *  You" one line away and the words alone were doing all the work. */
const STATE_TITLE: Record<RelayNotifyState, string> = {
  done: '✅ All Done',
  progress: '⏳ Still Working'
}

/** Says how to CHOOSE a state, and -- the load-bearing half -- when the answer
 *  is a different verb entirely. Both deleted states ('waiting', then 'blocked')
 *  were agents reaching for notify to say "I need you", so the hint names the
 *  verbs that actually wait rather than only listing what is left. */
const STATE_HINT =
  ' Set `state` to what is true right now: "done" (finished, nothing needed) or "progress" ' +
  '(long job, still running). Those are the only two, because a notify is delivered and closed ' +
  'the moment you send it -- nothing they tap can reach you, so no notify can ever say someone ' +
  'is needed. If you are stuck until they act, notify is the WRONG verb: use `approve` to ask ' +
  'permission to do something, or `ask` for an answer. Both wait for a real reply and render ' +
  'buttons that unblock you; a notify would just print a demand they cannot answer.' +
  ' With "progress", also pass `progress` (0-1) whenever you can count what is done -- the ' +
  'state says you are still working, the number says how far.'

/** The whole feature. IMAGE_HINT described the FIELDS and got an image attached
 *  0 times in 1,598 cards; rewritten to name the TRIGGER it worked immediately.
 *  So this names the trigger, and -- the half an agent gets wrong -- says how to
 *  derive the number, with a blessed way to opt out so the field is not filled
 *  with fiction. `state: 'progress'` has carried no magnitude since it shipped:
 *  1 card in 3,744 used it, while 242 hand-encoded "3 of 7" into prose where
 *  nothing could read it. */
const PROGRESS_HINT =
  ' When you are part-way through a job with more than one step, pass `progress`: a number ' +
  'from 0 to 1 for how much of the WHOLE job is finished. Derive it from the work you can ' +
  'actually see -- steps done over steps you have identified, files migrated over files found, ' +
  'tests passing over tests written. Say the denominator in `body` ("3 of 7 files") so the ' +
  'number is checkable. If you genuinely cannot count anything, leave it out: a made-up number ' +
  'is worse than none, because it will be drawn as a bar someone plans their day around. ' +
  'Never send a number that goes DOWN unless you say why in the body -- you found more work.'

/** Shared by notify/ask/approve. Out of range is DROPPED by the handler, never
 *  an error: nothing about a progress bar makes a question unanswerable, so
 *  failing an `ask` over a bad float would be strictly worse than showing the
 *  question without the bar. */
const progressField = z.number().min(0).max(1).optional()

/** Range and shape live in the schema; this says what the number MEANS, which
 *  zod cannot. 1.0 is deliberately not "done" -- `state` owns that. */
const PROGRESS_FIELD_DESC =
  'How far through the whole job, 0-1. Not a synonym for finished: 1.0 with more to verify is ' +
  'legitimate, and `state` is what says done.'

/** An idle ping is the one notify with no news of its own, so agents wrote the
 *  only thing left -- a bare "tell me what's next", which on a lock screen says
 *  neither which session woke up nor what it just did. `last` is asked for here
 *  because this description is the only lever on what an agent sends. */
const IDLE_LAST_HINT =
  ' When you send `idle: true` (you have finished and are waiting on them), ALSO pass `last`: ' +
  'one plain sentence saying what you just did, so the banner can remind them where you left ' +
  'off. "Fixed the login redirect, tests green" beats an empty prompt for the next instruction.'

/** Shared across all four verbs. 60 chars is what fits the phone card's chip on
 *  one line; longer names are the agent's to shorten, not ours to ellipsize. */
const fromField = z.string().max(60).optional()

/** Shared across all four verbs. Marks a rehearsal so every surface can say so
 *  -- a drill's own words ("drop the prod table") read exactly like a real one. */
const testField = z.boolean().optional()

/** Anything off the MCP socket is attacker-controllable (any local process can
 *  reach loopback), and this string is rendered on a card -- so newlines, which
 *  would let one sender's label impersonate a second line of the card, are
 *  flattened here rather than at the render site. */
export function sanitizeFrom(from: string | undefined): string | undefined {
  if (from === undefined) return undefined
  const flat = from.replace(/\s+/g, ' ').trim().slice(0, 60)
  return flat === '' ? undefined : flat
}

/** `from` is the join key EVERY surface filters on -- the phone thread keeps a
 *  card only when `senderMatchKey(from)` matches `stated ?? label`
 *  (SessionList.tsx:430, agent-face.ts:72). An agent that omits `--from` minted
 *  a card whose key was '', which matches no live session, so the card landed in
 *  no thread at all and the HUD printed "Unknown agent" -- while the verb still
 *  returned "Sent to <device>", because a card reaching the store IS a send.
 *  Five orphaned `show` cards were found that way.
 *
 *  So the omission is answered from `origin`, which the shim attaches itself:
 *  the pane match is the one `mac-notification.ts:212` already types replies
 *  back through, and it yields `stated ?? label` because that is the exact
 *  string the filters compare. An agent with no resolvable origin still gets
 *  undefined -- inventing a name would attribute its card to the wrong thread,
 *  which is worse than an unattributed one. */
function attributeFrom(
  from: string | undefined,
  origin: AgentOrigin | undefined
): string | undefined {
  const stated = sanitizeFrom(from)
  if (stated !== undefined) return stated
  const pane = origin?.tmuxPane
  if (!pane) return undefined
  const session = listedAgentSessions().find((s) => s.origin?.tmuxPane === pane)
  return session ? sanitizeFrom(session.stated ?? session.label) : undefined
}

/** Agents write in markdown because that is what a terminal renders, so bodies
 *  arrived carrying `**bold**`, backticked paths and list bullets -- which a
 *  lock screen shows literally, asterisks and all. Stripped here rather than in
 *  the caller: every agent on every machine passes through this one function,
 *  and asking each one to remember is how half of them keep shipping asterisks.
 *
 *  Markup only. The words are the sender's, and rewriting those would be this
 *  function inventing content it was never given. Em-dashes go because the
 *  house voice bans them outright (docs/brand-voice.md). */
export function sanitizeBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined
  const flat = body
    .replace(/```[a-zA-Z]*/g, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]+/gm, '')
    // Bullets only at a line start: a hyphen mid-sentence is a real hyphen.
    .replace(/^[ \t]*[-*•][ \t]+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat === '' ? undefined : flat
}

/** Fail-fast, before minting anything -- §6c: relay off must never leave a
 *  request pending. The string returned here IS what every VERB_HANDLERS
 *  entry should surface verbatim when this returns non-null. */
function relayOffGuard(): VerbToolResult | null {
  const reason = agentRelayOffReason()
  return reason ? textResult(reason, true) : null
}

/** The `image_path` + `capture` pair, shared by every verb that can show a
 *  picture. Declared once so notify/ask/approve/show describe the same thing to
 *  the agent in the same words -- four copies of this hint is how they drift. */
const imagePathField = z.string().min(1).optional()
const captureField = z.boolean().optional()
/** Optional marks drawn ON the picture. A string is the banner shorthand -- the
 *  only mark an agent that has not SEEN the screenshot can place honestly, so
 *  the blind case has somewhere to land that isn't a guessed coordinate. */
const annotateField = z
  .array(
    z.union([
      z.string().min(1).max(120),
      z.object({
        shape: z.enum(['circle', 'box', 'arrow', 'text']),
        at: z.object({ x: z.number(), y: z.number() }),
        size: z.number().optional(),
        from: z.object({ x: z.number(), y: z.number() }).optional(),
        text: z.string().max(120).optional(),
        color: z.enum(['red', 'yellow', 'green', 'blue', 'white']).optional()
      })
    ])
  )
  .max(6)
  .optional()
/** Phrased as an instruction, not an inventory of the two fields: the earlier
 *  wording only said HOW to attach a picture, and 0 of the last 1,598 cards
 *  carried one. An agent reads an optional-sounding extra as skippable, so the
 *  trigger ("did the work change something visual") has to be stated. */
const IMAGE_HINT =
  ' IMAGES: if the thing you are reporting on is visual -- a UI you changed, a page, a chart, ' +
  'a diff, a screen that looks wrong -- attach a picture. Pass `capture: true` to screenshot ' +
  'the Mac right now, or `image_path` for a file already on this Mac. The picture rides along ' +
  'on the same card, so they can SEE it on their phone and decide in one tap instead of ' +
  'reading a description of something you could just show them.' +
  ' MARKING IT UP: `annotate` draws on that picture -- pass a plain string for a big banner ' +
  'across the top (["Build green, 41 tests"]), or {shape:"circle"|"box"|"arrow", at:{x,y}, ' +
  'text, color} where x/y are 0-1 FRACTIONS of the image. Only place a circle/arrow when you ' +
  'already know where the thing is (you wrote that CSS, or you made the image). If you called ' +
  '`capture: true` you have NOT seen this screen -- use the string banner, never a guessed ' +
  'coordinate; an out-of-range mark is dropped, not moved.'

/** Resolves the two image inputs to one path, or an error result the caller
 *  must surface verbatim. Shared by ask/approve/show: the screenshot permission
 *  failure and the missing-file check read identically on every verb, and a
 *  second copy would be a second place for the permission copy to go stale. */
async function resolveImagePath(args: {
  image_path?: string
  capture?: boolean
  annotate?: MarkInput[]
}): Promise<{ path?: string; error?: VerbToolResult }> {
  // Marks are applied at this single choke point, so all four verbs get them
  // from one call site and cannot drift on what a failed annotation means.
  // `annotate` returns the ORIGINAL path on any failure -- the card degrades one
  // step (annotated -> plain picture), never to no picture at all.
  const marked = async (path: string): Promise<string> =>
    args.annotate?.length ? annotate(path, args.annotate) : path
  if (args.capture) {
    const shot = await captureScreenshot()
    if (!shot) {
      return {
        error: textResult(
          'Screenshot failed -- MightyMouse needs Screen Recording permission. Grant it in ' +
            'System Settings > Privacy & Security > Screen Recording, then try again.',
          true
        )
      }
    }
    return { path: await marked(shot) }
  }
  if (args.image_path && !existsSync(args.image_path)) {
    return { error: textResult(`Can't find that file: ${args.image_path}`, true) }
  }
  return { path: args.image_path ? await marked(args.image_path) : undefined }
}

/** Waits for a minted request to leave 'pending', however it resolves (phone
 *  answer, HUD answer, or its own timeout) -- shared by ask/approve/show so
 *  each doesn't reinvent the same listener teardown. */
export function awaitResolution(id: string): Promise<RelayRequest> {
  return new Promise((resolve) => {
    // 'delivered', not 'changed': 'changed' fires on the cosmetic half of a
    // dismiss, handing the agent an answer the human can still take back.
    const off = onRelayDelivered((request) => {
      if (request.id !== id) return
      off()
      resolve(request)
    })
    // Checked AFTER subscribing so a settlement landing between the two is
    // caught by the listener rather than falling through the gap. A dismiss
    // inside its undo window still reads as 'dismissed' here, so it is not
    // treated as settled -- only `undoPending` says whether it is final.
    const existing = relayRequestStore.get(id)
    if (existing && existing.status !== 'pending' && !relayRequestStore.undoPending(id)) {
      off()
      resolve(existing)
    }
  })
}

const notifyHandler: VerbHandler<{
  title: z.ZodOptional<z.ZodString>
  body: z.ZodOptional<z.ZodString>
  state: z.ZodOptional<z.ZodEnum<{ done: 'done'; progress: 'progress' }>>
  progress: typeof progressField
  level: z.ZodOptional<
    z.ZodEnum<{ info: 'info'; success: 'success'; warn: 'warn'; error: 'error' }>
  >
  image_path: typeof imagePathField
  capture: typeof captureField
  annotate: typeof annotateField
  from: typeof fromField
  test: typeof testField
  idle: z.ZodOptional<z.ZodBoolean>
  last: z.ZodOptional<z.ZodString>
}> = {
  description:
    'Tell the user something on their phone. Fire and forget -- use this for status updates ' +
    'like "build finished" or "tests are green". Does not wait for a reply. Put the news in ' +
    '`body` and let `state` write the headline; only pass `title` when the state words it wrong.' +
    STATE_HINT +
    PROGRESS_HINT +
    IMAGE_HINT +
    IDLE_LAST_HINT +
    FROM_HINT +
    PHONE_COPY_HINT,
  inputSchema: {
    // Optional since `state` supplies one; kept as an override so news that IS
    // its own headline ("Deploy #412 live") is not buried under a status word.
    title: z.string().min(1).max(120).optional(),
    body: z.string().max(2000).optional(),
    state: z.enum(RELAY_NOTIFY_STATES).optional(),
    progress: progressField.describe(PROGRESS_FIELD_DESC),
    level: z.enum(['info', 'success', 'warn', 'error']).optional(),
    image_path: imagePathField,
    capture: captureField,
    annotate: annotateField,
    from: fromField,
    test: testField,
    idle: z.boolean().optional(),
    last: z.string().max(200).optional()
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard

    // Resolved here, not at each render site, so the phone, the HUD and the
    // cloud fallback cannot drift apart on what an unstated notify means.
    // A stated `progress` implies the state: a number without one would default
    // to 'done' and print "All Done" over a half-finished bar.
    const state: RelayNotifyState = args.state ?? (args.progress !== undefined ? 'progress' : 'done')
    // A stated title outranks the derived one: news that IS its own headline
    // ("Deploy #412 live") should not be buried under a status word. Suppressing
    // it is no longer this function's job -- the states that let a caller dress a
    // notify up as a demand were deleted at the enum instead (store.ts).
    const stated = args.title === undefined ? undefined : sanitizeBody(args.title) ?? args.title
    // Degrades to a text-only card where ask/approve return the error: those two
    // block on an answer ABOUT the picture, so a missing one makes the question
    // unanswerable. A notify's news stands on its own, and eating the whole
    // notification over a denied screenshot loses the thing the user wanted.
    const image = await resolveImagePath(args)
    const request = relayRequestStore.mint('notify', {
      title: stated ?? STATE_TITLE[state],
      body: sanitizeBody(args.body),
      state,
      progress: args.progress,
      level: args.level,
      imagePath: image.path,
      from: attributeFrom(args.from, args.origin),
      cwd: args.cwd,
      origin: args.origin,
      test: args.test,
      idle: args.idle === true ? true : undefined,
      // Attached by the listener, never agent-supplied. `from` is a NAME, and
      // two unnamed panes in one checkout share it -- so one agent's idle ping
      // marked both rows "Handed back". This is the unambiguous half of that
      // join; absent for a shim too old to send the header.
      sessionId: args.sessionId,
      last: sanitizeBody(args.last)
    })
    const sent = await sendRelayPush(request)
    if (!sent.ok) {
      // §6c: the send failing does not fail the tool call -- the request
      // already lives in the store (HUD/Code sheet still show it), so the
      // agent gets a soft warning, not a hard error, and keeps going.
      return textResult(`Saved, but the push didn't go out: ${sent.detail}`)
    }
    // Stated, not swallowed: the card went out text-only and the agent believes
    // a picture is on it. Silence here is how "why is there no image" becomes
    // unanswerable from the phone.
    const missed = args.image_path || args.capture ? !image.path : false
    return textResult(
      missed
        ? `Sent to ${sent.deviceLabel}, but WITHOUT the picture -- the screenshot or file ` +
            'failed, so the card is text only.'
        : `Sent to ${sent.deviceLabel}.`
    )
  }
}

/** A follow-up question on the SAME card. Sent whole up front rather than one
 *  call per question: the hook fires once per AskUserQuestion and there is no
 *  second event between Q1 and Q2 to mint anything on (PRD §3). */
const questionsField = z
  .array(
    z.object({
      question: z.string().min(1).max(2000),
      options: z.array(z.string().min(1).max(80)).max(4).optional(),
      multi_select: z.boolean().optional()
    })
  )
  .min(1)
  .max(8)
  .optional()

const angleNumbers = z.object(Object.fromEntries(DECISION_ANGLES.map((a) => [a, z.number().min(0).max(100)])) as Record<(typeof DECISION_ANGLES)[number], z.ZodNumber>)
const weightsField = angleNumbers.partial().optional()
const scoresField = z.array(z.array(z.number().min(0).max(100))).max(4).optional()
const notesField = z.object(Object.fromEntries(DECISION_ANGLES.map((a) => [a, z.string().max(120)])) as Record<(typeof DECISION_ANGLES)[number], z.ZodString>).partial().optional()

const DECISION_HINT =
  ' When you are asking them to choose between approaches, boil it down to 3 options and ALSO send ' +
  '`weights` and `scores` so the card can show how sure you are. `weights`: how much each of five ' +
  'things matters for THIS decision, integers that add up to 100 - fast (done soon), cheap (costs ' +
  'nothing extra), undo (easy to walk back), lasts (right way long term), handsoff (little of their ' +
  'time). `scores`: one row per option, same order as `options`, five numbers 0-100 in the order ' +
  'fast, cheap, undo, lasts, handsoff. Optional `notes`: a few words per thing on why it matters ' +
  'here. `context`: one line of what they need to know, up to 300 characters.'

function buildDecision(
  args: { weights?: Partial<Record<string, number>>; scores?: number[][]; notes?: DecisionWire['notes']; test?: boolean; test_you_usually?: number },
  options: string[] | undefined,
  multiQuestion: boolean
): { decision?: DecisionWire; error?: string } {
  if (!args.weights && !args.scores) return {}
  if (!args.weights || !args.scores) return { error: 'Send `weights` and `scores` together, or neither.' }
  if (multiQuestion) return { error: '`weights` and `scores` only work on a single question. Drop `questions` or drop the scores.' }
  const error = decisionInputError(options?.length ?? 0, args.weights, args.scores)
  if (error) return { error }
  const weights = args.weights as DecisionWire['weights']
  const decision: DecisionWire = { weights, scores: args.scores, notes: args.notes, ...scoreDecision(weights, args.scores) }
  const picks = relayRequestStore.recentScoredPicks()
  if (picks.length >= YOU_USUALLY_MIN_DECISIONS) {
    decision.history = { agreed: picks.filter((p) => p.picked === p.best).length, of: picks.length }
    decision.youWeights = learnYourWeights(picks)
    const yours = totalsFor(decision.youWeights, args.scores)
    decision.youIdx = yours.indexOf(Math.max(...yours))
  }
  const forced = args.test ? args.test_you_usually : undefined
  if (forced !== undefined) decision.youIdx = forced >= 0 && forced < args.scores.length ? forced : undefined
  return { decision }
}

const askHandler: VerbHandler<{
  question: z.ZodString
  options: z.ZodOptional<z.ZodArray<z.ZodString>>
  questions: typeof questionsField
  progress: typeof progressField
  image_path: typeof imagePathField
  capture: typeof captureField
  annotate: typeof annotateField
  timeout_s: z.ZodOptional<z.ZodNumber>
  from: typeof fromField
  test: typeof testField
  context: z.ZodOptional<z.ZodString>
  weights: typeof weightsField
  scores: typeof scoresField
  notes: typeof notesField
  test_you_usually: z.ZodOptional<z.ZodNumber>
}> = {
  description:
    'Ask the user a question on their phone and wait for a reply. Use this when you need them ' +
    'to decide something, like which library to use or what to name a table. ALWAYS supply ' +
    '`options` (2-4 short choices) unless the answer is genuinely open-ended: their phone then ' +
    'shows tappable buttons, so answering is one tap instead of typing on a phone keyboard. ' +
    'Typing a free-text reply stays available behind a button either way.' +
    DECISION_HINT +
    PROGRESS_HINT +
    IMAGE_HINT +
    FROM_HINT +
    PHONE_COPY_HINT,
  inputSchema: {
    question: z.string().min(1).max(2000),
    // 4, not 8: a fifth chip wraps to a second row and pushes the reply button
    // under the fold on a phone.
    options: z.array(z.string().min(1).max(80)).max(4).optional(),
    questions: questionsField,
    progress: progressField.describe(PROGRESS_FIELD_DESC),
    image_path: imagePathField,
    capture: captureField,
    annotate: annotateField,
    timeout_s: z.number().int().positive().max(86_400).optional(),
    from: fromField,
    test: testField,
    context: z.string().max(300).optional(),
    weights: weightsField,
    scores: scoresField,
    notes: notesField,
    test_you_usually: z.number().int().min(-1).max(3).optional()
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard

    const scored = buildDecision(args, args.questions?.[0].options ?? args.options, (args.questions?.length ?? 0) > 1)
    if (scored.error) return textResult(scored.error, true)

    const image = await resolveImagePath(args)
    if (image.error) return image.error

    // `question`/`options` keep carrying question 0 even in an interview: every
    // surface that predates this (push body, notification, resolved tail) reads
    // those two fields and must not have to learn the array.
    const questions = args.questions?.map((q) => ({
      question: sanitizeBody(q.question) ?? q.question,
      options: q.options,
      multiSelect: q.multi_select
    }))

    const request = relayRequestStore.mint(
      'ask',
      {
        question: questions?.[0].question ?? sanitizeBody(args.question) ?? args.question,
        options: questions?.[0].options ?? args.options,
        questions: questions && questions.length > 1 ? questions : undefined,
        context: sanitizeBody(args.context),
        decision: scored.decision,
        progress: args.progress,
        imagePath: image.path,
        from: attributeFrom(args.from, args.origin),
        cwd: args.cwd,
        origin: args.origin,
        test: args.test
      },
      args.timeout_s ? args.timeout_s * 1_000 : undefined
    )
    const sent = await sendRelayPush(request)
    if (!sent.ok) {
      // Same §6c posture as notify: the request already lives in the store
      // (HUD/Code sheet can still answer it), so a failed push is a soft
      // warning, not a reason to skip waiting for the answer.
      console.error('[agent-relay] ask push failed', sent.detail)
    }

    const resolved = await awaitResolution(request.id)
    if (resolved.status === 'timedout') {
      return textResult(`Timed out waiting for an answer after ${resolved.timeoutMs / 1000}s.`, true)
    }
    // A dismiss is a decision, not silence -- say so plainly, so the agent
    // doesn't retry the way it reasonably might after a timeout.
    if (resolved.status === 'dismissed') {
      return textResult('Dismissed without an answer. Do not ask this again — pick a default or stop.', true)
    }
    // An interview returns EVERY answer: `answer` alone is question 0's, so a
    // caller reading only that would silently lose questions 2..N. Ordered by
    // question index, which is the order the agent asked them in.
    const all = resolved.buffered
    if (all.length > 1) {
      return textResult(
        JSON.stringify({
          answer: resolved.response?.answer ?? '',
          answers: [...all].sort((a, b) => a.index - b.index).map((a) => a.answer),
          via: resolved.resolvedVia
        })
      )
    }
    return textResult(
      JSON.stringify({ answer: resolved.response?.answer ?? '', via: resolved.resolvedVia })
    )
  }
}

const approveHandler: VerbHandler<{
  action: z.ZodString
  detail: z.ZodOptional<z.ZodString>
  risk: z.ZodOptional<z.ZodEnum<{ low: 'low'; high: 'high' }>>
  progress: typeof progressField
  image_path: typeof imagePathField
  capture: typeof captureField
  annotate: typeof annotateField
  timeout_s: z.ZodOptional<z.ZodNumber>
  from: typeof fromField
  test: typeof testField
}> = {
  description:
    'Ask the user to approve or deny something before you do it -- a migration, a deploy, ' +
    'spending money, or any destructive operation. Set risk to "high" for anything hard to ' +
    'undo; their ' +
    'phone requires an unlock to tap Approve on those. Blocks until they answer or it times ' +
    'out. A timeout is NEVER treated as approval -- it comes back denied. Neither is a ' +
    'dismissal: if they clear the card it returns approved:false with reason:"dismissed".' +
    PROGRESS_HINT +
    IMAGE_HINT +
    FROM_HINT +
    PHONE_COPY_HINT,
  inputSchema: {
    action: z.string().min(1).max(200),
    detail: z.string().max(2000).optional(),
    risk: z.enum(['low', 'high']).optional(),
    progress: progressField.describe(PROGRESS_FIELD_DESC),
    image_path: imagePathField,
    capture: captureField,
    annotate: annotateField,
    timeout_s: z.number().int().positive().max(86_400).optional(),
    from: fromField,
    test: testField
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard

    const image = await resolveImagePath(args)
    if (image.error) return image.error

    const request = relayRequestStore.mint(
      'approve',
      {
        action: sanitizeBody(args.action) ?? args.action,
        detail: sanitizeBody(args.detail),
        risk: args.risk ?? 'low',
        progress: args.progress,
        imagePath: image.path,
        from: attributeFrom(args.from, args.origin),
        cwd: args.cwd,
        origin: args.origin,
        test: args.test
      },
      args.timeout_s ? args.timeout_s * 1_000 : undefined
    )
    const sent = await sendRelayPush(request)
    if (!sent.ok) {
      console.error('[agent-relay] approve push failed', sent.detail)
    }

    const resolved = await awaitResolution(request.id)
    // The store itself never sets approved:true on timeout (RELAY_VERBS
    // 'approve' branch in timeout()) -- this handler trusts that rather than
    // re-deriving it, so there is exactly one place the hard rule can break.
    return textResult(
      JSON.stringify({
        approved: resolved.response?.approved ?? false,
        note: resolved.response?.note,
        reason: resolved.response?.reason
      })
    )
  }
}

const showHandler: VerbHandler<{
  image_path: z.ZodOptional<z.ZodString>
  capture: z.ZodOptional<z.ZodBoolean>
  annotate: typeof annotateField
  caption: z.ZodOptional<z.ZodString>
  wait_for_ack: z.ZodOptional<z.ZodBoolean>
  from: typeof fromField
  test: typeof testField
}> = {
  description:
    'Push an image to the user\'s phone -- a diff, a screenshot, what a page looks like now. ' +
    'Pass either `image_path` (a file already on this Mac) or `capture: true` to screenshot ' +
    'the Mac right now. Set `wait_for_ack` to block until they have seen it.' +
    IMAGE_HINT +
    FROM_HINT +
    PHONE_COPY_HINT,
  inputSchema: {
    image_path: z.string().min(1).optional(),
    capture: z.boolean().optional(),
    annotate: annotateField,
    caption: z.string().max(500).optional(),
    wait_for_ack: z.boolean().optional(),
    from: fromField,
    test: testField
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard

    // `show` is the one verb where the image IS the message, so an absent one
    // is an error here and merely optional on ask/approve.
    if (!args.image_path && !args.capture) {
      return textResult('show needs either image_path or capture: true.', true)
    }

    const image = await resolveImagePath(args)
    if (image.error) return image.error
    const imagePath = image.path

    const request = relayRequestStore.mint(
      'show',
      {
        imagePath,
        caption: sanitizeBody(args.caption),
        waitForAck: args.wait_for_ack,
        from: attributeFrom(args.from, args.origin),
        cwd: args.cwd,
        origin: args.origin,
        test: args.test
      },
      args.wait_for_ack ? undefined : RELAY_SHOW_TIMEOUT_MS
    )
    const sent = await sendRelayPush(request)
    if (!sent.ok) {
      console.error('[agent-relay] show push failed', sent.detail)
    }

    if (!args.wait_for_ack) {
      return textResult(`Sent to ${sent.ok ? sent.deviceLabel : 'the phone'}.`)
    }

    const resolved = await awaitResolution(request.id)
    if (resolved.status === 'timedout') {
      return textResult('Timed out waiting for an ack.', true)
    }
    if (resolved.status === 'dismissed') {
      return textResult('Dismissed without an ack.', true)
    }
    return textResult(JSON.stringify({ acked: resolved.response?.acked ?? false }))
  }
}

/** Read + resolve the pending queue from the same MCP surface the verbs use.
 *  These are NOT PRD §6 verbs -- an agent never calls them. They exist so a
 *  terminal (bin/mm-relay) is a first-class answering surface alongside the
 *  phone and the HUD, sharing the store's first-answer-wins path rather than
 *  reaching into the store behind it. Registered as tools because the loopback
 *  MCP port is the only door into the running Electron main process. */
const pendingHandler: VerbHandler<Record<string, never>> = {
  description:
    'List the relay requests still waiting on a human, newest first. Intended for local ' +
    'tooling, not for agents -- an agent gets its answer as the return value of ask/approve.',
  inputSchema: {},
  async run() {
    return textResult(
      JSON.stringify(
        relayRequestStore.listPending().map((r) => ({
          id: r.id,
          verb: r.verb,
          params: r.params,
          createdAt: r.createdAt,
          timeoutMs: r.timeoutMs
        }))
      )
    )
  }
}

/** The triage deck exactly as the phone computes it. Runs the real `buildDeck`
 *  over the real snapshot rather than re-deriving the rule here: a second copy
 *  of "which sessions earn a card" is how a CLI ends up disagreeing with the
 *  glass, and the empty-deck bug this was written for was invisible precisely
 *  because nothing could print the deck without a phone in hand. */
const deckHandler: VerbHandler<Record<string, never>> = {
  description:
    'List the swipe-triage deck the phone would show, newest-decidable first. Local tooling ' +
    'only -- this is a read of what the deck contains, and answers nothing.',
  inputSchema: {},
  async run() {
    const snapshot = relaySnapshot()
    // Mapped here rather than reused from ipc/agent-relay's currentStatus():
    // that module imports BrowserWindow, and pulling Electron in through a verb
    // breaks every MCP test that runs in plain node.
    const sessions: AgentRelaySessionInfo[] = listedAgentSessions().map((s) => ({
      label: s.label,
      stated: s.stated,
      stale: s.staleSince !== undefined,
      staleSince: s.staleSince,
      cwd: s.cwd,
      since: s.since,
      pid: s.facts?.pid,
      agent: s.facts?.agent,
      effort: s.facts?.effort,
      model: s.facts?.model,
      entrypoint: s.facts?.entrypoint,
      sessionId: s.sessionId,
      origin: s.origin,
      busySince: s.busySince,
      lastActivityAt: s.lastActivityAt,
      tldr: s.tldr,
      // Resolved, not omitted: actionsFor gates "Wrap up" on it, so leaving it
      // undefined makes the CLI report fewer options than the phone shows.
      canWrapUp: canWrapUp(s)
    }))
    const cards = buildDeck(sessions, [...snapshot.pending, ...snapshot.resolved], Date.now())
    return textResult(
      JSON.stringify({
        sessions: sessions.length,
        pending: snapshot.pending.length,
        resolved: snapshot.resolved.length,
        cards: cards.map((c) => ({
          label: c.label,
          pending: c.pending?.id,
          subject: c.subject,
          model: c.row.model,
          total: c.activity.total,
          waiting: c.activity.waiting,
          lastSummary: c.activity.lastSummary,
          // Explicit because this block hand-picks fields: every surface draws
          // the ring off the same `session.progress`, so omitting it here would
          // make the CLI the one surface that cannot see how far along an agent
          // is.
          progress: c.session.progress,
          // Through actionsFor, never hand-listed: a card's options are what a
          // right swipe SENDS, so a second derivation here would report buttons
          // the phone does not show.
          actions: actionsFor(c).map((a) => a.label)
        }))
      })
    )
  }
}

const resolveHandler: VerbHandler<{
  requestId: z.ZodString
  answer: z.ZodOptional<z.ZodString>
  approved: z.ZodOptional<z.ZodBoolean>
  note: z.ZodOptional<z.ZodString>
  acked: z.ZodOptional<z.ZodBoolean>
  via: z.ZodOptional<z.ZodEnum<{ chip: 'chip'; typed: 'typed'; screen: 'screen'; note: 'note' }>>
}> = {
  description:
    'Answer a pending relay request from local tooling. Same first-answer-wins path as the ' +
    'phone and the HUD: a request already answered or timed out is reported, never overwritten.',
  inputSchema: {
    requestId: z.string().min(1),
    answer: z.string().max(2000).optional(),
    approved: z.boolean().optional(),
    note: z.string().max(2000).optional(),
    acked: z.boolean().optional(),
    via: z.enum(['chip', 'typed', 'screen', 'note']).optional()
  },
  async run(args) {
    const result = relayRequestStore.resolve(
      args.requestId,
      { answer: args.answer, approved: args.approved, note: args.note, acked: args.acked },
      null,
      args.via ?? 'typed'
    )
    if (result === 'unknown') return textResult(`No request with id ${args.requestId}.`, true)
    if (result === 'already-resolved') {
      return textResult('That request was already answered or timed out.', true)
    }
    return textResult(`Answered ${args.requestId}.`)
  }
}

const dismissHandler: VerbHandler<{ requestId: z.ZodString }> = {
  description:
    'Clear a pending relay request without answering it. Unlike relay_resolve this carries no ' +
    'answer, so nothing downstream types into a terminal -- the card just leaves every surface. ' +
    'For local tooling (hooks) retiring a card the human already handled at the keyboard.',
  inputSchema: { requestId: z.string().min(1) },
  async run(args) {
    const result = relayRequestStore.dismiss(args.requestId, null)
    if (result === 'unknown') return textResult(`No request with id ${args.requestId}.`, true)
    if (result === 'already-resolved') {
      return textResult('That request was already answered or timed out.', true)
    }
    return textResult(`Dismissed ${args.requestId}.`)
  }
}

/**
 * Says what this session is ABOUT. Silent by construction: it mints no card,
 * sends no push, and returns immediately.
 *
 * It is a separate verb rather than a field on notify because a topic change is
 * not news -- routing it through notify would put a card on the lock screen every
 * time an agent changed subject. And it is not `from`: that names the session
 * once and is defended against overwrite (http-listener.nameAgentSession),
 * whereas this is expected to change every time the work does.
 */
const recapHandler: VerbHandler<{
  text: z.ZodString
  generated: z.ZodOptional<z.ZodBoolean>
  affects: z.ZodOptional<z.ZodArray<z.ZodString>>
}> = {
  description:
    'Say in one line what this session is working on, so its row in the session list reads ' +
    '"porting the phone list to the new grouping API" instead of a repo and a branch that ' +
    'every other pane shares. Send this when you START on something materially different, ' +
    'not on every step -- it replaces the previous line rather than adding to it. This is ' +
    'silent: no card, no notification, nothing for them to answer. Plain words, under ~15 ' +
    'words, no markdown: it renders on a phone card. Pass an empty string to clear it.',
  inputSchema: {
    text: z.string().max(TLDR_MAX),
    // Set only by the Stop-hook generator, never by an agent -- which is why it
    // is described as machine-only rather than offered as a choice. It is what
    // keeps the generator from marking its OWN line as hand-declared and then
    // refusing to ever refresh it.
    generated: z
      .boolean()
      .optional()
      .describe('Machine field. Agents must never set this -- leave it out.'),
    affects: z
      .array(z.string().max(60))
      .max(AFFECTS_MAX)
      .optional()
      .describe(
        `The parts of the product and the environments this work changes, named exactly as ${INFRA_RECORD_PATH} ` +
          'lists them under "surfaces" and "environments" (for example ["Portal", "staging"]). It replaces ' +
          'the previous list; an empty list clears it. Leave it out when nothing changed.'
      )
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard
    if (!args.sessionId) {
      return textResult(
        'No session id on this connection, so there is no row to describe. Upgrade the ' +
          'mightymouse-code shim, which is what sends it.',
        true
      )
    }
    // Resolved once, and the FULL id is what gets persisted: a prefix would
    // write the line under a key the shim never asks for on its next connect.
    const full = resolveSessionId(args.sessionId)
    // No match is a wrong id, not an empty relay -- saying "Noted" there sends
    // the caller away believing a row changed. Ambiguity gets its own wording
    // because the fix is different: lengthen the prefix, do not go find the id.
    if (!full) {
      return textResult(
        `No single live session matches "${args.sessionId}" -- either nothing has that id, or ` +
          'it is a prefix shared by several. Use more of the id.',
        true
      )
    }
    if (args.affects) {
      const cwd = listedAgentSessions().find((s) => s.sessionId === full)?.cwd
      const names = affectNames((cwd && (await affectsRecordAbove(cwd))?.record) || {})
      const unknown = unknownAffects(args.affects, names)
      if (unknown.length) {
        return textResult(
          `Not listed for this project: ${unknown.join(', ')}. ` +
            (names.length ? `Use these names: ${names.join(', ')}.` : `${INFRA_RECORD_PATH} lists none yet.`),
          true
        )
      }
      setAgentSessionAffects(full, args.affects)
    }
    setAgentSessionTldr(full, args.text)
    // Written where the shim can read it back, so an app restart -- which drops
    // the in-memory session map by design -- does not silently lose the line.
    persistSessionTldr(full, args.text)
    // A line the agent chose outranks anything the generator would infer from
    // the opening prompt, so claim it. Clearing is not declaring: an empty text
    // removes the line, and marking there would freeze the row blank forever.
    if (!args.generated && args.text.trim()) markSessionTldrDeclared(full)
    return textResult(args.text.trim() ? `Noted: ${args.text.trim()}` : 'Cleared.')
  }
}

/**
 * `busy` -- the mid-turn flag behind the session list's "Responding..." state.
 *
 * Hook-driven, never agent-driven: it is wired to UserPromptSubmit (on) and Stop
 * (off), so it reports what the session IS doing rather than what an agent
 * remembered to declare. That is the whole reason it is not a field on `recap` --
 * an agent that forgets leaves the row lying, and a lying "Responding..." is
 * worse than the honest "Connected" this replaces.
 *
 * Silent by construction: no card, no push, no lock screen. It moves one word on
 * a row that is already on screen.
 */
const busyHandler: VerbHandler<{ busy: z.ZodBoolean }> = {
  description:
    'Machine telemetry, not something to call by hand: the UserPromptSubmit and Stop hooks ' +
    'set this so a session row can say "Responding..." while its turn is live. Agents should ' +
    'never call it -- a hand-set flag is exactly the one that gets left on.',
  inputSchema: { busy: z.boolean() },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard
    if (!args.sessionId) {
      return textResult(
        'No session id on this connection, so there is no row to flag. Upgrade the ' +
          'mightymouse-code shim, which is what sends it.',
        true
      )
    }
    const full = resolveSessionId(args.sessionId)
    if (!full) {
      return textResult(
        `No single live session matches "${args.sessionId}" -- either nothing has that id, or ` +
          'it is a prefix shared by several. Use more of the id.',
        true
      )
    }
    setAgentSessionBusy(full, args.busy)
    return textResult(args.busy ? 'Responding.' : 'Idle.')
  }
}

/** Still mints a card: an agent that could end itself silently would take a
 *  terminal off the screen with nothing said. The answer is the user's. */
const wrapUpHandler: VerbHandler<{ reason: z.ZodOptional<z.ZodString> }> = {
  description:
    'Offer to end this session once you are finished. The user gets one card with two ' +
    'buttons -- wrap it up, or leave it open -- and nothing happens unless they pick the ' +
    'first. Ends the agent only: the terminal stays open to resume in. Call it when your ' +
    'work is genuinely done, never to end a turn.',
  inputSchema: {
    reason: z.string().min(1).max(300).optional()
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard
    if (!args.sessionId) {
      return textResult(
        'No session id on this connection, so there is no session to close. Upgrade the ' +
          'mightymouse-code shim, which is what sends it.',
        true
      )
    }
    const full = resolveSessionId(args.sessionId)
    if (!full) {
      return textResult(`No single live session matches "${args.sessionId}".`, true)
    }

    const request = relayRequestStore.mint('ask', {
      question: args.reason
        ? `${sanitizeBody(args.reason) ?? args.reason} Wrap up this agent?`
        : 'This agent says it is finished. Wrap it up?',
      options: [CONFIG.UI_LABELS.CODE_SESSION_WRAP, CONFIG.UI_LABELS.CODE_SESSION_WRAP_CONFIRM_NO],
      cwd: args.cwd,
      origin: args.origin
    })
    const sent = await sendRelayPush(request)
    if (!sent.ok) console.error('[agent-relay] wrap_up push failed', sent.detail)

    const resolved = await awaitResolution(request.id)
    // Anything that is not an explicit yes leaves the session alone: a timeout
    // and a dismiss both mean nobody chose to close it.
    if (resolved.response?.answer !== CONFIG.UI_LABELS.CODE_SESSION_WRAP) {
      return textResult('Left open. Carry on, or stop and wait.')
    }
    const started = await startSessionWrap(full, 'agent')
    if (!started.ok) return textResult(`Could not wrap up this session: ${started.reason}.`, true)
    // Deliberately not awaited: `done` waits out this very turn, so awaiting it
    // here would deadlock the agent against its own idle check.
    void started.done
    return textResult('Wrapping up. Finish anything unsaved now -- you have about a minute.')
  }
}

/** How long a photo request waits. Longer than an ask's default: the person
 *  has to unlock the phone, open the card and scroll a camera roll, and a
 *  picker that expires mid-scroll is worse than one that never opened. */
const RELAY_PHOTOS_TIMEOUT_MS = 300_000

const photosGetHandler: VerbHandler<{
  reason: z.ZodString
  from: typeof fromField
  test: typeof testField
}> = {
  description:
    "Ask for a photo off the user's phone and wait until they pick one. Use this when they " +
    'refer to something on their phone -- "the screenshot I just took", "that photo from the ' +
    'shop" -- instead of asking them to AirDrop it. Their phone shows a card; one tap opens ' +
    'the photo sheet, and the picture lands on this Mac. You get back the file path, which ' +
    'you can read like any other local file. Say in `reason` what you want it for, in the ' +
    'words they would use -- it is the whole text of the card they see.' +
    FROM_HINT +
    PHONE_COPY_HINT,
  inputSchema: {
    reason: z.string().min(1).max(200),
    from: fromField,
    test: testField
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard

    const request = relayRequestStore.mint(
      'photos_get',
      {
        // Carried as `body` rather than `question`: nothing here is typed back,
        // so a card reading this as a question would render a reply box that
        // answers nothing.
        body: sanitizeBody(args.reason) ?? args.reason,
        from: attributeFrom(args.from, args.origin),
        cwd: args.cwd,
        origin: args.origin,
        test: args.test
      },
      RELAY_PHOTOS_TIMEOUT_MS
    )
    const sent = await sendRelayPush(request)
    if (!sent.ok) {
      // Same posture as ask: the card is already in the store, so a failed push
      // costs the buzz and not the request.
      console.error('[agent-relay] photos_get push failed', sent.detail)
    }

    const resolved = await awaitResolution(request.id)
    if (resolved.status === 'timedout') {
      return textResult(
        `No photo came back within ${resolved.timeoutMs / 1000}s. Their phone may have been ` +
          'locked. Ask them for it in words rather than retrying.',
        true
      )
    }
    if (resolved.status === 'dismissed') {
      return textResult('They closed the photo request without picking one.', true)
    }
    // Resolved with no path means the picker opened and the transfer failed --
    // distinct from a dismiss, and the agent must not report a file it has not
    // been given.
    const imagePath = resolved.response?.imagePath
    if (!imagePath) {
      return textResult("The photo didn't make it across. Ask them to try again.", true)
    }
    return textResult(JSON.stringify({ image_path: imagePath, via: resolved.resolvedVia }))
  }
}

const photosSearchHandler: VerbHandler<{
  after: z.ZodOptional<z.ZodString>
  before: z.ZodOptional<z.ZodString>
  is_screenshot: z.ZodOptional<z.ZodBoolean>
  limit: z.ZodOptional<z.ZodNumber>
}> = {
  description:
    "Look through the photos on the user's phone WITHOUT any photo leaving it. You get back " +
    'dates and sizes only -- no pictures -- so you can narrow things down first and then ask ' +
    'for the one you want with photos_fetch. Filter by date range and whether it is a ' +
    'screenshot; nothing else is searchable. Prefer this over photos_get when the user has ' +
    'told you roughly WHEN ("the screenshot I just took", "that photo from last Tuesday"): ' +
    'it costs them no taps at all. Name the photo you picked in your reply so they can ' +
    'correct you.',
  inputSchema: {
    after: z.string().optional().describe('Inclusive. YYYY-MM-DD or full ISO-8601.'),
    before: z.string().optional().describe('EXCLUSIVE: 2026-04-01 means through March 31.'),
    is_screenshot: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional()
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard

    const answer = await searchPhotos({
      after: args.after,
      before: args.before,
      isScreenshot: args.is_screenshot,
      limit: args.limit
    })
    if (!answer) {
      return textResult(
        "Their phone didn't answer. It may be asleep or out of range -- ask them for the " +
          'photo in words rather than retrying.',
        true
      )
    }
    // Decision 1: the permission is asked for HERE, after a real search failed
    // for want of it, so the prompt arrives with a reason attached.
    if (answer.scope === 'none') {
      const granted = await requestPhotoAccess()
      if (!granted || granted === 'none') {
        return textResult(
          "They haven't given MightyMouse access to their photos, so there is nothing to " +
            'search. Ask them to send the photo instead, or to allow access in Settings.',
          true
        )
      }
      const retry = await searchPhotos({
        after: args.after,
        before: args.before,
        isScreenshot: args.is_screenshot,
        limit: args.limit
      })
      if (!retry) return textResult('Their phone stopped answering after granting access.', true)
      return textResult(JSON.stringify(searchPayload(retry)))
    }
    return textResult(JSON.stringify(searchPayload(answer)))
  }
}

/** `matched` is the count BEFORE the cap, so an agent can tell "all of them"
 *  from "the first 20 of 400" and say so instead of guessing. `scope: limited`
 *  rides along because a search over a hand-picked subset that finds nothing
 *  means something different from an empty full library. */
function searchPayload(answer: {
  scope: string
  matched: number
  photos: unknown[]
}): Record<string, unknown> {
  return {
    scope: answer.scope,
    matched: answer.matched,
    returned: answer.photos.length,
    photos: answer.photos,
    ...(answer.scope === 'limited'
      ? { note: 'They allowed only selected photos, so this is not their whole library.' }
      : {})
  }
}

const photosFetchHandler: VerbHandler<{ ids: z.ZodArray<z.ZodString> }> = {
  description:
    'Fetch photos you found with photos_search, by id. They are saved to this Mac and you ' +
    'get the file paths back, which you can read like any other local file. Ids stop working ' +
    'once the phone leaves the foreground -- if one expires, search again rather than asking ' +
    'the user anything.',
  inputSchema: {
    ids: z.array(z.string().min(1)).min(1).max(10)
  },
  async run(args) {
    const guard = relayOffGuard()
    if (guard) return guard

    // Sequential, not Promise.all: each fetch can pull an original down from
    // iCloud, and ten at once on a phone radio is slower than ten in a row.
    const paths: string[] = []
    const failed: string[] = []
    for (const id of args.ids) {
      const path = await fetchPhoto(id)
      if (path) paths.push(path)
      else failed.push(id)
    }
    if (paths.length === 0) {
      return textResult(
        'None of those photos came across. The ids may have expired -- search again to get ' +
          'fresh ones.',
        true
      )
    }
    return textResult(JSON.stringify({ image_paths: paths, ...(failed.length ? { failed } : {}) }))
  }
}

/** The tools gated behind the "Photo access for agents" toggle. A set rather
 *  than a check inside each handler: the gate has to run before registerTool,
 *  because decision 4 is about the tool being INVISIBLE while off. */
export const PHOTO_VERBS = new Set<string>(['photos_get', 'photos_search', 'photos_fetch'])

const DECISION_FIELDS: readonly string[] = ['context', 'weights', 'scores', 'notes', 'test_you_usually']
const askFullSchema = z.object(askHandler.inputSchema)

export function askWithoutDecisions(): { description: string; inputSchema: z.ZodTypeAny } {
  const plain = Object.fromEntries(Object.entries(askHandler.inputSchema).filter(([k]) => !DECISION_FIELDS.includes(k)))
  return { description: askHandler.description.replace(DECISION_HINT, ''), inputSchema: z.object(plain).passthrough() }
}

export function askArgsWithoutDecisions(args: Record<string, unknown>): Record<string, unknown> | string {
  if (!args.test) return Object.fromEntries(Object.entries(args).filter(([k]) => !DECISION_FIELDS.includes(k)))
  const parsed = askFullSchema.safeParse(args)
  return parsed.success ? { ...args, ...parsed.data } : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
}

/** Erases a handler's specific Args type before it enters the registry --
 *  `run`'s parameter type is used contravariantly, so a `VerbHandler<Shape>`
 *  is never itself assignable to `VerbHandler<ZodRawShape>`. registerTool
 *  re-validates against `inputSchema` at the MCP boundary, so the cast is
 *  sound: nothing reaches `run` that didn't already pass that shape's parse. */
function erase<Args extends z.ZodRawShape>(handler: VerbHandler<Args>): VerbHandler<z.ZodRawShape> {
  return handler as unknown as VerbHandler<z.ZodRawShape>
}

/** Keyed by RelayVerb so the registry stays exhaustive against the store's
 *  own verb union -- adding 'ask'/'approve'/'show' here is the whole diff a
 *  future item needs in this file. */
export const VERB_HANDLERS: Partial<Record<RelayVerb, VerbHandler<z.ZodRawShape>>> = {
  notify: erase(notifyHandler),
  ask: erase(askHandler),
  approve: erase(approveHandler),
  show: erase(showHandler),
  photos_get: erase(photosGetHandler)
}

/** Verbs an agent calls that address its SESSION rather than mint a card. Kept
 *  out of VERB_HANDLERS because that map is keyed by RelayVerb (the store's card
 *  verbs) and nothing here ever reaches the store. */
export const SESSION_HANDLERS: Record<string, VerbHandler<z.ZodRawShape>> = {
  recap: erase(recapHandler),
  busy: erase(busyHandler),
  wrap_up: erase(wrapUpHandler)
}

/** Local-tooling tools, kept OUT of VERB_HANDLERS so that map stays exactly the
 *  four PRD §6 verbs and its RelayVerb key stays exhaustive. */
export const TOOLING_HANDLERS: Record<string, VerbHandler<z.ZodRawShape>> = {
  // Photo search and fetch live here, not in VERB_HANDLERS: that map is keyed
  // by RelayVerb because every member mints a card, and neither of these does.
  photos_search: erase(photosSearchHandler),
  photos_fetch: erase(photosFetchHandler),
  relay_pending: erase(pendingHandler),
  relay_deck: erase(deckHandler),
  relay_resolve: erase(resolveHandler),
  relay_dismiss: erase(dismissHandler)
}
