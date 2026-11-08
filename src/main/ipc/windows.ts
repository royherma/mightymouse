/**
 * Window-opener IPC — the "open this window" handlers (Settings, Playground,
 * Analytics, Billing, Media Library, Mighty, Auth). Each just calls
 * the matching `showXWindow()`. Extracted verbatim from the old monolithic `ipc.ts`.
 */
import { ipcMain, BrowserWindow, type IpcMainEvent } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { showSettingsWindow } from '../settings-window'
import { isCodeTab, type SettingsSectionFocus, type UpgradeReason } from '../../shared/types'
import { showPhoneRemoteQrWindow } from '../phone-remote-qr-window'
import { showPlaygroundWindow } from '../playground-window'
import { showAnalyticsWindow } from '../analytics-window'
import { showDeckWindow } from '../deck-window'
import { showBillingWindow } from '../billing-window'
import { showUpgradeWindow, getUpgradeReason, registerUpgradeResize } from '../upgrade-window'
import { showMightyWindow } from '../mighty/mighty-window'
import { hidePanelWindow } from '../panel-window'
import {
  startCompanionWindow,
  stopCompanionWindow,
  sendCompanionStageEvent,
  sendLiveTurnResult,
  moveCompanionWindow
} from '../companion-window'
import type { CompanionStageEvent } from '../../shared/companion-debug'
import { runLiveDraft, runLiveTurn, runLiveTurnFromText } from '../capture/live-listen'
import { abortCompanionTurn } from '../companion-orchestrator'
import { handleHandsFreeSegment, setHandsFreeHostState } from '../capture/hands-free'
import type { HandsFreeHostState } from '../../shared/hands-free-state'
import { screen } from 'electron'
import { flashHighlightBox } from '../highlight-window'
import { showAgentCursor, hideAgentCursor } from '../actions/computer-use/agent-cursor'
import { showStatusBox } from '../actions/computer-use/status-box'
import { IS_DEV } from '../../shared/env'

