import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PATHS } from '../store/paths'
import { SETTINGS } from '../store/settings'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { devLog } from '../../shared/env'
import { PERMISSIONS } from '../platform'
import { sendToPhone } from '../phone-remote/server'
import { PHONE_FIRST_STEPS, PHONE_WELCOME_PICKS, type PhoneFirstStep } from '../../shared/phone-remote-protocol'

type FirstSteps = Record<PhoneFirstStep, number | null> & {
  shownAt: number | null
  welcomed: number | null
  micBlocked: boolean
  expired: boolean
}

const SHOW_FOR_MS = 7 * 24 * 60 * 60 * 1000

let cached: FirstSteps | null = null

function stamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function load(): FirstSteps {
  if (cached) return cached
  let raw: Partial<Record<keyof FirstSteps, unknown>> = {}
  try {
    if (existsSync(PATHS.PHONE_REMOTE_FIRST_STEPS)) {
      raw = JSON.parse(readFileSync(PATHS.PHONE_REMOTE_FIRST_STEPS, 'utf-8')) ?? {}
    }
  } catch (err) {
    devLog.warn('[phone-remote] could not read first-steps state', err)
  }
  cached = {
    shownAt: stamp(raw.shownAt),
    welcomed: stamp(raw.welcomed),
    move: stamp(raw.move),
    tap: stamp(raw.tap),
    talk: stamp(raw.talk),
    micBlocked: raw.micBlocked === true,
    expired: raw.expired === true
  }
  return cached
}

function save(state: FirstSteps): void {
  try {
    writeFileSync(PATHS.PHONE_REMOTE_FIRST_STEPS, JSON.stringify(state), 'utf-8')
  } catch (err) {
    devLog.warn('[phone-remote] could not write first-steps state', err)
  }
}

function secondsSinceShown(state: FirstSteps): number {
  return state.shownAt === null ? 0 : Math.round((Date.now() - state.shownAt) / 1000)
}

function allDone(state: FirstSteps): boolean {
  return PHONE_FIRST_STEPS.every((step) => state[step] !== null)
}

export function sendFirstStepsToPhone(): void {
  const state = load()
  if (!allDone(state) && !state.expired) {
    if (state.shownAt === null) {
      state.shownAt = Date.now()
      save(state)
      track(ANALYTICS_EVENT.phone_first_step, { step: 'shown', s_since_shown: 0 })
    } else if (Date.now() - state.shownAt > SHOW_FOR_MS) {
      state.expired = true
      save(state)
      track(ANALYTICS_EVENT.phone_first_step, {
        step: 'expired',
        s_since_shown: secondsSinceShown(state)
      })
    }
  }
  sendToPhone({
    type: 'firstSteps',
    show: !allDone(state) && !state.expired,
    welcome: state.welcomed === null && !state.expired,
    advanced: SETTINGS.advancedMode(),
    micBlocked: state.micBlocked,
    move: state.move !== null,
    tap: state.tap !== null,
    talk: state.talk !== null
  })
}

// Called on every pointer move the phone sends: the early return must stay a cached compare.
export function notePhoneFirstStep(step: PhoneFirstStep): void {
  const state = load()
  if (state[step] !== null) return
  if (step !== 'talk' && !PERMISSIONS.hasAccessibility(false)) return
  state[step] = Date.now()
  if (step === 'talk') state.micBlocked = false
  save(state)
  track(ANALYTICS_EVENT.phone_first_step, { step, s_since_shown: secondsSinceShown(state) })
  sendFirstStepsToPhone()
}

export function notePhoneWelcomePick(pick: unknown): void {
  const picked = PHONE_WELCOME_PICKS.find((p) => p === pick)
  const state = load()
  if (!picked || state.welcomed !== null) return
  state.welcomed = Date.now()
  save(state)
  track(ANALYTICS_EVENT.phone_first_step, {
    step: `welcome_${picked}`,
    s_since_shown: secondsSinceShown(state)
  })
  sendFirstStepsToPhone()
}

export function notePhoneMicDenied(): void {
  const state = load()
  track(ANALYTICS_EVENT.phone_first_step, {
    step: 'mic_denied',
    s_since_shown: secondsSinceShown(state)
  })
  if (state.micBlocked || state.talk !== null) return
  state.micBlocked = true
  save(state)
  sendFirstStepsToPhone()
}
