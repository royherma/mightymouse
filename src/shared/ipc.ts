/**
 * CHANNELS — single source of truth for all IPC channel name strings.
 *
 * Design decision: we chose the lighter-weight approach of centralizing channel
 * name constants rather than building typed ipcMain.on/handle wrappers.
 * Reason: Electron's ipcMain overloads (on vs handle, 1-arg vs 2-arg callbacks)
 * create friction for a generic typed wrapper without real payoff — the type
 * safety we need is on the *payload* shapes, not the channel dispatch mechanism.
 * The real wins are:
 *   1. No bare string literals scattered across main/preload/renderer.
 *   2. Payload params in ipc.ts handlers are explicitly typed against types.ts.
 *
 * Usage:
 *   import { CHANNELS } from '../shared/ipc';
 *   ipcMain.on(CHANNELS.submit, (_, payload: SubmitPayload) => { ... });
 *   win.webContents.send(CHANNELS.busyPhase, { phase, detail });
 */

export const CHANNELS = Object.freeze({
  // ── renderer → main (send / invoke) ────────────────────────────────────────
  submit: 'submit',
  // Open a native file picker for attachments (images/audio/files). Returns the
  // chosen paths as MediaAttachment[] with kind inferred from extension.
  pickAttachments: 'pick-attachments',
  // Downscaled JPEG data URL for an attached image, for the composer thumbnail.
  // Returns null for non-images / unreadable paths.
  attachmentThumb: 'attachment-thumb',
  pasteClipboardImage: 'paste-clipboard-image',
  saveDroppedImage: 'save-dropped-image',
  markupSave: 'markup-save',
  markupList: 'markup-list',
  copy: 'copy',
  cancel: 'cancel',
  // Hide the panel window without destroying it — unlike cancel/close, the
  // renderer's chat state survives; the existing panel hotkey (⌘⌥⇧M) restores it.
  panelHide: 'panel-hide',
  panelMinimizeOrigin: 'panel-minimize-origin',
  // Stop the in-flight panel run (SIGKILLs the spawned CLI) but keep the panel
  // open — distinct from `cancel`, which closes the panel and lets the run finish
  // into a HUD card. Used by the chat Stop button so the user can edit + resend.
  stopRun: 'stop-run',
  ctxToggle: 'ctxtoggle',
  // Live, unsubmitted panel input, sent debounced on every keystroke so the draft
  // survives a Panel remount (see PREFS.setDraftInput). Cleared (empty string) on
  // submit/stop/reset.
  draftInput: 'draft-input',
  cursorToggle: 'cursor-toggle',
  actionSelect: 'action-select',
  actionClear: 'action-clear',
  historyRequest: 'history-request',
  // Explicit feedback loop: submit a 👍/👎 (+ optional note) for a run; list all
  // ratings to hydrate the History flyout's thumbs state in one shot.
  feedbackSubmit: 'feedback-submit',
  feedbackList: 'feedback-list',
  // User-filed BUG REPORTS (?window=bug) — distinct from the run ratings above,
  // which is why these are namespaced `bugReport*` rather than `feedback*`.
  // Context = the diagnostics + activity trail the form shows before sending.
  bugReportContext: 'bug-report-context',
  bugReportSubmit: 'bug-report-submit',
  // Native picker for a user-attached screenshot. Returns an absolute path.
  bugReportPickScreenshot: 'bug-report-pick-screenshot',
  // Downscaled data URL for the attached image, for the form's thumbnail.
  bugReportScreenshotThumb: 'bug-report-screenshot-thumb',
  // Close the form after a successful submit.
  bugReportClose: 'bug-report-close',
  // Open the mailto: fallback when a submit fails (offline / function down).
  bugReportEmailFallback: 'bug-report-email-fallback',
  specialistLoad: 'specialist-load',
  specialistSend: 'specialist-send',
  specialistChanged: 'specialist-changed',
  specialistOpen: 'specialist-open',
  resize: 'resize',
  modeOverride: 'modeoverride',
  resetSession: 'reset-session',
  resumeSession: 'resume-session',
  resetPanelHeight: 'reset-panel-height',
  hudDismiss: 'hud-dismiss',
  hudReveal: 'hud-reveal',
  hudAction: 'hud-action',
  hudConfirmAct: 'hud-confirm-act',
  hudHover: 'hud-hover',
  hudLeave: 'hud-leave',
  hudFollowUp: 'hud-follow-up',
  hudRunSkill: 'hud-run-skill',
  // Voice routing: renderer → main, the user picked a destination for a finished
  // recording. Payload is { runId, sinkId, mode, submit }.
  voiceRoutePick: 'voice-route-pick',
  // Renderer → main: dismiss the routing card without sending anywhere.
  voiceRouteDismiss: 'voice-route-dismiss',
  // Renderer → main: the card's search box wants keyboard focus (true) or is done with it.
  voiceRouteSearchFocus: 'voice-route-search-focus',
  // Renderer → main: raise a destination's window WITHOUT delivering the text.
  // Separate from voiceRoutePick's 'goto' mode, which sends first and jumps
  // after: this one leaves the card up so you can keep looking. { runId, sinkId }.
  voiceRouteGo: 'voice-route-go',
  voiceRouteRetry: 'voice-route-retry',
  // Renderer → main: { runId, sinkId, select?, copy? }. No select = start, retry, or three fresh ones; copy = clipboard + close.
  voiceRouteEnhance: 'voice-route-enhance',
  // Renderer → main: the routing card's measured height, so it can grow on hover.
  // Its own channel, NOT hudResize — that one is owned by the HUD stack and keyed
  // by a runId that lives in a different map.
  voiceRouteResize: 'voice-route-resize',
  voiceRouteWidth: 'voice-route-width',
  voiceRouteMove: 'voice-route-move',
  // Settings → main: read/write the voice-routing flags.
  voiceRoutingConfigGet: 'voice-routing-config-get',
  voiceRoutingConfigSet: 'voice-routing-config-set',
  // HUD → main: rank the transcript this card is holding and show the card.
  // Only ever fires in 'hover' mode, where nothing was ranked up front.
  voiceRouteFromHud: 'voice-route-from-hud',
  voiceRouteFromHistory: 'voice-route-from-history',
  actionRun: 'action-run',
  actionSetSlot: 'action-set-slot',
  actionDismiss: 'action-dismiss',
  actionStop: 'action-stop',
  actionsConfigGet: 'actions-config-get',
  actionsConfigSet: 'actions-config-set',
  actionsOpenPluginsFolder: 'actions-open-plugins-folder',
  hudSetFocusable: 'hud-set-focusable',
  hudResize: 'hud-resize',
  hudStopCapture: 'hud-stop-capture',
  hudCancelCapture: 'hud-cancel-capture',
  hudStopRun: 'hud-stop-run',
  hudRelayAnswer: 'hud-relay-answer',
  // Replaces the old "Open the screen" affordance on the Mac card — see
  // take-me-to-the-session design. Fire-and-forget: the resolver shells out
  // to cmux/tmux/open on the main side, the renderer never waits on it.
  hudGoToOrigin: 'hud-go-to-origin',

  // ── renderer → main (invoke / handle) ──────────────────────────────────────
  // a dead "go to session" button is worse than none, so the card asks
  // FIRST whether the origin resolves before ever rendering the button.
  hudCanGoToOrigin: 'hud-can-go-to-origin',
  getInitialData: 'get-initial-data',
  actionsLoad: 'actions-load',
  actionsSave: 'actions-save',
  // Open the full-screen skill-editor overlay window. Renderer → main (fire); main
  // builds/focuses the screen-centered overlay so the editor is never clipped by
  // the small panel window's bounds (see the CSS-fixed-can't-escape gotcha).
  skillEditorOpen: 'skill-editor-open',
  // Close it (Save done / Esc / backdrop). Sent from the overlay renderer → main.
  skillEditorClose: 'skill-editor-close',
  // Run Transcript Inspector: open the full-screen inspector for a run (from the
  // HUD's expand icon), renderer → main (fire). Payload is the runId.
  transcriptOpen: 'transcript-open',
  // Close the inspector (its ✕ / Esc). Inspector renderer → main (fire).
  transcriptClose: 'transcript-close',
  replyWindowHide: 'reply-window-hide',
  replyWindowOpenBig: 'reply-window-open-big',
  replyWindowShow: 'reply-window-show',
  replyWindowAim: 'reply-window-aim',
  replyWindowScreen: 'reply-window-screen',
  replyWindowApp: 'reply-window-app',
  replyWindowSeeing: 'reply-window-seeing',
  replyWindowExpand: 'reply-window-expand',
  replyWindowAuto: 'reply-window-auto',
  replyWindowShowOver: 'reply-window-show-over',
  // main → panel broadcast after a save so the panel reloads its chip row.
  actionsChanged: 'actions-changed',
  skillsList: 'skills-list',
  settingsGet: 'settings-get',
  settingsInstallHint: 'settings-install-hint',
  settingsRequestPermission: 'settings-request-permission',
  settingsOpenPane: 'settings-open-pane',
  settingsOpenOnboarding: 'settings-open-onboarding',
  // Dev-only: replay the first-run wizard with mocked permission checks, so the
  // un-granted states can be walked without touching real TCC grants.
  devReplayFirstRun: 'dev-replay-first-run',
  // Deep-link into a Settings section (e.g. tray → Phone Remote). Push for an
  // already-open window; the invoke lets a freshly-created window pull the
  // pending target on mount (a push sent during load would race React's effects).
  settingsFocusSection: 'settings-focus-section',
  settingsTakeFocusSection: 'settings-take-focus-section',
  settingsSave: 'settings-save',
  settingsDownloadModel: 'settings-download-model',
  settingsInstallWhisper: 'settings-install-whisper',
  settingsInstallFfmpeg: 'settings-install-ffmpeg',
  // Live brew output line, pushed while an install runs so the UI isn't frozen.
  binaryInstallProgress: 'binary-install-progress',
  settingsGetPrefs: 'settings-get-prefs',
  settingsSetCursor: 'settings-set-cursor',
  settingsSetCursorStyle: 'settings-set-cursor-style',
  settingsSetBackend: 'settings-set-backend',
  settingsSetMaxRec: 'settings-set-max-rec',
  settingsSetSound: 'settings-set-sound',
  settingsSetCaptureHud: 'settings-set-capture-hud',
  settingsSetListenAutoPaste: 'settings-set-listen-autopaste',
  settingsSetContextLog: 'settings-set-context-log',
  settingsSetAgentPhotos: 'settings-set-agent-photos',
  settingsSetDecisionCards: 'settings-set-decision-cards',
  // Run Transcript Inspector ("Show run details") toggle. Mirrors the others.
  settingsSetRunTranscript: 'settings-set-run-transcript',
  settingsSetShowTiming: 'settings-set-show-timing',
  settingsSetDynamicIsland: 'settings-set-dynamic-island',
  // Selection bar (pops over highlighted text). Starts/stops the mouse watcher
  // live, same as settingsSetDynamicIsland shows/hides its window.
  settingsSetSelectionBar: 'settings-set-selection-bar',
  // main -> bar renderer: render these buttons. main -> bar: hide yourself.
  selectionBarShow: 'selection-bar-show',
  selectionBarHide: 'selection-bar-hide',
  settingsSetSelectionBarFast: 'settings-set-selection-bar-fast',
  // bar renderer -> main: the user tapped an action (or dismissed the bar).
  selectionBarAction: 'selection-bar-action',
  // main -> bar renderer: an inline (Fast) run started, finished, or failed.
  // Only this path reports back; a panel hand-off hides the bar instead.
  selectionBarResult: 'selection-bar-result',
  selectionBarDismiss: 'selection-bar-dismiss',
  // bar renderer -> main: the user accepted the previewed rewrite (carrying their
  // edits, if any). This is what pastes — a finished run alone never touches the
  // document.
  selectionBarAccept: 'selection-bar-accept',
  // bar renderer -> main: grow/shrink the window so the gear menu isn't clipped
  // by the bar's fixed 40px frame, and open the Settings window from the gear.
  selectionBarResize: 'selection-bar-resize',
  selectionBarMove: 'selection-bar-move',
  // The bar's own History list — just the runs it fired, so a rewrite whose paste
  // never landed is still there to re-paste.
  selectionBarListHistory: 'selection-bar-list-history',
  selectionBarPasteHistory: 'selection-bar-paste-history',
  // bar renderer -> main: the pointer is over the bar, so suspend the auto-hide
  // countdown (and the dismiss rules) rather than yanking it away mid-read.
  selectionBarHover: 'selection-bar-hover',
  // bar renderer -> main: the chip editor needs real keystrokes, which a
  // focusable:false window never gets. Flipped back the moment it closes.
  selectionBarSetFocusable: 'selection-bar-set-focusable',
  // Chip CRUD from the gear menu. Each returns the saved list, so the renderer
  // never has to guess what actually landed on disk.
  selectionBarListActions: 'selection-bar-list-actions',
  selectionBarSaveAction: 'selection-bar-save-action',
  selectionBarDeleteAction: 'selection-bar-delete-action',
  selectionBarResetActions: 'selection-bar-reset-actions',
  // One-off prompts typed into Ask. Listed when the field opens, and promoted to
  // a real chip when the user decides to keep one.
  selectionBarListRecents: 'selection-bar-list-recents',
  selectionBarKeepRecent: 'selection-bar-keep-recent',
  // Dock icon visibility. Applies live (no restart) — see applyDockIcon in main.
  settingsSetDockIcon: 'settings-set-dock-icon',
  // Live Voice Companion overlay ("Live mode"). Mirrors settingsSetDynamicIsland.
  settingsSetCompanion: 'settings-set-companion',
  // Hands-free dictation capability (talk, pause, it lands). Surface-neutral on
  // purpose -- the phone arms it today, the Mac's own mic later.
  // Which companion visualization draws the character — dev A/B pick from the
  // companion debug panel. See src/shared/companion-renderers.ts.
  settingsSetCompanionRenderer: 'settings-set-companion-renderer',
  // How much screen a voice conversation takes (full | mini). See companion-size.ts.
  settingsSetCompanionSize: 'settings-set-companion-size',
  // May a voice turn DRIVE the Mac, or only answer?
  settingsSetLiveActs: 'settings-set-live-acts',
  settingsSetSuggestions: 'settings-set-suggestions',
  settingsSetClick: 'settings-set-click',
  settingsSetFnListen: 'settings-set-fn-listen',
  settingsSetActHighlight: 'settings-set-act-highlight',
  phoneRemoteSetEnabled: 'phone-remote-set-enabled',
  phoneRemoteGetQr: 'phone-remote-get-qr',
  // Code agent relay. Toggle starts/stops the
  // loopback MCP server; status is polled by Settings for the health line;
  // sendTest fires a real `notify` push so setup ends in a felt buzz.
  agentRelaySetEnabled: 'agent-relay-set-enabled',
  agentRelayGetStatus: 'agent-relay-get-status',
  coordinationGet: 'coordination-get',
  coordinationSetEnabled: 'coordination-set-enabled',
  coordinationSetup: 'coordination-setup',
  coordinationRenameProject: 'coordination-rename-project',
  coordinationArchiveProject: 'coordination-archive-project',
  agentSessionMark: 'agent-session-mark',
  agentSessionImport: 'agent-session-import',
  coordinationAttention: 'coordination-attention',
  factoryGet: 'factory-get',
  factoryMaterials: 'factory-materials',
  factorySetup: 'factory-setup',
  factorySeed: 'factory-seed',
  factoryApprove: 'factory-approve',
  factoryPause: 'factory-pause',
  factoryCancel: 'factory-cancel',
  factoryPark: 'factory-park',
  factoryRestore: 'factory-restore',
  factoryPriority: 'factory-priority',
  factoryDraft: 'factory-draft',
  factoryRetry: 'factory-retry',
  factoryReconcile: 'factory-reconcile',
  factoryMerge: 'factory-merge',
  factoryTranscript: 'factory-transcript',
  factoryArtifact: 'factory-artifact',
  factoryLimits: 'factory-limits',
  factoryCodeSize: 'factory-code-size',
  agentRelaySendTest: 'agent-relay-send-test',
  // Which kinds of message may buzz the phone. Gates the push only -- the card
  // reaches every inbox either way.
  agentRelayGetPushFilter: 'agent-relay-get-push-filter',
  agentRelaySetPushFilter: 'agent-relay-set-push-filter',
  // The severity floor under the notify switch, stored alongside it.
  agentRelaySetNotifyLevel: 'agent-relay-set-notify-level',
  agentRelaySetTurnEndPing: 'agent-relay-set-turn-end-ping',
  // The Mac's OWN alert switches, separate from the phone's above
  // which kinds pop up here, and whether they are
  // drawn as macOS notifications or MightyMouse cards.
  agentRelayGetMacAlerts: 'agent-relay-get-mac-alerts',
  agentRelaySetMacAlerts: 'agent-relay-set-mac-alerts',
  // Main → Settings renderer: the phone flips these too, and Settings only
  // reads the filter at mount.
  agentRelayPushFilterChanged: 'agent-relay-push-filter-changed',
  // Item 3b: detect installed MCP clients and write our server entry into one,
  // so setup is a button instead of a copied snippet.
  agentRelayListClients: 'agent-relay-list-clients',
  agentRelayConfigureClient: 'agent-relay-configure-client',
  // The Mac's own Code surface: snapshot at open, push to keep it live, respond
  // to answer. Same store as the phone, so first answer wins across both.
  agentRelayGetRequests: 'agent-relay-get-requests',
  agentRelayRespond: 'agent-relay-respond',
  // Take a clear back, while the agent still hasn't been told.
  agentRelayUndismiss: 'agent-relay-undismiss',
  // Bring the terminal a session is running in to the front. The HUD has done
  // this per-REQUEST since §6b; a session carries the same origin, so its card
  // can offer the jump without waiting for the agent to ask something first.
  agentRelayRevealSession: 'agent-relay-reveal-session',
  // Suggested chips for an idle card -- the Mac deck's route to the same
  // generator the phone reaches over WS (`requestSuggestions`).
  agentRelaySuggest: 'agent-relay-suggest',
  // Type a line straight into the agent's pane, the same act the phone's
  // `relaySessionReply` performs -- not `agentRelayRespond`, which answers one
  // card. A session with no waiting card has nothing to respond TO, and this is
  // the only way to say something to it.
  agentRelaySessionReply: 'agent-relay-session-reply',
  agentRelaySessionSent: 'agent-relay-session-sent',
  agentRelaySessionBtw: 'agent-relay-session-btw',
  repoGitState: 'repo-git-state',
  pulseState: 'pulse-state',
  pulseFresh: 'pulse-fresh',
  pulseSetEnabled: 'pulse-set-enabled',
  pulseSetScope: 'pulse-set-scope',
  pulseScoreNow: 'pulse-score-now',
  pulseChanged: 'pulse-changed',
  repoGitPush: 'repo-git-push',
  repoGitChanges: 'repo-git-changes',
  repoGitPull: 'repo-git-pull',
  repoGitOpenPull: 'repo-git-open-pull',
  repoGitMerge: 'repo-git-merge',
  repoTurnUndo: 'repo-turn-undo',
  agentRelaySessionTranscript: 'agent-relay-session-transcript',
  agentRelaySessionChecklist: 'agent-relay-session-checklist',
  agentRelaySessionHelpers: 'agent-relay-session-helpers',
  agentRelaySessionTools: 'agent-relay-session-tools',
  agentRelaySessionAffects: 'agent-relay-session-affects',
  agentRelaySessionUsage: 'agent-relay-session-usage',
  mcpList: 'mcp-list',
  mcpHealth: 'mcp-health',
  mcpSave: 'mcp-save',
  mcpRemove: 'mcp-remove',
  mcpLogin: 'mcp-login',
  mcpOpenClaudeConnectors: 'mcp-open-claude-connectors',
  agentRelaySessionScreen: 'agent-relay-session-screen',
  agentRelaySessionKeys: 'agent-relay-session-keys',
  agentRelaySessionFit: 'agent-relay-session-fit',
  agentRelaySessionWatch: 'agent-relay-session-watch',
  agentRelaySessionUnwatch: 'agent-relay-session-unwatch',
  agentRelaySessionScreenChanged: 'agent-relay-session-screen-changed',
  // Ends one session on purpose -- the only verb that causes a row to leave the
  // list rather than observing that it already did.
  agentRelayWrapSession: 'agent-relay-wrap-session',
  codeStartAgent: 'code-start-agent',
  codeRouteTask: 'code-route-task',
  codeConductorWorkspaces: 'code-conductor-workspaces',
  codeContinueConductor: 'code-continue-conductor',
  codeNoProjectFolder: 'code-no-project-folder',
  codeProjectIdeas: 'code-project-ideas',
  codeProjectIdeaFeedback: 'code-project-idea-feedback',
  codeAgentModels: 'code-agent-models',
  codeSetAgentModel: 'code-set-agent-model',
  chatModelPicks: 'chat-model-picks',
  chatSetModelPick: 'chat-set-model-pick',
  chatSourceModels: 'chat-source-models',
  codeSetUpAgentProvider: 'code-set-up-agent-provider',
  codeAgentSetupProgress: 'code-agent-setup-progress',
  agentRelayRequestsChanged: 'agent-relay-requests-changed',
  // Pushed when an agent session opens or closes, so "N agents connected" moves
  // the instant a terminal is opened or shut rather than on the next poll.
  agentRelayStatusChanged: 'agent-relay-status-changed',
  // Main → Settings renderer: live status push (connection state, port taken,
  // LAN IP changed) so the QR/status line updates without polling.
  phoneRemoteStatus: 'phone-remote-status',
  // Trackpad move-sensitivity slider (Settings). Get returns the current
  // multiplier (PREFS-backed, survives restarts); set clamps + persists it.
  phoneRemoteGetSensitivity: 'phone-remote-get-sensitivity',
  phoneRemoteSetSensitivity: 'phone-remote-set-sensitivity',
  phoneRemoteSetStayAwake: 'phone-remote-set-stay-awake',
  phoneRemoteGetExtendedScreen: 'phone-remote-get-extended-screen',
  phoneRemoteClearExtendedScreen: 'phone-remote-clear-extended-screen',
  // Clamshell (lid-closed) mode — prompts for admin, so it returns a
  // {ok, cancelled?, error?} shape rather than a bare boolean.
  phoneRemoteSetClamshell: 'phone-remote-set-clamshell',
  phoneRemoteSetAwayMode: 'phone-remote-set-away-mode',
  // Begin/hand back Away Mode on demand, independent of the trigger that
  // normally starts it. The toggle records intent; this performs the thing.
  phoneRemoteToggleCoverNow: 'phone-remote-toggle-cover-now',
  phoneRemoteAwayState: 'phone-remote-away-state',
  // In-PWA enrollment: Settings shows a short code the phone types. `{ rotate:
  // true }` mints; omit to reuse the outstanding code so the QR stays valid.
  phoneRemoteGetPairCode: 'phone-remote-get-pair-code',
  // Revoke every paired device -- the explicit counterpart to credentials
  // that deliberately outlive a server restart.
  phoneRemoteForgetDevices: 'phone-remote-forget-devices',
  // Every paired device, for the Settings list. Ids are hashes, never
  // credentials -- see listPairedDevices.
  phoneRemoteListDevices: 'phone-remote-list-devices',
  // Revoke ONE device by listed id; kicks it only if it holds the live session.
  phoneRemoteRevokeDevice: 'phone-remote-revoke-device',
  // Main → Settings renderer: paired set changed, carrying the full new list.
  phoneRemoteDevicesChanged: 'phone-remote-devices-changed',
  phoneRemoteGetTunnel: 'phone-remote-get-tunnel',
  phoneRemoteSetTunnelEnabled: 'phone-remote-set-tunnel-enabled',
  // Main → Settings renderer: live tunnel lifecycle pushes (downloading pct,
  // provisioning, starting, up, error) so the row shows real progress instead
  // of a frozen "setting up" while cloudflared downloads on first use.
  phoneRemoteTunnelStatus: 'phone-remote-tunnel-status',

  webrtcCaptureStart: 'webrtc-capture-start',
  // Wait for this before sending webrtcCaptureStart: document load can race
  // React's listener registration and silently drop the start request.
  webrtcCaptureReady: 'webrtc-capture-ready',
  // Main -> hidden capture renderer: a trickled ICE candidate from the phone.
  webrtcCaptureIceCandidate: 'webrtc-capture-ice-candidate',
  // Main -> hidden capture renderer: tear the peer connection + capture stream
  // down (toggle-off or phone disconnect) but keep the hidden window alive for
  // the next mirrorStart -- avoids a getDisplayMedia() re-prompt cost per toggle.
  webrtcCaptureStop: 'webrtc-capture-stop',
  // Main -> hidden capture renderer: the user is (or has stopped) driving the
  // Mac from the phone. Sent only on the TRANSITION, and only for a cursorless
  // host, so the glasses can trade resolution for framerate while the screen is
  // actually changing. Main owns this because every input message already
  // arrives there, ahead of the pixels it is about to change.
  webrtcCaptureMotion: 'webrtc-capture-motion',
  // Hidden capture renderer -> main: the SDP answer, relayed to the phone as
  // 'mirrorAnswer'. capture renderer -> main -> phone is the ONE signaling path.
  webrtcCaptureAnswer: 'webrtc-capture-answer',
  // Hidden capture renderer -> main: one trickled ICE candidate, relayed to the
  // phone as 'mirrorIceCandidate'.
  webrtcCaptureIceCandidateOut: 'webrtc-capture-ice-candidate-out',
  // Hidden capture renderer -> main: capture/negotiation failed (permission
  // denied, no display source, peer connection error) -- relayed to the phone
  // as 'mirrorError' with the same human-readable reason string.
  webrtcCaptureError: 'webrtc-capture-error',
  // Hidden capture renderer -> main: capture stalled (frames stopped, e.g.
  // display sleep) and self-recovery is in progress / done -- relayed to the
  // phone as 'mirrorStalled' / 'mirrorRecovered'. Non-fatal: unlike
  // webrtcCaptureError this never tears the peer connection down.
  webrtcCaptureStalled: 'webrtc-capture-stalled',
  webrtcCaptureRecovered: 'webrtc-capture-recovered',
  webrtcCapturePcm: 'webrtc-capture-pcm',
  webrtcCaptureMicPcm: 'webrtc-capture-mic-pcm',
  // A SECOND encode of the running capture track -- Annex-B H.264 for the
  // phone's native PiP layer. Distinct
  // from the WebRTC path: that stays the foreground mirror, this exists only so
  // backgrounded Swift has CMSampleBuffers.
  webrtcCapturePipStart: 'webrtc-capture-pip-start',
  webrtcCapturePipStop: 'webrtc-capture-pip-stop',
  webrtcCapturePipChunk: 'webrtc-capture-pip-chunk',
  webrtcCapturePipConfig: 'webrtc-capture-pip-config',
  webrtcCapturePipEnded: 'webrtc-capture-pip-ended',
  // The audio half of the same pipe. Separate channels rather than a tagged
  // union so a silent mirror stays a video-only failure -- audio ending must
  // never read as the picture ending.
  webrtcCapturePipAudioChunk: 'webrtc-capture-pip-audio-chunk',
  webrtcCapturePipAudioConfig: 'webrtc-capture-pip-audio-config',
  settingsSetFeedback: 'settings-set-feedback',
  settingsSetHistoryEncryption: 'settings-set-history-encryption',
  settingsSetHistoryFilter: 'settings-set-history-filter',
  settingsSetMightySourceFilter: 'settings-set-mighty-source-filter',
  settingsSetMightyShowEmpty: 'settings-set-mighty-show-empty',
  settingsSetIncognito: 'settings-set-incognito',
  settingsClearHistory: 'settings-clear-history',
  settingsTestBackend: 'settings-test-backend',
  settingsBackendProbes: 'settings-backend-probes',
  settingsDisconnectBackend: 'settings-disconnect-backend',
  planLoginsList: 'plan-logins-list',
  planLoginsCheck: 'plan-logins-check',
  planLoginsAdd: 'plan-logins-add',
  planLoginsCancel: 'plan-logins-cancel',
  planLoginsRemove: 'plan-logins-remove',
  planLoginPicks: 'plan-login-picks',
  planLoginSetPick: 'plan-login-set-pick',
  panelProbeBackend: 'panel-probe-backend',
  // Write-once latch: the user opened the checklist while it read 5/5.
  panelChecklistSeenDone: 'panel-checklist-seen-done',
  // Persist the user's chosen Ollama model tag for the `local` backend (PREFS).
  settingsSetOllamaModel: 'settings-set-ollama-model',
  settingsSetThinkingEnabled: 'settings-set-thinking-enabled',
  // Persist the user's chosen Rapid-MLX model alias for the `mlx` backend (PREFS).
  settingsSetMlxModel: 'settings-set-mlx-model',
  /** Install + start a local backend's service. Streams on settingsLocalSetupProgress. */
  settingsSetUpLocalBackend: 'settings-set-up-local-backend',
  settingsLocalSetupProgress: 'settings-local-setup-progress',
  /** What the local-backend row should offer right now (install / start / nothing). */
  settingsLocalSetupState: 'settings-local-setup-state',
  // Persist the per-conversation model pick for the paid `mightymouse` backend
  // (an OpenRouter slug from CONFIG.MODEL_CATALOG, or '' for the server default).
  panelSetSelectedModel: 'panel-set-selected-model',
  // List models the user has already pulled via `ollama pull`, each with its
  // vision/tools capabilities resolved. [] if Ollama isn't running.
  settingsListLocalModels: 'settings-list-local-models',
  // List models a running Rapid-MLX server exposes (GET /v1/models), each with
  // vision/tools capabilities resolved. [] if Rapid-MLX isn't running.
  settingsListMlxModels: 'settings-list-mlx-models',

  // ── onboarding (permissions wizard) ────────────────────────────────────────
  onboardingGetChecks: 'onboarding-get-checks',
  onboardingRunSelfTest: 'onboarding-run-self-test',
  onboardingGetBinaries: 'onboarding-get-binaries',
  onboardingComplete: 'onboarding-complete',
  onboardingRestart: 'onboarding-restart',
  /** Grow/shrink the one-screen window when the provider list opens or closes —
   *  the list must not squeeze to a sliver to fit a fixed height. */
  onboardingSetHeight: 'onboarding-set-height',
  /** Reveal the app bundle in Finder so it can be dragged into a TCC pane. */
  onboardingRevealApp: 'onboarding-reveal-app',
  /** Dev: leave FTUE replay mid-run, so the wizard re-reads real TCC. The flag
   *  otherwise clears only on completion, stranding every later wizard faked. */
  onboardingExitMock: 'onboarding-exit-mock',

  // ── drag-to-add coach (floating panel shown over System Settings) ──────────
  /** Open the coach panel for one `+`-allow-list permission. */
  dragCoachShow: 'drag-coach-show',
  /** Dismiss the coach panel (its Done button, Esc, or an auto-close). */
  dragCoachClose: 'drag-coach-close',
  /** `send` keeps this native drag inside its synchronous gesture. */
  dragCoachStartDrag: 'drag-coach-start-drag',

  // ── setup check (one surface, every dependency, a button per failure) ──────
  setupGetChecks: 'setup-get-checks',
  /** Run the fix for one check. Streams progress on setupFixProgress. */
  setupRunFix: 'setup-run-fix',
  /** Take the zero-install escape hatch (may chain into sign-in / top-up). */
  setupSwitchBackend: 'setup-switch-backend',
  setupOpen: 'setup-open',

  // ── value tour (how-to walkthrough; not a gate) ────────────────────────────
  tourComplete: 'tour-complete',
  tourSkip: 'tour-skip',
  // Press-to-confirm probe (renderer arms/disarms; main pushes hit/wrong/mods
  // events back). ONE channel pair for all three hotkey steps — see
  // src/main/tour-hotkey-probe.ts + the design's mandated simplification.
  tourProbeArm: 'tour-probe-arm',
  tourProbeEvent: 'tour-probe-event',
  tourMockConfirm: 'tour-mock-confirm',
  tourMockMods: 'tour-mock-mods',

  // Renderer → main: Done clicked, or a path reached its win.
  firstRunFinish: 'first-run-finish',
  firstRunGetFirstBootAtMs: 'first-run-get-first-boot-at-ms',
  firstRunModelReady: 'first-run-model-ready',
  // Main → renderer push, 0-100. Observes the ONE background model download at boot.
  firstRunModelProgress: 'first-run-model-progress',
  firstRunTranscript: 'first-run-transcript',
  firstRunPhoneMoved: 'first-run-phone-moved',
  // ── first-run window · code path (CodePath.tsx) ────────────────────────────
  firstRunCodeRecentProjects: 'first-run-code-recent-projects',
  firstRunCodeInstallCommands: 'first-run-code-install-commands',
  firstRunCodeHandoff: 'first-run-code-handoff',

  // ── auth + analytics ───────────────────────────────────────────────────────
  authSendCode: 'auth-send-code',
  authVerifyCode: 'auth-verify-code',
  authPassword: 'auth-password',
  authSignOut: 'auth-sign-out',
  authDeleteAccount: 'auth-delete-account',
  authGetSession: 'auth-get-session',
  // Pending sign-in email from the landing-page download handoff. Renderer reads
  // this on mount to pre-fill the field; reading also clears it (one-shot).
  authTakePendingEmail: 'auth-take-pending-email',
  track: 'track',
  reportError: 'report-error',
  adminIsAdmin: 'admin-is-admin',
  // "View as user" preview: read + write the session-only flag that hides every
  // admin surface. Display only — real access is still checked server-side.
  adminGetViewAsUser: 'admin-get-view-as-user',
  adminSetViewAsUser: 'admin-set-view-as-user',

  openSettingsWindow: 'open-settings-window',
  // Standalone Phone Remote pairing QR modal, opened from the Panel header —
  // same pairing surface as the Settings card, without leaving the Panel.
  openPhoneRemoteQrWindow: 'open-phone-remote-qr-window',
  openPlaygroundWindow: 'open-playground-window',
  openAnalyticsWindow: 'open-analytics-window',
  openDeckWindow: 'open-deck-window',
  openCanvasWindow: 'open-canvas-window',
  canvasLoad: 'canvas-load',
  canvasSave: 'canvas-save',
  canvasThink: 'canvas-think',
  canvasDirections: 'canvas-directions',
  canvasHide: 'canvas-hide',
  canvasNew: 'canvas-new',
  canvasBoards: 'canvas-boards',
  canvasOpen: 'canvas-open',
  openMediaLibraryWindow: 'open-media-library-window',
  // Live Voice Companion overlay window (?window=companion) — open on demand from
  // the tray/Settings; closed the same way, or torn down when Live mode toggles off.
  // Stage renderer only: the overlay is click-through so the agent can reach
  // the apps underneath, and asks for pointer events back while the cursor is
  // over its one interactive region (the input bar).
  companionSetInteractive: 'companion-set-interactive',
  // Stage's input bar: a typed instruction runs the SAME live turn a spoken one
  // does — same session, same screen control, spoken reply — minus whisper.
  companionSendText: 'companion-send-text',
  openCompanionWindow: 'open-companion-window',
  closeCompanionWindow: 'close-companion-window',
  companionStageEventReport: 'companion-stage-event-report',
  companionStageEvent: 'companion-stage-event',
  liveTurnSubmit: 'live-turn-submit',
  liveTurnDraft: 'live-turn-draft',
  liveTurnResult: 'live-turn-result',
  hideoutState: 'hideout-state',
  hideoutControl: 'hideout-control',
  companionMicPaused: 'companion-mic-paused',
  companionAck: 'companion-ack',
  // Barge-in kill: the user talked over a turn that is DRIVING the Mac, so the
  // run has to die, not just have its reply dropped. Fire-and-forget — the
  // renderer has already moved on to `listening` and has nothing to wait for.
  companionAbortTurn: 'companion-abort-turn',
  // Hands-free dictation's host renderer (?window=handsfree). Same VAD hook as
  // the companion, different consumer in main: each segment pastes at the
  // cursor instead of going to the LLM. Host state is ONE channel carrying one
  // enum, not a channel per transition — the phone answers "what state is
  // hands-free in" with a single HandsFreeDisplay, and two surfaces disagreeing
  // about that vocabulary is how the mode drifts.
  handsFreeSegment: 'hands-free-segment',
  handsFreeHostState: 'hands-free-host-state',
  // Pointer-move traffic must use fire-and-forget send, not invoke.
  companionDragMove: 'companion-drag-move',
  openBillingWindow: 'open-billing-window',
  openUpgradeWindow: 'open-upgrade-window',
  // Renderer measures its own content; main clamps + re-centers the frame.
  upgradeResize: 'upgrade-resize',
  // Which limit triggered this open. Pushed when an ALREADY-open window is
  // re-opened from a different CTA; the initial value comes from upgradeGetReason.
  upgradeReason: 'upgrade-reason',
  upgradeGetReason: 'upgrade-get-reason',
  // Media Library: list the capture index, delete a capture, reveal it in Finder.
  mediaList: 'media-list',
  mediaDelete: 'media-delete',
  mediaReveal: 'media-reveal',
  // main → renderer: open the Library tab, selecting one capture when a folder is
  // given (empty string = just show the tab). A cold start passes the same value
  // via the ?focus= query param instead.
  mediaFocusFolder: 'media-focus-folder',
  recoveredRecordingsGet: 'recovered-recordings-get',
  recoveredRecordingsChanged: 'recovered-recordings-changed',
  recoveredRecordingsDismiss: 'recovered-recordings-dismiss',
  // Compute (or read cached) free local enrichment — OCR + keyword tags.
  mediaEnrich: 'media-enrich',
  // Re-run whisper on a capture's audio, overwriting transcript.txt. For the
  // captures whisper got wrong (a 16s clip transcribed as one word).
  mediaRetranscribe: 'media-retranscribe',
  // Resolve a macOS app's real icon to a cached PNG path (Media Library app filter).
  appIcon: 'app-icon',
  // Resolve a URL's site favicon to a cached PNG path (panel context row badge).
  favicon: 'favicon',
  linkPreview: 'link-preview',
  // Extract a normalized peak envelope (number[]) from a capture's audio for the
  // Media Library waveform scrubber. Computed in main (fetch can't read media://).
  mediaWaveform: 'media-waveform',
  // Chat with the media library: ask a question about your captures. Returns a
  // MediaChatResult with the LLM answer + cited folder paths.
  mediaChatWith: 'media-chat-with',
  // Opt-in toggle: include the user's own macOS screenshots/recordings in the
  // library. Get reads the pref; set writes it (the renderer re-lists after).
  mediaGetOsScreenshots: 'media-get-os-screenshots',
  mediaSetOsScreenshots: 'media-set-os-screenshots',
  analyticsRequest: 'analytics-request',
  analyticsInsight: 'analytics-insight',
  analyticsInitialRange: 'analytics-initial-range',
  openPath: 'open-path',
  openMedia: 'open-media',
  // Open an http(s) URL in the user's default browser (markdown links in answers).
  openExternal: 'open-external',
  linkMenu: 'link-menu',
  nativeMenu: 'native-menu',

  // ── Mighty (standing personal agent, ?window=mighty) ───────────────────────
  openMightyWindow: 'open-mighty-window',
  // Panel → main: open Mighty on the Code tab (the panel's Code button).
  openMightyCode: 'open-mighty-code',
  // Chat: send one message; returns a MightyChatResult (reply + sessionId + artifacts).
  mightyChat: 'mighty-chat',
  // Sessions: list summaries, fetch one full session, start a new one.
  navigatorRun: 'navigator-run',
  navigatorClose: 'navigator-close',
  navigatorSearch: 'navigator-search',
  mightyListSessions: 'mighty-list-sessions',
  mightyGetSession: 'mighty-get-session',
  mightyRunTerminal: 'mighty-run-terminal',
  mightyNewSession: 'mighty-new-session',
  mightyDeleteSession: 'mighty-delete-session',
  // Jobs: list, create/update, delete, run-now.
  mightyListJobs: 'mighty-list-jobs',
  mightyUpsertJob: 'mighty-upsert-job',
  mightyDeleteJob: 'mighty-delete-job',
  mightyRunJob: 'mighty-run-job',
  // Registry ("Made"): list created artifacts, remove one (also deletes the file).
  mightyListRegistry: 'mighty-list-registry',
  mightyDeleteArtifact: 'mighty-delete-artifact',
  // Reveal an artifact in Finder.
  mightyReveal: 'mighty-reveal',
  // Smart-open an artifact: HTML opens in the in-app viewer window, anything else
  // reveals in Finder.
  mightyOpenArtifact: 'mighty-open-artifact',
  // Mighty user settings (persona name, custom instructions, default output format).
  mightyGetSettings: 'mighty-get-settings',
  mightySetSettings: 'mighty-set-settings',
  // Global custom instructions (text + per-mode appliesTo toggles: rewrite/ask/act/mighty).
  globalInstructionsGet: 'global-instructions-get',
  globalInstructionsSet: 'global-instructions-set',
  // Chat view mode: render replies as formatted Markdown vs raw source text.
  mightyGetRenderMarkup: 'mighty-get-render-markup',
  mightySetRenderMarkup: 'mighty-set-render-markup',
  // "Read answers aloud" — voice as a mode ON chat. Independent of the companion
  // overlay toggle (settingsSetCompanion); this one makes a TYPED turn speak.
  mightyGetSpeakReplies: 'mighty-get-speak-replies',
  mightySetSpeakReplies: 'mighty-set-speak-replies',
  // Detail mode — a global flag for how much run internals to surface (timing today).
  mightyGetDetailMode: 'mighty-get-detail-mode',
  mightySetDetailMode: 'mighty-set-detail-mode',
  // Window zoom (⌘+ / ⌘- / ⌘0). Main owns the level — it applies it to the
  // webContents and persists it — so the renderer only reads and requests.
  mightyGetZoomLevel: 'mighty-get-zoom-level',
  mightySetZoomLevel: 'mighty-set-zoom-level',
  mightyGetSidebarWidth: 'mighty-get-sidebar-width',
  mightySetSidebarWidth: 'mighty-set-sidebar-width',
  mightyGetSidebarShown: 'mighty-get-sidebar-shown',
  mightySetSidebarShown: 'mighty-set-sidebar-shown',
  mightySetLastMode: 'mighty-set-last-mode',
  mightySetLastCodeSession: 'mighty-set-last-code-session',
  // Mighty chat: whether the right context rail (Outputs / Sources) is shown.
  mightyGetContextRailShown: 'mighty-get-context-rail-shown',
  mightySetContextRailShown: 'mighty-set-context-rail-shown',
  // Mighty chat workspace tab strip (tabs + panes + layout ratios), one JSON blob.
  mightyGetWorkspaces: 'mighty-get-workspaces',
  mightySetWorkspaces: 'mighty-set-workspaces',
  // Reveal a source file (something the user attached, not a registered artifact)
  // in Finder. Separate from mightyReveal, whose trust boundary is the registry.
  mightyRevealSource: 'mighty-reveal-source',
  // Open Mighty's workspace folder in Finder.
  mightyOpenWorkspace: 'mighty-open-workspace',
  // Bring the compact floating panel (hotkey popup) forward from the Mighty window.
  mightyShowPanel: 'mighty-show-panel',
  // Esc escalation, step 1: SIGKILL one pane's in-flight run (payload is its runId).
  // Only that run — sibling panes keep streaming, same contract as hudStopRun.
  mightyStopRun: 'mighty-stop-run',
  // Esc escalation, step 2: hide the chat window once nothing is left running.
  // Hide, not close — the window keeps its sessions and bounds for the next open.
  mightyHide: 'mighty-hide',
  mightyListProjects: 'mighty-list-projects',
  mightyUpsertProject: 'mighty-upsert-project',
  mightyDeleteProject: 'mighty-delete-project',
  mightyProjectsChanged: 'mighty-projects-changed',
  mightyAssignSessionProject: 'mighty-assign-session-project',
  mightyPickProjectFolder: 'mighty-pick-project-folder',
  mightyScanProjectFolder: 'mighty-scan-project-folder',
  mightyMakeProjectFolder: 'mighty-make-project-folder',
  mightyFoundProjects: 'mighty-found-projects',
  mightyImportProjects: 'mighty-import-projects',
  mightyPickProjectImage: 'mighty-pick-project-image',
  mightyClearProjectImage: 'mighty-clear-project-image',
  mightyDiscoverProjectImages: 'mighty-discover-project-images',
  mightySetSessionBackend: 'mighty-set-session-backend',
  mightySetSessionPinned: 'mighty-set-session-pinned',
  mightySetSessionTitle: 'mighty-set-session-title',
  mightySetSessionArchived: 'mighty-set-session-archived',
  mightySetProjectPinned: 'mighty-set-project-pinned',
  // Drop a session's last turn, for regenerate (resend the same q) and edit-resend
  // (resend an edited q) — both replace the tail of turns[] instead of branching.
  mightyTruncateLastTurn: 'mighty-truncate-last-turn',
  // Save a session to a file the user picks, as Markdown or the design's flat JSON shape.
  mightyExportSession: 'mighty-export-session',

  // ── main → renderer (webContents.send) ─────────────────────────────────────
  busyPhase: 'busy-phase',
  mightyPhase: 'mighty-phase',
  mightyEvent: 'mighty-event',
  // main → Mighty window: start a new empty chat now. Sent when the user expands an
  // EMPTY panel into an already-open Mighty window, so it clears to a fresh chat.
  mightyStartFresh: 'mighty-start-fresh',
  // main → Mighty window: switch to this session id now. Sent when the panel hands
  // off a live conversation into an ALREADY-OPEN Mighty window (a freshly-created
  // window instead gets the id via the ?session= query param).
  mightyOpenSession: 'mighty-open-session',
  // main → Mighty window: switch to the Code tab now. The already-open twin of
  // the ?tab=code query param a fresh window gets.
  mightyFocusCode: 'mighty-focus-code',
  // renderer → main: the session a voice pick just started, once, so the Code tab opens on it.
  codeTakeStartedAgent: 'code-take-started-agent',
  codeStartupPeek: 'code-startup-peek',
  codeStartupAnswer: 'code-startup-answer',
  // main → Mighty window: the zoom level changed. Fired for EVERY route (menu
  // ⌘+/⌘-/⌘0, trackpad pinch, or our own IPC), because main is the only place
  // that sees them all — the renderer can't observe a menu-driven zoom itself.
  mightyZoomChanged: 'mighty-zoom-changed',
  // main → Mighty window: ⌘+/⌘-/⌘0, so the renderer zooms the pane under the pointer.
  mightyZoomKey: 'mighty-zoom-key',
  // main → Mighty window AND Panel: a turn was just appended to a Mighty session
  // (live ask-mode answer, or a handed-off panel turn). If the receiving window is
  // showing that session, it re-fetches so the pending bubble fills in live.
  mightyTurnAppended: 'mighty-turn-appended',
  showAnswer: 'show-answer',
  // Act run finished while the panel was open: render the summary + reveal button
  // inline (the act analog of showAnswer, which carries a Q/A pair).
  showActResult: 'show-act-result',
  showError: 'show-error',
  // main → Panel, pushed once after a proactive startup health probe finds the
  // active backend CLI missing/broken. Dismissible banner, not a run failure.
  backendHealthWarning: 'backend-health-warning',
  // main → setup window, one per progress tick while a fix runs. Carries a
  // plain-English line only — raw tool output is where the forbidden
  // vocabulary lives, so it never crosses this boundary.
  setupFixProgress: 'setup-fix-progress',
  historyData: 'history-data',
  hudUpdate: 'hud-update',
  hudInit: 'hud-init',
  hudDone: 'hud-done',
  // Voice routing: main → routing-card renderer, the ranked destinations for a
  // finished recording. Payload is VoiceRoutePayload.
  voiceRouteInit: 'voice-route-init',
  // Main → routing-card renderer: the card is up but the ranking is still out.
  // Payload is VoiceRoutePendingPayload; voiceRouteInit replaces it.
  voiceRoutePending: 'voice-route-pending',
  // The window is hidden and reused, so the renderer clears its state here.
  voiceRouteReset: 'voice-route-reset',
  voiceRouteSearchOpen: 'voice-route-search-open',
  // Main → routing-card renderer: delivery finished, show the result then fade.
  voiceRouteResult: 'voice-route-result',
  voiceRouteEnhanced: 'voice-route-enhanced',
  actionCardShow: 'action-card-show',
  actionChordMods: 'action-chord-mods',
  actionResult: 'action-result',
  actionStep: 'action-step',
  // Run Transcript Inspector: main → inspector renderer push, one per RunEvent as
  // it streams (tool call w/ full input/output, thinking, text, usage). Payload is
  // TranscriptEventPayload ({ runId, event }).
  transcriptEvent: 'transcript-event',
  // Dynamic Island: main → island renderer push on every activity state change.
  islandActivity: 'island-activity',
  // Island drag: renderer → main. A screen-space DELTA, not a point (the window is
  // the drag surface, so its own movement would poison an absolute reading).
  islandMove: 'island-move',
  islandResetPosition: 'island-reset-position',
  playSound: 'play-sound',
  speakText: 'speak-text',
  kokoroInstall: 'kokoro-install',
  kokoroProgress: 'kokoro-progress',
  kokoroRemove: 'kokoro-remove',
  kokoroStatus: 'kokoro-status',
  cursorPos: 'cursor-pos',
  cursorStyle: 'cursor-style',
  // Act-mode highlight box: main → highlight overlay. Tells the overlay to flash
  // a dashed box at an absolute screen rect (window-local coords, same space as
  // cursorFlyTo). Payload is HighlightBoxPayload ({ x, y, w, h }).
  actHighlight: 'act-highlight',
  inkOp: 'ink-op',
  // Dev-only: Playground's "flash it now" button asks main to fire
  // flashHighlightBox at the current cursor position, so the overlay can be
  // demoed without a real act-mode run. No-ops outside IS_DEV.
  devFlashHighlight: 'dev-flash-highlight',
  // Computer-use "agent cursor": main → agent-cursor overlay. Glide the drawn
  // pointer to an absolute screen point and play the kind-specific cue (press
  // ripple for click, caret blink for type). Payload is AgentCursorTarget.
  agentCursorShow: 'agent-cursor-show',
  // Fade the agent cursor out at run end. The overlay window is kept alive for reuse.
  agentCursorHide: 'agent-cursor-hide',
  agentCursorHover: 'agent-cursor-hover',
  agentCursorControl: 'agent-cursor-control',
  computerUseStatus: 'computer-use-status',
  computerUseControl: 'computer-use-control',
  // Dev-only: Playground's agent-cursor demo drives showAgentCursor through a
  // fixed 4-point sequence without a real computer-use run. No-ops outside IS_DEV.
  devAgentCursorDemo: 'dev-agent-cursor-demo',
  // "Point at" feature: main → cursor overlay. Tells the glyph to glide to an
  // absolute screen point and pulse, then release back to following the cursor.
  // Payload is screen-logical coords (same space as cursorPos' source).
  cursorFlyTo: 'cursor-fly-to',
  // Whether the animated pointer art should draw. The overlay window also hosts
  // the suggestion bubble, so it can be UP for insights while the companion is
  // OFF — in that case the pointer must stay hidden (no uninvited trailing art).
  cursorPointerEnabled: 'cursor-pointer-enabled',
  // Snapshot at mount: overlay → main. Every other cursor channel is a one-way
  // push, so any state sent before the renderer's effects subscribed was dropped
  // silently and the art never drew until a restart. The overlay now PULLS its
  // startup state (style + pointer-on) once it's listening; the pushes above stay
  // for live updates. Same "snapshot at open, push to keep it live" shape as
  // agentRelayGetRequests.
  cursorGetState: 'cursor-get-state',
  // Experimental idle suggestions: main → cursor overlay. Sends a list of
  // suggestions to show in the bubble (empty list = hide it).
  cursorSuggest: 'cursor-suggest',
  // Suggestion bubble dismiss from its ✕ button: cursor overlay → main. Records
  // the shown set as dismissed and hides the bubble (same as Esc).
  cursorDismiss: 'cursor-dismiss',
  // The overlay is click-through by default; the bubble flips this on while it's
  // showing so the ✕ is clickable, then back off so clicks pass through again.
  cursorSetClickable: 'cursor-set-clickable',
  cursorSetFocusable: 'cursor-set-focusable',
  // HUD-style cancel: bare Esc on a live bubble arms it (main → overlay), which
  // reveals the "⏎ to cancel" hint; Enter then confirms via cursorDismiss.
  cursorCancelArm: 'cursor-cancel-arm',
  // Clicking a suggestion chip in the bubble: overlay → main. Runs that suggestion
  // (same path as the ⌘1/2/3 global keys) and hides the bubble.
  cursorAccept: 'cursor-accept',
  modelDownloadProgress: 'model-download-progress',
  authChanged: 'auth-changed',
  // Re-trigger over a new app while the panel is already open: main re-captures
  // context + selection and pushes a fresh first-frame payload so the panel
  // overrides its stale context instead of keeping the previous app's.
  panelReseed: 'panel-reseed',
  // Main → renderer push when Incognito mode flips (tray or Settings), so the
  // panel's "not logging" badge updates live without a reseed/remount.
  incognitoChanged: 'incognito-changed',
  // Main → renderer push when "View as user" flips (tray or Settings), so every
  // open window hides/shows its admin surfaces together instead of drifting.
  viewAsUserChanged: 'view-as-user-changed',
  // Main → renderer push when the chosen backend/model changes (Settings, or a
  // resumed conversation re-adopting its original backend), so every open
  // window's model chip updates live instead of only refreshing on next mount/focus.
  backendChanged: 'backend-changed',
  modelCatalogGet: 'model-catalog-get',
  modelCatalogChanged: 'model-catalog-changed',

  // ── Billing (mightymouse backend) ──────────────────────────────────────────
  // Renderer invokes get/checkout; main pushes balance-changed on proxy response.
  billingGetBalance: 'billing-get-balance',
  billingOpenCheckout: 'billing-open-checkout',
  billingBalanceChanged: 'billing-balance-changed',
  // Renderer pulls the user's recent billed calls for the Settings → Usage list.
  billingListUsage: 'billing-list-usage',
  // Opens the Stripe Customer Portal (manage/cancel a subscription, update card).
  billingOpenPortal: 'billing-open-portal',
  // Renderer pulls the signed-in user's current subscription (status/plan/renewal).
  billingGetSubscription: 'billing-get-subscription',
  billingGetUsage: 'billing-get-usage',
  // Renderer asks whether the Lifetime offer is buyable right now. Server-decided
  // (billing_config is not client-readable), so the UI just renders the answer.
  billingGetLifetimeOffer: 'billing-get-lifetime-offer',
  // Main → renderer push fired when the mightymouse:// checkout deep link returns
  // (Stripe success/cancel). Lets Settings show a result without polling.
  billingCheckoutReturn: 'billing-checkout-return',

  keysScan: 'keys-scan',
  keysList: 'keys-list',
  keysSet: 'keys-set',
  keysUpdate: 'keys-update',
  keysRemove: 'keys-remove',
  keysProbe: 'keys-probe',
  // Copies the value to the clipboard inside main; the renderer never sees a value.
  keysCopy: 'keys-copy',
  keysChanged: 'keys-changed',

  infraList: 'infra-list',
  infraCheck: 'infra-check',
  infraAdd: 'infra-add',
  infraRemove: 'infra-remove',
  infraSkip: 'infra-skip',
  infraWant: 'infra-want',
  infraTags: 'infra-tags',
  infraBrief: 'infra-brief',
  infraBriefDraft: 'infra-brief-draft',
  infraSetup: 'infra-setup',
  infraChanged: 'infra-changed',
  siteGet: 'site-get',
  sitePublish: 'site-publish',
  siteUnpublish: 'site-unpublish',
  siteProgress: 'site-progress',

  reportsGet: 'reports-get',
  reportsRefresh: 'reports-refresh',
  reportsChanged: 'reports-changed',

  builtList: 'built-list',
  builtOpen: 'built-open',
  builtHide: 'built-hide',
  builtFavorite: 'built-favorite',
  builtTag: 'built-tag',
  builtStop: 'built-stop',
  builtStart: 'built-start',
  builtChanged: 'built-changed',

  // ── Auto-update (electron-updater) ─────────────────────────────────────────
  // Renderer invokes check/download/install; main pushes update-status on every
  // electron-updater lifecycle event (checking → available → progress → … / error).
  updateCheck: 'update-check',
  updateDownload: 'update-download',
  updateInstall: 'update-install',
  updateOpenReleasePage: 'update-open-release-page',
  updateStatus: 'update-status',
  // Pull the cached state on mount. updateStatus is push-only, so a window opened
  // AFTER 'downloaded' fired would otherwise never learn an update is waiting.
  updateGetState: 'update-get-state',

  devUnpinForError: 'dev-unpin-for-error',

  resourcesSnapshot: 'resources-snapshot',
  // Main → resources window. Cached snapshot on open, then ~1s while it is visible.
  resourcesUpdated: 'resources-updated',
  resourcesAsk: 'resources-ask',
  resourcesAskDraft: 'resources-ask-draft',
  sideBrowserOpen: 'side-browser-open',
  sideBrowserNavigate: 'side-browser-navigate',
  sideBrowserCommand: 'side-browser-command',
  sideBrowserPlace: 'side-browser-place',
  sideBrowserStill: 'side-browser-still',
  sideBrowserClose: 'side-browser-close',
  sideBrowserPermission: 'side-browser-permission',
  sideBrowserLocation: 'side-browser-location',
  sideBrowserFind: 'side-browser-find',
  sideBrowserState: 'side-browser-state',
  sideBrowserStopAgent: 'side-browser-stop-agent',
  sideBrowserPauseAgent: 'side-browser-pause-agent',
  sideBrowserPopup: 'side-browser-popup',
  sideBrowserPageAction: 'side-browser-page-action',
  sideBrowserShortcut: 'side-browser-shortcut',
  sideBrowserOpenUrl: 'side-browser-open-url',
  sideBrowserTakeUrl: 'side-browser-take-url',
  sideBrowserImportSources: 'side-browser-import-sources',
  sideBrowserImportCookies: 'side-browser-import-cookies',
  sideBrowserSuggest: 'side-browser-suggest',
  sideBrowserTopSites: 'side-browser-top-sites',
  sideBrowserRecent: 'side-browser-recent',
  sideBrowserForgetRecent: 'side-browser-forget-recent',
  sideBrowserForgetTopSite: 'side-browser-forget-top-site',
  sideBrowserAnnotate: 'side-browser-annotate',
  sideBrowserAnnotateEnd: 'side-browser-annotate-end',
  sideBrowserMod: 'side-browser-mod',
  sideBrowserSharedMod: 'side-browser-shared-mod',
  // Origin comes from event.senderFrame in side-browser-passkeys.ts, never the payload.
  sideBrowserPasskey: 'side-browser-passkey',
  browserTaskRun: 'browser-task-run',
  browserTaskProgress: 'browser-task-progress',
  browserTaskControl: 'browser-task-control',
  browserTaskModels: 'browser-task-models',
  browserTaskSetModel: 'browser-task-set-model',
  filesRead: 'files-read',
  filesWrite: 'files-write',
  filesWatch: 'files-watch',
  filesChanged: 'files-changed',
  filesList: 'files-list'
} as const)

export type ChannelKey = keyof typeof CHANNELS
export type ChannelName = (typeof CHANNELS)[ChannelKey]
