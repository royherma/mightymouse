/**
 * Phone Remote -- system volume (debounced writes), sensitivity, host keyboard
 * detection, and the layout-prefs snapshot pushed to the phone on any pref flip.
 */
import { CONFIG } from '../../shared/config'
import { HOST_KEYBOARD, type HostDevice, type HostKeyboard } from '../../shared/phone-remote-keys'
import {
  type InstallableSkin,
  type PhoneRemoteColorScheme,
  type PhoneRemoteHandedness,
  type PhoneRemoteKeysPosition,
  type PhoneRemoteDeckMode,
  type PhoneRemoteSplitConcept,
  type PhoneRemoteMirrorPlacement,
  isPhoneRemoteSplitConcept,
  isPhoneRemoteMirrorPlacement
} from '../../shared/types'
import { PREFS } from '../store/prefs'
import { setCursorCompanion } from '../cursor-window'
import { sendToPhone } from '../phone-remote/server'
import { PERMISSIONS, input, system, clampVolume, type HostKeyboardLayoutType } from '../platform'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import type { PhoneRemoteMessage } from '../../shared/phone-remote-protocol'
import { sendFirstStepsToPhone } from './phone-first-steps'

let pendingVolume: number | null = null
let volumeWriteTimer: NodeJS.Timeout | null = null
let volumeWriteInFlight = false

export function flushVolume(): void {
  volumeWriteTimer = null
  if (pendingVolume === null) return
  const value = pendingVolume
  pendingVolume = null
  volumeWriteInFlight = true
  void system.setSystemVolume(value).finally(() => {
    volumeWriteInFlight = false
    // Keep the window open for the interval after a write, so the NEXT move in a
    // continuous drag lands on the trailing edge instead of spawning immediately.
    volumeWriteTimer = setTimeout(flushVolume, CONFIG.PHONE_REMOTE.VOLUME_WRITE_INTERVAL_MS)
  })
}

export function queueSystemVolume(value: number): void {
  pendingVolume = clampVolume(value)
  // Leading edge: the first move of a drag applies at once, so the slider feels
  // attached to the finger rather than lagging by one interval.
  if (volumeWriteTimer === null && !volumeWriteInFlight) flushVolume()
}

export function sendSystemVolumeToPhone(): void {
  const state = system.getSystemVolume()
  sendToPhone({
    type: 'systemVolume',
    volume: state ? state.volume : null,
    muted: state ? state.muted : false
  })
}

export function sendSensitivityToPhone(): void {
  sendToPhone({
    type: 'sensitivity',
    value: PREFS.getPhoneRemoteSensitivity(),
    min: CONFIG.PHONE_REMOTE.SENSITIVITY_MIN,
    max: CONFIG.PHONE_REMOTE.SENSITIVITY_MAX
  })
}

let hostKeyboardType: HostKeyboardLayoutType | null = null

/** ISO is the only board that draws differently (one extra key left of Z). JIS
 *  has its own extra keys we don't model yet, so it rides the ANSI layout --
 *  wrong in the same way it is today, not newly wrong. */
function hostKeyboardFromType(type: HostKeyboardLayoutType | null): HostKeyboard {
  return type === 'iso' ? HOST_KEYBOARD.macIso : HOST_KEYBOARD.mac
}

/** Probe the attached keyboard and, if it changed the answer, tell the phone.
 *  Called at server start; cheap after the first call (mm-input caches). */
export async function warmHostKeyboardType(): Promise<void> {
  if (process.platform !== 'darwin') return
  const next = await input.detectHostKeyboardType()
  if (next === hostKeyboardType) return
  hostKeyboardType = next
  sendLayoutPrefsToPhone()
}

let hostDevice: HostDevice | null = null
let hostDeviceProbe: Promise<void> | null = null

export function warmHostDevice(): Promise<void> {
  if (hostDevice || process.platform !== 'darwin') return Promise.resolve()
  hostDeviceProbe ??= system.getHostDevice().then((found) => {
    hostDevice = found
    hostDeviceProbe = null
    if (found) sendLayoutPrefsToPhone()
  })
  return hostDeviceProbe
}

export function layoutPrefsSnapshot(): {
  skin: InstallableSkin
  colorScheme: PhoneRemoteColorScheme
  handedness: PhoneRemoteHandedness
  keysPosition: PhoneRemoteKeysPosition
  deckMode: PhoneRemoteDeckMode
  splitConcept: PhoneRemoteSplitConcept
  mirrorPlacement: PhoneRemoteMirrorPlacement
  showCursor: boolean
  appRing: boolean
  renderMarkup: boolean
  hostKeyboard: HostKeyboard
  hostDevice?: HostDevice
} {
  if (!hostDevice) void warmHostDevice()
  return {
    skin: PREFS.getPhoneRemoteSkin(),
    colorScheme: PREFS.getPhoneRemoteColorScheme(),
    handedness: PREFS.getPhoneRemoteHandedness(),
    keysPosition: PREFS.getPhoneRemoteKeysPosition(),
    deckMode: PREFS.getPhoneRemoteDeckMode(),
    splitConcept: PREFS.getPhoneRemoteSplitConcept(),
    mirrorPlacement: PREFS.getPhoneRemoteMirrorPlacement(),
    showCursor: PREFS.getPhoneRemoteShowCursor(),
    appRing: PREFS.getPhoneRemoteAppRing(),
    // Deliberately the MIGHTY pref, not a phone-scoped one: the same switch backs
    // the Mac's Mighty window, so rendered/raw is one decision the user makes
    // once wherever they happen to be looking.
    renderMarkup: PREFS.getMightyRenderMarkup(),
    hostKeyboard:
      process.platform === 'darwin'
        ? hostKeyboardFromType(hostKeyboardType)
        : HOST_KEYBOARD.generic,
    hostDevice: hostDevice ?? undefined
  }
}

