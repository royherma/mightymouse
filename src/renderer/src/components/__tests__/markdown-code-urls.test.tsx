import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../Markdown'

;(globalThis as { window?: unknown }).window = {
  api: { mediaUrl: (p: string) => `media://file/${encodeURIComponent(p)}` }
}

const render = (text: string): string => renderToStaticMarkup(<Markdown cwd="/Users/roy/Dev/App">{text}</Markdown>)

describe('web URLs wrapped in backticks', () => {
  it('become clickable links', () => {
    const html = render('Deployed to `https://staging.example.com/app?x=1` just now')
    expect(html).toContain('href="https://staging.example.com/app?x=1"')
  })

  it('leave code that only starts with a URL as plain code', () => {
    const html = render('Run `https://example.com --flag` and `curl https://example.com`')
    expect(html).not.toContain('href="https://example.com')
  })

  it('leave non-web schemes as plain code', () => {
    expect(render('Open `ftp://example.com/file`')).not.toContain('href=')
  })
})
