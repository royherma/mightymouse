import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ opened: [] as string[] }))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, out: string) => void) =>
    cb(
      null,
      [
        '/Applications/Safari.app',
        '/Applications/Google Chrome.app',
        '/Applications/Visual Studio Code.app',
        '/Applications/ChatGPT.app',
        '/System/Applications/Notes.app',
        '/System/Applications/System Settings.app',
        '/Users/ada/Applications/Slack.app',
        '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app',
        '/Volumes/Backup/Applications/Music.app'
      ].join('\n')
    )
}))
vi.mock('../../capture/app-icon', () => ({ warmAppIcons: async () => {} }))
vi.mock('../../intent-router', () => ({
  VERBS: {
    openApp: {
      run: async (name: string) => {
        h.opened.push(name)
        return { ok: true, spoken: `Opened ${name}` }
      }
    }
  }
}))

import { quickOpenApp } from '../capabilities/system'

describe('quickOpenApp: "open <installed app>" skips the model', () => {
  it.each([
    ['open Safari', 'Safari'],
    ['Open safari.', 'Safari'],
    ['Hey, can you open the Notes app?', 'Notes'],
    ['could you please launch Google Chrome', 'Google Chrome'],
    ['switch to Visual Studio Code', 'Visual Studio Code'],
    ['bring up system settings', 'System Settings'],
    ['open up Slack', 'Slack'],
    ['open chat GPT', 'ChatGPT']
  ])('%s -> %s', async (said, app) => {
    expect((await quickOpenApp(said))?.app).toBe(app)
  })

  it.each([
    'open Safari and go to example.com',
    'open the pod bay doors',
    'close Safari',
    'what is Safari',
    'open Simulator',
    'open Music'
  ])('%s -> not a quick open', async (said) => {
    expect(await quickOpenApp(said)).toBeNull()
  })

  it('run opens the matched app by its real name', async () => {
    const quick = await quickOpenApp('open google chrome')
    expect(await quick?.run()).toEqual({ ok: true, line: 'Opened Google Chrome' })
    expect(h.opened).toEqual(['Google Chrome'])
  })
})
