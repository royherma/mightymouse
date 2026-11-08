import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractNeedsFromSource, findEnvFiles, scanRepoNeeds, walkFiles, walkFilesAsync } from '../scan-pure'

const need = (path: string, line: string): boolean | undefined => extractNeedsFromSource(path, line)[0]?.optional

describe('extractNeedsFromSource optional rules', () => {
  it('treats a key read by a dev script as optional', () => {
    expect(need('scripts/seed.ts', 'send(process.env.ACME_API_KEY)')).toBe(true)
    expect(need('tools/bin/run.mjs', 'send(process.env.ACME_API_KEY)')).toBe(true)
  })

  it('treats a client-bundle public key as optional', () => {
    for (const name of ['VITE_ACME_API_KEY', 'EXPO_PUBLIC_ACME_API_KEY', 'NEXT_PUBLIC_ACME_API_KEY']) {
      expect(need('src/app.ts', `send(process.env.${name})`)).toBe(true)
    }
  })

  it('still requires the same key read by app code', () => {
    expect(need('src/server.ts', 'send(process.env.ACME_API_KEY)')).toBe(false)
    expect(need('src/scripts-helper.ts', 'send(process.env.ACME_API_KEY)')).toBe(false)
    expect(need('src/app.ts', 'send(process.env.MY_VITE_ACME_API_KEY)')).toBe(false)
  })
})

describe('async repo walk', () => {
  const root = mkdtempSync(join(tmpdir(), 'mm-scan-async-'))
  mkdirSync(join(root, 'a', 'b'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(root, '.scratch-local'), { recursive: true })
  writeFileSync(join(root, '.env'), '')
  writeFileSync(join(root, '.env.example'), '')
  writeFileSync(join(root, 'a', '.dev.vars'), '')
  writeFileSync(join(root, 'a', 'b', 'x.ts'), 'send(process.env.ACME_API_KEY)')
  writeFileSync(join(root, 'node_modules', 'x', 'y.ts'), 'send(process.env.LEAKED_API_KEY)')
  writeFileSync(join(root, '.scratch-local', 'staging.env'), '')

  it('finds the same files the sync walk did, sorted', async () => {
    const match = (n: string): boolean => n.endsWith('.ts') || n.startsWith('.env')
    const got = await walkFilesAsync(root, match)
    expect(got).toEqual([...walkFiles(root, match)].sort())
    expect(got).toEqual([...got].sort())
  })

  it('stops at the depth limit', async () => {
    expect(await walkFilesAsync(root, (n) => n.endsWith('.ts'), 1)).toEqual([])
    expect(await walkFilesAsync(root, (n) => n.endsWith('.ts'), 2)).toEqual([join(root, 'a', 'b', 'x.ts')])
  })

  it('returns nothing for a folder that does not exist', async () => {
    expect(await walkFilesAsync(join(root, 'missing'), () => true)).toEqual([])
  })

  it('finds env files but skips examples, and includes .scratch-local envs', async () => {
    expect((await findEnvFiles(root)).sort()).toEqual(
      [join(root, '.env'), join(root, '.scratch-local', 'staging.env'), join(root, 'a', '.dev.vars')].sort()
    )
  })

  it('scans source for needs with repo-relative paths, never node_modules', async () => {
    const needs = await scanRepoNeeds(root)
    expect(needs.map((n) => [n.name, n.file])).toEqual([['ACME_API_KEY', join('a', 'b', 'x.ts')]])
  })
})
