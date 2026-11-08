/**
 * "relay toggle off -> MCP calls fail fast ... the error string IS
 * the guide." This is the one place that exact string is asserted verbatim
 * so a future copy edit can't silently break the fail-fast contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  DEFAULT_RELAY_MAC_ALERTS,
  DEFAULT_RELAY_PUSH_FILTER,
  RELAY_PUSH_VERBS,
  type RelayMacAlertSettings,
  type RelayNotifyPushLevel,
  type RelayPushFilter
} from '../../../shared/relay-push-filter'
import type { RelayRequest, RelayVerb } from '../store'

const getAgentRelayEnabled = vi.fn<() => boolean>()
const getAgentRelayPushFilter = vi.fn<() => RelayPushFilter>()
const getAgentRelayMacNotify = vi.fn<() => boolean>()
const getAgentRelayNotifyLevel = vi.fn<() => RelayNotifyPushLevel>()
const getAgentRelayMacAlerts = vi.fn<() => RelayMacAlertSettings>()

vi.mock('../../store/prefs', () => ({
  PREFS: {
    getAgentRelayEnabled: () => getAgentRelayEnabled(),
    getAgentRelayPushFilter: () => getAgentRelayPushFilter(),
    getAgentRelayNotifyLevel: () => getAgentRelayNotifyLevel(),
    getAgentRelayMacNotify: () => getAgentRelayMacNotify(),
    getAgentRelayMacAlerts: () => getAgentRelayMacAlerts()
  }
}))

// The Mac mirror needs Electron's Notification; mocked so the filter tests
// never leave the process.
const showMacRelayNotification = vi.fn()
vi.mock('../mac-notification', () => ({
  showMacRelayNotification: (...args: unknown[]) => showMacRelayNotification(...args)
}))

const pushableDevice = vi.fn()
vi.mock('../../phone-remote/server', () => ({
  pushableDevice: () => pushableDevice()
}))

const getSupabase = vi.fn()
vi.mock('../../supabase', () => ({
  getSupabase: () => getSupabase()
}))

describe('agentRelayOffReason / sendRelayPush relay-off fail-fast', () => {
  beforeEach(() => {
    vi.resetModules()
    getAgentRelayEnabled.mockReset()
    getAgentRelayPushFilter.mockReset()
    getAgentRelayPushFilter.mockReturnValue({ ...DEFAULT_RELAY_PUSH_FILTER })
    getAgentRelayMacNotify.mockReset()
    getAgentRelayMacNotify.mockReturnValue(false)
    getAgentRelayMacAlerts.mockReset()
    getAgentRelayMacAlerts.mockReturnValue({ ...DEFAULT_RELAY_MAC_ALERTS })
    getAgentRelayNotifyLevel.mockReset()
    getAgentRelayNotifyLevel.mockReturnValue('all')
    showMacRelayNotification.mockReset()
    pushableDevice.mockReset()
    getSupabase.mockReset()
  })

  it('returns the exact guide string when the toggle is off', async () => {
    getAgentRelayEnabled.mockReturnValue(false)
    const { agentRelayOffReason } = await import('../relay-send')
    expect(agentRelayOffReason()).toBe(
      'Agent relay is off in MightyMouse Settings. Turn it on to let this agent reach your phone.'
    )
  })

  it('returns null once the toggle is on', async () => {
    getAgentRelayEnabled.mockReturnValue(true)
    const { agentRelayOffReason } = await import('../relay-send')
    expect(agentRelayOffReason()).toBeNull()
  })

  it('sendRelayPush fails fast with reason "relay-off" before touching the device or network', async () => {
    getAgentRelayEnabled.mockReturnValue(false)
    const { sendRelayPush } = await import('../relay-send')

    const result = await sendRelayPush({
      id: 'req-1',
      verb: 'notify',
      params: { title: 'hi' },
      createdAt: Date.now(),
      timeoutMs: 1_000,
      status: 'pending',
      response: null,
      resolvedAt: null,
      resolvedBy: null,
      resolvedVia: null
    })

    expect(result).toEqual({
      ok: false,
      reason: 'relay-off',
      detail: 'Agent relay is off in MightyMouse Settings. Turn it on to let this agent reach your phone.'
    })
    // Fail-fast means it never reaches for a device or a session.
    expect(pushableDevice).not.toHaveBeenCalled()
    expect(getSupabase).not.toHaveBeenCalled()
  })
})

/**
 * design: which kinds of message may buzz the phone. All
 * four verbs are muteable,
 * so the test covers all four rather than a subset.
 */
