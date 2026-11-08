/**
 * Does relay history survive a Mac restart?
 *
 * The request Map is memory-only, so every restart used to wipe it and the
 * phone's Previous/Cleared tabs came back permanently empty. History is now
 * read back from the append-only audit log. A "restart" here is
 * `vi.resetModules()` + a fresh import of the store: the module-level singleton
 * is rebuilt exactly as it is on a real relaunch, while the temp audit log on
 * disk persists across it -- which is the whole thing under test.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync, writeFileSync } from 'fs'

const TEST_ROOT = join(tmpdir(), 'mm-relay-history-restore-test')
const LOG_PATH = join(TEST_ROOT, 'agent-relay-log.jsonl')

vi.mock('../../store/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/paths')>()
  const { join: j } = await import('path')
  const { tmpdir: t } = await import('os')
  const root = j(t(), 'mm-relay-history-restore-test')
  return {
    ...actual,
    PATHS: { ...actual.PATHS, ROOT: root, AGENT_RELAY_LOG: j(root, 'agent-relay-log.jsonl') }
  }
})

vi.mock('../../analytics', () => ({ track: () => {} }))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() }
}))

/** One audit row as the store writes them. `ts` is a parameter because the
 *  restore drops anything past RELAY_RETENTION_MS, which is its own test. */
function auditRow(over: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    requestId: 'req-1',
    verb: 'ask',
    params: { question: 'restored?' },
    event: 'resolved',
    response: { answer: 'yes' },
    deviceId: null,
    via: 'typed',
    ...over
  })
}

/** Boot a brand-new store singleton against the audit log currently on disk --
 *  the module-graph equivalent of relaunching the Mac app. */
async function restart(): Promise<typeof import('../store')> {
  vi.resetModules()
  return await import('../store')
}

describe('relay history survives a restart', () => {
  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true })
    rmSync(LOG_PATH, { force: true })
  })

  afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }))

  it('restores a resolved ask written by a previous process', async () => {
    writeFileSync(LOG_PATH, auditRow({}) + '\n', 'utf-8')

    const { relayRequestStore } = await restart()
    const resolved = relayRequestStore.listRecentResolved(20)

    expect(resolved.length, 'the logged ask must come back').toBe(1)
    expect(resolved[0].id).toBe('req-1')
    expect(resolved[0].verb).toBe('ask')
    expect(resolved[0].params.question).toBe('restored?')
    expect(resolved[0].response).toEqual({ answer: 'yes' })
  })

  it('routes a dismissed row to Cleared, not Previous', async () => {
    writeFileSync(LOG_PATH, auditRow({ requestId: 'req-2', event: 'dismissed' }) + '\n', 'utf-8')

    const { relayRequestStore } = await restart()

    expect(relayRequestStore.listDismissed(20).map((r) => r.id)).toEqual(['req-2'])
    expect(relayRequestStore.listRecentResolved(20)).toEqual([])
  })

  it('takes the LAST terminal row for an id, so an undo-then-answer wins', async () => {
    writeFileSync(
      LOG_PATH,
      [auditRow({ event: 'dismissed' }), auditRow({ event: 'resolved' })].join('\n') + '\n',
      'utf-8'
    )

    const { relayRequestStore } = await restart()

    expect(relayRequestStore.listRecentResolved(20).map((r) => r.id)).toEqual(['req-1'])
    expect(relayRequestStore.listDismissed(20), 'the earlier dismiss must not linger').toEqual([])
  })

  it('does NOT restore a still-pending request', async () => {
    // Its agent died with the old process, so a card for it could never be
    // answered -- showing one would be a lie about what is still reachable.
    writeFileSync(LOG_PATH, auditRow({ event: 'created', response: null }) + '\n', 'utf-8')

    const { relayRequestStore } = await restart()

    expect(relayRequestStore.listPending()).toEqual([])
    expect(relayRequestStore.listRecentResolved(20)).toEqual([])
  })

  it('drops rows older than the retention window', async () => {
    const { RELAY_RETENTION_MS } = await import('../store')
    const old = new Date(Date.now() - RELAY_RETENTION_MS - 60_000).toISOString()
    writeFileSync(LOG_PATH, auditRow({ ts: old }) + '\n', 'utf-8')

    const { relayRequestStore } = await restart()

    expect(relayRequestStore.listRecentResolved(20)).toEqual([])
  })

  it('survives a corrupt line without losing the good rows around it', async () => {
    // The restore reads a byte-offset tail of an append-only file, so a partial
    // first line is the NORMAL case, not corruption -- it must never throw.
    writeFileSync(
      LOG_PATH,
      ['{"ts":"trunca', auditRow({}), 'not json at all'].join('\n') + '\n',
      'utf-8'
    )

    const { relayRequestStore } = await restart()

    expect(relayRequestStore.listRecentResolved(20).map((r) => r.id)).toEqual(['req-1'])
  })

  it('is a no-op when no audit log exists yet', async () => {
    const { relayRequestStore } = await restart()
    expect(relayRequestStore.listRecentResolved(20)).toEqual([])
  })
})
