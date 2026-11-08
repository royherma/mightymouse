import { Fragment } from 'react'
import { Bell, BellOff, ChevronLeft, ChevronRight } from 'lucide-react'
import type { RelayVerbWire } from '@shared/phone-remote-protocol'
import {
  RELAY_PUSH_VERBS,
  RELAY_PUSH_EMOJI,
  RELAY_PUSH_LABELS,
  RELAY_PUSH_FOOTNOTE,
  RELAY_NOTIFY_LEVEL_LABEL,
  RELAY_NOTIFY_LEVEL_HINT,
  RELAY_TURN_END_LABEL,
  RELAY_TURN_END_HINT,
  type RelayNotifyPushLevel,
  type RelayPushFilter
} from '@shared/relay-push-filter'
import { hapticTick } from '../haptics'
import { nativeBridge } from '../native-bridge'
import PhoneRemoteTitleBar from '../PhoneRemoteTitleBar'
import type { PushStatus } from './use-ai-session'
import { Button } from '@shared/ui/Button'

/** `notDetermined` is the only state a tap can fix in-app, so it gets the only
 *  "turn on" label -- promising that to a denied user does nothing visible. */
function pushStatusCopy(status: Exclude<PushStatus, null>): {
  state: string
  line: string
  action: string
} {
  if (status === 'authorized') {
    return {
      state: 'Alerts are on. ',
      line: 'Your phone can buzz you when an agent needs something.',
      action: 'Change in iPhone Settings'
    }
  }
  if (status === 'notDetermined') {
    return {
      state: 'Alerts are off. ',
      line: 'Your phone has not been asked yet, so nothing can buzz you.',
      action: 'Turn on alerts'
    }
  }
  return {
    state: 'Alerts are off. ',
    line: 'You turned them off for MightyMouse, so nothing can buzz you.',
    action: 'Open iPhone Settings'
  }
}

/** `filter === null` means the Mac has not answered: render disabled rather
 *  than guess "on" and promise a buzz that will never come. */
export function AlertSettings({
  status,
  filter,
  notifyLevel,
  turnEndPing,
  onSetPush,
  onSetNotifyLevel,
  onSetTurnEndPing,
  onClose
}: {
  status: PushStatus
  filter: RelayPushFilter | null
  notifyLevel: RelayNotifyPushLevel
  turnEndPing: boolean
  onSetPush?: (verb: RelayVerbWire, on: boolean) => void
  onSetNotifyLevel?: (level: RelayNotifyPushLevel) => void
  onSetTurnEndPing?: (on: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const copy = status === null ? null : pushStatusCopy(status)
  return (
    <div className="codeAlerts" role="dialog" aria-label="Alerts">
      <PhoneRemoteTitleBar
        className="chatHeader"
        leading={
          <Button variant="bare" className="chatHeaderBtn chatBackBtn" aria-label="Back" onClick={onClose}>
            <ChevronLeft size={18} />
          </Button>
        }
        title={<span className="chatTitle">Alerts</span>}
      />

      <div className="codeAlertsBody">
        {copy && (
          <div className="codeAlertsPerm" data-on={status === 'authorized' ? '' : undefined}>
            <div className="codeAlertsPermLine">
              <span className="codeAlertsPermIcon">
                {status === 'authorized' ? (
                  <Bell size={15} strokeWidth={2.25} />
                ) : (
                  <BellOff size={15} strokeWidth={2.25} />
                )}
              </span>
              <span>
                <span className="codeAlertsPermState">{copy.state}</span>
                {copy.line}
              </span>
            </div>
            <Button
              variant="secondary" size="lg"
              className="codeAlertsPermBtn"
              onClick={() => {
                hapticTick()
                // One call for all states -- Swift branches on the live status.
                nativeBridge.pushSettingsOpen()
              }}
            >
              {copy.action}
              <ChevronRight size={15} strokeWidth={2.5} />
            </Button>
          </div>
        )}

        <div className="codeAlertsTitle">What buzzes your phone</div>
        <div className="codeAlertsList">
          {RELAY_PUSH_VERBS.map((verb) => (
            <Fragment key={verb}>
              <div className="codeAlertsRow">
                <span className="codeAlertsEmoji" aria-hidden="true">
                  {RELAY_PUSH_EMOJI[verb]}
                </span>
                <span className="label">{RELAY_PUSH_LABELS[verb]}</span>
                <label className="mirrorToggle">
                  <input
                    type="checkbox"
                    checked={filter ? filter[verb] : false}
                    disabled={!filter || !onSetPush}
                    onChange={(e) => {
                      hapticTick()
                      onSetPush?.(verb, e.target.checked)
                    }}
                  />
                  <span className="mirrorToggleTrack" />
                </label>
              </div>
              {/* Indented under its parent switch, and gone when that switch is
                  off -- a floor on a muted verb does nothing. */}
              {verb === 'notify' && filter?.notify && (
                <div className="codeAlertsRow codeAlertsSubRow">
                  <span className="label">
                    {RELAY_NOTIFY_LEVEL_LABEL}
                    <span className="codeAlertsSubHint">{RELAY_NOTIFY_LEVEL_HINT}</span>
                  </span>
                  <label className="mirrorToggle">
                    <input
                      type="checkbox"
                      checked={notifyLevel === 'problems'}
                      disabled={!onSetNotifyLevel}
                      onChange={(e) => {
                        hapticTick()
                        onSetNotifyLevel?.(e.target.checked ? 'problems' : 'all')
                      }}
                    />
                    <span className="mirrorToggleTrack" />
                  </label>
                </div>
              )}
              {/* Opt-in, and off by default: it fires every time any agent
                  finishes anything. */}
              {verb === 'notify' && filter?.notify && (
                <div className="codeAlertsRow codeAlertsSubRow">
                  <span className="label">
                    {RELAY_TURN_END_LABEL}
                    <span className="codeAlertsSubHint">{RELAY_TURN_END_HINT}</span>
                  </span>
                  <label className="mirrorToggle">
                    <input
                      type="checkbox"
                      checked={turnEndPing}
                      disabled={!onSetTurnEndPing}
                      onChange={(e) => {
                        hapticTick()
                        onSetTurnEndPing?.(e.target.checked)
                      }}
                    />
                    <span className="mirrorToggleTrack" />
                  </label>
                </div>
              )}
            </Fragment>
          ))}
        </div>
        <div className="settingHint">
          {filter ? RELAY_PUSH_FOOTNOTE : 'Waiting for your Mac to say which of these are on.'}
        </div>
      </div>
    </div>
  )
}
