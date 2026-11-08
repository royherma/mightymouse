import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  copied: '',
  captures: 0,
  calls: [] as [string, string][],
  result: { ok: true } as { ok: boolean; reason?: string }
}))

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: { getAppPath: () => '/tmp' } }))
vi.mock('../../platform', () => ({
  input: {},
  captureSelection: async () => (h.captures++, h.copied)
}))
vi.mock('../../fast-rewrite', () => ({
  runFastRewriteAndPaste: async (instruction: string, selection: string) => (h.calls.push([instruction, selection]), h.result),
  fastRewriteErrorText: (r: { reason: string }) => `failed: ${r.reason}`
}))

const { inputCapability } = await import('../capabilities/input')

async function rewrite(transcript: string, selection: string) {
  const actions = await inputCapability.listActions({ bundleId: 'com.x' } as never)
  const action = actions.find((a) => a.id === 'input.rewrite')!
  return action.run({ slots: {}, transcript, selection, trigger: 'voice' })
}

beforeEach(() => {
  h.copied = ''
  h.captures = 0
  h.calls = []
  h.result = { ok: true }
})

describe('input.rewrite', () => {
  it('rewrites the selection it was handed without copying again', async () => {
    expect(await rewrite('  make it shorter ', 'long text')).toEqual({ ok: true, line: 'Rewrote the selected text.' })
    expect(h.calls).toEqual([['make it shorter', 'long text']])
    expect(h.captures).toBe(0)
  })

  it('copies the selection itself when the app hid it', async () => {
    h.copied = 'hidden text'
    await rewrite('fix typos', '   ')
    expect(h.captures).toBe(1)
    expect(h.calls).toEqual([['fix typos', 'hidden text']])
  })

  it('asks for a selection when there is none anywhere', async () => {
    const r = await rewrite('fix typos', '')
    expect(r.ok).toBe(false)
    expect(r.line).toMatch(/Select the text/)
    expect(h.calls).toEqual([])
  })

  it('refuses an empty instruction', async () => {
    const r = await rewrite('   ', 'text')
    expect(r.ok).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('passes the rewrite failure through as the card line', async () => {
    h.result = { ok: false, reason: 'signed_out' }
    expect(await rewrite('shorter', 'text')).toEqual({ ok: false, line: 'failed: signed_out' })
  })

  it('is offered even with no front app', async () => {
    const actions = await inputCapability.listActions({ bundleId: '' } as never)
    expect(actions.map((a) => a.id)).toContain('input.rewrite')
  })
})
