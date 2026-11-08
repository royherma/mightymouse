/**
 * Phone Remote -- QR/pairing surface: building the LAN + tunnel QR codes,
 * starting the tunnel when the pref is on, and broadcasting connect status
 * and the paired-device list to every renderer that shows one.
 */
import * as QRCode from 'qrcode'
import { CHANNELS } from '../../shared/ipc'
import { CONFIG } from '../../shared/config'
import { PREFS } from '../store/prefs'
import { sendToSettingsRenderer } from '../settings-window'
import { sendToTourRenderer } from '../tour-window'
import { sendToFirstRunRenderer } from '../first-run-window'
import { sendToPanelRenderer } from '../panel-window'
import { sendToPhoneRemoteQrRenderer } from '../phone-remote-qr-window'
import { startTunnel, getTunnelHostname, NOT_SIGNED_IN } from '../phone-remote/cloudflare-tunnel'
import {
  getLanAddress,
  isPhoneRemoteRunning,
  startPhoneRemoteServer,
  currentPairingCode,
  listPairedDevices,
  resolveApproval,
  revokeActiveDevice,
  type PhoneRemoteMessage
} from '../phone-remote/server'
import { deviceIdleDays, isDeviceStale } from '../../shared/paired-device-labels'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { devLog } from '../../shared/env'
import { recordMirrorBench } from '../phone-remote/mirror-tuning-ledger'
import { recordJournal } from '../phone-remote/connection-journal'
// Circular by construction: phoneRemoteCallbacks() stays on the donor per the
// PRD (it wires handlePhoneMessage + friends), and freshPairingQrs() is the
// one place here that needs to restart-probe the server through it. Both
// sides only call the import at runtime, never at module-eval time, so the
// cycle resolves fine -- same pattern C4/C5 already use for phoneMayControlMac.
import { phoneRemoteCallbacks } from './phone-remote'

/** Prefers the tunnel address: it carries a real CA cert, so pairing over it
 *  skips the self-signed warning. Falls back to LAN while the tunnel is still
 *  provisioning -- a code that renders now beats a better one in ten seconds. */
export async function buildQrDataUrl(port: number): Promise<string> {
  const base = buildTunnelUrl() ?? (getLanAddress() ? `https://${getLanAddress()}:${port}/` : null)
  // https, not http: the server now serves a self-signed cert so the phone
  // gets a secure context (getUserMedia requires one — see server.ts header).
  if (!base) return ''
  return encodePairingQr(base)
}

/** Every QR goes through here: a second builder attaching the code itself is
 *  how the tunnel QR shipped bare, scanning fine and pairing nothing. */
export async function encodePairingQr(base: string): Promise<string> {
  // The code, not a session token: scanning and typing run the same /pair
  // exchange, so a scan can finish pairing on its own. `currentPairingCode`
  // reuses the outstanding code rather than minting a second one, which
  // would invalidate whatever the Mac is already showing.
  const url = new URL(base)
  url.searchParams.set(CONFIG.PHONE_REMOTE.PAIR_CODE_PARAM, currentPairingCode())
  return QRCode.toDataURL(url.toString())
}

export function buildTunnelUrl(): string | null {
  if (!PREFS.getPhoneRemoteTunnelEnabled()) return null
  const hostname = getTunnelHostname()
  if (!hostname) return null
  return `https://${hostname}/`
}

/** URL + QR pair for the tunnel address (the off-Wi-Fi row renders both). */
export async function buildTunnelUrlAndQr(): Promise<{ url: string; qrDataUrl: string } | null> {
  const url = buildTunnelUrl()
  if (!url) return null
  // `url` stays bare -- it is rendered as text to read or copy, and a code in
  // it would go stale on screen. Only the QR, scanned in the moment, carries one.
  return { url, qrDataUrl: await encodePairingQr(url) }
}

/** Bring the tunnel up for a running server (no-op when the pref is off) and
 *  hand back the url+qr on success. Shared by the enable toggle, the launch
 *  restore, and the base phone-remote toggle-on. */
export async function startTunnelIfEnabled(
  port: number
): Promise<{ ok: boolean; url?: string; qrDataUrl?: string; reason?: string }> {
  if (!PREFS.getPhoneRemoteTunnelEnabled()) return { ok: true }
  const result = await startTunnel(port)
  // Signed out is the default state of a first-run install now that the pref
  // ships ON -- report success with no tunnel URL so pairing falls back to LAN
  // silently, instead of opening on a red error nobody asked for.
  if (!result.ok && result.reason === NOT_SIGNED_IN) return { ok: true }
  if (!result.ok) return { ok: false, reason: result.reason }
  const pair = await buildTunnelUrlAndQr()
  return { ok: true, url: pair?.url, qrDataUrl: pair?.qrDataUrl }
}

