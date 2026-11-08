/**
 * The connect-layer rewrite's contract.
 * Every transition and every reason has a test -- this file lands before any
 * wiring so the vocabulary is settled before server/hook/UI consume it.
 */

import { describe, it, expect } from 'vitest'
import {
  transition,
  BLOCKED_REASON_INFO,
  type ConnState,
  type BlockedReason
} from '../connection-state'

const DISCONNECTED: ConnState = { kind: 'disconnected' }
const CONNECTING: ConnState = { kind: 'connecting' }
const CONNECTED: ConnState = { kind: 'connected' }
const REASONS: BlockedReason[] = [
  'no-credential',
  'credential-revoked',
  'mac-unreachable',
  'mac-busy',
  'rate-limited'
]

describe('transition', () => {
  // ── connectAttemptStarted: legal from anywhere ──────────────────────────
  it.each([
    ['disconnected', DISCONNECTED],
    ['connecting', CONNECTING],
    ['connected', CONNECTED],
    ...REASONS.map((r) => [`blocked(${r})`, { kind: 'blocked', reason: r } as ConnState] as const)
  ])('connectAttemptStarted moves %s to connecting', (_label, from) => {
    expect(transition(from as ConnState, { type: 'connectAttemptStarted' })).toEqual(CONNECTING)
  })

  // ── socketOpened: only from connecting ──────────────────────────────────
  it('socketOpened moves connecting to connected', () => {
    expect(transition(CONNECTING, { type: 'socketOpened' })).toEqual(CONNECTED)
  })

  it.each([
    ['disconnected', DISCONNECTED],
    ['connected', CONNECTED],
    ['blocked', { kind: 'blocked', reason: 'mac-unreachable' } as ConnState]
  ])('socketOpened is a no-op from %s', (_label, from) => {
    expect(transition(from as ConnState, { type: 'socketOpened' })).toEqual(from)
  })

  // ── socketClosed: reason -> blocked, no reason -> disconnected ──────────
  it.each(REASONS)('socketClosed(%s) moves connecting to blocked(%s)', (reason) => {
    expect(transition(CONNECTING, { type: 'socketClosed', reason })).toEqual({
      kind: 'blocked',
      reason
    })
  })

  it.each(REASONS)('socketClosed(%s) moves connected to blocked(%s)', (reason) => {
    expect(transition(CONNECTED, { type: 'socketClosed', reason })).toEqual({
      kind: 'blocked',
      reason
    })
  })

  it('socketClosed with no reason moves connecting to disconnected', () => {
    expect(transition(CONNECTING, { type: 'socketClosed', reason: null })).toEqual(DISCONNECTED)
  })

  it('socketClosed with no reason moves connected to disconnected', () => {
    expect(transition(CONNECTED, { type: 'socketClosed', reason: null })).toEqual(DISCONNECTED)
  })

  it.each([
    ['disconnected', DISCONNECTED],
    ['blocked', { kind: 'blocked', reason: 'mac-busy' } as ConnState]
  ])('socketClosed is a no-op from %s (stale/duplicate close)', (_label, from) => {
    expect(transition(from as ConnState, { type: 'socketClosed', reason: 'mac-unreachable' })).toEqual(
      from
    )
  })

  // ── retry: only from blocked or disconnected ────────────────────────────
  it('retry moves disconnected to connecting', () => {
    expect(transition(DISCONNECTED, { type: 'retry' })).toEqual(CONNECTING)
  })

  it.each(REASONS)('retry moves blocked(%s) to connecting', (reason) => {
    expect(transition({ kind: 'blocked', reason }, { type: 'retry' })).toEqual(CONNECTING)
  })

  it.each([
    ['connecting', CONNECTING],
    ['connected', CONNECTED]
  ])('retry is a no-op from %s (must not restart a socket that is fine)', (_label, from) => {
    expect(transition(from as ConnState, { type: 'retry' })).toEqual(from)
  })

  // ── approvalPending: the parked socket, waiting on the phone's verdict ────
  it('approvalPending moves connecting to awaitingApproval', () => {
    expect(transition(CONNECTING, { type: 'approvalPending', expiresAt: 1000 })).toEqual({
      kind: 'awaitingApproval',
      expiresAt: 1000
    })
  })

  it('approvalPending is a no-op from connected (a stale event must not unseat a live socket)', () => {
    expect(transition(CONNECTED, { type: 'approvalPending', expiresAt: 1000 })).toEqual(CONNECTED)
  })

  it('a denial closes the parked socket into blocked, not a silent hang', () => {
    // Deny and timeout both close as no-credential; without this edge the
    // waiting device would sit on the asking screen forever.
    const waiting: ConnState = { kind: 'awaitingApproval', expiresAt: 1000 }
    expect(transition(waiting, { type: 'socketClosed', reason: 'no-credential' })).toEqual({
      kind: 'blocked',
      reason: 'no-credential'
    })
  })
})

describe('BLOCKED_REASON_INFO', () => {
  it('has exactly the five reasons the PRD names, no more, no fewer', () => {
    expect(Object.keys(BLOCKED_REASON_INFO).sort()).toEqual([...REASONS].sort())
  })

  it.each(REASONS)('%s has a summary and an action', (reason) => {
    const info = BLOCKED_REASON_INFO[reason]
    expect(info.summary.length).toBeGreaterThan(0)
    expect(info.action.length).toBeGreaterThan(0)
  })
})
