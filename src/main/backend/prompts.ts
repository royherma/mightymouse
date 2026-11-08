import { existsSync } from 'fs'
import { CONFIG } from '../../shared/config'
import { whisperModelFor, whisperModelPathFor } from '../capture/binaries'
import { AppMode, ContextData } from '../../shared/types'
import type { HistoryItem } from '../../shared/types'
import { resolveClaude, input, shell } from '../platform'
import { SETTINGS } from '../store/settings'
import { PREFS } from '../store/prefs'
import { composeCharter } from './charter'

/**
 * Global custom instructions (Settings → Instructions), labeled and gated per
 * mode by the user's appliesTo toggles. Empty string when unset or off for
 * this mode — mirrors the memory-blob pattern so the prompt stays clean.
 * `'write'` (predictive suggestion drafts) rides the rewrite toggle — it's the
 * same rewrite-family output contract, just a different entry point.
 */
function globalInstructionsBlock(mode: AppMode): string {
  const gate = mode === 'write' ? 'rewrite' : mode
  const { text, appliesTo } = PREFS.getGlobalInstructions()
  if (text.trim() === '' || !appliesTo[gate]) return ''
  return `USER'S INSTRUCTIONS FOR YOU (follow these; they override defaults where they conflict):\n${text.trim()}\n\n---\n`
}

/**
 * The rewrite request: what to do, then the text to do it to.
 *
 * Both halves are LABELED. Joined by a bare `---`, a wordy instruction read as
 * more document, and the model echoed the instruction back above the rewrite —
 * separator and all — which then got pasted into the user's file. The labels are
 * what make "which half is which" unambiguous, so the whole prompt cannot be
 * mistaken for the thing being rewritten.
 */
export function rewriteUserPrompt(instruction: string, selection: string): string {
  return [
    'INSTRUCTION (what to do — never output this, never repeat it back):',
    instruction.trim(),
    '',
    'TEXT TO REWRITE (output only your rewritten version of everything below):',
    selection
  ].join('\n')
}

// Separator placed between the charter (who/how the agent is) and the
// mode-specific system prompt (what to do for THIS request). Kept here so the
// charter wiring reads the same at every assembly point.
const CHARTER_SEP = '\n\n---\n\n'

/**
 * Prepend the agent charter to a mode-specific system prompt. Every mode and
 * every backend goes through this, so the governing rules apply uniformly. An
 * empty mode prompt (e.g. a bare `act` with no extras) still gets the charter.
 */
export function prependCharter(modeSystemPrompt: string): string {
  const charter = composeCharter()
  return modeSystemPrompt.trim() === ''
    ? charter
    : `${charter}${CHARTER_SEP}${modeSystemPrompt}`
}

// Audio/video extensions that signal a transcription-flavored act task. Used to
// gate the whisper hint so unrelated act runs (rename/move/...) stay noise-free.
const MEDIA_EXTS = [
  '.mov',
  '.mp4',
  '.m4v',
  '.mkv',
  '.webm',
  '.avi',
  '.m4a',
  '.mp3',
  '.wav',
  '.aac',
  '.flac',
  '.aiff',
  '.caf'
] as const

/** True when a path/name ends in a known audio/video extension. */
function looksLikeMedia(path: string): boolean {
  const p = path.toLowerCase()
  return MEDIA_EXTS.some((ext) => p.endsWith(ext))
}

// Words that signal an instruction is about audio/video — transcription, but also
// convert/compress/extract/trim/caption, since the agent (not us) decides the action
// once it knows the tools exist. `transr?ibe` tolerates the common "transribe" typo.
// `transc?ribe` matches both "transcribe" and the common "transribe" typo.
const MEDIA_VERB_RE =
  /\b(transc?ribe|transcript|caption|subtitle|speech to text|audio to text|extract audio|compress|transcode|to mp3|to wav|to mp4)/i

