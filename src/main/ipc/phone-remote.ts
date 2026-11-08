/**
 * Phone Remote IPC — glue between the transport (phone-remote/server.ts, which
 * knows nothing about MightyMouse) and the rest of the app. Owns:
 *   - The Settings toggle (start/stop the server, generate the QR).
 *   - Move/tap/two-finger-tap -> runInput() (same trackpad path gaze.ts uses).
 *   - A held/toggled mic recording -> toWav -> transcribe -> clipboard +
 *     pasteText + logCapture, the exact same verbatim-dictation tail plain
 *     Listen uses on stop (see stopListenAndCopy() in capture/index.ts) — no
 *     LLM call, just paste. The card is raised with the same
 *     HUD_MODE.recording + HUD_CAPTURE.listen kind as a keyboard-triggered
 *     Listen, and the run is logged into runs/ + History + Speech analytics
 *     the same way, so it's indistinguishable from a Mac-side Listen.
 * Mirrors registerGazeHandlers()'s shape: one register function, module-level
 * throttle state for the high-frequency move stream.
 */
import { ipcMain } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { PREFS } from '../store/prefs'
import { input } from '../platform'
import { getVirtualDisplay, stopVirtualDisplay } from '../capture/virtual-display'
import type { PhoneRemoteGetPairCodeOpts } from '../../shared/types'
import { sendToSettingsRenderer } from '../settings-window'
import { sendToTourRenderer } from '../tour-window'
import { sendToPhoneRemoteQrRenderer } from '../phone-remote-qr-window'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { devLog } from '../../shared/env'
import { handoffResolver } from '../agent-relay/store'
import { setSuggestProbe, setIdleProbe } from '../agent-relay/mcp/http-listener'
import {
  startPhoneRemoteServer,
  stopPhoneRemoteServer,
  isPhoneRemoteRunning,
  isPhoneConnected,
  sendToPhone,
  currentPairingCode,
  currentPairingCodeExpiresAt,
  issuePairingCode,
  forgetPairedDevices,
  getPairedDeviceCount,
  listPairedDevices,
  revokePairedDevice
} from '../phone-remote/server'
import { deviceIdleDays, isDeviceStale } from '../../shared/paired-device-labels'
import {
  startStayAwake,
  stopStayAwake,
  setPairedDeviceCountSource
} from '../phone-remote/stay-awake'
import { enableClamshell, disableClamshell } from '../phone-remote/clamshell'
import { beginAwayMode, requestCoverNow, handback, isAwayModeHeld } from '../phone-remote/away-mode'
import {
  stopTunnel,
  getTunnelStatus,
  setTunnelStatusListener
} from '../phone-remote/cloudflare-tunnel'
import { refreshWebMacPresence } from '../web-mac-presence'
import { cancelGlide, cancelScrollFlush, endDrag } from './phone-remote-pointer'
import { phoneRemoteCallbacks } from './phone-remote-callbacks'
export {
  phoneRemoteCallbacks,
  getConnectedLabel,
  phoneMayControlMac,
  sendPermissionState
} from './phone-remote-callbacks'
export { applyEnvSwitch } from './phone-remote-env'
export { sendLayoutPrefsToPhone } from './phone-remote-prefs'
import { sendSensitivityToPhone } from './phone-remote-prefs'
import { suggestForSession, suggestProbeForLabel } from './phone-remote-chat'
import {
  buildQrDataUrl,
  buildTunnelUrl,
  buildTunnelUrlAndQr,
  startTunnelIfEnabled,
  broadcastPhoneDevices
} from './phone-remote-pairing-ui'

export async function startPhoneRemoteServerDefault(): Promise<void> {
  const result = await startPhoneRemoteServer(phoneRemoteCallbacks())
  if (!result.ok) {
    devLog.error('Phone Remote: failed to restore on launch', result.reason)
    PREFS.setPhoneRemoteEnabled(false)
    return
  }
  // Always false in practice — a phone cannot have connected to a server that
  // is only now starting — but read rather than hardcoded so this stays honest
  // if the restore path ever runs against an already-listening server.
  if (PREFS.getPhoneRemoteStayAwake()) startStayAwake(isPhoneConnected())
  // Off-Wi-Fi access restores with the server; failure is non-fatal (LAN path
  // still works) and surfaces in Settings via the tunnel status push.
  void startTunnelIfEnabled(result.port)
}

