import { track } from './analytics'
import { ANALYTICS_EVENT, type ChecklistStepKey } from '../shared/analytics-events'
import type { ActivationChecklist } from '../shared/types'
import { PERMISSIONS, requiredPermissionKeys } from './platform'
import { getPairedDeviceCount } from './phone-remote/server'
import { PREFS } from './store/prefs'

function readChecklist(): ActivationChecklist {
  const required = new Set(requiredPermissionKeys())
  return {
    permissionsGranted: PERMISSIONS.list()
      .filter((p) => required.has(p.key))
      .every((p) => p.status === 'granted'),
    firstRunDone: PREFS.getFirstRunSucceeded(),
    transcribeDone: PREFS.getTranscribeSucceeded(),
    phonePaired: getPairedDeviceCount() > 0,
    seenDone: PREFS.getChecklistSeenDone()
  }
}

/** remaining excludes the backend row -- that state lives client-side only
 * (see buildActivationChecklist() below), so it can't be counted here. */
function trackStep(step: ChecklistStepKey, c: ActivationChecklist): void {
  const done = [c.permissionsGranted, c.firstRunDone, c.transcribeDone, c.phonePaired]
  const remaining = done.filter((d) => !d).length
  track(ANALYTICS_EVENT.checklist_step_completed, { step, remaining })
  if (remaining === 0) track(ANALYTICS_EVENT.checklist_completed, {})
}

/** Every field is a live read of real app state -- no hand-set flag can lie
 * here. backendConnected is deliberately absent: it needs a real CLI probe
 * (probeBackend), too expensive to run on every panel reseed; the renderer
 * already has that result from its own panelProbeBackend() call. */
export function buildActivationChecklist(): ActivationChecklist {
  const c = readChecklist()
  // PERMISSIONS.list() is a pure poll with no latch of its own, unlike the
  // other three rows -- write one here, at the only place that observes the
  // live state, so the transition is still detected exactly once.
  if (c.permissionsGranted && !PREFS.getPermissionsSucceeded()) {
    PREFS.setPermissionsSucceeded()
    trackStep('permissions', c)
  }
  return c
}

/** Call right after writing a checklist latch (first-run, transcribe, phone
 * pair) so the event fires exactly once, at the real transition. */
export function trackChecklistStep(step: ChecklistStepKey): void {
  trackStep(step, readChecklist())
}
