import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SHIM = join(__dirname, '../../../../npm-shim/mightymouse-code/bin/mightymouse-code.js')
const PICK = ['detectAgent', 'ancestorCommands', 'ancestors']

function shimPart(): string {
  const src = readFileSync(SHIM, 'utf8')
  const fn = (name: string): string => {
    const at = src.indexOf(`\nfunction ${name}(`)
    return at === -1 ? '' : src.slice(at, src.indexOf('\n}\n', at) + 3)
  }
  const launcher = src.match(/\nconst LAUNCHER = .*\n/)?.[0] ?? ''
  return ["import { execFileSync } from 'child_process'", 'let ancestorList = null', launcher, ...PICK.map(fn), 'console.log(detectAgent())'].join('\n')
}

function agentUnder(program: string, args: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'shim-name-'))
  writeFileSync(join(dir, 'part.mjs'), shimPart())
  const fake = join(dir, program)
  writeFileSync(fake, `#!${process.execPath}\nrequire('child_process').execFileSync(process.execPath, [${JSON.stringify(join(dir, 'part.mjs'))}], { stdio: 'inherit' })\n`)
  chmodSync(fake, 0o755)
  return execFileSync(fake, args, { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' }).trim()
}

describe('shim agent name comes from the program, not its arguments', () => {
  it('an OpenCode session running a Claude model is OpenCode', () => {
    expect(agentUnder('opencode', ['--model', 'anthropic/claude-sonnet-5'])).toBe('opencode')
  })

  it('a Cursor agent asked about claude is Cursor', () => {
    expect(agentUnder('cursor-agent', ['--approve-mcps', 'why does claude say no'])).toBe('cursor')
  })

  it('agy is Antigravity even when its prompt names another agent', () => {
    expect(agentUnder('agy', ['-i', 'compare codex and opencode'])).toBe('antigravity')
  })
})
