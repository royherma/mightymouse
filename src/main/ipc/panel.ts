import { ipcMain, clipboard } from 'electron'
import { finishActiveCapture, cancelActiveCapture } from '../capture'
import { handsFreeHudId, stopHandsFree } from '../capture/hands-free'
import { runCaptureAction, clearCaptureAction, isCaptureCard } from '../capture/capture-actions'
import { resolvePendingAct } from '../capture/smart-dictation'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { buildActivationChecklist } from '../activation-checklist'
import {
  SubmitPayload,
  CtxTogglePayload,
  DraftInputPayload,
  ModeOverridePayload,
  ResizePayload,
  CopyPayload,
  ActionSelectPayload,
  SuggestionAcceptPayload,
  ResumeSessionResult,
  PanelInitData,
  HistoryEntry,
  HudActionPayload,
  HudConfirmActPayload,
  HudRelayAnswerPayload,
  FeedbackRating,
  MediaAttachment
} from '../../shared/types'
import { detectMode } from '../../shared/mode'
import { relayRequestStore } from '../agent-relay/store'
import { goToOriginFromHud, hasResolvableOriginFromHud } from '../hud-window'
import { CONFIG, buildLastHint } from '../../shared/config'
import { CHANNELS } from '../../shared/ipc'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { HISTORY } from '../store/history'
import { FEEDBACK } from '../store/feedback'
import { EVENTS } from '../store/events'
import { MIGHTY } from '../store/mighty'
import { resumeTarget } from '../store/resume-target'
import { ACTIONS } from '../store/actions'
import { UNREAD } from '../store/unread'
import { captureScreenshot } from '../platform'
import { abortRun } from '../backend/runner'
import { prependCharter } from '../backend/prompts'
import { BackendId, toBackendId } from '../backend/adapters'
import { estimateDuration } from '../estimator/duration-estimator'
import { clearBinaryCache } from '../platform'
import { buildMemoryBlob, assembleHistoryRecall } from '../backend/context-memory'
import {
  mightBeRecall,
  mightBeTimelineRecall,
  classifyRecallIntent
} from '../backend/recall-classifier'
import { segmentEvents } from '../backend/activity-recall'
import { assembleTimelineRecall } from '../backend/timeline-recall'
import { summarizeAttachments } from '../../shared/attachments'
import { parseDateRange } from '../backend/history-date-parser'
import { rankActivityForQuery, assembleActivityRecall, type ActivitySegment } from '../backend/activity-recall'
import { readContextEventsInRange } from '../backend/context-memory'
import {
  runHudRun,
  runHudFollowUp,
  getHudThread,
  detachActiveRunsToHud,
  type ResolvedActionExtra
} from '../backend/hud-run'
import {
  closePanelWindow,
  consumePendingOpenTo,
  consumePendingWelcome,
  getPanelWindow,
  getMinimizeOrigin,
  hidePanelWindow,
  needsPanelReseed,
  queueResumeConversation,
  resetPanelHeight,
  resizePanelWindow,
  sendToPanelRenderer
} from '../panel-window'
import { route } from '../routing'
import { getSupabase } from '../supabase'
import {
  startHud,
  runningHud,
  handleHudClick,
  keepHudAlive,
  setHudFocusable,
  rearmHudDismiss,
  dismissHud,
  setHudCardHeight
} from '../hud-window'
import {
  setCursorCompanion,
  setCursorClickable,
  setCursorFocusable
} from '../cursor-window'
import {
  acceptActiveSuggestion,
  dismissActiveBubble
} from '../insights/insights-manager'
import { peekTriggerData, clearTriggerData } from '../hotkeys'
import { captureContext } from '../platform'
import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  getPanelState,
  setPanelState,
  getActivePanelRunId,
  setActivePanelRunId,
  buildCtxLabel,
  buildCtxIdentity,
  actionVisible
} from './panel-state'

// Media extensions a bare selection might name. Mirrors prompts.ts MEDIA_EXTS;
// kept local + small to avoid a cross-module import just for a suffix test.
const SELECTION_MEDIA_EXTS = [
  '.mov', '.mp4', '.m4v', '.mkv', '.webm', '.avi',
  '.m4a', '.mp3', '.wav', '.aac', '.flac', '.aiff', '.caf'
]

/**
 * When a Finder file comes through as TEXT (a bare filename in the selection) rather
 * than via captureFinderSelection, the act agent gets no path and wastes a tool call
 * running `find` to locate it. If the selection is a single media-looking filename,
 * resolve it to an absolute path under the likely folder (the Finder window's dir,
 * else ~/Downloads, ~/Desktop, ~/Movies) so the agent operates on a real path.
 * Returns [] when it can't confidently resolve a single existing file.
 */
/**
 * Serialize a finished AI card's full chat (the original instruction + every ask
 * turn) to a temp markdown file, for attaching as context when a skill runs off the
 * card. Pulls turns from the in-memory HUD thread (ask cards) and the instruction
 * from the History row (any mode). Returns the file path, or '' if there's nothing
 * to write / the write fails (the skill then just runs with no chat attached).
 */
function writeChatContextFile(runId: string): string {
  const turns = getHudThread(runId)
  const row = HISTORY.readAllEntries().find((e) => e.run_id === runId)
  // Nothing to serialize — no thread turns and no history row for this run.
  if (turns.length === 0 && !row) return ''

  const parts: string[] = ['# Chat context', '']
  if (row?.instruction) parts.push(`**Instruction:** ${row.instruction}`, '')
  if (turns.length > 0) {
    for (const t of turns) {
      parts.push(`## You`, t.q, '', `## Assistant`, t.a, '')
    }
  } else if (row?.result) {
    // Non-ask card (act/rewrite) has no turns — use the row's result as the answer.
    parts.push(`## Assistant`, row.result, '')
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(PATHS.TMP, `chat-context-${stamp}-${runId.replace(/[^a-z0-9]/gi, '')}.md`)
  try {
    writeFileSync(file, parts.join('\n'), 'utf-8')
    return file
  } catch {
    return ''
  }
}

function resolveSelectionToFiles(selection: string, windowTitle: string): string[] {
  const name = selection.trim()
  if (name === '' || name.includes('\n')) return []
  const lower = name.toLowerCase()
  if (!SELECTION_MEDIA_EXTS.some((ext) => lower.endsWith(ext))) return []
  if (name.startsWith('/') && existsSync(name)) return [name] // already an absolute path

  const home = homedir()
  const dirs = [
    windowTitle ? join(home, windowTitle) : '', // e.g. window title "Downloads"
    join(home, 'Downloads'),
    join(home, 'Desktop'),
    join(home, 'Movies')
  ].filter((d) => d !== '')
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return [candidate]
  }
  return []
}

