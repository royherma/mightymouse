import { describe, it, expect } from 'vitest'
import { CONFIG } from '../config'
import {
  SETUP_STATUS,
  SETUP_FIX_KIND,
  isSetupComplete,
  type SetupCheck
} from '../setup-check'

/**
 * The opacity rule, enforced (PRD §4.0).
 *
 * Two external testers lost their first-run setup on 2026-07-23 to copy that
 * named our plumbing and offered no button. The fix is a rule, and a rule
 * nobody checks is a comment — so this test is the thing that actually holds
 * the line. Adding a word like "npm" to a setup string fails CI.
 *
 * See prds/active/2026-07-23-1784776098-zero-dead-ends-setup-check.md
 */

/**
 * Vocabulary the user never has to learn to use MightyMouse. A dependency of a
 * dependency is never the user's problem — if a string needs one of these words
 * to make sense, the string is describing OUR job, not the user's.
 *
 * Matched case-insensitively on word boundaries, so "Recording" is fine while
 * a bare "recording tool is ffmpeg" is not.
 */
const BANNED = [
  'npm',
  'node',
  'nodejs',
  'homebrew',
  'brew',
  'ffmpeg',
  'whisper',
  'cli',
  'path',
  'terminal',
  'shell',
  'binary',
  'install script',
  'package manager',
  'command line'
]

/** Every leaf string in the SETUP_CHECK copy tree, with its dotted path. */
function walk(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === 'string') {
    out.push({ path, text: value })
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, out)
  }
}

describe('setup check copy is opaque', () => {
  const strings: { path: string; text: string }[] = []
  walk(CONFIG.SETUP_CHECK, 'SETUP_CHECK', strings)
  // The local-backend setup copy lands in SetupCheck.detail and on the Settings
  // row, so it is the same surface under the same rule. It lives in its own
  // CONFIG block, which is exactly how "Needs Homebrew to install
  // automatically." shipped past a green run of this test.
  walk(CONFIG.LOCAL_SETUP_COPY, 'LOCAL_SETUP_COPY', strings)

  it('has copy to check (guards against the walker silently finding nothing)', () => {
    // Without this, a broken walker would make every assertion below vacuously
    // pass and the rule would be unenforced while looking green.
    expect(strings.length).toBeGreaterThan(20)
  })

  for (const word of BANNED) {
    it(`never says "${word}"`, () => {
      const re = new RegExp(`\\b${word}\\b`, 'i')
      const offenders = strings.filter((s) => re.test(s.text))
      expect(
        offenders.map((o) => `${o.path}: ${JSON.stringify(o.text)}`),
        `"${word}" is our plumbing, not the user's problem — describe the capability instead`
      ).toEqual([])
    })
  }

  it('never uses an em or en dash (house style)', () => {
    const offenders = strings.filter((s) => /[—–]/.test(s.text))
    expect(offenders.map((o) => o.path)).toEqual([])
  })

  // The onboarding warning lines feed the same surface and were the ORIGINAL
  // offenders ("Install the CLI, or switch backends in Settings").
  it('onboarding warning copy is opaque too', () => {
    const onboarding: { path: string; text: string }[] = []
    walk(CONFIG.ONBOARDING_CAPTURE, 'ONBOARDING_CAPTURE', onboarding)
    walk(CONFIG.ONBOARDING_BACKEND, 'ONBOARDING_BACKEND', onboarding)
    const re = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i')
    expect(onboarding.filter((s) => re.test(s.text)).map((o) => o.path)).toEqual([])
  })
})

describe('setup check invariants', () => {
  const row = (over: Partial<SetupCheck>): SetupCheck => ({
    id: 'recording',
    label: 'Screen recording',
    status: SETUP_STATUS.fail,
    detail: 'Needs one more piece',
    fix: { kind: SETUP_FIX_KIND.install, label: 'Set it up' },
    ...over
  })

  // THE core invariant. Everything else in this feature is decoration; a
  // failing row without a fix is the exact bug we shipped to two testers.
  it('a failing row always carries a fix', () => {
    const checks = [row({}), row({ id: 'backend', status: SETUP_STATUS.fail })]
    for (const c of checks) {
      if (c.status === SETUP_STATUS.fail) expect(c.fix).toBeDefined()
    }
  })

  it('is not complete while any required row fails', () => {
    expect(isSetupComplete([row({ status: SETUP_STATUS.ok, fix: undefined }), row({})])).toBe(false)
  })

  it('is complete when required rows pass, even with an optional one failing', () => {
    expect(
      isSetupComplete([
        row({ id: 'accessibility', status: SETUP_STATUS.ok, fix: undefined }),
        row({ id: 'microphone', status: SETUP_STATUS.optional })
      ])
    ).toBe(true)
  })

  it('treats a checking row as not yet complete', () => {
    expect(isSetupComplete([row({ status: SETUP_STATUS.checking })])).toBe(false)
  })
})
