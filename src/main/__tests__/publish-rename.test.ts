import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ repoFolder: '' }))

vi.mock('../supabase', () => ({
  getSupabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) } })
}))
vi.mock('../store/mighty', () => ({
  MIGHTY: { getProject: () => ({ name: 'My Shop', repoFolder: h.repoFolder }) }
}))

import { publishSite } from '../publish'

type Call = { method: string; url: string; body: Record<string, unknown> | null }

let calls: Call[]
let publishReply: { status: number; body: Record<string, unknown> }

beforeEach(() => {
  h.repoFolder = mkdtempSync(join(tmpdir(), 'mm-publish-'))
  writeFileSync(join(h.repoFolder, 'index.html'), '<h1>hi</h1>')
  mkdirSync(join(h.repoFolder, '.mightymouse'))
  writeFileSync(
    join(h.repoFolder, '.mightymouse/site.json'),
    JSON.stringify({ name: 'old-shop', url: 'https://old-shop.mightymouse.app', publishedAt: '', files: 1, folder: '' })
  )
  calls = []
  publishReply = {
    status: 200,
    body: { url: 'https://new-shop.mightymouse.app', uploadUrl: 'https://sites.test/new-shop', token: 't' }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
      calls.push({ method: init?.method ?? 'GET', url, body })
      if (body?.action === 'publish') return Response.json(publishReply.body, { status: publishReply.status })
      return Response.json({ ok: true })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(h.repoFolder, { recursive: true, force: true })
})

const unpublished = (): string[] =>
  calls.filter((c) => c.body?.action === 'unpublish').map((c) => String(c.body?.name))

describe('renaming a published site', () => {
  it('keeps the old address online when the new name is refused', async () => {
    publishReply = { status: 409, body: { error: 'name_taken', message: 'That address is taken. Try another one.' } }
    const result = await publishSite('p1', 'new-shop', () => {})
    expect(result.error).toBe('That address is taken. Try another one.')
    expect(unpublished()).toEqual([])
    expect(JSON.parse(readFileSync(join(h.repoFolder, '.mightymouse/site.json'), 'utf8')).name).toBe('old-shop')
  })

  it('takes the old address down only after the new site has uploaded', async () => {
    const result = await publishSite('p1', 'new-shop', () => {})
    expect(result.error).toBeUndefined()
    const lastPut = calls.map((c) => c.method).lastIndexOf('PUT')
    const unpublishAt = calls.findIndex((c) => c.body?.action === 'unpublish')
    expect(lastPut).toBeGreaterThan(-1)
    expect(unpublishAt).toBeGreaterThan(lastPut)
    expect(unpublished()).toEqual(['old-shop'])
    expect(result.site?.name).toBe('new-shop')
  })
})
