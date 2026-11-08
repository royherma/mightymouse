import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, app: { getAppPath: () => '/tmp' } }))

describe('input capability', () => {
  it('lists the new verbs', async () => {
    const { inputCapability } = await import('../capabilities/input')
    const ctx = {
      frontApp: 'Google Chrome', bundleId: 'com.google.Chrome', windowTitle: 'Inbox',
      urlHost: 'mail.google.com', hasSelection: false, selectionText: '',
      selectionKind: 'none' as const, recentApps: [], recentActionIds: []
    }
    const actions = await inputCapability.listActions(ctx)
    const shape = actions.map((a) => ({
      id: a.id,
      safety: a.safety,
      slots: a.slots.map((s) => `${s.kind}:${s.key}${s.kind === 'choice' ? `(${s.options.length})` : ''}`)
    }))
    expect(shape).toEqual([
      { id: 'input.type', safety: 'safe', slots: ['transcript:text'] },
      { id: 'input.rewrite', safety: 'safe', slots: ['transcript:instruction'] },
      { id: 'input.key', safety: 'safe', slots: ['choice:combo(16)'] },
      { id: 'input.keyRisky', safety: 'confirm', slots: ['choice:combo(3)'] },
      { id: 'input.scroll', safety: 'safe', slots: ['choice:direction(6)'] },
      { id: 'input.navigate', safety: 'safe', slots: ['choice:site(12)'] }
    ])
    expect(actions.map((a) => a.id)).toEqual([
      'input.type', 'input.rewrite', 'input.key', 'input.keyRisky', 'input.scroll', 'input.navigate'
    ])
    expect(actions.every((a) => !a.triggers.includes('idle'))).toBe(true)
  })
})
