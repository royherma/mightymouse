/**
 * Making two identical paired-device rows tellable apart. iOS caps every
 * iPhone's UA at the model FAMILY, so no parser change can fix this -- the fix
 * is set-level, and these are the cases where a naive one still collides.
 */

import { describe, it, expect } from 'vitest'
import type { PairedDevice } from '../types'
import {
  disambiguateDeviceLabels,
  isDeviceStale,
  deviceIdleDays,
  DEVICE_STALE_AFTER_DAYS
} from '../paired-device-labels'

const DAY_MS = 86_400_000

function device(over: Partial<PairedDevice> & { id: string }): PairedDevice {
  return {
    label: 'iPhone · Safari',
    kind: 'iphone',
    connected: false,
    pairedAt: Date.now(),
    lastSeenAt: null,
    ...over
  } as PairedDevice
}

describe('disambiguateDeviceLabels', () => {
  it('leaves an already-unique label untouched', () => {
    const rows = disambiguateDeviceLabels([
      device({ id: 'a', label: 'iPhone · Safari' }),
      device({ id: 'b', label: 'iPad · Safari' })
    ])
    expect(rows.map((r) => r.displayLabel)).toEqual(['iPhone · Safari', 'iPad · Safari'])
  })

  // The reported case: three rows, two of them byte-identical.
  it('separates collided labels', () => {
    const rows = disambiguateDeviceLabels([
      device({ id: 'a', label: 'iPhone · MightyMouse app', pairedAt: Date.parse('2026-07-03') }),
      device({ id: 'b', label: 'iPhone · MightyMouse app', pairedAt: Date.parse('2026-07-20') }),
      device({ id: 'c', label: 'iPhone · Home Screen app' })
    ])
    const labels = rows.map((r) => r.displayLabel)
    expect(new Set(labels).size).toBe(3)
    // A device that was never ambiguous must not get decorated.
    expect(labels).toContain('iPhone · Home Screen app')
  })

  // Same day means the date adds nothing -- two rows both saying "paired 3 Jul".
  it('falls back to ordinals when collided rows share a pairing day', () => {
    const sameDay = Date.parse('2026-07-03T09:00:00Z')
    const rows = disambiguateDeviceLabels([
      device({ id: 'a', label: 'iPhone · Safari', pairedAt: sameDay }),
      device({ id: 'b', label: 'iPhone · Safari', pairedAt: sameDay + 3_600_000 })
    ])
    const labels = rows.map((r) => r.displayLabel)
    expect(new Set(labels).size).toBe(2)
    expect(labels.some((l) => l.includes('(2)'))).toBe(true)
  })

  it('orders ordinals by pairing time, oldest first', () => {
    const rows = disambiguateDeviceLabels([
      device({ id: 'newer', label: 'iPhone · Safari', pairedAt: 2000 }),
      device({ id: 'older', label: 'iPhone · Safari', pairedAt: 1000 })
    ])
    // Numbering follows pairedAt, not array order: an ordinal that reshuffles
    // with the list names a different phone each render. Both rows get a number
    // -- an unsuffixed row beside "(2)" reads as if it weren't part of the pair.
    const older = rows.find((r) => r.id === 'older')!
    const newer = rows.find((r) => r.id === 'newer')!
    expect(older.displayLabel).toContain('(1)')
    expect(newer.displayLabel).toContain('(2)')
  })

  it('keeps every row and every id', () => {
    const rows = disambiguateDeviceLabels([
      device({ id: 'a', label: 'iPhone · Safari' }),
      device({ id: 'b', label: 'iPhone · Safari' }),
      device({ id: 'c', label: 'iPhone · Safari' })
    ])
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('handles an empty list', () => {
    expect(disambiguateDeviceLabels([])).toEqual([])
  })
})

describe('staleness', () => {
  it('measures idle days from last-seen', () => {
    const d = device({ id: 'a', lastSeenAt: Date.now() - 10 * DAY_MS })
    expect(deviceIdleDays(d)).toBe(10)
  })

  // Otherwise the row most worth forgetting is the one that can never be flagged.
  it('falls back to pairing time when the device never connected', () => {
    const d = device({ id: 'a', lastSeenAt: null, pairedAt: Date.now() - 90 * DAY_MS })
    expect(deviceIdleDays(d)).toBe(90)
    expect(isDeviceStale(d)).toBe(true)
  })

  it('does not flag a device inside the threshold', () => {
    const d = device({
      id: 'a',
      lastSeenAt: Date.now() - (DEVICE_STALE_AFTER_DAYS - 1) * DAY_MS
    })
    expect(isDeviceStale(d)).toBe(false)
  })

  // "Not used in 3 months" must never render under a green Connected dot.
  it('never flags the connected device', () => {
    const d = device({ id: 'a', connected: true, lastSeenAt: Date.now() - 400 * DAY_MS })
    expect(isDeviceStale(d)).toBe(false)
  })
})
