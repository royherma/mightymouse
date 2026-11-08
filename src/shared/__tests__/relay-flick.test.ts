import { describe, it, expect } from 'vitest'
import {
  FLICK_DISMISS_PX,
  FLICK_LOCK_PX,
  FLICK_VELOCITY,
  flyOffDx,
  flickTransform,
  lockAxis,
  shouldDismiss
} from '../relay-flick'

describe('lockAxis', () => {
  it('stays undecided under the slop', () => {
    expect(lockAxis(0, 0)).toBeNull()
    expect(lockAxis(FLICK_LOCK_PX - 1, FLICK_LOCK_PX - 1)).toBeNull()
  })

  it('picks the larger axis once past slop', () => {
    expect(lockAxis(20, 4)).toBe('x')
    expect(lockAxis(4, 20)).toBe('y')
  })

  it('ties go to y so a diagonal does not steal the list scroll', () => {
    expect(lockAxis(20, 20)).toBe('y')
  })
})

describe('shouldDismiss', () => {
  it('commits once travel clears the threshold', () => {
    expect(shouldDismiss(FLICK_DISMISS_PX, 0)).toBe(true)
    expect(shouldDismiss(-FLICK_DISMISS_PX, 0)).toBe(true)
  })

  it('snaps back on a short slow drag', () => {
    expect(shouldDismiss(40, 0.1)).toBe(false)
  })

  it('commits a short fast flick in the same direction', () => {
    expect(shouldDismiss(40, FLICK_VELOCITY)).toBe(true)
    expect(shouldDismiss(-40, -FLICK_VELOCITY)).toBe(true)
  })

  it('does not commit a reverse flick or a jitter under the lock', () => {
    expect(shouldDismiss(40, -FLICK_VELOCITY)).toBe(false)
    expect(shouldDismiss(FLICK_LOCK_PX - 1, FLICK_VELOCITY * 2)).toBe(false)
  })
})

describe('flyOffDx', () => {
  it('flies the way the finger was going', () => {
    expect(flyOffDx(30, 200)).toBe(264)
    expect(flyOffDx(-30, 200)).toBe(-264)
  })

  it('uses velocity when travel is zero', () => {
    expect(flyOffDx(0, 200, -1)).toBe(-264)
  })
})

describe('flickTransform', () => {
  it('translates and rotates with the drag', () => {
    const style = flickTransform(50)
    expect(style.transform).toContain('translate3d(50px,0,0)')
    expect(style.transform).toContain('rotate(')
    expect(style.opacity).toBeLessThan(1)
  })
})
