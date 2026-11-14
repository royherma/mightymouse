// MUST stay the first import: it stamps the admin's runtime env override where
// the RENDERER can see it, before any module here pulls in CONFIG. Same rule and
// same reason as env-bootstrap in src/main/index.ts.
import './env-stamp'
import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
import { CHANNELS } from '../shared/ipc'
import type { ReasoningEffort } from '../shared/model-sources'
import type {
  ActionCardPayload,
  ActionResultPayload,
  ActionStepPayload,
  ActionsConfigPatch
} from '../shared/action-engine'
import type {
  UserInputSource,
  VoiceRoutePayload,
  VoiceRoutePendingPayload,
  VoiceRouteEnhancePayload,
  VoiceRouteResultPayload,
  VoiceRoutePickPayload,
  VoiceRoutingMode,
  HistoryItem,
  SoundName,
  UpdateStatusPayload,
  BackendHealthWarning,
  BackendId,
  CheckoutReturnStatus,
  BillingCheckoutItem,
  SubscriptionStatus,
  LifetimeOffer,
  UpgradeReason,
  PanelInitData,
  SuggestState,
  ActivityPayload,
  MediaItem,
  RetranscribeResult,
  CursorFlyTo,
  HighlightBoxPayload,
  AgentCursorAction,
  AgentCursorTarget,
  ComputerUseCommand,
  ComputerUseStatus,
  SelectionBarShowPayload,
  SelectionBarResultPayload,
  PhoneRemoteDevicesChanged,
  PhoneRemoteGetPairCodeOpts,
  FeedbackRating,
  QuickAction,
  BusyPhasePayload,
  HudUpdatePayload,
  HudInitPayload,
  LocalSetupProgress,
  PhoneRemoteTunnelStatus,
  SettingsSectionFocus,
  HudRelayAnswerPayload,
  AgentRelayStatus,
  AgentRelaySessionInfo,
  ResourceSnapshot,
  SideBrowserBounds,
  SideBrowserCommand,
  SideBrowserShortcut,
  SideBrowserTabState,
  FileReadResult,
  FileWriteResult,
  BrowserTaskRequest,
  BrowserTaskResult,
  BrowserTaskProgress,
  BrowserTaskControl,
  BrowserTaskModel,
  BrowserTaskModelsState,
  SideBrowserImportSource,
  SideBrowserImportResult,
  SideBrowserSuggestion,
  ZoomKey,
  ReplyWindowAim,
  ReplyWindowApp,
  ReplyWindowSeeing
} from '../shared/types'
import type {
  AnalyticsEventName,
  AnalyticsEventProps,
  OnboardingSurface
} from '../shared/analytics-events'
import type { BugReportDraft } from '../shared/bug-report'
import type { InkOp } from '../shared/ink'
import type { PlanBackend } from '../shared/plan-logins'
import type { PulseScope } from '../shared/session-pulse'
import type { CompanionStageEvent } from '../shared/companion-debug'
import type { LiveDraft, LiveTurnResult } from '../shared/companion-state'
import type { HideoutControl, HideoutState } from '../shared/hideout'
import type { HandsFreeHostState } from '../shared/hands-free-state'
import type { TourProbeEventPayload } from '../shared/tour/types'
import type { UsageMeter } from '../shared/billing-math'
import type {
  AgentModelChoice,
  AgentSetupProgress,
  CodeTab,
  ModelCatalogEntry,
  SettingsPatch,
  CodeTabHandoff,
  StartupPeek,
  RecoveredRecordingsState,
  NativeMenuItem
} from '../shared/types'
import type { ShortcutId } from '../shared/shortcuts'
import type { SetupCheck, SetupCheckId, SetupFixProgress } from '../shared/setup-check'
import type {
  RelayResponseWire,
  RelaySnapshotWire,
  RelayVerbWire
} from '../shared/phone-remote-protocol'
import type {
  RelayMacAlertSettings,
  RelayNotifyPushLevel,
  RelayPushSettings
} from '../shared/relay-push-filter'

