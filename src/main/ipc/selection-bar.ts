import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { SELECTION_ACTIONS, newActionKey } from '../store/selection-actions'
import { SELECTION_RECENTS } from '../store/selection-recents'
import {
  getSelectionBarApp,
  getSelectionBarCtx,
  getSelectionBarText,
  hideSelectionBar,
  resizeSelectionBar,
  moveSelectionBar,
  restartSelectionBarAutoHide,
  sendSelectionBarResult,
  setSelectionBarHold,
  setSelectionBarFocusable,
  setSelectionBarHovered
} from '../selection-bar-window'
import { queueRunInstruction } from '../panel-window'
import { triggerRewritePanel } from '../hotkeys'
import { randomUUID } from 'crypto'
import {
  fastRewriteErrorText,
  runFastRewrite,
  stripFancyDashes,
  stripEchoedInstruction,
  type FastRewriteResult
} from '../fast-rewrite'
import { runBackend } from '../backend/runner'
import { trackError } from '../analytics'
import { pasteText, pasteTextToApp } from '../platform'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { HISTORY, historyTimestamp } from '../store/history'
import type { ContextData, HistoryEntry } from '../../shared/types'
import { FAST_SUBMODEL, MIGHTYMOUSE_BACKEND, runLabel } from '../../shared/model-label'
import { CONFIG } from '../../shared/config'
import { contextPromptBlock, rewriteUserPrompt } from '../backend/prompts'

/** Run the user's OWN backend for the bar. Same inline result as the fast path —
 *  the CLI spawn just makes it slower, which is the trade the toggle names. */
function runOwnBackend(userPrompt: string, instruction: string): Promise<FastRewriteResult> {
  const backend = PREFS.getBackend()
  return new Promise((resolve) => {
    void runBackend({
      backend,
      runId: `selection-bar:${randomUUID()}`,
      systemPrompt: CONFIG.SYSTEM_PROMPT_REWRITE,
      userPrompt,
      runDir: PATHS.TMP,
      timeoutMs: CONFIG.SELECTION_BAR.OWN_TIMEOUT_MS,
      mode: 'rewrite',
      lean: true,
      onPhase: () => {},
      onDone: (result) => {
        const text = stripFancyDashes(stripEchoedInstruction(result?.trim() ?? '', instruction))
        // Pasting an empty string would silently delete the selection, so an
        // empty answer is a failure here exactly as it is on the fast path.
        resolve(text ? { ok: true, text } : { ok: false, reason: 'error', message: 'no output' })
      }
    })
  })
}

// The rewrite waiting in the preview. Kept here rather than trusted from the
// renderer's accept message: what we paste has to be what the model produced (or
// what the user edited it into), not whatever arrives on an IPC channel.
let pendingText = ''

/** Paste the accepted rewrite over the original selection. */
async function applyRewrite(text: string): Promise<void> {
  // Clicking in the bar made US frontmost, which blurs the caret in the user's
  // document — a bare Cmd+V then lands nowhere. Re-activate the app the text came
  // from first, exactly as the suggestion path does (insights-manager.ts:493).
  const app = getSelectionBarApp()
  if (app && app !== CONFIG.APP_NAME) await pasteTextToApp(text, app)
  else await pasteText(text)
}

/** Log the run like any other. The bar rewrites the user's real text, so a row
 *  here is what makes that undoable-by-reference rather than gone. */
function recordRun(
  instruction: string,
  selection: string,
  result: FastRewriteResult,
  fast: boolean,
  ms: number,
  ctxAttached: boolean
): void {
  const entry: HistoryEntry = {
    schema_version: CONFIG.HISTORY_SCHEMA_VERSION,
    run_id: `sb:${randomUUID()}`,
    ts: historyTimestamp(),
    duration_s: Math.round(ms / 100) / 10,
    duration_ms: Math.round(ms),
    instruction,
    mode: 'rewrite',
    selection,
    selection_chars: selection.length,
    result: result.ok ? result.text : undefined,
    result_chars: result.ok ? result.text.length : undefined,
    reason: result.ok ? undefined : result.reason,
    ok: result.ok,
    backend: fast ? MIGHTYMOUSE_BACKEND : PREFS.getBackend(),
    model: fast ? FAST_SUBMODEL : '',
    ctx_attached: ctxAttached,
    front_app: getSelectionBarApp() || null,
    source: 'selection-bar',
    // The selection IS the before-text, so the bar gets edit tracking for free.
    suggested_text: result.ok ? result.text : undefined,
    final_text: result.ok ? result.text : undefined
  }
  HISTORY.append(entry)
}

/** App/window/URL only — Fast cannot open a local screenshot path. */
function barCtx(): ContextData | null {
  if (!PREFS.getCtxToggle()) return null
  const stored = getSelectionBarCtx()
  if (!stored.frontApp && !stored.windowTitle && !stored.browserURL) return null
  return {
    frontApp: stored.frontApp,
    windowTitle: stored.windowTitle,
    browserURL: stored.browserURL
  }
}

