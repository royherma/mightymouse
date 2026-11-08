import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  sent: [] as Array<Record<string, unknown>>,
  sessions: new Map<string, { staleSince?: number }>(),
  calls: [] as string[],
  pull: { url: 'https://github.com/o/r/pull/7', number: 7, state: 'open', base: 'main' } as Record<string, unknown> | null
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: () => {} } }))
vi.mock('../../store/mighty', () => ({ MIGHTY: { listProjects: () => [] } }))
vi.mock('../../phone-remote/server', () => ({ sendToPhone: (msg: Record<string, unknown>) => h.sent.push(msg) }))
vi.mock('../../phone-remote/relay-http', () => ({ transcriptMedia: () => [], transcriptSession: () => undefined }))
vi.mock('../../agent-relay/session-checklist', () => ({ readSessionChecklist: () => null }))
vi.mock('../../agent-relay/session-transcript', () => ({ readRunningHelpers: () => [], readSessionTools: () => [], readSessionTranscript: () => [] }))
vi.mock('../../agent-relay/project-ideas', () => ({ projectIdeas: async () => null }))
vi.mock('../mcp-connections', () => ({ listMcpConnections: async () => [] }))
vi.mock('../phone-remote-chat', () => ({ projectImageBase64: () => undefined }))
vi.mock('../phone-remote-share', () => ({ takeReplyImagePath: () => undefined }))
vi.mock('../agent-relay', () => ({ startCodeSession: async () => ({ ok: true }) }))
vi.mock('../../agent-relay/session-control', () => ({ resolveSessionRef: (ref: string) => h.sessions.get(ref) }))
vi.mock('../../agent-relay/repo-git', () => ({
  repoGitState: async () => {
    h.calls.push('state')
    return { branch: 'feature', dirty: 2, remoteHost: 'GitHub' }
  },
  repoGitChanges: async () => {
    h.calls.push('changes')
    return { files: [{ path: 'a', added: 3, removed: 1 }, { path: 'b', added: undefined, removed: undefined }, { path: 'c', added: 2, removed: 4 }] }
  },
  repoGitPull: async () => {
    h.calls.push('pull')
    return h.pull
  },
  repoGitOpenPull: async () => {
    h.calls.push('open')
    return { ok: true, pull: { ...h.pull, number: 8 } }
  },
  repoGitMerge: async () => {
    h.calls.push('merge')
    return { ok: false, error: 'GitHub did not merge it: checks pending' }
  }
}))

import { handleRelaySessionGit } from '../phone-remote-ai'

const send = async (msg: Record<string, unknown>): Promise<void> => handleRelaySessionGit({ type: 'relaySessionGit', ...msg } as never)

beforeEach(() => {
  h.sent = []
  h.calls = []
  h.sessions.clear()
  h.sessions.set('live', {})
  h.sessions.set('ended', { staleSince: 1 })
})

describe('handleRelaySessionGit', () => {
  it('drops an op outside status/open/merge and a missing label, touching no git', async () => {
    await send({ label: 'live', op: 'push' })
    await send({ label: 'live', op: 'reset --hard' })
    await send({ label: '  ', op: 'merge' })
    await send({ label: 42, op: 'merge' })
    expect(h.sent).toEqual([])
    expect(h.calls).toEqual([])
  })

  it('an ended session can still be read but never opens or merges a pull request', async () => {
    await send({ label: 'ended', op: 'merge' })
    await send({ label: 'ended', op: 'open' })
    expect(h.calls).toEqual([])
    expect(h.sent.map((m) => m.error)).toEqual(['This session has ended.', 'This session has ended.'])
    await send({ label: 'ended', op: 'status' })
    expect(h.calls).not.toContain('merge')
    expect(h.sent[2]).toMatchObject({ op: 'status', error: undefined })
  })

  it('an unknown session answers that it is gone', async () => {
    await send({ label: 'nope', op: 'merge' })
    expect(h.calls).toEqual([])
    expect(h.sent).toEqual([
      { type: 'relaySessionGitState', label: 'nope', op: 'merge', github: false, dirty: 0, pull: null, files: 0, added: 0, removed: 0, error: 'This session is gone.' }
    ])
  })

  it('status sums the change counts and reports the polled pull request', async () => {
    await send({ label: 'live', op: 'status' })
    expect(h.sent).toEqual([
      { type: 'relaySessionGitState', label: 'live', op: 'status', github: true, dirty: 2, pull: h.pull, files: 3, added: 5, removed: 5, error: undefined }
    ])
  })

  it('a successful open reports the pull request it made without polling again', async () => {
    await send({ label: 'live', op: 'open' })
    expect(h.calls).not.toContain('pull')
    expect(h.sent[0]).toMatchObject({ op: 'open', pull: { number: 8 }, error: undefined })
  })

  it('a refused merge passes the reason back alongside the current pull request', async () => {
    await send({ label: 'live', op: 'merge' })
    expect(h.calls[0]).toBe('merge')
    expect(h.sent[0]).toMatchObject({ op: 'merge', pull: h.pull, error: 'GitHub did not merge it: checks pending' })
  })
})