describe('sendRelayPush push filter', () => {
  const loadSend = () => import('../relay-send')

  const requestFor = (verb: RelayVerb): RelayRequest => ({
    id: `req-${verb}`,
    verb,
    params: { title: 'hi' },
    createdAt: 0,
    timeoutMs: 1_000,
    status: 'pending',
    response: null,
    resolvedAt: null,
    resolvedBy: null,
    resolvedVia: null,
    fetched: false
  })

  beforeEach(() => {
    vi.resetModules()
    getAgentRelayEnabled.mockReset()
    getAgentRelayEnabled.mockReturnValue(true)
    getAgentRelayPushFilter.mockReset()
    getAgentRelayMacAlerts.mockReset()
    getAgentRelayMacAlerts.mockReturnValue({ ...DEFAULT_RELAY_MAC_ALERTS })
    getAgentRelayMacNotify.mockReset()
    getAgentRelayMacNotify.mockReturnValue(false)
    getAgentRelayMacAlerts.mockReset()
    getAgentRelayMacAlerts.mockReturnValue({ ...DEFAULT_RELAY_MAC_ALERTS })
    getAgentRelayNotifyLevel.mockReset()
    getAgentRelayNotifyLevel.mockReturnValue('all')
    showMacRelayNotification.mockReset()
    pushableDevice.mockReset()
    getSupabase.mockReset()
  })

  it.each(RELAY_PUSH_VERBS)('mutes %s without touching the device or network', async (verb) => {
    getAgentRelayPushFilter.mockReturnValue({ ...DEFAULT_RELAY_PUSH_FILTER, [verb]: false })
    const { sendRelayPush } = await loadSend()

    const result = await sendRelayPush(requestFor(verb))

    // ok:true on purpose -- the caller treats ok:false as a fault worth
    // logging, and a push the user switched off is not a fault.
    expect(result).toEqual({ ok: true, deviceLabel: 'muted (push filter)' })
    expect(pushableDevice).not.toHaveBeenCalled()
    expect(getSupabase).not.toHaveBeenCalled()
    // The filter runs before the Mac mirror, so muting kills both.
    expect(showMacRelayNotification).not.toHaveBeenCalled()
  })

  it.each(RELAY_PUSH_VERBS)('lets %s through when its switch is on', async (verb) => {
    getAgentRelayPushFilter.mockReturnValue({ ...DEFAULT_RELAY_PUSH_FILTER })
    // Stop at the device check: proving it got PAST the filter is the point,
    // and a real send would need a JWT and a network.
    pushableDevice.mockReturnValue({ deviceId: null, reason: 'no-device' })
    const { sendRelayPush } = await loadSend()

    const result = await sendRelayPush(requestFor(verb))

    expect(result.ok).toBe(false)
    expect(pushableDevice).toHaveBeenCalled()
  })

  it('muting one verb leaves the other three alone', async () => {
    getAgentRelayPushFilter.mockReturnValue({ ...DEFAULT_RELAY_PUSH_FILTER, notify: false })
    pushableDevice.mockReturnValue({ deviceId: null, reason: 'no-device' })
    const { sendRelayPush } = await loadSend()

    expect((await sendRelayPush(requestFor('notify'))).ok).toBe(true)
    for (const verb of ['ask', 'approve', 'show'] as const) {
      expect((await sendRelayPush(requestFor(verb))).ok).toBe(false)
    }
  })
})

/** The severity floor under `notify`. The load-bearing case is the untagged
 *  one: `level` is optional and most senders omit it, so "problems only" mutes
 *  the majority of today's traffic -- that is the intended reading, and this
 *  locks it so nobody "fixes" it into letting untagged notifies through. */
