import { useEffect, useState, type JSX } from 'react'
import type { PhoneRemoteTunnelStatus } from '../../shared/types'
import { WindowFrame, LoadingBody } from './WindowFrame'
import { Switch } from './components/Switch'
import { Badge } from './components/Badge'
import { PAIR_QR_SIZE } from './components/PairQr'
import { PairingPanel } from './components/PairingPanel'
import { derivePairing } from '../../shared/phone-remote-pairing'
import { Button } from './components/Button'

// Standalone Phone Remote pairing QR window, opened from the Panel header.
// The pairing surface itself is PairingPanel, shared with the Settings card so
// the two can't drift apart again. This file owns only the window chrome, the
// feature toggle, and the IPC. Advanced knobs (stay-awake, clamshell) stay
// Settings-only; this is pairing only.

export default function PhoneRemoteQrApp(): JSX.Element {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [tunnelEnabled, setTunnelEnabled] = useState(false)
  const [tunnelStatus, setTunnelStatus] = useState<PhoneRemoteTunnelStatus>({ state: 'stopped' })
  const [tunnelQr, setTunnelQr] = useState<string | null>(null)

  const fetchQr = (): void => {
    window.api.phoneRemoteGetQr().then((r) => {
      if (r.ok) {
        setQr(r.qrDataUrl ?? null)
        setError(null)
      } else {
        // 'not-running' means the toggle flipped off in the gap between mount
        // and this resolving -- not worth surfacing. 'no-lan' is a real dead
        // end (buildQrDataUrl found neither a tunnel URL nor a LAN address)
        // and previously left the panel stuck on "Generating QR..."
        // forever with no error and no way to retry -- exactly the bug report.
        if (r.reason !== 'not-running') {
          setError('No network to pair on - connect to Wi-Fi, or turn on off-Wi-Fi access.')
        }
      }
    })
  }

  useEffect(() => {
    let cancelled = false

    window.api.settingsGetPrefs().then((p) => {
      if (cancelled) return
      setEnabled(p.phoneRemoteEnabled)
      setLoading(false)
      if (p.phoneRemoteEnabled) fetchQr()
      else void toggleEnabled(true)
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
    // A pairing code is single-use, so the QR fetched above dies the instant a
    // phone pairs. Main re-encodes and pushes it here rather than each surface
    // remembering to re-fetch. Null means nothing scannable -- keep the old one.
    const offDevices = window.api.onPhoneRemoteDevicesChanged((p) => {
      if (p.qrDataUrl) setQr(p.qrDataUrl)
      if (p.tunnelQrDataUrl) setTunnelQr(p.tunnelQrDataUrl)
    })

    return () => {
      cancelled = true
      offStatus()
      offTunnel()
      offDevices()
    }
  }, [])

  const toggleEnabled = async (next: boolean): Promise<void> => {
    setEnabled(next) // optimistic
    setError(null)
    if (!next) {
      setQr(null)
      setConnected(false)
      await window.api.phoneRemoteSetEnabled(false)
      return
    }
    const result = await window.api.phoneRemoteSetEnabled(true)
    if (!result.ok) {
      setEnabled(false)
      setError(
        result.reason === 'no-lan'
          ? 'No network to pair on - connect to Wi-Fi, or turn on off-Wi-Fi access.'
          : "Couldn't start Phone Remote."
      )
      return
    }
    setQr(result.qrDataUrl ?? null)
  }

  const toggleTunnel = async (next: boolean): Promise<void> => {
    setTunnelEnabled(next) // optimistic; live progress streams in via onPhoneRemoteTunnelStatus
    if (!next) setTunnelQr(null)
    await window.api.phoneRemoteSetTunnelEnabled(next)
  }

  // Full off→on: a bare re-enable hits startTunnel()'s idempotent early-return,
  // so the failed attempt would never be torn down (or its orphan reaped).
  const retryTunnel = async (): Promise<void> => {
    await window.api.phoneRemoteSetTunnelEnabled(false)
    await toggleTunnel(true)
  }

  // ONE derivation for badge + QR (shared/phone-remote-pairing.ts) — same
  // module the Settings card uses, so the two pairing surfaces can't drift.
  const pairing = derivePairing({
    enabled,
    connected,
    lanQr: qr,
    tunnelEnabled,
    tunnelStatus,
    tunnelQr
  })

  if (loading) {
    return (
      <WindowFrame title="Phone Remote">
        <LoadingBody />
      </WindowFrame>
    )
  }

  return (
    <WindowFrame title="Phone Remote">
      <div className="p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted text-sm max-w-[280px]">
            Use your phone as a trackpad and mic for your Mac.
          </div>
          <Switch on={enabled} onChange={toggleEnabled} />
        </div>

        {enabled && (
          <div className="flex items-center gap-2 flex-wrap">
            <Badge color={pairing.badgeColor}>{pairing.badge}</Badge>
            {pairing.canRetry && tunnelEnabled && (
              <Button
                variant="bare"
                onClick={() => void retryTunnel()}
                className="text-sm font-medium underline"
              >
                Retry
              </Button>
            )}
          </div>
        )}

        {/* Only for a failed toggle-on (enabled snaps back to false) -- once
            enabled, a QR-fetch error renders inline in the QR box below
            instead, alongside its own "Try again" retry. */}
        {!enabled && error && <div className="text-red-400 text-sm">{error}</div>}

        {enabled && (
          <div className="pt-4 border-t border-surface3">
            <PairingPanel
              pairing={pairing}
              tunnelEnabled={tunnelEnabled}
              tunnelStatus={tunnelStatus}
              onTunnelToggle={toggleTunnel}
              onTunnelRetry={() => void retryTunnel()}
              lanError={error}
              onLanRetry={() => {
                setError(null)
                fetchQr()
              }}
              qrSize={PAIR_QR_SIZE.lg}
              onUpgrade={() => window.api.openUpgradeWindow('phone_remote_minutes')}
            />
          </div>
        )}

        <Button onClick={() => window.close()} className="self-end">
          Done
        </Button>
      </div>
    </WindowFrame>
  )
}
