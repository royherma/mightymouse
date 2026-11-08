import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG } from '../../../shared/config'

// Same trick as feedback.test.ts: paths.ts captures os.homedir() at eval time, so
// the temp home must exist and homedir() must return it BEFORE run-folder.ts
// (→ paths.ts) is first imported.
const HOME = mkdtempSync(join(tmpdir(), 'mm-runfolder-'))
mkdirSync(join(HOME, CONFIG.APP_NAME, 'runs'), { recursive: true })

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => HOME }
})

const RUNS = join(HOME, CONFIG.APP_NAME, 'runs')

let createRunFolder: typeof import('../run-folder').createRunFolder

describe('createRunFolder', () => {
  beforeAll(async () => {
    createRunFolder = (await import('../run-folder')).createRunFolder
  })

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true })
  })

  it('names the folder <ts>-<kind>-<slug>-<run_id> (sortable + readable) and seeds run.json', () => {
    const dir = createRunFolder({
      runId: 'r1234',
      ts: '2026-06-14T10-00-00Z',
      kind: 'ask',
      instruction: 'what day is it',
      backend: 'mightymouse'
    })
    expect(dir).toBe(join(RUNS, '2026-06-14T10-00-00Z-ask-what-day-is-it-r1234'))
    expect(existsSync(dir!)).toBe(true)

    const meta = JSON.parse(readFileSync(join(dir!, 'run.json'), 'utf-8'))
    expect(meta).toMatchObject({
      run_id: 'r1234',
      kind: 'ask',
      instruction: 'what day is it',
      backend: 'mightymouse'
    })
  })

  it('tags the folder with the capture kind so a listen sorts apart from an ask', () => {
    const dir = createRunFolder({
      runId: 'l9f1a',
      ts: '2026-06-14T10-02-00Z',
      kind: 'listen',
      instruction: 'summarize this',
      backend: 'claude'
    })
    expect(dir).toBe(join(RUNS, '2026-06-14T10-02-00Z-listen-summarize-this-l9f1a'))
    const meta = JSON.parse(readFileSync(join(dir!, 'run.json'), 'utf-8'))
    expect(meta.kind).toBe('listen')
  })

  it('leads with the timestamp so runs sort chronologically', () => {
    const early = createRunFolder({ runId: 'a1', ts: '2026-06-14T08-00-00Z', kind: 'ask', instruction: 'zzz first', backend: 'claude' })
    const late = createRunFolder({ runId: 'b2', ts: '2026-06-14T20-00-00Z', kind: 'ask', instruction: 'aaa second', backend: 'claude' })
    // Lexical sort of basenames == chronological, regardless of instruction text.
    expect([late!, early!].map((d) => d.split('/').pop()).sort()[0]).toContain('08-00-00')
  })

  it('sanitizes a run_id with a colon into a shell-safe folder name', () => {
    // 'r:3f2a' / 'cheese:1a2b' / 'sf:<uuid>' all carry a ':' — must become '-'.
    const dir = createRunFolder({
      runId: 'cheese:1a2b',
      ts: '2026-06-14T10-00-00Z',
      kind: 'rewrite',
      instruction: 'tighten this',
      backend: 'claude'
    })
    expect(dir).toBe(join(RUNS, '2026-06-14T10-00-00Z-rewrite-tighten-this-cheese-1a2b'))
    expect(existsSync(dir!)).toBe(true)
  })

  it('empty instruction falls back to "run" in the slug', () => {
    const dir = createRunFolder({ runId: 'empty1', ts: '2026-06-14T10-00-00Z', kind: 'act', instruction: '', backend: 'claude' })
    expect(dir).toBe(join(RUNS, '2026-06-14T10-00-00Z-act-run-empty1'))
  })

  it('is idempotent — same run_id reuses the dir even as the slug changes (multi-turn ask)', () => {
    const a = createRunFolder({
      runId: 'turn-run',
      ts: '2026-06-14T10-00-00Z',
      kind: 'ask',
      instruction: 'first turn',
      backend: 'codex'
    })
    const b = createRunFolder({
      runId: 'turn-run',
      ts: '2026-06-14T10-05-00Z',
      kind: 'ask',
      instruction: 'a completely different second turn',
      backend: 'codex'
    })
    // Same dir despite a different ts + slug — matched on the trailing run_id.
    expect(a).toBe(b)
    expect(a).toBe(join(RUNS, '2026-06-14T10-00-00Z-ask-first-turn-turn-run'))
    // run.json reflects the latest call.
    const meta = JSON.parse(readFileSync(join(b!, 'run.json'), 'utf-8'))
    expect(meta.instruction).toBe('a completely different second turn')
  })

  it('writes a context block into run.json, dropping empty fields', () => {
    const dir = createRunFolder({
      runId: 'ctx1',
      ts: '2026-06-14T11-00-00Z',
      kind: 'rewrite',
      instruction: 'tighten',
      backend: 'claude',
      context: {
        front_app: 'Google Chrome',
        window_title: 'Runway',
        browser_url: '', // empty → dropped
        screenshot_path: '/tmp/ctx.png',
        selection_chars: 42
      }
    })
    const meta = JSON.parse(readFileSync(join(dir!, 'run.json'), 'utf-8'))
    expect(meta.context).toEqual({
      front_app: 'Google Chrome',
      window_title: 'Runway',
      screenshot_path: '/tmp/ctx.png',
      selection_chars: 42
    })
    expect('browser_url' in meta.context).toBe(false)
  })

  it('omits the context block entirely when there is nothing to record', () => {
    const dir = createRunFolder({
      runId: 'noctx1',
      ts: '2026-06-14T11-01-00Z',
      kind: 'act',
      instruction: 'do a thing',
      backend: 'claude',
      context: { front_app: '', window_title: undefined }
    })
    const meta = JSON.parse(readFileSync(join(dir!, 'run.json'), 'utf-8'))
    expect('context' in meta).toBe(false)
  })

  it('writes the selection to input.txt inside the folder (not swept tmp/)', () => {
    const dir = createRunFolder({
      runId: 'sel1',
      ts: '2026-06-14T11-02-00Z',
      kind: 'rewrite',
      instruction: 'fix typos',
      backend: 'claude',
      selection: 'teh quick brown fox'
    })
    expect(readFileSync(join(dir!, 'input.txt'), 'utf-8')).toBe('teh quick brown fox')
  })

  it('skips input.txt for an empty/absent selection', () => {
    const dir = createRunFolder({
      runId: 'nosel1',
      ts: '2026-06-14T11-03-00Z',
      kind: 'act',
      instruction: 'no selection here',
      backend: 'claude'
    })
    expect(existsSync(join(dir!, 'input.txt'))).toBe(false)
  })
})