/**
 * Hands the act agent our already-installed media stack (ffmpeg + whisper-cli +
 * model) so it doesn't waste tool calls running `which whisper` / hunting the model
 * / checking brew / installing — the exact flailing that turned a transcribe into a
 * 90s run.
 *
 * Design: the inventory is a FACT about the machine, so the agent (good at intent)
 * decides what to DO with it — we only decide WHETHER a media task is plausibly in
 * play. Gate is intentionally broad (a media file in finderFiles, a media filename
 * in the selection, OR a media-ish instruction) so it still fires when a Finder file
 * arrives as TEXT and path-resolution misses — the costs are asymmetric (a few
 * wasted prompt lines vs a 90s install hunt). Stays quiet on website/empty-context
 * asks (no media file, no media verb). Only injects when all three binaries exist
 * (never claim a tool that isn't there); paths come from SETTINGS so overrides hold.
 */
function whisperActHint(finderFiles: string[], instruction: string, selection: string): string {
  const mediaInPlay =
    finderFiles.some(looksLikeMedia) ||
    looksLikeMedia(selection.trim()) ||
    MEDIA_VERB_RE.test(instruction)
  if (!mediaInPlay) return ''

  const s = SETTINGS.get()
  if (!existsSync(s.ffmpegPath) || !existsSync(s.whisperPath) || !existsSync(s.whisperModelPath)) {
    return ''
  }

  return `\n\nMEDIA TOOLS (already installed on this machine. Use them directly, do NOT run \`which\`, search for the model, check brew, or install anything):
- ffmpeg:      ${s.ffmpegPath}
- whisper-cli: ${s.whisperPath}  (offline transcription)
- model:       ${whisperModelPathFor(whisperModelFor(s.whisperLang || CONFIG.WHISPER_LANG))}
To TRANSCRIBE a video/audio file (whisper-cli takes 16kHz mono WAV only):
  1. ${s.ffmpegPath} -i <INPUT> -ar 16000 -ac 1 -c:a pcm_s16le -y <TMP>.wav
  2. ${s.whisperPath} -m ${whisperModelPathFor(whisperModelFor(s.whisperLang || CONFIG.WHISPER_LANG))} -f <TMP>.wav -otxt -of <OUTBASE> -l ${s.whisperLang || CONFIG.WHISPER_LANG} -nt
  Transcript lands at <OUTBASE>.txt. Write it next to the input file.
For convert / compress / extract-audio / trim, use ffmpeg directly.`
}

export interface RewritePromptOptions {
  mode: AppMode
  selection: string
  instruction: string
  selFile: string
  conversationHistory: Array<{ q: string; a: string }>
  ctxData: ContextData | null
  actionExtra: {
    key: string
    system_extra?: string
    skill_body?: string
  } | null
  /** Optional pre-assembled memory blob (from buildMemoryBlob). Empty string = no-op.
   *  FIRST-PARTY only (the user's own history/feedback/activity) — it keeps its
   *  system-prompt position. Retrieved third-party content goes in `retrievedBlob`. */
  memoryBlob?: string
  /** Retrieved THIRD-PARTY content (connector emails/Slack, recall slices). Goes in
   *  the USER turn, never the system prompt: system position is unearned trust for
   *  text a stranger wrote. See the prompt-injection-hardening PRD. */
  retrievedBlob?: string
  /** Reference file/folder paths for the agent to read (e.g. a capture folder,
   *  a screenshot). The CLI backends have filesystem access, so naming the paths
   *  is enough — they'll open them. Empty/undefined = no reference block. */
  contextFiles?: string[]
  /** True on ask runs when the ambient context-log toggle is on AND the backend
   *  can tool-call. Appends SYSTEM_PROMPT_ACTIVITY_ACCESS so the agent knows the
   *  local keystroke/history files exist and reads them for "what did I do" Qs
   *  instead of refusing. The runner grants --add-dir separately (see hud-run). */
  activityAccess?: boolean
}

export interface ActPromptOptions {
  instruction: string
  finderFiles: string[]
  selection: string
  ctxData: ContextData | null
  /** Optional pre-assembled memory blob (from buildMemoryBlob). Empty string = no-op. */
  memoryBlob?: string
}

