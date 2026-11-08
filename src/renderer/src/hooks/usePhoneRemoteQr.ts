import { useEffect, useState } from 'react'
import type { PhoneRemoteTunnelStatus } from '../../../shared/types'
import { derivePairing } from '../../../shared/phone-remote-pairing'

// Read-only pairing QR for surfaces that only want to SHOW the code (the Panel
// header), not drive pairing. Toggling, retrying and tunnel setup stay in
// PhoneRemoteQrApp / SettingsApp; this hook never writes.

/** Null whenever there is nothing scannable — the caller falls back to a glyph. */
export function usePhoneRemoteQr(): string | null {
  const [enabled, setEnabled] = useState(false)
  const [connected, setConnected] = useState(false)
  const [lanQr, setLanQr] = useState<string | null>(null)
  const [tunnelEnabled, setTunnelEnabled] = useState(false)
  const [tunnelStatus, setTunnelStatus] = useState<PhoneRemoteTunnelStatus>({ state: 'stopped' })
  const [tunnelQr, setTunnelQr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    window.api.settingsGetPrefs().then((p) => {
      if (cancelled || !p.phoneRemoteEnabled) return
      setEnabled(true)
      window.api.phoneRemoteGetQr().then((r) => {
        if (!cancelled && r.ok) setLanQr(r.qrDataUrl ?? null)
      })
    })

    window.api.phoneRemoteGetTunnel().then((t) => {
      if (cancelled) return
      setTunnelEnabled(t.enabled)
      setTunnelStatus(t.status)
      setTunnelQr(t.qrDataUrl)
    })

    const offStatus = window.api.onPhoneRemoteStatus((s) => setConnected(s.connected))
    const offTunnel = window.api.onPhoneRemoteTunnelStatus((s) => {
      setTunnelStatus(s)
      if (s.state === 'up') {
        window.api.phoneRemoteGetTunnel().then((t) => setTunnelQr(t.qrDataUrl))
      } else {
        setTunnelQr(null)
      }
    })

    // Single-use code: the QR fetched on mount is dead once anything pairs.
    const offDevices = window.api.onPhoneRemoteDevicesChanged((p) => {
      if (p.qrDataUrl) setLanQr(p.qrDataUrl)
      if (p.tunnelQrDataUrl) setTunnelQr(p.tunnelQrDataUrl)
    })

    return () => {
      cancelled = true
      offStatus()
      offTunnel()
      offDevices()
    }
  }, [])

  return derivePairing({ enabled, connected, lanQr, tunnelEnabled, tunnelStatus, tunnelQr })
    .qrDataUrl
}
