/**
 * Phone Remote — msg.type -> handler dispatch table. Replaces
 * the inline switch that used to live in phone-remote.ts's handlePhoneMessage.
 * C9c finishes the migration: every message type now resolves here, so
 * handlePhoneMessage no longer falls through to any switch at all.
 */
import type { PhoneRemoteMessage } from '../../shared/phone-remote-protocol'
import { resolvePhotoAnswer } from '../agent-relay/photo-search'
import {
  handleMove,
  handleCenterCursor,
  handleTap,
  handleTwoFingerTap,
  handleDoubleTap,
  handleDragStart,
  handleDragMove,
  handleDragEnd,
  handleScroll,
  handleMirrorWarp,
  handlePasteClipboard,
  handleAppActivateItem,
  handleAppActivateGroup,
  handleAppActivatePane,
  handlePressKey,
  handlePadGesture,
  handlePadZoom,
  handleTmuxAction,
  handleTypeText,
  handleDeleteText
} from './phone-remote-pointer'
import {
  handleGetDictationHistory,
  handlePasteDictation,
  handleActDictation,
  handleAudioCancel,
  handleStopRun
} from './phone-remote-audio'
import {
  handleGetSensitivity,
  handleSetSensitivity,
  handleSetCursorSize,
  handleSetCursorAnimated,
  handleGetLayoutPrefs,
  handleSetSkin,
  handleSetColorScheme,
  handleSetHandedness,
  handleSetKeysPosition,
  handleSetDeckMode,
  handleSetSplitConcept,
  handleSetMirrorPlacement,
  handleSetShowCursor,
  handleSetAppRing,
  handleSetRenderMarkup,
  handleOpenAccessibilitySettings,
  handleSetSystemVolume,
  handleGetSystemVolume
} from './phone-remote-prefs'
import { sendEnvToPhone, applyEnvSwitch } from './phone-remote-env'
import {
  handleApprovalVerdict,
  handleUnpairSelf,
  handleDebugLog
} from './phone-remote-pairing-ui'
import {
  handleWindowLayout,
  handleAppSwitchOpen,
  handleAppSwitchActivate,
  handleAppSwitchMru,
  handleAppSwitchQuick,
  handleAppContext,
  handleClipboardState
} from './phone-remote-context'
import { handleGetReferralCode, handleSendInvite } from './phone-remote-share'
import { handleInk } from './phone-remote-ink'
import {
  handleMirrorStart,
  handleMirrorSetAudio,
  handlePhoneMicSet,
  handleMirrorIceCandidate,
  handleMirrorStop,
  handlePipStreamStart,
  handlePipStreamStop,
  handlePipStreamSetPlaying,
  handleMirrorDiag,
  handleMirrorGetIceServers
} from './phone-remote-mirror'
import {
  handleChatListSessions,
  handleChatGetModels,
  handleChatSetModel,
  handleChatGetSession,
  handleChatSendMsg,
  handleRelayRespond,
  handleRelayTapTrace,
  handleRelayUndismiss,
  handleRelayGetPushFilter,
  handleRelaySetPushFilter,
  handleRelaySetNotifyLevel,
  handleRelaySetTurnEndPing,
  handleRelaySessionPeek,
  handleRelaySessionReply,
  handleRelaySessionStop,
  handleRelaySessionSentGet,
  handleRelaySessionReveal,
  handleRelaySessionZoom,
  handleRelaySuggest,
  handleRelaySessionWrap,
  handleChatStop
} from './phone-remote-chat'
import {
  importAgentSessionArchive,
  markAgentSession,
  setRelayPushVerb,
  setRelayNotifyLevel,
  setRelayTurnEndPing
} from './agent-relay'
import {
  handleRelayProjectIdeas,
  handleRelayProjects,
  handleRelaySessionInfo,
  handleRelaySessionGit,
  handlePulseGet,
  handlePulseScore,
  handlePulseSetScope,
  handleRelaySessionTranscript,
  handleRelaySessionUndo,
  handleRelayStartSession,
  handleCodeGetModels,
  handleCodeSetModel
} from './phone-remote-ai'
import { phoneMayControlMac, sendPermissionState, getConnectedLabel } from './phone-remote'
import { notePhoneMicDenied, notePhoneWelcomePick } from './phone-first-steps'

