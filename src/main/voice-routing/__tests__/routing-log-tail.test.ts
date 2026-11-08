import { afterAll, describe, expect, it, vi } from 'vitest'
import { rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const LOG = join(tmpdir(), `mm-routing-log-${process.pid}.jsonl`)

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: (...a: Parameters<typeof actual.readFileSync>) => {
      if (String(a[0]).includes('mm-routing-log-')) throw new Error('read the whole routing log')
      return actual.readFileSync(...a)
    }
  }
})
vi.mock('../../store/paths', async () => {
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  return { PATHS: { VOICE_ROUTING_LOG: j(t(), `mm-routing-log-${process.pid}.jsonl`) } }
})

import { recentPickCounts } from '../routing-log'

afterAll(() => rmSync(LOG, { force: true }))

describe('recent pick counts on a routing log that has grown for months', () => {
  it('reads only the tail and still counts the latest deliveries', () => {
    const old = JSON.stringify({ event: 'ranked', transcript: 'x'.repeat(1000) }) + '\n'
    const recent = ['claude', 'claude', 'notes']
      .map((id) => JSON.stringify({ event: 'delivered', chosenSinkId: id }) + '\n')
      .join('')
    writeFileSync(LOG, old.repeat(5000) + recent)

    expect(recentPickCounts()).toEqual({ claude: 2, notes: 1 })
  })
})