export interface SuggestionPromptOptions {
  ctxData: ContextData
  selection: string
  ambientContext: string
  recentHistory: HistoryItem[]
  // Relevance-searched history for the current context. Present only on the manual
  // (⌘⌥⇧S) path; '' for the idle bubble.
  recallBlob: string
  // 'manual' earns the "advise the best next move" framing + the searched history;
  // 'idle' keeps the lighter quick-actions framing.
  source: 'idle' | 'manual'
  topAcceptedStems: string[]
}

/** CONTEXT block appended to rewrite/ask user prompts. Empty when there's nothing to attach. */
export function contextPromptBlock(
  ctxData: ContextData | null | undefined,
  mode: AppMode
): string {
  if (!ctxData) return ''
  const lines = [
    "CONTEXT (use silently to inform your answer; do NOT describe or narrate the context, the user already knows what's on their screen):"
  ]
  if (ctxData.frontApp) {
    lines.push(`- App: ${ctxData.frontApp}`)
  }
  if (ctxData.windowTitle) {
    lines.push(`- Window: ${ctxData.windowTitle}`)
  }
  if (ctxData.browserURL) {
    lines.push(`- URL: ${ctxData.browserURL}`)
  }
  if (ctxData.screenshotPath) {
    lines.push(`- Screen capture (open/view this image): ${ctxData.screenshotPath}`)
    lines.push(
      '  IMPORTANT: Look at it once. Ignore the small floating rewrite panel. Do NOT mention the screenshot, the timeline, or what apps/windows you saw. Just answer or rewrite.'
    )
  }

  if (mode === 'rewrite') {
    lines.push(
      'REWRITE-MODE OVERRIDE: Context is for tone/grounding ONLY. Your output must still be ONLY the rewritten text. No preamble, no analysis, no quoting context fields.'
    )
  } else {
    lines.push(
      "ASK-MODE OVERRIDE: Use context for grounding. Answer the question directly. Do NOT begin with 'Looking at your screen' or 'Based on the screenshot' or summarize what you see. Just answer."
    )
  }
  return '\n\n' + lines.join('\n') + '\n'
}

