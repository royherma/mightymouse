/**
 * Makes every row in the paired-devices list uniquely identifiable. Duplication
 * is a property of the SET, so this runs over the whole list. Weakest
 * decoration first: bare label, date, ordinal.
 */

type LabelledDevice = { label: string; pairedAt: number }

export function disambiguateDeviceLabels<T extends LabelledDevice>(
  devices: readonly T[]
): (T & { displayLabel: string })[] {
  const counts = new Map<string, number>()
  for (const d of devices) counts.set(d.label, (counts.get(d.label) ?? 0) + 1)

  const ordinals = new Map<T, number>()
  const seen = new Map<string, number>()
  for (const d of [...devices].sort((a, b) => a.pairedAt - b.pairedAt)) {
    const n = (seen.get(d.label) ?? 0) + 1
    seen.set(d.label, n)
    ordinals.set(d, n)
  }

  const daysByLabel = new Map<string, Set<string>>()
  for (const d of devices) {
    const set = daysByLabel.get(d.label) ?? new Set<string>()
    set.add(pairedDay(d.pairedAt))
    daysByLabel.set(d.label, set)
  }

  return devices.map((d) => {
    const collided = counts.get(d.label) ?? 0
    if (collided < 2) return { ...d, displayLabel: d.label }
    if ((daysByLabel.get(d.label)?.size ?? 0) === collided) {
      return { ...d, displayLabel: `${d.label} · paired ${pairedDay(d.pairedAt)}` }
    }
    return { ...d, displayLabel: `${d.label} (${ordinals.get(d) ?? 1})` }
  })
}

function pairedDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** 60 rather than 30 so a fortnight's holiday doesn't flag a phone in use. */
export const DEVICE_STALE_AFTER_DAYS = 60

/** Later than stale on purpose: a row is flagged for a month before revoke. */
export const DEVICE_REVOKE_AFTER_DAYS = 90

export function deviceIdleDays(device: {
  lastSeenAt: number | null
  pairedAt: number
}): number | null {
  const since = device.lastSeenAt ?? device.pairedAt
  if (!since) return null
  return Math.floor((Date.now() - since) / 86_400_000)
}

/** `connected` short-circuits: a live session would else read "13 months". */
export function isDeviceStale(device: {
  lastSeenAt: number | null
  pairedAt: number
  connected?: boolean
}): boolean {
  if (device.connected) return false
  const idle = deviceIdleDays(device)
  return idle !== null && idle >= DEVICE_STALE_AFTER_DAYS
}
