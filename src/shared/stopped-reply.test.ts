import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('stopped-reply mirror', () => {
  it('the edge copy the web chat imports matches the app copy byte for byte', () => {
    const app = readFileSync(join(__dirname, 'stopped-reply.ts'), 'utf8')
    const edge = readFileSync(join(__dirname, '../../supabase/functions/_shared/stopped-reply.ts'), 'utf8')
    expect(edge).toBe(app)
  })
})
