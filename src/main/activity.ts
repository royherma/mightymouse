/**
 * Activity emitter — the ONE place that knows "what is MightyMouse doing right now"
 * for the Dynamic Island. There is no central activity bus elsewhere: each capture
 * subsystem owns its own boolean (isRecording / isListening) and pushes per-card
 * HUD updates. Rather than have the island subscribe to HUD internals, the capture +
 * run lifecycle points call setActivity(...) here, and we fan that out to the island.
 *
 * Dependency injection: this module must NOT import island-window.ts (that module
 * imports the renderer/window stack, and a cycle would bite at init). Instead,
 * index.ts wires the push function once via initActivity(pushIslandActivity) — the
 * same pattern as configureAuth / configureOnboarding.
 *
 * setActivity is a no-op cost when the island is off: pushIslandActivity itself
 * checks whether the window exists, so call sites stay dumb and unconditional.
 */
import { CONFIG } from '../shared/config'
import { ActivityState, ActivityPayload } from '../shared/types'

type PushFn = (payload: ActivityPayload) => void

// Injected by initActivity(). No-op until wired, so importing this module before
// the island window module is loaded can't throw.
let push: PushFn = () => {}

let current: ActivityPayload = { state: 'idle' }
// One timer for the done/error → idle auto-reset. Cleared on every state change so
// a fresh activity never gets clobbered by a stale reset from the previous one.
let resetTimer: NodeJS.Timeout | null = null

/** Wire the island push function. Called once from index.ts after both modules load. */
export function initActivity(pushFn: PushFn): void {
  push = pushFn
}

/**
 * Record the current activity and fan it out to the island. `done` and `error`
 * auto-reset to `idle` after CONFIG.ISLAND.RESET_MS so the island never hangs on a
 * stale terminal state. Passing `idle` clears any pending reset.
 */
export function setActivity(state: ActivityState, detail?: string, elapsed?: number): void {
  current = { state, detail, elapsed }
  push(current)

  if (resetTimer) {
    clearTimeout(resetTimer)
    resetTimer = null
  }
  if (state === 'done' || state === 'error') {
    resetTimer = setTimeout(() => {
      resetTimer = null
      setActivity('idle')
    }, CONFIG.ISLAND.RESET_MS)
  }
}

/** The latest activity. Used to seed the island renderer on (re)connect. */
export function getActivity(): ActivityPayload {
  return current
}
