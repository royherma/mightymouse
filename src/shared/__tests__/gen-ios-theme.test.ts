import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error -- plain .mjs generator, no types; exercised for its parsers.
import * as gen from '../../../scripts/gen-ios-theme.mjs'
import { CONFIG } from '../config'

// The generator turns CSS token strings into Swift literals. A mis-parse renders
// black or silently drops a token, which looks like a design choice rather than a
// broken build -- so the parsers are tested against known-good values taken from
// config.ts by hand, and the emitter is checked for completeness.

describe('parseRgba', () => {
  it('parses the brand accent to normalised components', () => {
    // The whole point of this pipeline: the native shell used system .orange
    // (255,149,0) where the brand accent is 255,160,80.
    expect(gen.parseRgba('rgba(255, 160, 80, 1.00)')).toEqual({
      r: 1,
      g: 160 / 255,
      b: 80 / 255,
      a: 1
    })
  })

  it('keeps fractional alpha', () => {
    expect(gen.parseRgba('rgba(245, 244, 242, 0.96)')?.a).toBe(0.96)
  })

  it('returns null for a multi-layer shadow string', () => {
    // Must not be mistaken for a color -- these route to the shadow comments.
    expect(gen.parseRgba('0 28px 70px rgba(28, 26, 24, 0.14)')).toBeNull()
  })

  it('throws on an out-of-range component rather than clamping', () => {
    expect(() => gen.parseRgba('rgba(300, 0, 0, 1.0)')).toThrow(/out of range/)
  })
})

describe('parsePx / parseTriplet', () => {
  it('parses a px literal', () => {
    expect(gen.parsePx('14px')).toBe(14)
  })

  it('rejects a shadow string that merely contains px', () => {
    expect(gen.parsePx('0 28px 70px rgba(28, 26, 24, 0.14)')).toBeNull()
  })

  it('parses a bare rgb triplet', () => {
    expect(gen.parseTriplet('255, 160, 80')).toEqual([255, 160, 80])
  })
})

describe('token extraction', () => {
  const tokens = gen.parseTokens(
    gen.extractTokenBlock(readFileSync('src/shared/config/theme-tokens.ts', 'utf8'))
  )

  it('finds every token that CONFIG actually exposes', () => {
    // Guards the brace-matcher: a regex that stopped at the first `}` would
    // silently truncate the block and drop the tail of the palette.
    const expected = Object.keys(CONFIG.THEME_TOKENS).sort()
    expect(Object.keys(tokens).sort()).toEqual(expected)
  })

  it('agrees with CONFIG on values, so the text slice is not lossy', () => {
    for (const [key, value] of Object.entries(CONFIG.THEME_TOKENS)) {
      expect(tokens[key], key).toBe(value)
    }
  })

  it('classifies every token into exactly one namespace', () => {
    const c = gen.classify(tokens)
    const total =
      Object.keys(c.colors).length +
      Object.keys(c.spacing).length +
      Object.keys(c.radius).length +
      Object.keys(c.fonts).length +
      Object.keys(c.triplets).length +
      Object.keys(c.shadows).length
    expect(total).toBe(Object.keys(tokens).length)
  })
})

describe('emitSwift', () => {
  const swift = gen.emitSwift(
    gen.parseTokens(gen.extractTokenBlock(readFileSync('src/shared/config/theme-tokens.ts', 'utf8')))
  )

  it('emits the accent as the brand orange, not system orange', () => {
    expect(swift).toContain(
      'static let accent = Color(.sRGB, red: 0.760784, green: 0.313725, blue: 0.101961, opacity: 1.0)'
    )
  })

  it('emits all five namespaces', () => {
    for (const ns of ['enum MMColor', 'enum MMSpace', 'enum MMRadius', 'enum MMFont', 'enum MMRgb']) {
      expect(swift).toContain(ns)
    }
  })

  it('strips the scale prefix so call sites read MMRadius.md', () => {
    expect(swift).toContain('static let md: CGFloat = 10.0')
  })

  it('emits only legal Swift identifiers', () => {
    // Caught a real bug: stripping the prefix off `space1` left `1`, and
    // `static let 1: CGFloat` does not compile. The generated file was never
    // fed to a compiler, so the 15 passing tests all passed on broken output.
    const names = [...swift.matchAll(/static let ([^:\s]+)\s*[:=]/g)].map((m) => m[1])
    expect(names.length).toBeGreaterThan(70)
    for (const name of names) {
      expect(name, `illegal Swift identifier: ${name}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }
  })

  it('names the spacing scale in words, not digits', () => {
    expect(swift).toContain('static let four: CGFloat = 16.0')
    expect(swift).not.toMatch(/static let \d/)
  })

  it('never emits a raw CSS string as a Swift value', () => {
    // Shadow strings are reference comments only; one leaking into a `static let`
    // would not compile.
    const assignments = swift.split('\n').filter((l) => l.includes('static let'))
    for (const line of assignments) {
      expect(line, line).not.toMatch(/static let \w+ = '/)
      expect(line, line).not.toMatch(/px/)
    }
  })

  it('matches the checked-in Theme.swift (drift gate)', () => {
    // The same assertion `gen-ios-theme.mjs --check` makes in `make gate`,
    // duplicated here so a plain `vitest run` catches the drift too.
    const onDisk = readFileSync('ios/MightyMouse/Generated/Theme.swift', 'utf8')
    expect(onDisk).toBe(swift)
  })
})
