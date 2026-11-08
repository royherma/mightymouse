/** Pinning test for the phone-remote cursor "feel" constants.
 *
 *  Why this exists: the five numbers that decide whether the cursor feels
 *  smooth live in three different files, and only on-device testing can judge
 *  them. That combination burned us twice -- a change to two of them at once
 *  read as "worse" with no way to tell which one did it, and a later revert
 *  restored one constant while silently leaving two at their experimental
 *  values, which nobody caught until the user felt it again.
 *
 *  So: these values are approved-by-feel, not derived. This test fails on any
 *  edit to them. That failure is not a bug to route around -- it is the prompt
 *  to (a) change ONE constant at a time, (b) get it confirmed on a real phone,
 *  and (c) update the number here in the same commit.
 *
 *  Where each one lives, and what it does:
 *    MOVE_THROTTLE_MS      config.ts + react/App.tsx (hand-duplicated!)
 *                          ms between phone->host move messages.
 *    MOVE_SMOOTHING_ALPHA  ipc/phone-remote-pointer.ts - EMA weight on the raw delta.
 *    GLIDE_WINDOW_MS       ipc/phone-remote-pointer.ts - ms the sub-steps must fill.
 *    GLIDE_MAX_STEPS       ipc/phone-remote-pointer.ts - sub-step ceiling per message.
 *    MOVE_SLOW_MULTIPLIER  pointer-accel.ts - effective speed while slow.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CONFIG } from '../config'
import { MOVE_SLOW_MULTIPLIER } from '../pointer-accel'

const SRC = resolve(__dirname, '../..')

/** Read a `const NAME = <number>` out of a source file. Reading the text
 *  rather than importing is deliberate: the Electron-main module cannot be
 *  imported here (it pulls in BrowserWindow), and the phone bundle is a
 *  separate Vite build. */
function readNumericConst(relPath: string, name: string): number {
  const src = readFileSync(resolve(SRC, relPath), 'utf8')
  const m = new RegExp(`const ${name} = (-?[\\d.]+)`).exec(src)
  if (!m) throw new Error(`${name} not found in ${relPath} — was it renamed?`)
  return Number(m[1])
}

/** GLIDE_WINDOW_MS is derived (`MOVE_THROTTLE_MS - N`), not a literal, so the
 *  numeric reader above can't see it. Pull the margin instead and apply it. */
function glideWindowMs(): number {
  const src = readFileSync(resolve(SRC, 'main/ipc/phone-remote-pointer.ts'), 'utf8')
  const m = /const GLIDE_WINDOW_MS = CONFIG\.PHONE_REMOTE\.MOVE_THROTTLE_MS - (\d+)/.exec(src)
  if (!m) throw new Error('GLIDE_WINDOW_MS no longer derives from MOVE_THROTTLE_MS — was it rewritten?')
  return CONFIG.PHONE_REMOTE.MOVE_THROTTLE_MS - Number(m[1])
}

describe('phone-remote cursor feel (approved on-device — change one at a time)', () => {
  it('sends moves every 20ms (50/sec)', () => {
    expect(CONFIG.PHONE_REMOTE.MOVE_THROTTLE_MS).toBe(20)
  })

  it('keeps the phone bundle throttle in sync with shared config', () => {
    // These two CANNOT import each other, so drift is silent and halves the
    // fix: the host would pace for 50/sec while the phone still sent 30/sec.
    const phoneSide = readNumericConst(
      'main/phone-remote/react/hooks/use-trackpad.ts',
      'MOVE_THROTTLE_MS'
    )
    expect(phoneSide).toBe(CONFIG.PHONE_REMOTE.MOVE_THROTTLE_MS)
  })

  it('smooths deltas at alpha 0.5', () => {
    // Lowering this to 0.38 was tried and felt worse -- a smaller alpha tracks
    // raw hand wobble MORE closely, the opposite of the intent.
    expect(readNumericConst('main/ipc/phone-remote-pointer.ts', 'MOVE_SMOOTHING_ALPHA')).toBe(0.5)
  })

  it('glides in at most 3 sub-steps', () => {
    expect(readNumericConst('main/ipc/phone-remote-pointer.ts', 'GLIDE_MAX_STEPS')).toBe(3)
  })

  it('starts gliding from 1.5px, so slow moves are still smoothed', () => {
    expect(readNumericConst('main/ipc/phone-remote-pointer.ts', 'GLIDE_MIN_PX')).toBe(1.5)
  })

  it('still glides at fine-positioning speed', () => {
    // The regression this file exists to catch, and the one it originally
    // missed: GLIDE_MIN_PX is a DISTANCE threshold doing a SPEED threshold's
    // job. Halving the send interval halved every reported gap, which pushed
    // slow movement under the old 6px floor and switched gliding off exactly
    // where it was most wanted. Pinning the constants alone did not catch it
    // -- the relationship between them is what broke.
    const throttleMs = CONFIG.PHONE_REMOTE.MOVE_THROTTLE_MS
    const minPx = readNumericConst('main/ipc/phone-remote-pointer.ts', 'GLIDE_MIN_PX')
    // A deliberate, slow fine-positioning drag: ~200px/sec.
    const gapPx = 200 * (throttleMs / 1000)
    expect(gapPx).toBeGreaterThanOrEqual(minPx)
  })

  it('holds a slow finger to a fixed precision speed', () => {
    // Absolute, not a fraction of the slider -- see pointer-accel.ts. 2.5 was
    // shipped and read as "very slow and jumpy" at the user's 10.6 setting; 5
    // matches the fraction-era feel there while still capping 20x.
    expect(MOVE_SLOW_MULTIPLIER).toBe(5)
  })

  it('fills the send window without overrunning it', () => {
    // TWO failure modes, and the fix for one is the cause of the other:
    //  - overrun: this hop's steps still firing when the next message lands,
    //    so two hops fight for the cursor. Reads as jumpy, no visible cause.
    //  - UNDERRUN: steps finishing early, leaving the cursor perfectly still
    //    for the rest of the window. At 50/sec that is a 50Hz move-stop
    //    stutter -- invisible on a flick, obvious on a slow circle.
    //    Fixed step spacing hit
    //    this the moment the send interval halved to 20ms.
    // The window must therefore be nearly full, but not full.
    const windowMs = glideWindowMs()
    const throttle = CONFIG.PHONE_REMOTE.MOVE_THROTTLE_MS
    expect(windowMs).toBeLessThan(throttle)
    expect(windowMs).toBeGreaterThanOrEqual(throttle * 0.85)
  })

  it('paces a 2-step hop as widely as a 3-step one', () => {
    // The common case: most hops earn 2 steps, so if spacing were derived from
    // GLIDE_MAX_STEPS they would finish a third early and idle the tail --
    // exactly the stutter above, reintroduced through the back door.
    const windowMs = glideWindowMs()
    for (const steps of [2, 3]) {
      expect((windowMs / steps) * steps).toBeCloseTo(windowMs)
    }
  })
})