// Resolve a "recall my own history" query into a ready-to-inject memory blob +
// system prompt, or null if the query isn't recall. Two-stage: a free keyword gate,
// then (paid backend only) a fast Haiku classifier to pin the date window + search
// terms. Free backends fall back to the deterministic date-parser. Retrieval is
// date-window → text-search → recent, whichever the signals point to.
/**
 * Resolve a "recap my period" query (RecallIntent 'timeline') into a day-by-day
 * chronological blob. Merges the user's MightyMouse history (what they asked) with
 * their ambient app/site activity (what they used) across the window, bucketed by day.
 * Activity is only included when the context-log is enabled (opt-in) — otherwise the
 * timeline is just the history side. Defaults to the last 7 days when no window is named.
 */
function resolveTimelineRecall(
  from: Date | null,
  to: Date | null
): { blob: string; system: string } {
  // Default recap window = last 7 days (a "what did I do" with no date).
  const start = from ?? (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d })()
  const end = to ?? new Date()

  const entries = HISTORY.readByDate(start, end)

  let segments: ActivitySegment[] = []
  if (PREFS.getContextLog()) {
    const events = readContextEventsInRange(start.getTime(), end.getTime())
    segments = segmentEvents(events)
  }

  return {
    blob: assembleTimelineRecall(entries, segments, CONFIG.MEDIA_RECALL.RECALL_CHAR_BUDGET),
    system: prependCharter(CONFIG.SYSTEM_PROMPT_TIMELINE)
  }
}

async function resolveRecall(
  instr: string,
  backend: BackendId
): Promise<{ blob: string; system: string } | null> {
  const historyGate = mightBeRecall(instr)
  const timelineGate = mightBeTimelineRecall(instr)
  if (!historyGate && !timelineGate) return null

  let from: Date | null = null
  let to: Date | null = null
  let terms: string[] = []

  // Paid backend → model classifier (date window + distilled query). Free backends
  // have no Haiku path, so use the deterministic date parser instead.
  if (backend === 'mightymouse') {
    const getJwt = async (): Promise<string> => {
      const { data } = await getSupabase().auth.getSession()
      return data.session?.access_token ?? ''
    }
    const c = await classifyRecallIntent(instr, getJwt)
    // Chronological recap of a period → merge history + activity, day by day.
    if (c.intent === 'timeline') {
      let tFrom: Date | null = null
      let tTo: Date | null = null
      if (c.dateWindow) {
        tFrom = new Date(c.dateWindow.start + 'T00:00:00')
        const end = new Date(c.dateWindow.end + 'T00:00:00')
        end.setDate(end.getDate() + 1) // make the end day inclusive
        tTo = end
      }
      return resolveTimelineRecall(tFrom, tTo)
    }
    // Classifier whiffed to 'other' but the query clearly reads as a recap
    // ("recap my week") → honor the deterministic timeline gate rather than
    // dropping the feature to a plain ask. Uses the regex date parser for the window.
    if (c.intent === 'other' && timelineGate) {
      const range = parseDateRange(instr)
      return resolveTimelineRecall(range ? range.from : null, range ? range.to : null)
    }
    if (c.intent !== 'recall') return null
    if (c.dateWindow) {
      from = new Date(c.dateWindow.start + 'T00:00:00')
      const end = new Date(c.dateWindow.end + 'T00:00:00')
      end.setDate(end.getDate() + 1) // make [start, end] inclusive of the end day
      to = end
    }
    if (c.semanticQuery.trim() !== '') terms = c.semanticQuery.trim().split(/\s+/)
  } else {
    // "recap my week" → chronological timeline, not a pointed history answer. The
    // timeline gate is narrower than the recall gate, so check it first; a bare
    // date word alone ("yesterday") stays on the pointed-recall path below.
    if (timelineGate) {
      const range = parseDateRange(instr)
      return resolveTimelineRecall(range ? range.from : null, range ? range.to : null)
    }
    const range = parseDateRange(instr)
    if (range) {
      from = range.from
      to = range.to
    }
  }

  // Retrieve: prefer an explicit date window; else text search; else recent activity.
  let entries: HistoryEntry[]
  if (from && to) {
    entries = HISTORY.readByDate(from, to)
    if (terms.length > 0) {
      const set = new Set(HISTORY.searchText(terms).map((e) => e.run_id))
      const narrowed = entries.filter((e) => set.has(e.run_id))
      if (narrowed.length > 0) entries = narrowed
    }
  } else if (terms.length > 0) {
    entries = HISTORY.searchText(terms)
  } else {
    // Recall-flavored but no window/terms (e.g. "what's in my history") → last 7 days.
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    entries = HISTORY.readByDate(weekAgo, new Date())
  }

  const historyBlob = assembleHistoryRecall(entries.slice(0, 50), instr)

  // "What did I DO" (apps/sites/typed activity) is a different source than "what did
  // I ASK MightyMouse" (HISTORY, above) — mirrors media.ts's Phase 3b. Only when the
  // context-log is enabled (opt-in); skip silently otherwise.
  let activityBlob = ''
  if (PREFS.getContextLog()) {
    const startMs = from ? from.getTime() : Date.now() - 7 * 86400000
    const endMs = to ? to.getTime() : Date.now()
    const events = readContextEventsInRange(startMs, endMs)
    const segments = rankActivityForQuery(events, instr, terms, CONFIG.MEDIA_RECALL.ACTIVITY_TOP_N, from !== null)
    activityBlob = assembleActivityRecall(segments, CONFIG.MEDIA_RECALL.ACTIVITY_CHAR_BUDGET)
  }

  return {
    blob: activityBlob ? `${historyBlob}\n\n${activityBlob}` : historyBlob,
    system: prependCharter(CONFIG.SYSTEM_PROMPT_RECALL)
  }
}