describe('sendRelayPush notify severity floor', () => {
  const loadSend = () => import('../relay-send')

  const notifyWith = (level?: string): RelayRequest => ({
    id: `req-notify-${level ?? 'none'}`,
    verb: 'notify',
    params: level === undefined ? { title: 'hi' } : { title: 'hi', level },
    createdAt: 0,
    timeoutMs: 1_000,
    status: 'pending',
    response: null,
    resolvedAt: null,
    resolvedBy: null,
    resolvedVia: null,
    fetched: false
  })

  beforeEach(() => {
    vi.resetModules()
    getAgentRelayEnabled.mockReset()
    getAgentRelayEnabled.mockReturnValue(true)
    getAgentRelayPushFilter.mockReset()
    getAgentRelayPushFilter.mockReturnValue({ ...DEFAULT_RELAY_PUSH_FILTER })
    getAgentRelayNotifyLevel.mockReset()
    getAgentRelayNotifyLevel.mockReturnValue('problems')
    getAgentRelayMacNotify.mockReset()
    getAgentRelayMacNotify.mockReturnValue(false)
    getAgentRelayMacAlerts.mockReset()
    getAgentRelayMacAlerts.mockReturnValue({ ...DEFAULT_RELAY_MAC_ALERTS })
    showMacRelayNotification.mockReset()
    pushableDevice.mockReset()
    pushableDevice.mockReturnValue({ deviceId: null, reason: 'no-device' })
    getSupabase.mockReset()
  })

  it.each(['warn', 'error'])('lets %s through', async (level) => {
    const { sendRelayPush } = await loadSend()
    expect((await sendRelayPush(notifyWith(level))).ok).toBe(false)
    expect(pushableDevice).toHaveBeenCalled()
  })

  it.each(['info', 'success', undefined])('mutes %s', async (level) => {
    const { sendRelayPush } = await loadSend()

    expect(await sendRelayPush(notifyWith(level))).toEqual({
      ok: true,
      deviceLabel: 'muted (notify level)'
    })
    expect(pushableDevice).not.toHaveBeenCalled()
  })

  it('never touches the other three verbs -- they carry no level', async () => {
    const { sendRelayPush } = await loadSend()

    for (const verb of ['ask', 'approve', 'show'] as const) {
      expect((await sendRelayPush({ ...notifyWith(), verb })).ok).toBe(false)
    }
  })

  it("passes everything on 'all'", async () => {
    getAgentRelayNotifyLevel.mockReturnValue('all')
    const { sendRelayPush } = await loadSend()

    expect((await sendRelayPush(notifyWith())).ok).toBe(false)
    expect(pushableDevice).toHaveBeenCalled()
  })

  /** The turn-end ping is untagged AND has its own opt-in switch, so the floor
   *  above would eat every one of it -- two switches silently cancelling each
   *  other, which is exactly what shipped. `idle` is the flag
   *  the Stop hook sets, and it is the exemption. */
  it('lets an untagged idle ping through the problems floor', async () => {
    const { sendRelayPush } = await loadSend()
    const idle = { ...notifyWith(), params: { title: 'hi', idle: true } }

    expect((await sendRelayPush(idle)).ok).toBe(false)
    expect(pushableDevice).toHaveBeenCalled()
  })

  /** Same exemption, one state wider: an "All done" is the end of the work, not
   *  a step in it, so the floor muting it left the one card a person is waiting
   *  on as the only one they never got. */
  it('lets an untagged done notify through the problems floor', async () => {
    const { sendRelayPush } = await loadSend()
    const done = { ...notifyWith(), params: { title: 'All done', state: 'done' as const } }

    expect((await sendRelayPush(done)).ok).toBe(false)
    expect(pushableDevice).toHaveBeenCalled()
  })

  it('still mutes an untagged progress notify', async () => {
    const { sendRelayPush } = await loadSend()
    const progress = { ...notifyWith(), params: { title: 'hi', state: 'progress' as const } }

    expect(await sendRelayPush(progress)).toEqual({
      ok: true,
      deviceLabel: 'muted (notify level)'
    })
  })
})

/**
 * The defect this design exists to fix: the Mac mirror
 * used to sit BELOW the phone's gates, so a `return` for a phone-muted verb was
 * also a return for the Mac. Muting updates on the phone silently killed every
 * Mac alert of that kind. These lock the two surfaces apart.
 */
