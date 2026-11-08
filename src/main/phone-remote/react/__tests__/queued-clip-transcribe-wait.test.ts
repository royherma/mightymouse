import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('use-dictation arms transcribe wait for live native clips', () => {
  it('sendQueuedClip registers in-flight like sendClip, not for macAway drains', () => {
    const src = readFileSync(resolve(__dirname, '../hooks/use-dictation.ts'), 'utf8')
    const start = src.indexOf('const sendQueuedClip')
    const end = src.indexOf('subscribeNativeIntent', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const queued = src.slice(start, end)
    expect(queued).toMatch(/armClipInFlight/)
    expect(queued).toMatch(/clip\.macAway !== true/)
    expect(src).toMatch(/const armClipInFlight = useCallback/)
  })
})
