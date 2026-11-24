import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const proc = vi.hoisted(() => ({ args: new Map<number, string>(), lsof: new Map<number, string>() }))
vi.mock('child_process', async (orig) => ({
  ...(await orig<typeof import('child_process')>()),
  execFileSync: (cmd: string, argv: string[]) => {
    const pid = Number(argv[argv.indexOf('-p') + 1])
    const out = cmd === 'ps' ? proc.args.get(pid) : cmd === 'lsof' ? proc.lsof.get(pid) : undefined
    if (out === undefined) throw new Error(`no such process ${pid}`)
    return out
  }
}))

const { readAntigravityTranscript } = await import('../antigravity-transcript')

const home = mkdtempSync(join(tmpdir(), 'mm-agy-'))
const convDir = join(home, '.gemini', 'antigravity-cli', 'conversations')
const logDir = join(home, '.gemini', 'antigravity-cli', 'log')
mkdirSync(convDir, { recursive: true })
mkdirSync(logDir, { recursive: true })
afterAll(() => rmSync(home, { recursive: true, force: true }))

const varint = (n: number): Buffer => {
  const out: number[] = []
  while (n > 127) {
    out.push((n & 127) | 128)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return Buffer.from(out)
}
const bytes = (f: number, v: Buffer | string): Buffer => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(v)
  return Buffer.concat([varint((f << 3) | 2), varint(b.length), b])
}
const num = (f: number, n: number): Buffer => Buffer.concat([varint(f << 3), varint(n)])
const stamp = (seconds: number): Buffer => bytes(5, bytes(1, num(1, seconds)))
const userStep = (text: string, seconds: number): Buffer => Buffer.concat([stamp(seconds), bytes(19, bytes(2, text))])
const modelStep = (text: string, seconds: number, tool?: { name: string; args: object }): Buffer =>
  Buffer.concat([
    stamp(seconds),
    bytes(20, Buffer.concat([bytes(1, text), tool ? bytes(7, Buffer.concat([bytes(2, tool.name), bytes(3, JSON.stringify(tool.args))])) : Buffer.alloc(0)]))
  ])

const CWD = '/Users/dev/app'
let seq = 0
const conversation = (prompt: string, reply: string): string => {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
  const db = new Database(join(convDir, `${id}.db`))
  db.exec('create table steps (idx integer, step_type integer, step_payload blob)')
  const put = db.prepare('insert into steps values (?, ?, ?)')
  put.run(0, 1, bytes(1, `file://${CWD}`))
  put.run(1, 14, userStep(prompt, 1_800_000_000))
  put.run(2, 15, modelStep(reply, 1_800_000_005))
  db.close()
  return id
}
const agy = (pid: number, prompt: string, lsofExtra = ''): void => {
  proc.args.set(pid, `/opt/homebrew/bin/agy --model gemini-3-pro -i ${prompt}`)
  proc.lsof.set(pid, `p${pid}\nn${join(logDir, 'cli-20261124-040000.log')}\n${lsofExtra}`)
}
const session = (pid: number, since: number) => ({ cwd: CWD, since, facts: { agent: 'Antigravity', agentPid: pid } })
const texts = (turns: { text: string }[] | undefined): string[] => (turns ?? []).map((t) => t.text)

let since = 0
beforeEach(() => {
  since = Date.now() - 1000
})

describe('readAntigravityTranscript: agents started in the same second each get their own chat', () => {
  it("the shared log names both pids and the other agent's conversation first", () => {
    const mine = conversation('fix the login bug', 'Fixed the session check.')
    const theirs = conversation('write the readme', 'README drafted.')
    writeFileSync(
      join(logDir, 'cli-20261124-040000.log'),
      `started process with pid 2002\nstarted process with pid 2001\nCreated conversation ${theirs}\nCreated conversation ${mine}\n`
    )
    agy(2001, 'fix the login bug')
    agy(2002, 'write the readme')
    expect(texts(readAntigravityTranscript(session(2001, since), home))).toEqual(['fix the login bug', 'Fixed the session check.'])
    expect(texts(readAntigravityTranscript(session(2002, since), home))).toEqual(['write the readme', 'README drafted.'])
  })

  it('a log overwritten by the other agent (only its pid) is not trusted, even when both sent the same ask', () => {
    const theirs = conversation('rename the api route', 'Their rename.')
    const until = Date.now() + 25
    while (Date.now() < until);
    conversation('rename the api route', 'My rename.')
    writeFileSync(join(logDir, 'cli-20261124-040000.log'), `started process with pid 3002\nCreated conversation ${theirs}\n`)
    agy(3001, 'rename the api route')
    expect(texts(readAntigravityTranscript(session(3001, since), home))).toEqual(['rename the api route', 'My rename.'])
  })

  it('the conversation the agent holds open wins over the log', () => {
    const held = conversation('bump the version', 'Bumped to 2.0.')
    const other = conversation('bump the version', 'A different chat with the same ask.')
    writeFileSync(join(logDir, 'cli-20261124-040000.log'), `started process with pid 4001\nCreated conversation ${other}\n`)
    agy(4001, 'bump the version', `n${join(convDir, `${held}.db`)}\n`)
    expect(texts(readAntigravityTranscript(session(4001, since), home))).toEqual(['bump the version', 'Bumped to 2.0.'])
  })
})

describe('readAntigravityTranscript: reading a conversation', () => {
  it('turns user, model and tool steps into chat turns with real times', () => {
    const id = `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`
    const db = new Database(join(convDir, `${id}.db`))
    db.exec('create table steps (idx integer, step_type integer, step_payload blob)')
    const put = db.prepare('insert into steps values (?, ?, ?)')
    put.run(0, 14, userStep('run the tests', 1_800_000_100))
    put.run(1, 3, Buffer.from('ignored step'))
    put.run(2, 15, modelStep('Running them now.', 1_800_000_101, { name: 'run_command', args: { CommandLine: 'npm   test\n --silent' } }))
    put.run(3, 15, modelStep('', 1_800_000_102, { name: 'view_file', args: { AbsolutePath: '/Users/dev/app/a.ts' } }))
    db.close()
    writeFileSync(join(logDir, 'cli-20261124-040000.log'), `started process with pid 5001\nCreated conversation ${id}\n`)
    agy(5001, 'run the tests')
    expect(readAntigravityTranscript(session(5001, since), home)).toEqual([
      { role: 'you', at: 1_800_000_100_000, text: 'run the tests' },
      { role: 'agent', at: 1_800_000_101_000, text: 'Running them now.' },
      { role: 'tool', at: 1_800_000_101_000, text: 'run_command · npm test --silent' },
      { role: 'tool', at: 1_800_000_102_000, text: 'view_file · /Users/dev/app/a.ts' }
    ])
  })

  it('is not an Antigravity session when the pid runs something else', () => {
    proc.args.set(6001, '/usr/local/bin/claude --resume')
    expect(readAntigravityTranscript(session(6001, since), home)).toBeUndefined()
  })
})