describe('sendRelayPush mac alerts are independent of the phone filter', () => {
  const getAgentRelayEnabledLocal = getAgentRelayEnabled

  beforeEach(() => {
    vi.resetModules()
    getAgentRelayEnabledLocal.mockReset()
    getAgentRelayEnabledLocal.mockReturnValue(true)
    getAgentRelayPushFilter.mockReset()
    getAgentRelayPushFilter.mockReturnValue({ ...DEFAULT_RELAY_PUSH_FILTER })
    getAgentRelayNotifyLevel.mockReset()
    getAgentRelayNotifyLevel.mockReturnValue('all')
    getAgentRelayMacNotify.mockReset()
    getAgentRelayMacNotify.mockReturnValue(false)
    getAgentRelayMacAlerts.mockReset()
    getAgentRelayMacAlerts.mockReturnValue({ ...DEFAULT_RELAY_MAC_ALERTS })
    showMacRelayNotification.mockReset()
    pushableDevice.mockReset()
    pushableDevice.mockReturnValue({ deviceId: null, reason: 'no-device' })
    getSupabase.mockReset()
  })

  const card = (): RelayRequest => ({
    id: 'req-mac',
    verb: 'notify',
    params: { title: 'hi' },
    createdAt: 0,
    timeoutMs: 1_000,
    status: 'pending',
    response: null,
    resolvedAt: null,
    resolvedBy: null,
    resolvedVia: null,
    fetched: false
  })

  it('still alerts the Mac when the phone has that kind muted', async () => {
    getAgentRelayPushFilter.mockReturnValue({ ...DEFAULT_RELAY_PUSH_FILTER, notify: false })
    getAgentRelayMacAlerts.mockReturnValue({ ...DEFAULT_RELAY_MAC_ALERTS, enabled: true })

    const { sendRelayPush } = await import('../relay-send')
    const result = await sendRelayPush(card())

    // The phone is muted -- and the Mac was told anyway. Before the fix this
    // assertion failed: the early return happened first.
    expect(showMacRelayNotification).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, deviceLabel: 'muted (push filter)' })
  })

  it('still alerts the Mac when the phone severity floor mutes the update', async () => {
    getAgentRelayNotifyLevel.mockReturnValue('problems')
    getAgentRelayMacAlerts.mockReturnValue({ ...DEFAULT_RELAY_MAC_ALERTS, enabled: true })

    const { sendRelayPush } = await import('../relay-send')
    const progress = { ...card(), params: { title: 'hi', state: 'progress' as const } }
    const result = await sendRelayPush(progress)

    expect(showMacRelayNotification).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, deviceLabel: 'muted (notify level)' })
  })

  it('stays quiet on the Mac when the Mac has that kind muted, phone unaffected', async () => {
    getAgentRelayMacAlerts.mockReturnValue({
      ...DEFAULT_RELAY_MAC_ALERTS,
      enabled: true,
      filter: { ...DEFAULT_RELAY_MAC_ALERTS.filter, notify: false }
    })

    const { sendRelayPush } = await import('../relay-send')
    await sendRelayPush(card())

    // Muting the Mac must not mute the phone: the push still ran and only
    // failed for want of a paired device.
    expect(showMacRelayNotification).not.toHaveBeenCalled()
    expect(pushableDevice).toHaveBeenCalled()
  })

  it('shows nothing on the Mac while the master switch is off', async () => {
    const { sendRelayPush } = await import('../relay-send')
    await sendRelayPush(card())

    expect(showMacRelayNotification).not.toHaveBeenCalled()
  })

  it('applies the Mac severity floor without touching the phone', async () => {
    getAgentRelayMacAlerts.mockReturnValue({
      ...DEFAULT_RELAY_MAC_ALERTS,
      enabled: true,
      notifyLevel: 'problems'
    })

    const { sendRelayPush } = await import('../relay-send')
    const progress = { ...card(), params: { title: 'hi', state: 'progress' as const } }
    await sendRelayPush(progress)

    expect(showMacRelayNotification).not.toHaveBeenCalled()
    expect(pushableDevice).toHaveBeenCalled()
  })
})