/** Rewrite in place and keep the bar up to report it. Never throws. */
async function runInline(instruction: string, selection: string): Promise<void> {
  // Busy for the whole run: the paste's synthesised keystrokes would otherwise
  // read as typing-over-selection and hide the bar.
  setSelectionBarHold('run', true)
  const fast = PREFS.getSelectionBarFast()
  sendSelectionBarResult({
    state: 'running',
    runLabel: fast
      ? runLabel(MIGHTYMOUSE_BACKEND, FAST_SUBMODEL)
      : runLabel(PREFS.getBackend())
  })

  // The toggle picks the ENGINE, not the surface: either way the answer lands in
  // the bar rather than opening the panel.
  const ctx = barCtx()
  const userPrompt = `${rewriteUserPrompt(instruction, selection)}${contextPromptBlock(ctx, 'rewrite')}`
  const started = Date.now()
  const result = fast
    ? await runFastRewrite(instruction, selection, userPrompt)
    : await runOwnBackend(userPrompt, instruction)

  const ms = Date.now() - started
  recordRun(instruction, selection, result, fast, ms, !!ctx)
  // History is the only other record of a run and it's encrypted at rest, so a
  // failure here was invisible in the logs — the toast was the whole story.
  console.log(
    `[selection-bar] run ${result.ok ? 'ok' : `FAILED reason=${result.reason} msg=${result.message}`}` +
      ` engine=${fast ? 'fast' : PREFS.getBackend()} ${ms}ms chars=${selection.length}`
  )

  if (result.ok) {
    // The answer is an OFFER, not an edit: show it and let the user read, tweak,
    // and accept it. Nothing touches their document until they say so — pasting
    // here would overwrite the original before they had seen the replacement.
    pendingText = result.text
    sendSelectionBarResult({ state: 'done', text: result.text })
    // Hold the bar open: the user is reading. The preview owns dismissal now.
    setSelectionBarHold('run', true)
    return
  }

  // signed_out / out_of_credits are states the user is IN, not bugs — alerting on
  // them would page the channel for every logged-out click. Only a broken run does.
  if (result.reason === 'error' || result.reason === 'timeout' || result.reason === 'broken') {
    trackError({
      kind: `selection_bar_${result.reason}`,
      message: result.message,
      source: 'selection-bar',
      props: {
        engine: fast ? 'fast' : PREFS.getBackend(),
        instruction,
        selection_chars: selection.length,
        duration_ms: Math.round(ms)
      }
    })
  }

  // Failures linger longer than the ✓ — there are words to read — but they still
  // leave on their own. Hovering pauses it, so a long message is never yanked away.
  sendSelectionBarResult({ state: 'error', message: fastRewriteErrorText(result) })
  setSelectionBarHold('run', false)
  restartSelectionBarAutoHide()
}