const api = {
  getInitialData: () => ipcRenderer.invoke(CHANNELS.getInitialData),
  modeOverride: (mode: string | null) => ipcRenderer.send(CHANNELS.modeOverride, { mode }),
  ctxToggle: (on: boolean) => ipcRenderer.send(CHANNELS.ctxToggle, { on }),
  draftInput: (text: string) => ipcRenderer.send(CHANNELS.draftInput, { text }),
  actionSelect: (key: string) => ipcRenderer.send(CHANNELS.actionSelect, { key }),
  actionClear: () => ipcRenderer.send(CHANNELS.actionClear),
  skillEditorOpen: () => ipcRenderer.send(CHANNELS.skillEditorOpen),
  skillEditorClose: () => ipcRenderer.send(CHANNELS.skillEditorClose),
  onActionsChanged: (callback: (actions: QuickAction[]) => void) => {
    const handler = (_: unknown, actions: QuickAction[]): void => callback(actions)
    ipcRenderer.on(CHANNELS.actionsChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.actionsChanged, handler)
  },
  historyRequest: (query?: string) => ipcRenderer.send(CHANNELS.historyRequest, query),
  feedbackSubmit: (run_id: string, rating: FeedbackRating | null, note?: string) =>
    ipcRenderer.invoke(CHANNELS.feedbackSubmit, { run_id, rating, note }),
  feedbackList: () => ipcRenderer.invoke(CHANNELS.feedbackList),
  // Bug reports (?window=bug) — namespaced apart from the run-rating feedback
  // above; the two are unrelated surfaces that both wanted the word "feedback".
  bugReportContext: () => ipcRenderer.invoke(CHANNELS.bugReportContext),
  bugReportSubmit: (draft: BugReportDraft) => ipcRenderer.invoke(CHANNELS.bugReportSubmit, draft),
  bugReportPickScreenshot: () => ipcRenderer.invoke(CHANNELS.bugReportPickScreenshot),
  bugReportScreenshotThumb: (path: string) =>
    ipcRenderer.invoke(CHANNELS.bugReportScreenshotThumb, path),
  bugReportClose: () => ipcRenderer.invoke(CHANNELS.bugReportClose),
  bugReportEmailFallback: (url: string) => ipcRenderer.invoke(CHANNELS.bugReportEmailFallback, url),
  specialistLoad: () => ipcRenderer.invoke(CHANNELS.specialistLoad),
  specialistSend: (body: string) => ipcRenderer.invoke(CHANNELS.specialistSend, body),
  specialistOpen: () => ipcRenderer.send(CHANNELS.specialistOpen),
  onSpecialistChanged: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.specialistChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.specialistChanged, handler)
  },
  speakText: (text: string) => ipcRenderer.invoke(CHANNELS.speakText, text),

  // The free offline voice: install/remove the managed payload + read its state.
  kokoro: {
    status: () => ipcRenderer.invoke(CHANNELS.kokoroStatus),
    install: () => ipcRenderer.invoke(CHANNELS.kokoroInstall),
    remove: () => ipcRenderer.invoke(CHANNELS.kokoroRemove),
    // Byte counters, not a percentage: at ~550MB the card shows MB + speed + ETA,
    // and deriving those needs the raw numbers.
    onProgress: (callback: (p: { receivedBytes: number; totalBytes: number }) => void) => {
      const handler = (_: unknown, p: { receivedBytes: number; totalBytes: number }): void =>
        callback(p)
      ipcRenderer.on(CHANNELS.kokoroProgress, handler)
      return () => ipcRenderer.removeListener(CHANNELS.kokoroProgress, handler)
    }
  },
  copy: (text: string) => ipcRenderer.send(CHANNELS.copy, { text }),
  cancel: () => ipcRenderer.send(CHANNELS.cancel),
  panelHide: () => ipcRenderer.send(CHANNELS.panelHide),
  panelMinimizeOrigin: () => ipcRenderer.invoke(CHANNELS.panelMinimizeOrigin),
  stopRun: () => ipcRenderer.send(CHANNELS.stopRun),
  resetSession: () => ipcRenderer.send(CHANNELS.resetSession),
  resumeSession: (runId: string) => ipcRenderer.invoke(CHANNELS.resumeSession, runId),
  resetPanelHeight: () => ipcRenderer.send(CHANNELS.resetPanelHeight),
  resize: (h: number, inChat?: boolean) => ipcRenderer.send(CHANNELS.resize, { h, inChat }),
  submit: (
    q: string,
    mode: string,
    ctx: boolean,
    source: string,
    attachments?: import('../shared/types').MediaAttachment[],
    sessionId?: string
  ) => ipcRenderer.send(CHANNELS.submit, { q, mode, ctx, source, attachments, sessionId }),
  // Open the native file picker for attachments; returns classified MediaAttachment[].
  pickAttachments: (): Promise<import('../shared/types').MediaAttachment[]> =>
    ipcRenderer.invoke(CHANNELS.pickAttachments),
  pasteClipboardImage: (): Promise<import('../shared/types').MediaAttachment | null> =>
    ipcRenderer.invoke(CHANNELS.pasteClipboardImage),
  saveDroppedImage: (source: import('../shared/types').DroppedImage): Promise<import('../shared/types').MediaAttachment | null> =>
    ipcRenderer.invoke(CHANNELS.saveDroppedImage, source),
  markupSave: (png: string, source: string): Promise<string> =>
    ipcRenderer.invoke(CHANNELS.markupSave, png, source),
  markupList: (): Promise<string[]> => ipcRenderer.invoke(CHANNELS.markupList),
  // Resolve a dropped File → its absolute disk path. Electron 32+ removed the
  // legacy `File.path`; webUtils.getPathForFile is the only way, and it's only
  // callable from the privileged preload — so drag-drop must round-trip through here.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  // Downscaled JPEG data URL for an attached image (composer thumbnail); null if
  // not an image / unreadable.
  attachmentThumb: (path: string): Promise<string | null> =>
    ipcRenderer.invoke(CHANNELS.attachmentThumb, path),

  // Subscriptions from main process
  onHistoryData: (callback: (items: HistoryItem[]) => void) => {
    const handler = (_: unknown, items: HistoryItem[]): void => callback(items)
    ipcRenderer.on(CHANNELS.historyData, handler)
    return () => ipcRenderer.removeListener(CHANNELS.historyData, handler)
  },
  onBusyPhase: (callback: (payload: BusyPhasePayload) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.busyPhase, handler)
    return () => ipcRenderer.removeListener(CHANNELS.busyPhase, handler)
  },
  onShowAnswer: (
    callback: (payload: { q: string; a: string; runId?: string; sessionId?: string }) => void
  ) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.showAnswer, handler)
    return () => ipcRenderer.removeListener(CHANNELS.showAnswer, handler)
  },
  onShowActResult: (
    callback: (payload: { summary: string; revealPath: string | null; ok: boolean }) => void
  ) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.showActResult, handler)
    return () => ipcRenderer.removeListener(CHANNELS.showActResult, handler)
  },
  onShowError: (callback: (payload: { msg: string; runId?: string }) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.showError, handler)
    return () => ipcRenderer.removeListener(CHANNELS.showError, handler)
  },
  onBackendHealthWarning: (callback: (payload: BackendHealthWarning) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.backendHealthWarning, handler)
    return () => ipcRenderer.removeListener(CHANNELS.backendHealthWarning, handler)
  },
  // Fresh first-frame payload pushed when the hotkey re-fires over a new app
  // while the panel is already open — overrides the stale context/selection.
  onPanelReseed: (callback: (data: PanelInitData) => void) => {
    const handler = (_: unknown, data: PanelInitData): void => callback(data)
    ipcRenderer.on(CHANNELS.panelReseed, handler)
    return () => ipcRenderer.removeListener(CHANNELS.panelReseed, handler)
  },
  // A capture's HUD card was clicked while the library is already open — select it.
  onMediaFocusFolder: (callback: (folder: string) => void) => {
    const handler = (_: unknown, folder: string): void => callback(folder)
    ipcRenderer.on(CHANNELS.mediaFocusFolder, handler)
    return () => ipcRenderer.removeListener(CHANNELS.mediaFocusFolder, handler)
  },
  getModelCatalog: () => ipcRenderer.invoke(CHANNELS.modelCatalogGet),
  onModelCatalogChanged: (callback: (models: ModelCatalogEntry[]) => void) => {
    const handler = (_: unknown, models: ModelCatalogEntry[]): void => callback(models)
    ipcRenderer.on(CHANNELS.modelCatalogChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.modelCatalogChanged, handler)
  },
  onMightyFocusCode: (callback: (codeTab?: CodeTab) => void) => {
    const handler = (_: unknown, codeTab?: CodeTab): void => callback(codeTab)
    ipcRenderer.on(CHANNELS.mightyFocusCode, handler)
    return () => ipcRenderer.removeListener(CHANNELS.mightyFocusCode, handler)
  },
  codeTakeStartedAgent: (): Promise<CodeTabHandoff | null> =>
    ipcRenderer.invoke(CHANNELS.codeTakeStartedAgent),
  codeNoProjectFolder: (): Promise<string> => ipcRenderer.invoke(CHANNELS.codeNoProjectFolder),
  codeStartupPeek: (pane: string): Promise<StartupPeek> =>
    ipcRenderer.invoke(CHANNELS.codeStartupPeek, pane),
  codeStartupAnswer: (pane: string, index: number): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.codeStartupAnswer, pane, index),
  // Incognito flipped from any surface (tray or Settings) — keep badges live.
  onIncognitoChanged: (callback: (on: boolean) => void) => {
    const handler = (_: unknown, on: boolean): void => callback(on)
    ipcRenderer.on(CHANNELS.incognitoChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.incognitoChanged, handler)
  },
  // "View as user" flipped from any surface (tray or Settings) — keep every
  // window's admin surfaces in sync instead of only the one that toggled it.
  onViewAsUserChanged: (callback: (on: boolean) => void) => {
    const handler = (_: unknown, on: boolean): void => callback(on)
    ipcRenderer.on(CHANNELS.viewAsUserChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.viewAsUserChanged, handler)
  },
  // Backend/model changed from any surface (Settings, or a resumed session
  // re-adopting its original backend) — keep model chips live everywhere.
  onBackendChanged: (callback: (backend: BackendId) => void) => {
    const handler = (_: unknown, backend: BackendId): void => callback(backend)
    ipcRenderer.on(CHANNELS.backendChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.backendChanged, handler)
  },

  // HUD specific events
  onHudInit: (callback: (payload: HudInitPayload) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.hudInit, handler)
    return () => ipcRenderer.removeListener(CHANNELS.hudInit, handler)
  },
  onHudUpdate: (callback: (payload: HudUpdatePayload) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.hudUpdate, handler)
    return () => ipcRenderer.removeListener(CHANNELS.hudUpdate, handler)
  },
  onHudDone: (
    callback: (payload: {
      ok: boolean
      summary: string
      revealPath: string | null
      timerFreeze: string
      actions?: ('ask' | 'act')[]
      body?: string | null
      preview?: { path: string; kind: 'image' | 'video' } | null
      confirmAct?: boolean
    }) => void
  ) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.hudDone, handler)
    return () => ipcRenderer.removeListener(CHANNELS.hudDone, handler)
  },
  // Run Transcript Inspector: open the full-screen inspector for a run (from the
  // HUD's expand icon), close it (its ✕/Esc), and subscribe to the live event
  // stream (the inspector window uses this).
  transcriptOpen: (runId: string) => ipcRenderer.send(CHANNELS.transcriptOpen, runId),
  transcriptClose: () => ipcRenderer.send(CHANNELS.transcriptClose),
  onTranscriptEvent: (
    callback: (payload: import('../shared/types').TranscriptEventPayload) => void
  ) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.transcriptEvent, handler)
    return () => ipcRenderer.removeListener(CHANNELS.transcriptEvent, handler)
  },
  replyWindowHide: () => ipcRenderer.send(CHANNELS.replyWindowHide),
  replyWindowOpenBig: (ref: string) => ipcRenderer.send(CHANNELS.replyWindowOpenBig, ref),
  replyWindowShow: (ref: string) => ipcRenderer.send(CHANNELS.replyWindowShow, ref),
  onReplyWindowAim: (callback: (aim: ReplyWindowAim) => void) => {
    const handler = (_: unknown, aim: ReplyWindowAim): void => callback(aim)
    ipcRenderer.on(CHANNELS.replyWindowAim, handler)
    return () => ipcRenderer.removeListener(CHANNELS.replyWindowAim, handler)
  },
  replyWindowExpand: () => ipcRenderer.send(CHANNELS.replyWindowExpand),
  onReplyWindowSeeing: (callback: (seeing: ReplyWindowSeeing) => void) => {
    const handler = (_: unknown, seeing: ReplyWindowSeeing): void => callback(seeing)
    ipcRenderer.on(CHANNELS.replyWindowSeeing, handler)
    return () => ipcRenderer.removeListener(CHANNELS.replyWindowSeeing, handler)
  },
  replyWindowAuto: (on?: boolean): Promise<boolean> => ipcRenderer.invoke(CHANNELS.replyWindowAuto, on),
  replyWindowApp: (): Promise<ReplyWindowApp | null> => ipcRenderer.invoke(CHANNELS.replyWindowApp),
  replyWindowShowOver: (bundleId: string, on: boolean) => ipcRenderer.send(CHANNELS.replyWindowShowOver, bundleId, on),
  onReplyWindowScreen: (callback: (path: string) => void) => {
    const handler = (_: unknown, path: string): void => callback(path)
    ipcRenderer.on(CHANNELS.replyWindowScreen, handler)
    return () => ipcRenderer.removeListener(CHANNELS.replyWindowScreen, handler)
  },
  hudDismiss: (runId: string) => ipcRenderer.send(CHANNELS.hudDismiss, { runId }),
  hudStopCapture: (runId: string) => ipcRenderer.send(CHANNELS.hudStopCapture, { runId }),
  hudCancelCapture: (runId: string) => ipcRenderer.send(CHANNELS.hudCancelCapture, { runId }),
  hudStopRun: (runId: string) => ipcRenderer.send(CHANNELS.hudStopRun, { runId }),
  hudReveal: (runId: string) => ipcRenderer.send(CHANNELS.hudReveal, { runId }),
  hudAction: (runId: string, action: 'ask' | 'act', instruction?: string) =>
    ipcRenderer.send(CHANNELS.hudAction, { runId, action, instruction }),
  hudConfirmAct: (runId: string, answer: 'confirm' | 'cancel') =>
    ipcRenderer.send(CHANNELS.hudConfirmAct, { runId, answer }),
  hudHover: (runId: string) => ipcRenderer.send(CHANNELS.hudHover, { runId }),
  hudLeave: (runId: string) => ipcRenderer.send(CHANNELS.hudLeave, { runId }),
  hudFollowUp: (runId: string, q: string) => ipcRenderer.send(CHANNELS.hudFollowUp, { runId, q }),
  // Run a skill (QuickAction) against a finished card — main builds the attachment
  // (capture file, or the full chat serialized to a temp .md) and launches it.
  hudRunSkill: (runId: string, actionKey: string) =>
    ipcRenderer.send(CHANNELS.hudRunSkill, { runId, actionKey }),
  hudSetFocusable: (runId: string, focusable: boolean) =>
    ipcRenderer.send(CHANNELS.hudSetFocusable, { runId, focusable }),
  // Electron zoom is per-origin, so the Mighty panel's zoom leaks into every card; main sizes in unzoomed px.
  hudResize: (runId: string, height: number) =>
    ipcRenderer.send(CHANNELS.hudResize, { runId, height: height * webFrame.getZoomFactor() }),

  // Voice routing card
  onVoiceRouteInit: (callback: (payload: VoiceRoutePayload) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.voiceRouteInit, handler)
    return () => ipcRenderer.removeListener(CHANNELS.voiceRouteInit, handler)
  },
  onVoiceRoutePending: (callback: (payload: VoiceRoutePendingPayload) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.voiceRoutePending, handler)
    return () => ipcRenderer.removeListener(CHANNELS.voiceRoutePending, handler)
  },
  onVoiceRouteReset: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.voiceRouteReset, handler)
    return () => ipcRenderer.removeListener(CHANNELS.voiceRouteReset, handler)
  },
  onVoiceRouteSearchOpen: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.voiceRouteSearchOpen, handler)
    return () => ipcRenderer.removeListener(CHANNELS.voiceRouteSearchOpen, handler)
  },
  voiceRouteSearchFocus: (runId: string, on: boolean) =>
    ipcRenderer.send(CHANNELS.voiceRouteSearchFocus, { runId, on }),
  onVoiceRouteResult: (callback: (payload: VoiceRouteResultPayload) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.voiceRouteResult, handler)
    return () => ipcRenderer.removeListener(CHANNELS.voiceRouteResult, handler)
  },
  voiceRoutePick: (payload: VoiceRoutePickPayload) =>
    ipcRenderer.send(CHANNELS.voiceRoutePick, payload),
  voiceRouteDismiss: (runId: string) => ipcRenderer.send(CHANNELS.voiceRouteDismiss, { runId }),
  voiceRouteGo: (runId: string, sinkId: string) =>
    ipcRenderer.send(CHANNELS.voiceRouteGo, { runId, sinkId }),
  voiceRouteRetry: (runId: string) => ipcRenderer.send(CHANNELS.voiceRouteRetry, { runId }),
  voiceRouteEnhance: (runId: string, sinkId: string, select?: number, copy?: boolean) =>
    ipcRenderer.send(CHANNELS.voiceRouteEnhance, { runId, sinkId, select, copy }),
  onVoiceRouteEnhanced: (callback: (payload: VoiceRouteEnhancePayload) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.voiceRouteEnhanced, handler)
    return () => ipcRenderer.removeListener(CHANNELS.voiceRouteEnhanced, handler)
  },
  voiceRouteResize: (runId: string, height: number) =>
    ipcRenderer.send(CHANNELS.voiceRouteResize, {
      runId,
      height: height * webFrame.getZoomFactor()
    }),
  voiceRouteWidth: (runId: string, width: number) =>
    ipcRenderer.send(CHANNELS.voiceRouteWidth, { runId, width }),
  voiceRouteMove: (runId: string, dx: number, dy: number) =>
    ipcRenderer.send(CHANNELS.voiceRouteMove, { runId, dx, dy }),
  voiceRoutingConfigGet: () => ipcRenderer.invoke(CHANNELS.voiceRoutingConfigGet),
  voiceRoutingConfigSet: (patch: {
    mode?: VoiceRoutingMode
    offerGoTo?: boolean
    showSkills?: boolean
    showAgents?: boolean
  }) => ipcRenderer.invoke(CHANNELS.voiceRoutingConfigSet, patch),
  voiceRouteFromHud: (runId: string) => ipcRenderer.invoke(CHANNELS.voiceRouteFromHud, { runId }),
  voiceRouteFromHistory: (runId: string) =>
    ipcRenderer.invoke(CHANNELS.voiceRouteFromHistory, { runId }),
  onActionCardShow: (callback: (payload: ActionCardPayload) => void) => {
    const handler = (_e: unknown, payload: ActionCardPayload): void => callback(payload)
    ipcRenderer.on(CHANNELS.actionCardShow, handler)
    return () => ipcRenderer.removeListener(CHANNELS.actionCardShow, handler)
  },
  onActionChordMods: (callback: (held: boolean) => void) => {
    const handler = (_e: unknown, held: boolean): void => callback(held)
    ipcRenderer.on(CHANNELS.actionChordMods, handler)
    return () => ipcRenderer.removeListener(CHANNELS.actionChordMods, handler)
  },
  onActionResult: (callback: (payload: ActionResultPayload) => void) => {
    const handler = (_e: unknown, payload: ActionResultPayload): void => callback(payload)
    ipcRenderer.on(CHANNELS.actionResult, handler)
    return () => ipcRenderer.removeListener(CHANNELS.actionResult, handler)
  },
  onActionStep: (callback: (payload: ActionStepPayload) => void) => {
    const handler = (_e: unknown, payload: ActionStepPayload): void => callback(payload)
    ipcRenderer.on(CHANNELS.actionStep, handler)
    return () => ipcRenderer.removeListener(CHANNELS.actionStep, handler)
  },
  actionRun: (runId: string, proposalId: string) =>
    ipcRenderer.send(CHANNELS.actionRun, { runId, proposalId }),
  actionStop: (runId: string) => ipcRenderer.send(CHANNELS.actionStop, { runId }),
  actionSetSlot: (runId: string, proposalId: string, slotKey: string, value: string) =>
    ipcRenderer.send(CHANNELS.actionSetSlot, { runId, proposalId, slotKey, value }),
  actionDismiss: (runId: string, proposalId: string) =>
    ipcRenderer.send(CHANNELS.actionDismiss, { runId, proposalId }),
  actionsConfigGet: () => ipcRenderer.invoke(CHANNELS.actionsConfigGet),
  actionsConfigSet: (patch: ActionsConfigPatch) =>
    ipcRenderer.invoke(CHANNELS.actionsConfigSet, patch),
  actionsOpenPluginsFolder: () => ipcRenderer.invoke(CHANNELS.actionsOpenPluginsFolder),
  hudRelayAnswer: (payload: HudRelayAnswerPayload) =>
    ipcRenderer.send(CHANNELS.hudRelayAnswer, payload),
  hudGoToOrigin: (requestId: string) => ipcRenderer.send(CHANNELS.hudGoToOrigin, requestId),
  hudCanGoToOrigin: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.hudCanGoToOrigin, requestId),

  // Dynamic Island (main → island window): live activity state pushes.
  onIslandActivity: (callback: (payload: ActivityPayload) => void) => {
    const handler = (_: unknown, payload: ActivityPayload): void => callback(payload)
    ipcRenderer.on(CHANNELS.islandActivity, handler)
    return () => ipcRenderer.removeListener(CHANNELS.islandActivity, handler)
  },

  // Sound effects (main → hidden sound window)
  onPlaySound: (callback: (name: SoundName) => void) => {
    const handler = (_: unknown, name: SoundName): void => callback(name)
    ipcRenderer.on(CHANNELS.playSound, handler)
    return () => ipcRenderer.removeListener(CHANNELS.playSound, handler)
  },

  // Cursor companion overlay
  cursorToggle: (on: boolean) => ipcRenderer.send(CHANNELS.cursorToggle, { on }),
  onCursorPos: (callback: (pos: { x: number; y: number }) => void) => {
    const handler = (_: unknown, pos: { x: number; y: number }): void => callback(pos)
    ipcRenderer.on(CHANNELS.cursorPos, handler)
    return () => ipcRenderer.removeListener(CHANNELS.cursorPos, handler)
  },
  onCursorStyle: (callback: (style: string) => void) => {
    const handler = (_: unknown, style: string): void => callback(style)
    ipcRenderer.on(CHANNELS.cursorStyle, handler)
    return () => ipcRenderer.removeListener(CHANNELS.cursorStyle, handler)
  },
  onCursorFlyTo: (callback: (p: CursorFlyTo) => void) => {
    const handler = (_: unknown, p: CursorFlyTo): void => callback(p)
    ipcRenderer.on(CHANNELS.cursorFlyTo, handler)
    return () => ipcRenderer.removeListener(CHANNELS.cursorFlyTo, handler)
  },
  onCursorSuggest: (callback: (state: SuggestState) => void) => {
    const handler = (_: unknown, state: SuggestState): void => callback(state)
    ipcRenderer.on(CHANNELS.cursorSuggest, handler)
    return () => ipcRenderer.removeListener(CHANNELS.cursorSuggest, handler)
  },
  cursorDismiss: () => ipcRenderer.send(CHANNELS.cursorDismiss),
  cursorSetClickable: (on: boolean) => ipcRenderer.send(CHANNELS.cursorSetClickable, { on }),
  cursorSetFocusable: (on: boolean) => ipcRenderer.send(CHANNELS.cursorSetFocusable, { on }),
  onCursorCancelArm: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.cursorCancelArm, handler)
    return () => ipcRenderer.removeListener(CHANNELS.cursorCancelArm, handler)
  },
  cursorAccept: (index: number, finalText?: string) =>
    ipcRenderer.send(CHANNELS.cursorAccept, { index, finalText }),
  onCursorPointerEnabled: (callback: (enabled: boolean) => void) => {
    const handler = (_: unknown, enabled: boolean): void => callback(enabled)
    ipcRenderer.on(CHANNELS.cursorPointerEnabled, handler)
    return () => ipcRenderer.removeListener(CHANNELS.cursorPointerEnabled, handler)
  },
  cursorGetState: () => ipcRenderer.invoke(CHANNELS.cursorGetState),

  // Act-mode highlight box overlay
  onInkOp: (callback: (op: InkOp) => void) => {
    const handler = (_: unknown, op: InkOp): void => callback(op)
    ipcRenderer.on(CHANNELS.inkOp, handler)
    return () => ipcRenderer.removeListener(CHANNELS.inkOp, handler)
  },
  onActHighlight: (callback: (p: HighlightBoxPayload) => void) => {
    const handler = (_: unknown, p: HighlightBoxPayload): void => callback(p)
    ipcRenderer.on(CHANNELS.actHighlight, handler)
    return () => ipcRenderer.removeListener(CHANNELS.actHighlight, handler)
  },

  // Computer-use agent cursor overlay
  onAgentCursorShow: (callback: (p: AgentCursorTarget) => void) => {
    const handler = (_: unknown, p: AgentCursorTarget): void => callback(p)
    ipcRenderer.on(CHANNELS.agentCursorShow, handler)
    return () => ipcRenderer.removeListener(CHANNELS.agentCursorShow, handler)
  },
  onAgentCursorHide: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.agentCursorHide, handler)
    return () => ipcRenderer.removeListener(CHANNELS.agentCursorHide, handler)
  },
  agentCursorHover: (on: boolean): void => ipcRenderer.send(CHANNELS.agentCursorHover, on),
  agentCursorControl: (action: AgentCursorAction): void => ipcRenderer.send(CHANNELS.agentCursorControl, action),

  onComputerUseStatus: (callback: (p: ComputerUseStatus) => void) => {
    const handler = (_: unknown, p: ComputerUseStatus): void => callback(p)
    ipcRenderer.on(CHANNELS.computerUseStatus, handler)
    return () => ipcRenderer.removeListener(CHANNELS.computerUseStatus, handler)
  },
  computerUseControl: (command: ComputerUseCommand) =>
    ipcRenderer.send(CHANNELS.computerUseControl, command),

  // Selection bar over highlighted text
  onSelectionBarShow: (callback: (p: SelectionBarShowPayload) => void) => {
    const handler = (_: unknown, p: SelectionBarShowPayload): void => callback(p)
    ipcRenderer.on(CHANNELS.selectionBarShow, handler)
    return () => ipcRenderer.removeListener(CHANNELS.selectionBarShow, handler)
  },
  onSelectionBarHide: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.selectionBarHide, handler)
    return () => ipcRenderer.removeListener(CHANNELS.selectionBarHide, handler)
  },
  onSelectionBarResult: (callback: (p: SelectionBarResultPayload) => void) => {
    const handler = (_: unknown, p: SelectionBarResultPayload): void => callback(p)
    ipcRenderer.on(CHANNELS.selectionBarResult, handler)
    return () => ipcRenderer.removeListener(CHANNELS.selectionBarResult, handler)
  },
  // `prompt` is the typed question on the Ask chip; ignored by instruction chips.
  selectionBarAction: (key: string, prompt?: string) =>
    ipcRenderer.send(CHANNELS.selectionBarAction, key, prompt ?? ''),
  selectionBarDismiss: () => ipcRenderer.send(CHANNELS.selectionBarDismiss),
  // `edited` only when the user changed the draft; omitted means "as written".
  selectionBarAccept: (edited?: string) => ipcRenderer.send(CHANNELS.selectionBarAccept, edited),
  selectionBarResize: (height: number, width?: number) =>
    ipcRenderer.send(CHANNELS.selectionBarResize, height, width),
  selectionBarMove: (x: number, y: number) => ipcRenderer.send(CHANNELS.selectionBarMove, x, y),
  islandMove: (dx: number, dy: number) => ipcRenderer.send(CHANNELS.islandMove, dx, dy),
  islandResetPosition: () => ipcRenderer.send(CHANNELS.islandResetPosition),
  selectionBarListHistory: () => ipcRenderer.invoke(CHANNELS.selectionBarListHistory),
  selectionBarPasteHistory: (runId: string) =>
    ipcRenderer.send(CHANNELS.selectionBarPasteHistory, runId),
  selectionBarHover: (over: boolean) => ipcRenderer.send(CHANNELS.selectionBarHover, over),
  selectionBarSetFocusable: (on: boolean) =>
    ipcRenderer.send(CHANNELS.selectionBarSetFocusable, on),
  selectionBarListActions: () => ipcRenderer.invoke(CHANNELS.selectionBarListActions),
  selectionBarSaveAction: (key: string | null, label: string, instruction: string) =>
    ipcRenderer.invoke(CHANNELS.selectionBarSaveAction, key, label, instruction),
  selectionBarDeleteAction: (key: string) =>
    ipcRenderer.invoke(CHANNELS.selectionBarDeleteAction, key),
  selectionBarResetActions: () => ipcRenderer.invoke(CHANNELS.selectionBarResetActions),
  selectionBarListRecents: () => ipcRenderer.invoke(CHANNELS.selectionBarListRecents),
  selectionBarKeepRecent: (prompt: string) =>
    ipcRenderer.invoke(CHANNELS.selectionBarKeepRecent, prompt),
  selectionBarSetFast: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetSelectionBarFast, on),

  // Quick-action CRUD
  actionsLoad: () => ipcRenderer.invoke(CHANNELS.actionsLoad),
  actionsSave: (actions: QuickAction[]) => ipcRenderer.invoke(CHANNELS.actionsSave, actions),
  skillsList: () => ipcRenderer.invoke(CHANNELS.skillsList),

  // Settings / permissions window
  settingsGet: () => ipcRenderer.invoke(CHANNELS.settingsGet),
  settingsInstallHint: (tool: 'ffmpeg' | 'whisper' | 'node') =>
    ipcRenderer.invoke(CHANNELS.settingsInstallHint, tool),
  settingsRequestPermission: (key: string) =>
    ipcRenderer.invoke(CHANNELS.settingsRequestPermission, key),
  settingsOpenPane: (key: string) => ipcRenderer.invoke(CHANNELS.settingsOpenPane, key),
  settingsOpenOnboarding: () => ipcRenderer.invoke(CHANNELS.settingsOpenOnboarding),
  devReplayFirstRun: (mock?: boolean) => ipcRenderer.invoke(CHANNELS.devReplayFirstRun, mock),
  settingsTakeFocusSection: () => ipcRenderer.invoke(CHANNELS.settingsTakeFocusSection),
  onSettingsFocusSection: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.settingsFocusSection, handler)
    return () => ipcRenderer.removeListener(CHANNELS.settingsFocusSection, handler)
  },
  openSettingsWindow: (focusSection?: SettingsSectionFocus) =>
    ipcRenderer.invoke(CHANNELS.openSettingsWindow, focusSection),
  openPhoneRemoteQrWindow: () => ipcRenderer.invoke(CHANNELS.openPhoneRemoteQrWindow),
  openPlaygroundWindow: () => ipcRenderer.invoke(CHANNELS.openPlaygroundWindow),
  openAnalyticsWindow: () => ipcRenderer.invoke(CHANNELS.openAnalyticsWindow),
  openDeckWindow: () => ipcRenderer.invoke(CHANNELS.openDeckWindow),
  openCanvasWindow: () => ipcRenderer.invoke(CHANNELS.openCanvasWindow),
  canvas: {
    load: () => ipcRenderer.invoke(CHANNELS.canvasLoad),
    save: (state: import('../shared/canvas').CanvasState) => ipcRenderer.invoke(CHANNELS.canvasSave, state),
    think: (text: string) => ipcRenderer.invoke(CHANNELS.canvasThink, text),
    directions: (idea: string, steps: string[]) => ipcRenderer.invoke(CHANNELS.canvasDirections, idea, steps),
    hide: () => ipcRenderer.invoke(CHANNELS.canvasHide),
    startNew: () => ipcRenderer.invoke(CHANNELS.canvasNew),
    boards: () => ipcRenderer.invoke(CHANNELS.canvasBoards),
    open: (id: string) => ipcRenderer.invoke(CHANNELS.canvasOpen, id)
  },
  openBillingWindow: () => ipcRenderer.invoke(CHANNELS.openBillingWindow),
  openUpgradeWindow: (reason: UpgradeReason) =>
    ipcRenderer.invoke(CHANNELS.openUpgradeWindow, reason),
  upgradeResize: (height: number) => ipcRenderer.send(CHANNELS.upgradeResize, height),
  upgradeGetReason: (): Promise<UpgradeReason> => ipcRenderer.invoke(CHANNELS.upgradeGetReason),
  onUpgradeReason: (callback: (reason: UpgradeReason) => void) => {
    const handler = (_: unknown, reason: UpgradeReason): void => callback(reason)
    ipcRenderer.on(CHANNELS.upgradeReason, handler)
    return () => ipcRenderer.removeListener(CHANNELS.upgradeReason, handler)
  },
  openMediaLibraryWindow: () => ipcRenderer.invoke(CHANNELS.openMediaLibraryWindow),
  getRecoveredRecordings: () => ipcRenderer.invoke(CHANNELS.recoveredRecordingsGet),
  dismissRecoveredRecordings: () => ipcRenderer.invoke(CHANNELS.recoveredRecordingsDismiss),
  onRecoveredRecordingsChanged: (callback: (state: RecoveredRecordingsState) => void) => {
    const handler = (_: unknown, state: RecoveredRecordingsState): void => callback(state)
    ipcRenderer.on(CHANNELS.recoveredRecordingsChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.recoveredRecordingsChanged, handler)
  },
  mediaList: (): Promise<MediaItem[]> => ipcRenderer.invoke(CHANNELS.mediaList),
  mediaDelete: (folder: string): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.mediaDelete, folder),
  mediaReveal: (folder: string) => ipcRenderer.invoke(CHANNELS.mediaReveal, folder),
  mediaEnrich: (folder: string, force?: boolean): Promise<MediaItem | null> =>
    ipcRenderer.invoke(CHANNELS.mediaEnrich, folder, force),
  mediaRetranscribe: (folder: string): Promise<RetranscribeResult> =>
    ipcRenderer.invoke(CHANNELS.mediaRetranscribe, folder),
  // Build a media:// URL for an absolute capture-file path. Pure (no IPC). The
  // whole path is ONE percent-encoded opaque segment under host `file`, so the
  // standard scheme can't steal/lowercase a path segment as the host. Matches
  // the handler's decode in media-protocol.ts.
  mediaUrl: (absPath: string): string => 'media://file/' + encodeURIComponent(absPath),
  // Resolve a macOS app's real icon → cached PNG abs-path (or null). Pair with
  // mediaUrl() to render it: <img src={mediaUrl(await appIcon(name))} />.
  appIcon: (appName: string): Promise<string | null> =>
    ipcRenderer.invoke(CHANNELS.appIcon, appName),
  // Resolve a URL's site favicon → cached PNG abs-path (or null when the URL has
  // no host, or the fetch failed/timed out). Same mediaUrl() pairing as appIcon.
  favicon: (url: string): Promise<string | null> => ipcRenderer.invoke(CHANNELS.favicon, url),
  linkPreview: (url: string): Promise<import('../shared/types').LinkPreview | null> =>
    ipcRenderer.invoke(CHANNELS.linkPreview, url),
  // Normalized peak envelope (0..1) for a capture's audio — drives the Media
  // Library waveform scrubber. Empty array = no audio / decode failed.
  mediaWaveform: (mediaPath: string): Promise<number[]> =>
    ipcRenderer.invoke(CHANNELS.mediaWaveform, mediaPath),
  // Ask a question about the media library; returns a ranked + cited LLM answer.
  mediaChatWith: (question: string): Promise<import('../shared/types').MediaChatResult> =>
    ipcRenderer.invoke(CHANNELS.mediaChatWith, {
      question
    } as import('../shared/types').MediaChatPayload),
  // Opt-in toggle: include the user's own macOS screenshots/recordings in the library.
  mediaGetOsScreenshots: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mediaGetOsScreenshots),
  mediaSetOsScreenshots: (on: boolean): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.mediaSetOsScreenshots, on),

  // ── Mighty (standing personal agent) ────────────────────────────────────────
  mighty: {
    // startFresh: expand from an empty panel → open Mighty on a new empty chat.
    // sessionId: expand from a live panel conversation already bound to a session
    // (set as soon as its first ask-mode run started) → open Mighty on it directly.
    open: (startFresh?: boolean, sessionId?: string) =>
      ipcRenderer.invoke(CHANNELS.openMightyWindow, startFresh, sessionId),
    openCode: (codeTab?: CodeTab) => ipcRenderer.invoke(CHANNELS.openMightyCode, codeTab),
    // One chat turn. Resolves with reply + the session it landed in + new artifacts.
    chat: (
      message: string,
      sessionId?: string,
      attachments?: import('../shared/types').MediaAttachment[],
      projectId?: string,
      backend?: import('../shared/types').BackendId,
      clientRunId?: string
    ): Promise<import('../shared/types').MightyChatResult> =>
      ipcRenderer.invoke(CHANNELS.mightyChat, {
        message,
        sessionId,
        attachments,
        projectId,
        backend,
        clientRunId
      } as import('../shared/types').MightyChatPayload),
    listSessions: (): Promise<import('../shared/types').MightySession[]> =>
      ipcRenderer.invoke(CHANNELS.mightyListSessions),
    getSession: (id: string): Promise<import('../shared/types').MightySession | null> =>
      ipcRenderer.invoke(CHANNELS.mightyGetSession, id),
    runTerminal: (sessionId: string): Promise<string> => ipcRenderer.invoke(CHANNELS.mightyRunTerminal, sessionId),
    newSession: (projectId?: string): Promise<import('../shared/types').MightySession> =>
      ipcRenderer.invoke(CHANNELS.mightyNewSession, projectId),
    deleteSession: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightyDeleteSession, id),
    listProjects: (): Promise<import('../shared/types').MightyProject[]> =>
      ipcRenderer.invoke(CHANNELS.mightyListProjects),
    upsertProject: (
      project: import('../shared/types').MightyProject
    ): Promise<import('../shared/types').MightyProject | null> =>
      ipcRenderer.invoke(CHANNELS.mightyUpsertProject, project),
    deleteProject: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightyDeleteProject, id),
    assignSessionProject: (sessionId: string, projectId?: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightyAssignSessionProject, sessionId, projectId),
    pickProjectFolder: (
      known?: string
    ): Promise<import('../shared/types').ProjectRepoLink | null> =>
      ipcRenderer.invoke(CHANNELS.mightyPickProjectFolder, known),
    scanProjectFolder: (
      known?: string
    ): Promise<import('../shared/types').ProjectFolderScan | null> =>
      ipcRenderer.invoke(CHANNELS.mightyScanProjectFolder, known),
    makeProjectFolder: (name: string): Promise<import('../shared/types').ProjectRepoLink> =>
      ipcRenderer.invoke(CHANNELS.mightyMakeProjectFolder, name),
    foundProjects: (): Promise<import('../shared/types').ProjectFolderScan[]> =>
      ipcRenderer.invoke(CHANNELS.mightyFoundProjects),
    importProjects: (scans: import('../shared/types').ProjectFolderScan[]): Promise<number> =>
      ipcRenderer.invoke(CHANNELS.mightyImportProjects, scans),
    pickProjectImage: (
      projectId: string
    ): Promise<import('../shared/types').MightyProject | null> =>
      ipcRenderer.invoke(CHANNELS.mightyPickProjectImage, projectId),
    clearProjectImage: (
      projectId: string
    ): Promise<import('../shared/types').MightyProject | null> =>
      ipcRenderer.invoke(CHANNELS.mightyClearProjectImage, projectId),
    discoverProjectImages: (): Promise<number> =>
      ipcRenderer.invoke(CHANNELS.mightyDiscoverProjectImages),
    setSessionBackend: (
      sessionId: string,
      backend: import('../shared/types').BackendId
    ): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightySetSessionBackend, sessionId, backend),
    setSessionPinned: (sessionId: string, pinned: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightySetSessionPinned, sessionId, pinned),
    setSessionTitle: (sessionId: string, title: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightySetSessionTitle, sessionId, title),
    setSessionArchived: (sessionId: string, archived: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightySetSessionArchived, sessionId, archived),
    setProjectPinned: (projectId: string, pinned: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightySetProjectPinned, projectId, pinned),
    truncateLastTurn: (
      sessionId: string
    ): Promise<import('../shared/types').MightySession | null> =>
      ipcRenderer.invoke(CHANNELS.mightyTruncateLastTurn, sessionId),
    exportSession: (
      sessionId: string,
      format: import('../shared/types').MightyExportFormat
    ): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightyExportSession, sessionId, format),
    listJobs: (): Promise<import('../shared/types').MightyJob[]> =>
      ipcRenderer.invoke(CHANNELS.mightyListJobs),
    upsertJob: (job: import('../shared/types').MightyJob): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightyUpsertJob, {
        job
      } as import('../shared/types').MightyUpsertJobPayload),
    deleteJob: (id: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightyDeleteJob, id),
    runJob: (id: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightyRunJob, id),
    listRegistry: (): Promise<import('../shared/types').MightyArtifact[]> =>
      ipcRenderer.invoke(CHANNELS.mightyListRegistry),
    deleteArtifact: (path: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightyDeleteArtifact, path),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke(CHANNELS.mightyReveal, path),
    // Smart open: HTML → in-app viewer, anything else → Finder. Resolves false
    // when the file is missing on disk instead of silently no-op'ing.
    openArtifact: (path: string): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightyOpenArtifact, path),
    getSettings: (): Promise<import('../shared/types').MightySettings> =>
      ipcRenderer.invoke(CHANNELS.mightyGetSettings),
    setSettings: (settings: import('../shared/types').MightySettings): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetSettings, settings),
    getRenderMarkup: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightyGetRenderMarkup),
    setRenderMarkup: (on: boolean): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetRenderMarkup, on),
    getSpeakReplies: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightyGetSpeakReplies),
    setSpeakReplies: (on: boolean): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetSpeakReplies, on),
    getDetailMode: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightyGetDetailMode),
    setDetailMode: (on: boolean): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetDetailMode, on),
    getZoomLevel: (): Promise<number> => ipcRenderer.invoke(CHANNELS.mightyGetZoomLevel),
    setZoomLevel: (level: number): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetZoomLevel, level),
    // The zoom level changed by ANY route (⌘+/⌘-/⌘0, pinch, or our own setter).
    // Main is the only observer of all of them, so the indicator listens here.
    onZoomChanged: (callback: (level: number) => void): (() => void) => {
      const handler = (_: unknown, level: number): void => callback(level)
      ipcRenderer.on(CHANNELS.mightyZoomChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.mightyZoomChanged, handler)
    },
    onZoomKey: (callback: (key: ZoomKey) => void): (() => void) => {
      const handler = (_: unknown, key: ZoomKey): void => callback(key)
      ipcRenderer.on(CHANNELS.mightyZoomKey, handler)
      return () => ipcRenderer.removeListener(CHANNELS.mightyZoomKey, handler)
    },
    getSidebarWidth: (): Promise<number> => ipcRenderer.invoke(CHANNELS.mightyGetSidebarWidth),
    setSidebarWidth: (width: number): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetSidebarWidth, width),
    getSidebarShown: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightyGetSidebarShown),
    setSidebarShown: (on: boolean): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetSidebarShown, on),
    setLastMode: (mode: 'all' | 'chat' | 'code'): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetLastMode, mode),
    setLastCodeSession: (ref: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetLastCodeSession, ref),
    getContextRailShown: (): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.mightyGetContextRailShown),
    setContextRailShown: (on: boolean): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetContextRailShown, on),
    getWorkspaces: (): Promise<import('../shared/types').ChatWorkspaceTab[]> =>
      ipcRenderer.invoke(CHANNELS.mightyGetWorkspaces),
    setWorkspaces: (tabs: import('../shared/types').ChatWorkspaceTab[]): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightySetWorkspaces, tabs),
    revealSource: (path: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.mightyRevealSource, path),
    openWorkspace: (): Promise<void> => ipcRenderer.invoke(CHANNELS.mightyOpenWorkspace),
    // Bring the compact floating panel forward (the "back to panel" button).
    showPanel: (): Promise<void> => ipcRenderer.invoke(CHANNELS.mightyShowPanel),
    stopRun: (runId: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.mightyStopRun, runId),
    hide: (): Promise<void> => ipcRenderer.invoke(CHANNELS.mightyHide),
    // Subscribe to live-activity phases during a chat run. Returns an unsubscribe fn.
    onPhase: (
      callback: (payload: import('../shared/types').MightyPhasePayload) => void
    ): (() => void) => {
      const handler = (_: unknown, payload: import('../shared/types').MightyPhasePayload): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.mightyPhase, handler)
      return () => ipcRenderer.removeListener(CHANNELS.mightyPhase, handler)
    },
    // Subscribe to rich transcript events (tool calls, thinking, text chunks) during
    // a chat run — same RunEvent union the Run Transcript Inspector consumes.
    onEvent: (
      callback: (payload: import('../shared/types').MightyEventPayload) => void
    ): (() => void) => {
      const handler = (_: unknown, payload: import('../shared/types').MightyEventPayload): void =>
        callback(payload)
      ipcRenderer.on(CHANNELS.mightyEvent, handler)
      return () => ipcRenderer.removeListener(CHANNELS.mightyEvent, handler)
    },
    // Expand-from-empty-panel into an already-open Mighty window → start a new chat.
    onStartFresh: (callback: (projectId?: string) => void): (() => void) => {
      const handler = (_: unknown, projectId?: string): void => callback(projectId)
      ipcRenderer.on(CHANNELS.mightyStartFresh, handler)
      return () => ipcRenderer.removeListener(CHANNELS.mightyStartFresh, handler)
    },
    // Panel handoff into an already-open Mighty window → switch to this session id.
    onOpenSession: (callback: (sessionId: string) => void): (() => void) => {
      const handler = (_: unknown, sessionId: string): void => callback(sessionId)
      ipcRenderer.on(CHANNELS.mightyOpenSession, handler)
      return () => ipcRenderer.removeListener(CHANNELS.mightyOpenSession, handler)
    },
    // A turn was appended to a Mighty session (live ask-mode answer, or a resolved
    // handoff) — re-fetch if the receiving window is bound to that session.
    onTurnAppended: (
      callback: (payload: import('../shared/types').MightyTurnAppendedPayload) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        payload: import('../shared/types').MightyTurnAppendedPayload
      ): void => callback(payload)
      ipcRenderer.on(CHANNELS.mightyTurnAppended, handler)
      return () => ipcRenderer.removeListener(CHANNELS.mightyTurnAppended, handler)
    },
    onProjectsChanged: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on(CHANNELS.mightyProjectsChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.mightyProjectsChanged, handler)
    }
  },
  navigator: {
    run: (targetId: string) => ipcRenderer.invoke(CHANNELS.navigatorRun, targetId),
    close: () => ipcRenderer.invoke(CHANNELS.navigatorClose),
    search: (query: string, refs: import('../shared/navigator-targets').NavigatorSearchRef[]) =>
      ipcRenderer.invoke(CHANNELS.navigatorSearch, query, refs)
  },
  analyticsRequest: (range: string) => ipcRenderer.invoke(CHANNELS.analyticsRequest, range),
  analyticsInsight: (range: string) => ipcRenderer.invoke(CHANNELS.analyticsInsight, range),
  analyticsInitialRange: () => ipcRenderer.invoke(CHANNELS.analyticsInitialRange),
  openPath: (dir: string) => ipcRenderer.invoke(CHANNELS.openPath, dir),
  openMedia: (file: string) => ipcRenderer.invoke(CHANNELS.openMedia, file),
  openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  linkMenu: (url: string, canOpenHere: boolean) =>
    ipcRenderer.invoke(CHANNELS.linkMenu, url, canOpenHere),
  nativeMenu: (items: NativeMenuItem[]) => ipcRenderer.invoke(CHANNELS.nativeMenu, items),
  settingsSave: (patch: SettingsPatch) => ipcRenderer.invoke(CHANNELS.settingsSave, patch),
  settingsDownloadModel: (modelName?: string) =>
    ipcRenderer.invoke(CHANNELS.settingsDownloadModel, modelName),
  settingsInstallWhisper: () => ipcRenderer.invoke(CHANNELS.settingsInstallWhisper),
  settingsInstallFfmpeg: () => ipcRenderer.invoke(CHANNELS.settingsInstallFfmpeg),
  settingsGetPrefs: () => ipcRenderer.invoke(CHANNELS.settingsGetPrefs),
  settingsSetCursor: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetCursor, on),
  settingsSetCursorStyle: (style: string) =>
    ipcRenderer.invoke(CHANNELS.settingsSetCursorStyle, style),
  settingsSetBackend: (backend: string) => ipcRenderer.invoke(CHANNELS.settingsSetBackend, backend),
  settingsSetMaxRec: (min: number) => ipcRenderer.invoke(CHANNELS.settingsSetMaxRec, min),
  settingsSetSound: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetSound, on),
  settingsSetCaptureHud: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetCaptureHud, on),
  settingsSetListenAutoPaste: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetListenAutoPaste, on),
  settingsSetContextLog: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetContextLog, on),
  settingsSetAgentPhotos: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetAgentPhotos, on),
  settingsSetDecisionCards: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetDecisionCards, on),
  getGlobalInstructions: (): Promise<import('../shared/types').GlobalInstructionsSettings> =>
    ipcRenderer.invoke(CHANNELS.globalInstructionsGet),
  setGlobalInstructions: (
    settings: import('../shared/types').GlobalInstructionsSettings
  ): Promise<void> => ipcRenderer.invoke(CHANNELS.globalInstructionsSet, settings),
  settingsSetRunTranscript: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetRunTranscript, on),
  settingsSetShowTiming: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetShowTiming, on),
  settingsSetDynamicIsland: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetDynamicIsland, on),
  settingsSetSelectionBar: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetSelectionBar, on),
  settingsSetSelectionBarFast: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetSelectionBarFast, on),
  settingsSetDockIcon: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetDockIcon, on),
  settingsSetCompanion: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetCompanion, on),
  settingsSetCompanionRenderer: (renderer: string) =>
    ipcRenderer.invoke(CHANNELS.settingsSetCompanionRenderer, renderer),
  settingsSetCompanionSize: (size: string) =>
    ipcRenderer.invoke(CHANNELS.settingsSetCompanionSize, size),
  settingsSetLiveActs: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetLiveActs, on),
  companionSetInteractive: (interactive: boolean) =>
    ipcRenderer.invoke(CHANNELS.companionSetInteractive, interactive),
  companionSendText: (text: string) => ipcRenderer.send(CHANNELS.companionSendText, text),
  openCompanionWindow: () => ipcRenderer.invoke(CHANNELS.openCompanionWindow),
  closeCompanionWindow: () => ipcRenderer.invoke(CHANNELS.closeCompanionWindow),
  // Phase 0.5 debug/verify stream — see src/shared/companion-debug.ts.
  companionStageEventReport: (event: CompanionStageEvent) =>
    ipcRenderer.send(CHANNELS.companionStageEventReport, event),
  onCompanionStageEvent: (callback: (event: CompanionStageEvent) => void) => {
    const handler = (_: unknown, event: CompanionStageEvent): void => callback(event)
    ipcRenderer.on(CHANNELS.companionStageEvent, handler)
    return () => ipcRenderer.removeListener(CHANNELS.companionStageEvent, handler)
  },
  // Phase 1: one finished VAD segment (WAV bytes) up to main; the transcript +
  // mocked reply come back async via onLiveTurnResult, not a return value here
  // (see CHANNELS.liveTurnSubmit / liveTurnResult in ipc.ts for why).
  liveTurnSubmit: (wavBytes: Uint8Array, echoTail = '') =>
    ipcRenderer.send(CHANNELS.liveTurnSubmit, wavBytes, echoTail),
  liveTurnDraft: (wavBytes: Uint8Array, echoTail = ''): Promise<LiveDraft> =>
    ipcRenderer.invoke(CHANNELS.liveTurnDraft, wavBytes, echoTail),
  // Barge-in: kill the in-flight live run outright — see CHANNELS.companionAbortTurn.
  companionAbortTurn: () => ipcRenderer.send(CHANNELS.companionAbortTurn),
  onLiveTurnResult: (callback: (result: LiveTurnResult) => void) => {
    const handler = (_: unknown, result: LiveTurnResult): void => callback(result)
    ipcRenderer.on(CHANNELS.liveTurnResult, handler)
    return () => ipcRenderer.removeListener(CHANNELS.liveTurnResult, handler)
  },
  hideoutControl: (control: HideoutControl): Promise<HideoutState> => ipcRenderer.invoke(CHANNELS.hideoutControl, control),
  onHideoutState: (callback: (state: HideoutState) => void) => {
    const handler = (_: unknown, state: HideoutState): void => callback(state)
    ipcRenderer.on(CHANNELS.hideoutState, handler)
    return () => ipcRenderer.removeListener(CHANNELS.hideoutState, handler)
  },
  onCompanionMicPaused: (callback: (paused: boolean) => void) => {
    const handler = (_: unknown, paused: boolean): void => callback(paused)
    ipcRenderer.on(CHANNELS.companionMicPaused, handler)
    return () => ipcRenderer.removeListener(CHANNELS.companionMicPaused, handler)
  },
  onCompanionAck: (callback: (clip: { audio: Uint8Array; mimeType: string; text: string; announce?: boolean }) => void) => {
    const handler = (_: unknown, clip: { audio: Uint8Array; mimeType: string; text: string; announce?: boolean }): void => callback(clip)
    ipcRenderer.on(CHANNELS.companionAck, handler)
    return () => ipcRenderer.removeListener(CHANNELS.companionAck, handler)
  },
  // Hands-free dictation host (?window=handsfree). Same fire-and-forget shape
  // as liveTurnSubmit, with no result push back: the transcript is pasted at
  // the cursor by main, so the renderer has nothing to do with it.
  handsFreeSegment: (wavBytes: Uint8Array) => ipcRenderer.send(CHANNELS.handsFreeSegment, wavBytes),
  handsFreeHostState: (state: HandsFreeHostState) =>
    ipcRenderer.send(CHANNELS.handsFreeHostState, state),
  // Phase 3: drag-to-reposition the companion's OS window — see
  // companion-window.ts's moveCompanionWindow doc.
  companionDragMove: (delta: { dx: number; dy: number }) =>
    ipcRenderer.send(CHANNELS.companionDragMove, delta),
  // Dev-only: Playground's act-highlight demo button — see windows.ts's handler.
  devFlashHighlight: (opts?: { sizePx?: number; durationMs?: number }) =>
    ipcRenderer.send(CHANNELS.devFlashHighlight, opts),
  // Dev-only: Playground's agent-cursor demo button — see windows.ts's handler.
  devAgentCursorDemo: () => ipcRenderer.send(CHANNELS.devAgentCursorDemo),
  devUnpinForError: () => ipcRenderer.send(CHANNELS.devUnpinForError),
  // Screen mirror hidden capture window (?window=webrtc-capture) — see
  // src/main/capture/screen-stream.ts for the main-side half of this relay.
  webrtcCaptureReady: () => ipcRenderer.send(CHANNELS.webrtcCaptureReady),
  onWebrtcCaptureStart: (
    callback: (
      sdp: string,
      quality: 'capped' | 'native',
      iceServers: unknown[],
      shareAudio: boolean,
      audioOnly: boolean
    ) => void
  ) => {
    const handler = (
      _: unknown,
      sdp: string,
      quality: 'capped' | 'native',
      iceServers: unknown[],
      shareAudio: boolean,
      audioOnly: boolean
    ): void => callback(sdp, quality, iceServers, shareAudio, audioOnly)
    ipcRenderer.on(CHANNELS.webrtcCaptureStart, handler)
    return () => ipcRenderer.removeListener(CHANNELS.webrtcCaptureStart, handler)
  },
  onWebrtcCapturePcm: (callback: (chunk: ArrayBuffer) => void) => {
    // Electron structured-clones a Buffer across IPC as Uint8Array. Hand the
    // renderer a plain ArrayBuffer slice so the audio path never depends on
    // Node types leaking through the context bridge.
    const handler = (_: unknown, chunk: Uint8Array): void => {
      callback(
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
      )
    }
    ipcRenderer.on(CHANNELS.webrtcCapturePcm, handler)
    return () => ipcRenderer.removeListener(CHANNELS.webrtcCapturePcm, handler)
  },
  onWebrtcCaptureIceCandidate: (
    callback: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
  ) => {
    const handler = (
      _: unknown,
      candidate: string,
      sdpMid: string | null,
      sdpMLineIndex: number | null
    ): void => callback(candidate, sdpMid, sdpMLineIndex)
    ipcRenderer.on(CHANNELS.webrtcCaptureIceCandidate, handler)
    return () => ipcRenderer.removeListener(CHANNELS.webrtcCaptureIceCandidate, handler)
  },
  onWebrtcCaptureStop: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.webrtcCaptureStop, handler)
    return () => ipcRenderer.removeListener(CHANNELS.webrtcCaptureStop, handler)
  },
  onWebrtcCaptureMotion: (callback: (userDriving: boolean, source: UserInputSource) => void) => {
    const handler = (_e: unknown, userDriving: boolean, source: UserInputSource): void =>
      callback(userDriving, source)
    ipcRenderer.on(CHANNELS.webrtcCaptureMotion, handler)
    return () => ipcRenderer.removeListener(CHANNELS.webrtcCaptureMotion, handler)
  },
  webrtcCaptureAnswer: (sdp: string) => ipcRenderer.send(CHANNELS.webrtcCaptureAnswer, sdp),
  webrtcCaptureIceCandidateOut: (
    candidate: string,
    sdpMid: string | null,
    sdpMLineIndex: number | null
  ) => ipcRenderer.send(CHANNELS.webrtcCaptureIceCandidateOut, candidate, sdpMid, sdpMLineIndex),
  webrtcCaptureError: (reason: string) => ipcRenderer.send(CHANNELS.webrtcCaptureError, reason),
  webrtcCaptureStalled: () => ipcRenderer.send(CHANNELS.webrtcCaptureStalled),
  webrtcCaptureRecovered: () => ipcRenderer.send(CHANNELS.webrtcCaptureRecovered),
  webrtcCaptureMicPcm: (chunk: ArrayBuffer) =>
    ipcRenderer.send(CHANNELS.webrtcCaptureMicPcm, new Uint8Array(chunk)),
  onWebrtcCapturePipStart: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.webrtcCapturePipStart, handler)
    return () => ipcRenderer.removeListener(CHANNELS.webrtcCapturePipStart, handler)
  },
  onWebrtcCapturePipStop: (callback: () => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(CHANNELS.webrtcCapturePipStop, handler)
    return () => ipcRenderer.removeListener(CHANNELS.webrtcCapturePipStop, handler)
  },
  webrtcCapturePipConfig: (width: number, height: number, frameRate: number) =>
    ipcRenderer.send(CHANNELS.webrtcCapturePipConfig, width, height, frameRate),
  webrtcCapturePipChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.send(CHANNELS.webrtcCapturePipChunk, new Uint8Array(chunk)),
  webrtcCapturePipEnded: (reason: string) =>
    ipcRenderer.send(CHANNELS.webrtcCapturePipEnded, reason),
  webrtcCapturePipAudioConfig: (sampleRate: number, channels: number) =>
    ipcRenderer.send(CHANNELS.webrtcCapturePipAudioConfig, sampleRate, channels),
  webrtcCapturePipAudioChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.send(CHANNELS.webrtcCapturePipAudioChunk, new Uint8Array(chunk)),
  settingsSetSuggestions: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetSuggestions, on),
  settingsSetClick: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetClick, on),
  settingsSetFnListen: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetFnListen, on),
  settingsSetActHighlight: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetActHighlight, on),
  phoneRemoteSetEnabled: (on: boolean) => ipcRenderer.invoke(CHANNELS.phoneRemoteSetEnabled, on),
  phoneRemoteGetQr: () => ipcRenderer.invoke(CHANNELS.phoneRemoteGetQr),
  agentRelaySetEnabled: (on: boolean) => ipcRenderer.invoke(CHANNELS.agentRelaySetEnabled, on),
  agentRelayGetStatus: () => ipcRenderer.invoke(CHANNELS.agentRelayGetStatus),
  coordinationGet: () => ipcRenderer.invoke(CHANNELS.coordinationGet),
  coordinationAttention: (
    relaySessions: AgentRelaySessionInfo[] | { requestId: string; skip?: string[] }
  ) => ipcRenderer.invoke(CHANNELS.coordinationAttention, relaySessions),
  coordinationSetup: () => ipcRenderer.invoke(CHANNELS.coordinationSetup),
  coordinationSetEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(CHANNELS.coordinationSetEnabled, enabled),
  coordinationRenameProject: (project: string, name: string) =>
    ipcRenderer.invoke(CHANNELS.coordinationRenameProject, project, name),
  agentSessionMark: (session: AgentRelaySessionInfo, change: import('../shared/types').SessionMark) =>
    ipcRenderer.send(CHANNELS.agentSessionMark, session, change),
  agentSessionImport: (entries: unknown) => ipcRenderer.send(CHANNELS.agentSessionImport, entries),
  coordinationArchiveProject: (project: string, archived: boolean) =>
    ipcRenderer.invoke(CHANNELS.coordinationArchiveProject, project, archived),
  factoryMaterials: (request: import('../shared/factory').FactoryMaterialRequest) =>
    ipcRenderer.invoke(CHANNELS.factoryMaterials, request),
  factoryGet: () => ipcRenderer.invoke(CHANNELS.factoryGet),
  factorySetup: (body: {
    mightyId: string
    name: string
    repoRoot: string
    integrationRef?: string
    checkCommands?: string[]
    projectId?: string
  }) => ipcRenderer.invoke(CHANNELS.factorySetup, body),
  factorySeed: (body: {
    projectId: string
    source: 'write' | 'brief' | 'audit'
    goal?: string
    text?: string
    paths?: string[]
    drafts?: {
      title: string
      outcome: string
      acceptance: string[]
      scope: string[]
      dependsOn: string[]
      sourceFile: string
      oversized: boolean
      area?: string
    }[]
  }) => ipcRenderer.invoke(CHANNELS.factorySeed, body),
  factoryApprove: (body: { projectId: string; taskIds: string[] }) =>
    ipcRenderer.invoke(CHANNELS.factoryApprove, body),
  factoryPause: (body: { projectId: string | null; paused: boolean }) =>
    ipcRenderer.invoke(CHANNELS.factoryPause, body),
  factoryCancel: (taskId: string) => ipcRenderer.invoke(CHANNELS.factoryCancel, taskId),
  factoryRestore: (taskId: string) => ipcRenderer.invoke(CHANNELS.factoryRestore, taskId),
  factoryPark: (body: { taskId: string; parked: boolean }) =>
    ipcRenderer.invoke(CHANNELS.factoryPark, body),
  factoryPriority: (body: { projectId: string; priority: number }) =>
    ipcRenderer.invoke(CHANNELS.factoryPriority, body),
  factoryDraft: (body: {
    action: 'edit' | 'reject' | 'split' | 'reorder'
    taskId: string
    title?: string
    outcome?: string
    acceptance?: { text: string; command: string }[]
    scope?: string[]
    dependsOn?: string[]
    priority?: number
    area?: string
    kind?: string
  }) => ipcRenderer.invoke(CHANNELS.factoryDraft, body),
  factoryRetry: (taskId: string, options?: { note?: string; rebuild?: boolean }) =>
    ipcRenderer.invoke(CHANNELS.factoryRetry, taskId, options),
  factoryReconcile: () => ipcRenderer.invoke(CHANNELS.factoryReconcile),
  factoryMerge: (taskId: string) => ipcRenderer.invoke(CHANNELS.factoryMerge, taskId),
  factoryTranscript: (attemptId: string, reveal?: boolean) =>
    ipcRenderer.invoke(CHANNELS.factoryTranscript, attemptId, reveal),
  factoryArtifact: (evidenceId: string) => ipcRenderer.invoke(CHANNELS.factoryArtifact, evidenceId),
  factoryLimits: (body: {
    projectId?: string
    tasksAtOnce?: number
    globalSlots?: number
    repairs?: number
    stopAfter?: number | null
    models?: Partial<import('../shared/factory').FactoryModels>
  }) => ipcRenderer.invoke(CHANNELS.factoryLimits, body),
  factoryCodeSize: (projectId: string) => ipcRenderer.invoke(CHANNELS.factoryCodeSize, projectId),
  agentRelayGetPushFilter: () => ipcRenderer.invoke(CHANNELS.agentRelayGetPushFilter),
  agentRelaySetPushFilter: (verb: RelayVerbWire, on: boolean) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySetPushFilter, verb, on),
  agentRelaySetNotifyLevel: (level: RelayNotifyPushLevel) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySetNotifyLevel, level),
  agentRelayGetMacAlerts: () => ipcRenderer.invoke(CHANNELS.agentRelayGetMacAlerts),
  agentRelaySetMacAlerts: (next: RelayMacAlertSettings) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySetMacAlerts, next),
  agentRelaySetTurnEndPing: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySetTurnEndPing, on),
  agentRelaySendTest: () => ipcRenderer.invoke(CHANNELS.agentRelaySendTest),
  agentRelayListClients: () => ipcRenderer.invoke(CHANNELS.agentRelayListClients),
  agentRelayConfigureClient: (id: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelayConfigureClient, id),
  agentRelayGetRequests: () => ipcRenderer.invoke(CHANNELS.agentRelayGetRequests),
  agentRelayRespond: (requestId: string, response: RelayResponseWire) =>
    ipcRenderer.invoke(CHANNELS.agentRelayRespond, requestId, response),
  agentRelayUndismiss: (requestId: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelayUndismiss, requestId),
  agentRelayRevealSession: (label: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelayRevealSession, label),
  agentRelaySuggest: (label: string, context: string, said?: string, fresh?: boolean) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySuggest, label, context, said, fresh),
  agentRelaySessionReply: (
    label: string,
    text: string,
    paths?: string[],
    expected?: import('../shared/types').AgentTranscriptTurn,
    page?: { url: string; title: string }
  ) => ipcRenderer.invoke(CHANNELS.agentRelaySessionReply, label, text, paths, expected, page),
  agentRelaySessionBtw: (label: string, question: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySessionBtw, label, question),
  agentRelaySessionSent: (label: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySessionSent, label),
  repoGitState: (ref: string) => ipcRenderer.invoke(CHANNELS.repoGitState, ref),
  pulseState: (ref: string) => ipcRenderer.invoke(CHANNELS.pulseState, ref),
  pulseFresh: (sessionIds: string[]) => ipcRenderer.invoke(CHANNELS.pulseFresh, sessionIds),
  pulseSetEnabled: (on: boolean) => ipcRenderer.invoke(CHANNELS.pulseSetEnabled, on),
  pulseSetScope: (ref: string, scope: PulseScope) => ipcRenderer.invoke(CHANNELS.pulseSetScope, ref, scope),
  pulseScoreNow: (ref: string, force?: boolean) => ipcRenderer.invoke(CHANNELS.pulseScoreNow, ref, force),
  onPulseChanged: (callback: (sessionId: string) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, sessionId: string): void => callback(sessionId)
    ipcRenderer.on(CHANNELS.pulseChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.pulseChanged, handler)
  },
  repoGitPush: (ref: string) => ipcRenderer.invoke(CHANNELS.repoGitPush, ref),
  repoGitChanges: (ref: string, scope?: import('../shared/types').ChangeScope) => ipcRenderer.invoke(CHANNELS.repoGitChanges, ref, scope),
  repoGitPull: (ref: string) => ipcRenderer.invoke(CHANNELS.repoGitPull, ref),
  repoGitOpenPull: (ref: string) => ipcRenderer.invoke(CHANNELS.repoGitOpenPull, ref),
  repoGitMerge: (ref: string) => ipcRenderer.invoke(CHANNELS.repoGitMerge, ref),
  repoTurnUndo: (ref: string, turnAt: number) => ipcRenderer.invoke(CHANNELS.repoTurnUndo, ref, turnAt),
  agentRelaySessionTranscript: (ref: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySessionTranscript, ref),
  agentRelaySessionChecklist: (ref: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySessionChecklist, ref),
  agentRelaySessionHelpers: (ref: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySessionHelpers, ref),
  agentRelaySessionTools: (ref: string) => ipcRenderer.invoke(CHANNELS.agentRelaySessionTools, ref),
  agentRelaySessionAffects: (ref: string) => ipcRenderer.invoke(CHANNELS.agentRelaySessionAffects, ref),
  agentRelaySessionUsage: (ref: string) => ipcRenderer.invoke(CHANNELS.agentRelaySessionUsage, ref),
  mcp: {
    list: (cwd: string) => ipcRenderer.invoke(CHANNELS.mcpList, cwd),
    health: (cwd: string, fresh?: boolean) => ipcRenderer.invoke(CHANNELS.mcpHealth, cwd, fresh),
    save: (req: import('../shared/types').McpSaveRequest) => ipcRenderer.invoke(CHANNELS.mcpSave, req),
    remove: (cwd: string, name: string, scope: import('../shared/types').McpScope) =>
      ipcRenderer.invoke(CHANNELS.mcpRemove, cwd, name, scope),
    login: (cwd: string, name: string) => ipcRenderer.invoke(CHANNELS.mcpLogin, cwd, name),
    openClaudeConnectors: () => ipcRenderer.invoke(CHANNELS.mcpOpenClaudeConnectors)
  },
  agentRelaySessionScreen: (ref: string, back?: number) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySessionScreen, ref, back),
  agentRelaySessionKeys: (ref: string, keys: ({ text: string } | { key: string } | { paste: string })[]) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySessionKeys, ref, keys),
  agentRelaySessionFit: (ref: string, cols: number, rows: number) =>
    ipcRenderer.invoke(CHANNELS.agentRelaySessionFit, ref, cols, rows),
  agentRelaySessionWatch: (ref: string) => ipcRenderer.invoke(CHANNELS.agentRelaySessionWatch, ref),
  agentRelaySessionUnwatch: (ref: string) => ipcRenderer.invoke(CHANNELS.agentRelaySessionUnwatch, ref),
  onAgentRelaySessionScreenChanged: (cb: (ref: string) => void) => {
    const handler = (_e: unknown, ref: string): void => cb(ref)
    ipcRenderer.on(CHANNELS.agentRelaySessionScreenChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.agentRelaySessionScreenChanged, handler)
  },
  agentRelayWrapSession: (label: string) =>
    ipcRenderer.invoke(CHANNELS.agentRelayWrapSession, label),
  codeStartAgent: (input: {
    project: string
    cwd: string
    harness?: 'claude' | 'codex' | 'opencode' | 'cursor' | 'ollama' | 'tmux'
    inApp?: boolean
    message?: string
    paths?: string[]
    model?: string
    resume?: string
    think?: boolean
    effort?: ReasoningEffort
    plan?: boolean
  }) => ipcRenderer.invoke(CHANNELS.codeStartAgent, input),
  codeRouteTask: (task: string, sessions: { ref: string; title: string; recap?: string }[]) =>
    ipcRenderer.invoke(CHANNELS.codeRouteTask, task, sessions),
  codeConductorWorkspaces: () => ipcRenderer.invoke(CHANNELS.codeConductorWorkspaces),
  codeContinueConductor: (id: string) => ipcRenderer.invoke(CHANNELS.codeContinueConductor, id),
  codeProjectIdeas: (input: {
    cwd: string
    name: string
    titles: string[]
    mode: 'cached' | 'generate' | 'refresh'
  }) => ipcRenderer.invoke(CHANNELS.codeProjectIdeas, input),
  codeProjectIdeaFeedback: (input: {
    cwd: string
    label: string
    why?: string
    verdict: 'done' | 'bad' | null
  }) => ipcRenderer.invoke(CHANNELS.codeProjectIdeaFeedback, input),
  codeAgentModels: () => ipcRenderer.invoke(CHANNELS.codeAgentModels),
  codeSetAgentModel: (choice: AgentModelChoice) =>
    ipcRenderer.invoke(CHANNELS.codeSetAgentModel, choice),
  chatModelPicks: () => ipcRenderer.invoke(CHANNELS.chatModelPicks),
  chatSetModelPick: (backend: 'opencode' | 'openrouter' | 'claude' | 'codex', model: string) =>
    ipcRenderer.invoke(CHANNELS.chatSetModelPick, backend, model),
  chatSourceModels: () => ipcRenderer.invoke(CHANNELS.chatSourceModels),
  codeSetUpAgentProvider: (harness: AgentModelChoice['harness']) =>
    ipcRenderer.invoke(CHANNELS.codeSetUpAgentProvider, harness),
  onAgentSetupProgress: (callback: (payload: AgentSetupProgress) => void): (() => void) => {
    const handler = (_: unknown, payload: AgentSetupProgress): void => callback(payload)
    ipcRenderer.on(CHANNELS.codeAgentSetupProgress, handler)
    return () => ipcRenderer.removeListener(CHANNELS.codeAgentSetupProgress, handler)
  },
  onAgentRelayStatusChanged: (callback: (status: AgentRelayStatus) => void) => {
    const handler = (_e: unknown, status: AgentRelayStatus): void => callback(status)
    ipcRenderer.on(CHANNELS.agentRelayStatusChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.agentRelayStatusChanged, handler)
  },
  onAgentRelayPushFilterChanged: (callback: (settings: RelayPushSettings) => void) => {
    const handler = (_e: unknown, settings: RelayPushSettings): void => callback(settings)
    ipcRenderer.on(CHANNELS.agentRelayPushFilterChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.agentRelayPushFilterChanged, handler)
  },
  onAgentRelayRequestsChanged: (callback: (snapshot: RelaySnapshotWire) => void) => {
    const handler = (_: unknown, snapshot: RelaySnapshotWire): void => callback(snapshot)
    ipcRenderer.on(CHANNELS.agentRelayRequestsChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.agentRelayRequestsChanged, handler)
  },
  onPhoneRemoteStatus: (callback: (status: { connected: boolean }) => void) => {
    const handler = (_: unknown, status: { connected: boolean }): void => callback(status)
    ipcRenderer.on(CHANNELS.phoneRemoteStatus, handler)
    return () => ipcRenderer.removeListener(CHANNELS.phoneRemoteStatus, handler)
  },
  phoneRemoteGetSensitivity: () => ipcRenderer.invoke(CHANNELS.phoneRemoteGetSensitivity),
  phoneRemoteSetSensitivity: (value: number) =>
    ipcRenderer.invoke(CHANNELS.phoneRemoteSetSensitivity, value),
  phoneRemoteGetPairCode: (opts?: PhoneRemoteGetPairCodeOpts) =>
    ipcRenderer.invoke(CHANNELS.phoneRemoteGetPairCode, opts),
  phoneRemoteForgetDevices: () => ipcRenderer.invoke(CHANNELS.phoneRemoteForgetDevices),
  phoneRemoteListDevices: () => ipcRenderer.invoke(CHANNELS.phoneRemoteListDevices),
  phoneRemoteRevokeDevice: (deviceId: string) =>
    ipcRenderer.invoke(CHANNELS.phoneRemoteRevokeDevice, deviceId),
  onPhoneRemoteDevicesChanged: (callback: (payload: PhoneRemoteDevicesChanged) => void) => {
    const handler = (_: unknown, payload: PhoneRemoteDevicesChanged): void => callback(payload)
    ipcRenderer.on(CHANNELS.phoneRemoteDevicesChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.phoneRemoteDevicesChanged, handler)
  },
  phoneRemoteGetTunnel: () => ipcRenderer.invoke(CHANNELS.phoneRemoteGetTunnel),
  phoneRemoteSetTunnelEnabled: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.phoneRemoteSetTunnelEnabled, on),
  phoneRemoteGetExtendedScreen: () => ipcRenderer.invoke(CHANNELS.phoneRemoteGetExtendedScreen),
  phoneRemoteClearExtendedScreen: () => ipcRenderer.invoke(CHANNELS.phoneRemoteClearExtendedScreen),
  phoneRemoteSetStayAwake: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.phoneRemoteSetStayAwake, on),
  phoneRemoteSetClamshell: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.phoneRemoteSetClamshell, on),
  phoneRemoteSetAwayMode: (on: boolean) => ipcRenderer.invoke(CHANNELS.phoneRemoteSetAwayMode, on),
  phoneRemoteToggleCoverNow: () => ipcRenderer.invoke(CHANNELS.phoneRemoteToggleCoverNow),
  onPhoneRemoteAwayState: (callback: (active: boolean) => void) => {
    const handler = (_: unknown, active: boolean): void => callback(active)
    ipcRenderer.on(CHANNELS.phoneRemoteAwayState, handler)
    return () => ipcRenderer.removeListener(CHANNELS.phoneRemoteAwayState, handler)
  },
  onPhoneRemoteTunnelStatus: (callback: (status: PhoneRemoteTunnelStatus) => void) => {
    const handler = (_: unknown, status: PhoneRemoteTunnelStatus): void => callback(status)
    ipcRenderer.on(CHANNELS.phoneRemoteTunnelStatus, handler)
    return () => ipcRenderer.removeListener(CHANNELS.phoneRemoteTunnelStatus, handler)
  },
  settingsSetFeedback: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetFeedback, on),
  settingsSetHistoryEncryption: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetHistoryEncryption, on),
  settingsSetHistoryFilter: (hidden: string[]) =>
    ipcRenderer.invoke(CHANNELS.settingsSetHistoryFilter, hidden),
  settingsSetMightySourceFilter: (hidden: string[]) =>
    ipcRenderer.invoke(CHANNELS.settingsSetMightySourceFilter, hidden),
  settingsSetMightyShowEmpty: (show: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetMightyShowEmpty, show),
  settingsSetIncognito: (on: boolean) => ipcRenderer.invoke(CHANNELS.settingsSetIncognito, on),
  settingsClearHistory: () => ipcRenderer.invoke(CHANNELS.settingsClearHistory),
  settingsTestBackend: (backend: string) =>
    ipcRenderer.invoke(CHANNELS.settingsTestBackend, backend),
  settingsBackendProbes: () => ipcRenderer.invoke(CHANNELS.settingsBackendProbes),
  settingsDisconnectBackend: (backend: string) =>
    ipcRenderer.invoke(CHANNELS.settingsDisconnectBackend, backend),
  planLoginsList: () => ipcRenderer.invoke(CHANNELS.planLoginsList),
  planLoginsCheck: () => ipcRenderer.invoke(CHANNELS.planLoginsCheck),
  planLoginsAdd: (backend: PlanBackend) => ipcRenderer.invoke(CHANNELS.planLoginsAdd, backend),
  planLoginsCancel: () => ipcRenderer.invoke(CHANNELS.planLoginsCancel),
  planLoginsRemove: (id: string) => ipcRenderer.invoke(CHANNELS.planLoginsRemove, id),
  planLoginPicks: () => ipcRenderer.invoke(CHANNELS.planLoginPicks),
  planLoginSetPick: (backend: PlanBackend, id: string) => ipcRenderer.invoke(CHANNELS.planLoginSetPick, backend, id),
  panelProbeBackend: () => ipcRenderer.invoke(CHANNELS.panelProbeBackend),
  panelChecklistSeenDone: () => ipcRenderer.send(CHANNELS.panelChecklistSeenDone),
  settingsSetOllamaModel: (model: string) =>
    ipcRenderer.invoke(CHANNELS.settingsSetOllamaModel, model),
  settingsSetThinkingEnabled: (on: boolean) =>
    ipcRenderer.invoke(CHANNELS.settingsSetThinkingEnabled, on),
  settingsListLocalModels: () => ipcRenderer.invoke(CHANNELS.settingsListLocalModels),
  settingsSetMlxModel: (model: string) => ipcRenderer.invoke(CHANNELS.settingsSetMlxModel, model),
  settingsListMlxModels: () => ipcRenderer.invoke(CHANNELS.settingsListMlxModels),
  settingsLocalSetupState: (backend: string) =>
    ipcRenderer.invoke(CHANNELS.settingsLocalSetupState, backend),
  settingsSetUpLocalBackend: (backend: string) =>
    ipcRenderer.invoke(CHANNELS.settingsSetUpLocalBackend, backend),
  // Live progress while the setup runs. Plain-English lines only.
  onLocalSetupProgress: (callback: (payload: LocalSetupProgress) => void): (() => void) => {
    const handler = (_: unknown, payload: LocalSetupProgress): void => callback(payload)
    ipcRenderer.on(CHANNELS.settingsLocalSetupProgress, handler)
    return () => ipcRenderer.removeListener(CHANNELS.settingsLocalSetupProgress, handler)
  },
  panelSetSelectedModel: (model: string) =>
    ipcRenderer.invoke(CHANNELS.panelSetSelectedModel, model),

  // Onboarding (permissions wizard)
  tour: {
    complete: () => ipcRenderer.invoke(CHANNELS.tourComplete),
    skip: () => ipcRenderer.invoke(CHANNELS.tourSkip),
    // Press-to-confirm probe (see tour-hotkey-probe.ts). Fire-and-forget `send`,
    // not `invoke` — arming is a state write, not a request/response call.
    armProbe: (shortcutId: ShortcutId | null) =>
      ipcRenderer.send(CHANNELS.tourProbeArm, { shortcutId }),
    onProbeEvent: (callback: (payload: TourProbeEventPayload) => void) => {
      const handler = (_: unknown, payload: TourProbeEventPayload): void => callback(payload)
      ipcRenderer.on(CHANNELS.tourProbeEvent, handler)
      return () => ipcRenderer.removeListener(CHANNELS.tourProbeEvent, handler)
    },
    // §7.3 dev-only mock confirm — see ftue-replay.ts's mockConfirmTourStep.
    mockConfirm: () => ipcRenderer.send(CHANNELS.tourMockConfirm),
    // Dev-only chord simulator — see mockTourMods in ftue-replay.ts.
    mockMods: (down: boolean) => ipcRenderer.send(CHANNELS.tourMockMods, { down })
  },
  onboarding: {
    getChecks: () => ipcRenderer.invoke(CHANNELS.onboardingGetChecks),
    runSelfTest: (key: string) => ipcRenderer.invoke(CHANNELS.onboardingRunSelfTest, key),
    getBinaries: () => ipcRenderer.invoke(CHANNELS.onboardingGetBinaries),
    complete: (surface: OnboardingSurface) =>
      ipcRenderer.invoke(CHANNELS.onboardingComplete, surface),
    restart: () => ipcRenderer.invoke(CHANNELS.onboardingRestart),
    setHeight: (height: number) => ipcRenderer.invoke(CHANNELS.onboardingSetHeight, height),
    revealApp: () => ipcRenderer.invoke(CHANNELS.onboardingRevealApp),
    exitMock: () => ipcRenderer.invoke(CHANNELS.onboardingExitMock)
  },

  // Drag-to-add coach — the floating panel that explains the `+` allow-list.
  // Shown by the wizard on Grant; closed by the panel's own Done/Esc.
  dragCoach: {
    show: (key: string) => ipcRenderer.invoke(CHANNELS.dragCoachShow, key),
    close: () => ipcRenderer.invoke(CHANNELS.dragCoachClose),
    // Fire-and-forget: startDrag must run synchronously inside the gesture.
    startDrag: () => ipcRenderer.send(CHANNELS.dragCoachStartDrag)
  },

  // Setup Check — every dependency in one list, a button on every failing row.
  setup: {
    getChecks: (): Promise<SetupCheck[]> => ipcRenderer.invoke(CHANNELS.setupGetChecks),
    runFix: (id: SetupCheckId): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CHANNELS.setupRunFix, id),
    switchBackend: (): Promise<{ ok: boolean; pending?: boolean }> =>
      ipcRenderer.invoke(CHANNELS.setupSwitchBackend),
    open: (): Promise<void> => ipcRenderer.invoke(CHANNELS.setupOpen),
    // Live progress while a fix runs. Main sends only plain-English lines here —
    // raw tool output never crosses this boundary.
    onFixProgress: (callback: (payload: SetupFixProgress) => void) => {
      const handler = (_: unknown, payload: SetupFixProgress): void => callback(payload)
      ipcRenderer.on(CHANNELS.setupFixProgress, handler)
      return () => ipcRenderer.removeListener(CHANNELS.setupFixProgress, handler)
    }
  },

  // Auth (Email OTP) + analytics
  auth: {
    sendCode: (email: string) => ipcRenderer.invoke(CHANNELS.authSendCode, email),
    verifyCode: (email: string, token: string) =>
      ipcRenderer.invoke(CHANNELS.authVerifyCode, { email, token }),
    password: (email: string, password: string) =>
      ipcRenderer.invoke(CHANNELS.authPassword, { email, password }),
    signOut: () => ipcRenderer.invoke(CHANNELS.authSignOut),
    deleteAccount: () => ipcRenderer.invoke(CHANNELS.authDeleteAccount),
    getSession: () => ipcRenderer.invoke(CHANNELS.authGetSession),
    // One-shot: pending email handed off from the landing-page download. Reading
    // clears it in main, so pre-fill only happens once.
    takePendingEmail: (): Promise<string> => ipcRenderer.invoke(CHANNELS.authTakePendingEmail),
    onChange: (callback: (user: { email: string; userId: string } | null) => void) => {
      const handler = (_: unknown, user: Parameters<typeof callback>[0]): void => callback(user)
      ipcRenderer.on(CHANNELS.authChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.authChanged, handler)
    }
  },
  track: <K extends AnalyticsEventName>(
    event: K,
    ...rest: Record<string, never> extends AnalyticsEventProps<K>
      ? [props?: AnalyticsEventProps<K>]
      : [props: AnalyticsEventProps<K>]
  ) => ipcRenderer.send(CHANNELS.track, { event, props: rest[0] || {} }),
  reportError: (report: {
    kind: string
    message: string
    stack?: string | null
    source?: string
    props?: Record<string, unknown>
  }) => ipcRenderer.send(CHANNELS.reportError, report),

  // Admin visibility only — the dashboard itself lives in the web portal.
  admin: {
    isAdmin: () => ipcRenderer.invoke(CHANNELS.adminIsAdmin),
    // Real admin + preview flag together: an admin mid-preview reads as a
    // non-admin everywhere else, so Settings needs both to draw the exit switch.
    getViewAsUser: () => ipcRenderer.invoke(CHANNELS.adminGetViewAsUser),
    setViewAsUser: (on: boolean) => ipcRenderer.invoke(CHANNELS.adminSetViewAsUser, on)
  },

  onModelDownloadProgress: (callback: (payload: { pct: number }) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.modelDownloadProgress, handler)
    return () => ipcRenderer.removeListener(CHANNELS.modelDownloadProgress, handler)
  },

  // Live brew output while ffmpeg/whisper installs — keeps the button honest
  // about what it's doing instead of freezing for minutes.
  onBinaryInstallProgress: (callback: (payload: { key: string; line: string }) => void) => {
    const handler = (_: unknown, payload: Parameters<typeof callback>[0]): void => callback(payload)
    ipcRenderer.on(CHANNELS.binaryInstallProgress, handler)
    return () => ipcRenderer.removeListener(CHANNELS.binaryInstallProgress, handler)
  },

  // Billing (mightymouse backend)
  billingGetBalance: () => ipcRenderer.invoke(CHANNELS.billingGetBalance),
  billingListUsage: (limit?: number) => ipcRenderer.invoke(CHANNELS.billingListUsage, limit),
  billingOpenCheckout: (item: BillingCheckoutItem) =>
    ipcRenderer.invoke(CHANNELS.billingOpenCheckout, item),
  billingOpenPortal: () => ipcRenderer.invoke(CHANNELS.billingOpenPortal),
  billingGetSubscription: (): Promise<SubscriptionStatus | null> =>
    ipcRenderer.invoke(CHANNELS.billingGetSubscription),
  billingGetUsage: (): Promise<UsageMeter | null> => ipcRenderer.invoke(CHANNELS.billingGetUsage),
  billingGetLifetimeOffer: (): Promise<LifetimeOffer | null> =>
    ipcRenderer.invoke(CHANNELS.billingGetLifetimeOffer),
  onBillingBalanceChanged: (callback: (cents: number) => void) => {
    const handler = (_: unknown, cents: number): void => callback(cents)
    ipcRenderer.on(CHANNELS.billingBalanceChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.billingBalanceChanged, handler)
  },
  onBillingCheckoutReturn: (callback: (status: CheckoutReturnStatus) => void) => {
    const handler = (_: unknown, status: CheckoutReturnStatus): void => callback(status)
    ipcRenderer.on(CHANNELS.billingCheckoutReturn, handler)
    return () => ipcRenderer.removeListener(CHANNELS.billingCheckoutReturn, handler)
  },

  keys: {
    scan: (scope: string): Promise<import('../shared/keys').ProjectKeyMap> =>
      ipcRenderer.invoke(CHANNELS.keysScan, scope),
    list: (): Promise<import('../shared/keys').ProjectKeyMap[]> =>
      ipcRenderer.invoke(CHANNELS.keysList),
    set: (
      payload: import('../shared/keys').KeySetPayload
    ): Promise<import('../shared/keys').KeyRecord | null> =>
      ipcRenderer.invoke(CHANNELS.keysSet, payload),
    update: (
      id: string,
      patch: import('../shared/keys').KeyPatch
    ): Promise<import('../shared/keys').KeyRecord | null> =>
      ipcRenderer.invoke(CHANNELS.keysUpdate, id, patch),
    remove: (id: string, deleteValue: boolean): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.keysRemove, id, deleteValue),
    probe: (id: string): Promise<import('../shared/keys').KeyProbeResult> =>
      ipcRenderer.invoke(CHANNELS.keysProbe, id),
    copy: (id: string): Promise<boolean> => ipcRenderer.invoke(CHANNELS.keysCopy, id),
    onChanged: (callback: (maps: import('../shared/keys').ProjectKeyMap[]) => void) => {
      const handler = (_: unknown, maps: import('../shared/keys').ProjectKeyMap[]): void =>
        callback(maps)
      ipcRenderer.on(CHANNELS.keysChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.keysChanged, handler)
    }
  },

  built: {
    list: (): Promise<import('../shared/built').BuiltItem[] | null> => ipcRenderer.invoke(CHANNELS.builtList),
    open: (id: string, how: 'open' | 'reveal'): Promise<boolean> => ipcRenderer.invoke(CHANNELS.builtOpen, id, how),
    hide: (id: string): Promise<import('../shared/built').BuiltItem[]> => ipcRenderer.invoke(CHANNELS.builtHide, id),
    favorite: (id: string, on: boolean): Promise<import('../shared/built').BuiltItem[]> =>
      ipcRenderer.invoke(CHANNELS.builtFavorite, id, on),
    tag: (id: string, tags: string[]): Promise<import('../shared/built').BuiltItem[]> =>
      ipcRenderer.invoke(CHANNELS.builtTag, id, tags),
    stop: (id: string): Promise<import('../shared/built').BuiltRunResult> => ipcRenderer.invoke(CHANNELS.builtStop, id),
    start: (id: string): Promise<import('../shared/built').BuiltRunResult> => ipcRenderer.invoke(CHANNELS.builtStart, id),
    onChanged: (callback: (items: import('../shared/built').BuiltItem[]) => void) => {
      const handler = (_: unknown, items: import('../shared/built').BuiltItem[]): void => callback(items)
      ipcRenderer.on(CHANNELS.builtChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.builtChanged, handler)
    }
  },

  firstRunCode: {
    recentProjects: (): Promise<
      Array<{ folder: string; name: string; updatedAt: string; projectId?: string }>
    > => ipcRenderer.invoke(CHANNELS.firstRunCodeRecentProjects),
    installCommands: (): Promise<{ claude: string; codex: string }> =>
      ipcRenderer.invoke(CHANNELS.firstRunCodeInstallCommands),
    handoff: (input: { cwd: string; project: string; pane: string; message: string }): Promise<boolean> =>
      ipcRenderer.invoke(CHANNELS.firstRunCodeHandoff, input)
  },

  firstRun: {
    finish: (surface: 'first-run'): Promise<void> => ipcRenderer.invoke(CHANNELS.firstRunFinish, surface),
    getFirstBootAtMs: (): Promise<number | null> => ipcRenderer.invoke(CHANNELS.firstRunGetFirstBootAtMs),
    modelReady: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.firstRunModelReady),
    onModelProgress: (callback: (pct: number) => void) => {
      const handler = (_: unknown, pct: number): void => callback(pct)
      ipcRenderer.on(CHANNELS.firstRunModelProgress, handler)
      return () => ipcRenderer.removeListener(CHANNELS.firstRunModelProgress, handler)
    },
    onTranscript: (callback: (text: string) => void) => {
      const handler = (_: unknown, text: string): void => callback(text)
      ipcRenderer.on(CHANNELS.firstRunTranscript, handler)
      return () => ipcRenderer.removeListener(CHANNELS.firstRunTranscript, handler)
    },
    onPhoneMoved: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on(CHANNELS.firstRunPhoneMoved, handler)
      return () => ipcRenderer.removeListener(CHANNELS.firstRunPhoneMoved, handler)
    }
  },

  infra: {
    list: (): Promise<import('../shared/infra').ProjectInfra[]> => ipcRenderer.invoke(CHANNELS.infraList),
    check: (projectId: string): Promise<import('../shared/infra').ProjectInfra> =>
      ipcRenderer.invoke(CHANNELS.infraCheck, projectId),
    add: (projectId: string, kindId: string, name: string): Promise<import('../shared/infra').ProjectInfra> =>
      ipcRenderer.invoke(CHANNELS.infraAdd, projectId, kindId, name),
    remove: (projectId: string, kindId: string, provider: string): Promise<import('../shared/infra').ProjectInfra> =>
      ipcRenderer.invoke(CHANNELS.infraRemove, projectId, kindId, provider),
    skip: (projectId: string, kindId: string, skip: boolean): Promise<import('../shared/infra').ProjectInfra> =>
      ipcRenderer.invoke(CHANNELS.infraSkip, projectId, kindId, skip),
    want: (projectId: string, kindId: string): Promise<import('../shared/infra').ProjectInfra> =>
      ipcRenderer.invoke(CHANNELS.infraWant, projectId, kindId),
    setTags: (
      projectId: string,
      field: import('../shared/infra').TagField,
      values: string[] | null
    ): Promise<import('../shared/infra').ProjectInfra> =>
      ipcRenderer.invoke(CHANNELS.infraTags, projectId, field, values),
    setBrief: (
      projectId: string,
      brief: import('../shared/infra').ProjectBrief
    ): Promise<import('../shared/infra').ProjectInfra> =>
      ipcRenderer.invoke(CHANNELS.infraBrief, projectId, brief),
    draftBrief: (projectId: string): Promise<import('../shared/brief').BriefDraft> =>
      ipcRenderer.invoke(CHANNELS.infraBriefDraft, projectId),
    setup: (
      projectId: string,
      kindId: string,
      setup: { provider: string; pane?: string } | null
    ): Promise<import('../shared/infra').ProjectInfra> => ipcRenderer.invoke(CHANNELS.infraSetup, projectId, kindId, setup),
    site: (projectId: string): Promise<import('../shared/infra').SiteState> =>
      ipcRenderer.invoke(CHANNELS.siteGet, projectId),
    publishSite: (projectId: string, name: string): Promise<import('../shared/infra').SiteState> =>
      ipcRenderer.invoke(CHANNELS.sitePublish, projectId, name),
    unpublishSite: (projectId: string): Promise<import('../shared/infra').SiteState> =>
      ipcRenderer.invoke(CHANNELS.siteUnpublish, projectId),
    onSiteProgress: (callback: (progress: import('../shared/infra').SiteProgress) => void) => {
      const handler = (_: unknown, progress: import('../shared/infra').SiteProgress): void => callback(progress)
      ipcRenderer.on(CHANNELS.siteProgress, handler)
      return () => ipcRenderer.removeListener(CHANNELS.siteProgress, handler)
    },
    onChanged: (callback: (infra: import('../shared/infra').ProjectInfra) => void) => {
      const handler = (_: unknown, infra: import('../shared/infra').ProjectInfra): void => callback(infra)
      ipcRenderer.on(CHANNELS.infraChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.infraChanged, handler)
    }
  },

  reports: {
    get: (projectId: string, range: import('../shared/reports').ReportRange, ifStale?: boolean, env?: string): Promise<import('../shared/reports').ProjectReport> =>
      ipcRenderer.invoke(CHANNELS.reportsGet, projectId, range, ifStale, env),
    refresh: (projectId: string, range: import('../shared/reports').ReportRange, env?: string): Promise<import('../shared/reports').ProjectReport> =>
      ipcRenderer.invoke(CHANNELS.reportsRefresh, projectId, range, env),
    onChanged: (callback: (report: import('../shared/reports').ProjectReport) => void) => {
      const handler = (_: unknown, report: import('../shared/reports').ProjectReport): void => callback(report)
      ipcRenderer.on(CHANNELS.reportsChanged, handler)
      return () => ipcRenderer.removeListener(CHANNELS.reportsChanged, handler)
    }
  },

  resourcesSnapshot: (): Promise<ResourceSnapshot> =>
    ipcRenderer.invoke(CHANNELS.resourcesSnapshot),
  resourcesAsk: (text: string): Promise<void> => ipcRenderer.invoke(CHANNELS.resourcesAsk, text),
  onResourcesAskDraft: (callback: (text: string) => void) => {
    const handler = (_: unknown, text: string): void => callback(text)
    ipcRenderer.on(CHANNELS.resourcesAskDraft, handler)
    return () => ipcRenderer.removeListener(CHANNELS.resourcesAskDraft, handler)
  },
  onResourcesUpdated: (callback: (snapshot: ResourceSnapshot) => void) => {
    const handler = (_: unknown, snapshot: ResourceSnapshot): void => callback(snapshot)
    ipcRenderer.on(CHANNELS.resourcesUpdated, handler)
    return () => ipcRenderer.removeListener(CHANNELS.resourcesUpdated, handler)
  },
  sideBrowser: {
    open: (address: string): Promise<SideBrowserTabState | null> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserOpen, address),
    navigate: (id: string, address: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserNavigate, id, address),
    command: (id: string, cmd: SideBrowserCommand): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserCommand, id, cmd),
    place: (id: string, bounds: SideBrowserBounds | null): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserPlace, id, bounds),
    still: (id: string): Promise<string | null> => ipcRenderer.invoke(CHANNELS.sideBrowserStill, id),
    close: (id: string): Promise<void> => ipcRenderer.invoke(CHANNELS.sideBrowserClose, id),
    permission: (id: string, kind: string, decision: 'allow' | 'block' | 'reset'): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserPermission, id, kind, decision),
    find: (id: string, text: string | null, forward?: boolean): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserFind, id, text, forward),
    stopAgent: (id: string): Promise<void> => ipcRenderer.invoke(CHANNELS.sideBrowserStopAgent, id),
    pauseAgent: (id: string, paused: boolean): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserPauseAgent, id, paused),
    onState: (callback: (state: SideBrowserTabState) => void) => {
      const handler = (_: unknown, state: SideBrowserTabState): void => callback(state)
      ipcRenderer.on(CHANNELS.sideBrowserState, handler)
      return () => ipcRenderer.removeListener(CHANNELS.sideBrowserState, handler)
    },
    onPopup: (callback: (popup: { openerId: string; url: string }) => void) => {
      const handler = (_: unknown, popup: { openerId: string; url: string }): void => callback(popup)
      ipcRenderer.on(CHANNELS.sideBrowserPopup, handler)
      return () => ipcRenderer.removeListener(CHANNELS.sideBrowserPopup, handler)
    },
    onPageAction: (callback: (asked: { viewId: string; url: string; action: import('../shared/types').SideBrowserPageAction }) => void) => {
      const handler = (_: unknown, asked: { viewId: string; url: string; action: import('../shared/types').SideBrowserPageAction }): void => callback(asked)
      ipcRenderer.on(CHANNELS.sideBrowserPageAction, handler)
      return () => ipcRenderer.removeListener(CHANNELS.sideBrowserPageAction, handler)
    },
    onShortcut: (callback: (hit: { viewId: string; shortcut: SideBrowserShortcut }) => void) => {
      const handler = (_: unknown, hit: { viewId: string; shortcut: SideBrowserShortcut }): void => callback(hit)
      ipcRenderer.on(CHANNELS.sideBrowserShortcut, handler)
      return () => ipcRenderer.removeListener(CHANNELS.sideBrowserShortcut, handler)
    },
    onOpenUrl: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on(CHANNELS.sideBrowserOpenUrl, handler)
      return () => ipcRenderer.removeListener(CHANNELS.sideBrowserOpenUrl, handler)
    },
    takeUrl: (): Promise<string | null> => ipcRenderer.invoke(CHANNELS.sideBrowserTakeUrl),
    importSources: (): Promise<SideBrowserImportSource[]> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserImportSources),
    importCookies: (browser: string, profile: string): Promise<SideBrowserImportResult> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserImportCookies, browser, profile),
    suggest: (query: string): Promise<SideBrowserSuggestion[]> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserSuggest, query),
    topSites: (): Promise<SideBrowserSuggestion[]> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserTopSites),
    recent: (): Promise<SideBrowserSuggestion[]> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserRecent),
    forgetRecent: (url: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserForgetRecent, url),
    forgetTopSite: (url: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserForgetTopSite, url),
    annotate: (id: string): Promise<import('../shared/types').SideBrowserAnnotation | null> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserAnnotate, id),
    annotateEnd: (id: string, note: string | null): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.sideBrowserAnnotateEnd, id, note),
    mod: (
      id: string,
      action: import('../shared/types').SiteModAction,
      modId?: string,
      name?: string
    ): Promise<import('../shared/types').SiteModState[]> => ipcRenderer.invoke(CHANNELS.sideBrowserMod, id, action, modId, name),
    sharedMod: (
      id: string,
      request: import('../shared/types').SharedModRequest
    ): Promise<import('../shared/types').SharedModResult> => ipcRenderer.invoke(CHANNELS.sideBrowserSharedMod, id, request),
    runTask: (id: string, req: BrowserTaskRequest): Promise<BrowserTaskResult> =>
      ipcRenderer.invoke(CHANNELS.browserTaskRun, id, req),
    controlTask: (id: string, command: BrowserTaskControl, note?: string): Promise<void> =>
      ipcRenderer.invoke(CHANNELS.browserTaskControl, id, command, note),
    onTaskProgress: (callback: (progress: BrowserTaskProgress) => void) => {
      const handler = (_: unknown, progress: BrowserTaskProgress): void => callback(progress)
      ipcRenderer.on(CHANNELS.browserTaskProgress, handler)
      return () => ipcRenderer.removeListener(CHANNELS.browserTaskProgress, handler)
    },
    taskModels: (): Promise<BrowserTaskModelsState> => ipcRenderer.invoke(CHANNELS.browserTaskModels),
    setTaskModel: (choice: BrowserTaskModel): Promise<BrowserTaskModelsState> =>
      ipcRenderer.invoke(CHANNELS.browserTaskSetModel, choice)
  },

  files: {
    read: (path: string, limit?: number): Promise<FileReadResult> =>
      ipcRenderer.invoke(CHANNELS.filesRead, path, limit),
    write: (path: string, text: string, expectMtimeMs: number): Promise<FileWriteResult> =>
      ipcRenderer.invoke(CHANNELS.filesWrite, path, text, expectMtimeMs),
    list: (root: string): Promise<string[]> => ipcRenderer.invoke(CHANNELS.filesList, root),
    watch: (path: string, callback: () => void) => {
      const handler = (_: unknown, changed: string): void => {
        if (changed === path) callback()
      }
      ipcRenderer.on(CHANNELS.filesChanged, handler)
      void ipcRenderer.invoke(CHANNELS.filesWatch, path, true)
      return () => {
        ipcRenderer.removeListener(CHANNELS.filesChanged, handler)
        void ipcRenderer.invoke(CHANNELS.filesWatch, path, false)
      }
    }
  },

  // Auto-update (electron-updater)
  update: {
    check: () => ipcRenderer.invoke(CHANNELS.updateCheck),
    download: () => ipcRenderer.invoke(CHANNELS.updateDownload),
    install: () => ipcRenderer.invoke(CHANNELS.updateInstall),
    openReleasePage: () => ipcRenderer.invoke(CHANNELS.updateOpenReleasePage),
    getState: () => ipcRenderer.invoke(CHANNELS.updateGetState),
    onStatus: (callback: (payload: UpdateStatusPayload) => void) => {
      const handler = (_: unknown, payload: UpdateStatusPayload): void => callback(payload)
      ipcRenderer.on(CHANNELS.updateStatus, handler)
      return () => ipcRenderer.removeListener(CHANNELS.updateStatus, handler)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
