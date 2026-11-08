import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const TMUX = execFileSync('/bin/sh', ['-c', 'command -v tmux || true'], { encoding: 'utf8' }).trim()

vi.mock('../../platform/macos/resolve-binary', () => ({ resolveBinary: (name: string) => (name === 'tmux' ? TMUX || null : null) }))
vi.mock('../../platform', () => ({ resolveBinary: (name: string) => (name === 'tmux' ? TMUX || null : null) }))
vi.mock('../../../shared/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/env')>()),
  devLog: { warn: vi.fn(), log: vi.fn() }
}))

import { isStreaming, streamCommand, watchPane } from '../pane-stream'
import { livesInApp } from '../origin-resolver'

const dir = mkdtempSync(join(tmpdir(), 'mm-ps-'))
const socket = join(dir, 's')
const tmux = (...args: string[]): string => execFileSync(TMUX, ['-S', socket, ...args], { encoding: 'utf8' }).trim()
let pane = ''
const userClients: ChildProcess[] = []

beforeAll(() => {
  tmux('new-session', '-d', '-s', 'work', '-x', '80', '-y', '24')
  pane = tmux('display-message', '-p', '-t', 'work', '#{pane_id}')
})
afterAll(() => {
  for (const c of userClients) c.kill()
  spawnSync(TMUX, ['-S', socket, 'kill-server'])
  rmSync(dir, { recursive: true, force: true })
})

const origin = (): { tmuxPane: string; tmuxSocket: string } => ({ tmuxPane: pane, tmuxSocket: socket })
const clientFlags = (): string[] => tmux('list-clients', '-F', '#{client_flags}').split('\n').filter(Boolean)

describe('pane stream over a real tmux control client', () => {
  let changes = 0
  let stop = (): void => {}

  it('attaches one hidden client that never sizes the pane, and answers commands over it', async () => {
    stop = watchPane(origin(), () => changes++)
    await vi.waitFor(() => expect(isStreaming(origin())).toBe(true))
    await vi.waitFor(() => expect(clientFlags()).toHaveLength(1))
    expect(clientFlags()[0]).toContain('ignore-size')
    const ask = streamCommand(origin())!
    expect(await ask(['display-message', '-p', '-t', pane, '#{pane_width} #{pane_height}'])).toBe('80 24')
  })

  it('quotes arguments with spaces and quotes so tmux sees them whole', async () => {
    const ask = streamCommand(origin())!
    expect(await ask(['display-message', '-p', '-t', pane, "it's #{pane_id} ok"])).toBe(`it's ${pane} ok`)
  })

  it('a failed command answers null and the next replies still line up', async () => {
    const ask = streamCommand(origin())!
    const [bad, width, name] = await Promise.all([
      ask(['show-options', '-t', 'no-such-session']),
      ask(['display-message', '-p', '-t', pane, '#{pane_width}']),
      ask(['display-message', '-p', '-t', pane, '#{session_name}'])
    ])
    expect([bad, width, name]).toEqual([null, '80', 'work'])
  })

  it('tells the watcher when the pane prints', async () => {
    const before = changes
    tmux('send-keys', '-t', pane, 'echo streamed-line', 'Enter')
    await vi.waitFor(() => expect(changes).toBeGreaterThan(before))
  })

  it('the hidden client alone does not count as the user having the pane open', async () => {
    expect(await livesInApp(origin())).toBe(true)
  })

  it('a real attached client does', async () => {
    const user = spawn(TMUX, ['-S', socket, '-C', 'attach-session', '-t', 'work'])
    userClients.push(user)
    await vi.waitFor(() => expect(clientFlags()).toHaveLength(2))
    expect(await livesInApp(origin())).toBe(false)
    user.kill()
    await vi.waitFor(() => expect(clientFlags()).toHaveLength(1))
    expect(await livesInApp(origin())).toBe(true)
  })

  it('the last unwatch detaches the hidden client', async () => {
    stop()
    expect(streamCommand(origin())).toBeNull()
    await vi.waitFor(() => expect(clientFlags()).toHaveLength(0))
  })

  it('a killed session drops the stream instead of answering from a dead client', async () => {
    tmux('new-session', '-d', '-s', 'gone', '-x', '80', '-y', '24')
    const gonePane = tmux('display-message', '-p', '-t', 'gone', '#{pane_id}')
    const o = { tmuxPane: gonePane, tmuxSocket: socket }
    const end = watchPane(o, () => {})
    await vi.waitFor(() => expect(isStreaming(o)).toBe(true))
    tmux('kill-session', '-t', 'gone')
    await vi.waitFor(() => expect(isStreaming(o)).toBe(false))
    end()
  })
})