export function registerSelectionBarHandlers(): void {
  ipcMain.on(CHANNELS.selectionBarAction, (_, key: string, prompt?: string) => {
    const action = SELECTION_ACTIONS.load().find((a) => a.key === key)
    if (!action) return hideSelectionBar()

    // Ask carries no stored instruction, so the typed question IS the instruction.
    const instruction = action.instruction ?? (prompt ?? '').trim()
    // Only a typed one is remembered — a chip is already saved, so recording it
    // would fill the recents list with the chips sitting right above it.
    if (!action.instruction && instruction) SELECTION_RECENTS.record(instruction)
    const selection = getSelectionBarText()

    // The bar is its own surface, not a shortcut into the panel: a run here always
    // answers here. Without a stored selection there is nothing to rewrite, so
    // that one case falls through to the panel, which captures its own.
    if (instruction && selection) {
      void runInline(instruction, selection)
      return
    }
    // Falling through to the panel is silent otherwise, which reads in the log
    // exactly like the run never fired.
    console.log(
      `[selection-bar] -> panel (no inline run): instruction=${!!instruction} selection=${selection.length}`
    )

    hideSelectionBar()
    // Queue BEFORE triggering: the panel reads the queued instruction on mount.
    // An empty instruction is Ask — panel opens with the selection, empty input.
    if (instruction) queueRunInstruction(instruction)
    void triggerRewritePanel(true)
  })

  ipcMain.handle(CHANNELS.selectionBarListHistory, () =>
    HISTORY.readSelectionBarRecent(CONFIG.SELECTION_BAR.HISTORY_ROWS)
  )

  // Re-paste a past result. Goes through applyRewrite like a fresh accept, so it
  // lands in whatever the user has highlighted NOW — the original selection is
  // long gone, and re-running the model would give a different answer anyway.
  ipcMain.on(CHANNELS.selectionBarPasteHistory, (_, runId: string) => {
    const row = HISTORY.readSelectionBarRecent(CONFIG.SELECTION_BAR.HISTORY_ROWS).find(
      (r) => r.run_id === runId
    )
    if (!row?.result) return
    void applyRewrite(row.result).finally(() => {
      setTimeout(hideSelectionBar, CONFIG.SELECTION_BAR.DONE_LINGER_MS)
    })
  })

  ipcMain.on(CHANNELS.selectionBarDismiss, () => {
    pendingText = ''
    hideSelectionBar()
  })

  // Accepting is the only path that writes to the user's document. `edited` is
  // absent when they took the draft as-is; anything else is their own text.
  ipcMain.on(CHANNELS.selectionBarAccept, (_, edited?: string) => {
    const text = typeof edited === 'string' && edited.trim() ? edited : pendingText
    if (!text) return hideSelectionBar()
    pendingText = ''
    void applyRewrite(text).finally(() => {
      // Hide only once the paste's Cmd+V has been delivered — uiohook sees it
      // after AppleScript returns, and a live bar would read it as typing.
      setTimeout(hideSelectionBar, CONFIG.SELECTION_BAR.DONE_LINGER_MS)
    })
  })

  ipcMain.on(CHANNELS.selectionBarResize, (_, height: number, width?: number) => {
    if (typeof height === 'number' && Number.isFinite(height)) resizeSelectionBar(height, width)
  })

  ipcMain.on(CHANNELS.selectionBarMove, (_, x: number, y: number) => {
    if (typeof x === 'number' && typeof y === 'number') moveSelectionBar(x, y)
  })

  // Hovering means the user is reading the bar, so hold it open.
  ipcMain.on(CHANNELS.selectionBarHover, (_, over: boolean) => {
    setSelectionBarHold('hover', !!over)
    setSelectionBarHovered(!!over)
  })

  ipcMain.on(CHANNELS.selectionBarSetFocusable, (_, on: boolean) => {
    setSelectionBarHold('edit', !!on)
    setSelectionBarFocusable(!!on)
  })

  // Chip CRUD. Each returns the saved list so the renderer never guesses.
  ipcMain.handle(CHANNELS.selectionBarListActions, () => SELECTION_ACTIONS.load())

  ipcMain.handle(
    CHANNELS.selectionBarSaveAction,
    (_, key: string | null, label: string, instruction: string) => {
      const trimmed = { label: label.trim(), instruction: instruction.trim() }
      if (!trimmed.label || !trimmed.instruction) return SELECTION_ACTIONS.load()

      const actions = SELECTION_ACTIONS.load()
      const existing = key ? actions.find((a) => a.key === key) : null
      if (existing) {
        existing.label = trimmed.label
        existing.instruction = trimmed.instruction
      } else {
        actions.push({ key: newActionKey(), ...trimmed })
      }
      SELECTION_ACTIONS.save(actions)
      return actions
    }
  )

  ipcMain.handle(CHANNELS.selectionBarDeleteAction, (_, key: string) => {
    const actions = SELECTION_ACTIONS.load().filter((a) => a.key !== key)
    SELECTION_ACTIONS.save(actions)
    return actions
  })

  ipcMain.handle(CHANNELS.selectionBarResetActions, () => SELECTION_ACTIONS.resetToDefaults())

  ipcMain.handle(CHANNELS.selectionBarListRecents, () => SELECTION_RECENTS.load())

  // Keeping a recent prompt makes it a chip. The label is the prompt's own first
  // words: naming it would be a second question asked at the moment the user is
  // already mid-rewrite, and MAX_LABEL_CHARS truncates the chip anyway.
  ipcMain.handle(CHANNELS.selectionBarKeepRecent, (_, prompt: string) => {
    const instruction = (prompt ?? '').trim()
    if (!instruction) {
      return { actions: SELECTION_ACTIONS.load(), recents: SELECTION_RECENTS.load() }
    }

    const actions = SELECTION_ACTIONS.load()
    // Same instruction twice is one chip: the bar is a fixed width, so a
    // duplicate costs a slot the user can see is wasted.
    if (!actions.some((a) => a.instruction?.trim().toLowerCase() === instruction.toLowerCase())) {
      actions.push({ key: newActionKey(), label: chipLabelFor(instruction), instruction })
      SELECTION_ACTIONS.save(actions)
    }
    return { actions, recents: SELECTION_RECENTS.forget(instruction) }
  })
}

/** A chip title from a whole sentence: enough leading words to fill the chip,
 *  since the bar truncates anything longer than MAX_LABEL_CHARS regardless. */
function chipLabelFor(instruction: string): string {
  const max = CONFIG.SELECTION_BAR.MAX_LABEL_CHARS
  const words = instruction.split(/\s+/).filter(Boolean)
  let label = ''
  for (const w of words) {
    const next = label ? `${label} ${w}` : w
    if (next.length > max && label) break
    label = next
    if (label.length >= max) break
  }
  return label || instruction.slice(0, max)
}