/**
 * Build the panel's first-frame payload AND seed panelState for the submit/run
 * handlers. Consumes the hotkey's trigger data when present; otherwise captures
 * live CONTEXT (no-trigger opens: tray "Open", open/history hotkeys, first open
 * after a restart). Used by the getInitialData handler (mount) and by the
 * re-trigger path (CHANNELS.panelReseed) — same payload both ways.
 *
 * We capture ONLY context in the no-trigger branch, never selection: selection
 * capture falls back to a Cmd+C clipboard swap, and by the time this runs the
 * panel is taking focus — so a stray Cmd+C targets the wrong app and can leak
 * the internal `__cm_rewrite_sentinel_…` clipboard marker into the input. A
 * no-trigger open is explicitly "no selection", which is correct.
 */
export async function buildPanelInitData(): Promise<PanelInitData> {
  const t = peekTriggerData()
  const ctxOn = t?.ctxOn ?? PREFS.getCtxToggle()
  const ctx = t?.ctx ?? (await captureContext())
  const selection = t?.selection ?? ''
  // Restore the quick-action a saved draft was composed under (see draftInput
  // below) so resubmitting it still carries the action's system_extra/skill.
  const allActions = ACTIONS.load()
  const savedActionKey = PREFS.getActiveActionKey()
  const savedAction = savedActionKey ? allActions.find((a) => a.key === savedActionKey) ?? null : null

  // Seed the state used by submit/run handlers.
  setPanelState({
    runId: t?.runId ?? `r:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`,
    selection,
    history: [],
    modeOverride: PREFS.getLastMode(),
    ctx,
    ctxOn,
    finderFiles: t?.finderFiles ?? [],
    activeAction: savedAction
  })

  const lastInstr = PREFS.getLastInstruction()
  const placeholder = buildLastHint(lastInstr)

  const actions = allActions.filter((a) => actionVisible(a, ctx.browserURL))

  return {
    selection,
    placeholder,
    lastInstr,
    lastMode: PREFS.getLastMode(),
    ctxOn,
    ctxLabel: buildCtxLabel(ctx),
    ...buildCtxIdentity(ctx),
    actions,
    backend: PREFS.getBackend(),
    ollamaModel: PREFS.getOllamaModel(),
    mlxModel: PREFS.getMlxModel(),
    selectedModel: PREFS.getSelectedModel(),
    cursorOn: PREFS.getCursorCompanion(),
    feedbackEnabled: PREFS.getFeedbackEnabled(),
    incognito: PREFS.getIncognito(),
    historyFilterHidden: PREFS.getHistoryFilterHidden(),
    mightySourceFilterHidden: PREFS.getMightySourceFilterHidden(),
    mightyShowEmpty: PREFS.getMightyShowEmpty(),
    draftInput: PREFS.getDraftInput(),
    activeActionKey: savedAction?.key ?? '',
    // 'history' when opened from the tray History item — the renderer opens the
    // flyout on mount/reseed. Single-shot: cleared so the next plain open is normal.
    openTo: consumePendingOpenTo(),
    welcome: consumePendingWelcome(),
    checklist: buildActivationChecklist()
  }
}