export function registerPhoneRemoteHandlers(): void {
  setSuggestProbe(suggestProbeForLabel)
  setIdleProbe(handoffResolver)
  setPairedDeviceCountSource(getPairedDeviceCount)

  // Registered here rather than agent-relay.ts (which this file imports from)
  // to keep the generator and its handler on the same side of that edge.
  ipcMain.handle(
    CHANNELS.agentRelaySuggest,
    (_e, label: string, context: string, said?: string, fresh?: boolean) =>
      suggestForSession(String(label), String(context), {
        said: typeof said === 'string' ? said : undefined,
        fresh: fresh === true
      })
  )

  ipcMain.handle(CHANNELS.phoneRemoteGetQr, async () => {
    if (!isPhoneRemoteRunning()) return { ok: false, reason: 'not-running' as const }
    // startPhoneRemoteServer is idempotent when already listening (early-
    // returns the bound port, no new bind/no side effects) — reusing it here
    // avoids duplicating the "how do I find my own port" lookup.
    const result = await startPhoneRemoteServer(phoneRemoteCallbacks())
    if (!result.ok) return { ok: false, reason: result.reason }
    const qrDataUrl = await buildQrDataUrl(result.port)
    if (!qrDataUrl) return { ok: false, reason: 'no-lan' as const }
    const tunnelUrl = buildTunnelUrl()
    // `connected` is the CURRENT state, not a transition. A surface that opens
    // while a phone is already live (the tour's pairing step on a returning
    // user) would otherwise wait forever for a broadcast that already fired.
    return { ok: true, qrDataUrl, tunnelUrl, connected: isPhoneConnected() }
  })

  ipcMain.handle(CHANNELS.phoneRemoteSetEnabled, async (_e, on: boolean) => {
    const next = on === true

    if (!next) {
      stopPhoneRemoteServer()
      stopTunnel()
      // Ordering matters: a glide step or a scroll flush firing after
      // stopMoveLoop() writes to a dead process's stdin.
      cancelGlide()
      cancelScrollFlush()
      input.stopMoveLoop()
      // Release the display block with the server it belongs to — leaving it
      // held after the remote is off is the battery leak this module guards.
      stopStayAwake()
      // Clamshell is scoped to an active remote too: turning the remote off is
      // an explicit "I'm done", so the machine-wide flag goes with it (layer 1).
      void disableClamshell()
      // Same for Away Mode — and more urgently, since handing back is what
      // relocks the Mac and uncovers the screen (layer 1).
      void handback()
      endDrag()
      PREFS.setPhoneRemoteEnabled(false)
      track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote', value: 'false' })
      // Tray row prints Off/Waiting/Connected — repaint it on the toggle too,
      // not just on connect (broadcastPhoneStatus doesn't fire for this path).
      void import('../index').then((m) => m.refreshTrayMenu())
      return { ok: true }
    }

    const result = await startPhoneRemoteServer(phoneRemoteCallbacks())

    if (!result.ok) {
      // Never persist an ON pref for a server that failed to start — otherwise
      // the next launch's startAppTail() restore would silently retry-and-fail
      // on every boot with no UI to explain why.
      PREFS.setPhoneRemoteEnabled(false)
      return { ok: false, reason: result.reason }
    }

    PREFS.setPhoneRemoteEnabled(true)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote', value: 'true' })
    void import('../index').then((m) => m.refreshTrayMenu())
    // Opt-in, so this is a no-op for anyone who hasn't enabled stay-awake.
    if (PREFS.getPhoneRemoteStayAwake()) startStayAwake(isPhoneConnected())
    // Fire-and-forget: the LAN QR must never wait on a tunnel provision/
    // download; the off-Wi-Fi row updates itself via the status push.
    void startTunnelIfEnabled(result.port)
    const qrDataUrl = await buildQrDataUrl(result.port)
    if (!qrDataUrl) return { ok: false, reason: 'no-lan' as const }
    const tunnelUrl = buildTunnelUrl()
    // `connected` is the CURRENT state, not a transition. A surface that opens
    // while a phone is already live (the tour's pairing step on a returning
    // user) would otherwise wait forever for a broadcast that already fired.
    return { ok: true, qrDataUrl, tunnelUrl, connected: isPhoneConnected() }
  })

  ipcMain.handle(CHANNELS.phoneRemoteGetSensitivity, () => PREFS.getPhoneRemoteSensitivity())

  ipcMain.handle(CHANNELS.phoneRemoteSetSensitivity, (_e, value: number) => {
    PREFS.setPhoneRemoteSensitivity(value)
    // Keep an already-paired phone's own slider in sync with a change made
    // from Mac Settings, same as the reverse direction in handlePhoneMessage.
    sendSensitivityToPhone()
    return PREFS.getPhoneRemoteSensitivity()
  })

  setTunnelStatusListener((s) => {
    refreshWebMacPresence()
    sendToSettingsRenderer(CHANNELS.phoneRemoteTunnelStatus, s)
    sendToTourRenderer(CHANNELS.phoneRemoteTunnelStatus, s)
    sendToPhoneRemoteQrRenderer(CHANNELS.phoneRemoteTunnelStatus, s)
    // The main QR is built from whatever address existed at mount, and the
    // tunnel takes seconds to come up (download + provision + spawn). Without
    // this repaint every surface keeps showing the LAN QR it minted first, so
    // a scan lands on https://192.168.x.x and hits the self-signed warning
    // the tunnel exists to remove.
    if (s.state === 'up') broadcastPhoneDevices(true)
  })

  // Polled by Settings rather than pushed: the display can also disappear
  // without any IPC (macOS terminating the helper), so a stored flag would go
  // stale. getVirtualDisplay() reads the live child-process state.
  ipcMain.handle(CHANNELS.phoneRemoteGetExtendedScreen, async () => ({
    active: getVirtualDisplay() !== null
  }))

  ipcMain.handle(CHANNELS.phoneRemoteClearExtendedScreen, async () => {
    stopVirtualDisplay()
    return { ok: true }
  })

  ipcMain.handle(CHANNELS.phoneRemoteSetStayAwake, async (_e, on: boolean) => {
    const next = on === true
    PREFS.setPhoneRemoteStayAwake(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote_stay_awake', value: String(next) })

    if (next && isPhoneRemoteRunning()) startStayAwake(isPhoneConnected())
    else if (!next) stopStayAwake()

    return { ok: true }
  })

  ipcMain.handle(CHANNELS.phoneRemoteSetClamshell, async (_e, on: boolean) => {
    const next = on === true

    if (!next) {
      const res = await disableClamshell()
      // Pref goes off regardless: intent is "off", and leaving it on after a
      // failed revert would mislead the user into thinking the lid is still
      // covered. The real machine state is re-read on next Settings open.
      PREFS.setPhoneRemoteClamshell(false)
      track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote_clamshell', value: 'false' })
      return res
    }

    const res = await enableClamshell()
    if (!res.ok) {
      // Cancelled prompt or failure — never persist ON for a flag we don't hold,
      // or the toggle would lie about whether the lid is actually covered.
      PREFS.setPhoneRemoteClamshell(false)
      return res
    }

    PREFS.setPhoneRemoteClamshell(true)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote_clamshell', value: 'true' })
    return res
  })

  ipcMain.handle(CHANNELS.phoneRemoteSetAwayMode, async (_e, on: boolean) => {
    const next = on === true

    if (!next) {
      await handback()
      // Off regardless of the handback's outcome: a toggle left on after a
      // failed relock would misreport the machine. handback() keeps the cover
      // up if the lock didn't come back.
      PREFS.setPhoneRemoteAwayMode(false)
      track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote_away_mode', value: 'false' })
      return { ok: true }
    }

    // Turning it ON with no phone connected only records intent — the hold is
    // acquired per session at connect. Suspending the lock now would leave a Mac
    // unlocked with nobody driving it, which is the exact state this must never
    // create. So: persist, and let onConnect do the real work.
    if (!isPhoneConnected()) {
      PREFS.setPhoneRemoteAwayMode(true)
      track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote_away_mode', value: 'true' })
      return { ok: true }
    }

    // A phone IS connected, so apply it immediately rather than making the user
    // reconnect to see it take effect.
    const res = await beginAwayMode({
      onEndedByHuman: () => sendToPhone({ type: 'awayEnded' }),
      onCovered: () => sendToPhone({ type: 'awayCovered' })
    })
    if (!res.ok) {
      // Never persist ON for a hold we don't have — the toggle would claim the
      // session survives a walk-away when it doesn't.
      PREFS.setPhoneRemoteAwayMode(false)
      return {
        ok: false,
        cancelled: res.reason === 'cancelled',
        reason: res.reason,
        error: res.error
      }
    }

    PREFS.setPhoneRemoteAwayMode(true)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote_away_mode', value: 'true' })
    return { ok: true }
  })

  // Momentary: must NOT write PhoneRemoteAwayMode, which means "hold when a
  // phone connects". Needs no phone — covering with nobody connected is the
  // state that needs testing. Never a toggle: held means the idle timer is
  // still running, and treating that as "off" locked the Mac on Protect.
  ipcMain.handle(CHANNELS.phoneRemoteToggleCoverNow, async () => {
    const res = await requestCoverNow({
      onEndedByHuman: () => {
        sendToPhone({ type: 'awayEnded' })
        sendToSettingsRenderer(CHANNELS.phoneRemoteAwayState, false)
      },
      onCovered: () => sendToPhone({ type: 'awayCovered' })
    })

    const active = isAwayModeHeld()
    sendToSettingsRenderer(CHANNELS.phoneRemoteAwayState, active)
    if (!res.ok) {
      return {
        ok: false,
        active,
        cancelled: res.reason === 'cancelled',
        reason: res.reason,
        error: res.error
      }
    }
    return { ok: true, active }
  })

  ipcMain.handle(CHANNELS.phoneRemoteGetPairCode, async (_e, opts?: PhoneRemoteGetPairCodeOpts) => {
    if (!isPhoneRemoteRunning()) return { code: null, pairedCount: 0, expiresAt: null }
    if (opts?.rotate) {
      issuePairingCode()
      broadcastPhoneDevices(true)
    }
    return {
      code: currentPairingCode(),
      pairedCount: getPairedDeviceCount(),
      // The deadline, not a duration: the row re-renders every second and any
      // duration it was handed would be stale by the first tick.
      expiresAt: currentPairingCodeExpiresAt()
    }
  })

  ipcMain.handle(CHANNELS.phoneRemoteForgetDevices, async () => {
    // Snapshot BEFORE the delete -- afterwards there is nothing left to describe,
    // and idle_days is the whole point of the event.
    const before = listPairedDevices()
    const forgot = forgetPairedDevices()
    for (const device of before) {
      track(ANALYTICS_EVENT.phone_device_revoked, {
        all: true,
        idle_days: deviceIdleDays(device),
        stale: isDeviceStale(device),
        total_devices: 0
      })
    }
    broadcastPhoneDevices()
    return { forgot }
  })

  ipcMain.handle(CHANNELS.phoneRemoteListDevices, async () => {
    return { devices: listPairedDevices() }
  })

  ipcMain.handle(CHANNELS.phoneRemoteRevokeDevice, async (_e, deviceId: unknown) => {
    if (typeof deviceId !== 'string' || !deviceId) return { revoked: false, devices: [] }
    const before = listPairedDevices().find((d) => d.id === deviceId)
    const revoked = revokePairedDevice(deviceId)
    // Return the fresh list so the row disappears without a second round trip
    // -- and so a stale id (already revoked elsewhere) still re-syncs the UI.
    const devices = listPairedDevices()
    // Only on a real revoke: a stale id that matched nothing deleted nothing,
    // and counting it would inflate churn with pure UI resyncs.
    if (revoked && before) {
      track(ANALYTICS_EVENT.phone_device_revoked, {
        all: false,
        idle_days: deviceIdleDays(before),
        stale: isDeviceStale(before),
        total_devices: devices.length
      })
      // The caller already has `devices` back; this is for any OTHER window
      // showing the same list.
      broadcastPhoneDevices()
    }
    return { revoked, devices }
  })

  ipcMain.handle(CHANNELS.phoneRemoteGetTunnel, async () => {
    const pair = await buildTunnelUrlAndQr()
    return {
      enabled: PREFS.getPhoneRemoteTunnelEnabled(),
      status: getTunnelStatus(),
      url: pair?.url ?? null,
      qrDataUrl: pair?.qrDataUrl ?? null
    }
  })

  ipcMain.handle(CHANNELS.phoneRemoteSetTunnelEnabled, async (_e, on: boolean) => {
    const next = on === true
    PREFS.setPhoneRemoteTunnelEnabled(next)
    track(ANALYTICS_EVENT.setting_toggled, { key: 'phone_remote_tunnel', value: String(next) })

    if (!next) {
      // Tunnel + DNS stay provisioned server-side for a fast re-enable; this
      // only stops the local cloudflared process (PRD §4).
      stopTunnel()
      return { ok: true }
    }

    // Enabled while the server is off: the pref is stored and the tunnel comes
    // up with the next server start (toggle-on / launch restore).
    if (!isPhoneRemoteRunning()) return { ok: true }

    // startPhoneRemoteServer is idempotent when already listening — reused
    // here only to learn the bound port (same trick as phoneRemoteGetQr).
    const result = await startPhoneRemoteServer(phoneRemoteCallbacks())
    if (!result.ok) return { ok: false, reason: result.reason }
    const started = await startTunnelIfEnabled(result.port)
    if (!started.ok) return { ok: false, reason: started.reason }
    return { ok: true, url: started.url, qrDataUrl: started.qrDataUrl }
  })
}
