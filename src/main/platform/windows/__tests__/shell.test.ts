/**
 * The Windows shell domain, tested for the three things that are silently wrong
 * rather than loudly wrong when they break: quoting that stops escaping, a
 * spawn switch PowerShell doesn't understand, and a file read that drops
 * newlines. The suite runs on ubuntu, so only the pure string builders are
 * covered here — anything that spawns powershell.exe belongs to the VM smoke.
 */
import { describe, it, expect } from 'vitest'
import { bin, quote, spawnArgs, fileText, pathPrefix, agentToolHints } from '../shell'

describe('windows shell.quote', () => {
  it('wraps in single quotes', () => {
    expect(quote('hello')).toBe("'hello'")
  })

  it("doubles an embedded ' — the only character with meaning inside a PS literal", () => {
    expect(quote("it's")).toBe("'it''s'")
  })

  it('leaves $(...) inert, which is the whole reason for single quotes', () => {
    // A double-quoted PowerShell string would EXECUTE this.
    expect(quote('$(Remove-Item C:\\)')).toBe("'$(Remove-Item C:\\)'")
  })

  it('passes a Windows path through unmangled — backslashes are not escapes here', () => {
    expect(quote('C:\\Users\\roy\\.local\\bin\\claude.cmd')).toBe(
      "'C:\\Users\\roy\\.local\\bin\\claude.cmd'"
    )
  })
})

describe('windows shell.spawnArgs', () => {
  it('ends with -Command and the command, so the command is the last argv entry', () => {
    const args = spawnArgs('echo hi')
    expect(args.at(-2)).toBe('-Command')
    expect(args.at(-1)).toBe('echo hi')
  })

  it('never emits the POSIX -c that would make powershell.exe misparse the run', () => {
    expect(spawnArgs('echo hi')).not.toContain('-c')
  })

  it('suppresses the profile, so a user banner cannot land in stdout we parse', () => {
    expect(spawnArgs('echo hi')).toContain('-NoProfile')
  })

  it('is non-interactive, so a prompting CLI fails instead of hanging', () => {
    expect(spawnArgs('echo hi')).toContain('-NonInteractive')
  })
})

describe('windows shell.fileText', () => {
  it('reads -Raw: without it Get-Content returns lines that join with SPACES', () => {
    expect(fileText('C:\\tmp\\prompt.txt')).toContain('-Raw')
  })

  it('reads UTF8, or PS 5.1 decodes the prompt as the ANSI codepage', () => {
    expect(fileText('C:\\tmp\\prompt.txt')).toContain('-Encoding UTF8')
  })

  it('quotes the path and trims like $(cat) does', () => {
    expect(fileText("C:\\tmp\\it's.txt")).toBe(
      "(Get-Content -Raw -Encoding UTF8 'C:\\tmp\\it''s.txt').TrimEnd()"
    )
  })

  it('is one argument: a native command receives the contents, not a pipeline', () => {
    const expr = fileText('C:\\tmp\\p.txt')
    expect(expr.startsWith('(')).toBe(true)
    expect(expr.endsWith('()')).toBe(true)
  })
})

describe('windows shell identity', () => {
  it('spawns PowerShell, not cmd — cmd cannot quote or substitute what we build', () => {
    expect(bin).toBe('powershell.exe')
  })

  it('prepends nothing to PATH: there is no Homebrew, and CLIs resolve absolute', () => {
    expect(pathPrefix).toBe('')
  })

  it('names Windows tools to the agent, never the macOS ones', () => {
    const hints = agentToolHints()
    expect(hints).toContain('Get-Clipboard')
    expect(hints).not.toMatch(/osascript|sips|qlmanage|homebrew/i)
  })
})
