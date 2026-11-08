import { ElectronAPI } from '@electron-toolkit/preload'
import type { PlanBackend, PlanLogin, PlanLoginPicks, PlanLoginsResult } from '../shared/plan-logins'
import type { ReasoningEffort } from '../shared/model-sources'
import {
  HistoryItem,
  SettingsState,
  SettingsPatch,
  PermissionKey,
  PermissionTest,
  PermissionCheck,
  BackendProbeRecord,
  BackendTestResult,
  BackendHealthWarning,
  SoundName,
  QuickAction,
  BackendId,
  AnalyticsData,
  AnalyticsRange,
  UpdateStatusPayload,
  UsageEvent,
  PanelInitData,
  ActivityPayload,
  SuggestState,
  MediaItem,
  RetranscribeResult,
  CursorFlyTo,
  CursorState,
  MediaChatResult,
  FeedbackRating,
  FeedbackEntry,
  SkillInfo,
  MightyChatResult,
  MightyExportFormat,
  MightySession,
  MightyJob,
  MightyArtifact,
  MightySettings,
  MightyProject,
  ProjectRepoLink,
  ProjectFolderScan,
  MightyPhasePayload,
  MightyEventPayload,
  MightyTurnAppendedPayload,
  MediaAttachment,
  DroppedImage,
  ResumeSessionResult,
  BinaryStatus,
  LocalModel,
  LocalSetupState,
  LocalSetupProgress,
  TranscriptEventPayload,
  BusyPhasePayload,
  CheckoutReturnStatus,
  BillingCheckoutItem,
  SubscriptionStatus,
  LifetimeOffer,
  UpgradeReason,
  ChatWorkspaceTab,
  SettingsSectionFocus,
  HudDonePayload,
  HudUpdatePayload,
  HudInitPayload,
  VoiceRoutePayload,
  VoiceRoutePendingPayload,
  VoiceRouteEnhancePayload,
  VoiceRouteResultPayload,
  VoiceRoutePickPayload,
  VoiceRoutingConfig,
  VoiceRoutingMode,
  ResourceSnapshot,
  SideBrowserBounds,
  SideBrowserCommand,
  SideBrowserShortcut,
  SideBrowserTabState,
  FileReadResult,
  FileWriteResult,
  SideBrowserImportSource,
  SideBrowserImportResult,
  SideBrowserSuggestion,
  BrowserTaskRequest,
  BrowserTaskResult,
  BrowserTaskProgress,
  BrowserTaskControl,
  BrowserTaskModel,
  BrowserTaskModelsState,
  ZoomKey
} from '../shared/types'
import type {
  KeyPatch,
  KeyProbeResult,
  KeyRecord,
  KeySetPayload,
  ProjectKeyMap
} from '../shared/keys'
import type {
  ActionCardPayload,
  ActionResultPayload,
  ActionStepPayload,
  ActionsConfig,
  ActionsConfigPatch
} from '../shared/action-engine'
import type {
  PhoneRemoteTunnelStatus,
  HighlightBoxPayload,
  AgentCursorAction,
  AgentCursorTarget,
  ComputerUseCommand,
  ComputerUseStatus,
  SelectionBarShowPayload,
  SelectionBarResultPayload,
  SelectionBarAction,
  SelectionBarHistoryItem,
  PairedDevice,
  PhoneRemoteDevicesChanged,
  PhoneRemoteGetPairCodeOpts,
  SpeakTextResult,
  UserInputSource,
  AgentRelayStatus,
  AgentRelaySessionInfo,
  McpClientId,
  McpClientState,
  HudRelayAnswerPayload,
  CodeTab,
  CodeTabHandoff,
  StartupPeek,
  ModelCatalogEntry
} from '../shared/types'
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
import type {
  AgentChecklist,
  AgentHelper,
  AgentToolUse,
  AgentModelChoice,
  AgentModelsState,
  AgentSetupProgress,
  AgentTranscriptTurn,
  RecoveredRecordingsState
} from '../shared/types'
import type { CompanionStageEvent } from '../shared/companion-debug'
import type { InkOp } from '../shared/ink'
import type { Suggestion } from '../shared/swipe-suggest'
import type { SupportState } from '../shared/support/types'
import type { LiveDraft, LiveTurnResult } from '../shared/companion-state'
import type { HideoutControl, HideoutState } from '../shared/hideout'
import type { HandsFreeHostState } from '../shared/hands-free-state'
import { CursorStyleId } from '../shared/cursor-styles'
import type { CompanionRendererId } from '../shared/companion-renderers'
import type { CompanionSize } from '../shared/companion-size'
import type {
  AnalyticsEventName,
  AnalyticsEventProps,
  OnboardingSurface
} from '../shared/analytics-events'
import type { TourProbeEventPayload } from '../shared/tour/types'
import type { UsageMeter } from '../shared/billing-math'
import type { ShortcutId } from '../shared/shortcuts'
import type { SetupCheck, SetupCheckId, SetupFixProgress } from '../shared/setup-check'
import type { BugReportContext, BugReportDraft, BugReportResult } from '../shared/bug-report'

/** Shared by phoneRemoteSetEnabled + phoneRemoteGetQr — both answer "here's the
 *  pairing code and who's on it right now", so one shape keeps them honest. */
interface PhoneRemoteQrResult {
  ok: boolean
  qrDataUrl?: string
  tunnelUrl?: string | null
  reason?: string
  /** A phone is connected AT THIS MOMENT. Distinct from the status broadcast,
   *  which only fires on a transition. */
  connected?: boolean
}

interface CustomAPI {
  getInitialData: () => Promise<PanelInitData>
  modeOverride: (mode: 'rewrite' | 'ask' | 'act' | null) => void
  ctxToggle: (on: boolean) => void
  draftInput: (text: string) => void
  actionSelect: (key: string) => void
  actionClear: () => void
  skillEditorOpen: () => void
  skillEditorClose: () => void
  onActionsChanged: (callback: (actions: QuickAction[]) => void) => () => void
  historyRequest: (query?: string) => void
  feedbackSubmit: (
    run_id: string,
    rating: FeedbackRating | null,
    note?: string
  ) => Promise<FeedbackEntry | null>
  feedbackList: () => Promise<Record<string, FeedbackEntry>>
  bugReportContext: () => Promise<BugReportContext>
  bugReportSubmit: (draft: BugReportDraft) => Promise<BugReportResult>
  bugReportPickScreenshot: () => Promise<string | null>
  bugReportScreenshotThumb: (path: string) => Promise<string | null>
  bugReportClose: () => Promise<void>
  bugReportEmailFallback: (url: string) => Promise<void>
  specialistLoad: () => Promise<SupportState>
  specialistSend: (body: string) => Promise<SupportState>
  specialistOpen: () => void
  onSpecialistChanged: (callback: () => void) => () => void
  /** Synthesize `text` via the TTS ladder. `dataUrl` is null when no voice
   *  produced audio (non-mac, or `say` itself failed) — callers stay silent.
   *  `words` carries real per-word timings, but ONLY from the Kokoro rung. */
  speakText: (text: string) => Promise<SpeakTextResult>
  kokoro: {
    status: () => Promise<{
      supported: boolean
      installed: boolean
      enabled: boolean
      hasPayload: boolean
      provider: string
    }>
    install: () => Promise<{ ok: boolean; error?: string }>
    remove: () => Promise<{ removed: boolean; bytesFreed: number }>
    onProgress: (callback: (p: { receivedBytes: number; totalBytes: number }) => void) => () => void
  }
  copy: (text: string) => void
  cancel: () => void
  panelHide: () => void
  panelMinimizeOrigin: () => Promise<{ x: number; y: number }>
  stopRun: () => void
  resetSession: () => void
  resumeSession: (runId: string) => Promise<ResumeSessionResult>
  resetPanelHeight: () => void
  resize: (h: number, inChat?: boolean) => void
  submit: (
    q: string,
    mode: string,
    ctx: boolean,
    source: string,
    attachments?: MediaAttachment[],
    sessionId?: string
  ) => void
  pickAttachments: () => Promise<MediaAttachment[]>
  pasteClipboardImage: () => Promise<MediaAttachment | null>
  saveDroppedImage: (source: DroppedImage) => Promise<MediaAttachment | null>
  markupSave: (png: string, source: string) => Promise<string>
  markupList: () => Promise<string[]>
  pathForFile: (file: File) => string
  attachmentThumb: (path: string) => Promise<string | null>


