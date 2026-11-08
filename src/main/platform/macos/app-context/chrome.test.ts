import { describe, expect, it } from 'vitest'
import { pairsWindow, resolveProfileFromTitle } from './chrome'

/**
 * Window title → profile directory.
 *
 * This mapping has shipped wrong twice, both times looking confident:
 *  1. Matched `info_cache.name` against a title that actually carries
 *     `gaia_given_name`, across ALL 24 profiles including dormant ones. A
 *     signed-out profile named "Pat" uniquely matched a window owned by a
 *     signed-in profile whose given name is "Pat", so the bar drew a monogram
 *     while Chrome's own toolbar showed the account photo.
 *  2. Split the qualified form with a regex, which mis-parsed a display name
 *     that itself contains parentheses and dropped that window's 14 tabs.
 *
 * The fixture is Pat's real machine, reduced to the profiles that matter.
 */
const CACHE = {
  Default: { name: 'Person 1', gaia_given_name: 'Pat', user_name: 'dev@example.com' },
  'Profile 15': { name: 'acme.example', gaia_given_name: 'Pat', user_name: 'alex@acme.example' },
  'Profile 16': {
    name: "Studio (my socials)",
    gaia_given_name: 'Tech',
    user_name: 'dev2@example.com'
  },
  'Profile 25': { name: 'sidecar', gaia_given_name: 'pat', user_name: 'dev3@example.com' },
  // Signed out, no window open. The impostor from failure #1.
  'Profile 9': { name: 'Pat' }
}
/** The four with a window open — what `last_active_profiles` reports. */
const LIVE = ['Default', 'Profile 16', 'Profile 25', 'Profile 15']

const resolve = (title: string, candidates = LIVE): string =>
  resolveProfileFromTitle(title, candidates, CACHE)

describe('resolveProfileFromTitle', () => {
  it('reads a bare given name as the default profile, not as ambiguous', () => {
    // Both Default and Profile 15 have the given name "Pat". Chrome qualifies
    // Profile 15's windows and leaves Default's bare, so bare IS the answer.
    expect(resolve('Home / X - Google Chrome - Pat')).toBe('Default')
  })

  it('prefers the parenthesised profile name over the given name', () => {
    expect(resolve('New Tab - Google Chrome - Pat (acme.example)')).toBe('Profile 15')
  })

  it('handles a display name that itself contains parentheses', () => {
    // Failure #2: a regex split on the outer parens left "my socials" and
    // matched nothing, silently losing this window's tabs.
    expect(resolve("Generative Session | Runway AI - Google Chrome - Tech (Studio (my socials))")).toBe(
      'Profile 16'
    )
  })

  it('never picks a profile that has no window open', () => {
    // Failure #1: "Profile 9" is named "Pat" and would match this title, but it
    // is not in the live set, so it must not be considered at all.
    expect(resolve('Home / X - Google Chrome - Pat')).not.toBe('Profile 9')
  })

  it('distinguishes given names that differ only by case', () => {
    expect(resolve('Gmail - Google Chrome - pat (sidecar)')).toBe('Profile 25')
  })

  it('returns empty for a title with no profile suffix', () => {
    // A single-profile Chrome omits the suffix entirely.
    expect(resolve('Home / X')).toBe('')
    expect(resolve('Home / X - Google Chrome')).toBe('')
  })

  it('returns empty rather than guessing when nothing matches', () => {
    expect(resolve('Something - Google Chrome - Nobody')).toBe('')
  })

  it('falls back to the display name for a signed-out profile', () => {
    // No Google account means no given name, so Chrome titles with `name`.
    expect(resolve('Notes - Google Chrome - Pat', ['Profile 9'])).toBe('Profile 9')
  })
})

/**
 * The checksum guarding the tab-count join.
 *
 * Counts come from Chrome and the profile from System Events, and there is no
 * shared key to join them: System Events cannot see Chrome's window id, and
 * maximized windows all report identical bounds. Position is the only join, and
 * it breaks silently when System Events lists a window Chrome's collection
 * omits (downloads, task manager) — every later pair shifts by one and a whole
 * window's tabs land on the wrong profile.
 *
 * Chrome's own `title of w` is the prefix of System Events' name for the same
 * window, so it detects the shift. This locks the predicate itself; the live
 * behaviour it protects was verified against all four open profiles.
 */
describe('chrome/System Events window pairing checksum', () => {
  it('accepts a correctly aligned pair', () => {
    expect(pairsWindow('MightyMouse', "MightyMouse - Google Chrome - Tech (Studio (my socials))")).toBe(true)
  })

  it('rejects a pair shifted by an extra System Events window', () => {
    // The real failure: a Task Manager window Chrome does not enumerate would
    // credit MightyMouse's 15 tabs to whatever profile sorted next.
    expect(pairsWindow('MightyMouse', 'Task Manager - Google Chrome')).toBe(false)
  })

  it('accepts a title that itself contains the separator', () => {
    // A tab title with " - " in it must not be mistaken for a drifted pair.
    const chrome = 'Search results - dev3@example.com - Gmail'
    expect(pairsWindow(chrome, `${chrome} - Google Chrome - pat (sidecar)`)).toBe(true)
  })

  it('accepts when Chrome reports no title rather than dropping the window', () => {
    // An empty Chrome title carries no signal, so it cannot prove drift — and
    // discarding the window would lose its tabs for no reason.
    expect(pairsWindow('', 'Untitled - Google Chrome - Pat')).toBe(true)
  })
})
