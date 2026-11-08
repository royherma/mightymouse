/**
 * The Mac's own alert switches, for the Code window's Settings tab.
 *
 * WHY it is separate from the phone's sheet (src/main/phone-remote/react/
 * CodeSheet.tsx): they used to be one set of answers, and the send path checked
 * the phone's copy first -- so turning off updates on the phone silently killed
 * every Mac alert of that kind too. Two
 * surfaces, two answers, one screen each.
 *
 * Writes the whole object per change rather than one switch at a time: this
 * screen owns every control on it, so one round trip beats six.
 */

import { JSX, useCallback, useEffect, useState } from 'react'
import { Switch } from '../components/Switch'
import {
  RELAY_MAC_FOOTNOTE,
  RELAY_MAC_PHONE_NOTE,
  RELAY_MAC_PUSH_LABELS,
  RELAY_NOTIFY_LEVEL_HINT,
  RELAY_NOTIFY_LEVEL_LABEL,
  RELAY_PUSH_EMOJI,
  RELAY_PUSH_VERBS,
  type RelayMacAlertSettings,
  type RelayMacRenderer
} from '../../../shared/relay-push-filter'

/** What each look actually costs you, in the user's words. The second line is
 *  the honest trade -- a card you miss is gone, and hiding that would make the
 *  choice a trap rather than a preference. */
const LOOK_OPTIONS: { id: RelayMacRenderer; title: string; hint: string }[] = [
  {
    id: 'native',
    title: 'macOS notifications',
    hint: 'They wait for you in Notification Center and follow your Focus settings. Room for two buttons.'
  },
  {
    id: 'card',
    title: 'MightyMouse cards',
    hint: 'Every button the agent offered, right on your screen. If you miss one, it is gone.'
  }
]

export function MightyMacAlerts(): JSX.Element | null {
  const [mac, setMac] = useState<RelayMacAlertSettings | null>(null)

  useEffect(() => {
    void (async () => setMac(await window.api.agentRelayGetMacAlerts()))()
  }, [])

  const save = useCallback((next: RelayMacAlertSettings) => {
    // Optimistic: the switch must move under the finger, not after a round trip.
    setMac(next)
    void window.api.agentRelaySetMacAlerts(next)
  }, [])

  if (!mac) return null

  return (
    <div className="block space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-md font-medium">Alerts on this Mac</span>
        <Switch on={mac.enabled} onChange={(on) => save({ ...mac, enabled: on })} />
      </div>
      <span className="block text-sm text-muted">
        Pops up here when an agent needs you. {RELAY_MAC_PHONE_NOTE}
      </span>

      {mac.enabled && (
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">How they look</span>
            {LOOK_OPTIONS.map((opt) => (
              <label
                key={opt.id}
                className="flex gap-2.5 items-start cursor-pointer rounded-lg px-2.5 py-2 hover:bg-surface2"
              >
                <input
                  type="radio"
                  name="mm-mac-alert-look"
                  checked={mac.renderer === opt.id}
                  onChange={() => save({ ...mac, renderer: opt.id })}
                  className="mt-1 accent-accent"
                />
                <span className="space-y-0.5">
                  <span className="block text-md">{opt.title}</span>
                  <span className="block text-sm text-muted">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="space-y-1">
            <span className="block text-sm font-medium">What pops up here</span>
            {RELAY_PUSH_VERBS.map((verb) => (
              <div key={verb}>
                <div className="flex items-center gap-2.5 py-1.5">
                  <span aria-hidden="true">{RELAY_PUSH_EMOJI[verb]}</span>
                  <span className="text-md flex-1">{RELAY_MAC_PUSH_LABELS[verb]}</span>
                  <Switch
                    on={mac.filter[verb]}
                    onChange={(on) => save({ ...mac, filter: { ...mac.filter, [verb]: on } })}
                  />
                </div>
                {/* Indented under its parent switch and gone when that switch is
                    off -- a floor on a muted kind does nothing. */}
                {verb === 'notify' && mac.filter.notify && (
                  <div className="flex items-center gap-2.5 py-1.5 pl-7">
                    <span className="text-md flex-1">
                      {RELAY_NOTIFY_LEVEL_LABEL}
                      <span className="block text-sm text-muted">{RELAY_NOTIFY_LEVEL_HINT}</span>
                    </span>
                    <Switch
                      on={mac.notifyLevel === 'problems'}
                      onChange={(on) => save({ ...mac, notifyLevel: on ? 'problems' : 'all' })}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <span className="block text-sm text-muted">{RELAY_MAC_FOOTNOTE}</span>
        </div>
      )}
    </div>
  )
}
