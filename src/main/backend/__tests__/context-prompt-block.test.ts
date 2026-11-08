import { describe, it, expect } from 'vitest'
import { contextPromptBlock, rewriteUserPrompt } from '../prompts'

describe('contextPromptBlock', () => {
  it('returns empty when context is off', () => {
    expect(contextPromptBlock(null, 'rewrite')).toBe('')
    expect(contextPromptBlock(undefined, 'rewrite')).toBe('')
  })

  it('includes app, window, and URL when present', () => {
    const block = contextPromptBlock(
      {
        frontApp: 'Google Chrome',
        windowTitle: 'Pull requests',
        browserURL: 'https://github.com/acme/app'
      },
      'rewrite'
    )
    expect(block).toContain('- App: Google Chrome')
    expect(block).toContain('- Window: Pull requests')
    expect(block).toContain('- URL: https://github.com/acme/app')
    expect(block).toContain('REWRITE-MODE OVERRIDE')
    expect(block).not.toContain('Screen capture')
  })

  it('omits screenshot unless a path is passed', () => {
    const bar = contextPromptBlock({ frontApp: 'Notes' }, 'rewrite')
    expect(bar).toContain('- App: Notes')
    expect(bar).not.toContain('Screen capture')

    const panel = contextPromptBlock(
      { frontApp: 'Notes', screenshotPath: '/tmp/shot.png' },
      'rewrite'
    )
    expect(panel).toContain('Screen capture (open/view this image): /tmp/shot.png')
  })

  it('appends onto an inline rewrite prompt only when on', () => {
    const selection = 'teh quick brown fox'
    const instruction = 'Fix the spelling'
    const off = `${rewriteUserPrompt(instruction, selection)}${contextPromptBlock(null, 'rewrite')}`
    expect(off).toBe(rewriteUserPrompt(instruction, selection))

    const on = `${rewriteUserPrompt(instruction, selection)}${contextPromptBlock({ frontApp: 'Safari', browserURL: 'https://apple.com' }, 'rewrite')}`
    expect(on).toContain(selection)
    expect(on).toContain('- App: Safari')
    expect(on).toContain('- URL: https://apple.com')
    expect(on).not.toContain('Screen capture')
  })
})
