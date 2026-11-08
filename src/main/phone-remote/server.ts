/**
 * Stable Phone Remote server entry point.
 *
 * HTTP routes and WebSocket protocol handling are split behind this public
 * facade so existing main-process callers keep one import path.
 */
export {
  activeDeviceId,
  certCoversLanIp,
  closeApprovalWindow,
  currentPairingCode,
  currentPairingCodeExpiresAt,
  decideObserver,
  decideTakeover,
  forgetPairedDevices,
  getLanAddress,
  getPairedDeviceCount,
  isPhoneConnected,
  isPhoneRemoteRunning,
  isPhoneRun,
  issuePairingCode,
  listPairedDevices,
  markMirrorMediaEnded,
  openApprovalWindow,
  pushableDevice,
  resolveApproval,
  revokeActiveDevice,
  revokePairedDevice,
  sendBinaryToPhone,
  sendDictationHistory,
  sendToPhone,
  setHistoryReader,
  startPhoneRemoteServer,
  stopPhoneRemoteServer
} from './server-runtime'

export type {
  DictationEntry,
  DictationPage,
  PhoneRemoteCallbacks,
  PhoneRemoteMessage
} from './server-runtime'
