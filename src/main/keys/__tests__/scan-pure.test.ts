import { describe, it, expect } from 'vitest'
import {
  extractNeedsFromSource,
  hasFallbackNear,
  isPassThroughAssignment,
  isTestPath,
  walkFiles,
  WRANGLER_CONFIG_RE
} from '../scan-pure'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('isTestPath', () => {
  it('flags test files and spares source', () => {
    expect(isTestPath('src/main/audio/__tests__/tts-kokoro.test.ts')).toBe(true)
    expect(isTestPath('src/foo.spec.tsx')).toBe(true)
    expect(isTestPath('src/main/audio/tts.ts')).toBe(false)
    expect(isTestPath('src/latest.ts')).toBe(false)
  })
})

describe('hasFallbackNear', () => {
  it('sees a nullish default and a bail-out guard', () => {
    expect(hasFallbackNear(["const k = process.env.X ?? ''"], 0)).toBe(true)
    expect(hasFallbackNear(['const t = Deno.env.get("X")', 'if (!t) return null'], 0)).toBe(true)
  })

  it('does not fire on a hard requirement', () => {
    expect(hasFallbackNear(['const k = process.env.X', 'send(k)', 'done()'], 0)).toBe(false)
  })
})

describe('WRANGLER_CONFIG_RE', () => {
  it('takes every wrangler config spelling', () => {
    for (const name of [
      'wrangler.toml',
      'wrangler.json',
      'wrangler.jsonc',
      'wrangler.staging.json',
      'wrangler.production.json'
    ])
      expect(WRANGLER_CONFIG_RE.test(name)).toBe(true)
  })

  it('leaves look-alikes alone', () => {
    for (const name of ['wrangler.json.bak', 'my-wrangler.json', 'wrangler.d.ts', 'wrangler.yaml'])
      expect(WRANGLER_CONFIG_RE.test(name)).toBe(false)
  })
})

describe('isPassThroughAssignment', () => {
  it('sees a value handed straight to another object', () => {
    expect(isPassThroughAssignment('  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,')).toBe(true)
    expect(isPassThroughAssignment('    VITE_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN,')).toBe(
      true
    )
    expect(isPassThroughAssignment('  token: Deno.env.get("ACME_API_KEY")')).toBe(true)
  })

  it('leaves a real use alone', () => {
    expect(isPassThroughAssignment('send(process.env.ACME_API_KEY)')).toBe(false)
    expect(isPassThroughAssignment('const key = process.env.ACME_API_KEY')).toBe(false)
    expect(isPassThroughAssignment('  dsn: process.env.ACME_API_KEY.trim(),')).toBe(false)
  })
})

describe('extractNeedsFromSource', () => {
  it('marks a pass-through property optional', () => {
    const [need] = extractNeedsFromSource(
      'apps/mobile/app.config.ts',
      '  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,'
    )
    expect(need.optional).toBe(true)
  })

  it('still requires a name that is used directly somewhere', () => {
    const needs = extractNeedsFromSource(
      'src/a.ts',
      ['  dsn: process.env.ACME_API_KEY,', 'connect(process.env.ACME_API_KEY)'].join('\n')
    )
    expect(needs.map((n) => n.optional)).toEqual([true, false])
  })

  it('marks a fallback site optional and a bare site required', () => {
    const [opt] = extractNeedsFromSource('src/a.ts', "const k = process.env.ACME_API_KEY ?? ''")
    expect(opt.optional).toBe(true)
    const [req] = extractNeedsFromSource('src/b.ts', 'send(process.env.ACME_API_KEY)')
    expect(req.optional).toBe(false)
  })

  it('carries the test flag through from the path', () => {
    const [need] = extractNeedsFromSource('src/__tests__/a.test.ts', 'process.env.ACME_API_KEY')
    expect(need.isTest).toBe(true)
  })

  it('ignores names that are not secrets', () => {
    expect(extractNeedsFromSource('src/a.ts', 'process.env.NODE_ENV')).toHaveLength(0)
  })
})

describe('walkFiles', () => {
  it('skips build output and nested worktree checkouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-pure-'))
    for (const dir of ['src', '.next', join('.claude', 'worktrees')]) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'a.ts'), 'process.env.ACME_API_KEY')
    }
    const found = walkFiles(root, (n) => n.endsWith('.ts')).map((f) => f.replace(root, ''))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('src')
  })
})