export function buildRewritePrompts(opts: RewritePromptOptions): {
  systemPrompt: string
  userPrompt: string
} {
  const { mode, selection, instruction, selFile, conversationHistory, ctxData, actionExtra, memoryBlob, retrievedBlob, contextFiles, activityAccess } = opts

  // Reference files (a capture folder / screenshot) the agent should read before
  // answering. Naming the paths is enough — the CLI backends have file access.
  const refBlock =
    contextFiles && contextFiles.length > 0
      ? `\n\nReference files (read them before answering):\n${contextFiles.map((f) => `- ${f}`).join('\n')}`
      : ''

  // 1. Build System Prompt
  const baseSysPrompt = mode === 'ask' ? CONFIG.SYSTEM_PROMPT_ASK : CONFIG.SYSTEM_PROMPT_REWRITE
  const actionParts: string[] = []

  // Ambient activity access: tell the agent the local keystroke/history files exist
  // so it reads them for "what did I do/type" questions instead of refusing. Only
  // set on ask runs where the toggle is on + the backend can tool-call (see hud-run).
  if (activityAccess) {
    actionParts.push(CONFIG.SYSTEM_PROMPT_ACTIVITY_ACCESS)
  }

  if (actionExtra) {
    if (actionExtra.skill_body && actionExtra.skill_body.trim() !== '') {
      actionParts.push(
        `REFERENCE SKILL (for tone/voice/conventions; do NOT mention it):\n${actionExtra.skill_body}`
      )
    }
    if (actionExtra.system_extra && actionExtra.system_extra.trim() !== '') {
      actionParts.push(actionExtra.system_extra)
    }
  }

  // Inject memory blob into system prompt so it's available for all modes.
  // Delimited clearly; placed before base system prompt so model sees it first.
  // ONLY first-party memory belongs here — retrieved third-party content is built
  // into the user turn below (retrievedPart).
  const memoryPart = memoryBlob && memoryBlob.trim() !== ''
    ? `${memoryBlob.trim()}\n\n---\n`
    : ''

  // Retrieved third-party content (connector items, recall slices) rides in the
  // USER turn. Position is the mitigation: text a stranger wrote must not occupy
  // the system slot, where models weight instructions most heavily. The content is
  // already fenced at assembly time (context-memory.ts → untrusted.ts).
  const retrievedPart = retrievedBlob && retrievedBlob.trim() !== ''
    ? `\n\n${retrievedBlob.trim()}\n`
    : ''

  // Global custom instructions (Settings → Instructions), gated per mode. Sits
  // ahead of the memory blob so assembly order is charter → instructions → memory
  // → mode prompt (instructions are a standing user preference, memory is per-run).
  const instructionsPart = globalInstructionsBlock(mode)

  const baseWithMemory = `${instructionsPart}${memoryPart}${baseSysPrompt}`
  const modeSystemPrompt =
    actionParts.length > 0 ? `${actionParts.join('\n\n')}\n\n${baseWithMemory}` : baseWithMemory
  // Charter (mission + decision principles) prepends to every mode + every backend.
  const systemPrompt = prependCharter(modeSystemPrompt)

  const ctxBlock = contextPromptBlock(ctxData, mode)

  // 3. Build User Prompt
  const hasSelection = selection && selection.trim() !== ''
  let userPrompt = ''

  if (mode === 'rewrite') {
    if (hasSelection) {
      userPrompt = `Instruction from user: ${instruction}\n\nThe selected text is in the file ${selFile}. Read it, apply the instruction, and output ONLY the rewritten text. Do not add any explanation, preamble, or code blocks.${ctxBlock}${retrievedPart}`
    } else {
      userPrompt = `Instruction from user: ${instruction}\n\nThere is NO selected text. Generate the output from scratch based on the instruction and the context provided below. Output ONLY the generated text. No preamble, no explanation, no code blocks.${ctxBlock}${retrievedPart}`
    }
  } else {
    let historyBlock = ''
    if (conversationHistory && conversationHistory.length > 0) {
      const histLines: string[] = []
      for (const qa of conversationHistory) {
        histLines.push(`Q: ${qa.q}`)
        histLines.push(`A: ${qa.a}`)
      }
      historyBlock = `\n\nPrevious exchanges:\n${histLines.join('\n')}\n`
    }

    if (hasSelection) {
      userPrompt = `Selected text is in: ${selFile}${historyBlock}\n\nUser question: ${instruction}${ctxBlock}${refBlock}${retrievedPart}`
    } else {
      userPrompt = `There is no selected text — answer based on the context below.${historyBlock}\n\nUser question: ${instruction}${ctxBlock}${refBlock}${retrievedPart}`
    }
  }

  return { systemPrompt, userPrompt }
}

/**
 * The screen-control half of the act prompt, with every dynamic path filled in.
 * Exported because Mighty builds its own system prompt (it does not go through
 * buildActPrompts), and voice/chat turns need the identical verb list — two copies
 * of this replace-chain is how the two paths would silently drift apart.
 *
 * Returns '' with no screenshot: the coordinates in every verb below are measured
 * on an attached image, so the capability is meaningless without one.
 */
export function screenControlBlock(screenshotPath: string | undefined | null): string {
  if (!screenshotPath) return ''
  return CONFIG.SYSTEM_PROMPT_ACT_SCREEN
    .replace(/\{\{BIN\}\}/g, input.inputBinPath())
    .replace(/\{\{UIBIN\}\}/g, input.uiBinPath())
    .replace(/\{\{SHOTBIN\}\}/g, input.shotCommand())
    .replace(/\{\{SHOT\}\}/g, screenshotPath)
}

