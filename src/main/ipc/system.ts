/**
 * System IPC — quick-action CRUD, skills list, onboarding wizard, value tour,
 * reveal-in-Finder, renderer analytics/error reporting, admin platform stats,
 * auto-update, feedback list, and attachment picker/thumbnail. Extracted
 * verbatim from the old monolithic `ipc.ts`.
 */
import { ipcMain, shell, dialog, app, BrowserWindow, clipboard, Menu, net } from 'electron'
import { mkdir, readdir, stat, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { existsSync, statSync } from 'fs'
import { CHANNELS } from '../../shared/ipc'
import { CONFIG } from '../../shared/config'
import { PermissionKey, MediaAttachment, type DroppedImage, type LinkMenuChoice, type NativeMenuItem, type SpeakTextResult } from '../../shared/types'
import { track, trackError, trackFromRenderer, type ErrorReport } from '../analytics'
import {
  ANALYTICS_EVENT,
  type OnboardingSurface
} from '../../shared/analytics-events'
import { PREFS } from '../store/prefs'
import { PATHS } from '../store/paths'
import { runSelfTest, buildPermissionChecks } from '../platform'
import { completeOnboarding, lowerOnboardingWindowForGrant } from '../onboarding-window'
import { showDragCoachWindow, closeDragCoachWindow, startAppDrag } from '../drag-coach-window'
import {
  isFtueMockActive,
  mockPermissionChecks,
  mockSelfTest,
  endFtueMock,
  exitFtueMock,
  mockConfirmTourStep,
  mockTourMods
} from '../ftue-replay'
import { completeTour } from '../tour-window'
import { armProbe } from '../tour-hotkey-probe'
import type { ShortcutId } from '../../shared/shortcuts'
import { getBinaryStatuses } from '../capture/binaries'
import { buildSetupChecks, runSetupFix, runSetupSwitch } from '../setup-check'
import type { SetupCheckId } from '../../shared/setup-check'
import { route } from '../routing'
import { ACTIONS } from '../store/actions'
import { SKILLS } from '../store/skills'
import { openSkillEditor, closeSkillEditor } from '../skill-editor-window'
import { openTranscript, closeTranscript } from '../transcript-window'
import { getPanelWindow } from '../panel-window'
import { getPanelState } from './panel-state'
import { FEEDBACK } from '../store/feedback'
import { getBugReportContext, submitBugReport } from '../bug-report'
import { closeBugReportWindow } from '../bug-report-window'
import { hideReplyWindow, showReplyWindow } from '../reply-window'
import { resolveSessionRef } from '../agent-relay/session-control'
import { showAgentInCodeTab } from '../mighty/mighty-window'
import type {
  BugReportContext,
  BugReportDraft,
  BugReportResult
} from '../../shared/bug-report'
import { isCurrentUserAdmin, isRealAdmin } from '../auth'
import { isPreviewingAsUser } from '../admin-preview'
import { updaterIpc } from '../updater'
import { toAttachment, ATTACHMENT_DIALOG_FILTERS } from '../../shared/attachments'
import { loadImageAsDataUrl } from '../backend/image-vision'

const DROPPED_IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export function registerSystemHandlers(): void {
  // ── Quick-action CRUD ──────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.actionsLoad, () => ACTIONS.load())

  ipcMain.handle(CHANNELS.actionsSave, (_, actions: import('../../shared/types').QuickAction[]) => {
    if (!Array.isArray(actions)) throw new Error('actions must be an array')
    ACTIONS.save(actions)
    track(ANALYTICS_EVENT.quick_action, { kind: 'save' })
    const saved = ACTIONS.load()
    // Deleting the armed shortcut must disarm it, or the next submit still carries
    // its system_extra/skill_body under a pill that no longer exists.
    const activeKey = PREFS.getActiveActionKey()
    if (activeKey && !saved.some((a) => a.key === activeKey)) {
      PREFS.setActiveActionKey(null)
      const panelState = getPanelState()
      if (panelState) panelState.activeAction = null
    }
    // The editor lives in its own overlay window, so the panel can't hear the
    // save through the old inline onSaved callback — push the fresh list to it.
    getPanelWindow()?.webContents.send(CHANNELS.actionsChanged, saved)
    return saved
  })

  // Open/close the full-screen skill-editor overlay (its own window so the modal
  // centers on the display and never clips inside the small panel — see
  // skill-editor-window.ts + the CLAUDE.md gotcha).
  ipcMain.on(CHANNELS.skillEditorOpen, () => openSkillEditor())
  ipcMain.on(CHANNELS.skillEditorClose, () => closeSkillEditor())

  // Open/close the full-screen Run Transcript Inspector overlay (own window, same
  // fixed-can't-escape reason as the skill editor). Open carries the runId to show.
  ipcMain.on(CHANNELS.transcriptOpen, (_, runId: string) => openTranscript(runId))
  ipcMain.on(CHANNELS.transcriptClose, () => closeTranscript())
  ipcMain.on(CHANNELS.replyWindowHide, () => hideReplyWindow())
  ipcMain.on(CHANNELS.replyWindowShow, (_e, ref: unknown) => {
    if (typeof ref === 'string' && ref) showReplyWindow(ref)
  })
  ipcMain.on(CHANNELS.replyWindowOpenBig, (_e, ref: unknown) => {
    if (typeof ref !== 'string' || !resolveSessionRef(ref)) return
    hideReplyWindow()
    showAgentInCodeTab({ ref })
  })

  // Live list of the user's Claude Code skills, for the chip-body slash autocomplete.
  // Read fresh from ~/.claude/skills/ on every call so it always reflects what the
  // backend agent can actually invoke.
  ipcMain.handle(CHANNELS.skillsList, () => SKILLS.list())

  // ── Onboarding (permissions wizard) ──────────────────────────────────────
  // During a dev FTUE replay the checks are mocked, so the wizard renders its
  // un-granted first-run states without touching the machine's real TCC grants.
  ipcMain.handle(CHANNELS.onboardingGetChecks, () =>
    isFtueMockActive() ? mockPermissionChecks() : buildPermissionChecks()
  )

  ipcMain.handle(CHANNELS.onboardingRunSelfTest, (_, key: PermissionKey) =>
    isFtueMockActive() ? mockSelfTest(key) : runSelfTest(key)
  )

  // Capture-readiness row: ffmpeg/whisper/whisper-model status, same source Settings uses.
  ipcMain.handle(CHANNELS.onboardingGetBinaries, () => getBinaryStatuses())

  // Open Finder with the app bundle already selected, so the drag the coach UI
  // is miming is one gesture away. `getPath('exe')` points INSIDE the bundle
  // (…/MightyMouse.app/Contents/MacOS/MightyMouse) and revealing that would
  // select the unix binary — which macOS refuses to accept in a TCC pane. Walk
  // up to the .app itself, which is the only thing draggable there.
  // In dev there is no bundle (it's Electron.app), so this falls back to
  // revealing whatever the exe resolves to rather than throwing.
  ipcMain.handle(CHANNELS.onboardingRevealApp, () => {
    const exe = app.getPath('exe')
    const bundle = exe.match(/^(.*\.app)\/Contents\/MacOS\//)
    shell.showItemInFolder(bundle ? bundle[1] : exe)
  })

  ipcMain.handle(CHANNELS.onboardingExitMock, () => exitFtueMock())

  // ── Drag-to-add coach ─────────────────────────────────────────────────────
  // The wizard fires `show` the moment Grant is pressed on a `+`-allow-list
  // permission, and `close` once it verifies (or the user dismisses). Both are
  // no-ops when the panel isn't up, so the wizard never has to track its state.
  ipcMain.handle(CHANNELS.dragCoachShow, (_, key: PermissionKey) => showDragCoachWindow(key))

  ipcMain.handle(CHANNELS.dragCoachClose, () => {
    closeDragCoachWindow()
  })

  // `on`, not `handle`: the renderer sends this synchronously from inside the
  // dragstart gesture, and a round trip would lose the drag.
  ipcMain.on(CHANNELS.dragCoachStartDrag, () => startAppDrag())

  // ── Setup Check ───────────────────────────────────────────────────────────
  // One surface for every dependency, with a real action per failure. Replaces
  // the two dead-end warning sentences that lost two external testers on
  // 2026-07-23. See prds/active/2026-07-23-1784776098-zero-dead-ends-setup-check.md
  ipcMain.handle(CHANNELS.setupGetChecks, () => buildSetupChecks())

  ipcMain.handle(CHANNELS.setupRunFix, async (event, id: SetupCheckId) => {
    lowerOnboardingWindowForGrant()
    // Progress goes back to the window that ASKED, not a broadcast — two
    // surfaces can show setup at once (onboarding + Settings) and only the
    // one driving the install should animate.
    const res = await runSetupFix(id, (message, percent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(CHANNELS.setupFixProgress, { id, message, percent })
      }
    })
    if (!event.sender.isDestroyed()) {
      event.sender.send(CHANNELS.setupFixProgress, { id, message: '', done: true, ok: res.ok })
    }
    return res
  })

  ipcMain.handle(CHANNELS.setupSwitchBackend, () => runSetupSwitch())

  ipcMain.handle(CHANNELS.setupOpen, () => route('setup'))

  ipcMain.handle(CHANNELS.onboardingComplete, (_, surface: OnboardingSurface) => {
    // Leave mock mode first so a replay can't strand the app believing onboarding
    // was never done. No-op outside a dev replay.
    endFtueMock()
    // Persists the flag, closes the window, and releases the app-tail gate.
    completeOnboarding(surface)
  })

  // Screen Recording granted but the per-process TCC cache still refuses. The
  // wizard used to print "quit and reopen" and leave the user to do it by hand,
  // which wrote no marker at all — so the next launch was a cold boot and landed
  // them on the panel mid-wizard. Same relaunch the Setup window already does.
  ipcMain.handle(CHANNELS.onboardingSetHeight, (e, height: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    const [w] = win.getSize()
    // resizable:false means setSize is the only way to change it, and it must
    // stay centered or the window walks down the screen on every toggle.
    win.setSize(w, height, true)
    win.center()
  })

  ipcMain.handle(CHANNELS.onboardingRestart, () => {
    app.relaunch()
    app.exit(0)
  })

  // ── Value tour (how-to walkthrough) ──────────────────────────────────────
  // Done and Skip have the same main-side effect (mark seen + close); the
  // distinction is tracked renderer-side via analytics before the invoke.
  ipcMain.handle(CHANNELS.tourComplete, () => completeTour())
  ipcMain.handle(CHANNELS.tourSkip, () => completeTour())

  // Press-to-confirm probe: renderer arms on step entry, disarms (shortcutId:
  // null) on step change/skip/complete. Belt-and-braces disarm also lives in
  // tour-window.ts's `closed` handler, so a crashed renderer can't strand it.
  ipcMain.on(CHANNELS.tourProbeArm, (_, payload: { shortcutId: ShortcutId | null }) => {
    armProbe(payload?.shortcutId ?? null)
  })

  // §7.3 dev-only mock confirm — mockConfirmTourStep() itself IS_DEV-gates, so
  // this handler is a harmless no-op in a packaged build.
  ipcMain.on(CHANNELS.tourMockConfirm, () => mockConfirmTourStep())

  // Dev-only: hold/release the fake ⌘⌥⇧ chord so the letter-cap-revealed frame
  // can be inspected without occupying the keyboard. mockTourMods IS_DEV-gates.
  ipcMain.on(CHANNELS.tourMockMods, (_, payload: { down: boolean }) => {
    mockTourMods(payload?.down === true)
  })

  ipcMain.handle(CHANNELS.openPath, async (_, target: string) => {
    // Act-result reveal. `target` is either a produced FILE (act.outputPath) or the
    // run FOLDER. Open a folder; for a file, reveal it in Finder with the file
    // selected so the user lands ON the output, not on it opened in some app.
    // (The HUD card does the same in hud-window.ts.)
    try {
      if (!existsSync(target)) {
        // Nothing was produced at that path. We used to mkdir it so the reveal
        // still did something — but `target` comes from the renderer, so that
        // handed a compromised renderer arbitrary directory creation anywhere on
        // disk. A missing output is a no-op; the run folder is reachable from the
        // HUD card regardless.
        console.error('openPath ignored: no such path:', target)
        return
      }
      if (statSync(target).isDirectory()) await shell.openPath(target)
      else shell.showItemInFolder(target)
    } catch (err) {
      console.error('openPath failed:', err)
    }
  })

  ipcMain.handle(CHANNELS.openMedia, async (_, file: string) => {
    // Media only: an arbitrary renderer-supplied path handed to shell.openPath would launch executables.
    if (typeof file !== 'string' || !/\.(png|jpe?g|gif|webp|svg|mp4|mov|webm)$/i.test(file)) return
    if (!existsSync(file)) return
    const err = await shell.openPath(file)
    if (err) console.error('openMedia failed:', err)
  })

  ipcMain.handle(CHANNELS.openExternal, async (_, url: string) => {
    // Markdown links in assistant answers open in the default browser. Hard-gate to
    // http(s) so a hostile response can't hand us a `file://`, `javascript:`, or a
    // custom-scheme URL that shell.openExternal would obey.
    try {
      if (typeof url !== 'string') return
      const scheme = new URL(url).protocol
      if (scheme !== 'https:' && scheme !== 'http:') return
      await shell.openExternal(url)
    } catch (err) {
      console.error('openExternal failed:', err)
    }
  })

  ipcMain.handle(CHANNELS.linkMenu, (e, url: string, canOpenHere: boolean) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
    return new Promise<LinkMenuChoice>((resolve) => {
      let choice: LinkMenuChoice = null
      Menu.buildFromTemplate([
        ...(canOpenHere ? [{ label: 'Open in the Browser tab', click: () => (choice = 'app') }] : []),
        { label: 'Open in your browser', click: () => void shell.openExternal(url) },
        { type: 'separator' as const },
        { label: 'Copy link', click: () => clipboard.writeText(url) }
      ]).popup({
        window: BrowserWindow.fromWebContents(e.sender) ?? undefined,
        callback: () => resolve(choice)
      })
    })
  })

  ipcMain.handle(CHANNELS.nativeMenu, (e, items: NativeMenuItem[]) => {
    if (!Array.isArray(items) || items.length === 0) return null
    return new Promise<string | null>((resolve) => {
      Menu.buildFromTemplate(
        items.map((item) =>
          'type' in item
            ? { type: 'separator' as const }
            : {
                label: item.label,
                enabled: item.enabled !== false,
                click: () => resolve(item.id)
              }
        )
      ).popup({
        window: BrowserWindow.fromWebContents(e.sender) ?? undefined,
        // macOS can close the menu before the item's click fires; defer so a click still wins.
        callback: () => setTimeout(() => resolve(null), 0)
      })
    })
  })

  ipcMain.on(CHANNELS.track, (_, payload: { event: string; props?: Record<string, unknown> }) => {
    if (payload?.event) trackFromRenderer(payload.event, payload.props || {})
  })

  // Renderer-side errors (React throws, unhandled rejections in a window) land
  // in the same public.errors table as main-process crashes, tagged source.
  ipcMain.on(CHANNELS.reportError, (_, payload: ErrorReport) => {
    if (payload?.message) trackError({ ...payload, source: payload.source || 'renderer' })
  })

  // ── Admin platform dashboard ───────────────────────────────────────────────
  // UI-visibility check (the real boundary is server-side in admin-stats).
  ipcMain.handle(CHANNELS.adminIsAdmin, async () => isCurrentUserAdmin())

  // "View as user" preview. The read answers with the REAL admin check plus the
  // flag, so Settings can render the exit switch for an admin who is currently
  // being shown a user's view — isCurrentUserAdmin() alone would say "no admin
  // here" and hide the way back. The write goes through the same broadcast the
  // tray uses, so both surfaces flip together.
  ipcMain.handle(CHANNELS.adminGetViewAsUser, async () => ({
    realAdmin: await isRealAdmin(),
    viewAsUser: isPreviewingAsUser()
  }))

  ipcMain.handle(CHANNELS.adminSetViewAsUser, async (_, on: boolean) => {
    // A non-admin flipping this would be a no-op that still costs a tray rebuild.
    if (!(await isRealAdmin())) return false
    // Dynamic import — index.ts imports this module, so a static one would be a
    // cycle. Same workaround as broadcastIncognito in ipc/settings.ts.
    const { setViewAsUserPreview } = await import('../index')
    setViewAsUserPreview(!!on)
    return isPreviewingAsUser()
  })

  // Hydrate the History flyout's thumbs state in one shot: run_id → latest rating.
  ipcMain.handle(CHANNELS.feedbackList, async () => FEEDBACK.all())

  // ── Auto-update ────────────────────────────────────────────────────────────
  // check/download/install delegate to the single updater module. In manual mode
  // (current) the renderer uses updateOpenReleasePage instead of download/install.
  ipcMain.handle(CHANNELS.updateCheck, () => updaterIpc.check())
  ipcMain.handle(CHANNELS.updateDownload, () => updaterIpc.download())
  ipcMain.handle(CHANNELS.updateInstall, () => updaterIpc.install())
  ipcMain.handle(CHANNELS.updateOpenReleasePage, () => updaterIpc.openReleasePage())
  ipcMain.handle(CHANNELS.updateGetState, () => updaterIpc.getState())

  // Native file picker for attachments — shared by panel + MightyChat. Returns
  // classified MediaAttachments (kind inferred from extension in one shared place,
  // src/shared/attachments.ts) so the renderer never duplicates extension logic.
  ipcMain.handle(CHANNELS.pickAttachments, async (): Promise<MediaAttachment[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: ATTACHMENT_DIALOG_FILTERS
    })
    if (result.canceled) return []
    return result.filePaths.map(toAttachment)
  })

  ipcMain.handle(CHANNELS.pasteClipboardImage, async (): Promise<MediaAttachment | null> => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const dir = join(app.getPath('userData'), 'pasted')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `pasted-${Date.now()}.png`)
    await writeFile(path, image.toPNG())
    return toAttachment(path)
  })

  ipcMain.handle(CHANNELS.saveDroppedImage, async (_, source: DroppedImage): Promise<MediaAttachment | null> => {
    const fetched = source.url && /^https?:/.test(source.url) ? await net.fetch(source.url).catch(() => null) : null
    const type = source.bytes ? source.type : fetched?.ok ? fetched.headers.get('content-type') : null
    const ext = DROPPED_IMAGE_EXT[(type ?? '').split(';')[0].trim()]
    const bytes = source.bytes ?? (fetched && ext ? new Uint8Array(await fetched.arrayBuffer()) : null)
    if (!ext || !bytes) return null
    const dir = join(app.getPath('userData'), 'pasted')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `dropped-${Date.now()}.${ext}`)
    await writeFile(path, bytes)
    return { ...toAttachment(path), name: source.name || `picture.${ext}` }
  })

  ipcMain.handle(CHANNELS.markupSave, async (_, png: string, source: string): Promise<string> => {
    await mkdir(PATHS.MARKUPS, { recursive: true })
    const stem = basename(source, extname(source)).replace(/-markup-\d+$/, '').slice(0, 60)
    const path = join(PATHS.MARKUPS, `${stem}-markup-${Date.now()}.png`)
    await writeFile(path, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'))
    return path
  })

  ipcMain.handle(CHANNELS.markupList, async (): Promise<string[]> => {
    const names = await readdir(PATHS.MARKUPS).catch(() => [] as string[])
    const pngs = names.filter((n) => n.endsWith('.png')).map((n) => join(PATHS.MARKUPS, n))
    const dated = await Promise.all(pngs.map(async (p) => ({ p, at: (await stat(p)).mtimeMs })))
    return dated.sort((a, b) => b.at - a.at).map((d) => d.p)
  })

  // Thumbnail for an attached image — a downscaled JPEG data URL (reuses the vision
  // loader's resize+compress). The composer renders it in the attachment chip. Null
  // for non-images / unreadable paths, so the chip falls back to its kind icon.
  ipcMain.handle(CHANNELS.attachmentThumb, async (_, path: string): Promise<string | null> => {
    return loadImageAsDataUrl(path)
  })

  // ── Bug reports (?window=bug) ──────────────────────────────────────────────
  // Context is collected in main because only main knows the backend, last mode,
  // crash message, and anon/session ids. The form shows all of it before sending.
  ipcMain.handle(CHANNELS.bugReportContext, (): Promise<BugReportContext> => getBugReportContext())

  ipcMain.handle(
    CHANNELS.bugReportSubmit,
    async (_, draft: BugReportDraft): Promise<BugReportResult> => {
      const result = await submitBugReport(draft)
      if (result.ok) track(ANALYTICS_EVENT.bug_report_submitted)
      return result
    }
  )

  // Screenshot is user-initiated only — the app never auto-captures one.
  ipcMain.handle(CHANNELS.bugReportPickScreenshot, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(CHANNELS.bugReportScreenshotThumb, async (_, path: string): Promise<string | null> =>
    loadImageAsDataUrl(path)
  )

  ipcMain.handle(CHANNELS.bugReportClose, (): void => closeBugReportWindow())

  // Submit failed (offline / function down) — hand the user their typed report
  // as a prefilled email rather than losing it.
  ipcMain.handle(CHANNELS.bugReportEmailFallback, (_, url: string): void => {
    if (url.startsWith('mailto:')) void shell.openExternal(url)
  })

  // Read-aloud: synthesize text on demand for the panel/HUD speak button. Returns
  // the bytes as a base64 data URL because a Uint8Array over IPC arrives as a
  // plain object in the renderer, which no <audio> src accepts. Never throws —
  // speak() already resolves every failure to a null-audio result.
  ipcMain.handle(
    CHANNELS.speakText,
    async (_, text: string): Promise<SpeakTextResult> => {
      const { speak } = await import('../audio/tts')
      const r = await speak(typeof text === 'string' ? text : '')
      return {
        dataUrl: r.audio
          ? `data:${r.mimeType};base64,${Buffer.from(r.audio).toString('base64')}`
          : null,
        provider: r.provider,
        // Only the Kokoro rung supplies these; undefined elsewhere, which the
        // renderer reads as "speak it, just don't highlight".
        words: r.words
      }
    }
  )

  // Free-voice install. One install may run at a time: the payload is ~550MB and a
  // second concurrent fetch would fight the first over the same .partial file.
  let kokoroInstalling = false
  ipcMain.handle(
    CHANNELS.kokoroInstall,
    async (event): Promise<{ ok: boolean; error?: string }> => {
      if (kokoroInstalling) return { ok: false, error: 'Already installing.' }
      kokoroInstalling = true
      try {
        const { downloadManagedKokoro } = await import('../audio/download-kokoro')
        const res = await downloadManagedKokoro((p) => {
          // The window can close mid-download; sending to a destroyed frame throws.
          if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.kokoroProgress, p)
        })
        return { ok: res.ok, error: res.error }
      } finally {
        kokoroInstalling = false
      }
    }
  )

  ipcMain.handle(CHANNELS.kokoroRemove, async (): Promise<{ removed: boolean; bytesFreed: number }> => {
    const { removeManagedKokoro } = await import('../audio/download-kokoro')
    return removeManagedKokoro()
  })

  // Drives the Settings card: which state to render (install / installed / unsupported)
  // and whether a paid key is overriding the free voice anyway.
  ipcMain.handle(
    CHANNELS.kokoroStatus,
    async (): Promise<{
      supported: boolean
      installed: boolean
      enabled: boolean
      hasPayload: boolean
      provider: string
    }> => {
      const { isKokoroSupportedPlatform, isKokoroAvailable } = await import('../audio/ensure-kokoro')
      const { resolvedTtsProvider } = await import('../audio/tts')
      const { PREFS } = await import('../store/prefs')
      return {
        supported: isKokoroSupportedPlatform(),
        installed: isKokoroAvailable(),
        enabled: PREFS.getKokoroEnabled(),
        hasPayload: Boolean(CONFIG.COMPANION.KOKORO_DOWNLOAD.url),
        provider: resolvedTtsProvider()
      }
    }
  )
}
