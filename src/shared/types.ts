// rewrite = transform selected text · ask = answer a question · act = run an
// agentic action · write = generate fresh text into an empty cursor (nothing
// selected). `write` is set explicitly (by a write-kind suggestion, or a future
// empty-cursor flow) — detectMode never infers it from instruction text.
import type { BackendId } from '../main/backend/adapters'
import type { AdminBugReport } from './bug-report'
import type { CursorStyleId } from './cursor-styles'
import type { RelayInterviewAnswer, RelayQuestion } from './relay-interview'
import type { RemoteRefusal } from './remote-refusal'
import type { ReasoningEffort } from './model-sources'

export type AppMode = 'rewrite' | 'ask' | 'act' | 'write'

// A capture is a non-LLM action that still produces a run folder + history row:
// a voice listen, a screen recording, or a screenshot. Kept distinct from AppMode
// (those are LLM modes) but unified under RunKind so every action — LLM or capture —
// gets the same per-run folder (`<ts>-<kind>-<slug>-<id>`) and shows in the panel.
export type CaptureKind = 'listen' | 'recording' | 'screenshot'

// The kind tag stamped on a run folder + history row. ANY action — an LLM mode or a
// capture — is one of these, so a new action type just adds a member and flows through
// the same createRunFolder / history-panel machinery with no new plumbing.
export type RunKind = AppMode | CaptureKind

/** One spoken word and when it is heard, for read-aloud highlighting. Produced
 *  only by the Kokoro rung (see src/main/audio/tts.ts) — the other TTS providers
 *  return opaque audio, so consumers must treat these as optional. */
export interface SpokenWord {
  /** The word as written, matched back against the source text by the renderer. */
  w: string
  /** Start / end offset in seconds from the beginning of the clip. */
  s: number
  e: number
}

/** What `speakText` hands the renderer: audio as a data URL (a Uint8Array over
 *  IPC arrives as a plain object no <audio> src accepts) plus optional timings. */
export interface SpeakTextResult {
  dataUrl: string | null
  provider: string
  words?: SpokenWord[]
}

export type AttachmentKind = 'image' | 'audio' | 'file'

/** One user-attached piece of media flowing from the UI through to a backend. */
export interface MediaAttachment {
  /** Absolute path on disk. */
  path: string
  kind: AttachmentKind
  /** Original filename for display in the UI (basename of path when absent). */
  name?: string
}

export type DroppedImage = { name: string } & ({ bytes: Uint8Array; type: string; url?: undefined } | { url: string; bytes?: undefined; type?: undefined })

export interface AttachmentSummary {
  count: number
  images: number
  audio: number
  files: number
}

export type SuggestionKind = 'run' | 'write'

export interface Suggestion {
  label: string
  instruction: string
  mode: AppMode
  /** Defaults to 'run' when absent (every legacy suggestion). */
  kind?: SuggestionKind
  /** The ready-to-paste body for a 'write' suggestion. Ignored for 'run'. */
  text?: string
  // Optional one-line "best next move" advice shown above the action chips. Only
  // the first suggestion's advice is rendered (it's the headline for the bubble).
  advice?: string
}

export type SuggestPhase = 'hidden' | 'loading' | 'ready' | 'empty' | 'error'

export type SuggestState =
  | { phase: 'hidden' }
  // etaMs: predicted gen time (ms) from past suggestion runs, for the ring sweep.
  // Optional — absent when there's no history yet (→ plain spinner, no ring).
  | { phase: 'loading'; etaMs?: number }
  | { phase: 'ready'; suggestions: Suggestion[] }
  | { phase: 'empty' }
  | { phase: 'error' }

export interface CursorFlyTo {
  x: number
  y: number
}

/** Startup snapshot the cursor overlay pulls at mount (see CHANNELS.cursorGetState). */
export interface CursorState {
  style: CursorStyleId
  pointerEnabled: boolean
}

export interface UsageEvent {
  id: number
  /** ISO-8601 timestamp the call was recorded. */
  createdAt: string
  /** Ties back to the client-side run (and the History row). Shown for support. */
  runId: string
  /** Which feature triggered it: rewrite | ask | act | unknown (older rows). */
  feature: string
  /** User-facing product name (e.g. "MightyMouse AI"). Resolved server-side from
   *  billing_config — the raw provider/model is deliberately NOT sent to the client
   *  (no provider leak, change the name without an app release). */
  displayName: string
  inputTokens: number
  outputTokens: number
  /** What the user was actually charged, in credit cents (integer; may round a
   *  sub-cent call to 0). */
  chargedCents: number
  /** Real upstream cost in micro-dollars (millionths). Carries sub-cent precision
   *  the integer chargedCents loses — used to render "< $0.01" honestly. */
  costUsdMicros: number
  /** Wall-clock duration of the call. */
  durationMs: number
}

export type { BackendId } from '../main/backend/adapters'

export type ModelCatalogEntry = { id: string; label: string; tier: 'cheap' | 'mid' | 'premium' }

export const HUD_MODE = {
  screenshot: 'screenshot',
  recording: 'recording',
  act: 'act'
} as const

/** The window route token union. Used in query params and loadFile calls. */
export type HudMode = (typeof HUD_MODE)[keyof typeof HUD_MODE]

// 19 = 6px gap + 22px button + 4px shadow, minus the 13px gutter every card window already has.
export const HUD_ROUTE_ROOM = 19

export const HUD_CAPTURE = {
  listen: 'listen',
  screen: 'screen',
  smartListen: 'smartListen',
  handsFree: 'handsFree'
} as const
export type HudCapture = (typeof HUD_CAPTURE)[keyof typeof HUD_CAPTURE]

export const RUN_EVENT = {
  tool_start: 'tool_start',
  tool_end: 'tool_end',
  thinking: 'thinking',
  text: 'text',
  usage: 'usage'
} as const
export type RunEventKind = (typeof RUN_EVENT)[keyof typeof RUN_EVENT]

/** A tool call begins — carries the tool name and its FULL input object. */
export interface ToolStartEvent {
  kind: typeof RUN_EVENT.tool_start
  /** Stable id pairing this start to its tool_end (the CLI's tool_use id). */
  id: string
  /** Tool name, e.g. 'Read', 'Bash', 'Edit', 'WebSearch', an MCP tool. */
  name: string
  /** The full tool input object as the model sent it (command, file_path,
   *  content, query, …) — not truncated. The inspector renders it verbatim. */
  input: unknown
}

/** A tool call finishes — carries its full result content + error flag. */
export interface ToolEndEvent {
  kind: typeof RUN_EVENT.tool_end
  /** Matches the ToolStartEvent.id (the CLI's tool_use_id). */
  id: string
  /** The tool's output content, verbatim (string or structured blocks). */
  output: unknown
  /** True when the tool reported an error (is_error on the result block). */
  isError: boolean
}

/** A block of the model's reasoning ("thinking"). Only present when the CLI
 *  streams extended-thinking content blocks; absent otherwise. */
export interface ThinkingEvent {
  kind: typeof RUN_EVENT.thinking
  text: string
}

/** A block of assistant-authored answer text streamed mid-run. */
export interface RunTextEvent {
  kind: typeof RUN_EVENT.text
  text: string
}

/** Final token usage + cost, from the terminal `result` event. One per run.
 *  (Named RunUsageEvent — `UsageEvent` is already the billing usage-history row.) */
export interface RunUsageEvent {
  kind: typeof RUN_EVENT.usage
  inputTokens: number
  outputTokens: number
  /** Prompt-cache read/creation tokens, when the stream reports them. */
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** Total run cost in USD (total_cost_usd). */
  costUsd?: number
  /** Number of agent turns the run took (num_turns). */
  turns?: number
  /** Wall-clock run duration in ms (duration_ms). */
  durationMs?: number
  /** Model id the CLI actually ran ("claude-opus-5-5"), not the alias we passed. */
  model?: string
}

/** One structured event in a run's live transcript. */
export type RunEvent = ToolStartEvent | ToolEndEvent | ThinkingEvent | RunTextEvent | RunUsageEvent

/** Act-mode highlight box: main → highlight overlay (CHANNELS.actHighlight).
 *  Window-local logical points, same coordinate space as cursorFlyTo. */
export interface HighlightBoxPayload {
  x: number
  y: number
  w: number
  h: number
  durationMs: number
}

/** What the drawn agent cursor is about to do to the control it glides to. */
export type AgentCursorKind = 'click' | 'type' | 'key' | 'scroll' | 'drag' | 'look'

/** Computer-use "agent cursor": main → agent-cursor overlay (CHANNELS.agentCursorShow).
 *  x/y are global SCREEN points (top-left origin), not window-local. */
export interface AgentCursorTarget {
  x: number
  y: number
  kind: AgentCursorKind
  label?: string
  paused?: boolean
  controls?: boolean
}

export type AgentCursorAction = 'pause' | 'resume' | 'stop'

export type ComputerUseRunState = 'running' | 'paused' | 'ended'

export interface ComputerUseStatus {
  state: ComputerUseRunState
  step: number
  line: string
  detail?: string
  /** True on an 'ended' status whose run did not finish 'done' — offers Try again. */
  canRetry?: boolean
}

export type ComputerUseCommand = 'pause' | 'resume' | 'stop' | 'close' | 'retry'

/** Payload pushed main → inspector on each event (CHANNELS.transcriptEvent). */
export interface TranscriptEventPayload {
  runId: string
  event: RunEvent
}

/** Quick-action buttons offered on a done HUD card (e.g. the listen result). */
export type HudActionKind = 'ask' | 'act'

/** Confirm/cancel buttons on a "this act is destructive, proceed?" HUD card —
 *  distinct from HudActionKind (whose 'act' means "run act on this capture",
 *  not "yes, run the act I already classified"). */
export type HudConfirmKind = 'confirm' | 'cancel'

/** Renderer → main when a destructive-act confirm card is answered. */
export interface HudConfirmActPayload {
  runId: string
  answer: HudConfirmKind
}

/** A capture preview to show inline on a finished HUD card (macOS-style thumbnail). */
export interface HudPreview {
  /** Absolute path to the captured asset — served to the renderer via media://. */
  path: string
  /** image = a screenshot <img>; video = a muted looping <video> of the recording. */
  kind: 'image' | 'video'
}

/** Everything a pre-warmed (spare) HUD window needs to become a specific card —
 *  the same fields a cold window reads from its URL query. See warmHud(). */
export interface HudInitPayload {
  runId: string
  title: string
  subtitle: string
  mode: HudMode
  capture: HudCapture
  etaMs: number
  elapsedMs: number
}

/** Payload pushed to the HUD renderer while a run is still in flight — a phase
 *  label, a timer freeze, a recording→processing flip, or a card reuse. Every
 *  field is optional: an update carries only what changed. */
export interface HudUpdatePayload {
  subtitle?: string
  freezeTimer?: boolean
  /** The value to display while frozen, e.g. "12.4s". Only read when freezeTimer. */
  timerFreeze?: string
  running?: boolean
  title?: string
  cancelArmed?: boolean
  /** Predicted run duration (ms) for the ETA progress bar; 0/absent = no bar. */
  etaMs?: number
  /** Explicitly flip the recording/waveform UI off (e.g. mic closed, now
   *  processing) without a full `running` reset. Absent = leave as-is. */
  recording?: boolean
  /** 0..1 progress while the listen key is physically held. Drives the hold-glow. */
  holdProgress?: number
  routeNext?: boolean
  submitNext?: boolean
  capture?: HudCapture
  /** Hands-free only: is the user talking RIGHT NOW (per the VAD)? A hands-free
   *  session is mostly silence, so the waveform and timer follow speech rather
   *  than the session — an always-on wave over a 26s timer read as "recording
   *  everything you say" when nothing was being captured. */
  speaking?: boolean
}

/** A pending code-agent-relay card (PRD 2026-08-12-1786501335 §6b) riding the
 *  same HUD card window as any other run. One card = one RelayRequest; born
 *  already "done" (there's no running phase) and never auto-dismisses until
 *  answered, mirroring confirmAct's destructive-act gate. */
export interface HudRelayCard {
  requestId: string
  /** `notify` only ever appears when Roy chose MightyMouse cards over macOS
   *  notifications (PRD 2026-08-22-1787388684). It has nothing to answer, so it
   *  is the one verb here that carries no controls and dismisses on its own. */
  verb: 'ask' | 'approve' | 'show' | 'photos_get' | 'notify'
  /** Minted-at + budget -- `waitingLabel`'s (relay-cards.ts) only inputs. The
   *  Panel and phone cards already show "Asked 4m ago" off these; the HUD
   *  couldn't, having neither. */
  createdAt: number
  timeoutMs: number
  /** Who is asking, same label the Panel and phone cards chip -- with several
   *  agents open, "Needs your answer" alone names no session. */
  from?: string
  /** Hash key for AgentFace. sessionId when the shim sent one, else the join
   *  string, so the HUD draws the same face as the Panel without re-joining. */
  faceId?: string
  /** Only rendered when it says something the `from` label doesn't -- a worktree
   *  whose folder differs from the repo name. See distinctPath in relay-status. */
  cwd?: string
  /** A drill. The title already carries [TEST] via markTest; this rides too so
   *  the card can mark itself without parsing its own heading. */
  test?: boolean
  /** Severity for notify-style emphasis, from the shared LEVEL_EMOJI set. */
  level?: 'info' | 'success' | 'warn' | 'error'
  question?: string
  options?: string[]
  /** A multi-question ask. The HUD steps through it with the same shared
   *  interviewView() the Panel and phone cards use, so all three hold one
   *  cursor rather than three that drift. */
  questions?: RelayQuestion[]
  /** Answers already collected on ANY surface -- the card re-renders off the
   *  store's change feed, so this is what advances it to the next question. */
  buffered?: RelayInterviewAnswer[]
  /** The request has a tmux pane, so the whole interview can be finished here
   *  rather than handed back after question 1 (blockFor's `noPane`). */
  canReadPane?: boolean
  action?: string
  detail?: string
  risk?: 'low' | 'high'
  /** Absolute path to the screenshot; served via media://, same as HudPreview. */
  imagePath?: string
  caption?: string
  waitForAck?: boolean
  /** 0-1, how far through the whole job. ask/approve only -- the verb union
   *  above excludes notify, so a notify's progress never reaches the HUD and
   *  that is deliberate: admitting notify here is a much larger change than
   *  drawing a bar. */
  progress?: number
}

/** Payload pushed to the HUD renderer when a run finishes. */
export interface HudDonePayload {
  ok: boolean
  summary: string
  revealPath: string | null
  timerFreeze: string
  /** Quick-action buttons to show under the summary; suppresses auto-dismiss. */
  actions?: HudActionKind[]
  /** True = voice routing is in 'hover' mode and this transcript is still held
   *  for it, so the card offers a "voice route" button that ranks on demand.
   *  Nothing has been ranked yet at this point. */
  canVoiceRoute?: boolean
  /** Long-form result body to render inline + offer a Copy button for. */
  body?: string | null
  /** Inline capture preview (screenshot thumbnail / short recording clip). */
  preview?: HudPreview | null
  /** True = this card is a destructive-act confirm gate: render Confirm/Cancel
   *  instead of `actions`, never auto-dismiss. */
  confirmAct?: boolean
  hasConversation?: boolean
  /** True when the user stopped this run themselves (Stop button / stop hotkey).
   *  Renders neutrally instead of as a red failure — a deliberate stop is not an
   *  error, even though it arrives on the ok:false path. */
  stopped?: boolean
  /** Ms spent turning the finished audio into text — the wait after the mic closed,
   *  NOT the clip length (`timerFreeze` already holds that). Shown beside the clip
   *  length only when the "Show transcription speed" pref is on. */
  transcribeMs?: number
  /** Present = render this card as a relay ask/approve/show request instead of
   *  a normal run result. */
  relay?: HudRelayCard
}

/** Renderer → main when a relay HUD card is answered. */
export interface HudRelayAnswerPayload {
  runId: string
  requestId: string
  response: { answer?: string; approved?: boolean; note?: string; acked?: boolean }
  via: 'chip' | 'typed' | 'note'
  /** Which question of a multi-question ask this answers. Sent rather than
   *  re-derived in main, so the card that drew the question owns the cursor. */
  questionIndex?: number
  /** This answer REPLACES the one already held for `questionIndex` -- set only
   *  by a card that stepped back onto an answered question. */
  revise?: boolean
}

/** Renderer → main when a HUD quick-action button is clicked. */
export interface HudActionPayload {
  runId: string
  action: HudActionKind
  /** Optional instruction typed into the card's hover input. '' / undefined =
   *  run on the capture with the neutral default framing. */
  instruction?: string
}

// UI sound-effect names. Each maps to src/renderer/src/sounds/<name>.wav.
export type SoundName =
  | 'screenshot'
  | 'record-start'
  | 'record-stop'
  | 'done'
  | 'success'
  | 'error'
  | 'thinking'

// ── Settings deep-link ──────────────────────────────────────────────────────
// Sections the Settings window can be opened AT (scrolled into view). Grow this
// union as more launch points (tray, deeplinks) want to land on a section.
export type SettingsSectionFocus =
  | 'phoneRemote'
  | 'binaries'
  | 'credits'
  | 'selectionBar'
  | 'agentRelay'