export function buildActPrompts(opts: ActPromptOptions): {
  systemPrompt: string
  userPrompt: string
} {
  const { instruction, finderFiles, selection, ctxData, memoryBlob } = opts
  // Resolve the claude binary for the skill hint; fall back to the bare name
  // (the agent runs in a login shell where PATH resolves it anyway).
  const claudeBin = resolveClaude() ?? 'claude'
  const skillHint = `\n- Claude Code skills are available. Invoke them with: ${claudeBin} -p "/<skillname> <args>" --permission-mode bypassPermissions\n- Known skills: /yap (auto-caption a video file), /commit-fix, /tweet, /draft-tweet. If the task says "yap", run: ${claudeBin} -p "/yap <absolute-file-path>" --permission-mode bypassPermissions`

  // Screen-control capability: only when a screenshot is attached (the agent needs
  // to see the screen to act on coordinates). Inject the resolved mm-input path +
  // the current screenshot into the static guidance — keeps the prompt magic-string
  // free (the path is dynamic dev vs packaged) while teaching the verbs once.
  const screenHint = screenControlBlock(ctxData?.screenshotPath)

  // Inject memory blob before the act system prompt
  const memoryPart = memoryBlob && memoryBlob.trim() !== ''
    ? `${memoryBlob.trim()}\n\n---\n`
    : ''
  // Global custom instructions (Settings → Instructions), gated on appliesTo.act.
  const instructionsPart = globalInstructionsBlock('act')
  const hint = whisperActHint(finderFiles, instruction, selection)
  const systemPrompt = prependCharter(
    `${instructionsPart}${memoryPart}${CONFIG.SYSTEM_PROMPT_ACT.replace('{{ACT_TOOL_HINTS}}', shell.agentToolHints())}${skillHint}${screenHint}${hint}`
  )

  const parts: string[] = []
  parts.push(`USER INSTRUCTION: ${instruction}`)

  if (finderFiles && finderFiles.length > 0) {
    const lines = ['SELECTED FILES (from Finder):']
    for (const f of finderFiles) {
      lines.push(`- ${f}`)
    }
    parts.push(lines.join('\n'))
  }

  if (selection && selection.trim() !== '') {
    parts.push(`SELECTED TEXT:\n${selection}`)
  }

  if (ctxData && (ctxData.frontApp || ctxData.browserURL)) {
    const ctxLines = ['USER CONTEXT:']
    if (ctxData.frontApp) {
      ctxLines.push(`- frontmost app: ${ctxData.frontApp}`)
    }
    if (ctxData.windowTitle) {
      ctxLines.push(`- window title: ${ctxData.windowTitle}`)
    }
    if (ctxData.browserURL) {
      ctxLines.push(`- browser URL: ${ctxData.browserURL}`)
    }
    parts.push(ctxLines.join('\n'))
  }

  parts.push('Now perform the task. Remember to end with the ACT_RESULT line.')

  const userPrompt = parts.join('\n\n')

  return { systemPrompt, userPrompt }
}

// Shared rule that teaches the predictor the 'write' kind: a fully-drafted body the
// user can paste instantly (no second LLM call). Only emit it on a COMPOSE surface —
// an empty/half-written tweet box, reply field, blank email, comment — where the win
// is having the text ready. The draft rides in `text`; picking it pastes that verbatim.
const WRITE_RULE = `- When the user is on ANY editable text surface where the obvious next move is producing content — a tweet, reply, post, comment, email, message, OR a doc, note, schedule, list, outline, or table they're clearly about to fill in — your FIRST object MUST be a "kind":"write" with a "text" field holding the FULL drafted body, ready to paste verbatim. This is REQUIRED on an empty compose box, not optional — do NOT return an "ask"/"act" that merely DESCRIBES drafting ("Draft a LinkedIn post") when you can just WRITE it. An empty post/tweet/reply/email box with the cursor in it is the clearest possible signal: commit to a full draft, don't hedge. Keep "mode":"rewrite" on it. Match their voice and the surface (a tweet is short and punchy; a LinkedIn post leads with a hook; a schedule is concrete time-blocked lines). Ground the topic in their recent work from the context (what they shipped, the thread they're in). Only skip write when there is genuinely no topic to draft from. Never wrap "text" in quotes or hashtags they didn't ask for.`

