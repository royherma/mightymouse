import { BrowserWindow, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CHANNELS } from '../shared/ipc'
import type { RunEvent, TranscriptEventPayload } from '../shared/types'

// Full-screen, transparent, INTERACTIVE overlay hosting the Run Transcript
// Inspector — the live, ordered timeline of a run's tool calls (with full
// input/output), thinking, assistant text, and final token usage. It lives in its
// OWN window (not the 320px HUD) for the same reason the skill editor does: a CSS
// `position: fixed` overlay can only ever cover the HUD's tiny bounds and would be
// clipped at its edges (see CLAUDE.md "fixed-can't-escape" gotcha). Recipe mirrors
// skill-editor-window.ts: focusable + not click-through, main owns the lifecycle.
//
// Events stream from runner.ts → pushTranscriptEvent BEFORE the window may exist
// (the user opens the inspector partway through a run), so main keeps a per-run
// event BUFFER. On open we replay the buffer, then live events append. The buffer
// is bounded (a runaway run can't grow it without limit) and cleared when the run
// is done or the buffer's run changes.

let transcriptWindow: BrowserWindow | null = null
/** The runId currently displayed (or last requested). */
let activeRunId = ''
/** Ordered events seen for `activeRunId`, replayed when the window mounts. */
let buffer: RunEvent[] = []
/** Bound so a very long run can't grow the buffer unbounded. Oldest drop first. */
const MAX_BUFFERED = 2000
let windowReady = false

function buildWindow(): BrowserWindow {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const b = display.bounds

  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    // Interactive: it must take focus to receive clicks, scroll, and Esc.
    focusable: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=transcript&runId=${activeRunId}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'transcript', runId: activeRunId }
    })
  }

  win.on('closed', () => {
    transcriptWindow = null
    windowReady = false
  })

  return win
}

/**
 * Record a run event so the inspector can show it. Called from the HUD run wiring
 * for EVERY run when the run-transcript setting is on — even when the inspector
 * window isn't open — so opening it mid-run shows the full history. If a new run's
 * events arrive (different runId), the buffer resets to that run.
 */
export function pushTranscriptEvent(runId: string, event: RunEvent): void {
  if (runId !== activeRunId) {
    // A different run started streaming — the inspector tracks the newest run.
    activeRunId = runId
    buffer = []
  }
  buffer.push(event)
  if (buffer.length > MAX_BUFFERED) buffer.shift()

  if (transcriptWindow && !transcriptWindow.isDestroyed() && windowReady) {
    const payload: TranscriptEventPayload = { runId, event }
    transcriptWindow.webContents.send(CHANNELS.transcriptEvent, payload)
  }
}

/** Open (or focus) the inspector for a run, replaying its buffered events. */
export function openTranscript(runId: string): void {
  // If we're opening a run different from what's buffered, we have no history for
  // it — show it empty and let live events fill in. (The common path is opening
  // the run currently streaming, which the buffer already holds.)
  if (runId !== activeRunId) {
    activeRunId = runId
    buffer = []
  }

  if (transcriptWindow && !transcriptWindow.isDestroyed()) {
    transcriptWindow.focus()
    replayBuffer()
    return
  }
  windowReady = false
  transcriptWindow = buildWindow()
  transcriptWindow.on('ready-to-show', () => {
    if (!transcriptWindow || transcriptWindow.isDestroyed()) return
    transcriptWindow.show()
    transcriptWindow.focus()
    windowReady = true
    replayBuffer()
  })
}

/** Send the whole buffered history to the (now-mounted) inspector, in order. */
function replayBuffer(): void {
  if (!transcriptWindow || transcriptWindow.isDestroyed() || !windowReady) return
  for (const event of buffer) {
    const payload: TranscriptEventPayload = { runId: activeRunId, event }
    transcriptWindow.webContents.send(CHANNELS.transcriptEvent, payload)
  }
}

/** Tear the inspector down (its ✕ / Esc). Buffer is kept so a re-open still shows
 *  the run's history until a new run overwrites it. */
export function closeTranscript(): void {
  if (transcriptWindow && !transcriptWindow.isDestroyed()) {
    transcriptWindow.close()
  }
  transcriptWindow = null
  windowReady = false
}
