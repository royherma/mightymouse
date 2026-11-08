import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSessionTranscript } from '../session-transcript'

const id = 'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75'

function agentSays(text: string): { root: string; files: (t: string) => string[] | undefined } {
  const root = mkdtempSync(join(tmpdir(), 'mm-tx-media-'))
  const dir = join(root, '.claude', 'projects', '-cwd')
  mkdirSync(dir, { recursive: true })
  const line = {
    type: 'assistant',
    timestamp: '2026-09-21T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: text.replaceAll('$ROOT', root) }] }
  }
  writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify(line))
  return {
    root,
    files: () => readSessionTranscript({ cwd: '/cwd', sessionId: id }, root)[0]?.files
  }
}

describe('media an agent names in its reply shows on the phone', () => {
  it('picks up images and videos that exist, in backticks, parens or at a sentence end', () => {
    const t = agentSays('Saved `$ROOT/a.png` and ($ROOT/clip.mp4). Also $ROOT/b.JPG.')
    for (const f of ['a.png', 'clip.mp4', 'b.JPG']) writeFileSync(join(t.root, f), 'x')
    expect(t.files('')).toEqual([join(t.root, 'a.png'), join(t.root, 'clip.mp4'), join(t.root, 'b.JPG')])
  })

  it('names the same file once', () => {
    const t = agentSays('Here: $ROOT/a.png - again $ROOT/a.png')
    writeFileSync(join(t.root, 'a.png'), 'x')
    expect(t.files('')).toEqual([join(t.root, 'a.png')])
  })

  it('drops a path that does not exist, a non-media file, and a web URL', () => {
    const t = agentSays('Missing $ROOT/gone.png, notes $ROOT/notes.txt, see https://example.com/$ROOT/a.png')
    writeFileSync(join(t.root, 'notes.txt'), 'x')
    writeFileSync(join(t.root, 'a.png'), 'x')
    expect(t.files('')).toBeUndefined()
  })

  it('does not match a media extension in the middle of a longer name', () => {
    const t = agentSays('Wrote $ROOT/a.png.bak for you')
    writeFileSync(join(t.root, 'a.png'), 'x')
    writeFileSync(join(t.root, 'a.png.bak'), 'x')
    expect(t.files('')).toBeUndefined()
  })
})