/** Runtime names for {@link SettingsSectionFocus} — import instead of retyping. */
export const SETTINGS_SECTION = {
  phoneRemote: 'phoneRemote',
  binaries: 'binaries',
  // Where every "you hit the free limit" CTA lands, from any window.
  credits: 'credits',
  selectionBar: 'selectionBar',
  agentRelay: 'agentRelay'
} as const satisfies { [K in SettingsSectionFocus]: K }

// ── Permissions ─────────────────────────────────────────────────────────────
export type PermissionKey = 'accessibility' | 'screen' | 'microphone'
export type PermissionStatus = 'granted' | 'denied' | 'unknown' | 'not-applicable'

export interface PermissionState {
  key: PermissionKey
  label: string
  status: PermissionStatus
  description: string
  /** True if this permission blocks a core feature on the current platform. */
  required: boolean
}

export interface PermissionTest {
  ok: boolean
  /** Short, human-readable reason when `ok` is false. */
  detail?: string
  /** Granted in macOS but the per-process TCC cache still refuses; only a
   *  relaunch clears it. Branch on this, never on `detail`'s wording. */
  needsRestart?: boolean
  /** ffmpeg is on disk but dies on launch (a Homebrew dylib drift). The fix is a
   *  download, not a permission grant — branch on this, never on `detail`. */
  ffmpegBroken?: boolean
  /** FAKED by the dev FTUE replay — says nothing about the real machine. Any
   *  surface showing a mocked result must label it from THIS, not `detail`. */
  mocked?: boolean
  /** Mocked results that can never flip ok (screen, deliberately) — so the UI
   *  can stop offering a control that cannot work. */
  mockUnwinnable?: boolean
}

/** Combined view returned to the onboarding wizard: OS status + probe result. */
export interface PermissionCheck {
  key: PermissionKey
  status: PermissionStatus
  test: PermissionTest
}

// ── Whisper / capture binary status ─────────────────────────────────────────
export interface BinaryStatus {
  key: 'ffmpeg' | 'whisper' | 'whisperModel' | 'parakeet'
  label: string
  path: string
  found: boolean
  /** For binaries: version string if resolvable. For model: byte size. */
  detail?: string
}

export interface SettingsState {
  permissions: PermissionState[]
  binaries: BinaryStatus[]
  paths: {
    ffmpeg: string
    whisper: string
    whisperModel: string
  }
  devices: {
    video: string
    audio: string
  }
  /** Whisper language code the user picked — drives the picker AND the model. */
  whisperLang: string
  /** Readiness of the big multilingual model, so the picker can show the cost
   *  of a non-English language before the user commits to the download. */
  multilingualModel: {
    name: string
    installed: boolean
    /** Human sizes ('1.6 GB'), pre-formatted in main so the UI does no math. */
    needLabel: string
    freeLabel: string | null
    hasRoom: boolean
  }
  /** Live AVFoundation device lists for the Settings dropdowns. */
  available: {
    video: Array<{ index: string; name: string }>
    audio: Array<{ index: string; name: string }>
  }
  /** Where the app saves runs/captures (read-only; openable in Finder). */
  storage: {
    root: string
    captures: string
    acts: string
  }
  platform: string
  recording: boolean
  /** Homebrew present — gates the one-click ffmpeg/whisper install buttons. Without
   *  it we explain how to get brew instead of showing a button that can't work. */
  hasHomebrew: boolean
  /** "Let Siri see your Mac's screen" — see StoredSettings.siriScreenAnswer.
   *  Resolved to a real boolean here so the renderer never re-applies the default. */
  siriScreenAnswer: boolean
  smallPanel: boolean
  holdForSmartDictation: boolean
  advancedMode: boolean
  webAccess: boolean
  codeOwnCopy: boolean
  transcriptFormats: Record<string, boolean>
}

/** What the Settings window may send to `settingsSave`. Was `Record<string, string>`
 *  until a boolean setting existed; the index signature stays so the text fields keep
 *  passing through unchanged, and each non-string key is declared beside it. */
export type SettingsPatch = Record<string, string | boolean | undefined> & {
  siriScreenAnswer?: boolean
  smallPanel?: boolean
  holdForSmartDictation?: boolean
  advancedMode?: boolean
  webAccess?: boolean
  codeOwnCopy?: boolean
}

// ── Capture session ─────────────────────────────────────────────────────────

export type TranscribeEngineRan = 'parakeet' | 'whisper'

