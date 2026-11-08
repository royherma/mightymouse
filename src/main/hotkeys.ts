import { CONFIG } from '../shared/config'
import { captureContext, captureFinderSelection } from './platform'
import { captureSelection } from './platform'
import { PREFS } from './store/prefs'
import { EVENTS } from './store/events'
import { PATHS } from './store/paths'
import { route } from './routing'
import { appendFileSync } from 'fs'
import { ContextData } from '../shared/types'

interface TriggerData {
  runId: string
  selection: string
  ctx: ContextData
  finderFiles: string[]
  ctxOn: boolean
}

export let activeTriggerData: TriggerData | null = null

/**
 * Read the pending trigger data WITHOUT clearing it. Idempotent on purpose: the
 * renderer's mount effect can fire twice (React StrictMode double-invokes effects
 * in dev), so a read-and-destroy would hand the selection to the first call and
 * an empty payload to the second, wiping the chip (the "flash" bug). Returns null
 * when there's no pending trigger — the caller should capture live context.
 *
 * Staleness is handled by clearTriggerData() on panel close: a reopen WITHOUT a
 * fresh hotkey (tray "Open", history) finds it null and falls back to live
 * context. A new hotkey overwrites activeTriggerData wholesale, so it never goes
 * stale within a session.
 */
export function peekTriggerData(): TriggerData | null {
  return activeTriggerData
}

/** Drop the pending trigger so a later no-trigger reopen doesn't show stale data. */
export function clearTriggerData(): void {
  activeTriggerData = null
}

/**
 * Capture CONTEXT + any selected text and stash it as trigger data, BEFORE the
 * panel takes focus. Used by the main-panel hotkey: it must record which
 * app/window was front *before* the panel steals focus (otherwise
 * captureContext() later reports the panel itself), and it grabs the current
 * selection so opening over highlighted text seeds the input just like the
 * rewrite hotkey. Selection stays empty when nothing is highlighted (correct for
 * a fresh main-panel open). Mirrors the context+selection half of
 * triggerRewritePanel.
 */
export async function prepareContextTrigger(): Promise<void> {
  const runId = `r:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`
  const ctx = await captureContext()
  const selection = await captureSelection()
  // Grab the Finder file selection too — this runs BEFORE the panel steals focus
  // (index.ts calls it ahead of showPanelWindow), so Finder is still frontmost and
  // `selection as alias list` returns the selected file(s). Without this the panel
  // hotkey always got finderFiles: [], so an act run on a selected video had no path
  // and the agent wasted tool calls running `find` to locate it. ipc.ts only attaches
  // these when Finder is actually frontmost, so a stale selection can't leak in.
  const finderFiles = await captureFinderSelection()
  activeTriggerData = {
    runId,
    selection,
    ctx,
    finderFiles,
    ctxOn: PREFS.getCtxToggle()
  }
}

let rewriteLastFired = 0
const REWRITE_COOLDOWN_MS = 1000

function truncate(s: string, n: number): string {
  if (!s) return ''
  const raw = s.replace(/\n/g, ' ')
  return raw.length <= n ? raw : raw.substring(0, n) + '...'
}

/**
 * Run the rewrite/ask panel trigger sequence: capture context + selection,
 * then open the panel. Invoked by the unified uiohook hotkey watcher.
 *
 * The cooldown debounces uiohook key-REPEAT on a held hotkey. A click (the
 * selection bar) is always one deliberate press, so it passes skipCooldown —
 * without it, tapping the bar within a second of the last open silently does
 * nothing.
 */
export async function triggerRewritePanel(skipCooldown = false): Promise<void> {
  const now = Date.now()
  if (!skipCooldown && now - rewriteLastFired < REWRITE_COOLDOWN_MS) return
  rewriteLastFired = now
  {
    console.log('[hotkey] ; trigger fired')
    const runId = `r:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`

    // Log run separation. Incognito suppresses the run log (it carries the
    // selection preview / verbatim user text).
    const incognito = PREFS.getIncognito()
    const logLine = (s: string): void => {
      if (incognito) return
      try { appendFileSync(PATHS.LOG, s, 'utf-8') } catch {}
    }
    logLine(`=== RUN ${runId} ===\n`)
    logLine(`[${new Date().toLocaleString()}] [${runId}] trigger fired\n`)

    EVENTS.append({ run_id: runId, event: 'trigger' })

    // 1. Capture Context
    const ctx = await captureContext()
    EVENTS.append({
      run_id: runId,
      event: 'context_captured',
      front_app: ctx.frontApp,
      window_title: ctx.windowTitle,
      browser_url: ctx.browserURL
    })

    // 2. Capture Finder
    const finderFiles = await captureFinderSelection()
    EVENTS.append({
      run_id: runId,
      event: 'finder_selection_captured',
      count: finderFiles.length
    })

    // 3. Capture text selection
    const selection = await captureSelection()
    const truncatedSel = truncate(selection, CONFIG.MAX_PREVIEW_LEN)

    if (selection === '') {
      logLine(`[${new Date().toLocaleString()}] [${runId}] selection EMPTY -- proceeding without selection (ctx-only mode)\n`)
    } else {
      logLine(`[${new Date().toLocaleString()}] [${runId}] selection captured: ${selection.length} chars, preview: "${truncatedSel}"\n`)
    }

    EVENTS.append({
      run_id: runId,
      event: 'selection_captured',
      chars: selection.length,
      preview: truncatedSel
    })

    const ctxOn = PREFS.getCtxToggle()
    logLine(`[${new Date().toLocaleString()}] [${runId}] ctx toggle initial: ${ctxOn ? 'on' : 'off'}\n`)

    // Store trigger state so renderer can query it during mount
    activeTriggerData = {
      runId,
      selection,
      ctx,
      finderFiles,
      ctxOn
    }

    // 4. Open Window
    route('panel', { panelSource: 'hotkey' })
  }
}
