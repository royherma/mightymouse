import { describe, expect, it } from 'vitest'
import { agentName, badgeLetter } from '../voice-route-labels'

describe('agentName', () => {
  // The bug: cutting at the last "/" left the branch, so every agent on main
  // rendered as "main - <tag>" and the column read as six identical rows.
  it('drops the whole repo/branch prefix, not just the repo', () => {
    expect(agentName('ShowAndTell/main - pro-paywall')).toBe('pro-paywall')
    expect(agentName('ShowAndTell/feature/x - sep-18-s-a')).toBe('sep-18-s-a')
  })

  it('leaves a renamed session alone', () => {
    expect(agentName('fix the auth bug')).toBe('fix the auth bug')
  })

  it('falls back to the repo cut when there is no session tag', () => {
    expect(agentName('ShowAndTell/main')).toBe('main')
    expect(agentName('ShowAndTell/main - ')).toBe('main')
  })
})

describe('badgeLetter', () => {
  it('uses the project, not the branch-leading label', () => {
    expect(badgeLetter('ShowAndTell', 'main - pro-paywall')).toBe('S')
  })

  it('skips leading punctuation', () => {
    expect(badgeLetter('.config-repo', '')).toBe('C')
  })

  it('falls back to the label when there is no project', () => {
    expect(badgeLetter('', 'wip-scan')).toBe('W')
  })
})