export function broadcastPhoneStatus(connected: boolean): void {
  sendToSettingsRenderer(CHANNELS.phoneRemoteStatus, { connected })
  sendToTourRenderer(CHANNELS.phoneRemoteStatus, { connected })
  sendToFirstRunRenderer(CHANNELS.phoneRemoteStatus, { connected })
  void import('../index').then((m) => m.refreshTrayMenu())
}

/** Push the paired set after anything mutates it.
 * `freshQrs` re-encodes both QRs. True after /pair or a user rotate; false on
 * revoke, which must not spin the digits under a scan. */
export function broadcastPhoneDevices(freshQrs = false): void {
  void (async () => {
    const payload = {
      devices: listPairedDevices(),
      ...(freshQrs ? await freshPairingQrs() : {})
    }
    sendToSettingsRenderer(CHANNELS.phoneRemoteDevicesChanged, payload)
    // PairingPanel (hence PairCodeRow + PairedDeviceList) renders in the PANEL
    // window too, which is where pairing is usually done. Settings-only meant the
    // consumed code stayed on screen looking valid and the new row never appeared.
    sendToPanelRenderer(CHANNELS.phoneRemoteDevicesChanged, payload)
    sendToTourRenderer(CHANNELS.phoneRemoteDevicesChanged, payload)
    sendToPhoneRemoteQrRenderer(CHANNELS.phoneRemoteDevicesChanged, payload)
  })()
}

/** Both code-bearing QRs, re-encoded against whatever code is live now. Null on
 * either when there's nothing scannable (server down, no LAN, tunnel off) --
 * a surface showing a QR keeps its old one rather than blanking. */
export async function freshPairingQrs(): Promise<{
  qrDataUrl: string | null
  tunnelQrDataUrl: string | null
}> {
  if (!isPhoneRemoteRunning()) return { qrDataUrl: null, tunnelQrDataUrl: null }
  const result = await startPhoneRemoteServer(phoneRemoteCallbacks())
  if (!result.ok) return { qrDataUrl: null, tunnelQrDataUrl: null }
  return {
    qrDataUrl: (await buildQrDataUrl(result.port)) || null,
    tunnelQrDataUrl: (await buildTunnelUrlAndQr())?.qrDataUrl ?? null
  }
}

export function handleApprovalVerdict(
  msg: Extract<PhoneRemoteMessage, { type: 'approvalVerdict' }>
): void {
  // Everything off the wire is attacker-controllable once the tunnel is on,
  // so the id is checked for shape here and matched against the outstanding
  // request inside resolveApproval -- a forged verdict for a request that
  // isn't live admits nobody.
  if (typeof msg.id !== 'string' || typeof msg.allow !== 'boolean') return
  resolveApproval(msg.id, msg.allow)
}

export function handleUnpairSelf(): void {
  // No payload to validate -- the socket identifies the credential.
  // Read BEFORE the revoke: `connected` marks the live socket's own
  // device, and the revoke clears exactly that mark.
  const before = listPairedDevices().find((d) => d.connected)
  if (!revokeActiveDevice()) return
  track(ANALYTICS_EVENT.phone_device_revoked, {
    all: false,
    idle_days: before ? deviceIdleDays(before) : 0,
    stale: before ? isDeviceStale(before) : false,
    total_devices: listPairedDevices().length
  })
  // The only revoke with no IPC round-trip to answer -- it starts on the
  // phone, so nothing else would ever tell Settings the row is gone.
  broadcastPhoneDevices()
}

/** Phone-side diagnostics. devLog so it's dev-only, but always visible
 *  in /tmp/mightymouse-dev.log where on-device behavior can be read.
 *  Tagged with the connected device so concurrent clients (glasses, phone,
 *  a desktop test tab) are separable in one log. connectedLabel is read
 *  live from phone-remote.ts (mutated at connect), passed in rather than
 *  imported so a snapshot here never goes stale across reconnects. */
export function handleDebugLog(
  msg: Extract<PhoneRemoteMessage, { type: 'debugLog' }>,
  connectedLabel: string
): void {
  devLog.log(`[phone-remote][${connectedLabel}] ${msg.message}`)
  // A bench summary is the one diagnostic worth outliving the dev log,
  // which `make restart` truncates -- see mirror-tuning-ledger. Matched on
  // the rendered prefix because the phone sends this as free text; a
  // protocol variant for it would have to be kept in step with a format
  // that changes every time something new is being measured.
  if (msg.message.includes('BENCH ')) recordMirrorBench(msg.message)
  // The phone's own failed attempts, replayed on the connection that
  // finally worked. They belong in the journal rather than the dev log
  // for the same reason the journal exists at all: the attempt worth
  // reading is the one BEFORE the restart that fixed it.
  const connectLog = msg.message.indexOf('CONNECTLOG ')
  if (connectLog !== -1) {
    recordJournal('phone-attempt', {
      label: connectedLabel,
      detail: msg.message.slice(connectLog + 'CONNECTLOG '.length)
    })
  }
}
