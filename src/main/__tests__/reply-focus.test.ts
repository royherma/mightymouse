import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Session = { label: string; since: number; sessionId?: string; cwd?: string; origin?: { tmuxPane?: string }; facts?: { agent?: string } }

const h = vi.hoisted(() => ({
  root: '',
  live: [] as Session[],
  built: [] as Array<Record<string, unknown>>,
  front: '',
  url: '',
  settings: {} as Record<string, unknown>,
  cmux: '',
  tmux: '',
  onFront: null as ((bundleId: string) => void) | null,
  follow: [] as boolean[],
  switched: [] as string[]
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, screen: {} }))
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => h.root }))
vi.mock('../platform', () => ({
  context: {
    userFacingFrontmostBundleId: () => h.front,
    frontPageUrl: async () => h.url,
    onFrontmostAppChange: (fn: (bundleId: string) => void) => {
      h.onFront = fn
    }
  },
  resolveBinary: () => h.tmux
}))
vi.mock('../agent-relay/mcp/http-listener', () => ({ liveAgentSessions: () => h.live }))
vi.mock('../agent-relay/session-transcript', () => ({
  claudeTranscriptPaths: (_home: string, _cwd: string, id: string) => [join(h.root, 'chats', `${id}.jsonl`)],
  codexTranscriptPath: () => ''
}))
vi.mock('../agent-relay/origin-resolver', () => ({ cmuxPath: () => h.cmux }))
vi.mock('../store/settings', () => ({
  SETTINGS: { get: () => h.settings, set: (patch: Record<string, unknown>) => Object.assign(h.settings, patch) }
}))
vi.mock('../reply-window', () => ({
  followFrontApp: (showHere: boolean) => h.follow.push(showHere),
  switchReplyWindow: (aim: { ref: string }) => {
    h.switched.push(aim.ref)
    return true
  },
  tellReplyWindow: () => undefined
}))
vi.mock('../built/scan', () => ({ cachedBuilt: () => h.built }))

const CHROME = 'com.google.Chrome'

const session = (sessionId: string, cwd: string): Session => ({ label: sessionId, since: 0, sessionId, cwd })

function chat(sessionId: string, mentions: string, times: number): void {
  const lines = Array.from({ length: times }, () => JSON.stringify({ text: `opened ${mentions}` }))
  lines.push(JSON.stringify({ text: 'unrelated line' }))
  writeFileSync(join(h.root, 'chats', `${sessionId}.jsonl`), lines.join('\n'))
}

function page(rel: string, html = '<html></html>'): string {
  const path = join(h.root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, html)
  return path
}

function inFront(url: string, bundle = CHROME): void {
  h.front = bundle
  h.url = url
}

async function load(): Promise<typeof import('../reply-focus')> {
  vi.resetModules()
  return import('../reply-focus')
}

beforeEach(() => {
  h.root = mkdtempSync(join(tmpdir(), 'mm-reply-focus-'))
  mkdirSync(join(h.root, 'chats'))
  mkdirSync(join(h.root, 'proj'))
  mkdirSync(join(h.root, 'other'))
  h.live = []
  h.built = []
  h.settings = {}
  h.cmux = ''
  h.tmux = ''
  h.onFront = null
  h.follow = []
  h.switched = []
  inFront('')
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(h.root, { recursive: true, force: true })
})