// Escape hatch: if there's genuinely nothing useful to suggest (blank screen, no
// selection, too little context), the model returns a single decline object instead
// of forcing a weak suggestion. parseSuggestionResult reads {"decline":"..."} and
// surfaces the reason to the dev log so an empty trigger explains itself.
const DECLINE_RULE = `- If you genuinely cannot suggest anything useful for this context (blank or near-empty screen, no selection, not enough to act on), return ONLY {"decline":"<short reason, e.g. blank document with no content to work on>"} instead of an array. Prefer this over inventing a weak or generic suggestion.`

// History rows marked "✗ failed:" are actions that already FAILED. Re-suggesting one
// verbatim repeats the failure (the bug: a failed "paste the drafted post → no draft
// found" came back as a "Paste to compose" chip with nothing to paste). Treat a
// failure as a signal to fix the root cause instead — if "paste a draft" failed for
// lack of a draft, suggest DRAFTING it (a write), not pasting again.
const FAILED_RUN_RULE = `- A history row marked "✗ failed:" is an action that already FAILED. NEVER re-suggest a failed action verbatim — it will just fail again. Instead, address why it failed: if "paste the drafted post" failed because no draft existed, suggest DRAFTING the post now (prefer a "kind":"write" with the full body), not pasting.`

// Hard output-format clamp. The model is fully capable of emitting raw JSON; left
// unconstrained it narrates its reasoning first ("Clear: the composer is open…")
// which (a) blows the latency budget — a 17.6s run timed out mid-sentence — and (b)
// puts stray '[' brackets before the real array (quoted "[ask]" history) that the
// parser then has to dig past. Telling it to start at '[' and end at ']' kills both.
const JSON_ONLY_RULE = `- OUTPUT FORMAT (hard rule): respond with ONLY the raw JSON. Your entire reply MUST start with "[" (or "{" for a decline) and end with "]" (or "}"). No reasoning, no preamble, no explanation, no markdown code fences — not before the JSON, not after. Do NOT narrate what you see or think. Emit the JSON and nothing else.`