  actionsLoad: () => Promise<QuickAction[]>
  actionsSave: (actions: QuickAction[]) => Promise<QuickAction[]>
  skillsList: () => Promise<SkillInfo[]>

  onHistoryData: (callback: (items: HistoryItem[]) => void) => () => void
  onBusyPhase: (callback: (payload: BusyPhasePayload) => void) => () => void
  onShowAnswer: (
    callback: (payload: { q: string; a: string; runId?: string; sessionId?: string }) => void
  ) => () => void
  onShowActResult: (
    callback: (payload: {
      summary: string
      revealPath: string | null
      revealIsDir?: boolean
      ok: boolean
    }) => void
  ) => () => void
  onShowError: (callback: (payload: { msg: string; runId?: string }) => void) => () => void
  onBackendHealthWarning: (callback: (payload: BackendHealthWarning) => void) => () => void
  onPanelReseed: (callback: (data: PanelInitData) => void) => () => void
  onMediaFocusFolder: (callback: (folder: string) => void) => () => void
  onMightyFocusCode: (callback: (codeTab?: CodeTab) => void) => () => void
  codeTakeStartedAgent: () => Promise<CodeTabHandoff | null>
  codeNoProjectFolder: () => Promise<string>
  codeStartupPeek: (pane: string) => Promise<StartupPeek>
  codeStartupAnswer: (pane: string, index: number) => Promise<boolean>
  onIncognitoChanged: (callback: (on: boolean) => void) => () => void
  onViewAsUserChanged: (callback: (on: boolean) => void) => () => void
  onBackendChanged: (callback: (backend: BackendId) => void) => () => void
  getModelCatalog: () => Promise<ModelCatalogEntry[]>
  onModelCatalogChanged: (callback: (models: ModelCatalogEntry[]) => void) => () => void

  // Shared payload type, same reasoning as onHudDone below.
  onHudUpdate: (callback: (payload: HudUpdatePayload) => void) => () => void
  onHudInit: (callback: (payload: HudInitPayload) => void) => () => void
  // Reference the shared payload type rather than re-declaring its shape — the
  // hand-copied version had already drifted (it silently lacked `stopped`).
  onHudDone: (callback: (payload: HudDonePayload) => void) => () => void
  transcriptOpen: (runId: string) => void
  transcriptClose: () => void
  onTranscriptEvent: (callback: (payload: TranscriptEventPayload) => void) => () => void
  replyWindowHide: () => void
  replyWindowOpenBig: (ref: string) => void
  replyWindowShow: (ref: string) => void
  onReplyWindowAim: (callback: (ref: string) => void) => () => void
  hudDismiss: (runId: string) => void
  hudStopCapture: (runId: string) => void
  hudCancelCapture: (runId: string) => void
  hudStopRun: (runId: string) => void
  hudReveal: (runId: string) => void
  hudAction: (runId: string, action: 'ask' | 'act', instruction?: string) => void
  hudConfirmAct: (runId: string, answer: 'confirm' | 'cancel') => void
  hudHover: (runId: string) => void
  hudLeave: (runId: string) => void
  hudFollowUp: (runId: string, q: string) => void
  hudRunSkill: (runId: string, actionKey: string) => void
  hudSetFocusable: (runId: string, focusable: boolean) => void
  hudResize: (runId: string, height: number) => void
  onVoiceRouteInit: (callback: (payload: VoiceRoutePayload) => void) => () => void
  onVoiceRoutePending: (callback: (payload: VoiceRoutePendingPayload) => void) => () => void
  onVoiceRouteReset: (callback: () => void) => () => void
  onVoiceRouteSearchOpen: (callback: () => void) => () => void
  voiceRouteSearchFocus: (runId: string, on: boolean) => void
  onVoiceRouteResult: (callback: (payload: VoiceRouteResultPayload) => void) => () => void
  voiceRoutePick: (payload: VoiceRoutePickPayload) => void
  voiceRouteDismiss: (runId: string) => void
  voiceRouteGo: (runId: string, sinkId: string) => void
  voiceRouteRetry: (runId: string) => void
  voiceRouteEnhance: (runId: string, sinkId: string, select?: number, copy?: boolean) => void
  onVoiceRouteEnhanced: (callback: (payload: VoiceRouteEnhancePayload) => void) => () => void
  voiceRouteResize: (runId: string, height: number) => void
  voiceRouteWidth: (runId: string, width: number) => void
  voiceRouteMove: (runId: string, dx: number, dy: number) => void
  voiceRoutingConfigGet: () => Promise<VoiceRoutingConfig>
  voiceRoutingConfigSet: (patch: {
    mode?: VoiceRoutingMode
    offerGoTo?: boolean
    showSkills?: boolean
    showAgents?: boolean
  }) => Promise<void>
  /** Resolves true when a routing card actually opened. */
  voiceRouteFromHud: (runId: string) => Promise<boolean>
  voiceRouteFromHistory: (runId: string) => Promise<boolean>
  onActionCardShow: (callback: (payload: ActionCardPayload) => void) => () => void
  onActionChordMods: (callback: (held: boolean) => void) => () => void
  onActionResult: (callback: (payload: ActionResultPayload) => void) => () => void
  onActionStep: (callback: (payload: ActionStepPayload) => void) => () => void
  actionRun: (runId: string, proposalId: string) => void
  actionStop: (runId: string) => void
  actionSetSlot: (runId: string, proposalId: string, slotKey: string, value: string) => void
  actionDismiss: (runId: string, proposalId: string) => void
  actionsConfigGet: () => Promise<ActionsConfig>
  actionsConfigSet: (patch: ActionsConfigPatch) => Promise<ActionsConfig>
  actionsOpenPluginsFolder: () => Promise<void>
  hudRelayAnswer: (payload: HudRelayAnswerPayload) => void
  hudGoToOrigin: (requestId: string) => void
  hudCanGoToOrigin: (requestId: string) => Promise<boolean>
  onPlaySound: (callback: (name: SoundName) => void) => () => void
  onIslandActivity: (callback: (payload: ActivityPayload) => void) => () => void

  cursorToggle: (on: boolean) => void
  onCursorPos: (callback: (pos: { x: number; y: number }) => void) => () => void
  onCursorStyle: (callback: (style: CursorStyleId) => void) => () => void
  onCursorFlyTo: (callback: (p: CursorFlyTo) => void) => () => void
  onCursorSuggest: (callback: (state: SuggestState) => void) => () => void
  cursorDismiss: () => void
  cursorSetClickable: (on: boolean) => void
  cursorSetFocusable: (on: boolean) => void
  onCursorCancelArm: (callback: () => void) => () => void
  cursorAccept: (index: number, finalText?: string) => void
  onCursorPointerEnabled: (callback: (enabled: boolean) => void) => () => void
  cursorGetState: () => Promise<CursorState>

