import { describe, it, expect } from 'vitest'
import { friendlyStep } from '../act-step-label'
import { RUN_EVENT, type RunEvent } from '../types'

const bash = (command: string): RunEvent => ({ kind: RUN_EVENT.tool_start, id: 't', name: 'Bash', input: { command } })
const tool = (name: string, input: unknown = {}): RunEvent => ({ kind: RUN_EVENT.tool_start, id: 't', name, input })
const text = (t: string): RunEvent => ({ kind: RUN_EVENT.text, text: t }) as RunEvent

describe('friendlyStep: the agent narration line', () => {
  it('keeps only the first sentence, without markdown', () => {
    expect(friendlyStep(text('Hunting for the Post button. Then I will click it.'))).toBe('Hunting for the Post button')
    expect(friendlyStep(text('Found Sam, opening the DM\nsecond line'))).toBe('Found Sam, opening the DM')
    expect(friendlyStep(text('**Opening** the `Settings` app!'))).toBe('Opening the Settings app')
  })

  it('does not cut a sentence at the dot inside a domain', () => {
    expect(friendlyStep(text('Heading to x.com to post'))).toBe('Heading to x.com to post')
  })

  it('drops a line too short to mean anything', () => {
    expect(friendlyStep(text('ok'))).toBeNull()
    expect(friendlyStep(text('  '))).toBeNull()
  })

  it('clips a long line to 70 characters with an ellipsis', () => {
    const out = friendlyStep(text('word '.repeat(40)))!
    expect(out).toHaveLength(70)
    expect(out.endsWith('…')).toBe(true)
  })

  it('ignores events that are not a step', () => {
    expect(friendlyStep({ kind: RUN_EVENT.tool_end, id: 't', ok: true } as RunEvent)).toBeNull()
  })
})

describe('friendlyStep: screen control through mm-input', () => {
  it('shows what is being typed', () => {
    expect(friendlyStep(bash("/x/bin/mm-input type 'hi there'"))).toBe('Typing “hi there”')
    const long = friendlyStep(bash(`mm-input type "${'a'.repeat(100)}"`))!
    expect(long).toBe(`Typing “${'a'.repeat(39)}…”`)
  })

  it('names keys, drags and scroll direction', () => {
    expect(friendlyStep(bash('mm-input key "cmd+t"'))).toMatch(/shortcut|keys/i)
    expect(friendlyStep(bash('mm-input drag 1 2 30 40'))).toMatch(/drag/i)
    expect(friendlyStep(bash('mm-input scroll down 3'))).toBe('Scrolling down')
    expect(friendlyStep(bash('mm-input scroll up 5'))).toBe('Scrolling up')
  })

  it('a bare mouse move keeps the previous step instead of a new line', () => {
    expect(friendlyStep(bash('mm-input move 10 20'))).toBeNull()
  })

  it('three clicks in a row read as three different lines, stable per step number', () => {
    const labels = [0, 1, 2].map((n) => friendlyStep(bash('mm-input click 10 20'), n))
    expect(new Set(labels).size).toBe(3)
    expect(labels.every((l) => l && /click|press/i.test(l))).toBe(true)
    expect(friendlyStep(bash('mm-input click 10 20'), 1)).toBe(labels[1])
  })

  it('reads an unquoted key exactly as the screen prompt teaches it (`key return`)', () => {
    expect(friendlyStep(bash('/x/bin/mm-input key return'))).toBe(friendlyStep(bash('/x/bin/mm-input key "return"')))
  })

  it('reads unquoted typing exactly as the screen prompt teaches it (`type <text>`)', () => {
    expect(friendlyStep(bash('/x/bin/mm-input type hello'))).toBe('Typing “hello”')
  })

  it('unquoted typing keeps every word, as mm-input joins its args', () => {
    expect(friendlyStep(bash('mm-input type hello world'))).toBe('Typing “hello world”')
  })

  it('unquoted typing stops at the end of its line in a multi-line script', () => {
    expect(friendlyStep(bash('mm-input type hello\nmm-input key return'))).toBe('Typing “hello”')
  })

  // Bug: the bare branch of TEXT_RE runs to end of line, so shell syntax lands in the label.
  it('unquoted typing chained with && shows only what gets typed', () => {
    expect(friendlyStep(bash('mm-input type hello && mm-input key return'))).toBe('Typing “hello”')
  })

  it('unquoted typing with a redirect shows only what gets typed', () => {
    expect(friendlyStep(bash('mm-input type hello 2>&1'))).toBe('Typing “hello”')
  })
})

describe('friendlyStep: other shell commands', () => {
  it('names the app or site being opened', () => {
    expect(friendlyStep(bash('open -a "Google Chrome"'))).toBe('Opening Google Chrome')
    expect(friendlyStep(bash("open -a 'Visual Studio Code'"))).toBe('Opening Visual Studio Code')
    expect(friendlyStep(bash('open -a Spotify'), 1)).toBe('Popping open Spotify')
    expect(friendlyStep(bash('open "https://www.x.com/compose/post"'))).toBe('Heading to x.com')
  })

  it('points, screenshots and AppleScript each get their own words', () => {
    expect(friendlyStep(bash('/x/bin/mm-ui highlight 100 200'))).toMatch(/point/i)
    expect(friendlyStep(bash('screencapture -x /tmp/a.png'))).toMatch(/screen|look|changed/i)
    expect(friendlyStep(bash(`osascript -e 'tell application "Music" to play'`))).toMatch(/app/i)
  })

  it('any other command still says something true', () => {
    expect(friendlyStep(bash('ls -la ~/Desktop'))).toMatch(/command|behind-the-scenes/i)
  })

  it('a Bash call with no command has no step', () => {
    expect(friendlyStep(tool('Bash', {}))).toBeNull()
  })
})

describe('friendlyStep: named tools', () => {
  it('strips the mcp prefix and reads the site off a browser open', () => {
    expect(friendlyStep(tool('mcp__mightymouse__browser_open', { url: 'https://www.youtube.com/watch?v=1' }))).toBe('Heading to youtube.com')
    expect(friendlyStep(tool('browser_open', {}))).toBe('Opening a page')
  })

  it('shows typed text from either field name, or plain Typing', () => {
    expect(friendlyStep(tool('browser_type', { text: 'hello' }))).toBe('Typing “hello”')
    expect(friendlyStep(tool('mcp__x__browser_fill', { value: 'sam@x.com' }))).toBe('Typing “sam@x.com”')
    expect(friendlyStep(tool('browser_type', { text: '   ' }))).toBe('Typing')
  })

  it('names the site a fetch reads, and a bad url does not throw', () => {
    expect(friendlyStep(tool('WebFetch', { url: 'https://www.example.com/a' }))).toBe('Reading example.com')
    expect(friendlyStep(tool('WebFetch', { url: 'not a url' }))).toBe('Reading not a url')
  })

  it('covers screenshots, files, search and helpers', () => {
    expect(friendlyStep(tool('mcp__mm__take_screenshot'))).toMatch(/screen|look|changed/i)
    expect(friendlyStep(tool('Read'))).toMatch(/file/i)
    expect(friendlyStep(tool('Edit'))).toMatch(/writ|sav/i)
    expect(friendlyStep(tool('Grep'))).toMatch(/files/i)
    expect(friendlyStep(tool('WebSearch'))).toMatch(/web/i)
    expect(friendlyStep(tool('Task'))).toMatch(/helper/i)
  })

  it('an unknown tool keeps the previous step', () => {
    expect(friendlyStep(tool('TodoWrite'))).toBeNull()
  })
})
