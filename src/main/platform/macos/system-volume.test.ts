import { describe, it, expect } from 'vitest'
import { clampVolume, VOLUME_MIN, VOLUME_MAX } from './system-volume'

// These bounds are the only thing between an attacker-controllable WS number
// and an interpolated osascript source string.
describe('clampVolume', () => {
  it('passes an in-range value through, rounded', () => {
    expect(clampVolume(44)).toBe(44)
    expect(clampVolume(44.6)).toBe(45)
  })

  it('pins out-of-range values to the nearer end', () => {
    expect(clampVolume(-50)).toBe(VOLUME_MIN)
    expect(clampVolume(9999)).toBe(VOLUME_MAX)
  })

  it('pins Infinity to MAX, not to silence', () => {
    // A shared !isFinite guard sent "too loud" to 0, the opposite end.
    expect(clampVolume(Infinity)).toBe(VOLUME_MAX)
    expect(clampVolume(-Infinity)).toBe(VOLUME_MIN)
  })

  it('sends NaN to MIN, since it has no nearer end', () => {
    expect(clampVolume(NaN)).toBe(VOLUME_MIN)
  })
})