type Handler<T extends PhoneRemoteMessage['type']> = (
  msg: Extract<PhoneRemoteMessage, { type: T }>
) => void

// Every message type is present here now -- handlePhoneMessage in
// phone-remote.ts calls this unconditionally and returns, no fallback switch.
export const PHONE_MESSAGE_HANDLERS: { [T in PhoneRemoteMessage['type']]: Handler<T> } = {
  move: handleMove,
  centerCursor: handleCenterCursor,
  tap: handleTap,
  twoFingerTap: handleTwoFingerTap,
  doubleTap: handleDoubleTap,
  dragStart: handleDragStart,
  dragMove: handleDragMove,
  dragEnd: handleDragEnd,
  scroll: handleScroll,
  mirrorWarp: handleMirrorWarp,
  ink: handleInk,
  getDictationHistory: handleGetDictationHistory,
  pasteDictation: handlePasteDictation,
  actDictation: handleActDictation,
  audioCancel: handleAudioCancel,
  // Answers to a Mac-initiated photos* event. They resolve a parked promise
  // rather than doing anything themselves, so an answer whose requestId nobody
  // is waiting on is dropped inside the broker.
  photosSearchResult: (msg) =>
    void resolvePhotoAnswer(
      msg.requestId,
      { scope: msg.scope, matched: msg.matched, photos: msg.photos },
      'search'
    ),
  photosAccessResult: (msg) => void resolvePhotoAnswer(msg.requestId, msg.scope, 'access'),
  photosFetchFailed: (msg) => void resolvePhotoAnswer(msg.requestId, null, 'fetch'),
  stopRun: handleStopRun,
  getSensitivity: handleGetSensitivity,
  setSensitivity: handleSetSensitivity,
  setCursorSize: handleSetCursorSize,
  setCursorAnimated: handleSetCursorAnimated,
  getEnv: () => void sendEnvToPhone(),
  setEnv: (msg) => void applyEnvSwitch(msg.value),
  approvalVerdict: handleApprovalVerdict,
  unpairSelf: handleUnpairSelf,
  getLayoutPrefs: () => handleGetLayoutPrefs(sendPermissionState),
  setSkin: handleSetSkin,
  setColorScheme: handleSetColorScheme,
  setHandedness: handleSetHandedness,
  setKeysPosition: handleSetKeysPosition,
  setDeckMode: handleSetDeckMode,
  setSplitConcept: handleSetSplitConcept,
  setMirrorPlacement: handleSetMirrorPlacement,
  setShowCursor: handleSetShowCursor,
  setAppRing: handleSetAppRing,
  setRenderMarkup: handleSetRenderMarkup,
  openAccessibilitySettings: () => handleOpenAccessibilitySettings(),
  micDenied: notePhoneMicDenied,
  welcomePick: (msg) => notePhoneWelcomePick(msg.pick),
  windowLayout: (msg) => handleWindowLayout(msg, phoneMayControlMac),
  appSwitchOpen: () => handleAppSwitchOpen(phoneMayControlMac),
  appSwitchActivate: (msg) => handleAppSwitchActivate(msg, phoneMayControlMac),
  appSwitchMru: () => handleAppSwitchMru(phoneMayControlMac),
  appSwitchQuick: (msg) => handleAppSwitchQuick(msg, phoneMayControlMac),
  appContext: () => handleAppContext(phoneMayControlMac),
  clipboardState: () => handleClipboardState(),
  pasteClipboard: handlePasteClipboard,
  appActivateItem: handleAppActivateItem,
  appActivateGroup: handleAppActivateGroup,
  appActivatePane: handleAppActivatePane,
  pressKey: handlePressKey,
  padGesture: handlePadGesture,
  padZoom: handlePadZoom,
  tmuxAction: handleTmuxAction,
  typeText: handleTypeText,
  deleteText: handleDeleteText,
  getReferralCode: () => handleGetReferralCode(),
  sendInvite: handleSendInvite,
  debugLog: (msg) => handleDebugLog(msg, getConnectedLabel()),
  // Both consumed in server.ts, which stashes them for the binary frame that
  // follows and returns before calling onMessage.
  audioMeta: () => {},
  imageMeta: () => {},
  mirrorStart: handleMirrorStart,
  mirrorSetAudio: handleMirrorSetAudio,
  phoneMicSet: handlePhoneMicSet,
  setSystemVolume: handleSetSystemVolume,
  getSystemVolume: handleGetSystemVolume,
  mirrorIceCandidate: handleMirrorIceCandidate,
  mirrorStop: handleMirrorStop,
  pipStreamStart: handlePipStreamStart,
  pipStreamStop: handlePipStreamStop,
  pipStreamSetPlaying: handlePipStreamSetPlaying,
  mirrorDiag: handleMirrorDiag,
  mirrorGetIceServers: handleMirrorGetIceServers,
  chatListSessions: handleChatListSessions,
  chatGetSession: handleChatGetSession,
  chatSend: handleChatSendMsg,
  sessionMark: (msg) => markAgentSession(msg.session, msg.change, 'phone'),
  sessionArchiveImport: (msg) => importAgentSessionArchive(msg.entries),
  relayRespond: handleRelayRespond,
  relayTapTrace: handleRelayTapTrace,
  relayUndismiss: handleRelayUndismiss,
  relayGetPushFilter: () => handleRelayGetPushFilter(),
  relaySetPushFilter: (msg) => handleRelaySetPushFilter(msg, setRelayPushVerb),
  relaySetNotifyLevel: (msg) => handleRelaySetNotifyLevel(msg, setRelayNotifyLevel),
  relaySetTurnEndPing: (msg) => handleRelaySetTurnEndPing(msg, setRelayTurnEndPing),
  relaySessionPeek: handleRelaySessionPeek,
  relaySessionReply: handleRelaySessionReply,
  relaySessionStop: handleRelaySessionStop,
  relaySessionSentGet: handleRelaySessionSentGet,
  relaySessionReveal: handleRelaySessionReveal,
  relaySessionZoom: handleRelaySessionZoom,
  relaySuggest: handleRelaySuggest,
  relaySessionWrap: handleRelaySessionWrap,
  relayStartSession: handleRelayStartSession,
  relayProjects: () => handleRelayProjects(),
  relayProjectIdeas: handleRelayProjectIdeas,
  relaySessionTranscript: handleRelaySessionTranscript,
  relaySessionUndo: handleRelaySessionUndo,
  relaySessionInfo: handleRelaySessionInfo,
  relaySessionGit: handleRelaySessionGit,
  pulseGet: handlePulseGet,
  pulseScore: handlePulseScore,
  pulseSetScope: handlePulseSetScope,
  chatStop: handleChatStop,
  modelsGet: (msg) => (msg.scope === 'code' ? void handleCodeGetModels() : handleChatGetModels()),
  modelsSet: (msg) => void (msg.scope === 'code' ? handleCodeSetModel(msg.id) : handleChatSetModel(msg.id)),
  // Both consumed in server.ts, which returns before calling onMessage: the
  // swap and the zoom relay are both defined by WHICH SOCKET asked, and this
  // layer has already lost that.
  requestControl: () => {},
  mirrorViewerZoom: () => {},
  mirrorViewerZoomChanged: () => {},
  mirrorViewerZoomRequest: () => {},
  mirrorViewerPan: () => {}
}

/** Looks up and calls the handler for msg.type. Every PhoneRemoteMessage
 *  type has an entry (see PHONE_MESSAGE_HANDLERS above), so this always
 *  finds one -- the cast matches the lookup to the narrowed msg it came from. */
export function dispatchPhoneMessage(msg: PhoneRemoteMessage): void {
  const handler = PHONE_MESSAGE_HANDLERS[msg.type] as Handler<typeof msg.type>
  handler(msg)
}
