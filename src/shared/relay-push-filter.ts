/**
 * Which kinds of agent message are allowed to buzz the phone.
 *
 * Gates the PUSH and nothing else. The card is minted into the store before a
 * push is ever sent, so a muted verb still lands in the HUD, the Panel and the
 * phone inbox -- muting costs you the buzz, never the message. That guarantee
 * is what makes muting `ask`/`approve` acceptable at all, since either can
 * leave an agent blocked for hours with no signal.
 *
 * Mac-OWNED, not Mac-only: it gates the send, so the phone can never enforce it
 * -- but the phone's alerts sheet reads and writes the same one answer.
 *
 */

import type { RelayVerbWire } from './phone-remote-protocol'

/** Same verbs as RELAY_VERBS/RelayVerbWire, restated as a value because a
 *  filter has to be iterated (to build a default, to render a row per switch)
 *  and a type alone cannot be. Typed against RelayVerbWire so dropping a verb
 *  here fails the build rather than silently un-gating it. */
export const RELAY_PUSH_VERBS: readonly RelayVerbWire[] = [
  'ask',
  'approve',
  'notify',
  'show',
  'photos_get'
]

export type RelayPushFilter = Record<RelayVerbWire, boolean>

/** A floor UNDER the notify switch, not a fifth verb: `level` is notify-only.
 *  `level` is optional and most agents omit it, so 'problems' mutes the
 *  MAJORITY of today's traffic -- intended, and why the row says so out loud. */
export type RelayNotifyPushLevel = 'all' | 'problems'

/** Not 'info': an agent that tags nothing gets no severity invented for it. */
export const RELAY_PROBLEM_LEVELS: readonly string[] = ['warn', 'error']

export function passesNotifyLevel(floor: RelayNotifyPushLevel, level?: string): boolean {
  return floor === 'all' || (level !== undefined && RELAY_PROBLEM_LEVELS.includes(level))
}

/** One shape because it is one stored file, one broadcast and one screen. */
export type RelayPushSettings = {
  filter: RelayPushFilter
  notifyLevel: RelayNotifyPushLevel
  turnEndPing: boolean
}

/** How a relay card is drawn on the Mac. Not a quality ranking -- each wins
 *  somewhere the other cannot. `native` survives you not looking (it waits in
 *  Notification Center and respects Focus) but caps at two buttons and draws
 *  nothing at all for a multi-question ask. `card` shows every option the agent
 *  offered and needs no macOS permission, but is gone if you miss it. */
export type RelayMacRenderer = 'native' | 'card'

/** The Mac's own answers, deliberately NOT the phone's. The phone filter gates
 *  the push; this gates the mirror, and they used to be one record -- which
 *  meant muting updates on the phone silently killed them on the Mac too. */
export type RelayMacAlertSettings = {
  enabled: boolean
  renderer: RelayMacRenderer
  filter: RelayPushFilter
  notifyLevel: RelayNotifyPushLevel
}

/** Off, like the pref it replaces: turning Mac alerts on for someone who never
 *  asked is the same unasked-for interruption DEFAULT_RELAY_TURN_END_PING
 *  avoids. Every verb on underneath, so switching the master on is loud rather
 *  than mysteriously silent. */
export const DEFAULT_RELAY_MAC_ALERTS: RelayMacAlertSettings = {
  enabled: false,
  renderer: 'native',
  filter: { ask: true, approve: true, notify: true, show: true, photos_get: true },
  notifyLevel: 'all'
}

/** The phone says "buzz me" because a phone buzzes. Nothing buzzes on a Mac, so
 *  the same switches need their own words -- same order, same meaning. */
export const RELAY_MAC_PUSH_LABELS: Record<RelayVerbWire, string> = {
  ask: 'When an agent asks a question',
  approve: 'When an agent needs the OK',
  notify: 'Updates',
  show: 'Things to look at',
  photos_get: 'When an agent wants a photo'
}

/** Mac twin of RELAY_PUSH_FOOTNOTE, plus the half that stops this screen
 *  reading like it silenced the phone as well. */
export const RELAY_MAC_FOOTNOTE =
  'Turning one off just stops the pop-up. It still shows up in MightyMouse.'
export const RELAY_MAC_PHONE_NOTE =
  'Your phone has its own switches. Changing these leaves it alone.'

/** Every verb on. Absent or unparseable prefs read as this: the failure mode of
 *  a bad file must be "you get buzzed", never "you silently get nothing". */
export const DEFAULT_RELAY_PUSH_FILTER: RelayPushFilter = {
  ask: true,
  approve: true,
  notify: true,
  show: true,
  photos_get: true
}

/** What each switch says. Benefits, not verbs -- the user never sees the word
 *  "notify" or "verb" (docs/brand-voice.md). Order is the display order:
 *  the two that block an agent first, since those are the ones worth thinking
 *  twice about turning off. */
export const RELAY_PUSH_LABELS: Record<RelayVerbWire, string> = {
  ask: 'Buzz me when an agent asks a question',
  approve: 'Buzz me when an agent needs the OK',
  notify: 'Buzz me for updates',
  show: 'Buzz me for things to look at',
  photos_get: 'Buzz me when an agent wants a photo'
}

/** One per switch, so a row is scannable before it is read. Picked for the
 *  STAKES, not the noun: the two that leave an agent blocked get faces, the two
 *  that are only news get objects. */
export const RELAY_PUSH_EMOJI: Record<RelayVerbWire, string> = {
  ask: '🙋',
  approve: '🫱',
  notify: '📣',
  show: '👀',
  photos_get: '🖼️'
}

export const RELAY_NOTIFY_LEVEL_LABEL = 'Only buzz me when something looks wrong'
export const RELAY_NOTIFY_LEVEL_HINT =
  'Warnings and errors still buzz. Ordinary updates stay quiet until you open MightyMouse.'

/** Sits UNDER the notify switch like `notifyLevel`, and is read by the Stop
 *  hook rather than by any send path here: the ping it gates is fired from
 *  outside the app entirely (~/.claude/hooks/mm-relay-notify.sh), so this file
 *  owns the answer and the shell reads it out of the same JSON.
 *
 *  Default OFF. A turn-end ping fires every time any agent finishes anything,
 *  which is a lot of buzzing to switch on for someone who never asked for it --
 *  the opposite default from the four verbs, and deliberately so. */
export const DEFAULT_RELAY_TURN_END_PING = false

export const RELAY_TURN_END_LABEL = 'Buzz me when an agent finishes its turn'
export const RELAY_TURN_END_HINT =
  'Tells you what it just did, so you can pick up where it left off without going back to the Mac.'

/** Ships directly under the switches. Load-bearing, not decoration: it is the
 *  entire reason turning one off is safe, so it goes wherever they go. */
export const RELAY_PUSH_FOOTNOTE =
  'Turning one off just stops the buzz. It still shows up in MightyMouse.'
