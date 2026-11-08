// The iOS event names live in TWO places: the typed map here, and Swift string
// constants in ios/MightyMouse/Analytics.swift. Swift cannot import TypeScript,
// so that duplication is unavoidable — but it is silent. A rename on this side
// leaves the phone emitting an event no dashboard query matches, and nothing
// fails: the insert succeeds, the funnel just quietly under-reports.
//
// This test is the only thing standing between a rename and that outage. It
// parses the Swift file and asserts both sides agree.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_EVENT,
  IOS_DISCOVERY_OUTCOME,
  IOS_PAIR_FAIL_REASON,
  IOS_SIGNIN_FAIL_REASON
} from './analytics-events'

const SWIFT = readFileSync(
  join(__dirname, '../../ios/MightyMouse/Analytics.swift'),
  'utf8'
)

/** Pull the string literals out of one `enum Name { static let x = "y" }` block. */
function swiftEnumValues(enumName: string): string[] {
  const block = new RegExp(`enum ${enumName} \\{([\\s\\S]*?)\\n\\}`).exec(SWIFT)
  if (!block) throw new Error(`enum ${enumName} not found in Analytics.swift`)
  return [...block[1].matchAll(/static let \w+ = "([^"]+)"/g)].map((m) => m[1])
}

describe('iOS analytics contract', () => {
  it('every ios_ event in the TS map exists in Swift', () => {
    const tsEvents = Object.values(ANALYTICS_EVENT).filter((e) => e.startsWith('ios_'))
    // Guards the guard: if the filter ever matches nothing, the assertions below
    // pass vacuously and this file becomes decoration.
    expect(tsEvents.length).toBe(10)
    expect(swiftEnumValues('AnalyticsEvent').sort()).toEqual(tsEvents.sort())
  })

  it.each([
    ['SignInFailReason', IOS_SIGNIN_FAIL_REASON],
    ['PairFailReason', IOS_PAIR_FAIL_REASON],
    ['DiscoveryOutcome', IOS_DISCOVERY_OUTCOME]
  ])('%s reasons match the TS union', (swiftEnum, tsMap) => {
    expect(swiftEnumValues(swiftEnum).sort()).toEqual(Object.values(tsMap).sort())
  })

  it("platform is the literal the CHECK constraint allows", () => {
    // Migration 0058 constrains events.platform. A drift here is a rejected
    // insert on every single event the phone sends.
    expect(SWIFT).toContain('"platform": "ios"')
  })
})