/** Exported so a setting that lives OUTSIDE the phone section can still reach a
 *  connected phone the moment it flips. */
export function sendLayoutPrefsToPhone(): void {
  sendToPhone({ type: 'layoutPrefs', ...layoutPrefsSnapshot() })
}

type Msg<T extends PhoneRemoteMessage['type']> = Extract<PhoneRemoteMessage, { type: T }>

export function handleGetSensitivity(): void {
  sendSensitivityToPhone()
}

export function handleSetSensitivity(msg: Msg<'setSensitivity'>): void {
  PREFS.setPhoneRemoteSensitivity(msg.value)
  // Echo back the clamped value so the phone's slider snaps to whatever
  // was actually persisted, not whatever the user dragged past the ends.
  sendSensitivityToPhone()
}

export function sendCursorAppearanceToPhone(): void {
  sendToPhone({
    type: 'cursorAppearance',
    ...input.getCursorAppearance(),
    animated: PREFS.getCursorCompanion()
  })
}

export function handleSetCursorSize(msg: Msg<'setCursorSize'>): void {
  input.setCursorSize(msg.value)
  sendCursorAppearanceToPhone()
}

export function handleSetCursorAnimated(msg: Msg<'setCursorAnimated'>): void {
  const next = msg.value === true
  PREFS.setCursorCompanion(next)
  setCursorCompanion(next)
  track(ANALYTICS_EVENT.setting_toggled, { key: 'cursor_companion', value: String(next) })
  sendCursorAppearanceToPhone()
}

export function handleGetLayoutPrefs(sendPermissionState: () => void): void {
  sendLayoutPrefsToPhone()
  // Rides the connect-time burst so a phone joining a Mac that already
  // lacks Accessibility shows the fix immediately, instead of after the
  // user taps something and gets nothing.
  sendPermissionState()
  sendFirstStepsToPhone()
}

export function handleSetSkin(msg: Msg<'setSkin'>): void {
  PREFS.setPhoneRemoteSkin(msg.value)
  // Which skins get picked is the whole case for (or against) a skins
  // marketplace — without this the only measurable fact is that the default
  // exists. Fired on the SET, not the read, so it counts deliberate choices.
  track(ANALYTICS_EVENT.setting_toggled, {
    key: 'phone_remote_skin',
    value: msg.value
  })
  sendLayoutPrefsToPhone()
}

export function handleSetColorScheme(msg: Msg<'setColorScheme'>): void {
  PREFS.setPhoneRemoteColorScheme(msg.value)
  sendLayoutPrefsToPhone()
}

export function handleSetHandedness(msg: Msg<'setHandedness'>): void {
  PREFS.setPhoneRemoteHandedness(msg.value)
  sendLayoutPrefsToPhone()
}

export function handleSetKeysPosition(msg: Msg<'setKeysPosition'>): void {
  PREFS.setPhoneRemoteKeysPosition(msg.value)
  sendLayoutPrefsToPhone()
}

export function handleSetDeckMode(msg: Msg<'setDeckMode'>): void {
  PREFS.setPhoneRemoteDeckMode(msg.value)
  sendLayoutPrefsToPhone()
}

export function handleSetSplitConcept(msg: Msg<'setSplitConcept'>): void {
  if (!isPhoneRemoteSplitConcept(msg.value)) return
  PREFS.setPhoneRemoteSplitConcept(msg.value)
  sendLayoutPrefsToPhone()
}

export function handleSetMirrorPlacement(msg: Msg<'setMirrorPlacement'>): void {
  if (!isPhoneRemoteMirrorPlacement(msg.value)) return
  PREFS.setPhoneRemoteMirrorPlacement(msg.value)
  sendLayoutPrefsToPhone()
}

export function handleSetShowCursor(msg: Msg<'setShowCursor'>): void {
  PREFS.setPhoneRemoteShowCursor(msg.value)
  sendLayoutPrefsToPhone()
  // No stream to start/stop: the overlay is drawn from the phone's own
  // touch coordinates, so the pref only has to reach the phone.
}

export function handleSetAppRing(msg: Msg<'setAppRing'>): void {
  PREFS.setPhoneRemoteAppRing(msg.value)
  sendLayoutPrefsToPhone()
  // Purely a phone-side surface: it activates apps through the existing
  // appSwitchActivate path, so nothing here needs to start or stop.
}

export function handleSetRenderMarkup(msg: Msg<'setRenderMarkup'>): void {
  // Writes the SHARED Mighty pref -- an open Mac window reads it on its next
  // mount rather than live, which is fine: this is a display preference, not
  // state a run depends on.
  PREFS.setMightyRenderMarkup(msg.value)
  sendLayoutPrefsToPhone()
}

// Deliberately NOT gated on phoneMayControlMac -- this is the one message
// whose whole job is fixing that permission, so gating it would make the
// recovery unreachable exactly when it's needed.
export function handleOpenAccessibilitySettings(): void {
  PERMISSIONS.openPane('accessibility')
}

export function handleSetSystemVolume(msg: Msg<'setSystemVolume'>): void {
  // Never trust a wire number: clampVolume also rejects NaN/Infinity, which
  // would otherwise interpolate straight into the osascript source.
  if (typeof msg.volume !== 'number') return
  queueSystemVolume(msg.volume)
}

export function handleGetSystemVolume(): void {
  sendSystemVolumeToPhone()
}
