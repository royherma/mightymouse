/**
 * The paired-phone list for the Phone Remote settings card.
 *
 * Exists because "Forget paired devices" was the only revoke control, and it
 * was all-or-nothing on a set the user couldn't see. Once a Mac can have
 * several phones paired, the kill switch has to answer "which one?" before it
 * can be trusted -- so every device gets a row, an icon, a last-seen time, and
 * its own Disconnect.
 *
 * The live device is marked, and its row says Disconnect rather than Forget:
 * revoking the phone in your hand and revoking one in a drawer feel like
 * different acts even though the server does the same thing.
 */

import { useEffect, useState, useCallback, type JSX } from 'react'
import { Smartphone, Tablet, Laptop, HelpCircle, ChevronDown } from 'lucide-react'
import { GlowDot } from './GlowDot'
import { ConfirmDialog } from './ConfirmDialog'
import type { PairedDevice, PhoneRemoteDeviceKind } from '../../../shared/types'
import {
  disambiguateDeviceLabels,
  isDeviceStale,
  deviceIdleDays,
  DEVICE_REVOKE_AFTER_DAYS
} from '../../../shared/paired-device-labels'
import { Button } from './Button'

/** Device class → the icon that makes the row scannable at a glance. Exhaustive
 *  over PhoneRemoteDeviceKind, so a new kind is a compile error, not a blank. */
const KIND_ICON: Record<PhoneRemoteDeviceKind, typeof Smartphone> = {
  iphone: Smartphone,
  ipad: Tablet,
  android: Smartphone,
  mac: Laptop,
  unknown: HelpCircle
}

/** "3m ago" / "2d ago". Null means the device hasn't connected since we started
 *  recording identity -- shown as the pairing date instead of a fake "never". */
function relTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** OS joins the usage line rather than taking a third row, which would push
 *  each row taller than the collapsed header it sits under. */
function subtitleFor(device: PairedDevice): string {
  const usage = usageFor(device)
  return device.osLabel ? `${device.osLabel} · ${usage}` : usage
}

function usageFor(device: PairedDevice): string {
  if (device.connected) return 'Connected now'
  // A stale row says how long in months rather than "Last used 74d ago" -- the
  // point is "you can probably forget this", not the exact number.
  if (isDeviceStale(device)) {
    const days = deviceIdleDays(device) ?? 0
    const months = Math.max(2, Math.round(days / 30))
    // Stale opens a month before the revoke, so warn before it happens.
    const left = Math.max(1, DEVICE_REVOKE_AFTER_DAYS - days)
    return `Not used in ${months} months · disconnects in ${left}d`
  }
  if (device.lastSeenAt) return `Last used ${relTime(device.lastSeenAt)}`
  if (device.pairedAt) return `Paired ${relTime(device.pairedAt)}`
  return 'Not used yet'
}

/** `onRevokedAll` lets the host clear any pairing code it's showing -- a
 *  revoke-all invalidates the outstanding code server-side, so leaving it on
 *  screen would offer a code that can no longer pair anything. */
