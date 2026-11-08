import { describe, it, expect } from 'vitest'
import { mergeAppList, type AppSwitchItem } from '../app-list-merge'

const app = (bundleId: string): AppSwitchItem => ({
  name: bundleId,
  bundleId,
  iconPngBase64: ''
})

const ids = (list: AppSwitchItem[] | null): string[] | null =>
  list === null ? null : list.map((a) => a.bundleId)

describe('mergeAppList', () => {
  it('shows the first list as-is when nothing is drawn yet', () => {
    const incoming = [app('a'), app('b')]
    const { immediate, deferred } = mergeAppList(null, incoming)
    expect(ids(immediate)).toEqual(['a', 'b'])
    expect(deferred).toBeNull()
  })

  it('defers a pure reorder — this is the reshuffle the ring must not do mid-gesture', () => {
    const { immediate, deferred } = mergeAppList([app('a'), app('b')], [app('b'), app('a')])
    expect(immediate).toBeNull()
    expect(ids(deferred)).toEqual(['b', 'a'])
  })

  it('defers an identical list', () => {
    const { immediate } = mergeAppList([app('a'), app('b')], [app('a'), app('b')])
    expect(immediate).toBeNull()
  })

  it('shows a NEW app immediately, at the FRONT where the ring can draw it', () => {
    const { immediate } = mergeAppList([app('a'), app('b')], [app('new'), app('a'), app('b')])
    expect(ids(immediate)).toEqual(['new', 'a', 'b'])
  })

  it('puts a newcomer inside the ring window on a busy machine', () => {
    // The ring draws only APP_RING_MAX_SLOTS (9) apps. Appending to a 12-app
    // list put the new app at index 12 -- past the window, invisible. This is
    // the CapCut case, and the reason front beats append.
    const current = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(app)
    const { immediate } = mergeAppList(current, [app('capcut'), ...current])
    expect(immediate).not.toBeNull()
    expect(ids(immediate!.slice(0, 9))).toContain('capcut')
  })

  it('still defers the true MRU order after showing a new app', () => {
    const { deferred } = mergeAppList([app('a'), app('b')], [app('new'), app('a'), app('b')])
    expect(ids(deferred)).toEqual(['new', 'a', 'b'])
  })

  it('keeps multiple newcomers in the order the Mac reported them', () => {
    const { immediate } = mergeAppList([app('a')], [app('y'), app('a'), app('x')])
    expect(ids(immediate)).toEqual(['y', 'x', 'a'])
  })

  it('removes a quit app immediately — a slot that activates a dead app is worse', () => {
    const { immediate } = mergeAppList([app('a'), app('gone'), app('b')], [app('a'), app('b')])
    expect(ids(immediate)).toEqual(['a', 'b'])
  })

  it('handles a launch and a quit in the same update', () => {
    const { immediate } = mergeAppList([app('a'), app('gone')], [app('new'), app('a')])
    expect(ids(immediate)).toEqual(['new', 'a'])
  })

  it('keeps the CURRENT relative order for survivors, not the incoming one', () => {
    // Order changed AND an app arrived: survivors must not reshuffle among
    // themselves just because the urgent half of the update was applied.
    const { immediate } = mergeAppList(
      [app('a'), app('b'), app('c')],
      [app('c'), app('b'), app('a'), app('new')]
    )
    expect(ids(immediate)).toEqual(['new', 'a', 'b', 'c'])
  })

  it('shows an emptied list rather than holding a fully stale one', () => {
    const { immediate } = mergeAppList([app('a')], [])
    expect(ids(immediate)).toEqual([])
  })
})