export function buildSuggestionPrompts(opts: SuggestionPromptOptions): {
  systemPrompt: string
  userPrompt: string
} {
  const isManual = opts.source === 'manual'
  // Manual trigger = a deliberate "what should I do here?" ask, so the first
  // object carries an `advice` headline (the best next move for THIS situation,
  // grounded in the searched history). Idle stays a lightweight quick-actions list.
  const systemPrompt = isManual
    ? `You advise the user on their best next move in MightyMouse for the situation on screen right now.
Use everything you know about them (their searched history, recent activity, and proven habits) to judge what they should do — not generic tips.
Return ONLY valid JSON: an array of 1-3 objects shaped exactly like {"label":"...","instruction":"...","mode":"rewrite|ask|act","advice":"..."}.
Rules:
- The FIRST object MUST include advice: one short sentence (max ~14 words) naming the single best next move for this exact context. The rest omit advice.
- label is short UI copy for the action chip, not a sentence about the app.
- instruction is the full command to run if the chip is picked.
- mode is rewrite when changing selected text, ask when answering/explaining, act when doing a task.
- Ground the advice in the searched history when it's relevant (a prior thread, a commitment, a person). Do not invent facts that aren't in the context.
${WRITE_RULE}
${FAILED_RUN_RULE}
${DECLINE_RULE}
- A screenshot of the user's screen is attached. Read it to ground every suggestion in what's actually on screen (the open app, the compose box, the thread, the signed-in account). Never narrate the screenshot or say "I see" — just use it.
${JSON_ONLY_RULE}`
    : `You predict short MightyMouse actions for the user's current context.
Return ONLY valid JSON: an array of 2-3 objects shaped exactly like {"label":"...","instruction":"...","mode":"rewrite|ask|act"}.
Rules:
- label is short UI copy, not a sentence about the app.
- instruction is the full command to run if selected.
- mode is rewrite when changing selected text, ask when answering/explaining, act when doing a task.
${WRITE_RULE}
${FAILED_RUN_RULE}
${DECLINE_RULE}
- A screenshot of the user's screen is attached. Read it to ground every suggestion in what's actually on screen (the open app, the compose box, the thread, the signed-in account). Never narrate the screenshot or say "I see" — just use it.
${JSON_ONLY_RULE}`

  const recent = opts.recentHistory
    .slice(0, CONFIG.SUGGESTIONS.RECENT_HISTORY)
    .map((item) => `- [${item.mode}] ${item.instruction}`)
    .join('\n')
  const proven =
    opts.topAcceptedStems.length > 0
      ? opts.topAcceptedStems.map((stem) => `- ${stem}`).join('\n')
      : ''

  const lines = [
    'CURRENT CONTEXT',
    `App: ${opts.ctxData.frontApp || '(unknown)'}`,
    `Window: ${opts.ctxData.windowTitle || '(unknown)'}`,
    `URL: ${opts.ctxData.browserURL || '(none)'}`,
    `Selected text: ${opts.selection.trim() || '(none)'}`,
    ''
  ]

  // Name the screenshot path so the claude (shell) backend Reads the actual pixels
  // off disk — without this it gets text only and trusts the (sometimes wrong) URL.
  // That was the bug: an OPEN LinkedIn composer with a stale `about:blank` URL made
  // the model declare "blank page, no compose box" and decline. The http backend
  // gets the image via `images`; this line is what gives the CLI backend the same view.
  // The window title is the ground truth for what's open — trust it over the URL.
  if (opts.ctxData.screenshotPath) {
    lines.push(
      `Screen capture (open/view this image to see what's actually on screen): ${opts.ctxData.screenshotPath}`,
      // Hard imperative, not a hint: on the claude CLI backend the screenshot is NOT
      // attached as a vision input — it's only this file path the model must Read with
      // its own tool. Haiku skipped the Read and declined off the text context
      // (about:blank URL + empty selection read as "blank page, no compose box") even
      // with an open composer on screen. Force the Read BEFORE any decision, and tell
      // the model that about:blank + empty selection are NORMAL on an open web composer.
      'YOU MUST open and look at this screenshot before deciding ANYTHING. Do NOT judge from the URL or selection text alone — on a web compose box the URL often reads "about:blank" and the selection is empty; that is NORMAL and does NOT mean the page is blank. The screenshot is the ground truth: if it shows an open compose box / thread / editor, that is what is on screen, and you should WRITE for it (not decline). Only decline if the SCREENSHOT itself shows nothing to act on.',
      ''
    )
  }

  lines.push(
    'RECENT ACTIVITY',
    opts.ambientContext || '(none)',
    ''
  )

  // Manual path only: relevance-searched history for what's on screen. The deeper
  // "what we know about you in this situation" signal that powers the advice.
  if (isManual && opts.recallBlob.trim() !== '') {
    lines.push('WHAT WE KNOW (searched from your history for this context)', opts.recallBlob.trim(), '')
  }

  lines.push(
    'RECENT USER INSTRUCTIONS',
    recent || '(none)',
    '',
    'PROVEN ACCEPTED INSTRUCTION STEMS IN THIS APP',
    proven || '(none)',
    '',
    isManual
      ? `Give your best next move as advice on the first item, then up to ${CONFIG.SUGGESTIONS.MAX} actions total.`
      : `Return at most ${CONFIG.SUGGESTIONS.MAX} suggestions.`
  )

  return { systemPrompt, userPrompt: lines.join('\n') }
}

// ── Smart dictation (double-tap) ──────────────────────────────────────────────
// Screen-aware dictation: the user spoke an instruction while looking at their
// screen, and a screenshot is attached. The model reads the screen, decides
// whether the user wants text WRITTEN into the app (a reply, copy, a rewrite) or
// a QUESTION ANSWERED, and returns ONE {action,text} object. The caller pastes on
// action:"paste" and shows the body on action:"answer" — see smart-dictation.ts.
// Same {...}-grab + coerce + fallback safety net as recall-classifier: a bad shape
// degrades to pasting the verbatim transcript, never a crash.
export interface SmartDictationPromptOptions {
  /** The transcribed spoken instruction. */
  transcript: string
  /** Screen context; screenshotPath is what makes this screen-aware. */
  ctxData: ContextData
}

