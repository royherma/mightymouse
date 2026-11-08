import { describe, expect, it } from 'vitest'
import { barContext } from './AppContextBar'
import type { AppContext } from '@shared/app-context'

const ctx = (appName: string): AppContext =>
  ({ appName, items: [], groups: [], activeGroupId: null }) as unknown as AppContext

// The bar renders both dropdowns as its CHILDREN and returns null when it has
// no drawable context, so "which context do we draw?" decides whether an open
// sheet survives. Three fixes to the native-keyboard dead-tap were wrong
// because they guarded the wrong window; these lock the window that matters.
describe('barContext', () => {
  it('prefers the live context whenever it is readable', () => {
    const live = ctx('Safari')
    expect(barContext(live, ctx('Notes'))).toBe(live)
  })

  it('holds the last good context when a poll comes back unreadable', () => {
    const lastGood = ctx('Safari')
    expect(barContext(null, lastGood)).toBe(lastGood)
  })

  it('treats a context with no appName as unreadable, not as a real answer', () => {
    // The Mac sends a context OBJECT with an empty appName when the Apple-events
    // read times out -- not a bare null. Checking truthiness of the object would
    // pass this straight through and unmount the bar.
    const lastGood = ctx('Safari')
    expect(barContext(ctx(''), lastGood)).toBe(lastGood)
  })

  // THE REGRESSION. The previous fix read, in effect,
  //   live?.appName ? live : open ? lastGood : live
  // which falls through to `live` (null) whenever no sheet is open yet. The
  // trace showed the null landing BETWEEN the tap and the sheet opening, so
  // `open` was still null and the guard did nothing -- the bar unmounted mid-tap
  // and the dropdown never opened. Freezing must not depend on sheet state.
  it('holds the context even with NO sheet open yet -- the mid-tap window', () => {
    const lastGood = ctx('Safari')
    expect(barContext(null, lastGood)).toBe(lastGood)
    expect(barContext(null, lastGood)).not.toBeNull()
  })

  it('still renders nothing before the first readable context', () => {
    // Freezing must not invent a bar out of nothing on a cold start.
    expect(barContext(null, null)).toBeNull()
  })
})
