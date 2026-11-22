import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StartupPeek, StartupPrompt } from '../../../shared/types'

const h = vi.hoisted(() => ({
  peeks: [] as StartupPeek[],
  answered: [] as Array<{ pane: string; index: number }>,
  minted: [] as Array<{ question: string; options: string[] }>
}))

vi.mock('../../../shared/env', () => ({ devLog: { error: () => {}, warn: () => {} } }))
vi.mock('../../store/paths', () => ({ PATHS: { CODE_NO_PROJECT: '/mm/no-project' } }))
vi.mock('../mcp/http-listener', () => ({ liveAgentSessions: () => [] }))
vi.mock('../relay-send', () => ({ sendRelayPush: async () => ({ ok: true }) }))
vi.mock('../picker-keys', () => ({
  peekStartup: async () => h.peeks.shift() ?? { alive: false, prompt: null, tail: [] },
  answerStartup: async (pane: string, index: number) => {
    h.answered.push({ pane, index })
  }
}))
vi.mock('../store', () => ({
  relayRequestStore: {
    mint: (_verb: string, params: { question: string; options: string[] }) => {
      h.minted.push(params)
      return { id: `req-${h.minted.length}` }
    },
    get: () => undefined,
    resolve: () => {},
    undoPending: () => false
  }
}))

import { watchStartup } from '../startup-watch'

const SHOTS = join(tmpdir(), 'MightyMouse-reply-screens')
const ADD_OPTIONS = ['No, exit', 'Yes, add for this session', 'Yes, and remember']

const showing = (prompt: StartupPrompt): StartupPeek => ({ alive: true, prompt, tail: [] })
const addDir = (folder: string): StartupPrompt => ({
  question: `Do you trust the files in ${folder}?`,
  detail: '',
  options: ADD_OPTIONS,
  selected: 0
})

async function run(input: Parameters<typeof watchStartup>[0], prompt: StartupPrompt): Promise<void> {
  h.peeks = [showing(prompt), { alive: false, prompt: null, tail: [] }]
  watchStartup(input)
  await vi.advanceTimersByTimeAsync(2500)
}

beforeEach(() => {
  vi.useFakeTimers()
  h.answered = []
  h.minted = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('watchStartup answers the add-folder question only for its own screenshot folder', () => {
  it("picks 'Yes, add' when the question names the app's own temp folder", async () => {
    await run({ pane: '%1', from: 'proj', cwd: '/Users/me/proj', readDirs: [SHOTS] }, addDir(SHOTS))
    expect(h.answered).toEqual([{ pane: '%1', index: 1 }])
    expect(h.minted).toEqual([])
  })

  it('still matches when the terminal wrapped the folder path across lines', async () => {
    const wrapped = `${SHOTS.slice(0, 12)} ${SHOTS.slice(12)}`
    await run({ pane: '%2', from: 'proj', cwd: '/Users/me/proj', readDirs: [SHOTS] }, addDir(wrapped))
    expect(h.answered).toEqual([{ pane: '%2', index: 1 }])
  })

  it('asks the person when the folder is one they attached from outside the temp folder', async () => {
    const desktop = '/Users/me/Desktop/notes'
    await run({ pane: '%3', from: 'proj', cwd: '/Users/me/proj', readDirs: [desktop] }, addDir(desktop))
    expect(h.answered).toEqual([])
    expect(h.minted.map((m) => m.question)).toEqual([`Do you trust the files in ${desktop}?`])
  })

  it('asks the person when the question names a folder the session was not started with', async () => {
    const other = join(tmpdir(), 'somebody-else')
    await run({ pane: '%4', from: 'proj', cwd: '/Users/me/proj', readDirs: [SHOTS] }, addDir(other))
    expect(h.answered).toEqual([])
    expect(h.minted).toHaveLength(1)
  })

  it('never auto-trusts a user-picked project folder', async () => {
    const trust: StartupPrompt = { question: 'Is this a project you trust?', detail: '', options: ['No, exit', 'Yes, I trust this folder'], selected: 0 }
    await run({ pane: '%5', from: 'proj', cwd: '/Users/me/proj', readDirs: [SHOTS] }, trust)
    expect(h.answered).toEqual([])
    expect(h.minted).toHaveLength(1)
  })
})