export function PairedDeviceList({
  onRevokedAll
}: {
  onRevokedAll?: () => void
}): JSX.Element | null {
  const [devices, setDevices] = useState<PairedDevice[]>([])
  // Carries `displayLabel` so the confirm dialog names the device the same way
  // its row did -- naming it "iPhone" in the dialog after the row said
  // "iPhone (2)" would undo the disambiguation at the one moment it matters.
  const [pending, setPending] = useState<(PairedDevice & { displayLabel: string }) | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  // Collapsed by default: the count answers "is anything paired?", which is the
  // question this list is usually asked. Expanding is for revoking one.
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async () => {
    const res = await window.api.phoneRemoteListDevices()
    setDevices(res.devices)
  }, [])

  useEffect(() => {
    void refresh()
    return window.api.onPhoneRemoteDevicesChanged((payload) => setDevices(payload.devices))
  }, [refresh])

  async function revoke(device: PairedDevice): Promise<void> {
    setPending(null)
    // The handler returns the fresh list, so a stale id (revoked from another
    // window) still re-syncs instead of leaving a row that no longer exists.
    const res = await window.api.phoneRemoteRevokeDevice(device.id)
    setDevices(res.devices)
  }

  async function forgetAll(): Promise<void> {
    setConfirmAll(false)
    await window.api.phoneRemoteForgetDevices()
    setDevices([])
    onRevokedAll?.()
  }

  // Nothing paired is the common case before first pairing -- an empty
  // "Devices" header there would be noise, not information.
  if (devices.length === 0) return null

  return (
    <div className="mt-3 pt-3 border-t border-surface3">
      <div className="flex items-center justify-between gap-3 mb-2">
        {/* The count IS the toggle -- same disclosure meaning as a Settings
            section header (chevron hides what's below it), so this doesn't
            introduce a second widget with its own rules. */}
        <Button
          variant="bare"
          aria-expanded={open}
          className="flex items-center gap-1.5 text-muted text-xs hover:text-fg select-none"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown
            size={13}
            strokeWidth={2.5}
            className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          {devices.length} paired {devices.length === 1 ? 'device' : 'devices'}
        </Button>
        {/* Stays visible while collapsed too: it's the panic button for "I
            don't recognize one of these", so putting it behind the disclosure
            would cost a click at the one moment speed matters. */}
        {devices.length > 1 && (
          <Button
            variant="bare"
            className="text-muted text-xs hover:text-fg shrink-0"
            onClick={() => setConfirmAll(true)}
          >
            Forget all
          </Button>
        )}
      </div>
      <div className={`flex-col gap-1 ${open ? 'flex' : 'hidden'}`}>
        {disambiguateDeviceLabels(devices).map((device) => {
          const Icon = KIND_ICON[device.kind]
          const stale = isDeviceStale(device)
          return (
            <div
              key={device.id}
              className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface2"
            >
              <Icon
                size={18}
                className="shrink-0"
                style={{ color: device.connected ? 'var(--green)' : 'var(--muted)' }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm truncate">{device.displayLabel}</span>
                  {device.connected && <GlowDot color="var(--green)" size="w-1.5 h-1.5" />}
                </div>
                <div className="text-muted text-xs">{subtitleFor(device)}</div>
              </div>
              {/* A worded button, not an ✕: revoking access is worth naming,
                  and "Disconnect" vs "Forget" is the one place the difference
                  between the live phone and an idle one is visible.

                  Amber only on hover -- this is reversible (re-pair with a new
                  code), so a row that sits there permanently red would overstate
                  it. Calm at rest, clear the moment you reach for it.

                  A STALE row is the exception: hiding Forget behind hover is
                  right for a device in use and wrong for junk the user should
                  clear, so past the threshold it stays visible.

                  transition-all, not transition-colors + transition-opacity:
                  both set transition-property, so the second silently wins and
                  one of the two animations is lost. */}
              <Button
                variant="bare"
                aria-label={`${device.connected ? 'Disconnect' : 'Forget'} ${device.displayLabel}`}
                className={`shrink-0 rounded-sm border border-surface3 px-2 py-0.5 text-xs font-semibold text-muted transition-all hover:border-amber hover:text-amber group-hover:opacity-100 focus-visible:opacity-100 ${stale ? 'opacity-100' : 'opacity-0'}`}
                onClick={() => setPending(device)}
              >
                {device.connected ? 'Disconnect' : 'Forget'}
              </Button>
            </div>
          )
        })}
      </div>

      {pending && (
        <ConfirmDialog
          title={pending.connected ? 'Disconnect this device?' : 'Forget this device?'}
          body={
            pending.connected
              ? `${pending.displayLabel} will lose control of this Mac right away and needs a new code to pair again.`
              : `${pending.displayLabel} will need a new code before it can control this Mac again.`
          }
          confirmLabel={pending.connected ? 'Disconnect' : 'Forget'}
          onConfirm={() => void revoke(pending)}
          onCancel={() => setPending(null)}
        />
      )}

      {confirmAll && (
        <ConfirmDialog
          title="Forget all paired devices?"
          body="Every phone you've paired will need a new code before it can control this Mac again."
          confirmLabel="Forget all"
          onConfirm={() => void forgetAll()}
          onCancel={() => setConfirmAll(false)}
        />
      )}
    </div>
  )
}
