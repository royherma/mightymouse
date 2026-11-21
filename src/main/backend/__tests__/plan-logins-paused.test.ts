import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
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
vi.mock('../../platform', () => ({ shell: { env: () => ({}) }, resolveBinary: () => null, clearBinaryCache: () => {} }))
vi.mock('../adapters', () => ({ BACKENDS: {} }))

const HOUR = 3_600_000

const login = (id: string, dir: string | null, over: Partial<PlanLogin> = {}): PlanLogin => ({
  id, backend: 'claude', email: `${id}@example.com`, plan: 'max', dir, windows: [], checkedAt: null, limitedUntil: null, ...over
})

async function freshModule(saved: PlanLogin[], picks?: object): Promise<typeof import('../plan-logins')> {
  root.dir = mkdtempSync(join(tmpdir(), 'mm-plan-paused-'))
  writeFileSync(join(root.dir, 'plan-logins.json'), JSON.stringify(saved))
  if (picks) writeFileSync(join(root.dir, 'plan-login-picks.json'), JSON.stringify(picks))
  vi.resetModules()
  return import('../plan-logins')
}

const main = login('claude-default', null)
const work = login('claude-work', '/logins/claude-work')

describe('removing the main plan login pauses it instead of deleting it', () => {
  it('keeps the main login on disk, marked paused', async () => {
    const m = await freshModule([main, work])
    const after = await m.removePlanLogin('claude-default')
    expect(after.find((l) => l.id === 'claude-default')).toMatchObject({ paused: true, dir: null })
    const onDisk = JSON.parse(readFileSync(join(root.dir, 'plan-logins.json'), 'utf-8')) as PlanLogin[]
    expect(onDisk.find((l) => l.id === 'claude-default')?.paused).toBe(true)
  })

  it('new sessions stop using a paused main login and use the next one', async () => {
    const m = await freshModule([main, work])
    await m.removePlanLogin('claude-default')
    expect(m.planLoginPicks().claude).toBe('claude-work')
    expect(m.pickedLoginEnv('claude')).toEqual({ CLAUDE_CONFIG_DIR: '/logins/claude-work' })
  })

  it('a saved pick on a paused login is ignored', async () => {
    const m = await freshModule([login('claude-default', null, { paused: true }), work], { claude: 'claude-default' })
    expect(m.planLoginPicks().claude).toBe('claude-work')
  })

  it('a run never lands on a paused login, even when it is the only one with room', async () => {
    const full = { name: 'five_hour' as const, usedPct: 100, resetsAt: Date.now() + HOUR }
    const m = await freshModule([login('claude-default', null, { paused: true }), login('claude-work', '/w', { windows: [full] })])
    expect(m.pickPlanLogin('claude')?.id).toBe('claude-work')
    expect(m.planLoginHasRoom('claude')).toBe(false)
  })

  it('with every login paused there is nothing to pick', async () => {
    const m = await freshModule([login('claude-default', null, { paused: true })])
    expect(m.pickPlanLogin('claude')).toBeNull()
    expect(m.planLoginHasRoom('claude')).toBe(false)
    expect(m.planLoginPicks().claude).toBe('')
  })

  it('removing an unknown id changes nothing', async () => {
    const m = await freshModule([main, work])
    const after = await m.removePlanLogin('nope')
    expect(after.some((l) => l.paused)).toBe(false)
  })
})

describe('parseAgyUsage', () => {
  // Verbatim `agy -p /usage` output.
  const REAL =
    'Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-27T08:22:35Z\n' +
    'Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-28T02:15:41Z\n'

  it('turns "% remaining" into % used, one window per model group', async () => {
    const m = await freshModule([])
    expect(m.parseAgyUsage(REAL)).toEqual([
      { name: 'week', usedPct: 2, resetsAt: Date.parse('2026-11-27T08:22:35Z'), label: 'Gemini' },
      { name: 'week', usedPct: 0, resetsAt: Date.parse('2026-11-28T02:15:41Z'), label: 'Claude and GPT' }
    ])
  })

  it('puts each group five-hour window before its weekly one, groups in the order agy printed them', async () => {
    const m = await freshModule([])
    const out = m.parseAgyUsage(
      'Gemini Models\tWeekly Limit Remaining\t40%\t2026-11-27T08:00:00Z\n' +
        'Claude and GPT models\tFive Hour Limit Remaining\t10%\t2026-11-21T12:00:00Z\n' +
        'Gemini Models\tFive Hour Limit Remaining\t75.4%\t2026-11-21T11:00:00Z\n'
    )
    expect(out.map((w) => `${w.label}:${w.name}:${w.usedPct}`)).toEqual([
      'Gemini:five_hour:25',
      'Gemini:week:60',
      'Claude and GPT:five_hour:90'
    ])
  })

  it('skips the banner, blank lines, and rows without a number or a date', async () => {
    const m = await freshModule([])
    expect(
      m.parseAgyUsage(
        'Fetching usage...\n\nGemini Models\tWeekly Limit Remaining\tn/a\t2026-11-27T08:00:00Z\n' +
          'Gemini Models\tWeekly Limit Remaining\t50%\tsoon\nRemaining credits\t1955\n'
      )
    ).toEqual([])
  })
})

describe('removing an Antigravity account', () => {
  it('deletes only that account folder', async () => {
    const m = await freshModule([])
    const accounts = join(root.dir, 'antigravity-accounts')
    mkdirSync(join(accounts, 'abc1'), { recursive: true })
    mkdirSync(join(accounts, 'keep2'), { recursive: true })
    await m.removeAntigravityAccount('abc1')
    expect(existsSync(join(accounts, 'abc1'))).toBe(false)
    expect(existsSync(join(accounts, 'keep2'))).toBe(true)
  })

  it('an id that climbs out of the accounts folder deletes nothing', async () => {
    const m = await freshModule([])
    mkdirSync(join(root.dir, 'antigravity-accounts'), { recursive: true })
    const victim = join(root.dir, 'victim')
    mkdirSync(victim)
    await m.removeAntigravityAccount('../victim')
    await m.removeAntigravityAccount('..')
    expect(existsSync(victim)).toBe(true)
    expect(existsSync(join(root.dir, 'antigravity-accounts'))).toBe(true)
  })

  it('the main Google account is hidden, never deleted', async () => {
    const m = await freshModule([])
    await m.removeAntigravityAccount('default')
    expect(existsSync(join(root.dir, 'antigravity-main-hidden'))).toBe(true)
  })
})
