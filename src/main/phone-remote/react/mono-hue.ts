import type { AppContextGroup } from '@shared/app-context'

/** Distinct monogram colors. 12 × 30° is the most a hue wheel gives before two
 *  slots stop reading as different colors at 22px. */
const MONO_SLOTS = 12

/** Probe step. Coprime with MONO_SLOTS, so probing visits every slot before it
 *  repeats — any other step would give up while slots were still free. */
const PROBE_STEP = 5

function fnv1a(s: string): number {
  let h = 2166136261
  for (let n = 0; n < s.length; n++) {
    h ^= s.charCodeAt(n)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h | 0)
}

/**
 * A hue per group, assigned so no two groups on screen share one.
 *
 * HASHING ALONE IS NOT ENOUGH, and that is the whole reason for the probe:
 * hashing eight real cmux tab ids put two of them 0.5° apart, which renders as
 * one color. Nudging the hash (golden angle, more bits, more slots) only moves
 * which pair collides — with 8 items over 12 slots the birthday odds of SOME
 * collision are ~93%. So hash for a stable PREFERENCE, then linear-probe to the
 * next free slot.
 *
 * Keyed on the id, never the render index: a hue that shifts when a tab opens or
 * closes makes the color noise instead of a landmark. Order does decide who wins
 * a contested slot, so a tab CAN change color when an earlier one closes — the
 * alternative is two rows that look identical, which is the bug this fixes.
 *
 * Past MONO_SLOTS groups the probe finds nothing free and colors repeat. That is
 * the honest degradation: a 13th hue would be a duplicate that merely pretends
 * to differ.
 *
 * Saturation and lightness stay in the CSS so white text cannot be made
 * unreadable from here.
 */
export function monoHues(groups: AppContextGroup[]): Map<string, number> {
  const taken = new Set<number>()
  const out = new Map<string, number>()
  for (const g of groups) {
    if (g.iconPngBase64) continue // has a real avatar, never draws a monogram
    let slot = fnv1a(g.id) % MONO_SLOTS
    for (let k = 0; k < MONO_SLOTS && taken.has(slot); k++) {
      slot = (slot + PROBE_STEP) % MONO_SLOTS
    }
    taken.add(slot)
    out.set(g.id, slot * (360 / MONO_SLOTS))
  }
  return out
}
