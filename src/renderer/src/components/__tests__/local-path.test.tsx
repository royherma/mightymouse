import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../Markdown'
import { InlineMedia } from '../local-path'

const CWD = '/Users/roy/Dev/App'
;(globalThis as { window?: unknown }).window = {
  api: { mediaUrl: (p: string) => `media://file/${encodeURIComponent(p)}` }
}

describe('local paths in agent text', () => {
  it('links absolute, relative, inline-code and markdown-link paths but not URLs', () => {
    const html = renderToStaticMarkup(
      <Markdown cwd={CWD}>
        {
          'Saved /Users/roy/Dev/App/.claude/artifacts/shot.png. Fixed in src/main/dock.ts:42, see `docs/gotchas.md`, [index](src/main/index.ts) and https://x.com/a/b.png or 1/2.5'
        }
      </Markdown>
    )
    const hrefs = [
      ...html.matchAll(/class="local-path[^"]*" href="([^"]+)"|href="([^"]+)" class="local-path/g)
    ].map((m) => m[1] ?? m[2])
    expect(hrefs).toEqual([
      `${CWD}/.claude/artifacts/shot.png`,
      `${CWD}/src/main/dock.ts`,
      `${CWD}/docs/gotchas.md`,
      `${CWD}/src/main/index.ts`
    ])
    expect(html).toContain('href="https://x.com/a/b.png"')
  })

  it('shows images and videos inline, not code files', () => {
    const html = renderToStaticMarkup(
      <InlineMedia text={'see /Users/roy/Dev/App/a.png and out/b.mp4 and src/c.ts'} cwd={CWD} />
    )
    expect(html.match(/<img/g)?.length).toBe(1)
    expect(html.match(/<video/g)?.length).toBe(1)
  })
})