export interface CaptureResult {
  kind: CaptureKind
  folder: string
  screenshotPath?: string
  videoPath?: string
  audioPath?: string
  transcriptPath?: string
  transcriptPreview?: string
  /** Length of the recorded audio in seconds — NOT how long processing took. */
  durationS?: number
  /** Words in the transcript (whitespace-split). Drives speech analytics. */
  wordCount?: number
  /** Wall-clock ms inside whisper-cli. Present whenever transcription ran, including
   *  when it failed. Feeds `listen_completed.transcribe_ms`. */
  transcribeMs?: number
  /** Which engine produced the transcript. Feeds `listen_completed.engine`. */
  transcribeEngineRan?: TranscribeEngineRan
  /** True when parakeet failed and whisper produced this. Feeds `listen_completed.fell_back`. */
  transcribeFellBack?: boolean
  /** Ms from "audio finalized" to "transcript in hand" — the wait the user actually
   *  sees. Feeds `listen_completed.total_ms`. */
  processingMs?: number
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

// ── Media library ───────────────────────────────────────────────────────────
/** Capture kind, derived from the folder prefix (rec- / shot- / listen-). */
export type MediaKind = 'screenshot' | 'recording' | 'listen'

export type MediaSource = 'app' | 'os'

export interface MediaItem {
  folder: string
  /** Where the row came from (gates delete + enrich behavior). Absent = 'app'. */
  source?: MediaSource
  kind: MediaKind
  /** Capture time, ISO-8601, parsed from the folder name. */
  ts: string
  run_id?: string
  /** The note the user left on this capture (FeedbackEntry.note, joined by run_id). */
  note?: string
  /** file:// or media:// URL to the primary visual (png/mp4), if any. */
  imagePath?: string
  videoPath?: string
  audioPath?: string
  /** Full transcript text, if a transcript.txt exists. */
  transcript?: string
  durationS?: number
  wordCount?: number
  /** Frontmost app at capture time, from the context file. */
  frontApp?: string
  windowTitle?: string
  browserUrl?: string
  /** Total bytes of the folder's media files. */
  sizeBytes: number
  /** Cached enrichment, if it's been computed (insights.json present). */
  insights?: MediaInsights
  /** Cached amplitude peaks (0..1) from waveform.json. Scanning never decodes. */
  waveform?: number[]
}

export interface RetranscribeResult {
  ok: boolean
  /** The refreshed row (new transcript + wordCount). Present only when ok. */
  item?: MediaItem
  /** Human-readable failure to show in the detail pane. */
  error?: string
}

export interface MediaInsights {
  /** Schema version — bump when the enrichment shape changes (re-compute). */
  v: number
  /** ISO-8601 of when enrichment ran. */
  ts: string
  /** On-screen text via Vision OCR (screenshot) or deduped video-frame OCR. */
  ocrText?: string
  /** Ranked keyword phrases (RAKE) from transcript + ocrText. The chips. */
  tags: string[]
  /** For video: how many frames were sampled + OCR'd (so the UI can say so). */
  framesOcr?: number
}

export interface AgentSessionEntry {
  ts: string
  kind: 'started' | 'archived'
  source?: 'phone' | 'mac'
}

export interface AgentSessionsData {
  started: number
  archived: number
  byBucket: { label: string; started: number; archived: number }[]
}

export interface AgentSpendTotals {
  usd: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface AgentSpendData extends AgentSpendTotals {
  sessions: number
  byBucket: (AgentSpendTotals & { label: string })[]
}

export interface SpeechEntry {
  ts: string
  run_id?: string
  /** Whitespace-split word count of the transcript. */
  words: number
  /** Recording length in seconds. */
  duration_s: number
  /** Transcript character count. */
  chars: number
  ok?: boolean
}

/** One probe step (binary present, logged in) with its own pass/fail. */
export interface BackendCheck {
  label: string // "CLI installed", "Logged in"
  ok: boolean
  detail: string // "claude 2.1.156", "dev@example.com (max)", or the error
}

export interface BackendTestResult {
  ok: boolean // all checks passed
  checks: BackendCheck[]
  advice: string | null // what to do if something failed, e.g. "Run: claude /login"
}

export interface BackendProbeRecord {
  result: BackendTestResult
  at: number
  canDisconnect: boolean
}

/**
 * What the one-click setup can do for a local backend right now.
 *
 * Derived in main and sent whole, so the renderer never re-infers a button label
 * from a pile of booleans. `action` is what the button does; `null` means there
 * is nothing to click and `detail` explains why (needs a download, wrong Mac).
 */
export interface LocalSetupState {
  action: 'install' | 'start' | null
  /** Aliases the user has already pulled — Rapid-MLX can only serve these. */
  pulledModels: string[]
  detail: string | null
}

/** A live tick from a running setup. `percent` is deliberately approximate: brew
 *  and Metal shader compilation report nothing, so it's derived from elapsed time
 *  against a measured ceiling — enough to show the bar moving, never a promise. */
export interface LocalSetupProgress {
  backend: string
  phase: 'installing' | 'starting'
  message: string
  percent: number
  elapsedMs: number
}

/** What one model declares it can do — the probe result shared by the Ollama and
 *  Rapid-MLX capability lookups. */
export interface ModelCapabilities {
  vision: boolean
  tools: boolean
  thinking: boolean
}

/** One Ollama model the user has already pulled, with its declared capabilities.
 *  Shared shape between main (local-models.ts probes it) and renderer (Settings
 *  model dropdown displays it) — lives here, not in main/, so preload can type it. */
export interface LocalModel extends ModelCapabilities {
  /** Model identifier: an Ollama tag ("gemma3:27b") for the `local` backend, or a
   *  Rapid-MLX served alias ("qwen3-0.6b-4bit") for the `mlx` backend. */
  name: string
  /** Bytes on disk (from `ollama list`) for a soft RAM-fit warning. 0 when the
   *  source doesn't report size — Rapid-MLX's `/v1/models` gives no byte count. */
  sizeBytes: number
}

/** Payload pushed on CHANNELS.backendHealthWarning after a failed startup probe. */
export interface BackendHealthWarning {
  backend: BackendId
  result: BackendTestResult
}

export type RunFailReason =
  | 'error'
  | 'timeout'
  | 'out_of_credits'
  | 'stopped'
  /** Backend threw before a process existed (binary missing, bad path). */
  | 'spawn_failed'
  /** The paid backend rejected the run because nobody is signed in. */
  | 'signed_out'
  /** Server-side breakage (404/5xx) — a bad model id or a down proxy. Retrying
   *  cannot clear it, which is what separates this from 'error'. */
  | 'broken'
  /** Provider returned 429 / "rate limit" / "quota" — retry later, not a bug. */
  | 'rate_limited'

export interface HistoryEntry {
  schema_version: number
  run_id: string
  ts: string
  duration_s: number
  /** Same measure as duration_s at full precision. Rows written before this field
   *  existed only have the rounded seconds, so readers fall back to duration_s. */
  duration_ms?: number
  instruction: string
  mode: AppMode
  selection: string
  selection_chars: number
  result?: string
  result_chars?: number
  /** Why this run failed. Present on every `ok: false` row, absent when ok. */
  reason?: RunFailReason
  result_detail?: string
  turns?: Array<{ q: string; a: string }>
  turn_count?: number
  ok: boolean
  backend: string
  model: string
  ctx_attached: boolean
  /** By-kind count of attachments the user sent with this run (NOT context).
   *  Omitted when none, so old rows stay valid. */
  attachments?: AttachmentSummary
  front_app?: string | null
  window_title?: string | null
  browser_url?: string | null
  screenshot_path?: string | null
  prompt_file?: string
  out_file?: string
  run_dir?: string
  /** Where the run was initiated from. 'listen' = voice-initiated Ask/Act. */
  source?: string
  capture_kind?: CaptureKind
  suggested_text?: string
  final_text?: string
  edit_type?: EditType
  pipeline_id?: string
  session_id?: string
  run_state?: RunState
}

export type RunState = 'pending' | 'interrupted'

export type EditType = 'unchanged' | 'edited' | 'rewritten'

export type FeedbackRating = 'up' | 'down'

export interface FeedbackEntry {
  run_id: string
  rating: FeedbackRating | null
  /** Optional "what I expected instead" — the correction text fed back to the model. */
  note?: string
  /** Denormalized from the run so analytics can slice by mode/backend without a join. */
  mode?: string
  backend?: string
  ts: string
}

export type EstimateConfidence = 'low' | 'med' | 'high'
export interface DurationEstimate {
  /** Predicted total run time, milliseconds. */
  etaMs: number
  /** How many past runs backed the estimate (more = tighter). */
  sampleSize: number
  confidence: EstimateConfidence
}

export interface QuickAction {
  key: string
  label: string
  icon?: string
  mode: AppMode
  instruction: string
  require_url_host?: string
  system_extra?: string
  skill_path?: string
  /** Inline body — typed directly in the editor. When present, overrides skill_path. */
  body?: string
}

/** One discovered Claude Code skill — drives the chip-body slash autocomplete. */
export interface SkillInfo {
  /** Slash-command name, e.g. `gen-image` → typed as `/gen-image`. */
  name: string
  /** One-line summary from the skill's frontmatter (may be empty). */
  description: string
}

export interface ContextData {
  frontApp?: string | null
  windowTitle?: string | null
  browserURL?: string | null
  screenshotPath?: string | null
}

export interface RunContext {
  front_app?: string
  window_title?: string
  browser_url?: string
  /** Absolute path to the context screenshot — a REFERENCE, the image is not copied
   * into the folder (it's large + used once at run time; may be swept later). */
  screenshot_path?: string
  /** Size of the input selection (rewrite/ask). The text itself lands in input.txt. */
  selection_chars?: number
}

/** One delta-encoded point in a compressed mouse move trail: offset-from-previous-point in ms/px. */
export interface ContextLogMovePoint {
  dt: number
  dx: number
  dy: number
}

/** One line in the ambient context log (~/MightyMouse/context-log/*.jsonl). */
export interface ContextLogEvent {
  ts: string
  type: 'focus' | 'text' | 'click' | 'move'
  app: string | null
  title: string | null
  url: string | null
  /** Present only on `text` events; redacted before write. */
  text?: string
  /** Present only on `click` events. 'wheel' covers scroll. */
  button?: 'left' | 'right' | 'middle' | 'wheel'
  /** Present only on `click` events. */
  x?: number
  /** Present only on `click` events. */
  y?: number
  /** Present only on `move` events: the trail's starting point. */
  startX?: number
  /** Present only on `move` events: the trail's starting point. */
  startY?: number
  /** Present only on `move` events: delta-encoded points after the start. */
  points?: ContextLogMovePoint[]
}

export interface PanelState {
  runId: string
  selection: string
  history: Array<{ q: string; a: string }>
  /** First question of the current ask conversation — used as the History title. */
  sessionTitle?: string
  modeOverride: AppMode | null
  ctx: ContextData
  ctxOn: boolean
  finderFiles: string[]
  activeAction: QuickAction | null
}

export interface ResumeSessionResult {
  ok: boolean
  turns: Array<{ q: string; a: string }>
  /** The mode the resumed run actually ran in — the renderer adopts it as the
   *  mode override so the next turn keeps that mode's capabilities (an act
   *  continuation must stay act, not silently become a tool-less ask). */
  mode: AppMode
  /** How the run was originally started, when it began as a capture (a listen /
   *  recording / screenshot the user then asked or acted on). Carried so the
   *  chip can keep showing that origin instead of dropping it on resume. */
  capture_kind?: CaptureKind
  backend: BackendId
  sessionId?: string
}

export type PanelOpenTo =
  | 'history'
  | { type: 'conversation'; runId: string }
  // The selection bar's one-tap actions: the panel opens with `instruction`
  // already in the input and submits it, so the user never types anything.
  | { type: 'run'; instruction: string }

/**
 * One button on the selection bar. `instruction` is the literal prompt sent to
 * the backend against the captured selection — `null` means "just open the
 * panel and let the user type", which is what Ask does.
 */
export interface SelectionBarAction {
  key: string
  label: string
  instruction: string | null
}

/** main -> bar: how an inline run is going. `error` carries the line to show. */
export interface SelectionBarResultPayload {
  state: 'running' | 'done' | 'error'
  message?: string
  /** The rewrite, on `done`. Shown for review — the user accepts it before it
   *  reaches their document. */
  text?: string
  // Who is actually answering THIS run. Resent here because the gear menu can
  // flip the engine after the bar was shown.
  runLabel?: string
}

export interface SelectionBarShowPayload {
  actions: SelectionBarAction[]
  chars: number
  // Current fast-mode state, sent per show so the gear menu opens on the truth
  // even when the pref was changed from the Settings window.
  fast: boolean
  // The user's own backend, named, so the menu can offer it opposite Fast.
  backendLabel: string
  // Who answers a run in the bar — "MightyMouse API · Fast". Always ours: the
  // bar never spawns the user's CLI.
  runLabel: string
  ctxOn: boolean
  ctxApp: string
  ctxURL: string
  ctxLabel: string
}

export type WelcomeVariant = 'new' | 'returning'

export interface PanelInitData {
  selection: string
  placeholder: string
  lastInstr: string
  lastMode: AppMode | null
  ctxOn: boolean
  ctxLabel: string
  /** Front app name behind `ctxLabel`, unflattened — drives the context row's real
   *  app icon. Empty when there's no context. Kept separate from ctxLabel because
   *  that string is display-only (already joined with the host/title). */
  ctxApp: string
  /** Real page URL behind `ctxLabel` (empty for non-browser apps or a junk URL) —
   *  drives the favicon badge on the corner of the app icon. */
  ctxURL: string
  actions: QuickAction[]
  backend: string
  /** The selected Ollama model tag (e.g. "gemma3:4b") when backend is `local`.
   *  Empty for cloud backends. Drives the panel chip so a local run shows WHICH
   *  model is answering, not just "Local". */
  ollamaModel: string
  /** The selected Rapid-MLX model alias (e.g. "qwen3-0.6b-4bit") when backend is
   *  `mlx`. Empty otherwise. Drives the panel chip so a Rapid-MLX run shows WHICH
   *  model is answering, mirroring ollamaModel for the `local` backend. */
  mlxModel: string
  /** The per-conversation model pick for the paid `mightymouse` backend (an
   *  OpenRouter slug from CONFIG.MODEL_CATALOG), or empty for "server default".
   *  Seeds the panel's model dropdown on mount/reseed so the choice persists. */
  selectedModel: string
  cursorOn: boolean
  /** Whether the feedback loop is on — gates the 👍/👎 UI in the History flyout. */
  feedbackEnabled: boolean
  /** Incognito mode on — drives the panel's "not logging" badge. Kept live via
   *  the `incognitoChanged` broadcast (tray/Settings toggles update it instantly). */
  incognito: boolean
  /** History-panel kind filter: the run kinds the user has HIDDEN (CSV-backed pref).
   *  Empty = show everything. Seeds the History flyout's filter on mount/reseed so
   *  the choice persists across sessions. Values are RunKind strings. */
  historyFilterHidden: string[]
  /** Mighty conversation-sidebar filter: the sources the user has HIDDEN. Empty =
   *  show everything. Values are MightyRunSource strings. */
  mightySourceFilterHidden: string[]
  /** Sidebar lists conversations nothing was ever sent in. Defaults false — see
   *  PATHS.MIGHTY_SHOW_EMPTY_PREF for why this one inverts the pref above. */
  mightyShowEmpty: boolean
  /** Unsubmitted composer text from a prior session, restored so a draft survives
   *  a Panel remount (see PREFS.setDraftInput). Empty = no draft pending. */
  draftInput: string
  /** The quick-action key selected when the draft above was saved, so reselecting
   *  the draft also restores which action (and its mode) was active. Empty = none. */
  activeActionKey: string
  openTo?: PanelOpenTo
  welcome?: WelcomeVariant
  checklist: ActivationChecklist
}

/** "Finish setup" panel card — every field derives from real app state (permission
 *  bridges, run/transcribe/pair latches), never a hand-set flag. See
 *  buildActivationChecklist() in main/activation-checklist.ts.
 *
 *  backendConnected is NOT here: it needs a real CLI probe (probeBackend), too
 *  expensive to run on every panelReseed (every hotkey press while the panel is
 *  open). The renderer already runs that probe once per mount via
 *  panelProbeBackend() for the health-warning banner — the checklist reuses that
 *  same result instead of a second spawn. */
export interface ActivationChecklist {
  permissionsGranted: boolean
  firstRunDone: boolean
  transcribeDone: boolean
  phonePaired: boolean
  /** Not a step — the user has seen the list at 5/5. Gates the header ring's
   *  disappearance so a step completed off-screen can't retire it unseen. */
  seenDone: boolean
}

// ── Persisted user settings ──────────────────────────────────────────────────
export interface StoredSettings {
  ffmpegPath: string
  whisperPath: string
  whisperModelPath: string
  videoDevice: string
  audioDevice: string
  /** Whisper language code ('en', 'es', 'he', …). Picks the model too — see whisperModelFor. */
  whisperLang: string
  /** Which engine transcribes. Exists as the one-line rollback, not as an
   *  opt-in — there is no settings row for it. */
  transcribeEngine?: TranscribeEngineRan
  /** "Let Siri see your Mac's screen" — gates the screenshot an App Intent takes
   *  with nobody at the keyboard. On by default (Roy, 2026-09-15): the curtain and
   *  away-mode guards already cover the case this would protect, and a default-off
   *  toggle makes the headline phrase dead on arrival for every new user.
   *  A screenshot cannot be scrubbed — redact.ts is text-only — so this switch is
   *  the whole privacy boundary. */
  siriScreenAnswer?: boolean
  /** Off by default: the panel hotkey, tray and Dock open the main window instead. */
  smallPanel?: boolean
  holdForSmartDictation?: boolean
  advancedMode?: boolean
  webAccess?: boolean
  codeOwnCopy?: boolean
  transcriptFormats?: Record<string, boolean>
}

// ── Analytics ────────────────────────────────────────────────────────────────

export type AnalyticsRange = 'daily' | 'weekly' | 'monthly' | 'alltime'

export interface HeatCell {
  week: number
  day: number
  count: number
  listens: number
  captures: number
  label: string
}

/** Granularity of the range-aware time series: hour buckets for "Today",
 *  day buckets for week/month, week buckets for all-time. Drives axis labels. */
export type SeriesGranularity = 'hour' | 'day' | 'week'

/** One range-aware time-series bucket. `label` is built server-side (the axis /
 *  tooltip text) so the renderer never re-derives dates from an index. `key` is a
 *  stable id (hour `0–23`, `YYYY-MM-DD`, or `YYYY-MM-DD` week-start). */
export interface SeriesBucket {
  key: string
  label: string
  count: number
  ok: number
  avgDur: number
  chars: number
  /** Per-mode run counts in this bucket, for the rewrite/ask/act-over-time chart. */
  modes: Record<AppMode, number>
  /** Listen (dictation) runs in this bucket. Lives alongside `count` (runs) so the
   *  Activity chart can stack runs + listens — our two main interactions. */
  listens: number
  /** Screenshot + recording captures in this bucket. Its own lane like `listens`
   *  so captures show in tooltips without inflating the run count. */
  captures: number
}
export interface ModeBucket {
  mode: AppMode
  count: number
}
export interface AppBucket {
  app: string
  count: number
}
export interface ModelBucket {
  model: string
  count: number
}
/** A suggestion's end-state. Mirror of SuggestionDecision in outcome-store.ts —
 *  kept here so the renderer can type the breakdown without importing from main. */
export type SuggestionDecisionId = 'accepted' | 'rejected' | 'superseded' | 'ignored'
export interface DecisionBucket {
  decision: SuggestionDecisionId
  count: number
}
export interface DurBucket {
  label: string
  count: number
}
export interface HourBucket {
  hour: number
  count: number
}

/** Dictation metrics, derived from speech.jsonl. Null when no listen runs yet. */
export interface SpeechData {
  sessions: number
  totalWords: number
  totalSeconds: number
  /** Words per minute across all dictation (totalWords / totalMinutes). */
  avgWpm: number
  /** Per-day words spoken, same window/clamp as runsByDay. */
  wordsByDay: { date: string; words: number }[]
}

export interface SuggestionsData {
  /** Funnel: total shown, of which accepted (the rest were dismissed). */
  shown: number
  accepted: number
  dismissed: number
  /** accepted / shown. 0 when nothing was shown. */
  acceptRate: number
  /** The decision made on each shown suggestion, split by outcome. Counts sum to
   *  `shown`. Legacy rows with no `decision` are inferred from `accepted`. */
  byDecision: DecisionBucket[]
  /** What the user picks — accepted suggestions split by mode (write/ask/act). */
  byMode: ModeBucket[]
  /** Where suggestions land most (by front app), most-shown first. */
  topApps: AppBucket[]
  /** Generation latency across suggestions that carry a `gen_ms` (legacy rows
   *  without it are excluded). null when none have timing yet. */
  gen: SuggestionGenStats | null
}

export interface SuggestionGenStats {
  /** Rows that carried a gen_ms (the sample size behind these numbers). */
  samples: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  /** Per-bucket avg generation time, aligned to AnalyticsData.series buckets, so
   *  the UI can chart latency over time at whatever range is picked. Buckets with
   *  no timed suggestion have avgMs 0. */
  series: { key: string; label: string; avgMs: number; count: number }[]
  /** Distribution of gen times across timed suggestions, bucketed by latency
   *  (not by date) — the SPREAD of how fast generations are. More useful than the
   *  over-time line: "most land in 1–2s, a few 5s+" reads at a glance. */
  distribution: { label: string; count: number }[]
}

export interface AnalyticsData {
  totalRuns: number
  /** Listen (dictation) runs in range. Tracked separately from `totalRuns` —
   *  pure speech-to-text never inflates the LLM run KPIs — but surfaced as a
   *  first-class interaction (runs + listens are our two main interactions). */
  totalListens: number
  /** Screenshot + recording captures in range. Like `totalListens`, kept out of
   *  `totalRuns` (a capture isn't an LLM run) but surfaced as its own KPI. */
  totalCaptures: number
  successRate: number
  avgDurationS: number
  totalCharsGenerated: number
  totalCharsInput: number
  avgTurnCount: number
  currentStreak: number
  longestStreak: number
  ctxAttachedPct: number
  estimatedMinsSaved: number
  topModel: string
  /** Full model breakdown for the range, most-used first. Lets the UI show the
   *  whole mix ("you switch models") instead of only the single top model. */
  byModel: ModelBucket[]
  /** Range-aware time series: 24 hourly buckets (Today), 7/30 daily (week/month),
   *  or 52 weekly (all-time). Drives the trend charts at every range, and the
   *  Activity grid for non-all-time ranges. */
  series: SeriesBucket[]
  /** Granularity of `series` — picks the right axis labels in the renderer. */
  granularity: SeriesGranularity
  /** GitHub-style 52-week daily calendar. Populated ONLY for the all-time range
   *  (where a day-textured calendar is meaningful); empty for narrower ranges,
   *  which render the `series` strip instead. */
  heatmap: HeatCell[]
  byMode: ModeBucket[]
  topApps: AppBucket[]
  durationBuckets: DurBucket[]
  byHour: HourBucket[]
  firstRunTs: string | null
  lastRunTs: string | null
  dataSpanDays: number
  /** Dictation metrics. Null when the user has no listen runs yet. */
  speech: SpeechData | null
  agentSessions: AgentSessionsData | null
  agentSpend?: AgentSpendData | null
  /** Proactive cursor-suggestion metrics (its own block). Null when the user has
   *  never been shown a suggestion in range. */
  suggestions: SuggestionsData | null
  /** Explicit-feedback (👍/👎 + corrections) metrics. Null when the user has never
   *  rated a run in range — the whole section hides. The eval surface for the
   *  feedback loop: approval/issue/coverage ratios over time. */
  feedback: FeedbackData | null
}

export interface FeedbackSeriesBucket {
  key: string
  label: string
  runs: number
  up: number
  down: number
  /** down-votes that carried a note (the actionable corrections). */
  corrections: number
  /** up-votes that carried a note (the reinforcing praises). */
  praises: number
}

/** Aggregate explicit-feedback metrics + the over-time series that drive the
 *  Feedback & learning section's charts. Mirrors SuggestionsData's shape: range-
 *  aware KPIs up top, a per-bucket series below. */
export interface FeedbackData {
  /** Headline counts in range. */
  up: number
  down: number
  corrections: number
  /** up-votes that carried a note (the reinforcing praises). */
  praises: number
  /** Runs that got any rating (up or down). `rated / runs` = coverage. */
  rated: number
  totalRuns: number
  /** up / (up + down). 0 when nothing rated. The core "is it good" number. */
  approvalRate: number
  /** rated / totalRuns. How much of activity gets feedback at all. */
  ratedCoverage: number
  /** Change in approvalRate from the first rated bucket to the last (percentage
   *  POINTS, e.g. +0.18 = up 18pt). 0 when fewer than 2 rated buckets — the
   *  "📈 trend" KPI chip. */
  trendDelta: number
  /** Per-bucket series for the charts. Same length/order as AnalyticsData.series. */
  series: FeedbackSeriesBucket[]
  recent: { instruction: string | null; note: string; mode: AppMode; rating: FeedbackRating }[]
}

/** Inputs the async AI-insight call needs, surfaced by buildAnalyticsData so the
 *  renderer can request the (slow) insight separately without recomputing stats. */
export interface AnalyticsInsightSeed {
  totalRuns: number
  successRate: number
  avgDurationS: number
  totalCharsGenerated: number
  topApp: string
  topMode: string
  currentStreak: number
}

export interface KeyCount {
  key: string
  count: number
}
export interface DayCount {
  date: string
  count: number
}
/** Success rate over a slice of runs: ok of total, rate in [0,1]. */
export interface RateRow {
  key: string
  ok: number
  total: number
  rate: number
}
/** Latency percentiles (ms) for a backend slice. */
export interface LatencyRow {
  key: string
  p50: number
  p95: number
  samples: number
}
export interface CohortRow {
  cohort: string
  size: number
  funnel: { step: string; pct: number }[]
  retention: (number | null)[]
}

export interface AdminErrorRow {
  ts: string
  kind: string
  source: string
  message: string
  /** Truncated to ~2KB in the edge fn; null when the thrower gave us none. */
  stack: string | null
  appVersion: string | null
  platform: string | null
  userId: string | null
  /** Resolved from user_id via the admin user list; null for anonymous rows. */
  userEmail: string | null
  anonId: string | null
  sessionId: string | null
  props: Record<string, unknown>
}

/** The same bug seen N times, collapsed. `versions` is what reveals a regression. */
export interface AdminErrorGroup {
  fingerprint: string
  kind: string
  source: string
  message: string
  count: number
  /** Distinct people affected — separates "my machine" from "everyone". */
  userCount: number
  firstSeen: string
  lastSeen: string
  versions: KeyCount[]
  sample: AdminErrorRow
  occurrences: AdminErrorRow[]
}

export interface BuilderRung {
  label: string
  event: string
  users: number
}

export interface AdminStats {
  rangeDays: number
  generatedAt: string
  release_emails?: ReleaseEmailStats[]
  errors: {
    total: number
    byKind: KeyCount[]
    bySource: KeyCount[]
    byDay: DayCount[]
    groups?: AdminErrorGroup[]
    latest: AdminErrorRow[]
  }
  bugReports?: {
    total: number
    open: number
    byStatus: KeyCount[]
    byDay: DayCount[]
    /** Median age of the open queue, in days. */
    medianOpenAgeDays: number
    reports: AdminBugReport[]
  }
  // Real signed-up user roster (auth.users), newest first, capped at 500. Optional:
  // an env whose admin-stats fn predates this field omits it. Distinct from
  // `signups` below, which is an event-count proxy, not an actual per-user list.
  users?: {
    total: number
    // plan/balance/spend/runs are OPTIONAL per row on purpose: an env still
    // running the pre-People-tab admin-stats fn returns rows without them, and
    // the table must degrade to '—' rather than render NaN or crash.
    rows: {
      email: string
      createdAt: string
      lastSignInAt: string | null
      /** Newest event, all-time — the real "last active". Distinct from
       *  lastSignInAt, which a long-lived session freezes at signup. Optional
       *  for the same reason as the money fields: an env on the older fn omits
       *  it, and the surfaces fall back rather than rendering "never". */
      lastEventAt?: string | null
      plan?: UserPlan
      /** Live wallet, cents. All-time (credit_balances), not window-bounded. */
      balanceCents?: number
      /** All-time topups in cents — what this person has actually paid us. */
      spentCents?: number
      /** All-time metered LLM spend charged against their credits, in cents. */
      burnedCents?: number
      /** All-time count of metered runs (usage_events rows). */
      runs?: number
      /** How far this person got. ALL-TIME, never range-bounded: on a 24h
       *  window every user would otherwise read 'signed_up', which is worse
       *  than no column. Optional — an env on the pre-0030 fn omits it. */
      stage?: UserStage
      /** Their email was on the landing-page waitlist before they signed up.
       *  A marker, not a rung — see {@link UserStage}. */
      viaWaitlist?: boolean
      /** They minted a phone-remote credential at least once (`phone_device_paired`).
       *  A marker, not a rung — reconnect storms do not change this. */
      phonePaired?: boolean
      nudges?: LifecycleNudge[]
      digest?: DigestFlag
      journey?: UserJourney
    }[]
  }
  // Landing-page waitlist ("Get Early Access" form). Optional: an env whose
  // admin-stats fn predates this field, or one without migration 0007, omits it.
  // allTime = lifetime list size (range-independent); inRange/byDay use the window.
  waitlist?: {
    allTime: number
    inRange: number
    byDay: DayCount[]
    byPlatform: KeyCount[]
    bySource: KeyCount[]
    rows?: {
      email: string
      platform: string | null
      createdAt: string
      source?: string | null
      /** True when this waitlist email now has a real signed-up account. */
      converted?: boolean
      /** When the welcome/download email went out, or null if it didn't (no
       *  Resend key at signup, or the send threw). Absent (undefined) on an env
       *  whose admin-stats fn or DB predates the email_sent_at column. */
      emailedAt?: string | null
      nudgeStatus?: string | null
      /** When it went out, falling back to when it was drafted/queued for a row
       *  that hasn't sent yet. */
      nudgedAt?: string | null
      /** True only once it actually sent — a draft is not a send. */
      nudgeSent?: boolean
      /** Which subsystem sent it: 'auto' = the scheduled nudge, 'human' = an
       *  admin's Reach out. Null when neither has. */
      nudgeBy?: 'auto' | 'human' | null
      /** Hours from the nudge landing to the account existing, or null if either
       *  never happened. Temporal order only: this does NOT claim the email
       *  caused the signup. */
      convertedAfterH?: number | null
      /** Furthest rung reached after converting, from the same ladder the People
       *  roster uses. Undefined when the address never became an account, or on
       *  an env whose fn predates this field — both render '—', never a rung. */
      stage?: UserStage
    }[]
  }
  // Acquisition / UTM attribution. Where signups come from: source/medium/campaign
  // rank bars (windowed) + a redemption funnel (all-time) joining waitlist emails →
  // signed-in users → payers. Optional: an env whose admin-stats fn predates this.
  acquisition?: {
    landingPageFunnel?: { path: string; signups: number; paid: number; paidPct: number }[]
    campaignFunnel?: {
      key: string
      platform: string | null
      visitors: number
      signups: number
      activated: number
      paid: number
      revenue: number
      signupPct: number
      paidPct: number
    }[]
    /** False when the underlying reads failed, so the UI can distinguish
     *  "query broke" from a genuine "no campaigns yet". */
    campaignFunnelAvailable?: boolean
    /** Same join as campaignFunnel at the utm_content grain — which CREATIVE
     *  earned the money, not just which campaign. `key` is "campaign / content".
     *  Untagged traffic is excluded, so this never sums to the campaign totals. */
    adFunnel?: {
      key: string
      platform: string | null
      visitors: number
      signups: number
      activated: number
      paid: number
      revenue: number
      signupPct: number
      paidPct: number
    }[]
    adFunnelAvailable?: boolean
    bySource: KeyCount[]
    byMedium: KeyCount[]
    byCampaign: KeyCount[]
    byReferrer: KeyCount[]
    funnel: { stage: string; count: number }[]
    // Attribution coverage: how many signed-up users we can tie to a source.
    // totalUsers/unattributedUsers are counts; attributedPct is 0–100.
    totalUsers: number
    unattributedUsers: number
    attributedPct: number
  }
  referrals?: {
    /** referral_leaderboard: one row per referrer, all-time. */
    leaderboard?: {
      referrer_email: string
      referral_code: string
      /** All-time signups landed by this referrer (not range-bounded). */
      referrals: number
      referrals_paid: number
      referrals_unpaid: number
      earned_cents: number
      gifted_cents: number
      referrals_active: number
      referees_spent_cents: number
      last_referral_at: string | null
    }[]
    funnel?: {
      codes_issued: number
      tagged_referral: number
      tagged_expired: number
      attributed: number
      paid: number
      became_active: number
      total_paid_out_cents: number
      referees_spent_cents: number
    } | null
    pairs?: {
      referee_id: string
      referee_email: string
      referee_signed_up_at: string
      referrer_id: string
      referrer_email: string | null
      referral_code: string
      referee_paid_cents: number | null
      referrer_paid_cents: number | null
      referee_was_paid: boolean
      referrer_was_paid: boolean
      referee_usage_events: number
      referee_spent_cents: number
    }[]
    /** True when the 200-row pairs cap was hit — the list is a recent sample,
     *  not the full history, and the UI must say so rather than imply completeness. */
    pairsTruncated?: boolean
    drift?: {
      user_id: string
      email: string
      balance_cents: number
      ledger_cents: number
      drift_cents: number
    }[]
  } | null
  revenue: {
    grossRevenue: number
    refunded: number
    llmCost: number
    margin: number
    payingUsers: number
    topupCount: number
    byDay: DayCount[]
    byPack: KeyCount[]
    byModel: KeyCount[]
    activeSubscriberCount?: number
    subscriptionMrr?: number
    oneTimeRevenue?: number
    lifetime?: {
      revenue: number
      soldCount: number
      configSoldCount: number
      cap: number
      enabled: boolean
      refundedCount: number
    }
  }
  signups: {
    total: number
    uniqueUsers: number
    byDay: DayCount[]
  }
  // Portal (app.getmightymouse.com) reach: distinct people per event; newAccounts is auth.users created in range.
  webApp?: {
    builderFunnel: { ladder: BuilderRung[]; side: BuilderRung[] }
    newAccounts: number
    newAccountsByDay: DayCount[]
    chatViewed: number
    previewViewed: number
    codeOpened: number
    messageSent: number
    paywallShown: number
    checkoutStarted: number
  }
  funnel: { step: string; users: number }[]
  purchaseFunnel: { step: string; users: number }[]
  cohorts: {
    curveLen: number
    day: CohortRow[]
    week: CohortRow[]
    activation: {
      activatedUsers: number
      totalUsers: number
      medianDays: number
      p90Days: number
    }
  }
  /** Stripe return split: completed vs cancelled. */
  checkoutReturns: { success: number; cancel: number }
  usage: {
    totalRuns: number
    byMode: KeyCount[]
    byBackend: KeyCount[]
    byDay: DayCount[]
  }
  // Did it work + how fast — derived from run_completed. rate is ok/total in [0,1].
  reliability: {
    total: number
    ok: number
    rate: number
    byMode: RateRow[]
    byBackend: RateRow[]
    failReasons: KeyCount[]
    // What KIND of runs: output size, turn depth, context-attach rate, source mix.
    shape: {
      avgCharsOut: number
      avgTurns: number
      ctxAttachRate: number
      bySource: KeyCount[]
    }
  }
  latency: {
    samples: number
    p50: number
    p95: number
    byBackend: LatencyRow[]
  }
  // Distinct users per setting key, plus voice/capture usage totals.
  adoption: {
    settings: KeyCount[]
    voice: {
      recordings: number
      listens: number
      screenshots: number
      totalWords: number
      voiceUsers: number
      /** Mac hotkey vs phone hold-to-speak. Optional: rows predating the `source`
       *  prop have no split, and an older edge fn deploy omits the field entirely. */
      listensBySource?: KeyCount[]
    }
    /** Setup-check health: how many installs are usable, and what's blocking the
     *  rest. Optional — an edge fn deployed before setup_diagnostic omits it. */
    setup?: SetupHealthStats
  }
  traffic?: TrafficStats | null
  // Phone Remote funnel. Optional so a client running ahead of the deployed edge
  // fn renders a "redeploy" hint instead of crashing on undefined — same
  // contract as `adoption`/`traffic` above.
  phoneRemote?: PhoneRemoteStats | null
  codeSessions?: CodeSessionStats | null
  // The native iPhone app's funnel. Same optional contract as phoneRemote: a
  // client ahead of the deployed edge fn hides the section rather than reporting
  // zero installs, which is a different claim from "we didn't ask".
  ios?: IosAppStats | null
  // Install → first-value funnel, per signed-up user, all-time. Optional under
  // the same contract as the sections above.
  activation?: ActivationStats | null
}

export interface ActivationStats {
  /** False when the user_stages table is unreadable. The UI must show a gap
   *  rather than a ladder of zeros, which would claim nobody ever launched. */
  available: boolean
  /** Whether admin accounts are counted. Default false — at low volume one
   *  admin account can outweigh every real user. */
  includeInternal: boolean
  /** How many accounts the internal filter removed (0 when includeInternal). */
  excludedInternal: number
  funnel: { step: string; users: number }[]
  /** Setup board health, reported separately from the funnel: only users who
   *  actually opened the panel are counted, so `reported` is the honest
   *  denominator. */
  setup: { green: number; reported: number }
  /** Tour completion, out of everyone who launched. Skippable, so a low number
   *  here is not automatically a loss — cross-read it with the funnel. */
  onboarding: { completed: number; launched: number }
  /** Precomputed drops, so the UI names each loss without re-deriving it. */
  lost: {
    neverLaunched: number
    stalledInOnboarding: number
    neverSucceeded: number
  }
  /** Setup checks ranked by how many users they currently block, with whether
   *  the in-app self-fix actually rescues them. */
  blockers: {
    check: string
    usersAffected: number
    usersStillBlocked: number
    fixTried: number
    fixWorked: number
  }[]
  /** Everyone who signed up and never reached a good run — the email list. */
  stuck: {
    email: string
    createdAt: string
    stage?: string
    blockedOn: string[]
  }[]
}

export interface SetupHealthStats {
  /** Installs that reported a settled board in range (the denominator). */
  reported: number
  /** Nothing blocking. `optional` failures (e.g. no mic) count as healthy. */
  healthy: number
  /** At least one blocking check failing — the population that can't work. */
  blocked: number
  /** Which check id is blocking, ranked. Sums above `blocked` when one install
   *  is stuck on two things — that's intended, it's per-dependency demand. */
  blockedBy: KeyCount[]
  /** `<checkId>:<fixKind>:<ok|fail>` across all rows — did the button work. */
  fixOutcomes: KeyCount[]
}

export interface CodeSessionDay {
  date: string
  started: number
  archived: number
}

export interface CodeSessionStats {
  started: number
  archived: number
  activeUsers: number
  startedPerUser: number
  archivedBySource: KeyCount[]
  byDay: CodeSessionDay[]
}

export interface PhoneRemoteStats {
  /** The four headline funnel stages, in order, for the Funnel primitive. */
  funnel: { step: string; users: number }[]
  /** Distinct users who turned the setting on in range. */
  enabledUsers: number
  /** Distinct users whose phone actually connected. The step that was invisible. */
  pairedUsers: number
  /** Distinct users who did anything at all once paired (moved/clicked/spoke/chatted). */
  activeUsers: number
  returningUsers: number
  /** Sessions that connected and did literally nothing — the drop-off cohort. */
  idleSessions: number
  /** Total completed phone sessions in range (idle included). */
  totalSessions: number
  /** Median session length in seconds; 0 when there are no sessions. */
  medianSessionS: number
  /** First pairs (reconnect:false) vs reconnects — pairing churn at a glance. */
  firstPairs: number
  reconnects: number
  /** LAN vs tunnel split of pair events. Reads as "tunnel available", not "used". */
  byTransport: KeyCount[]
  /** Interaction totals across all sessions in range. */
  totals: { moves: number; clicks: number; voiceRuns: number; chatTurns: number }
  /** Pairs per day, for the trend chart. */
  byDay: DayCount[]
}

export interface IosAppStats {
  /** installed → signed in → paired → returned, for the Funnel primitive. */
  funnel: { step: string; users: number }[]
  /** Distinct installs that opened the app in range (anon_id = one install). */
  installedUsers: number
  signedInUsers: number
  pairedUsers: number
  /** Installs that opened the app on 2+ SEPARATE DAYS — the habit signal. */
  returningUsers: number
  /** Signed in on the phone AND ran the Mac app. Joined on user_id: the two
   *  installs have different anon_ids, so an anon join is always zero. */
  bothSurfaceUsers: number
  /** Cold starts (the install proxy) vs every foreground (the DAU signal). */
  coldLaunches: number
  totalLaunches: number
  /** Ranked failure reasons — the top bar is the thing to go fix. */
  pairFailReasons: KeyCount[]
  signInFailReasons: KeyCount[]
  /** Bonjour sweep results. 'blocked' = Local Network permission denied. */
  discoveryOutcomes: KeyCount[]
  /** Adoption per build, so a fix's uptake is visible without a store report. */
  byVersion: KeyCount[]
  /** Cold launches per day, for the trend chart. */
  byDay: DayCount[]
}

export interface SurfaceTraffic {
  /** CF requestHost this block covers, e.g. 'app.getmightymouse.com'. */
  host: string
  pageloads: number
  byDay: DayCount[]
  byReferrer: KeyCount[]
  byPage: KeyCount[]
  byCountry: KeyCount[]
}

/** Landing-only beacon aggregates (pageviews table). Distinct from CF pageloads. */
export interface LandingTrafficStats {
  /** Every human landing pageview in range (same person can count many times). */
  pageviews: number
  /** Distinct visitor_hash values in range — deduped people, not pageloads. */
  uniqueVisitors: number
  byDay: DayCount[]
  byCountry: KeyCount[]
  byReferrerClass: KeyCount[]
  byDevice: KeyCount[]
  byBrowser: KeyCount[]
  byOS: KeyCount[]
}

export interface TrafficStats {
  pageloads: number
  byDay: DayCount[]
  byCountry: KeyCount[]
  byReferrer: KeyCount[]
  byPage: KeyCount[]
  byDevice: KeyCount[]
  byBrowser: KeyCount[]
  byOS: KeyCount[]
  // Which MM host the loads hit (landing vs portal split).
  byHost: KeyCount[]
  /** Per-surface blocks (landing, portal). Optional: an env whose admin-stats fn
   *  predates the Traffic tab omits it, and the UI falls back to merged charts. */
  bySurface?: SurfaceTraffic[]
  /** Our beacon on getmightymouse.com — UTM, variant, deduped visitors. Optional
   *  when admin-stats predates the landing band or pageviews is empty. */
  landing?: LandingTrafficStats
}

// IPC message structures
export interface SubmitPayload {
  q: string
  mode: AppMode
  ctx: boolean
  source: string
  /** User-attached media (images / files / audio). Audio is transcribed pre-run. */
  attachments?: MediaAttachment[]
  /** The Mighty session this ask is a follow-up on (panel's sessionIdRef), so main
   *  appends to the SAME session instead of minting a new one. Undefined on the
   *  first turn of a conversation (or for rewrite/act, which never bind a session). */
  sessionId?: string
}

export interface ActionSelectPayload {
  key: string
}

export interface ModeOverridePayload {
  mode: AppMode
}

export interface SuggestionAcceptPayload {
  index: number
  finalText?: string
}

export interface ResizePayload {
  h: number
  inChat?: boolean
}

export interface CopyPayload {
  text: string
}

export interface CtxTogglePayload {
  on: boolean
}

export interface DraftInputPayload {
  text: string
}

/** Result of the mightymouse:// checkout deep link bouncing back to the app. */
export type CheckoutReturnStatus = 'success' | 'cancel'

export type BillingItemKind = 'pack' | 'plan' | 'lifetime'

export const LIFETIME_ERROR = {
  disabled: 'lifetime_disabled',
  soldOut: 'lifetime_sold_out',
  alreadyOwned: 'already_lifetime'
} as const

export interface LifetimeOffer {
  available: boolean
  alreadyOwned: boolean
  priceCents: number
  creditsCents: number
}

/**
 * Which limit sent the user to the upgrade window. Carried through the whole
 * funnel (upgrade_opened → checkout_started → checkout_returned) so "which limit
 * actually converts" is one query instead of guesswork.
 */
export type UpgradeReason =
  | 'phone_remote_minutes'
  | 'credits_empty'
  | 'settings'
  | 'panel'
  | 'onboarding'

/** What `billingOpenCheckout` sends: which item, and whether it's a pack or a plan. */
export interface BillingCheckoutItem {
  kind: BillingItemKind
  id: string
  /** Which limit sent the user here. Analytics only — never forwarded to Stripe. */
  reason?: UpgradeReason
}

export interface SubscriptionStatus {
  status: string
  planId: string | null
  currentPeriodEnd: string | null
}

export interface BusyPhasePayload {
  phase: string
  detail: string
  source: 'node'
  /** Predicted run duration (ms) for the busy overlay's ETA bar; 0/absent = no bar. */
  etaMs?: number
  /** Run id of the in-flight ask, so the panel can track it client-side and hand it
   *  to Mighty on expand (live-handoff). Present from the first phase of every run. */
  runId?: string
  /** The Mighty session this ask is already linked to (ask mode only), so the panel
   *  can bind to it and receive live turn updates without a separate handoff step. */
  sessionId?: string
}

export interface AnswerPayload {
  q: string
  a: string
  /** Run id of the ask that produced this answer — mirrors BusyPhasePayload.runId so
   *  the panel keeps a live id even if it only ever saw the answer, not the phases. */
  runId?: string
}

export interface ActResultPayload {
  summary: string
  /** Path to reveal in Finder (file or run dir); null = nothing to open. */
  revealPath: string | null
  /** True when revealPath is the run FOLDER (no specific output file) — drives the
   *  button label ("Open run folder" vs "Show in Finder"). */
  revealIsDir?: boolean
  ok: boolean
}

export interface HistoryItem {
  run_id: string
  instruction: string
  mode: RunKind
  ts: string
  backend: string
  selection_preview: string
  /** Full result text, so history can show + copy + re-paste a past run's output. */
  result?: string
  /** Full multi-turn conversation, so an expanded history row renders the whole thread. */
  turns?: Array<{ q: string; a: string }>
  ok: boolean
  run_state?: RunState
  open_path?: string
  /** How long the run took, in ms. Absent on rows written before runs were timed. */
  duration_ms?: number
}

/** One row on the selection bar's own History list. Deliberately NOT HistoryItem:
 *  the bar is 400px wide and shows only what it can act on — what was asked, what
 *  came back, and whether it worked. Everything else the flyout renders (turns,
 *  run folder, feedback, mode chips) has no room and no use here. */
export interface SelectionBarHistoryItem {
  run_id: string
  ts: string
  /** The chip label or typed question that fired the run. */
  instruction: string
  /** What was highlighted, truncated for one line. */
  selection_preview: string
  /** The rewrite. Present on success only — that IS the thing to re-paste. */
  result?: string
  ok: boolean
}

// ── Billing / Credits ────────────────────────────────────────────────────────

/** Live credit balance returned by the edge function / billing IPC channel. */
export interface CreditBalance {
  /** Remaining balance in US cents (e.g. 2000 = $20.00). */
  balance_cents: number
  /** ISO-8601 timestamp of the last server-side update. */
  updated_at: string
}

/** Stripe prepaid pack ids. Must stay in sync with CONFIG.BILLING.PACKS[].id. */
export type BillingPackId = 'pack_20' | 'pack_100' | 'pack_200'

export type UpdateState =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'download-progress'
  | 'downloaded'
  | 'error'

/** Payload pushed on CHANNELS.updateStatus for every updater lifecycle event. */
export interface UpdateStatusPayload {
  state: UpdateState
  /** Target version, present on `available` / `downloaded`. */
  version?: string
  /** Download percent (0–100), present on `download-progress`. */
  percent?: number
  /** Error message, present on `error`. */
  message?: string
}

export type ActivityState =
  | 'idle'
  | 'listening'
  | 'recording'
  | 'screenshot'
  | 'thinking'
  | 'done'
  | 'error'

/** Payload pushed to the island renderer on every activity state change. */
export interface ActivityPayload {
  state: ActivityState
  /** Short context label, e.g. "Transcribed", "Screenshot saved", "analyzing…".
   *  Load-bearing for `done`/`error` — that's the text shown next to the flash. */
  detail?: string
  /** Seconds elapsed, for the recording timer / done summary. */
  elapsed?: number
}

export interface RecoveredRecording {
  folder: string
  summary: string
  transcript: string
}

export interface RecoveredRecordingsState {
  working: boolean
  items: RecoveredRecording[]
}

export interface MediaChatResult {
  /** The LLM's answer text. Empty string when error is set. */
  answer: string
  /** Absolute paths of the capture folders cited in the answer (ranked order). */
  citedFolders: string[]
  /** Set when the run failed; absent on success. */
  error?: 'timeout' | 'oom_credits' | 'failed'
}

/** Request payload for CHANNELS.mediaChatWith — one turn of the media-library chat. */
export interface MediaChatPayload {
  /** The user's question. */
  question: string
}

export type MightyRunSource = 'chat' | 'job' | 'phone' | 'listen' | 'capture' | 'voice'

/** One exchange in a Mighty session: the user's (or job's) message and Mighty's reply. */
export interface MightyTurn {
  /** Who/what asked: a typed chat message, or the job that fired. */
  source: MightyRunSource
  /** The user prompt (chat) or the job's prompt (scheduled). */
  q: string
  /** Mighty's reply text (the act summary / answer). Empty until the run finishes. */
  a: string
  /** UTC ISO-8601 timestamp of this turn. */
  ts: string
  /** Whether the underlying run succeeded. */
  ok: boolean
  /** Backend that served this turn (claude | codex | mightymouse). */
  backend: string
  model?: string
  /** Absolute paths of any artifacts this turn created (also added to the registry). */
  artifacts?: string[]
  /** By-kind count of attachments the user sent with this turn (NOT context).
   *  Omitted when none, so old rows stay valid. */
  attachments?: AttachmentSummary
  /** Absolute paths of the files the user attached to this turn (what Mighty read).
   *  Powers the Sources section of the context rail. Omitted when none — old rows,
   *  which only ever stored the `attachments` count, stay valid. */
  sources?: string[]
  /** Wall-clock time the run took, in ms. Surfaced under the bubble in detail mode.
   *  Omitted on turns recorded before timing existed, so old rows stay valid — every
   *  reader must treat absent as "unknown", never as zero. */
  durationMs?: number
  firstPhaseMs?: number
  toolCalls?: ToolCallSummary[]
  run_id?: string
  usage?: TurnUsage
}

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  costUsd?: number
  free?: boolean
  genMs?: number
}

/** One tool call in a settled turn's persisted trail — deliberately smaller than the
 *  live ToolRow (no raw output): the point is "what did it do", not a full replay. */
export interface ToolCallSummary {
  name: string
  /** One-line rendering of the tool's input (same helper the live view uses). */
  inputPreview: string
  ok: boolean
}

/** A resumable Mighty conversation. One row per session in sessions.jsonl (latest wins). */
export interface MightySession {
  schema_version: number
  /** Stable session id (uuid). */
  id: string
  /** UTC ISO-8601 of session creation. */
  created: string
  /** UTC ISO-8601 of the last turn. */
  updated: string
  /** Short human title (first user message, truncated) for the sidebar. */
  title: string
  /** The full ordered conversation — every chat turn and job result in this session. */
  turns: MightyTurn[]
  /** Project this session is grouped under. Absent/undefined → unassigned. */
  projectId?: string
  /** Provider for THIS conversation only. Absent → project default, then global pref. */
  backend?: BackendId
  runId?: string
  /** UTC ISO-8601 of the last rename or project move; sync-only, so the sidebar order stays on `updated`. */
  renamed?: string
  pinned?: boolean
  archived?: boolean
}

export interface ChatPaneRef {
  id: string
  sessionId: string | null
  /** Bumped every time the USER points this pane at a different chat (new chat, open
   *  from the drawer, delete-unbind). NOT bumped when a first send fills in the id the
   *  pane just created. The render key reads it, so a switch remounts the pane with no
   *  carried-over state while a live first send keeps its instance. Absent → 0. */
  bindGen?: number
  /** Project the pane's first send should file its new session under ("new chat" from
   *  a project header). Only meaningful while `sessionId` is null — once the session
   *  exists it carries its own projectId, which wins. */
  pendingProjectId?: string
  /** Set = this pane shows a Code agent (its relay label) instead of a chat. */
  agentLabel?: string
  /** Set without agentLabel = an empty Code pane that starts a new agent in this folder. */
  agentCwd?: string
}

export interface PaneLayoutState {
  /** Fractional widths (sum ~1) for each column, left to right. */
  colRatios?: number[]
  /** Fractional heights (sum ~1) for each row, top to bottom. */
  rowRatios?: number[]
}

export interface ChatWorkspaceTab {
  id: string
  name: string
  panes: ChatPaneRef[]
  layout: PaneLayoutState
  /** UTC ISO-8601 of tab creation. Also the source the naming scheme reads to bucket
   *  this tab into its creation day for the per-day letter counter. */
  createdAt: string
  /** How this tab's panes are shown: tiled together, or one at a time behind a
   *  sub-tab row. Absent → 'grid', which is what every tab did before the mode
   *  existed, so old persisted tabs keep their current look. */
  viewMode?: PaneViewMode
}

export type PaneViewMode = 'grid' | 'single'

export type ZoomKey = 'in' | 'out' | 'reset'

export interface MightyProject {
  /** Stable project id (uuid). */
  id: string
  /** Human label shown in the sidebar. */
  name: string
  /** UTC ISO-8601 of project creation. */
  created: string
  /** UTC ISO-8601 of last edit (rename/settings change). */
  updated: string
  /** Default backend for new conversations started inside this project. Empty/absent → use the global PREFS default. */
  defaultBackend?: BackendId
  /** Default mightymouse-backend model slug for new conversations here. Only meaningful when defaultBackend is 'mightymouse'. */
  defaultModel?: string
  /** Extra system-prompt context appended after the global Mighty instructions for conversations in this project. Empty/absent → none. */
  systemPrompt?: string
  repoFolder?: string
  /** Must equal bin/mm-coord's project() id for repoFolder, or agents there stop filing under this project. */
  agentProjectId?: string
  /** A `PROJECT_ICONS` id the sidebar draws instead of the generic folder. Absent → folder. */
  icon?: string
  /** Absolute path to a picture MightyMouse copied under ~/MightyMouse/mighty/project-images/. */
  imagePath?: string
  /** User cleared the picture; the startup scan must not re-add one. */
  imageRemoved?: boolean
  archived?: boolean
  pinned?: boolean
}

export interface ProjectRepoLink {
  repoFolder: string
  agentProjectId: string
}

/** What a folder carries, counted at pick time so the import list can name it. */
export interface ProjectFolderScan extends ProjectRepoLink {
  /** Folder basename, the default project name. */
  name: string
  hasInstructions: boolean
  skills: number
  agents: number
  /** Agent sessions already filed under agentProjectId, seen in the last 72h. */
  liveAgents: number
}

/** One tick in the "what to import" list. Absent key = the folder has none of that kind. */
export type ProjectImportKey = 'instructions' | 'skills' | 'agents' | 'liveAgents'

/** Dot-folders and scratch space are where agents ran, not projects to keep - import leaves them unticked. */
export function isKeepableProject(name: string): boolean {
  return !/^(\.|tmp$|temp$|scratchpad$|node_modules$)/.test(name)
}

/** How often a scheduled job fires. v1 keeps it simple; cron is a later seam. */
export type MightySchedule = 'daily' | 'hourly' | 'weekdays' | 'manual'

export type GithubJobEvent = 'pr-opened' | 'issue-opened' | 'checks-failed'

export interface MightyJobTrigger {
  kind: 'github'
  repoCwd: string
  event: GithubJobEvent
  /** Ids already handled; absent until the first poll records what existed before the trigger. */
  seen?: string[]
}

/** A scheduled job Mighty runs on its own. One row per job in jobs.jsonl (latest wins). */
export interface MightyJob {
  /** Stable job id (uuid). */
  id: string
  /** Human label shown in the Jobs tab. */
  name: string
  /** The instruction Mighty runs when this job fires. */
  prompt: string
  /** Cadence. `manual` never auto-fires (run button only). */
  schedule: MightySchedule
  /** Local hour-of-day (0-23) the daily/weekdays job fires at. Ignored for hourly/manual. */
  hour: number
  /** Whether the job is active. Disabled jobs never fire (kept for re-enable). */
  enabled: boolean
  /** UTC ISO-8601 of the last fire ATTEMPT (success or failure), or null if never run.
   *  Attempts, not successes — this is what marks a schedule window handled, so a
   *  failed run must still stamp it or the job re-fires every tick. */
  lastRun: string | null
  /** UTC ISO-8601 of job creation. */
  created: string
  /** Session id job results are appended to (one rolling session per job). */
  sessionId: string
  /** Absent = Mighty answers. `code` = start a coding agent session in `cwd`. */
  target?: { kind: 'code'; cwd: string; project: string }
  /** Absent = the clock (`schedule`) decides. Set = a GitHub event decides. */
  trigger?: MightyJobTrigger
}

/** An artifact Mighty created (file written during an act run). Powers the "Made" tab. */
export interface MightyArtifact {
  /** Absolute path of the created file. */
  path: string
  /** UTC ISO-8601 it was created. */
  ts: string
  /** Session id the creating turn belongs to. */
  sessionId: string
  exists: boolean
  /** The prompt that produced it (for context in the list). */
  prompt: string
}

/** Which modes a global custom-instructions block is injected into. */
export interface GlobalInstructionsAppliesTo {
  rewrite: boolean
  ask: boolean
  act: boolean
  mighty: boolean
}

/** User-editable free text applied across modes, gated per-mode by appliesTo.
 *  Replaces the old Mighty-only `MightySettings.instructions` field — see the
 *  one-time migration in PREFS.getGlobalInstructions(). */
export interface GlobalInstructionsSettings {
  text: string
  appliesTo: GlobalInstructionsAppliesTo
}

/** Default artifact format Mighty builds when the user hasn't asked for a specific one. */
export type MightyOutputFormat = 'auto' | 'html' | 'markdown'

export type ChatTabNameFormat = 'pretty' | 'compact' | 'slug'

export type LinkTarget = 'app' | 'browser'

export type LinkMenuChoice = 'app' | null

export type NativeMenuItem =
  | { id: string; label: string; enabled?: boolean }
  | { type: 'separator' }

/** User-editable Mighty settings (persona, behavior, output). Persisted via PREFS. */
export interface MightySettings {
  /** Persona name override. Empty → fall back to CONFIG.MIGHTY.NAME. */
  name: string
  /** Free-text "how should Mighty behave" injected into the system prompt. Empty → none. */
  instructions: string
  /** Preferred default artifact format. */
  outputFormat: MightyOutputFormat
  /** Naming scheme for auto-named chat tabs. Only affects tabs created from now on —
   *  existing tab names are persisted strings and are never rewritten. */
  tabNameFormat: ChatTabNameFormat
  linksOpenIn: LinkTarget
  /** True once the found-projects import screen has been answered, so it never returns. */
  importedFoundProjects?: boolean
}

/** Request payload for CHANNELS.mightyChat — one chat turn. */
export interface MightyChatPayload {
  /** The user's message. */
  message: string
  /** Session to append to. Empty/absent → start a new session. */
  sessionId?: string
  /** Project to seed a brand-new session's defaults from. Ignored when sessionId is
   *  set (that session already carries its own projectId, if any). */
  projectId?: string
  /** Provider the pane picked before it had a session to pin it to. Only consulted
   *  for that first send; afterwards the session's own field wins. */
  backend?: BackendId
  /** User-attached media (images / files / audio). Audio is transcribed pre-run. */
  attachments?: MediaAttachment[]
  /** Caller-minted id echoed back on every phase/event push for this run. A pane's
   *  FIRST send has no sessionId to match live pushes against, and matching on the
   *  absent one made every fresh pane accept every other fresh pane's stream. This is
   *  the only identifier both sides hold before a session exists. */
  clientRunId?: string
}

/** Live-activity push (CHANNELS.mightyPhase) emitted during a chat run. */
export interface MightyPhasePayload {
  /** The session this run belongs to — used to match the right pending bubble. */
  sessionId: string
  /** Echo of the sender's MightyChatPayload.clientRunId, absent for runs started
   *  somewhere other than a chat pane (scheduler, phone). Matching on this instead of
   *  sessionId is what keeps concurrent first-sends from crossing streams. */
  clientRunId?: string
  /** Short user-facing activity headline ("Reading…", "Writing", "Running command"). */
  phase: string
  detail: string
}

export interface MightyEventPayload {
  sessionId: string
  clientRunId?: string
  event: RunEvent
}

/** Result of a Mighty chat turn. */
export interface MightyChatResult {
  /** Mighty's reply. */
  answer: string
  /** The session id this turn landed in (new or existing). */
  sessionId: string
  /** Artifacts created this turn. */
  artifacts: string[]
  /** Set when the run failed; absent on success. Same union the history row and
   *  the cloud event carry, so one run can't be a `timeout` in one store and a
   *  bare `failed` in another. */
  error?: RunFailReason
  usage?: TurnUsage
}

/** CHANNELS.mightyExportSession target format. */
export type MightyExportFormat = 'markdown' | 'json'

/** Request payload for CHANNELS.mightyUpsertJob — create or update a job. */
export interface MightyUpsertJobPayload {
  job: MightyJob
}

export interface MightyTurnAppendedPayload {
  sessionId: string
}

export type DashboardTab =
  | 'pulse'
  | 'digest'
  | 'money'
  | 'activation'
  | 'pipeline'
  | 'growth'
  | 'traffic'
  | 'ads'
  | 'referrals'
  | 'people'
  | 'nudges'
  | 'mods'
  | 'email'
  | 'waitlist'
  | 'health'
  | 'release'
  | 'sessions'
  | 'feedback'
  | 'inbox'

// ── Admin dashboard: Email tab (migration 0042 — email_sends) ────────────────

/** Coarse family of a send. Mirrors the email_sends CHECK constraint. */
export type EmailKind = 'lifecycle' | 'release' | 'waitlist' | 'admin' | 'transactional'

/** One row of the append-only send log. */
export interface EmailSend {
  id: number
  user_id: string | null
  email: string
  kind: EmailKind
  /** Template id, e.g. 'stalled' | 'release_notes' | 'mac_download'. Free text
   *  in the DB on purpose — templates outpace migrations. */
  slug: string
  subject: string | null
  status: 'sent' | 'failed'
  error: string | null
  sent_at: string
  opened_at: string | null
  clicked_at: string | null
}

/** Top-strip totals. Rates are over SENT, not all rows, and are null when
 *  nothing was sent — a 0% open rate on zero emails is a lie, not a zero. */
export interface EmailSummary {
  sent: number
  failed: number
  opened: number
  clicked: number
  openRate: number | null
  clickRate: number | null
  /** Point-in-time, NOT windowed: how many we can no longer mail, full stop. */
  suppressed: number
  queuedDrafts: number
}

/** A person on the CRM board, with just enough to decide whether to mail them. */
export interface EmailPerson {
  userId: string
  email: string
  createdAt: string
  /** When they reached their current rung — how long they've been stuck. */
  stageSince: string
  lastEmail: {
    slug: string
    kind: EmailKind
    status: 'sent' | 'failed'
    sent_at: string
    opened_at: string | null
    clicked_at: string | null
  } | null
  emailCount: number
  queuedDraft: { trigger: string; drafted_at: string | null } | null
  /** Every drip email they got, one per step, oldest send per step. */
  drips?: { slug: string; sent_at: string; opened: boolean; clicked: boolean }[]
}

/** The rungs of the CRM board. Mirrors user_stages (0030) minus paid_at, which
 *  nothing writes yet — rendering it would mean an always-empty column. */
export type EmailStageKey = 'signed_up' | 'launched' | 'onboarded' | 'activated'

/** `total` is the true column size; `people` is capped for render. */
export interface EmailStageColumn {
  total: number
  /** Over the whole column, not just the capped `people`. */
  neverEmailed?: number
  people: EmailPerson[]
}

export interface DripStepStats {
  sent: number
  failed: number
  opened: number
  clicked: number
  sentLastDay: number
  lastAt: string | null
  queued: number
  skipped: number
}

/** All-time, per email slug (outreach templates folded into `outreach`). */
export interface AdminDripMap {
  steps: Record<string, DripStepStats>
  waitlist: number
  autosend: boolean
  holdHours: number
  thresholdHours: Record<'waitlist_no_download' | 'stalled' | 'gone_quiet' | 'win_back', number>
}

export interface AdminEmailOverview {
  ok: true
  days: number
  summary: EmailSummary
  board: Record<EmailStageKey, EmailStageColumn>
  log: EmailSend[]
  /** Absent from an admin-emails deploy older than the drip map. */
  drip?: AdminDripMap
}

export type JourneySurface = 'landing' | 'web-chat' | 'web-code' | 'mac' | 'phone' | 'ios'

// Mirrors Journey in supabase/functions/_shared/new-people.ts.
export type UserJourney = {
  source: string
  signupSurface: 'web' | 'mac' | 'ios' | 'waitlist' | 'unknown'
  surfaces: JourneySurface[]
  furthest: string
  lastEvent: string | null
  lastAt: string | null
}

export type UserPlan = 'lifetime' | 'subscriber' | 'free'

export type UserStage = 'signed_up' | 'launched' | 'onboarded' | 'activated' | 'paying'

export type LifecycleTrigger = 'stalled' | 'gone_quiet' | 'win_back'

/** How a nudge ended up. 'failed' is deliberately kept and never retried, so a
 *  broken send stays visible instead of silently re-queueing. */
export type LifecycleSendStatus = 'pending' | 'sent' | 'failed'

/** One lifecycle email we sent (or tried to send) to a person. */
export interface LifecycleNudge {
  trigger: LifecycleTrigger
  status: LifecycleSendStatus
  sentAt: string
}

export const DIGEST_REASONS = [
  'nudge_ignored',
  'paying_stalled',
  'high_intent_stuck',
  'error_blocked'
] as const
export type DigestReason = (typeof DIGEST_REASONS)[number]

export interface DigestFlag {
  reason: DigestReason
  stuckDays: number
  evidence: string
  /** When a human last reached out, if they have. Suppresses the flag for a
   *  configured window, so a row Roy already handled stops shouting at him. */
  contactedAt?: string | null
}

export interface DigestPerson {
  userId: string
  email: string | null
  reason: DigestReason
  /** Furthest rung reached, in the People tab's vocabulary. */
  stage: string
  /** Days on the clock THIS reason measures, not one shared "stuck" clock.
   *  Render it with the reason's verb (REASON_META.stuckVerb), never bare. */
  stuckDays: number
  /** The sentence computed server-side at digest time. Rendered verbatim. */
  evidence: string
  /** "signed up Jul 30 · last opened the app Aug 10 (2d ago)". Absent on rows
   *  snapshotted before it existed, so render skips it rather than printing
   *  a dangling separator. */
  context?: string
}

/** Someone who arrived or crossed a rung inside the window. */
export interface DigestMover {
  userId: string
  email: string | null
  stage: string
  at: string
}

export interface DigestMovement {
  arrived: DigestMover[]
  advanced: DigestMover[]
  net: { stage: string; count: number }[]
}

/** A whole digest read: today computed live, or a past day replayed verbatim. */
export interface DigestReport {
  day: string
  /** True when this came from operator_digest_runs — "as posted 09:00" rather
   *  than "computed just now". The UI must print one or the other, never guess. */
  snapshot: boolean
  computedAt: string | null
  /** How many qualified before the display cap. */
  total: number
  rows: DigestPerson[]
  /** Absent on a replayed snapshot: movement is computed live, not stored. */
  movement: DigestMovement | null
  /** What the automated lane is holding, so "Nothing needs you" is trustworthy. */
  queueNote: string | null
}

/** Rung order, lowest first. The ONE place the ladder's sequence is defined. */
export const USER_STAGE_ORDER: readonly UserStage[] = [
  'signed_up',
  'launched',
  'onboarded',
  'activated',
  'paying'
] as const

/** Default tab when the URL has no (or an invalid) `tab` param. */
export const DEFAULT_DASHBOARD_TAB: DashboardTab = 'growth'

export interface ReleaseEmailStats {
  version: string
  sent: number
  opened: number
  clicked: number
  failed: number
}

export interface ReleaseBroadcastResult {
  ok: boolean
  version?: string
  dryRun?: boolean
  total_users?: number
  already_mailed?: number
  suppressed?: number
  recipients?: number
  sent?: number
  failed?: number
  sample?: { subject?: string; text?: string; html?: string }
}

export interface ReleaseInfo {
  installed?: {
    version: string
    notes: { title: string; detail: string }[]
  }
  latest?: {
    version: string
    publishedAt: string
    /** External release-body markdown, as published on the GitHub Release. */
    body: string
    url: string
  }
}

export type SessionClass = 'human' | 'bot' | 'agent' | 'answer_engine'

// Mirrors VISITOR_STEPS in supabase/functions/_shared/visitor-journey.ts; change both together.
export const VISITOR_STEP_ORDER = ['visited', 'opened_app', 'opened_signin', 'signed_in', 'used', 'activated'] as const
export type VisitorStep = (typeof VISITOR_STEP_ORDER)[number]

export const AHA_VIA_ORDER = ['web', 'ai', 'code', 'phone', 'voice'] as const
export type AhaVia = (typeof AHA_VIA_ORDER)[number]

export interface SessionRow {
  key: string
  day: string
  class: SessionClass
  signedIn: boolean
  isAdmin: boolean
  isInternal: boolean
  user: { id: string; email: string | null } | null
  views: number
  firstAt: string
  lastAt: string
  durationSec: number
  country: string | null
  city: string | null
  device: string | null
  browser: string | null
  refHost: string | null
  /** Where the visit came FROM. 'ai' = a person who clicked through an AI answer. */
  refClass: ReferrerClass | null
  utmSource: string | null
  /** Ad creative slug (e.g. `chair_mac`). Null for organic/non-ad traffic. */
  utmContent: string | null
  utmTerm?: string | null
  landingPath: string
  surface: string | null
  persistentVisitor?: string | null
  furthest?: VisitorStep
  ahaVia?: AhaVia | null
  /** A Clarity recording exists for this visit. False also means "not yet" —
   *  Clarity ingests with a lag, so a fresh session flips true later. */
  hasReplay: boolean
}

/** Bucketed referrer origin, mirrors refClass() in web/functions/_lib/classify.js. */
export type ReferrerClass = 'ai' | 'search' | 'social' | 'direct' | 'other'

export interface AiReferralStats {
  /** Distinct human sessions referred from an AI host. */
  sessions: number
  /** How many of those were signed in — the closest thing to a conversion here. */
  signedIn: number
  byHost: KeyCount[]
  byLandingPath: KeyCount[]
  /** AI CRAWLER visits (class='answer_engine'). Leading indicator, not a referral. */
  crawls: number
}

export interface SessionListResponse {
  days: number
  class: SessionClass | 'all'
  excludeInternal: boolean
  adminCount: number
  count: number
  sessions: SessionRow[]
  aiReferrals?: AiReferralStats
  ads?: AdCreativeStats[]
  adsError?: string
}

export interface AdCreativeStats {
  id: string
  name: string
  status: string
  adset: string
  adsetId: string
  adsetCreated: string
  campaign: string
  image: string | null
  utmContent: string | null
  utmTerm: string | null
  spend: number
  impressions: number
  clicks: number
  robots: number
}

export interface SessionTrailEntry {
  path: string
  at: string
  refHost: string | null
  utmSource: string | null
  utmContent: string | null
  entry: boolean
  dwellSec: number | null
}

export interface SessionDetail {
  key: string
  day: string
  visitorHash: string
  class: SessionClass | null
  signedIn: boolean
  signedInDuringSession: boolean
  durationSec: number
  /** Summed real per-page dwell pings; null when no dwell beacon ever landed. */
  dwellSec: number | null
  surface: string | null
  /** null = this browser sent no persistent cookie id, so "returning" is unknowable. */
  returningVisitor: boolean | null
  priorVisitAt: string | null
  user: { id: string; email: string | null } | null
  device: string | null
  browser: string | null
  os: string | null
  country: string | null
  city: string | null
  asn: number | null
  asOrg: string | null
  netFlag: string | null
  client: SessionClientInfo | null
  verifiedBot: boolean
  /** Clarity replay for this visit. Null when the browser blocked localStorage
   *  (no mm_vid to match on) or Clarity has no recording for it. */
  clarityUrl: string | null
  furthest?: VisitorStep
  stepAt?: Partial<Record<VisitorStep, string | null>>
  appEvents?: { event: string; at: string; reason?: string }[]
  trail: SessionTrailEntry[]
}

export interface SessionClientInfo {
  sw?: number
  sh?: number
  vw?: number
  vh?: number
  dpr?: number
  lang?: string
  langs?: string
  tz?: string
  ipTz?: string
  region?: string
  osVer?: string
  touch?: number
  cores?: number
  mem?: number
  conn?: string
  dark?: boolean
}

export interface AdminUserEvent {
  at: string
  event: string
  sessionId: string
  appVersion: string | null
  platform: string | null
  props: Record<string, unknown>
}

/** Which send-ledger a drawer email row came from. Mirrors the two tables:
 *  lifecycle_emails (0032) and release_emails (0034). */
export type AdminEmailKind = 'lifecycle' | 'release'

export type AdminEmailStatus =
  | 'draft'
  | 'pending'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'expired'
  | 'stale_skipped'

export interface AdminUserProfile {
  user: {
    /** Null for a lead: they left an email on the landing page and never made
     *  an account, so there is no auth row to key the rest of this profile on. */
    id: string | null
    email: string | null
    createdAt: string | null
    lastSignInAt: string | null
    /** auth provider — 'google', 'email', … */
    provider: string | null
    plan: UserPlan
    appVersion: string | null
    platform: string | null
    phoneVersion?: string | null
  }
  money: {
    /** Live wallet, cents. */
    balanceCents: number
    /** Real money in — topup + lifetime ledger kinds ONLY, never grants. */
    spentCents: number
    /** Credit we handed out (signup grant, referral, sub reset). Not revenue. */
    grantedCents: number
    /** Metered LLM spend charged against credits, cents. */
    burnedCents: number
    /** What those runs actually cost US at provider prices, cents. */
    rawCostCents: number
    runs: number
    runsCapped: boolean
    lifetimeGrantedAt: string | null
    lifetimePaidCents: number | null
    lifetimeSeat: number | null
    subscriptionStatus: string | null
    subscriptionPlanId: string | null
    subscriptionRenewsAt: string | null
  }
  setup?: {
    lastRunAt: string | null
    /** Failing check ids on the NEWEST board only — an already-fixed check is gone. */
    failing: string[]
    /** Passing count as the app counted it: `optional` failures count as ok. */
    okCount: number
    failingCount: number
    /** Times they opened the board. High = the install fought them. */
    runs: number
    /** Self-fix attempts, newest first. `ok` is what the fix REPORTED. */
    fixes: { at: string; check: string; kind: string; ok: boolean }[]
  } | null
  permissions?: {
    rows: {
      permission: PermissionKey
      /** Latest observed status. Null = never observed, not a denial. */
      status: 'granted' | 'denied' | null
      at: string | null
      /** Newest observation was the state on arrival, not a user action. */
      atLaunch: boolean
      /** Ever seen granted, even if now denied — a revoke, not a no-show. */
      everGranted: boolean
    }[]
    lastSeenAt: string | null
    denied: PermissionKey[]
    /** False = no observation at all; the board is a gap, not a verdict. */
    observed: boolean
  }
  stage?: {
    launchedAt: string | null
    onboardedAt: string | null
    activatedAt: string | null
    known: boolean
  }
  activity: {
    totalEvents: number
    /** True when totalEvents hit the server cap — it's a floor, not a total. */
    eventsCapped: boolean
    /** Distinct days with any event inside windowDays. The real habit signal. */
    activeDays: number
    windowDays: number
    firstEventAt: string | null
    lastEventAt: string | null
    /** Zero-filled daily counts over windowDays, oldest first. */
    byDay: { day: string; count: number }[]
    topEvents: { event: string; count: number }[]
    timeline: AdminUserEvent[]
  }
  errors: {
    at: string
    kind: string
    message: string
    source: string | null
    appVersion: string | null
    props: Record<string, unknown>
  }[]
  usage: {
    byModel: { model: string; runs: number; cents: number }[]
    recent: {
      at: string
      model: string
      inputTokens: number | null
      outputTokens: number | null
      chargedCents: number | null
      durationMs: number | null
    }[]
  }
  ledger: { at: string; kind: string; amountCents: number; balanceAfter: number }[]
  web: {
    views: number
    country: string | null
    city: string | null
    device: string | null
    browser: string | null
    os: string | null
    recent: {
      at: string
      path: string
      surface: string | null
      refHost: string | null
      utmSource: string | null
    }[]
  }
  /** channel = 'referral' | 'utm' | 'organic'; utm* carry the campaign detail. */
  attribution: {
    channel: string
    referralCode: string | null
    utmSource: string | null
    utmMedium: string | null
    utmCampaign: string | null
    landingPath?: string | null
    referrer?: string | null
  } | null
  bugReports: {
    id: number
    at: string
    body: string
    steps: string | null
    status: string | null
    appVersion: string | null
  }[]
  emails: {
    at: string
    kind: AdminEmailKind
    label: string
    status: AdminEmailStatus
    error: string | null
    /** False when the send has no Resend id, so the open/click webhook could
     *  never match it — every send before migration 0038. Distinguishes "we
     *  don't know" from "they didn't open it"; both leave openedAt null. */
    tracked: boolean
    openedAt: string | null
    clickedAt: string | null
  }[]
  /** True when this address is on email_suppressions — they unsubscribed or
   *  hard-bounced, so no further automated mail will go out. */
  emailSuppressed: boolean
  /** Live Stripe, not our `billing_subscriptions` mirror. The mirror carries
   *  status/plan/period only, which cannot answer the question an operator
   *  actually opens this drawer with: did real money leave their card, how many
   *  times, and did a code cover it. `linked: false` means no Stripe customer
   *  was ever created — they never reached checkout. */
  billing?: {
    linked: boolean
    customerId?: string | null
    subscriptionId?: string | null
    dashboardUrl?: string | null
    /** Stripe was unreachable. Every number below is ABSENT, not zero — render
     *  this as "couldn't read", never as "never paid". */
    error?: string
    /** True when at least one invoice was actually paid with money > 0. */
    paying?: boolean
    status?: string | null
    canceledAt?: string | null
    cancelAtPeriodEnd?: boolean | null
    priceId?: string | null
    /** Dollars on the price they are subscribed to, not cents. */
    amount?: number | null
    currency?: string | null
    interval?: string | null
    trialStart?: string | null
    trialEnd?: string | null
    card?: { brand: string | null; last4: string | null } | null
    usedCode?: boolean
    discounts?: {
      discountId: string
      /** Dollars this discount took off that invoice. */
      amountOff: number | null
      couponId: string | null
      couponName: string | null
      percentOff: number | null
      duration: string | null
      durationInMonths: number | null
      onInvoice: string | null
    }[]
    /** Dollars, summed across `payments`. */
    totalPaid?: number | null
    /** One row per invoice that took real money. Length IS the charge count. */
    payments?: {
      invoiceId: string | null
      chargeId: string | null
      paidCents: number
      paid: number | null
      at: string | null
      reason: string | null
      receiptUrl: string | null
    }[]
    /** Every invoice, including the $0 ones a coupon covered. */
    invoices?: {
      id: string | null
      at: string | null
      status: string | null
      total: number | null
      reason: string | null
      periodStart: string | null
      periodEnd: string | null
    }[]
  }
  /** Set when this address is on the waitlist. Non-null with `user.id === null`
   *  is a LEAD: an email off the landing page with no account behind it, so
   *  every user_id-keyed section of this profile is empty by fact, not by gap.
   *  Non-null alongside a real id just means they were on the list before they
   *  signed up — the drawer still shows where they came from. */
  lead: {
    capturedAt: string
    /** Platform they asked for — 'mac' | 'windows'. Not a device they own. */
    platform: string | null
    /** Channel the landing page recorded, e.g. 'facebook'. */
    source: string | null
    referrer: string | null
    utmCampaign: string | null
    utmContent: string | null
    utmMedium: string | null
    /** Landing page variant they were served, for A/B reads. */
    variant: string | null
    landingPath: string | null
    /** When the capture email went out. Null = it never did. */
    emailSentAt: string | null
  } | null
}

export const PHONE_REMOTE_SKINS = ['default', 'proII', 'cap', 'military', 'amethyst'] as const
export type PhoneRemoteSkin = (typeof PHONE_REMOTE_SKINS)[number]

/** Narrow an untrusted string (pref file contents, a WS message) to a BUILT-IN
 *  skin. Remote skins deliberately fail this check — see isInstallableSkin. */
export function isPhoneRemoteSkin(value: string): value is PhoneRemoteSkin {
  return (PHONE_REMOTE_SKINS as readonly string[]).includes(value)
}

export const REMOTE_SKIN_PREFIX = 'remote:'

/** Any skin id that may be persisted or sent over the wire: a built-in union
 *  member, or `remote:<id>`. Deliberately widened to string for the remote
 *  case — the typechecker cannot know a catalog it has never fetched. */
export type InstallableSkin = PhoneRemoteSkin | `${typeof REMOTE_SKIN_PREFIX}${string}`

const REMOTE_SKIN_ID_RE = /^[a-z0-9-]{1,32}$/

/** Narrow an untrusted string to a persistable skin id (built-in OR remote).
 *  Use at every string→skin boundary that must accept remote skins; use
 *  isPhoneRemoteSkin where only a compiled-in skin is valid. */
export function isInstallableSkin(value: string): value is InstallableSkin {
  if (isPhoneRemoteSkin(value)) return true
  return isRemoteSkinId(value)
}

/** True for a well-formed `remote:<id>` id. Does NOT assert the skin is
 *  installed — callers resolve that against the cache. */
export function isRemoteSkinId(value: string): value is `${typeof REMOTE_SKIN_PREFIX}${string}` {
  if (!value.startsWith(REMOTE_SKIN_PREFIX)) return false
  return REMOTE_SKIN_ID_RE.test(value.slice(REMOTE_SKIN_PREFIX.length))
}

/** The bare catalog id inside a `remote:` skin id, or null if not a remote id.
 *  This is the only sanctioned way to get the filesystem/URL segment — never
 *  slice the prefix by hand, or an unvalidated id reaches a path join. */
export function remoteSkinCatalogId(value: string): string | null {
  return isRemoteSkinId(value) ? value.slice(REMOTE_SKIN_PREFIX.length) : null
}

/** One entry in the catalog served by the phone-remote-skins edge function,
 *  and (minus `css`) one card in the phone's skin store. */
export interface RemoteSkinManifestEntry {
  /** Bare catalog id, no prefix. Must satisfy REMOTE_SKIN_ID_RE. */
  id: string
  label: string
  /** The store's one-line pitch, mirroring SKIN_OPTIONS.blurb. */
  blurb: string
  /** Raw CSS. Sanitised on install — only --pro-* declarations survive, and
   *  only url()s naming a listed asset. See sanitizeRemoteSkinCss. */
  css: string
  /** Filenames (not URLs) this skin's css may reference in url(). Fetched
   *  relative to the catalog's assetBaseUrl and re-served from localhost. */
  assets?: string[]
  /** Pins data-theme='light', same contract as LIGHT_PINNED_SKINS. */
  lightOnly?: boolean
  /** Paints its regions with images instead of the token sculpt, so the deck
   *  tears the sculpt out from under them. Only meaningful alongside `assets`:
   *  the art arrives as `--pro-*-img: url(...)` naming one of those files. */
  imageSkin?: boolean
}

export interface RemoteSkinCatalog {
  /** Absolute https base the entries' `assets` resolve against. */
  assetBaseUrl: string
  skins: RemoteSkinManifestEntry[]
}
// Pro layout color scheme, strictly light/dark. Irrelevant to the classic
// layout. 'proII' used to live here as a third theme value — it's a layout
// now; prefs.ts migrates old pref files on first read.
export type PhoneRemoteColorScheme = 'light' | 'dark'
// Pro layout handedness — mirrors the whole layout horizontally.
export type PhoneRemoteHandedness = 'left' | 'right'
export type PhoneRemoteKeysPosition = 'top' | 'bottom'
export type PhoneRemoteDeckMode = 'stacked' | 'split'

export const SPLIT_CONCEPT_IDS = ['mirror', 'groups', 'fan', 'rails', 'pods'] as const
export type PhoneRemoteSplitConcept = (typeof SPLIT_CONCEPT_IDS)[number]

export function isPhoneRemoteSplitConcept(v: unknown): v is PhoneRemoteSplitConcept {
  return typeof v === 'string' && (SPLIT_CONCEPT_IDS as readonly string[]).includes(v)
}

export const SHIPPING_SPLIT_CONCEPTS: readonly (readonly [PhoneRemoteSplitConcept, string])[] = [
  ['mirror', 'Mirrored'],
  ['groups', 'Split']
]

export const MIRROR_PLACEMENT_IDS = ['stacked', 'bleed', 'glass', 'inset'] as const
export type PhoneRemoteMirrorPlacement = (typeof MIRROR_PLACEMENT_IDS)[number]

export function isPhoneRemoteMirrorPlacement(v: unknown): v is PhoneRemoteMirrorPlacement {
  return typeof v === 'string' && (MIRROR_PLACEMENT_IDS as readonly string[]).includes(v)
}

export const MIRROR_PLACEMENT_LABELS: readonly (readonly [PhoneRemoteMirrorPlacement, string])[] = [
  ['stacked', 'Above'],
  ['glass', 'Under glass']
]

/** Which USER ACTION is about to change the mirrored screen, so a switch-latency
 *  sample can be attributed to its cause. The two are the same downscale but very
 *  different numbers -- a scroll rides an already-warm encoder while an app switch
 *  pays a cold estimate -- and averaging them hides the case being measured.
 *
 *  Every member is something the user DID. This is a herald, not an observation:
 *  it fires ahead of the pixels because the input is known before the repaint
 *  lands, which is the entire reason it beats a frame sampler for the downscale.
 *  The cost is that it is BLIND to any change the user did not cause -- a playing
 *  video with hands off the trackpad emits nothing at all. Anything that needs to
 *  know whether the SCREEN is changing must measure frames, not this. That
 *  distinction cost a whole video-mode detector built on the wrong signal.
 *
 *  Here rather than beside the capture code because it rides the input IPC and
 *  is therefore read in main, preload and the renderer. */
export type UserInputSource = 'input' | 'switch' | 'cursor'

export const PHONE_AUDIO_TO = {
  paste: 'paste',
  chat: 'chat',
  note: 'note'
} as const
export type PhoneAudioDestination = (typeof PHONE_AUDIO_TO)[keyof typeof PHONE_AUDIO_TO]

/** Image types the phone may put on the Mac's clipboard. HEIC is absent on
 *  purpose: the phone re-encodes to JPEG before sending, and macOS clipboard
 *  consumers handle HEIC inconsistently. */
export const PHONE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png'])

// A paired phone as Settings lists it. Device classes are a closed set so the
// row's icon can switch exhaustively; 'unknown' covers devices paired before
// identity capture existed, which stay valid and self-label on next connect.
export const PHONE_REMOTE_DEVICE_KINDS = ['iphone', 'ipad', 'android', 'mac', 'unknown'] as const
export type PhoneRemoteDeviceKind = (typeof PHONE_REMOTE_DEVICE_KINDS)[number]

// Which host the remote page is running in. Declared here rather than in the
// phone's host-capabilities.ts because the Mac stores it per paired device --
// both sides must agree on the spelling or a device labels itself wrong.
export const HOST_SHELLS = ['safari', 'pwa', 'native'] as const
export type HostShell = (typeof HOST_SHELLS)[number]

/** One paired device, as sent main → Settings. Deliberately carries no
 *  credential: `id` is a one-way hash, since this crosses into a renderer. */
export interface PairedDevice {
  id: string
  /** "iPhone 15 Pro · Safari", or "Unknown device" pre-backfill. Not guaranteed
   *  unique across rows -- iOS web clients all report the bare family name. Run
   *  the list through `disambiguateDeviceLabels` before rendering. */
  label: string
  /** "iOS 18.7.7", or null for a device paired before OS capture. Kept off
   *  `label` so the row's title stays the identity and the version rides the
   *  subtitle, where it doesn't feed `disambiguateDeviceLabels`. */
  osLabel: string | null
  kind: PhoneRemoteDeviceKind
  pairedAt: number
  /** Last WS connect, or null if it hasn't connected since identity capture. */
  lastSeenAt: number | null
  /** True for the one device holding the live session (only one at a time). */
  connected: boolean
}

/** Pushed on CHANNELS.phoneRemoteDevicesChanged. Carries re-encoded QRs as well
 *  as the list: a pairing code is single-use, so the QR a surface fetched on
 *  mount is dead the moment anything pairs. Either QR is null when there's
 *  nothing scannable -- keep the previous one rather than blanking the panel. */
export interface PhoneRemoteDevicesChanged {
  devices: PairedDevice[]
  // Present when the live pairing code changed (pair or a user rotate). Absent
  // means "keep the QR you have" -- a revoke must not spin digits under a scan.
  qrDataUrl?: string | null
  tunnelQrDataUrl?: string | null
}

/** `rotate` mints a new code; omit it to reuse the outstanding one (QR + digits). */
export interface PhoneRemoteGetPairCodeOpts {
  rotate?: boolean
}

// Off-Wi-Fi access (Cloudflare Tunnel) lifecycle — pushed main → Settings over
// CHANNELS.phoneRemoteTunnelStatus so the row shows real progress (download
// pct, provisioning, up, error). Owned by phone-remote/cloudflare-tunnel.ts.
export type PhoneRemoteTunnelState =
  | 'stopped'
  | 'downloading'
  | 'provisioning'
  | 'starting'
  | 'up'
  | 'error'
/** Why `/whoami` carried no `tunnel` field. Lets a phone tell "signed out, so
 *  no tunnel exists" apart from "the tunnel is down" -- before this they were
 *  the same silence, and the phone blamed the network for both. */
export type TunnelReach = 'up' | 'signed-out' | 'starting' | 'error' | 'off'

export interface PhoneRemoteTunnelStatus {
  state: PhoneRemoteTunnelState
  /** Download progress 0-100, only while state === 'downloading'. */
  pct?: number
  /** Public hostname, set once provisioned (persists across states). */
  hostname?: string
  /** Human-readable reason, only while state === 'error'. */
  error?: string
  /** Set when the server REFUSED rather than failed — carries the code and the
   *  usage numbers the upgrade prompt renders. `error` holds its message, so a
   *  surface that ignores this field still shows a real sentence. */
  refusal?: RemoteRefusal
}

/** Code agent relay (PRD 2026-08-12-1786501335) health line for Settings —
 *  one shape covers "off", "on but nobody to push to", and "ready". */
/** Which sub-tab the Code tab lands on. Shared because the tray asks for one,
 *  main forwards it, and CodePanel reads it. */
export const CODE_TABS = ['agents', 'needs', 'previous', 'sessions', 'work', 'factory', 'keys', 'infra', 'reports', 'built', 'browser'] as const
export type CodeTab = (typeof CODE_TABS)[number]
export type MightyMode = 'all' | 'chat' | 'code'
export const isMightyMode = (v: unknown): v is MightyMode => v === 'all' || v === 'chat' || v === 'code'

export interface StartupPrompt {
  question: string
  detail: string
  options: string[]
  selected: number
  keys?: ('Enter' | 'Escape' | 't')[]
}

export interface StartupPeek {
  alive: boolean
  prompt: StartupPrompt | null
  tail: string[]
}

export interface StartedAgent {
  cwd: string
  project: string
  pane: string
  message: string
  files: string[]
  since: number
}

export type CodeTabHandoff = StartedAgent | { ref: string } | { newIn: string | null }

export function isCodeTab(value: string | null): value is CodeTab {
  return value !== null && (CODE_TABS as readonly string[]).includes(value)
}

export interface AgentRelayStatus {
  enabled: boolean
  running: boolean
  /** Set only when a paired phone has registered a push token. */
  deviceLabel?: string
  /** Set when enabled+running but there's nobody to push to yet — the
   *  Settings health line renders this verbatim (§6c: the guide IS the string). */
  reason?: string
  /** Epoch ms of the last MCP call, and who made it. Null means no agent has
   *  reached this listener yet — the only honest test of "connected". */
  lastAgentAt?: number | null
  lastAgentFrom?: string
  /** Agent sessions open RIGHT NOW — one per running `npx mightymouse-code`,
   *  which lives exactly as long as the terminal/editor session that spawned
   *  it. 0 when everything is closed; no timeout is involved. */
  agentCount?: number
  /** Their labels, oldest session first, for naming who is connected. */
  agentNames?: string[]
  /** Same sessions, with the directory each one runs in — two panes in one
   *  checkout share a label, so the path is what tells them apart. */
  agentSessions?: AgentRelaySessionInfo[]
  /** Archived/pinned flags by `sessionArchiveKey`, kept on the Mac so every surface agrees. */
  sessionMarks?: SessionMarks
}

export type SessionMark = { archived?: boolean; pinned?: boolean }
export type SessionMarks = Record<string, SessionMark>

/** The "where do I click to see this agent" address the shim derived from its
 *  own env -- cmux workspace/tab, tmux pane/socket, or the terminal's own
 *  bundle id. Every field optional: which ones are present is itself the
 *  signal for which resolver strategy applies.
 *
 *  Declared HERE rather than beside the listener that parses it because both
 *  the phone bundle and the renderer now read it off a session, and neither may
 *  import from `main/`. */
export interface AgentOrigin {
  cmuxWorkspaceId?: string
  cmuxTabId?: string
  cmuxBundleId?: string
  tmuxPane?: string
  tmuxSocket?: string
  termProgram?: string
  hostBundleId?: string
}

/** One line of an agent's real conversation, read off its own transcript file.
 *  `tool` is what it DID between messages, so a long working stretch is not a
 *  silent gap in the thread. */
export interface AgentTranscriptTurn {
  role: 'you' | 'agent' | 'tool'
  at: number
  text: string
  files?: string[]
  recap?: string
  undo?: TurnUndoState
}

export interface AgentSessionUsage {
  output: number
  context?: number
  contextWindow?: number
  planUsedPct?: number
  account?: string
}

export interface AgentToolUse {
  kind: 'app' | 'skill' | 'helper' | 'builtin'
  name: string
  calls: number
  lastAt: number
  lastDetail: string
  tools: Record<string, number>
}

export type McpScope = 'user' | 'local' | 'project'
export type McpStatus = 'connected' | 'needs-login' | 'failed' | 'pending-approval'

export interface McpServerSpec {
  transport: 'stdio' | 'http' | 'sse'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpConnection {
  name: string
  scope: McpScope | 'claude-ai'
  spec: McpServerSpec
}

export interface McpHealthRow {
  name: string
  target: string
  status: McpStatus
  detail: string
}

export interface McpSaveRequest {
  cwd: string
  name: string
  scope: McpScope
  spec: McpServerSpec
  previous?: { name: string; scope: McpScope }
}

export type McpActionResult = { ok: true } | { ok: false; error: string }

export interface AgentHelper {
  task: string
  doing: string
  since: number
}

export interface AgentChecklistItem {
  label: string
  status: 'pending' | 'in_progress' | 'completed'
  /** The item is open because it needs Roy's hands or eyes, not because the
   *  agent is still on it. */
  waiting?: boolean
}

export interface AgentChecklist {
  goal?: string
  items: AgentChecklistItem[]
  done: number
}

export interface RepoGitState {
  branch: string
  upstream?: string
  ahead: number
  dirty: number
  head: { sha: string; subject: string }
  pending: string[]
  remoteHost?: string
}

export type RepoPushResult = { ok: true; pushed: number; upstream: string } | { ok: false; error: string }

export interface ChangedFile {
  path: string
  added?: number
  removed?: number
}

export type ChangeScope = 'message' | 'branch' | 'uncommitted'

export interface ChangeSet {
  base: string
  files: ChangedFile[]
  patch: string
  truncated: boolean
}

export interface RepoPull {
  url: string
  number: number
  state: 'open' | 'merged' | 'closed'
  base: string
  blocker?: string
}

export type RepoPullResult = { ok: true; pull: RepoPull } | { ok: false; error: string }

export type TurnUndoState = 'undo' | 'putBack'

export type CheckpointResult = { ok: true; state: TurnUndoState; files: number } | { ok: false; error: string }

export interface AgentRelaySessionInfo {
  label: string
  project?: { name: string; icon?: string; imageBase64?: string }
  /** What the agent called itself. Rendered UNDER `label`, never instead of it:
   *  a dictated name arrives garbled too often to be the identity you scan for. */
  stated?: string
  /** Socket has dropped but the row is held briefly, so a blip doesn't read as
   *  a session that ended. */
  stale?: boolean
  /** Epoch ms the socket dropped. `stale` says THAT it ended; this says when, so
   *  a card can read "Ended 3m ago" instead of a bare word that ages invisibly. */
  staleSince?: number
  cwd?: string
  /** Epoch ms the session's socket opened — drives the "for 4m" age. */
  since?: number
  /** The agent's process id, when its shim reported one. Absent for a shim that
   *  predates the facts header, which is exactly the row that cannot be told
   *  apart from its neighbours any other way. */
  pid?: number
  /** Which coding agent is running ("claude", "codex", "cursor"). Absent for a
   *  shim that predates the facts header, so every surface must render nothing
   *  rather than a placeholder. */
  agent?: string
  /** The agent's reasoning effort, when it reports one. Same absence rule. */
  effort?: string
  /** Which model is running, already in the words a person says ("Opus 5"), so
   *  every surface shows the same string. Absent for a shim that predates it or
   *  one that could not resolve a model — never guessed. */
  model?: string
  /** How the agent was started (the shim's own word for its entrypoint). */
  entrypoint?: string
  /** The agent's own session id. Survives a rename, which is what makes it the
   *  stable key for a detail sheet that must not follow the wrong card when a
   *  session renames itself mid-view. */
  sessionId?: string
  /** The shim's "go to this session" address, when it could derive one. Drives
   *  the detail sheet's jump-to-terminal action; absent means no jump exists. */
  origin?: AgentOrigin
  /** The app the session runs in ("cmux", "Cursor"), resolved from the origin's
   *  bundle id. Resolved STRINGS rather than the origin itself, because the
   *  phone renders these too and must never hold pane ids. */
  hostAppName?: string
  /** Its 16px icon, base64 PNG. Absent when the bundle had none; the name still
   *  renders on its own. */
  hostAppIconPngBase64?: string
  /** Where it lives, in the words on the tab strip: the cmux tab name when we
   *  can read it, else the bare pane id. */
  whereLabel?: string
  /** How many of this session's cards are still waiting on an answer. 0 is the
   *  normal state; anything above it is the only per-session signal the relay
   *  genuinely has, so it's the only one the dot is allowed to claim. */
  waiting?: number
  /** createdAt of this session's newest request WHEN that request is the idle
   *  "your turn" ping — any newer request of any verb clears it. Computed in
   *  main from the full store, so the resolved tail cap cannot drop it. */
  idleSince?: number
  /** The same stamp as `idleSince`, kept across the point where the user has
   *  SEEN it. Two different questions were riding one field: whether the ping is
   *  unread (which `withSeenIdle` spends, and should) and how long the session
   *  has been handed back (which opening a row does not change). Only the row's
   *  age caption reads this; the dot still keys on `idleSince`. */
  handedBackAt?: number
  /** When this session's CURRENT turn started, or undefined between turns —
   *  the one signal that separates an agent actually churning from one parked
   *  at a prompt. Mid-turn only: a session waiting on a build it kicked off
   *  ended its turn and is not busy. Set by the UserPromptSubmit hook, cleared
   *  by Stop, and expired by CONFIG.AGENT_RELAY.BUSY_MAX_MS so a killed agent
   *  that never fired Stop decays to Connected instead of lying. */
  busySince?: number
  /** When this session last PROVED it was working, refreshed by every tool-use
   *  ping rather than once per human prompt. `busySince` is turn AGE and is never
   *  refreshed; this is LIVENESS. Without it an agent working autonomously for
   *  more than BUSY_MAX_MS decayed to "Connected" and read as idle mid-run. */
  lastActivityAt?: number
  lastTurnEndedAt?: number
  /** Set by the PreCompact hook, cleared by PostCompact or the next tool/turn edge. */
  compactingSince?: number
  /** Last lines from the pane, filled on demand when the phone opens this
   *  session. Absent until peeked, and absent when there is no pane to read. */
  preview?: string
  /** Whether this row can be wrapped up. False for a shim too old to report its
   *  agent's pid — the pid it does send is the proxy's, so a wrap-up there would
   *  drop the row and leave the agent running headless. Resolved in main so no
   *  surface has to know that; a surface only has to hide the button. */
  canWrapUp?: boolean
  /** One plain line saying what this session is ABOUT, declared by the agent via
   *  `recap`. Every other field on this row is identity or an event; on a list of
   *  six panes sharing one checkout, this is the only one that says which is
   *  which by subject. Absent whenever the agent never declared one. */
  tldr?: string
  /** How far along the agent says it is, 0-1, declared via `notify`. Lives on
   *  the session and not on a card: the number describes the AGENT, so a card
   *  the sheet fails to match must not be able to take the ring down with it. */
  progress?: number
}

/** MCP clients we can configure for the user (PRD item 3b). */
export type McpClientId = 'claude-code' | 'codex' | 'cursor' | 'vscode'

/** One detected client. Absent from the list entirely = not installed on this Mac. */
export interface McpClientState {
  id: McpClientId
  label: string
  path: string
  configured: boolean
}

/** One ranked destination on the voice-routing card. */
export interface VoiceRouteOption {
  sinkId: string
  label: string
  appName: string
  /** 0-100, already rounded — the renderer displays it verbatim. */
  percent: number
}

/** Main → routing card: where this recording could go. */
/** Main → routing card, the instant the user asks for a ranking. Opens the card
 *  with nothing in it but the words being routed, so the 1-3s Jev takes is spent
 *  looking at a card filling in rather than at an empty screen. The real
 *  VoiceRoutePayload lands on the same window when the ranking returns. */
export interface VoiceRoutePendingPayload {
  runId: string
  /** First line of the transcript, same as VoiceRoutePayload.preview. */
  preview: string
  /** Bands the card should draw placeholder rows for, in order. Read from the
   *  toggles, so the skeleton has the shape the real answer will have. */
  bands: string[]
}

export interface VoiceRoutePayload {
  runId: string
  options: VoiceRouteOption[]
  /** How long the ranking took, ms. Shown top-right, frozen, once the rows
   *  land — the same number the routing log records. */
  latencyMs: number
  /** Pre-selected destination, or '' when Jev was too unsure to pick one. */
  suggestedSinkId: string
  /** False when confidence fell below the floor: the card still lists the
   *  options, but nothing is pre-selected and Enter does nothing. */
  confident: boolean
  /** Whether Jev judged the text ready to submit as-is. Drives whether the
   *  primary button says "send" or "paste". */
  submitNow: boolean
  /** Offer "Go there & submit" alongside "Paste & submit". */
  offerGoTo: boolean
  /** First line of the transcript, so the card can show what is being routed. */
  preview: string
  /** Filename of the screenshot going along with the transcript, '' when none.
   *  Shown so an attachment is never invisible: the user said "look at my last
   *  screenshot" and must be able to see WHICH one that resolved to before it
   *  is sent. Basename only — the full path is main-side. */
  screenshotName: string
  screenshotThumb: string
  /** Second column: skills to run and agents to hand this to. Empty when both
   *  toggles are off, which is when the card shows one column as before. */
  helperOptions: VoiceRouteHelperOption[]
  /** Jev's pick in the second column, or '' when it had none. */
  suggestedHelperId: string
  /** The app a new session opens in, e.g. 'Ghostty'. '' when the host could not
   *  be resolved, and the card must then stay silent about the destination
   *  rather than naming a terminal the user may not run. */
  newAgentHost: string
  /** Everything riding along with the words, so the card can show it. */
  sent: VoiceRouteSent
  /** Recent picks per sinkId, from the routing log. */
  picks: Record<string, number>
}

/** What actually leaves the machine on a send, item by item. Built from the
 *  same values delivery uses, never re-derived in the renderer. */
export interface VoiceRouteSent {
  /** Frontmost app when the recording started, '' when it could not be read. */
  appName: string
  /** Front window or browser tab title, '' when the app has no adapter. */
  title: string
  /** Front tab URL, '' for anything that is not a browser. */
  url: string
  /** Filename of the attached screenshot, '' when none. */
  screenshotName: string
  /** The whole transcript, not the one-line preview. */
  transcript: string
}

/** One second-column destination. No icon: a skill has none, and an agent's is
 *  the same terminal icon for every session, so the kind tag carries it. */
export interface VoiceRouteHelperOption {
  sinkId: string
  label: string
  /** 'skill' runs it; 'agent' types into that session; 'new-agent' starts a
   *  fresh session in that project. Drives the row's tag and, for 'new-agent',
   *  whether the row offers the harness pick. */
  kind: 'skill' | 'agent' | 'new-agent'
  /** What this destination is, one line — shown as the row's subtitle. */
  description: string
  percent: number
  /** Repo the agent is working in, '' for a skill. The row's letter badge comes
   *  from this, not from the label: the label leads with the branch, so six
   *  agents on `main` all drew the same M. */
  project: string
  /** Branch the agent sits on, '' when unknown or not an agent. */
  branch: string
  /** Folder the agent runs in or the new agent starts in, '' for a skill. */
  cwd: string
  /** Plain state — 'working right now', 'idle', 'disconnected'. '' for a skill. */
  activity: string
}

export type VoiceRouteMode = 'paste' | 'goto'

/** Renderer → main: the user picked a destination. */
export interface VoiceRoutePickPayload {
  runId: string
  sinkId: string
  mode: VoiceRouteMode
  submit: boolean
  /** Which app to start a new agent in. Only read for a 'new-agent' pick; the
   *  other kinds have a single delivery path and ignore it. */
  harness?: AgentHarness
  /** What was typed in the card's search box when the pick came from there. */
  query?: string
}

/** Where a new agent can be started. A preference about the user's own setup,
 *  which is why they pick it on the row rather than the model choosing. */
export type AgentHarness = 'claude' | 'codex' | 'opencode' | 'cursor' | 'tmux'

/** model '' = the CLI's own default. */
export interface AgentModelChoice {
  harness: 'claude' | 'codex' | 'opencode' | 'cursor' | 'ollama'
  model: string
}

export interface AgentModelOption extends AgentModelChoice {
  label: string
  reasoningEfforts?: ReasoningEffort[]
}

export interface AgentSetupProgress {
  harness: AgentModelChoice['harness']
  message: string
  percent: number | null
}

export interface AgentModelsState {
  options: AgentModelOption[]
  selected: AgentModelChoice | null
  needsSetup: Array<AgentModelChoice['harness']>
}

export interface VoiceRouteEnhancePayload {
  runId: string
  status: 'running' | 'done' | 'failed'
  kind: string
  variants: Array<{ label: string; text: string }>
  /** -1 = the original words. */
  selected: number
  startedAt: number
  tookMs: number
  reason: string
}

/** Main → routing card: how delivery went. */
export interface VoiceRouteResultPayload {
  runId: string
  /** The row this result belongs to, so the card can print the outcome in place
   *  instead of swapping itself for a separate box. '' when no row was picked. */
  sinkId?: string
  ok: boolean
  submitted: boolean
  /** App name for the toast ("Sent to Cursor"). */
  appName: string
  /** True when the place this landed can still be opened after the send, so the
   *  result card offers a button to go look at it. False for a destination the
   *  user is already looking at, or one that left nothing to visit. */
  canGo: boolean
  canRetry?: boolean
  canPickAgain?: boolean
  where?: string
  /** Why it failed, in the user's words, when `ok` is false. '' for a success.
   *  Without it every cause printed "Couldn't reach X" — including a session
   *  that had actually started. */
  reason: string
}

/** When the ranking runs. 'hover' costs nothing until the user hovers the
 *  transcript card and asks for it; 'always' ranks every transcription. */
export type VoiceRoutingMode = 'off' | 'hover' | 'always'

/** Settings ↔ main: the voice-routing flags. */
export interface VoiceRoutingConfig {
  mode: VoiceRoutingMode
  offerGoTo: boolean
  /** Show the second column's skills. On unless switched off. */
  showSkills: boolean
  /** Show the second column's running agents. On unless switched off. */
  showAgents: boolean
}

export interface ResourceRow {
  id: string
  name: string
  detail?: string
  cores: number
  memBytes: number
  iconDataUrl?: string
  pids: number[]
  /** Absolute .app bundle path, when the row came from one. Feeds the icon. */
  bundlePath?: string
  spark: number[]
  memSpark: number[]
}

export interface ResourceSnapshot {
  rows: ResourceRow[]
  totalCores: number
  totalMemBytes: number
  memFreePercent: number | null
  swapUsedBytes: number | null
  sampledAt: number
  /** Oldest-first stacked totals for the chart, one entry per fine-tier sample. */
  trend: ResourceTrendPoint[]
  /** Merge, don't replace. A tick sends only icons that just resolved. */
  icons?: Record<string, string>
  failed?: boolean
}

/** One fine-tier sample, already banded into the rows the chart draws. */
export interface ResourceTrendPoint {
  at: number
  usedCores: number
  usedMemBytes: number
  /** Cores per row id. Missing id = zero. */
  byId: Record<string, number>
  /** Memory bytes per row id. Missing id = zero. */
  memById: Record<string, number>
}

export interface LinkPreview {
  url: string
  site: string
  title?: string
  description?: string
  image?: string
  icon?: string
  isImage?: boolean
}

export interface FileReadResult {
  path: string
  size: number
  mtimeMs: number
  text?: string
  binary?: boolean
  tooBig?: boolean
  error?: 'secret' | 'outside' | 'missing' | 'directory'
}

export type FileWriteResult = { ok: true; mtimeMs: number } | { ok: false; reason: 'conflict' | 'forbidden' | 'failed' }

export type SideBrowserPageAction = { do: 'compose'; text: string } | { do: 'projectKind'; kind: string }
export type SideBrowserShortcut = 'newTab' | 'closeTab' | 'reopenTab' | 'focusAddress' | 'prevTab' | 'nextTab' | 'files' | 'annotate'

export interface SideBrowserAnnotation {
  path: string
  note: string
}

export interface SideBrowserTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  error?: string
  findOpen?: boolean
  found?: { active: number; matches: number }
  ask?: SideBrowserPermission
  sitePermissions?: SideBrowserPermission[]
  agentDoing?: string
  agentPaused?: boolean
  mods?: SiteModState[]
  modSuggestion?: string
  sharedMods?: SharedMod[]
  modLink?: SharedMod
}

export interface SideBrowserPermission {
  origin: string
  kind: string
  label: string
  allowed?: boolean
}

export interface SideBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export type SideBrowserCommand = 'back' | 'forward' | 'reload' | 'stop' | 'devtools' | 'external'

export interface PasskeyRequest {
  kind: 'create' | 'get'
  publicKey: Record<string, unknown>
}

export type PasskeyErrorCode =
  | 'not-entitled'
  | 'unsupported-os'
  | 'cancelled'
  | 'not-allowed'
  | 'invalid-rp-id'
  | 'not-top-frame'
  | 'internal'

export interface PasskeyResult {
  ok: boolean
  credential?: Record<string, unknown>
  errorCode?: PasskeyErrorCode
  errorMessage?: string
}

export interface SideBrowserSuggestion {
  url: string
  title: string
  favicon?: string
}

export interface SideBrowserImportSource {
  browser: string
  browserLabel: string
  profile: string
  name: string
  email?: string
  lastUsed: boolean
}

export type SideBrowserImportResult =
  | { ok: true; browserLabel: string; imported: number; sites: number; skipped: number }
  | { ok: false; reason: 'missing' | 'denied' | 'unreadable' }

export type PageControlKind =
  | 'text' | 'email' | 'tel' | 'url' | 'number' | 'search' | 'date' | 'month' | 'week' | 'time'
  | 'datetime-local' | 'password' | 'checkbox' | 'radio' | 'color' | 'range'
  | 'textarea' | 'select' | 'combobox' | 'editable' | 'button' | 'link'

export interface PageControl {
  ref: string
  kind: PageControlKind
  label: string
  value?: string
  hint?: string
  options?: string[]
  group?: string
  href?: string
  required?: boolean
  disabled?: boolean
  secret?: boolean
}

export interface PageRead {
  url: string
  title: string
  controls: PageControl[]
  text: string
  ms: number
}

export type PageFillResult =
  | { ref: string; ok: true; value: string }
  | { ref: string; ok: false; reason: string; value?: string }

export interface BrowserTaskRequest {
  instruction: string
  files: string[]
  context?: string
  tabs?: string[]
  editMod?: string
}

export interface BrowserTaskProgress {
  tabId: string
  line: string
  step?: boolean
  paused?: string
  showTab?: string
}

export type BrowserTaskControl = 'pause' | 'resume' | 'stop'

export interface BrowserTaskModel {
  source: 'cloud' | 'claude'
  model: string
}

export interface BrowserTaskModelOption extends BrowserTaskModel {
  label: string
}

export interface BrowserTaskModelsState {
  options: BrowserTaskModelOption[]
  selected: BrowserTaskModel
}

export type BrowserTaskFailure = { ok: false; reason: string; ms: number }

export type BrowserStepsResult = { ok: true; kind: 'steps'; answer: string; steps: number; ms: number; costUsd: number }

export type BrowserModResult = { ok: true; kind: 'mod'; name: string; summary: string; ms: number; costUsd: number }

export type BrowserTaskResult = BrowserFillResult | BrowserStepsResult | BrowserModResult | BrowserTaskFailure

export type SiteModAction = 'keep' | 'undo' | 'toggle' | 'remove' | 'rename' | 'list'

export type ModShareStatus = 'live' | 'pending' | 'pulled'

export interface SharedMod {
  id: string
  host: string
  name: string
  summary: string
  kind: 'look' | 'code'
  asks: string[]
  status: ModShareStatus
  statusReason: string | null
  installs: number
  fingerprint: string
  maker: { name: string; verified: boolean }
}

export type SharedModRequest =
  | { do: 'share'; modId: string; makerName?: string }
  | { do: 'unshare'; modId: string }
  | { do: 'add'; sharedId: string; yes?: boolean }
  | { do: 'report'; sharedId: string; reason: string }
  | { do: 'sync' }

export interface SharedModResult {
  ok: boolean
  message?: string
  url?: string
  status?: ModShareStatus
  needsName?: boolean
  needsYes?: string[]
  canRetry?: boolean
}

export interface SiteModState {
  id: string
  name: string
  host: string
  on: boolean
  broken?: string
  kind: 'look' | 'code'
  asks: string[]
  builtIn?: boolean
  pulled?: string
  shared?: { id: string; url: string; maker: string; verified: boolean; mine: boolean; status: ModShareStatus }
}

export type BrowserFillResult =
  | {
      ok: true
      kind: 'fill'
      filled: string[]
      unsure: string[]
      missing: string[]
      failed: string[]
      ms: number
      readMs: number
      docMs: number
      modelMs: number
      costUsd: number
    }
  | BrowserTaskFailure