export function registerPanelHandlers(): void {
  // ── Panel window ───────────────────────────────────────────────────────────
  // The renderer calls this on mount. buildPanelInitData consumes the hotkey's
  // trigger data (selection + window context), seeds panelState, and returns
  // everything the panel needs to render its first frame.
  ipcMain.handle(CHANNELS.getInitialData, () => buildPanelInitData())

  ipcMain.on(CHANNELS.panelChecklistSeenDone, () => PREFS.setChecklistSeenDone())

  ipcMain.on(CHANNELS.modeOverride, (_, payload: ModeOverridePayload) => {
    const panelState = getPanelState()
    if (panelState) {
      panelState.modeOverride = payload.mode
      PREFS.setLastMode(payload.mode)
      EVENTS.append({ run_id: panelState.runId, event: 'mode_override', mode: payload.mode || '' })
      track(ANALYTICS_EVENT.panel_mode_override, { mode: payload.mode })
    }
  })

  ipcMain.on(CHANNELS.ctxToggle, (_, payload: CtxTogglePayload) => {
    PREFS.setCtxToggle(payload.on)
    const panelState = getPanelState()
    if (panelState) {
      panelState.ctxOn = payload.on
      EVENTS.append({ run_id: panelState.runId, event: 'ctx_toggle', on: payload.on })
      track(ANALYTICS_EVENT.panel_ctx_toggle, { on: payload.on })
    }
  })

  // Debounced from the renderer on every keystroke — see PREFS.setDraftInput.
  ipcMain.on(CHANNELS.draftInput, (_, payload: DraftInputPayload) => {
    PREFS.setDraftInput(payload.text)
  })

  ipcMain.on(CHANNELS.cursorToggle, (_, payload: CtxTogglePayload) => {
    const on = payload.on === true
    PREFS.setCursorCompanion(on)
    setCursorCompanion(on)
    const panelState = getPanelState()
    if (panelState) {
      EVENTS.append({ run_id: panelState.runId, event: 'cursor_companion_toggle', on })
    }
  })

  ipcMain.on(CHANNELS.cursorDismiss, () => {
    dismissActiveBubble()
  })

  ipcMain.on(CHANNELS.cursorSetClickable, (_, payload: CtxTogglePayload) => {
    setCursorClickable(payload.on === true)
  })

  ipcMain.on(CHANNELS.cursorSetFocusable, (_, payload: CtxTogglePayload) => {
    setCursorFocusable(payload.on === true)
  })

  ipcMain.on(CHANNELS.cursorAccept, (_, payload: SuggestionAcceptPayload) => {
    acceptActiveSuggestion(payload.index, payload.finalText)
  })

  ipcMain.on(CHANNELS.actionSelect, (_, payload: ActionSelectPayload) => {
    const panelState = getPanelState()
    if (!panelState) return
    const actions = ACTIONS.load()
    const found = actions.find((a) => a.key === payload.key)
    if (found) {
      panelState.activeAction = found
      PREFS.setActiveActionKey(found.key)
      EVENTS.append({ run_id: panelState.runId, event: 'action_selected', action_key: found.key })
      track(ANALYTICS_EVENT.quick_action, { kind: 'select' })
    } else {
      panelState.activeAction = null
      PREFS.setActiveActionKey(null)
    }
  })

  ipcMain.on(CHANNELS.actionClear, () => {
    const panelState = getPanelState()
    PREFS.setActiveActionKey(null)
    if (panelState) {
      panelState.activeAction = null
      EVENTS.append({ run_id: panelState.runId, event: 'action_cleared' })
      track(ANALYTICS_EVENT.quick_action, { kind: 'clear' })
    }
  })

  ipcMain.on(CHANNELS.historyRequest, (event, query?: string) => {
    // Opening History = "I've seen my runs" — clear the menu-bar unread badge.
    // The onChange listener re-renders the tray (no explicit refresh needed here).
    UNREAD.clear()
    // Always answer with the rows: reading history is independent of a live run.
    // Gating on `panelState` here was a race — when History is opened cold from
    // the tray (the unread-badge case), the request can land before the panel's
    // getInitialData mount has seeded panelState, so the guard dropped the reply
    // and the flyout sat on its loading/empty state forever.
    // Reply to whichever window asked (panel OR the Mighty full-screen History tab)
    // instead of hardcoding the panel — this channel is shared by both surfaces.
    const q = typeof query === 'string' ? query.trim() : ''
    const items = HISTORY.readRecent(30, q)
    event.sender.send(CHANNELS.historyData, items)
    // A search re-asks on every pause in typing - only the first ask is an "open".
    if (q !== '') return
    track(ANALYTICS_EVENT.history_action, { kind: 'open' })
    // Run-scoped event log only when there's a live run to attribute it to.
    const panelState = getPanelState()
    if (panelState) {
      EVENTS.append({ run_id: panelState.runId, event: 'history_opened', count: items.length })
    }
  })

  // Record an explicit 👍/👎 (+ optional "what I expected" note) for a run, keyed
  // by run_id. Persists to the feedback store, fires the eval analytics event, and
  // returns the stored entry so the renderer can confirm its optimistic state.
  ipcMain.handle(
    CHANNELS.feedbackSubmit,
    async (_, payload: { run_id: string; rating: FeedbackRating | null; note?: string }) => {
      const runId = (payload?.run_id || '').trim()
      if (runId === '') return null
      // A thumb is either 'up'/'down', or null for a NOTE-ONLY entry (a capture with
      // no AI answer to rate). A null-rating entry with no note is meaningless — drop it.
      const rating = payload.rating === 'up' || payload.rating === 'down' ? payload.rating : null
      const note = payload.note?.trim() || undefined
      if (rating === null && !note) return null
      // Denormalize mode/backend off the run so analytics can slice without a join.
      const row = HISTORY.readAllEntries().find((e) => e.run_id === runId)
      FEEDBACK.record({
        run_id: runId,
        rating,
        note,
        mode: row?.mode,
        backend: row?.backend
      })
      track(ANALYTICS_EVENT.feedback_given, {
        rating: rating ?? 'note',
        mode: row?.mode ?? 'ask',
        backend: row?.backend ?? '',
        has_note: !!note
      })
      return FEEDBACK.get(runId)
    }
  )

  ipcMain.on(CHANNELS.copy, (_, payload: CopyPayload) => {
    clipboard.writeText(payload.text || '')
    track(ANALYTICS_EVENT.history_action, { kind: 'copy' })
  })

  // Paste an arbitrary string into the frontmost app (History "Paste" button).
  // The user clicks back into their doc, then clicks Paste; we Cmd+V there.
  ipcMain.on(CHANNELS.cancel, () => {
    const panelState = getPanelState()
    if (panelState) {
      EVENTS.append({ run_id: panelState.runId, event: 'dismissed' })
    }
    track(ANALYTICS_EVENT.panel_dismissed, {})
    // Closing the panel never kills the spawned CLI — so any run still in flight
    // keeps going. Re-point it to a live HUD card NOW (top-right, dismissable) so
    // it stays visible during the run instead of reappearing only when it finishes.
    detachActiveRunsToHud()
    // The run now lives on as a HUD card — the panel's Stop no longer owns it.
    setActivePanelRunId(null)
    // Drop the trigger so a later reopen with no fresh hotkey (tray, history)
    // starts from live context, not this run's stale selection/window.
    clearTriggerData()
    closePanelWindow()
  })

  // Hide the panel without closing it — unlike cancel, an in-flight run keeps
  // reporting to the panel (not detached to a HUD card) and renderer state
  // (answerVisible, conversation) survives. The existing panel hotkey (⌘⌥⇧M)
  // restores it via showPanelWindow's hidden-window branch.
  // Where the minimize animation should shrink toward, in the panel's own
  // coordinate space. Computed per click, not cached: the panel follows the
  // cursor on every open, so a stale origin would aim at the wrong corner.
  ipcMain.handle(CHANNELS.panelMinimizeOrigin, () => getMinimizeOrigin())

  ipcMain.on(CHANNELS.panelHide, () => {
    track(ANALYTICS_EVENT.panel_dismissed, {})
    hidePanelWindow({ yieldApp: false })
  })

  // Stop button on a live chat turn: SIGKILL the in-flight CLI but keep the panel
  // open. The killed child's `close` fires the standard failure path (onDone with a
  // nonzero code) → onShowError clears the renderer's pending state. The renderer
  // restores the just-sent text into the composer so the user can edit + resend.
  ipcMain.on(CHANNELS.stopRun, () => {
    // Kill ONLY the panel's in-flight run — never sibling runs (a HUD card, a cheese
    // task). activePanelRunId is the cardRunId we passed to runHudRun.
    const activePanelRunId = getActivePanelRunId()
    const killed = activePanelRunId ? abortRun(activePanelRunId) : false
    setActivePanelRunId(null)
    const panelState = getPanelState()
    if (panelState) {
      EVENTS.append({ run_id: panelState.runId, event: 'run_stopped' })
    }
    track(ANALYTICS_EVENT.run_stopped, { killed: killed ? 1 : 0 })
  })

  // "Back / New" from the chat view: drop the conversation context and start a
  // fresh run so the next ask is its own distinct History entry. Panel stays open.
  ipcMain.on(CHANNELS.resetSession, () => {
    const panelState = getPanelState()
    if (!panelState) return
    EVENTS.append({
      run_id: panelState.runId,
      event: 'session_reset',
      turns: panelState.history.length
    })
    panelState.history = []
    panelState.sessionTitle = undefined
    panelState.runId = `r:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`
    PREFS.setDraftInput('')
    PREFS.setActiveActionKey(null)
    // Snap the frame back to compact — a chat that grew the window shouldn't
    // leave a tall empty panel behind on New.
    resetPanelHeight()
  })

  // "Continue" from a history row: re-seed the live panel from a past run so the
  // next submit APPENDS to that conversation instead of starting fresh. The inverse
  // of resetSession — we adopt the run's own run_id (so the re-written history row
  // collapses onto the original, not a duplicate), load its turns as conversation
  // context, and restore the backend it ran on (a continuation, not a fresh run on
  // whatever's currently selected). Rewrite/act rows have no `turns`; we synthesize
  // a single {q:instruction, a:result} turn so any LLM row can be continued as chat.
  ipcMain.handle(
    CHANNELS.resumeSession,
    async (_, runId: string): Promise<ResumeSessionResult> => {
      // findLast, not .reverse().find() — the latter mutated the array it was given.
      const entry = HISTORY.readAllEntries().findLast((e) => e.run_id === runId)
      const backend = PREFS.getBackend()
      const panelState = getPanelState()
      if (!entry || !panelState) {
        return { ok: false, turns: [], mode: 'ask', backend }
      }
      // Both halves of "what does this row resume to?" live in resume-target.ts so
      // the tests exercise the real rule instead of a copy of it.
      const target = resumeTarget(entry, (id) => MIGHTY.findSessionIdByRunId(id))
      const turns = target.turns
      if (turns.length === 0) return { ok: false, turns: [], mode: 'ask', backend }

      // Adopt the run's identity + thread so the next turn lands on the same row.
      panelState.history = turns.slice()
      panelState.runId = entry.run_id
      panelState.sessionTitle = entry.instruction
      // Adopt its MODE too. The next submit re-writes this same run_id, so leaving
      // the override stale would both run the follow-up in the wrong mode and flip
      // the stored row's chip to whatever mode that turn happened to be.
      const resumedMode = entry.mode || 'ask'
      panelState.modeOverride = resumedMode
      PREFS.setLastMode(resumedMode)
      // Continuation runs on the backend the conversation was built on, not the
      // current pref. Re-resolve binaries in case that CLI wasn't probed at launch.
      const runBackend = toBackendId(entry.backend)
      clearBinaryCache()
      PREFS.setBackend(runBackend)
      // Other open windows (Mighty, a second Panel) should learn the pref
      // changed too, not just the window that resumed this session.
      const { broadcastBackendChanged } = await import('../index')
      broadcastBackendChanged(runBackend)
      EVENTS.append({ run_id: entry.run_id, event: 'session_resumed', turns: turns.length })
      // Resume in the mode the run ACTUALLY ran in, not a hardcoded 'ask'. Returning
      // 'ask' here silently downgraded a continued act run to a plain question — the
      // follow-up lost tool/screen access and the row's chip flipped act→ask.
      return {
        ok: true,
        turns,
        mode: resumedMode,
        capture_kind: entry.capture_kind,
        backend: runBackend,
        // undefined → no session on record, so callers seed a transient thread.
        sessionId: target.sessionId ?? undefined
      }
    }
  )

  // Snap the panel back to its compact default height WITHOUT touching the session
  // (used by Reuse — refilling the box from history shouldn't leave the window tall).
  ipcMain.on(CHANNELS.resetPanelHeight, () => {
    resetPanelHeight()
  })

  ipcMain.on(CHANNELS.resize, (_, payload: ResizePayload) => {
    resizePanelWindow(payload.h, payload.inChat)
  })

  // Hover buttons on a live recording/listen HUD card: Stop finalizes it
  // (same as pressing the capture hotkey again), Cancel discards it (same as
  // Esc→Enter but immediate — the click itself is the confirmation).
  ipcMain.on(CHANNELS.hudStopCapture, (_, payload: { runId: string }) => {
    finishActiveCapture(payload.runId)
  })

  ipcMain.on(CHANNELS.hudCancelCapture, (_, payload: { runId: string }) => {
    cancelActiveCapture(payload.runId)
  })

  // Stop button on a live Ask/Act HUD card: SIGKILL only THIS card's in-flight CLI
  // (never sibling runs). The killed child's `close` fires the standard failure
  // path → the card settles into its normal error/stopped state, so we don't
  // dismiss it here. Distinct from hudCancelCapture (that path discards a
  // recording); this one aborts an LLM run that's already thinking.
  ipcMain.on(CHANNELS.hudStopRun, (_, payload: { runId: string }) => {
    const killed = abortRun(payload.runId)
    EVENTS.append({ run_id: payload.runId, event: 'run_stopped' })
    track(ANALYTICS_EVENT.run_stopped, { killed: killed ? 1 : 0 })
  })

  ipcMain.on(CHANNELS.hudDismiss, (_, payload: { runId: string }) => {
    // Closing a LIVE capture's card must stop the capture, not just hide it.
    // Every other card is a finished result, so × is purely visual there — but
    // hands-free's card is the mode indicator, and dismissing it alone left the
    // mic open with nothing on screen saying so.
    if (handsFreeHudId() === payload.runId) {
      stopHandsFree()
      return
    }
    // Closing the card = you're done with this result → drop it from the unread
    // badge (per-run, not the bulk History-open clear).
    UNREAD.markRead(payload.runId)
    // Clears both the capture context AND the ask conversation thread for this
    // card (clearCaptureAction co-clears via clearHudThread).
    clearCaptureAction(payload.runId)
    // Actually close the card — the × button should remove it, not just flip it
    // to a red "dismissed" state that lingers (which is what failHud did).
    dismissHud(payload.runId)
  })

  // Inline follow-up question typed into an ask HUD card: reuse the card's stored
  // conversation thread and run another ask turn on the same card.
  ipcMain.on(CHANNELS.hudFollowUp, (_, payload: { runId: string; q: string }) => {
    // Asking a follow-up = you read the result and are using it → mark seen.
    UNREAD.markRead(payload.runId)
    runHudFollowUp(payload.runId, payload.q || '')
  })

  // Run a skill (QuickAction) against a FINISHED card. Two attachment shapes:
  //  • capture card (screenshot/recording/listen) → the capture folder/file is the
  //    context (reuses runCaptureAction, which already grants the folder to act).
  //  • AI-answer card (ask/act/rewrite) → serialize the full chat (instruction +
  //    every turn) to a temp .md and attach it as a `file`, so the skill runs with
  //    the whole conversation as context. Reuses the existing attachment pipeline —
  //    no new adapter/backend plumbing.
  ipcMain.on(CHANNELS.hudRunSkill, (_, payload: { runId: string; actionKey: string }) => {
    const runId = (payload?.runId || '').trim()
    const action = ACTIONS.load().find((a) => a.key === payload?.actionKey)
    if (runId === '' || !action) return
    UNREAD.markRead(runId)

    const actionExtra: ResolvedActionExtra = {
      key: action.key,
      system_extra: action.system_extra ?? '',
      // Inline body wins over a skill file path (mirrors the panel submit handler).
      skill_body: action.body || (action.skill_path ? ACTIONS.readSkillBody(action.skill_path) : '')
    }

    // Capture card: the folder IS the attachment. runCaptureAction handles the rest.
    if (isCaptureCard(runId)) {
      runCaptureAction(runId, 'act', action.instruction, actionExtra)
      return
    }

    // AI-answer card: serialize the full chat to a temp .md and attach it.
    const chatFile = writeChatContextFile(runId)
    const attachments: MediaAttachment[] = chatFile
      ? [{ path: chatFile, kind: 'file', name: 'chat-context.md' }]
      : []

    const backend = PREFS.getBackend()
    const short = action.label.length > 40 ? action.label.slice(0, 40) + '…' : action.label
    const etaMs = estimateDuration('act', backend)?.etaMs ?? 0
    runningHud(runId, `⚡ ${action.label}`, short, etaMs)
    setActivePanelRunId(runId)

    runHudRun({
      runId,
      historyRunId: runId,
      mode: 'act',
      // The skill's own instruction is the command; the chat rides as the attachment.
      instruction: action.instruction || `Apply the "${action.label}" skill to the attached chat.`,
      selection: '',
      selFile: '',
      ctxData: null,
      finderFiles: [],
      conversationHistory: [],
      sessionTitle: '',
      actionExtra,
      memoryBlob: buildMemoryBlob({ mode: 'act' }),
      backend,
      attachments,
      source: 'panel',
      triggerApp: ''
    })
  })

  // Content-driven sizing: the HUD renderer reports its measured height so the
  // window fits its content exactly (no clipped buttons/inputs, shrinks back too).
  ipcMain.on(CHANNELS.hudResize, (_, payload: { runId: string; height: number }) => {
    setHudCardHeight(payload.runId, payload.height)
  })

  ipcMain.on(CHANNELS.hudReveal, async (_, payload: { runId: string }) => {
    // Clicking into the card = you opened the result → mark seen.
    UNREAD.markRead(payload.runId)
    clearCaptureAction(payload.runId)
    const resume = handleHudClick(payload.runId)
    if (!resume) return
    // Smart-dictation card: hand off to the conversation it just logged, same
    // single-shot openTo handoff as opening History from the tray (see
    // openHistory() in index.ts) — the RENDERER resumes it once mounted/reseeded,
    // no timer to race the panel's init.
    const wasOpen = needsPanelReseed()
    queueResumeConversation(payload.runId)
    route('panel', { panelSource: 'other' })
    if (wasOpen) {
      sendToPanelRenderer(CHANNELS.panelReseed, await buildPanelInitData())
    }
  })

  ipcMain.on(CHANNELS.hudAction, (_, payload: HudActionPayload) => {
    // Running a follow-up action off the card = you used the result → mark seen.
    UNREAD.markRead(payload.runId)
    runCaptureAction(payload.runId, payload.action, payload.instruction)
  })

  ipcMain.on(CHANNELS.hudConfirmAct, (_, payload: HudConfirmActPayload) => {
    UNREAD.markRead(payload.runId)
    resolvePendingAct(payload.runId, payload.answer)
  })

  ipcMain.on(CHANNELS.hudRelayAnswer, (_, payload: HudRelayAnswerPayload) => {
    UNREAD.markRead(payload.runId)
    // No local echo needed: resolve() fires the store's 'changed' event, and
    // this very card is subscribed to it (agent-relay.ts), so it dismisses
    // itself the normal way — same as any other surface answering first.
    relayRequestStore.resolve(
      payload.requestId,
      { ...payload.response, questionIndex: payload.questionIndex, revise: payload.revise },
      'hud',
      payload.via
    )
  })

  ipcMain.on(CHANNELS.hudGoToOrigin, (_, requestId: string) => {
    void goToOriginFromHud(requestId)
  })

  ipcMain.handle(CHANNELS.hudCanGoToOrigin, (_, requestId: string) =>
    hasResolvableOriginFromHud(requestId)
  )

  ipcMain.on(CHANNELS.hudHover, (_, payload: { runId: string }) => {
    // Pointer on the card is the closest honest "you saw this result" signal we
    // get for a card that just appeared — drop it from the unread badge.
    UNREAD.markRead(payload.runId)
    keepHudAlive(payload.runId)
  })

  ipcMain.on(CHANNELS.hudLeave, (_, payload: { runId: string }) => {
    rearmHudDismiss(payload.runId)
  })

  // Follow-up input focus/blur: a HUD card opens non-focusable (so it never steals
  // focus on appear); flip it focusable only while the user is typing in it.
  ipcMain.on(CHANNELS.hudSetFocusable, (_, payload: { runId: string; focusable: boolean }) => {
    setHudFocusable(payload.runId, payload.focusable)
  })

  ipcMain.on(CHANNELS.submit, async (_, payload: SubmitPayload) => {
    const panelState = getPanelState()
    if (!panelState) return

    const instr = (payload.q || '').trim()
    if (instr === '') return

    // Hoisted so the catch block below can tag a failure with the run it belongs
    // to — undefined if we throw before the run's id is even minted.
    let cardRunId: string | undefined

    // This is a fire-and-forget `.on` handler: an unhandled throw anywhere below
    // (screenshot capture, memory blob, mkdir, prompt build) would leave the panel
    // stuck on its busy overlay forever. Catch it and send showError — the panel's
    // onShowError already clears the spinner, re-enables the input, and refocuses.
    try {
      const ctxRequested = payload.ctx === true
      const att = summarizeAttachments(payload.attachments)
      EVENTS.append({
        run_id: panelState.runId,
        event: 'submit',
        ctx_requested: ctxRequested,
        instruction: instr,
        mode_hint: payload.mode || '',
        // Attachments sent WITH the run (distinct from context). Per-kind so the
        // audit trail shows exactly what the user attached.
        attachments: att.count,
        attachment_images: att.images,
        attachment_audio: att.audio,
        attachment_files: att.files
      })

      PREFS.setLastInstruction(instr)
      // The draft has been acted on — clear it so a stale draft never resurfaces
      // on the next panel open (submit already persisted it via setLastInstruction).
      PREFS.setDraftInput('')
      PREFS.setActiveActionKey(null)
      panelState.ctxOn = ctxRequested

      let mode = payload.mode || detectMode(instr)
      if (panelState.modeOverride) {
        mode = panelState.modeOverride
      }
      PREFS.setLastMode(mode)
      // mode_submit is emitted centrally in runHudRun (covers panel + every other
      // run path), so it's NOT fired here — doing so would double-count panel runs.

      // Predicted run duration for this (mode, backend) shape, computed UP FRONT so
      // the busy overlay's progress bar can fill from the very first phase — incl.
      // the screen capture below, which can itself take seconds. 0 when there's no
      // history to predict from (→ overlay shows just its timer). The estimate uses
      // the pre-recall mode; recall flipping rewrite→ask is rare and close in time.
      const backendChoice = PREFS.getBackend()
      // `let` because recall (below) can flip rewrite→ask, changing the run shape —
      // we recompute the estimate after that so the HUD card uses the final mode.
      let etaMs = estimateDuration(mode, backendChoice)?.etaMs ?? 0

      // 1. Capture screen capture if requested
      let screenshotPath: string | null = null
      if (panelState.ctxOn) {
        sendToPanelRenderer(CHANNELS.busyPhase, {
          phase: 'Capturing screen',
          detail: 'taking screenshot',
          etaMs
        })
        screenshotPath = await captureScreenshot()
      }

      const ctxData = {
        frontApp: panelState.ctx.frontApp,
        windowTitle: panelState.ctx.windowTitle,
        browserURL: panelState.ctx.browserURL,
        screenshotPath
      }

      // 2. Load action extra details
      let actionExtra: ResolvedActionExtra | null = null
      if (panelState.activeAction) {
        actionExtra = {
          key: panelState.activeAction.key,
          system_extra: panelState.activeAction.system_extra,
          skill_body: panelState.activeAction.skill_path
            ? ACTIONS.readSkillBody(panelState.activeAction.skill_path)
            : ''
        }
      }

      // Source text precedence: live selection → renderer-provided source → clipboard.
      // The panel no longer shows a paste-box; with no selection we fall back to the
      // clipboard so "rewrite what I just copied" just works.
      const sourceOverride = payload.source || clipboard.readText() || ''
      const selectionText = panelState.selection !== '' ? panelState.selection : sourceOverride

      // History recall: "what did I ask yesterday?" etc. Detect (free keyword gate,
      // then paid-only fast classifier), retrieve the slice, and answer it as an ask
      // with the user's own history injected. Replaces the ambient memory blob and
      // pins the recall system prompt. Falls through to normal flow when not recall.
      let recallBlob: string | null = null
      if (mode !== 'act') {
        const recall = await resolveRecall(instr, backendChoice)
        if (recall) {
          mode = 'ask'
          recallBlob = recall.blob
          if (!actionExtra) {
            actionExtra = { key: 'recall', system_extra: recall.system, skill_body: '' }
          } else {
            actionExtra = { ...actionExtra, system_extra: recall.system }
          }
        }
      }

      const isAskMode = mode === 'ask'

      // Ask/act routing: if the panel is open + visible, keep the run inline in
      // the panel (live progress in its busy overlay, result inline — no HUD card
      // and no jarring panel→HUD jump). Otherwise (hotkey trigger with no panel)
      // it goes to a top-right HUD card. One surface at a time — Esc dismisses.
      const panelWin = getPanelWindow()
      const routeToPanel =
        (isAskMode || mode === 'act') && panelWin !== null && panelWin.isVisible()

      // Ask gets a fresh per-question runId so concurrent cards don't collide in
      // the HUD Map; act/rewrite reuse the panel session runId (one in-flight).
      cardRunId = isAskMode
        ? `r:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`
        : panelState.runId

      // Register THIS run as the panel's stoppable target as soon as its id
      // exists — not after the screenshot/recall prep below, which can take
      // seconds and left an early Stop click unable to find/kill the right run.
      setActivePanelRunId(cardRunId)

      // Finder reports its *persistent* selection even when another app is
      // frontmost — so a file last clicked in Finder would hijack an act run
      // started from highlighted text in Chrome. Only attach Finder files when
      // Finder is actually frontmost; otherwise the highlighted text is the target.
      const finderFrontmost = (panelState.ctx.frontApp || '').toLowerCase() === 'finder'
      let finderFiles = mode === 'act' && finderFrontmost ? panelState.finderFiles || [] : []

      // Fallback: Finder sometimes hands us the file as TEXT (selection) instead of
      // via the AppleScript selection. For an act run with no finderFiles, if the
      // selection is a single media filename, resolve it to a real path so the agent
      // skips the opening `find` and the whisper hint can attach to a real file.
      if (mode === 'act' && finderFiles.length === 0) {
        finderFiles = resolveSelectionToFiles(selectionText, panelState.ctx.windowTitle || '')
      }

      // Pre-write the selection tmp file for rewrite/ask (act has no selFile).
      let selFile = ''
      if (mode !== 'act') {
        const epoch = Date.now()
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        selFile = join(PATHS.TMP, `rewrite-${stamp}-${epoch}-sel.txt`)
        try {
          writeFileSync(selFile, selectionText || '', 'utf-8')
        } catch {}
      }

      // Recall replaces the ambient blob with the retrieved slice — but the two
      // travel in SEPARATE fields now. First-party memory keeps its system-prompt
      // slot; retrieved third-party content (connector emails/Slack) rides in the
      // user turn instead, so a stranger's words never occupy the system position.
      // See prds/active/2026-07-23-1784792061-prompt-injection-hardening.md.
      const memoryBlob = recallBlob !== null ? '' : buildMemoryBlob({ mode })
      const retrievedBlob = recallBlob ?? ''

      // Bring the HUD card up BEFORE the service runs (rewrite has no card — it
      // blind-pastes; on focus-loss the service raises its own "saved" card).
      // When act is routed to the open panel we raise NO card and leave the panel
      // alone — its busy overlay already shows live progress, and the result lands
      // inline (the hud-run layer falls back to a card if the panel is closed
      // mid-run, so a long act started then dismissed still surfaces its result).
      // Re-estimate with the FINAL mode (recall may have flipped rewrite→ask) so the
      // HUD card's bar matches the run actually about to happen.
      etaMs = estimateDuration(mode, backendChoice)?.etaMs ?? 0
      if (mode === 'act' && !routeToPanel) {
        let hudSubtitle = instr
        if (hudSubtitle.length > 36) hudSubtitle = hudSubtitle.substring(0, 36) + '…'
        if (finderFiles.length > 0) {
          const lastSlash = finderFiles[0].lastIndexOf('/')
          const first = lastSlash !== -1 ? finderFiles[0].substring(lastSlash + 1) : finderFiles[0]
          hudSubtitle = finderFiles.length === 1 ? first : `${first} + ${finderFiles.length - 1} more`
        }
        startHud(cardRunId, 'Working on it', hudSubtitle, undefined, undefined, etaMs)
      } else if (isAskMode && !routeToPanel) {
        // Only raise a HUD card when the answer is NOT going inline to the panel.
        let askTitle = instr
        if (askTitle.length > 36) askTitle = askTitle.substring(0, 36) + '…'
        startHud(cardRunId, 'Working on it', askTitle, undefined, undefined, etaMs)
      }

      runHudRun({
        runId: cardRunId,
        // Ask rewrites ONE History row under the panel session runId across turns.
        historyRunId: panelState.runId,
        mode,
        instruction: instr,
        selection: selectionText,
        selFile,
        ctxData,
        finderFiles,
        // Seed from the panel session's cumulative turns so a NEW ask card still
        // sees the prior conversation (the in-card follow-up then extends the
        // card's own thread). getHudThread is [] for a fresh card; panelState
        // carries the session history across cards.
        conversationHistory: isAskMode ? panelState.history.slice() : getHudThread(cardRunId),
        sessionTitle: '',
        actionExtra,
        memoryBlob,
        retrievedBlob,
        backend: backendChoice,
        attachments: payload.attachments,
        source: 'panel',
        triggerApp: panelState.ctx.frontApp || '',
        // Inline when the panel is open, HUD card otherwise. The hud-run layer
        // sends showAnswer itself for target:'panel' — we don't push it here.
        target: routeToPanel ? 'panel' : 'hud',
        // Follow-up on an already-bound Mighty session (panel's sessionIdRef) —
        // undefined on the true first turn, so hud-run mints a fresh session only
        // then and appends to this one otherwise. See hud-run.ts's isAsk binding.
        sessionId: isAskMode ? payload.sessionId : undefined,
        // Mirror each successful ask turn back into panelState so the NEXT ask
        // inherits it (panel-routed re-submits seed from panelState.history;
        // a fresh HUD card inherits the same). Keeps the session copy in sync.
        onAskTurn: (q, a) => {
          const panelState = getPanelState()
          if (!panelState) return
          if (panelState.history.length === 0) panelState.sessionTitle = q
          panelState.history.push({ q, a })
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('submit handler failed:', err)
      sendToPanelRenderer(CHANNELS.showError, { msg, runId: cardRunId })
    }
  })
}