  onInkOp: (callback: (op: InkOp) => void) => () => void
  onActHighlight: (callback: (p: HighlightBoxPayload) => void) => () => void
  onAgentCursorShow: (callback: (p: AgentCursorTarget) => void) => () => void
  onAgentCursorHide: (callback: () => void) => () => void
  agentCursorHover: (on: boolean) => void
  agentCursorControl: (action: AgentCursorAction) => void
  onComputerUseStatus: (callback: (p: ComputerUseStatus) => void) => () => void
  computerUseControl: (command: ComputerUseCommand) => void
  onSelectionBarShow: (callback: (p: SelectionBarShowPayload) => void) => () => void
  onSelectionBarHide: (callback: () => void) => () => void
  onSelectionBarResult: (callback: (p: SelectionBarResultPayload) => void) => () => void
  selectionBarAction: (key: string, prompt?: string) => void
  selectionBarDismiss: () => void
  selectionBarAccept: (edited?: string) => void
  selectionBarResize: (height: number, width?: number) => void
  selectionBarMove: (x: number, y: number) => void
  islandMove: (dx: number, dy: number) => void
  islandResetPosition: () => void
  selectionBarListHistory: () => Promise<SelectionBarHistoryItem[]>
  /** Re-paste a past bar run's result over the CURRENT selection. */
  selectionBarPasteHistory: (runId: string) => void
  selectionBarSetFast: (on: boolean) => Promise<boolean>
  selectionBarHover: (over: boolean) => void
  selectionBarSetFocusable: (on: boolean) => void
  selectionBarListActions: () => Promise<SelectionBarAction[]>
  selectionBarSaveAction: (
    key: string | null,
    label: string,
    instruction: string
  ) => Promise<SelectionBarAction[]>
  selectionBarDeleteAction: (key: string) => Promise<SelectionBarAction[]>
  selectionBarResetActions: () => Promise<SelectionBarAction[]>
  selectionBarListRecents: () => Promise<string[]>
  selectionBarKeepRecent: (
    prompt: string
  ) => Promise<{ actions: SelectionBarAction[]; recents: string[] }>

