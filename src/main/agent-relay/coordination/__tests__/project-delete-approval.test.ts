import { expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoordinationService } from '../service'
import { relayRequestStore } from '../../store'
it('refuses a delete without a real approval', () => {
  const svc = new CoordinationService(mkdtempSync(join(tmpdir(), 'gate-')))
  svc.setEnabled(true)
  const bad = (approval: string): string => {
    try { svc.execute('project_delete', { project: 'p1', approval }, 'nottoken'); return 'ALLOWED' }
    catch (e) { return (e as Error).message }
  }
  expect(bad('invented-id')).toContain('approve this removal first')

  const pending = relayRequestStore.mint('approve', { title: 'Delete p1', body: 'p1' })
  expect(bad(pending.id)).toContain('approve this removal first')

  relayRequestStore.resolve(pending.id, { approved: false }, 'test')
  expect(bad(pending.id)).toContain('did not approve')

  const other = relayRequestStore.mint('approve', { title: 'Delete something-else', body: 'zzz' })
  relayRequestStore.resolve(other.id, { approved: true }, 'test')
  expect(bad(other.id)).toContain('given for something else')
  svc.close()
})