export function buildSmartDictationPrompts(opts: SmartDictationPromptOptions): {
  systemPrompt: string
  userPrompt: string
} {
  const modeSystemPrompt = `The user DICTATED an instruction out loud while looking at their screen. A screenshot of that screen is attached. Do exactly what they want, adapted to what's on screen.

Decide ONE of three actions:
- "paste" — they want text written or edited IN the app on screen (an email/message reply, a document edit, slide copy, ad copy, a social post). Return the exact text to insert, in THEIR voice, grounded in the thread/doc/compose box visible in the screenshot. This is the common case.
- "answer" — they asked a question or want information (not text to insert, and not a task to perform). Return the answer.
- "act" — they gave a TASK that requires taking real action beyond inserting text: operating on files, running something, multi-step work, or anything that needs tools/agentic follow-through (e.g. "rename this file to X", "find the PDF I downloaded and move it to Desktop", "commit these changes"). Return a short one-line restatement of the task as "text" — it's used as the instruction for the follow-up run, not shown to the user as-is.

For "act" ONLY, also decide "destructive": true if the task deletes, overwrites, sends, pays, or otherwise makes an irreversible/hard-to-undo change (e.g. "delete all my downloads", "empty the trash", "send this email", "force push", "overwrite X") — anything the user would want a chance to confirm before it runs. "destructive": false for reversible/low-risk acts (rename, move within the workspace, read-only lookups, running a build). When genuinely unsure, prefer true. Omit "destructive" entirely for "paste"/"answer".

Return ONLY valid JSON, exactly this shape:
{"action":"paste"|"answer"|"act","text":"...","destructive":true|false}

Rules:
- Read the screenshot before deciding. It is the ground truth for what's open (the compose box, the thread, the signed-in account, the current slide). On a web compose box the URL often reads "about:blank" and there's no selection — that is NORMAL, not a blank page.
- For "paste": output ONLY the text to insert. No preamble, no quotes around it, no "Here's your reply". Match the tone of what's on screen; keep it in the user's voice.
- For "answer": be direct. Do NOT begin with "Looking at your screen" or "Based on the screenshot".
- For "act": default to "paste" or "answer" unless the request clearly needs real action taken (file ops, running commands, multi-step work) — most dictation is text-in-the-box, so don't over-trigger "act". Always include "destructive" for "act".
- Never narrate the screenshot or say "I see". Just produce the JSON.
- OUTPUT FORMAT (hard rule): your entire reply MUST start with "{" and end with "}". No reasoning, no markdown fences, nothing before or after the JSON object.`

  const systemPrompt = prependCharter(modeSystemPrompt)

  const lines = ['WHAT THE USER SAID (dictated aloud):', opts.transcript.trim(), '', 'CURRENT SCREEN CONTEXT']
  if (opts.ctxData.frontApp) lines.push(`- App: ${opts.ctxData.frontApp}`)
  if (opts.ctxData.windowTitle) lines.push(`- Window: ${opts.ctxData.windowTitle}`)
  if (opts.ctxData.browserURL) lines.push(`- URL: ${opts.ctxData.browserURL}`)
  if (opts.ctxData.screenshotPath) {
    lines.push(
      `- Screen capture (open/view this image to see what's actually on screen): ${opts.ctxData.screenshotPath}`,
      // Same hard imperative as the suggestion path: on the claude CLI backend the
      // screenshot is NOT a vision input — it's a file path the model must Read. Force
      // the Read before deciding so it doesn't misjudge from an about:blank URL alone.
      '  YOU MUST open and look at this screenshot before deciding. Ignore the small floating MightyMouse HUD if visible.'
    )
  }
  lines.push('', 'Return the single {"action","text","destructive"} JSON object now.')

  return { systemPrompt, userPrompt: lines.join('\n') }
}
