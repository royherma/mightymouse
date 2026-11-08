import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ home: '', mightyDir: '', repo: '' }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => env.home }
})
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => (args.at(-1) as (e: Error) => void)(new Error('no lsof under test')),
  spawn: vi.fn()
}))
vi.mock('../../store/paths', () => ({
  PATHS: {
    get MIGHTY_DIR() {
      return env.mightyDir
    }
  }
}))
vi.mock('../../store/mighty', () => ({
  MIGHTY: { listProjects: () => [{ id: 'proj-1', name: 'Site', repoFolder: env.repo, archived: false }] }
}))

env.home = mkdtempSync(join(tmpdir(), 'mm-built-scan-'))
env.mightyDir = join(env.home, 'mighty')
env.repo = join(env.home, 'site_repo')
const { scanBuilt, favoriteBuilt, hideBuilt } = await import('../scan')

const DAY = 86_400_000
const at = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString()
const page = join(env.repo, 'site', 'page.html')
const deck = join(env.repo, 'site', 'deck.html')
const transcript = join(env.home, '.claude', 'projects', env.repo.replace(/[/_.]/g, '-'), 'session-1.jsonl')

const row = (type: string, ts: string, content: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, timestamp: ts, sessionId: 's1', cwd: env.repo, message: { content }, ...extra })
const write = (id: string, file: string) => ({ type: 'tool_use', id, name: 'Write', input: { file_path: file } })
const text = (t: string) => ({ type: 'text', text: t })

mkdirSync(join(env.repo, 'site'), { recursive: true })
mkdirSync(join(env.repo, 'src'), { recursive: true })
writeFileSync(page, '<html><head><title>Pricing page</title></head></html>')
writeFileSync(deck, '<html><head><title>Launch deck</title></head></html>')
writeFileSync(join(env.repo, 'src', 'component.html'), '<p>x</p>')
mkdirSync(join(transcript, '..'), { recursive: true })
writeFileSync(
  transcript,
  [
    JSON.stringify({ type: 'ai-title', sessionId: 's1', aiTitle: 'Build the pricing page' }),
    row('assistant', at(3 * DAY), [write('w1', page)]),
    row('assistant', at(2 * DAY), [write('w2', page)]),
    row('assistant', at(2 * DAY), [write('w3', join(env.repo, 'src', 'component.html'))]),
    row('assistant', at(DAY + 60_000), [write('w4', deck)]),
    row('assistant', at(DAY), [{ type: 'tool_use', id: 'a1', name: 'Artifact', input: { file_path: deck } }]),
    row('user', at(DAY), [{ type: 'tool_result', tool_use_id: 'a1', content: 'Published https://claude.ai/code/artifact/abcdef12-0000' }], {
      toolUseResult: { artifact_id: 'uuid-1111-2222' }
    }),
    row('assistant', at(8 * DAY), [text('Dev server at http://localhost:5173/app')]),
    row('assistant', at(8 * DAY), [text('Docs at http://localhost:4000')]),
    row('assistant', at(DAY), [text('API on http://127.0.0.1:3000/health')])
  ].join('\n') + '\n'
)

afterAll(() => rmSync(env.home, { recursive: true, force: true }))

const byId = (items: Awaited<ReturnType<typeof scanBuilt>>) => new Map(items.map((i) => [i.id, i]))

describe('Made scan from Claude Code transcripts', () => {
  it('turns Write/Artifact/localhost lines into items with versions, titles and the chat name', async () => {
    const items = byId(await scanBuilt())
    expect(items.get(`file:${page}`)).toMatchObject({ kind: 'file', title: 'Pricing page', versions: 2, chat: 'Build the pricing page', projectId: 'proj-1' })
    expect(items.get('online:https://claude.ai/code/artifact/uuid-1111-2222')).toMatchObject({ kind: 'online', title: 'Launch deck', file: deck })
    expect(items.has(`file:${deck}`)).toBe(false)
    expect(items.has(`file:${join(env.repo, 'src', 'component.html')}`)).toBe(false)
    expect(items.get('port:3000')).toMatchObject({ kind: 'stopped', url: 'http://127.0.0.1:3000/health' })
  })

  it('drops a stopped server unseen for over 7 days', async () => {
    const items = byId(await scanBuilt())
    expect(items.has('port:5173')).toBe(false)
    expect(items.has('port:4000')).toBe(false)
  })

  it('a favorited stopped server never expires, and unfavoriting lets it expire again', async () => {
    await favoriteBuilt('port:4000', true)
    let items = byId(await scanBuilt())
    expect(items.get('port:4000')).toMatchObject({ kind: 'stopped', favorite: true })
    expect(items.has('port:5173')).toBe(false)

    await favoriteBuilt('port:4000', false)
    items = byId(await scanBuilt())
    expect(items.has('port:4000')).toBe(false)
  })

  it('rescanning an unchanged transcript does not count versions twice', async () => {
    const items = byId(await scanBuilt())
    expect(items.get(`file:${page}`)?.versions).toBe(2)
  })

  it('an archived item stays hidden across rescans', async () => {
    await hideBuilt('port:3000')
    expect(byId(await scanBuilt()).has('port:3000')).toBe(false)
  })
})