describe('aimAtFront picks the agent for the browser tab in front', () => {
  it('the agent that made the page wins over another agent working in the same folder', async () => {
    const file = page('proj/out/report-page.html')
    h.live = [session('in-folder', join(h.root, 'proj')), session('maker', join(h.root, 'other'))]
    h.built = [{ sessionId: 'maker', file }]
    inFront(pathToFileURL(file).href)
    expect(await (await load()).aimAtFront(2000)).toBe('maker')
  })

  it('a made-by entry for an agent that is no longer connected is ignored', async () => {
    const file = page('proj/out/report-page.html')
    h.live = [session('in-folder', join(h.root, 'proj'))]
    h.built = [{ sessionId: 'gone', file }]
    inFront(pathToFileURL(file).href)
    expect(await (await load()).aimAtFront(2000)).toBe('in-folder')
  })

  it('an artifact page names its maker in data-sessions, and the first one still connected is chosen', async () => {
    const file = page('proj/.claude/artifacts/review-page.html', '<body data-sessions="gone:1,maker:2,in-folder:3">')
    h.live = [session('in-folder', join(h.root, 'proj')), session('maker', join(h.root, 'other'))]
    inFront(pathToFileURL(file).href)
    expect(await (await load()).aimAtFront(2000)).toBe('maker')
  })

  it('the one agent whose folder holds the page is chosen; an agent sitting in the home folder never counts', async () => {
    const file = page('proj/site/index-page.html')
    h.live = [session('home', h.root), session('in-folder', join(h.root, 'proj')), session('elsewhere', join(h.root, 'other'))]
    inFront(pathToFileURL(file).href)
    expect(await (await load()).aimAtFront(2000)).toBe('in-folder')
  })

  it('a local server page is matched through the folder the made-by entry records for its port', async () => {
    h.live = [session('in-folder', join(h.root, 'proj')), session('elsewhere', join(h.root, 'other'))]
    h.built = [{ port: 5173, cwd: join(h.root, 'proj') }]
    inFront('http://localhost:5173/dashboard')
    expect(await (await load()).aimAtFront(2000)).toBe('in-folder')
  })

  it('a local server page an agent started is matched to that agent by its port', async () => {
    h.live = [session('in-folder', join(h.root, 'proj')), session('maker', join(h.root, 'other'))]
    h.built = [{ sessionId: 'maker', port: 5173, cwd: join(h.root, 'proj') }]
    inFront('http://app.localhost:5173/')
    expect(await (await load()).aimAtFront(2000)).toBe('maker')
  })

  it('two agents in the folder: the one whose chat names the page is chosen, even once', async () => {
    const file = page('proj/out/report-page.html')
    h.live = [session('quiet', join(h.root, 'proj')), session('talker', join(h.root, 'proj'))]
    chat('quiet', 'something-else.html', 4)
    chat('talker', 'report-page.html', 1)
    inFront(pathToFileURL(file).href)
    expect(await (await load()).aimAtFront(2000)).toBe('talker')
  })

  it('two agents in the folder: the one that names the page more often wins', async () => {
    const file = page('proj/out/report-page.html')
    h.live = [session('less', join(h.root, 'proj')), session('more', join(h.root, 'proj'))]
    chat('more', 'report-page.html', 5)
    chat('less', 'report-page.html', 2)
    inFront(pathToFileURL(file).href)
    expect(await (await load()).aimAtFront(2000)).toBe('more')
  })

  it('a page outside every agent folder needs 3 mentions in one chat: 2 is a stray mention and picks nobody', async () => {
    h.live = [session('agent', join(h.root, 'proj'))]
    chat('agent', 'example.com/docs/pricing', 2)
    inFront('https://example.com/docs/pricing?ref=x')
    expect(await (await load()).aimAtFront(2000)).toBeUndefined()
  })

  it('a page outside every agent folder with 3 mentions in one chat picks that agent', async () => {
    h.live = [session('agent', join(h.root, 'proj')), session('other', join(h.root, 'other'))]
    chat('agent', 'example.com/docs/pricing', 3)
    inFront('https://example.com/docs/pricing/')
    expect(await (await load()).aimAtFront(2000)).toBe('agent')
  })

  it('in cmux, the agent in the focused tmux pane is chosen', async () => {
    const bin = join(h.root, 'bin')
    mkdirSync(bin)
    h.cmux = join(bin, 'cmux')
    h.tmux = join(bin, 'tmux')
    writeFileSync(h.cmux, `#!/bin/sh\necho '{"surfaces":[{"focused":false,"title":"a"},{"focused":true,"title":"work","resume_binding":{"kind":"tmux","checkpoint_id":"mm-2"}}]}'\n`)
    writeFileSync(h.tmux, `#!/bin/sh\n[ "$4" = "mm-2" ] && echo '%7'\n`)
    chmodSync(h.cmux, 0o755)
    chmodSync(h.tmux, 0o755)
    h.live = [
      { ...session('pane-3', join(h.root, 'proj')), origin: { tmuxPane: '%3' } },
      { ...session('pane-7', join(h.root, 'proj')), origin: { tmuxPane: '%7' } }
    ]
    inFront('', 'com.cmuxterm.app')
    expect(await (await load()).aimAtFront(2000)).toBe('pane-7')
  })
})

describe('startReplyFocusTracking shows the reply window over a browser only when an agent is connected', () => {
  async function track(): Promise<(bundleId: string) => void> {
    vi.useFakeTimers({ toFake: ['setInterval'] })
    ;(await load()).startReplyFocusTracking()
    return h.onFront!
  }

  it('a browser in front with no agent connected keeps the window away', async () => {
    const front = await track()
    front(CHROME)
    expect(h.follow).toEqual([false])
  })

  it('a browser in front with an agent connected shows it; a non-browser app hides it', async () => {
    h.live = [session('agent', join(h.root, 'proj'))]
    const front = await track()
    front(CHROME)
    front('com.apple.Terminal')
    expect(h.follow).toEqual([true, false])
  })

  it('an app removed from the show-over list hides it even with an agent connected', async () => {
    h.live = [session('agent', join(h.root, 'proj'))]
    h.settings.replyWindowShowOver = ['com.apple.Safari']
    const front = await track()
    front(CHROME)
    front('com.apple.Safari')
    expect(h.follow).toEqual([false, true])
  })

  it('switching to MightyMouse itself leaves the window as it is', async () => {
    h.live = [session('agent', join(h.root, 'proj'))]
    const front = await track()
    front('com.mightymouse.app')
    expect(h.follow).toEqual([])
  })

  it('auto-switch moves the window to the agent that made the tab in front, and stays put when turned off', async () => {
    const file = page('proj/out/report-page.html')
    h.live = [session('maker', join(h.root, 'other')), session('in-folder', join(h.root, 'proj'))]
    h.built = [{ sessionId: 'maker', file }]
    inFront(pathToFileURL(file).href)
    const front = await track()
    front(CHROME)
    await vi.waitFor(() => expect(h.switched).toEqual(['maker']))

    h.settings.replyWindowAutoSwitch = false
    const off = await track()
    off(CHROME)
    await new Promise((done) => setTimeout(done, 50))
    expect(h.switched).toEqual(['maker'])
  })
})