export function registerWindowHandlers(): void {
  ipcMain.handle(CHANNELS.openSettingsWindow, (_e, focusSection?: SettingsSectionFocus) => {
    showSettingsWindow(focusSection)
  })

  ipcMain.handle(CHANNELS.openPhoneRemoteQrWindow, () => {
    showPhoneRemoteQrWindow()
  })

  ipcMain.handle(CHANNELS.openPlaygroundWindow, () => {
    showPlaygroundWindow()
  })

  ipcMain.handle(CHANNELS.openAnalyticsWindow, () => {
    showAnalyticsWindow()
  })

  ipcMain.handle(CHANNELS.openDeckWindow, () => {
    showDeckWindow()
  })

  ipcMain.handle(CHANNELS.openBillingWindow, () => {
    showBillingWindow()
  })

  // The one paywall. `reason` is the limit that sent the user here and rides the
  // whole funnel through to checkout_returned.
  ipcMain.handle(CHANNELS.openUpgradeWindow, (_, reason: UpgradeReason) => {
    showUpgradeWindow(reason)
  })

  ipcMain.handle(CHANNELS.upgradeGetReason, () => getUpgradeReason())

  registerUpgradeResize()

  ipcMain.handle(CHANNELS.openMediaLibraryWindow, () => {
    showMightyWindow(false, undefined, '')
    track(ANALYTICS_EVENT.media_library_action, { kind: 'open' })
  })

  // ── Mighty (standing personal agent) ────────────────────────────────────────
  // Panel and Mighty are two views of the same chat — show one, hide the other.
  // startFresh: the panel was empty, so open Mighty on a new empty chat too.
  // sessionId: the panel had a live conversation, already bound to this Mighty
  // session — open directly on it instead of resuming Mighty's last chat.
  ipcMain.handle(
    CHANNELS.openMightyWindow,
    (_e, startFresh?: boolean, sessionId?: string) => {
      showMightyWindow(startFresh === true, sessionId)
      hidePanelWindow()
    }
  )

  // The panel's Code button. Its own flyout is gone: agent cards get answered in
  // one place, and that place is big enough to read a diff in.
  ipcMain.handle(CHANNELS.openMightyCode, (_e, codeTab?: unknown) => {
    showMightyWindow(false, undefined, undefined, true, typeof codeTab === 'string' && isCodeTab(codeTab) ? codeTab : undefined)
    hidePanelWindow()
  })

  // ── Live Voice Companion overlay (Phase 0: mocked state cycle) ─────────────
  ipcMain.handle(CHANNELS.openCompanionWindow, () => {
    startCompanionWindow()
  })

  ipcMain.handle(CHANNELS.closeCompanionWindow, () => {
    stopCompanionWindow()
  })

  // Phase 0.5 debug/verify stream: Phase 0's mock state-cycle timer runs in the
  // companion renderer, so its sample stage-events arrive here and get
  // re-broadcast to the same window. Real Phase 1-4 adapters run in main and
  // will call sendCompanionStageEvent() directly, skipping this hop entirely.
  ipcMain.on(CHANNELS.companionStageEventReport, (_: IpcMainEvent, event: CompanionStageEvent) => {
    sendCompanionStageEvent(event)
  })

  // Phase 1: one finished VAD segment arrives as raw WAV bytes (renderer's
  // useVoiceActivity.ts already decided the segment boundaries — see the
  // design's VoiceInputSource). `send` (fire-and-forget), not `invoke`: the
  // renderer doesn't block on the result, it gets it back via the
  // liveTurnResult push once live-listen.ts's transcribe-then-mock-respond
  // loop finishes — matches the "audio in / transcript event out" shape the
  // design asks for, rather than a single blocking round trip.
  ipcMain.handle(CHANNELS.liveTurnDraft, (_, wavBytes: Uint8Array, echoTail: unknown) =>
    runLiveDraft(wavBytes, typeof echoTail === 'string' ? echoTail : '')
  )

  ipcMain.on(CHANNELS.liveTurnSubmit, (_: IpcMainEvent, wavBytes: Uint8Array, echoTail: unknown) => {
    runLiveTurn(wavBytes, typeof echoTail === 'string' ? echoTail : '')
      .then((result) => sendLiveTurnResult(result))
      .catch((err) => {
        sendLiveTurnResult({
          ok: false,
          transcript: '',
          reply: '',
          error: err instanceof Error ? err.message : String(err)
        })
      })
  })

  // Stage's input bar. Same fire-and-forget shape as liveTurnSubmit and the same
  // result push, so a typed turn and a spoken one are indistinguishable to the
  // renderer — it just skips whisper.
  ipcMain.on(CHANNELS.companionSendText, (_: IpcMainEvent, text: string) => {
    runLiveTurnFromText(String(text ?? ''))
      .then((result) => sendLiveTurnResult(result))
      .catch((err) => {
        sendLiveTurnResult({
          ok: false,
          transcript: '',
          reply: '',
          error: err instanceof Error ? err.message : String(err)
        })
      })
  })

  // Barge-in kill. Once a live turn can click and type, dropping its reply is no
  // longer enough — the run keeps operating the Mac until the process dies, so
  // the user watches the thing they just told to stop carry on regardless.
  ipcMain.on(CHANNELS.companionAbortTurn, () => {
    abortCompanionTurn()
  })

  // Hands-free dictation: same VAD hook as the companion, different consumer.
  // Fire-and-forget with no reply — main pastes the transcript at the cursor,
  // so there is nothing for the host renderer to render.
  ipcMain.on(CHANNELS.handsFreeSegment, (_: IpcMainEvent, wavBytes: Uint8Array) => {
    void handleHandsFreeSegment(wavBytes)
  })

  ipcMain.on(CHANNELS.handsFreeHostState, (_: IpcMainEvent, payload: HandsFreeHostState) => {
    setHandsFreeHostState(payload)
  })

  // Phase 3: drag-to-reposition. Fires once per pointermove frame during a
  // character drag — see companion-window.ts's moveCompanionWindow doc.
  ipcMain.on(CHANNELS.companionDragMove, (_: IpcMainEvent, delta: { dx: number; dy: number }) => {
    moveCompanionWindow(delta.dx, delta.dy)
  })

  // Dev-only: Playground's "flash it now" button — fires the real act-highlight
  // overlay at the current cursor position so it can be demoed without a live
  // act-mode run. sizePx/durationMs let the Playground sliders tune it live,
  // no restart needed. No-ops in production builds.
  ipcMain.on(
    CHANNELS.devFlashHighlight,
    (_: IpcMainEvent, opts?: { sizePx?: number; durationMs?: number }) => {
      if (!IS_DEV) return
      const pt = screen.getCursorScreenPoint()
      flashHighlightBox(pt.x, pt.y, opts?.sizePx, opts?.durationMs)
    }
  )

  // Dev-only: Playground's agent-cursor demo — glides the drawn cursor through
  // 4 points near the real cursor, one per computer-use kind, then hides it.
  // No live loop.ts run involved. No-ops in production builds.
  ipcMain.on(CHANNELS.devAgentCursorDemo, () => {
    if (!IS_DEV) return
    const pt = screen.getCursorScreenPoint()
    const stops: Array<{ dx: number; dy: number; kind: 'click' | 'type' | 'key' | 'scroll'; label: string }> = [
      { dx: 120, dy: 0, kind: 'click', label: 'Pressing Next' },
      { dx: 120, dy: 120, kind: 'type', label: 'Typing name' },
      { dx: -120, dy: 120, kind: 'key', label: 'Pressing Enter' },
      { dx: 0, dy: 0, kind: 'scroll', label: 'Scrolling down' }
    ]
    stops.forEach((s, i) => {
      setTimeout(() => {
        showAgentCursor({ x: pt.x + s.dx, y: pt.y + s.dy, kind: s.kind, label: s.label })
        showStatusBox({ state: 'running', step: i + 1, line: s.label })
      }, i * 900)
    })
    setTimeout(
      () => {
        hideAgentCursor()
        showStatusBox({
          state: 'ended',
          step: stops.length,
          line: 'Stopped - it kept repeating the same step - 4 steps, 12.4 s',
          detail:
            'Drags, right-clicks, double-clicks and sign-ins stay with you. Do that part, then ask for the rest',
          canRetry: true
        })
      },
      stops.length * 900 + 600
    )
  })

  // DEV ONLY — a Vite compile/HMR error landed in the sender's window. Nearly
  // every surface here runs at alwaysOnTop 'screen-saver', a macOS level above
  // Mission Control and the Dock, so an error painted inside one is unescapable
  // and reads as a frozen machine rather than one bad import. Drop the offending
  // window to a normal level so it can be clicked away, moved, or Cmd+Tabbed
  // past. Resolved from the event sender so this covers every window generically
  // — no per-surface list to keep in sync. Purely a dev affordance: the next
  // showXWindow() re-pins as usual, and IS_DEV keeps it out of prod entirely.
  ipcMain.on(CHANNELS.devUnpinForError, (e: IpcMainEvent) => {
    if (!IS_DEV) return
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    win.setAlwaysOnTop(false)
    win.setIgnoreMouseEvents(false)
  })
}
