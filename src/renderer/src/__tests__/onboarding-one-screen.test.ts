import { describe, it, expect } from 'vitest'
import { rowState } from '../components/PermissionRow'
import type { PermissionCheck, PermissionKey, PermissionStatus } from '../../../shared/types'

// The one-screen setup is the real first run (since 2026-08-05), and two of its
// decisions are silent when they break: a row that renders "Granted" over a
// permission that is off, and a finish button that stays live while the one
// REQUIRED permission is missing. Both reduce to pure predicates — tested here
// without a DOM, since the component only reads them.

const check = (
  key: PermissionKey,
  status: PermissionStatus,
  ok: boolean,
  needsRestart = false
): PermissionCheck => ({ key, status, test: { ok, needsRestart } })

describe('rowState', () => {
  it('is granted when the self-test passes', () => {
    expect(rowState(check('accessibility', 'granted', true), false)).toBe('granted')
  })

  it('is off when the permission is missing and nothing is in flight', () => {
    expect(rowState(check('microphone', 'denied', false), false)).toBe('off')
  })

  it('is busy while an Allow is outstanding', () => {
    expect(rowState(check('microphone', 'denied', false), true)).toBe('busy')
  })

  it('reports needsRestart only when the OS actually granted it', () => {
    expect(rowState(check('screen', 'granted', false, true), false)).toBe('needsRestart')
  })

  // The regression this guards: needsRestart alone would render a green
  // "Granted — needs a restart" over a permission the user never turned on.
  it('does NOT report needsRestart when the OS status is not granted', () => {
    expect(rowState(check('screen', 'denied', false, true), false)).toBe('off')
  })

  it('prefers a passing self-test over a stale needsRestart flag', () => {
    expect(rowState(check('screen', 'granted', true, true), false)).toBe('granted')
  })

  it('is off when there is no check yet, even if busy is false', () => {
    expect(rowState(undefined, false)).toBe('off')
  })
})

// Mirrors the two inline predicates in OnboardingOneScreen.tsx: the finish
// button is gated on accessibility alone (mic + screen are optional), and its
// label swaps to Restart when ANY granted permission is TCC-stale.
const accessibilityOk = (checks: PermissionCheck[]): boolean =>
  !!checks.find((c) => c.key === 'accessibility')?.test.ok

const needsRestart = (checks: PermissionCheck[]): boolean =>
  checks.some((c) => c.status === 'granted' && c.test.needsRestart)

describe('finish gate', () => {
  it('stays disabled while accessibility is ungranted, even with the optional two done', () => {
    expect(
      accessibilityOk([
        check('accessibility', 'denied', false),
        check('microphone', 'granted', true),
        check('screen', 'granted', true)
      ])
    ).toBe(false)
  })

  it('goes live on accessibility alone — mic and screen are optional', () => {
    expect(
      accessibilityOk([
        check('accessibility', 'granted', true),
        check('microphone', 'denied', false),
        check('screen', 'denied', false)
      ])
    ).toBe(true)
  })

  it('swaps to the restart label when a granted permission is TCC-stale', () => {
    expect(
      needsRestart([
        check('accessibility', 'granted', true),
        check('screen', 'granted', false, true)
      ])
    ).toBe(true)
  })

  it('keeps the normal label when a stale flag sits on an ungranted permission', () => {
    expect(
      needsRestart([
        check('accessibility', 'granted', true),
        check('screen', 'denied', false, true)
      ])
    ).toBe(false)
  })
})