  settingsGet: () => Promise<SettingsState>
  settingsInstallHint: (tool: 'ffmpeg' | 'whisper' | 'node') => Promise<string>
  settingsRequestPermission: (key: PermissionKey) => Promise<SettingsState>
  settingsOpenPane: (key: PermissionKey) => Promise<void>
  settingsOpenOnboarding: () => Promise<void>
  /** Dev-only: replay first run. `mock: false` uses this Mac's real TCC grants
   *  instead of faked checks. No-op in prod. */
  devReplayFirstRun: (mock?: boolean) => Promise<void>
  settingsTakeFocusSection: () => Promise<SettingsSectionFocus | null>
  onSettingsFocusSection: (callback: () => void) => () => void
  openSettingsWindow: (focusSection?: SettingsSectionFocus) => Promise<void>
  openPhoneRemoteQrWindow: () => Promise<void>
  openPlaygroundWindow: () => Promise<void>
  openAnalyticsWindow: () => Promise<void>
  openDeckWindow: () => Promise<void>
  openCanvasWindow: () => Promise<void>
  canvas: {
    load: () => Promise<import('../shared/canvas').CanvasState>
    save: (state: import('../shared/canvas').CanvasState) => Promise<void>
    think: (text: string) => Promise<import('../shared/canvas').CanvasThinkResult>
    directions: (idea: string, steps: string[]) => Promise<import('../shared/canvas').CanvasDirectionsResult>
    hide: () => Promise<void>
    startNew: () => Promise<import('../shared/canvas').CanvasState>
    boards: () => Promise<import('../shared/canvas').CanvasBoardSummary[]>
    open: (id: string) => Promise<import('../shared/canvas').CanvasState>
  }
  openBillingWindow: () => Promise<void>
  openUpgradeWindow: (reason: UpgradeReason) => Promise<void>
  upgradeResize: (height: number) => void
  upgradeGetReason: () => Promise<UpgradeReason>
  onUpgradeReason: (callback: (reason: UpgradeReason) => void) => () => void
  openMediaLibraryWindow: () => Promise<void>
  getRecoveredRecordings: () => Promise<RecoveredRecordingsState>
  dismissRecoveredRecordings: () => Promise<void>
  onRecoveredRecordingsChanged: (callback: (state: RecoveredRecordingsState) => void) => () => void
  mediaList: () => Promise<MediaItem[]>
  mediaDelete: (folder: string) => Promise<boolean>
  mediaReveal: (folder: string) => Promise<void>
  mediaEnrich: (folder: string, force?: boolean) => Promise<MediaItem | null>
  mediaRetranscribe: (folder: string) => Promise<RetranscribeResult>
  mediaUrl: (absPath: string) => string
  appIcon: (appName: string) => Promise<string | null>
  favicon: (url: string) => Promise<string | null>
  linkPreview: (url: string) => Promise<import('../shared/types').LinkPreview | null>
  mediaWaveform: (mediaPath: string) => Promise<number[]>
  mediaChatWith: (question: string) => Promise<MediaChatResult>
  mediaGetOsScreenshots: () => Promise<boolean>
  mediaSetOsScreenshots: (on: boolean) => Promise<void>
  mighty: {
    open: (startFresh?: boolean, sessionId?: string) => Promise<void>
    openCode: (codeTab?: CodeTab) => Promise<void>
    chat: (
      message: string,
      sessionId?: string,
      attachments?: MediaAttachment[],
      projectId?: string,
      backend?: BackendId,
      clientRunId?: string
    ) => Promise<MightyChatResult>
    listSessions: () => Promise<MightySession[]>
    getSession: (id: string) => Promise<MightySession | null>
    runTerminal: (sessionId: string) => Promise<string>
    newSession: (projectId?: string) => Promise<MightySession>
    deleteSession: (id: string) => Promise<boolean>
    listProjects: () => Promise<MightyProject[]>
    upsertProject: (project: MightyProject) => Promise<MightyProject | null>
    deleteProject: (id: string) => Promise<boolean>
    assignSessionProject: (sessionId: string, projectId?: string) => Promise<boolean>
    pickProjectFolder: (known?: string) => Promise<ProjectRepoLink | null>
    scanProjectFolder: (known?: string) => Promise<ProjectFolderScan | null>
    foundProjects: () => Promise<ProjectFolderScan[]>
    importProjects: (scans: ProjectFolderScan[]) => Promise<number>
    pickProjectImage: (projectId: string) => Promise<MightyProject | null>
    clearProjectImage: (projectId: string) => Promise<MightyProject | null>
    discoverProjectImages: () => Promise<number>
    setSessionBackend: (sessionId: string, backend: BackendId) => Promise<boolean>
    setSessionPinned: (sessionId: string, pinned: boolean) => Promise<boolean>
    setSessionTitle: (sessionId: string, title: string) => Promise<boolean>
    setSessionArchived: (sessionId: string, archived: boolean) => Promise<boolean>
    setProjectPinned: (projectId: string, pinned: boolean) => Promise<boolean>
    truncateLastTurn: (sessionId: string) => Promise<MightySession | null>
    exportSession: (sessionId: string, format: MightyExportFormat) => Promise<boolean>
    listJobs: () => Promise<MightyJob[]>
    upsertJob: (job: MightyJob) => Promise<void>
    deleteJob: (id: string) => Promise<boolean>
    runJob: (id: string) => Promise<boolean>
    listRegistry: () => Promise<MightyArtifact[]>
    deleteArtifact: (path: string) => Promise<boolean>
    reveal: (path: string) => Promise<void>
    openArtifact: (path: string) => Promise<boolean>
    getSettings: () => Promise<MightySettings>
    setSettings: (settings: MightySettings) => Promise<void>
    getRenderMarkup: () => Promise<boolean>
    setRenderMarkup: (on: boolean) => Promise<void>
    // "Read answers aloud" on a typed chat turn — see useSpokenReplies.ts.
    getSpeakReplies: () => Promise<boolean>
    setSpeakReplies: (on: boolean) => Promise<void>
    getDetailMode: () => Promise<boolean>
    setDetailMode: (on: boolean) => Promise<void>
    getZoomLevel: () => Promise<number>
    setZoomLevel: (level: number) => Promise<void>
    // Fired when the zoom level changes by any route (⌘+/⌘-/⌘0, trackpad pinch, or
    // setZoomLevel). Returns an unsubscribe fn.
    onZoomChanged: (callback: (level: number) => void) => () => void
    onZoomKey: (callback: (key: ZoomKey) => void) => () => void
    getSidebarWidth: () => Promise<number>
    setSidebarWidth: (width: number) => Promise<void>
    getSidebarShown: () => Promise<boolean>
    setSidebarShown: (on: boolean) => Promise<void>
    setLastMode: (mode: 'all' | 'chat' | 'code') => Promise<void>
    setLastCodeSession: (ref: string) => Promise<void>
    getContextRailShown: () => Promise<boolean>
    setContextRailShown: (on: boolean) => Promise<void>
    getWorkspaces: () => Promise<ChatWorkspaceTab[]>
    setWorkspaces: (tabs: ChatWorkspaceTab[]) => Promise<void>
    revealSource: (path: string) => Promise<void>
    openWorkspace: () => Promise<void>
    showPanel: () => Promise<void>
    /** SIGKILL one pane's in-flight run. True if a live run was actually killed. */
    stopRun: (runId: string) => Promise<boolean>
    /** Hide the chat window (keeps sessions + bounds for the next open). */
    hide: () => Promise<void>
    onPhase: (callback: (payload: MightyPhasePayload) => void) => () => void
    // Rich transcript events (tool calls, thinking, text chunks) during a chat run.
    onEvent: (callback: (payload: MightyEventPayload) => void) => () => void
    // Fired when the user expands an empty panel into an already-open Mighty window:
    // the window should clear to a new empty chat. Returns an unsubscribe fn.
    onStartFresh: (callback: (projectId?: string) => void) => () => void
    // Fired when the panel hands off a live conversation into an already-open
    // Mighty window: switch to this session id now. Returns an unsubscribe fn.
    onOpenSession: (callback: (sessionId: string) => void) => () => void
    // Fired when a turn is appended to a Mighty session (live ask-mode answer, or a
    // resolved handoff) — the receiving window re-fetches if it's showing that session.
    onTurnAppended: (callback: (payload: MightyTurnAppendedPayload) => void) => () => void
    onProjectsChanged: (callback: () => void) => () => void
  }
  navigator: {
    run: (targetId: string) => Promise<void>
    close: () => Promise<void>
    search: (
      query: string,
      refs: import('../shared/navigator-targets').NavigatorSearchRef[]
    ) => Promise<import('../shared/navigator-targets').NavigatorContentHit[]>
  }
  analyticsRequest: (range: string) => Promise<AnalyticsData>
  analyticsInsight: (range: string) => Promise<string>
  analyticsInitialRange: () => Promise<AnalyticsRange>
  openPath: (dir: string) => Promise<void>
  openMedia: (file: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  linkMenu: (url: string, canOpenHere: boolean) => Promise<import('../shared/types').LinkMenuChoice>
  nativeMenu: (items: import('../shared/types').NativeMenuItem[]) => Promise<string | null>
  settingsSave: (patch: SettingsPatch) => Promise<SettingsState>
  settingsDownloadModel: (modelName?: string) => Promise<{
    result: { ok: boolean; path: string; error?: string }
    state: SettingsState
  }>
  settingsInstallWhisper: () => Promise<{
    result: { ok: boolean; output: string }
    state: SettingsState
  }>
  settingsInstallFfmpeg: () => Promise<{
    result: { ok: boolean; output: string }
    state: SettingsState
  }>
  onBinaryInstallProgress: (
    callback: (payload: { key: string; line: string }) => void
  ) => () => void
  settingsGetPrefs: () => Promise<{
    cursorCompanion: boolean
    cursorStyle: CursorStyleId
    backend: BackendId
    ollamaModel: string
    mlxModel: string
    selectedModel: string
    thinkingEnabled: boolean
    maxRecordingMin: number
    soundEnabled: boolean
    captureHud: boolean
    listenAutoPaste: boolean
    contextLog: boolean
    agentPhotos: boolean
    decisionCards: boolean
    runTranscript: boolean
    showTiming: boolean
    dynamicIsland: boolean
    selectionBar: boolean
    selectionBarFast: boolean
    dockIcon: boolean
    liveCompanion: boolean
    companionRenderer: CompanionRendererId
    companionSize: CompanionSize
    liveActs: boolean
    suggestions: boolean
    clickEnabled: boolean
    fnListenEnabled: boolean
    actHighlight: boolean
    feedbackEnabled: boolean
    historyFilterHidden: string[]
    mightySourceFilterHidden: string[]
    mightyShowEmpty: boolean
    historyEncryption: boolean
    incognito: boolean
    phoneRemoteEnabled: boolean
    phoneRemoteStayAwake: boolean
    phoneRemoteClamshell: boolean
    phoneRemoteAwayMode: boolean
    /** Live: is Away Mode held right now (any trigger). */
    phoneRemoteAwayHeld: boolean
    /** False on Windows: every pointer verb is unimplemented, so the control is
     *  hidden rather than offering a remote that cannot move the cursor. */
    phoneRemoteSupported: boolean
    advancedMenu: boolean
  }>
  settingsSetCursor: (on: boolean) => Promise<boolean>
  settingsSetCursorStyle: (style: string) => Promise<CursorStyleId>
  settingsSetBackend: (backend: string) => Promise<BackendId>
  settingsSetMaxRec: (min: number) => Promise<number>
  settingsSetSound: (on: boolean) => Promise<boolean>
  settingsSetCaptureHud: (on: boolean) => Promise<boolean>
  settingsSetListenAutoPaste: (on: boolean) => Promise<boolean>
  settingsSetContextLog: (on: boolean) => Promise<boolean>
  settingsSetAgentPhotos: (on: boolean) => Promise<boolean>
  settingsSetDecisionCards: (on: boolean) => Promise<boolean>
  getGlobalInstructions: () => Promise<GlobalInstructionsSettings>
  setGlobalInstructions: (settings: GlobalInstructionsSettings) => Promise<void>
  settingsSetRunTranscript: (on: boolean) => Promise<boolean>
  settingsSetShowTiming: (on: boolean) => Promise<boolean>
  settingsSetDynamicIsland: (on: boolean) => Promise<boolean>
  settingsSetSelectionBar: (on: boolean) => Promise<boolean>
  settingsSetSelectionBarFast: (on: boolean) => Promise<boolean>
  settingsSetDockIcon: (on: boolean) => Promise<boolean>
  settingsSetCompanion: (on: boolean) => Promise<boolean>
  settingsSetCompanionRenderer: (renderer: string) => Promise<CompanionRendererId>
  settingsSetCompanionSize: (size: string) => Promise<CompanionSize>
  settingsSetLiveActs: (on: boolean) => Promise<boolean>
  companionSetInteractive: (interactive: boolean) => Promise<void>
  companionSendText: (text: string) => void
  openCompanionWindow: () => Promise<void>
  closeCompanionWindow: () => Promise<void>
  // Phase 0.5 debug/verify stream — see src/shared/companion-debug.ts.
  companionStageEventReport: (event: CompanionStageEvent) => void
  onCompanionStageEvent: (callback: (event: CompanionStageEvent) => void) => () => void
  // Phase 1: one finished VAD segment (WAV bytes) up to main; the transcript +
  // mocked reply come back async via onLiveTurnResult (see CHANNELS.liveTurnSubmit
  // / liveTurnResult in ipc.ts for why this isn't a single invoke/return pair).
  liveTurnSubmit: (wavBytes: Uint8Array, echoTail?: string) => void
  liveTurnDraft: (wavBytes: Uint8Array, echoTail?: string) => Promise<LiveDraft>
  onLiveTurnResult: (callback: (result: LiveTurnResult) => void) => () => void
  hideoutControl: (control: HideoutControl) => Promise<HideoutState>
  onHideoutState: (callback: (state: HideoutState) => void) => () => void
  onCompanionMicPaused: (callback: (paused: boolean) => void) => () => void
  onCompanionAck: (callback: (clip: { audio: Uint8Array; mimeType: string; text: string; announce?: boolean }) => void) => () => void
  // Barge-in: kill the in-flight live run — see CHANNELS.companionAbortTurn.
  companionAbortTurn: () => void
  // Hands-free dictation host — see CHANNELS.handsFreeSegment. No result push
  // back: main pastes the transcript at the cursor itself.
  handsFreeSegment: (wavBytes: Uint8Array) => void
  handsFreeHostState: (state: HandsFreeHostState) => void
  // Phase 3: drag-to-reposition the companion's OS window — see
  // companion-window.ts's moveCompanionWindow doc.
  companionDragMove: (delta: { dx: number; dy: number }) => void
  // Dev-only: Playground's act-highlight demo button — see windows.ts's handler.
  devFlashHighlight: (opts?: { sizePx?: number; durationMs?: number }) => void
  // Dev-only: Playground's agent-cursor demo button — see windows.ts's handler.
  devAgentCursorDemo: () => void
  /** DEV ONLY: drop this window out of alwaysOnTop after a Vite build error. */
  devUnpinForError: () => void
  // Screen mirror hidden capture window (?window=webrtc-capture) — see
  // src/main/capture/screen-stream.ts for the main-side half of this relay.
  webrtcCaptureReady: () => void
  onWebrtcCaptureStart: (
    callback: (
      sdp: string,
      quality: 'capped' | 'native',
      iceServers: unknown[],
      shareAudio: boolean,
      audioOnly: boolean
    ) => void
  ) => () => void
  /** Raw system-audio PCM from the native SCK helper (float32 interleaved,
   *  CONFIG.PHONE_REMOTE.SYSTEM_AUDIO_*). Fires many times per second. */
  onWebrtcCapturePcm: (callback: (chunk: ArrayBuffer) => void) => () => void
  onWebrtcCaptureIceCandidate: (
    callback: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void
  ) => () => void
  onWebrtcCaptureStop: (callback: () => void) => () => void
  /** The phone is driving the Mac (true) or has been idle long enough to be
   *  reading (false). Edge-triggered by main, not a per-event firehose. */
  onWebrtcCaptureMotion: (
    callback: (userDriving: boolean, source: UserInputSource) => void
  ) => () => void
  webrtcCaptureAnswer: (sdp: string) => void
  webrtcCaptureIceCandidateOut: (
    candidate: string,
    sdpMid: string | null,
    sdpMLineIndex: number | null
  ) => void
  webrtcCaptureError: (reason: string) => void
  webrtcCaptureStalled: () => void
  webrtcCaptureRecovered: () => void
  webrtcCaptureMicPcm: (chunk: ArrayBuffer) => void
  onWebrtcCapturePipStart: (callback: () => void) => () => void
  onWebrtcCapturePipStop: (callback: () => void) => () => void
  webrtcCapturePipConfig: (width: number, height: number, frameRate: number) => void
  webrtcCapturePipChunk: (chunk: ArrayBuffer) => void
  webrtcCapturePipEnded: (reason: string) => void
  webrtcCapturePipAudioConfig: (sampleRate: number, channels: number) => void
  webrtcCapturePipAudioChunk: (chunk: ArrayBuffer) => void
  settingsSetSuggestions: (on: boolean) => Promise<boolean>
  settingsSetClick: (on: boolean) => Promise<boolean>
  settingsSetFnListen: (on: boolean) => Promise<boolean>
  settingsSetActHighlight: (on: boolean) => Promise<boolean>
  phoneRemoteSetEnabled: (on: boolean) => Promise<PhoneRemoteQrResult>
  phoneRemoteGetQr: () => Promise<PhoneRemoteQrResult>
  agentRelaySetEnabled: (on: boolean) => Promise<AgentRelayStatus>
  agentRelayGetStatus: () => Promise<AgentRelayStatus>
  coordinationGet: () => Promise<import('../shared/coordination').CoordinationSnapshot>
  coordinationAttention: {
    (
      sessions: AgentRelaySessionInfo[]
    ): Promise<import('../shared/coordination-attention').AttentionRow[]>
    (request: {
      requestId: string
      skip?: string[]
    }): Promise<import('../shared/session-priority').SessionPriorityResult>
  }
  coordinationSetup: () => Promise<string[]>
  coordinationRenameProject: (
    project: string,
    name: string
  ) => Promise<import('../shared/coordination').CoordinationSnapshot>
  agentSessionMark: (session: AgentRelaySessionInfo, change: import('../shared/types').SessionMark) => void
  agentSessionImport: (entries: unknown) => void
  coordinationArchiveProject: (
    project: string,
    archived: boolean
  ) => Promise<import('../shared/coordination').CoordinationSnapshot>
  coordinationSetEnabled: (
    enabled: boolean
  ) => Promise<import('../shared/coordination').CoordinationSnapshot>
  factoryMaterials: (
    request: import('../shared/factory').FactoryMaterialRequest
  ) => Promise<import('../shared/factory').FactoryMaterialResult>
  factoryGet: () => Promise<import('../shared/factory').FactorySnapshot>
  factorySetup: (body: {
    mightyId: string
    name: string
    repoRoot: string
    integrationRef?: string
    checkCommands?: string[]
    projectId?: string
  }) => Promise<import('../shared/factory').FactorySnapshot>
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
  }) => Promise<import('../shared/factory').FactorySnapshot>
  factoryApprove: (body: {
    projectId: string
    taskIds: string[]
  }) => Promise<import('../shared/factory').FactorySnapshot>
  factoryPause: (body: {
    projectId: string | null
    paused: boolean
  }) => Promise<import('../shared/factory').FactorySnapshot>
  factoryCancel: (taskId: string) => Promise<import('../shared/factory').FactorySnapshot>
  factoryRestore: (taskId: string) => Promise<import('../shared/factory').FactorySnapshot>
  factoryPark: (body: {
    taskId: string
    parked: boolean
  }) => Promise<import('../shared/factory').FactorySnapshot>
  factoryPriority: (body: {
    projectId: string
    priority: number
  }) => Promise<import('../shared/factory').FactorySnapshot>
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
  }) => Promise<import('../shared/factory').FactorySnapshot>
  factoryRetry: (
    taskId: string,
    options?: { note?: string; rebuild?: boolean }
  ) => Promise<import('../shared/factory').FactorySnapshot>
  factoryReconcile: () => Promise<import('../shared/factory').FactorySnapshot>
  factoryMerge: (taskId: string) => Promise<import('../shared/factory').FactorySnapshot>
  factoryTranscript: (
    attemptId: string,
    reveal?: boolean
  ) => Promise<import('../shared/factory').FactoryTranscript>
  factoryArtifact: (evidenceId: string) => Promise<string>
  factoryLimits: (body: {
    projectId?: string
    tasksAtOnce?: number
    globalSlots?: number
    repairs?: number
    stopAfter?: number | null
    models?: Partial<import('../shared/factory').FactoryModels>
  }) => Promise<import('../shared/factory').FactorySnapshot>
  factoryCodeSize: (projectId: string) => Promise<import('../shared/factory').CodeSize>
  agentRelayGetPushFilter: () => Promise<RelayPushSettings>
  /** Returns the settings AFTER the write, so the caller never has to guess what
   *  they now are -- two switches flipped fast both settle on the truth. */
  agentRelaySetPushFilter: (verb: RelayVerbWire, on: boolean) => Promise<RelayPushSettings>
  agentRelaySetNotifyLevel: (level: RelayNotifyPushLevel) => Promise<RelayPushSettings>
  agentRelayGetMacAlerts: () => Promise<RelayMacAlertSettings>
  agentRelaySetMacAlerts: (next: RelayMacAlertSettings) => Promise<RelayMacAlertSettings>
  agentRelaySetTurnEndPing: (on: boolean) => Promise<RelayPushSettings>
  agentRelaySendTest: () => Promise<{ ok: true } | { ok: false; detail: string }>
  agentRelayListClients: () => Promise<McpClientState[]>
  agentRelayConfigureClient: (
    id: McpClientId
  ) => Promise<{ ok: true } | { ok: false; detail: string }>
  agentRelayGetRequests: () => Promise<RelaySnapshotWire>
  agentRelayRespond: (
    requestId: string,
    response: RelayResponseWire
  ) => Promise<'resolved' | 'already-resolved' | 'unknown'>
  /** False when the undo window had already closed -- the agent has its answer. */
  agentRelayUndismiss: (requestId: string) => Promise<boolean>
  /** Bring this session's terminal to the front. `ok:false` means the shim
   *  reported no address we can act on, which the sheet must say out loud
   *  rather than leaving a button that appears to do nothing. */
  agentRelayRevealSession: (label: string) => Promise<{ ok: true; via: string } | { ok: false }>
  /** Suggested chips for an idle card. Empty array is a real answer ("keep the
   *  canned three") -- every failure path resolves that way, never rejects. */
  agentRelaySuggest: (
    label: string,
    context: string,
    said?: string,
    fresh?: boolean
  ) => Promise<Suggestion[]>
  /** Type a line into the agent's pane. `ok:false` covers every way it went
   *  nowhere -- session reaped, no pane and no pid, tmux refused -- so the
   *  composer can keep the draft rather than clear a message nobody got. */
  agentRelaySessionReply: (
    label: string,
    text: string,
    paths?: string[],
    expected?: import('../shared/types').AgentTranscriptTurn,
    page?: { url: string; title: string }
  ) => Promise<{ ok: true; via: 'tmux' | 'tty' } | { ok: false }>
  repoGitState: (ref: string) => Promise<import('../shared/types').RepoGitState | null>
  pulseState: (ref: string) => Promise<import('../shared/session-pulse').PulseState>
  pulseFresh: (sessionIds: string[]) => Promise<Record<string, import('../shared/session-pulse').PulseRow>>
  pulseSetEnabled: (on: boolean) => Promise<boolean>
  pulseSetScope: (ref: string, scope: import('../shared/session-pulse').PulseScope) => Promise<void>
  pulseScoreNow: (ref: string, force?: boolean) => Promise<void>
  onPulseChanged: (callback: (sessionId: string) => void) => () => void
  repoGitPush: (ref: string) => Promise<import('../shared/types').RepoPushResult>
  repoGitChanges: (ref: string, scope?: import('../shared/types').ChangeScope) => Promise<import('../shared/types').ChangeSet | null>
  repoGitPull: (ref: string) => Promise<import('../shared/types').RepoPull | null>
  repoGitOpenPull: (ref: string) => Promise<import('../shared/types').RepoPullResult>
  repoGitMerge: (ref: string) => Promise<import('../shared/types').RepoPullResult>
  repoTurnUndo: (ref: string, turnAt: number) => Promise<import('../shared/types').CheckpointResult>
  /** What YOU have already typed at this agent, oldest first. A reply mints no
   *  card, so this store is the only record the thread can be rebuilt from. */
  agentRelaySessionSent: (
    label: string
  ) => Promise<{ text: string; at: number; files?: string[] }[]>
  agentRelaySessionTranscript: (ref: string) => Promise<AgentTranscriptTurn[]>
  agentRelaySessionChecklist: (ref: string) => Promise<AgentChecklist | undefined>
  agentRelaySessionHelpers: (ref: string) => Promise<AgentHelper[]>
  agentRelaySessionTools: (ref: string) => Promise<AgentToolUse[]>
  agentRelaySessionAffects: (ref: string) => Promise<import('../shared/surfaces').SessionAffects>
  agentRelaySessionUsage: (ref: string) => Promise<import('../shared/types').AgentSessionUsage | null>
  mcp: {
    list: (cwd: string) => Promise<import('../shared/types').McpConnection[]>
    health: (cwd: string, fresh?: boolean) => Promise<import('../shared/types').McpHealthRow[]>
    save: (req: import('../shared/types').McpSaveRequest) => Promise<import('../shared/types').McpActionResult>
    remove: (
      cwd: string,
      name: string,
      scope: import('../shared/types').McpScope
    ) => Promise<import('../shared/types').McpActionResult>
    login: (cwd: string, name: string) => Promise<import('../shared/types').McpActionResult>
    openClaudeConnectors: () => Promise<void>
  }
  agentRelaySessionScreen: (
    ref: string,
    back?: number
  ) => Promise<{
    text: string
    cols: number
    rows: number
    cursor?: { x: number; y: number }
    history: number
    alt: boolean
    streamed: boolean
  } | null>
  agentRelaySessionKeys: (
    ref: string,
    keys: ({ text: string } | { key: string } | { paste: string })[]
  ) => Promise<boolean>
  agentRelaySessionFit: (ref: string, cols: number, rows: number) => Promise<boolean>
  agentRelaySessionWatch: (ref: string) => Promise<boolean>
  agentRelaySessionUnwatch: (ref: string) => Promise<void>
  onAgentRelaySessionScreenChanged: (cb: (ref: string) => void) => () => void
  /** Ask the agent to finish, then close it. Resolves as soon as the ask is
   *  typed -- the escalation behind it runs for up to a minute, and the real
   *  confirmation is the row leaving the list. */
  agentRelayWrapSession: (
    label: string
  ) => Promise<
    { ok: true; via: 'tmux' | 'tty' } | { ok: false; reason: 'unreachable' | 'unsupported' }
  >
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
  }) => Promise<{ ok: true; pane: string } | { ok: false; reason: string }>
  codeRouteTask: (task: string, sessions: { ref: string; title: string; recap?: string }[]) => Promise<string | null>
  codeConductorWorkspaces: () => Promise<import('../shared/conductor').ConductorWorkspace[]>
  codeContinueConductor: (id: string) => Promise<import('../shared/conductor').ConductorContinueResult>
  codeProjectIdeas: (input: {
    cwd: string
    name: string
    titles: string[]
    mode: 'cached' | 'generate' | 'refresh'
  }) => Promise<import('../shared/project-ideas').ProjectIdeasResult | null>
  codeProjectIdeaFeedback: (input: {
    cwd: string
    label: string
    why?: string
    verdict: import('../shared/project-ideas').ProjectIdeaVerdict | null
  }) => Promise<import('../shared/project-ideas').ProjectIdeaCheck>
  codeAgentModels: () => Promise<AgentModelsState>
  codeSetAgentModel: (choice: AgentModelChoice) => Promise<boolean>
  codeSetUpAgentProvider: (harness: AgentModelChoice['harness']) => Promise<{ ok: boolean }>
  chatModelPicks: () => Promise<{ opencode: string; openrouter: string; claude: string; codex: string }>
  chatSetModelPick: (backend: 'opencode' | 'openrouter' | 'claude' | 'codex', model: string) => Promise<void>
  chatSourceModels: () => Promise<import('../shared/model-sources').SourceModel[]>
  onAgentSetupProgress: (callback: (payload: AgentSetupProgress) => void) => () => void
  onAgentRelayRequestsChanged: (callback: (snapshot: RelaySnapshotWire) => void) => () => void
  onAgentRelayStatusChanged: (callback: (status: AgentRelayStatus) => void) => () => void
  /** The phone can change these switches too, so Settings has to be told. */
  onAgentRelayPushFilterChanged: (callback: (settings: RelayPushSettings) => void) => () => void
  onPhoneRemoteStatus: (callback: (status: { connected: boolean }) => void) => () => void
  phoneRemoteGetSensitivity: () => Promise<number>
  phoneRemoteSetSensitivity: (value: number) => Promise<number>
  /** Outstanding pairing code for the in-PWA enrollment flow. `code` is
   *  null when the server isn't running. Pass `{ rotate: true }` to mint. */
  phoneRemoteGetPairCode: (opts?: PhoneRemoteGetPairCodeOpts) => Promise<{
    code: string | null
    pairedCount: number
    /** Epoch ms the code stops being accepted; null when there is no code. */
    expiresAt: number | null
  }>
  /** Revokes every paired device; returns how many were forgotten. */
  phoneRemoteForgetDevices: () => Promise<{ forgot: number }>
  phoneRemoteListDevices: () => Promise<{ devices: PairedDevice[] }>
  phoneRemoteRevokeDevice: (
    deviceId: string
  ) => Promise<{ revoked: boolean; devices: PairedDevice[] }>
  /** Fires whenever the paired set changes, from any source -- including a
   *  phone unpairing itself, which has no invoke to answer. */
  onPhoneRemoteDevicesChanged: (
    callback: (payload: PhoneRemoteDevicesChanged) => void
  ) => () => void
  phoneRemoteGetTunnel: () => Promise<{
    enabled: boolean
    status: PhoneRemoteTunnelStatus
    url: string | null
    qrDataUrl: string | null
  }>
  phoneRemoteSetTunnelEnabled: (
    on: boolean
  ) => Promise<{ ok: boolean; url?: string; qrDataUrl?: string; reason?: string }>
  onPhoneRemoteTunnelStatus: (callback: (status: PhoneRemoteTunnelStatus) => void) => () => void
  /** Whether a phone-remote extended screen is up right now. Polled, not
   *  pushed -- the display can vanish without any IPC. */
  phoneRemoteGetExtendedScreen: () => Promise<{ active: boolean }>
  phoneRemoteClearExtendedScreen: () => Promise<{ ok: boolean }>
  phoneRemoteSetStayAwake: (on: boolean) => Promise<{ ok: boolean }>
  /** Clamshell (lid-closed) mode. Prompts for admin — `cancelled` distinguishes
   *  "user dismissed the password dialog" from a real failure. */
  phoneRemoteSetClamshell: (
    on: boolean
  ) => Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  /** Away Mode: keep working after you walk away — holds the Mac unlocked for
   *  the length of a phone session and covers the screen on a delay.
   *  `reason: 'no-input-watch'` means Accessibility isn't granted, so the Mac
   *  couldn't detect someone sitting down — the only actionable failure. */
  phoneRemoteSetAwayMode: (on: boolean) => Promise<{
    ok: boolean
    cancelled?: boolean
    reason?: 'no-input-watch' | 'cancelled' | 'failed'
    error?: string
  }>
  /** Cover the screen NOW, or uncover it. `active` is the state AFTER the call. */
  phoneRemoteToggleCoverNow: () => Promise<{
    ok: boolean
    active: boolean
    cancelled?: boolean
    reason?: 'no-input-watch' | 'cancelled' | 'failed'
    error?: string
  }>
  /** Away Mode held/handed back from anywhere — a phone, a human, the tray. */
  onPhoneRemoteAwayState: (callback: (active: boolean) => void) => () => void
  settingsSetFeedback: (on: boolean) => Promise<boolean>
  settingsSetHistoryEncryption: (on: boolean) => Promise<boolean>
  settingsSetHistoryFilter: (hidden: string[]) => Promise<string[]>
  settingsSetMightySourceFilter: (hidden: string[]) => Promise<string[]>
  settingsSetMightyShowEmpty: (show: boolean) => Promise<boolean>
  settingsSetIncognito: (on: boolean) => Promise<boolean>
  settingsClearHistory: () => Promise<string | null>
  settingsTestBackend: (backend: string) => Promise<BackendTestResult>
  settingsBackendProbes: () => Promise<Partial<Record<BackendId, BackendProbeRecord>>>
  settingsDisconnectBackend: (backend: string) => Promise<BackendTestResult>
  planLoginsList: () => Promise<PlanLogin[]>
  planLoginsCheck: () => Promise<PlanLogin[]>
  planLoginsAdd: (backend: PlanBackend) => Promise<PlanLoginsResult>
  planLoginsCancel: () => Promise<void>
  planLoginsRemove: (id: string) => Promise<PlanLogin[]>
  planLoginPicks: () => Promise<PlanLoginPicks>
  planLoginSetPick: (backend: PlanBackend, id: string) => Promise<PlanLoginPicks>
  /** Probe the currently-selected backend (panel-open pre-flight). null if the
   *  probe itself failed — treat as "no warning", never as unhealthy. */
  panelProbeBackend: () => Promise<BackendHealthWarning | null>
  panelChecklistSeenDone: () => void
  settingsSetOllamaModel: (model: string) => Promise<string>
  settingsSetThinkingEnabled: (on: boolean) => Promise<boolean>
  settingsListLocalModels: () => Promise<LocalModel[]>
  settingsSetMlxModel: (model: string) => Promise<string>
  settingsListMlxModels: () => Promise<LocalModel[]>
  /** What the one-click setup can do for this local backend right now. */
  settingsLocalSetupState: (backend: string) => Promise<LocalSetupState>
  /** Install + start the local service. Progress arrives on onLocalSetupProgress. */
  settingsSetUpLocalBackend: (
    backend: string
  ) => Promise<{ ok: boolean; reason?: string; startedModel?: string }>
  onLocalSetupProgress: (callback: (payload: LocalSetupProgress) => void) => () => void
  /** Persist the panel's per-conversation model pick for the paid `mightymouse`
   *  backend. Returns the STORED value (validated against CONFIG.MODEL_CATALOG;
   *  junk/removed → ''). '' means "use the server's feature-routed default". */
  panelSetSelectedModel: (model: string) => Promise<string>
  onModelDownloadProgress: (callback: (payload: { pct: number }) => void) => () => void

  tour: {
    complete: () => Promise<void>
    skip: () => Promise<void>
    armProbe: (shortcutId: ShortcutId | null) => void
    onProbeEvent: (callback: (payload: TourProbeEventPayload) => void) => () => void
    /** §7.3 dev-only — no-op in a packaged build. */
    mockConfirm: () => void
    mockMods: (down: boolean) => void
  }

  onboarding: {
    getChecks: () => Promise<PermissionCheck[]>
    runSelfTest: (key: PermissionKey) => Promise<PermissionTest>
    getBinaries: () => Promise<BinaryStatus[]>
    complete: (surface: OnboardingSurface) => Promise<void>
    /** Relaunch to clear the stale Screen Recording TCC cache, resuming the wizard. */
    restart: () => Promise<void>
    /** Reveal the app bundle in Finder, ready to drag into a TCC pane. */
    revealApp: () => Promise<void>
    /** Dev: drop out of FTUE replay without completing it, so the wizard shows
     *  the machine's real grants. No-op outside a replay. */
    exitMock: () => Promise<void>
    setHeight?: (height: number) => Promise<void>
  }

  /**
   * The drag-to-add coach panel — a floating window that survives System
   * Settings taking focus, unlike anything drawn inside the wizard.
   */
  dragCoach: {
    /** Open the panel for one `+`-allow-list permission (accessibility/screen). */
    show: (key: PermissionKey) => Promise<void>
    close: () => Promise<void>
    /**
     * Start a real macOS file drag of the .app bundle, so dropping it on the
     * pane's list actually adds the app. Synchronous by necessity — see
     * CHANNELS.dragCoachStartDrag.
     */
    startDrag: () => void
  }

  /** Setup Check — every dependency in one list, a button on every failure. */
  setup: {
    getChecks: () => Promise<SetupCheck[]>
    runFix: (id: SetupCheckId) => Promise<{ ok: boolean }>
    /** May return `pending` when it had to send the user to sign-in / credits. */
    switchBackend: () => Promise<{ ok: boolean; pending?: boolean }>
    open: () => Promise<void>
    onFixProgress: (callback: (payload: SetupFixProgress) => void) => () => void
  }

  auth: {
    sendCode: (email: string) => Promise<{ ok: boolean; error?: string }>
    verifyCode: (email: string, token: string) => Promise<{ ok: boolean; error?: string }>
    password: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>
    signOut: () => Promise<void>
    deleteAccount: () => Promise<{ ok: boolean; error?: string }>
    getSession: () => Promise<{ email: string; userId: string } | null>
    takePendingEmail: () => Promise<string>
    onChange: (callback: (user: { email: string; userId: string } | null) => void) => () => void
  }
  track: <K extends AnalyticsEventName>(
    event: K,
    ...rest: Record<string, never> extends AnalyticsEventProps<K>
      ? [props?: AnalyticsEventProps<K>]
      : [props: AnalyticsEventProps<K>]
  ) => void
  reportError: (report: {
    kind: string
    message: string
    stack?: string | null
    source?: string
    props?: Record<string, unknown>
  }) => void

  // Admin visibility only — the dashboard itself lives in the web portal.
  admin: {
    isAdmin: () => Promise<boolean>
    getViewAsUser: () => Promise<{ realAdmin: boolean; viewAsUser: boolean }>
    setViewAsUser: (on: boolean) => Promise<boolean>
  }

  // Billing (mightymouse backend)
  billingGetBalance: () => Promise<number | null>
  billingListUsage: (limit?: number) => Promise<UsageEvent[]>
  billingOpenCheckout: (item: BillingCheckoutItem) => Promise<{ ok: boolean; error?: string }>
  billingOpenPortal: () => Promise<{ ok: boolean }>
  billingGetSubscription: () => Promise<SubscriptionStatus | null>
  billingGetUsage: () => Promise<UsageMeter | null>
  billingGetLifetimeOffer: () => Promise<LifetimeOffer | null>
  onBillingBalanceChanged: (cb: (cents: number) => void) => () => void
  onBillingCheckoutReturn: (cb: (status: CheckoutReturnStatus) => void) => () => void

  keys: {
    scan: (scope: string) => Promise<ProjectKeyMap>
    list: () => Promise<ProjectKeyMap[]>
    set: (payload: KeySetPayload) => Promise<KeyRecord | null>
    update: (id: string, patch: KeyPatch) => Promise<KeyRecord | null>
    remove: (id: string, deleteValue: boolean) => Promise<boolean>
    probe: (id: string) => Promise<KeyProbeResult>
    copy: (id: string) => Promise<boolean>
    onChanged: (callback: (maps: ProjectKeyMap[]) => void) => () => void
  }
  built: {
    list: () => Promise<import('../shared/built').BuiltItem[] | null>
    open: (id: string, how: 'open' | 'reveal') => Promise<boolean>
    hide: (id: string) => Promise<import('../shared/built').BuiltItem[]>
    favorite: (id: string, on: boolean) => Promise<import('../shared/built').BuiltItem[]>
    tag: (id: string, tags: string[]) => Promise<import('../shared/built').BuiltItem[]>
    stop: (id: string) => Promise<import('../shared/built').BuiltRunResult>
    start: (id: string) => Promise<import('../shared/built').BuiltRunResult>
    onChanged: (callback: (items: import('../shared/built').BuiltItem[]) => void) => () => void
  }
  firstRunCode: {
    recentProjects: () => Promise<
      Array<{ folder: string; name: string; updatedAt: string; projectId?: string }>
    >
    installCommands: () => Promise<{ claude: string; codex: string }>
    handoff: (input: { cwd: string; project: string; pane: string; message: string }) => Promise<boolean>
  }
  firstRun: {
    finish: (surface: 'first-run') => Promise<void>
    getFirstBootAtMs: () => Promise<number | null>
    modelReady: () => Promise<boolean>
    onModelProgress: (callback: (pct: number) => void) => () => void
    onTranscript: (callback: (text: string) => void) => () => void
    onPhoneMoved: (callback: () => void) => () => void
  }
  infra: {
    list: () => Promise<import('../shared/infra').ProjectInfra[]>
    check: (projectId: string) => Promise<import('../shared/infra').ProjectInfra>
    add: (projectId: string, kindId: string, name: string) => Promise<import('../shared/infra').ProjectInfra>
    remove: (projectId: string, kindId: string, provider: string) => Promise<import('../shared/infra').ProjectInfra>
    skip: (projectId: string, kindId: string, skip: boolean) => Promise<import('../shared/infra').ProjectInfra>
    want: (projectId: string, kindId: string) => Promise<import('../shared/infra').ProjectInfra>
    setTags: (
      projectId: string,
      field: import('../shared/infra').TagField,
      values: string[] | null
    ) => Promise<import('../shared/infra').ProjectInfra>
    setBrief: (
      projectId: string,
      brief: import('../shared/infra').ProjectBrief
    ) => Promise<import('../shared/infra').ProjectInfra>
    draftBrief: (projectId: string) => Promise<import('../shared/brief').BriefDraft>
    setup: (
      projectId: string,
      kindId: string,
      setup: { provider: string; pane?: string } | null
    ) => Promise<import('../shared/infra').ProjectInfra>
    site: (projectId: string) => Promise<import('../shared/infra').SiteState>
    publishSite: (projectId: string, name: string) => Promise<import('../shared/infra').SiteState>
    unpublishSite: (projectId: string) => Promise<import('../shared/infra').SiteState>
    onSiteProgress: (
      callback: (progress: import('../shared/infra').SiteProgress) => void
    ) => () => void
    onChanged: (callback: (infra: import('../shared/infra').ProjectInfra) => void) => () => void
  }
  reports: {
    get: (projectId: string, range: import('../shared/reports').ReportRange, ifStale?: boolean, env?: string) => Promise<import('../shared/reports').ProjectReport>
    refresh: (projectId: string, range: import('../shared/reports').ReportRange, env?: string) => Promise<import('../shared/reports').ProjectReport>
    onChanged: (callback: (report: import('../shared/reports').ProjectReport) => void) => () => void
  }
  resourcesSnapshot: () => Promise<ResourceSnapshot>
  resourcesAsk: (text: string) => Promise<void>
  onResourcesAskDraft: (cb: (text: string) => void) => () => void
  onResourcesUpdated: (cb: (snapshot: ResourceSnapshot) => void) => () => void
  sideBrowser: {
    open: (address: string) => Promise<SideBrowserTabState | null>
    navigate: (id: string, address: string) => Promise<void>
    command: (id: string, cmd: SideBrowserCommand) => Promise<void>
    place: (id: string, bounds: SideBrowserBounds | null) => Promise<void>
    still: (id: string) => Promise<string | null>
    close: (id: string) => Promise<void>
    permission: (id: string, kind: string, decision: 'allow' | 'block' | 'reset') => Promise<void>
    find: (id: string, text: string | null, forward?: boolean) => Promise<void>
    stopAgent: (id: string) => Promise<void>
    pauseAgent: (id: string, paused: boolean) => Promise<void>
    onState: (cb: (state: SideBrowserTabState) => void) => () => void
    onPopup: (cb: (popup: { openerId: string; url: string }) => void) => () => void
    onPageAction: (cb: (asked: { viewId: string; url: string; action: import('../shared/types').SideBrowserPageAction }) => void) => () => void
    onShortcut: (cb: (hit: { viewId: string; shortcut: SideBrowserShortcut }) => void) => () => void
    onOpenUrl: (cb: () => void) => () => void
    takeUrl: () => Promise<string | null>
    importSources: () => Promise<SideBrowserImportSource[]>
    importCookies: (browser: string, profile: string) => Promise<SideBrowserImportResult>
    suggest: (query: string) => Promise<SideBrowserSuggestion[]>
    topSites: () => Promise<SideBrowserSuggestion[]>
    recent: () => Promise<SideBrowserSuggestion[]>
    forgetRecent: (url: string) => Promise<void>
    forgetTopSite: (url: string) => Promise<void>
    annotate: (id: string) => Promise<import('../shared/types').SideBrowserAnnotation | null>
    annotateEnd: (id: string, note: string | null) => Promise<void>
    mod: (
      id: string,
      action: import('../shared/types').SiteModAction,
      modId?: string,
      name?: string
    ) => Promise<import('../shared/types').SiteModState[]>
    sharedMod: (
      id: string,
      request: import('../shared/types').SharedModRequest
    ) => Promise<import('../shared/types').SharedModResult>
    runTask: (id: string, req: BrowserTaskRequest) => Promise<BrowserTaskResult>
    controlTask: (id: string, command: BrowserTaskControl, note?: string) => Promise<void>
    onTaskProgress: (cb: (progress: BrowserTaskProgress) => void) => () => void
    taskModels: () => Promise<BrowserTaskModelsState>
    setTaskModel: (choice: BrowserTaskModel) => Promise<BrowserTaskModelsState>
  }

  // Auto-update (electron-updater)
  files: {
    read: (path: string, limit?: number) => Promise<FileReadResult>
    write: (path: string, text: string, expectMtimeMs: number) => Promise<FileWriteResult>
    list: (root: string) => Promise<string[]>
    watch: (path: string, callback: () => void) => () => void
  }
  update: {
    check: () => Promise<void>
    download: () => Promise<void>
    install: () => Promise<void>
    openReleasePage: () => Promise<void>
    getState: () => Promise<UpdateStatusPayload>
    onStatus: (cb: (payload: UpdateStatusPayload) => void) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: CustomAPI
  }
}
export {}
