// The ONLY place an ActionDefinition.run is called; re-verifies the picked
// id and slot values against the definition before running.
import { CONFIG } from '../../shared/config'
import { withTimeout } from '../auth'
import type { ActionDefinition, ActionRunInput, ActionRunResult } from '../../shared/action-engine'

function slotsAreValid(def: ActionDefinition, slots: ActionRunInput['slots']): boolean {
  for (const slot of def.slots) {
    if (slot.kind !== 'choice') continue
    if (!Object.prototype.hasOwnProperty.call(slots, slot.key)) continue
    const value = slots[slot.key]
    if (!slot.options.some((o) => o.value === value)) return false
  }
  return true
}

// Never throws — a slot value outside the offered options is rejected, not run.
export async function executeAction(
  def: ActionDefinition,
  input: ActionRunInput
): Promise<ActionRunResult> {
  if (!slotsAreValid(def, input.slots)) {
    return { ok: false, line: 'rejected: unknown-slot-value' }
  }

  try {
    return await withTimeout(def.run(input), def.timeoutMs ?? CONFIG.ACTIONS.RUN_TIMEOUT_MS, {
      ok: false,
      line: 'timed out'
    })
  } catch (err) {
    return { ok: false, line: err instanceof Error ? err.message : 'run failed' }
  }
}
