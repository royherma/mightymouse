/**
 * The connection harness reproduces copy it cannot import: every gate is inline
 * JSX in `App.tsx`, with no seam to render one from outside it. Those copies
 * are the one part of the harness that can go stale silently -- a reworded
 * screen would leave it confidently previewing something no user ever sees,
 * which is worse than not having a harness at all.
 *
 * So every string is asserted against App.tsx itself. If this fails, the gate
 * changed and `connect-harness.local.tsx` is what needs updating -- never the
 * other way round.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { BLOCKED_REASON_INFO } from '../../connection-state'
import type { BlockedReason } from '../../connection-state'

const APP = resolve(__dirname, '../App.tsx')
const HARNESS = resolve(__dirname, '../connect-harness.local.tsx')

const useMirror = readFileSync(APP, 'utf8')
const harness = readFileSync(HARNESS, 'utf8')

/** Curly apostrophes are what the source ships (’, not '). Comparing on a
 *  normalised form would let the two files disagree on the character the user
 *  actually sees, so they are matched verbatim instead. */
const TITLES = [
  'is using your Mac',
  'Let’s connect your Mac',
  'Can’t find your Mac',
  'Too many tries to connect',
  'Waiting for approval'
]

const BODIES = [
  'Take control to use it here. The other device will stop.',
  'This phone was disconnected in MightyMouse settings.',
  'If Safari shows a warning, tap Show Details, then “visit this website”.',
  'Give it a moment, then try again.',
  'Open MightyMouse on your connected phone and tap Allow.',
  'Make sure MightyMouse is open on your Mac and you’re on the same Wi-Fi.'
]

const ACTIONS = ['Take control', 'Open your Mac’s page', 'Try again', 'Unpair this phone']

/** The boot gate is markup the harness re-types rather than a component it can
 *  mount, so its copy needs the same guard as the terminal screens. */
const BOOT_GATE = ['Connecting to your Mac…']

describe('connection harness mirrors the real gate copy', () => {
  it.each(TITLES)('title %j still exists in use-mirror and in the harness', (title) => {
    expect(useMirror).toContain(title)
    expect(harness).toContain(title)
  })

  it.each(BODIES)('body %j still exists in use-mirror and in the harness', (body) => {
    expect(useMirror).toContain(body)
    expect(harness).toContain(body)
  })

  it.each(ACTIONS)('action %j still exists in use-mirror and in the harness', (label) => {
    expect(useMirror).toContain(label)
    expect(harness).toContain(label)
  })

  it.each(BOOT_GATE)('boot gate line %j is reproduced verbatim', (line) => {
    expect(useMirror).toContain(line)
    expect(harness).toContain(line)
  })

  // The fallback for a Mac that named no device. Asserted on its own because
  // the `${who}` template means the full title never appears literally in
  // use-mirror -- only this default does.
  it('the anonymous handoff label is the same in both', () => {
    expect(useMirror).toContain("'Another device'")
    expect(harness).toContain('Another device is using your Mac')
  })

  // The harness claims to cover every state. That claim is only worth
  // something if adding a sixth reason to the vocabulary breaks it.
  it.each(Object.keys(BLOCKED_REASON_INFO) as BlockedReason[])(
    'blocked reason %s has a scenario in the harness',
    (reason) => {
      expect(harness).toContain(reason)
    }
  )
})
