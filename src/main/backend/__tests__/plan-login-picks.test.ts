import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PlanLogin } from '../../../shared/plan-logins'

const root = vi.hoisted(() => ({ dir: '' }))

vi.mock('../../store/paths', () => ({
  PATHS: {
    get ROOT() {
      return root.dir
    }
  }
}))
vi.mock('../../platform', () => ({ shell: { env: () => ({}) } }))
vi.mock('../adapters', () => ({ BACKENDS: {} }))

const login = (id: string, backend: 'claude' | 'codex', dir: string | null): PlanLogin => ({
  id, backend, email: `${id}@example.com`, plan: 'max', dir, windows: [], checkedAt: null, limitedUntil: null
})

async function freshModule(saved: PlanLogin[], picks?: object): Promise<typeof import('../plan-logins')> {
  root.dir = mkdtempSync(join(tmpdir(), 'mm-plan-picks-'))
  writeFileSync(join(root.dir, 'plan-logins.json'), JSON.stringify(saved))
  if (picks) writeFileSync(join(root.dir, 'plan-login-picks.json'), JSON.stringify(picks))
  vi.resetModules()
  return import('../plan-logins')
}

const work = login('claude-work', 'claude', '/logins/claude-work')
const side = login('codex-side', 'codex', '/logins/codex-side')

describe('plan login picks', () => {
  beforeEach(() => {
    root.dir = ''
  })

  it('defaults each backend to its default-home login when nothing was picked', async () => {
    const m = await freshModule([work, side])
    expect(m.planLoginPicks()).toEqual({ claude: 'claude-default', codex: 'codex-default' })
    expect(m.pickedLoginEnv('claude')).toEqual({})
  })

  it('a saved pick wins and its config dir goes into the new session env', async () => {
    const m = await freshModule([work, side], { claude: 'claude-work', codex: 'codex-side' })
    expect(m.planLoginPicks()).toEqual({ claude: 'claude-work', codex: 'codex-side' })
    expect(m.pickedLoginEnv('claude')).toEqual({ CLAUDE_CONFIG_DIR: '/logins/claude-work' })
    expect(m.pickedLoginEnv('codex')).toEqual({ CODEX_HOME: '/logins/codex-side' })
  })

  it('falls back to the default login once the picked one was removed', async () => {
    const m = await freshModule([side], { claude: 'claude-work' })
    expect(m.planLoginPicks().claude).toBe('claude-default')
    expect(m.pickedLoginEnv('claude')).toEqual({})
  })

  it('setPlanLoginPick saves a real login and keeps the other backend pick', async () => {
    const m = await freshModule([work, side], { codex: 'codex-side' })
    expect(m.setPlanLoginPick('claude', 'claude-work')).toEqual({ claude: 'claude-work', codex: 'codex-side' })
    expect(m.pickedLoginEnv('claude')).toEqual({ CLAUDE_CONFIG_DIR: '/logins/claude-work' })
  })

  it('refuses a pick that belongs to the other backend or does not exist', async () => {
    const m = await freshModule([work, side])
    expect(m.setPlanLoginPick('claude', 'codex-side').claude).toBe('claude-default')
    expect(m.setPlanLoginPick('codex', 'nope').codex).toBe('codex-default')
    expect(existsSync(join(root.dir, 'plan-login-picks.json'))).toBe(false)
  })

  it('a corrupt picks file reads as no picks', async () => {
    const m = await freshModule([work])
    writeFileSync(join(root.dir, 'plan-login-picks.json'), '{not json')
    expect(m.planLoginPicks().claude).toBe('claude-default')
  })

  it('a harness that is not a plan backend gets no login env', async () => {
    const m = await freshModule([work], { claude: 'claude-work' })
    expect(m.pickedLoginEnv('opencode')).toEqual({})
    expect(m.pickedLoginEnv('cursor')).toEqual({})
  })
})
