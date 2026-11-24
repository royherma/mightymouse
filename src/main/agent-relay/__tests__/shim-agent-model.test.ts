import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SHIM = join(__dirname, '../../../../npm-shim/mightymouse-code/bin/mightymouse-code.js')
const PICK = ['sessionModel', 'agentArgModel', 'modelLabel', 'detectAgent', 'ancestorCommands', 'ancestors', 'claudeSettingsModel']

function shimPart(): string {
  const src = readFileSync(SHIM, 'utf8')
  const fn = (name: string): string => {
    const at = src.indexOf(`\nfunction ${name}(`)
    return at === -1 ? '' : src.slice(at, src.indexOf('\n}\n', at) + 3)
  }
  const launcher = src.match(/\nconst LAUNCHER = .*\n/)?.[0] ?? ''
  return [
    "import { execFileSync } from 'child_process'",
    "import { readFileSync } from 'fs'",
    "import { homedir } from 'os'",
    "import { basename, join } from 'path'",
    'let ancestorList = null',
    'const transcriptModel = () => ""',
    'const codexConfigModel = () => ""',
    launcher,
    ...PICK.map(fn),
    'console.log(sessionModel(detectAgent()))'
  ].join('\n')
}

function modelUnder(program: string, args: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'shim-model-'))
  mkdirSync(join(home, '.claude'))
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }))
  writeFileSync(join(home, 'part.mjs'), shimPart())
  const fake = join(home, program)
  writeFileSync(
    fake,
    `#!${process.execPath}\nrequire('child_process').execFileSync(process.execPath, [${JSON.stringify(join(home, 'part.mjs'))}], { stdio: 'inherit' })\n`
  )
  chmodSync(fake, 0o755)
  return execFileSync(fake, args, { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' }).trim()
}

describe('shim model label', () => {
  it('a Gemini agent started by agy reports the model it was launched with, not Claude settings', () => {
    expect(modelUnder('agy', ['--model', 'gemini-4-neon-medium', '-i', 'hi'])).toBe('Gemini 4 Neon')
  })
  it('an agy agent with no --model reports nothing rather than Opus', () => {
    expect(modelUnder('agy', ['-i', 'hi'])).toBe('')
  })
})
