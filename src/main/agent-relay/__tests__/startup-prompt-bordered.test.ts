import { describe, expect, it } from 'vitest'
import { parseStartupPrompt } from '../picker-keys'

const RULE = '─'.repeat(60)

describe('parseStartupPrompt: questions with a border right above the options', () => {
  it('ignores the earlier terminal output above the border', () => {
    const p = parseStartupPrompt([
      '⏺ Reading the screenshot you sent',
      '  /var/folders/ab/T/MightyMouse-reply-screens/screen-1.png',
      RULE,
      ' Do you trust the files in /var/folders/ab/T/MightyMouse-reply-screens?',
      '   ❯ Yes, add for this session',
      '     No, exit',
      '',
      ' Enter to confirm · Esc to cancel'
    ])
    expect(p?.options).toEqual(['Yes, add for this session', 'No, exit'])
    expect(p?.selected).toBe(0)
    expect(p?.question).toBe('Do you trust the files in /var/folders/ab/T/MightyMouse-reply-screens?')
    expect(p?.detail).toBe('')
  })

  it('does not take a numbered list the agent printed above the border as options', () => {
    const p = parseStartupPrompt([
      '⏺ Plan:',
      '  1. Read the file',
      '  2. Write the summary',
      RULE,
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      '',
      ' Esc to cancel · Tab to amend'
    ])
    expect(p?.options).toEqual(['Yes', 'No'])
    expect(p?.selected).toBe(0)
    expect(p?.question).toBe('Do you want to proceed?')
  })

  it('takes the marked row and its same-indent neighbours when the question has no blank line above the options', () => {
    const p = parseStartupPrompt([
      RULE,
      ' Do you trust the files in this folder?',
      '   ❯ Yes, proceed',
      '     No, exit',
      '',
      ' Enter to confirm · Esc to cancel'
    ])
    expect(p?.options).toEqual(['Yes, proceed', 'No, exit'])
    expect(p?.selected).toBe(0)
    expect(p?.question).toBe('Do you trust the files in this folder?')
  })

  it('keeps the selection when the marked row is not the first option', () => {
    const p = parseStartupPrompt([
      RULE,
      ' Pick a theme for this terminal?',
      '     Dark',
      '   ❯ Light',
      '     High contrast',
      '',
      ' Enter to confirm · Esc to cancel'
    ])
    expect(p?.options).toEqual(['Dark', 'Light', 'High contrast'])
    expect(p?.selected).toBe(1)
    expect(p?.question).toBe('Pick a theme for this terminal?')
  })
})
