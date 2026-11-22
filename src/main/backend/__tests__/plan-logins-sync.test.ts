import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
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

const RELAY = { command: 'npx', args: ['-y', 'mightymouse-code'] }

interface Setup {
  m: typeof import('../plan-logins')
  dir: string
  home: string
}

async function setup(main: object | null, mine?: object | string): Promise<Setup> {
  root.dir = mkdtempSync(join(tmpdir(), 'mm-plan-sync-'))
  const home = mkdtempSync(join(tmpdir(), 'mm-plan-sync-home-'))
  vi.stubEnv('HOME', home)
  if (main) writeFileSync(join(home, '.claude.json'), JSON.stringify(main))
  const dir = join(root.dir, 'plan-logins', 'claude-2')
  mkdirSync(dir, { recursive: true })
  if (mine !== undefined) writeFileSync(join(dir, '.claude.json'), typeof mine === 'string' ? mine : JSON.stringify(mine))
  writeFileSync(join(root.dir, 'plan-logins.json'), JSON.stringify([]))
  vi.resetModules()
  return { m: await import('../plan-logins'), dir, home }
}

const readMine = (dir: string): Record<string, any> => JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf-8'))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('syncClaudeLogin copies the main login setup into a second Claude login', () => {
  it('copies answered first-run flags but never the account, subscription or object-valued state', async () => {
    const { m, dir } = await setup({
      theme: 'dark',
      hasSeenTasksHint: true,
      claudeInChromeDefaultEnabled: false,
      tipsDismissed: true,
      lastReleaseNotesSeen: '2.1.0',
      hasAvailableSubscription: true,
      hasOpusPlanDefault: true,
      userID: 'main-user',
      oauthAccount: { emailAddress: 'main@example.com' },
      hasShownSomething: { nested: true },
      numStartups: 40
    }, { userID: 'second-user', oauthAccount: { emailAddress: 'second@example.com' } })
    m.syncClaudeLogin(dir)
    expect(readMine(dir)).toEqual({
      theme: 'dark',
      hasSeenTasksHint: true,
      claudeInChromeDefaultEnabled: false,
      tipsDismissed: true,
      lastReleaseNotesSeen: '2.1.0',
      userID: 'second-user',
      oauthAccount: { emailAddress: 'second@example.com' },
      hasCompletedOnboarding: true
    })
  })

  it("keeps the second login's own answers over the main login's", async () => {
    const { m, dir } = await setup({ theme: 'dark', hasSeenTasksHint: true }, { theme: 'light', hasSeenTasksHint: false })
    m.syncClaudeLogin(dir)
    expect(readMine(dir)).toMatchObject({ theme: 'light', hasSeenTasksHint: false, hasCompletedOnboarding: true })
  })

  it('marks a brand-new login set up even when the main login has no config file', async () => {
    const { m, dir } = await setup(null)
    m.syncClaudeLogin(dir)
    expect(readMine(dir)).toEqual({ hasCompletedOnboarding: true })
  })

  it("adds the main login's MCP servers, keeps the login's own, and always mirrors mightymouse-code from main", async () => {
    const { m, dir } = await setup(
      { mcpServers: { 'mightymouse-code': RELAY, github: { command: 'gh-mcp' }, shared: { command: 'main-shared' } } },
      { mcpServers: { 'mightymouse-code': { command: 'old-relay' }, own: { command: 'own' }, shared: { command: 'mine-shared' } } }
    )
    m.syncClaudeLogin(dir)
    expect(readMine(dir).mcpServers).toEqual({
      'mightymouse-code': RELAY,
      github: { command: 'gh-mcp' },
      own: { command: 'own' },
      shared: { command: 'mine-shared' }
    })
  })

  it('drops mightymouse-code from the second login when the main login no longer has it', async () => {
    const { m, dir } = await setup(
      { mcpServers: { github: { command: 'gh-mcp' } } },
      { mcpServers: { 'mightymouse-code': RELAY, own: { command: 'own' } } }
    )
    m.syncClaudeLogin(dir)
    expect(readMine(dir).mcpServers).toEqual({ github: { command: 'gh-mcp' }, own: { command: 'own' } })
  })

  it('trusts the project folder and merges its MCP lists when the main login trusts it', async () => {
    const cwd = '/Users/me/project'
    const { m, dir } = await setup(
      {
        projects: {
          [cwd]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            allowedTools: ['Bash'],
            mcpServers: { local: { command: 'local' } },
            enabledMcpjsonServers: ['a', 'b'],
            disabledMcpjsonServers: ['z']
          },
          '/Users/me/other': { hasTrustDialogAccepted: true }
        }
      },
      { projects: { [cwd]: { hasTrustDialogAccepted: false, enabledMcpjsonServers: ['b', 'c'] } } }
    )
    m.syncClaudeLogin(dir, cwd)
    const projects = readMine(dir).projects
    expect(Object.keys(projects)).toEqual([cwd])
    expect(projects[cwd]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      mcpServers: { local: { command: 'local' } },
      enabledMcpjsonServers: ['b', 'c', 'a'],
      disabledMcpjsonServers: ['z']
    })
  })

  it('leaves the project untrusted when the main login never trusted it', async () => {
    const cwd = '/Users/me/project'
    const { m, dir } = await setup({ projects: { [cwd]: { hasTrustDialogAccepted: false } } }, { projects: { [cwd]: {} } })
    m.syncClaudeLogin(dir, cwd)
    expect(readMine(dir).projects[cwd].hasTrustDialogAccepted).toBe(false)
  })

  it('never writes outside the plan-logins folder (the main login itself is ~/.claude)', async () => {
    const { m, home } = await setup({ theme: 'dark' })
    const outside = join(home, '.claude')
    mkdirSync(outside)
    m.syncClaudeLogin(outside)
    m.syncClaudeLogin(join(root.dir, 'plan-logins'))
    expect(existsSync(join(outside, '.claude.json'))).toBe(false)
    expect(existsSync(join(root.dir, 'plan-logins', '.claude.json'))).toBe(false)
  })

  it('leaves an unreadable login config alone instead of overwriting it', async () => {
    const { m, dir } = await setup({ theme: 'dark' }, '{ not json')
    m.syncClaudeLogin(dir)
    expect(readFileSync(join(dir, '.claude.json'), 'utf-8')).toBe('{ not json')
  })

  it('writes the file private (0600) and leaves no temp file behind', async () => {
    const { m, dir } = await setup({ theme: 'dark' })
    m.syncClaudeLogin(dir)
    expect(statSync(join(dir, '.claude.json')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['.claude.json'])
  })

  it('a launch on the second login carries the folder trust for the launch folder', async () => {
    const cwd = '/Users/me/project'
    const { dir } = await setup({ projects: { [cwd]: { hasTrustDialogAccepted: true } } })
    const login: PlanLogin = { id: 'claude-2', backend: 'claude', email: 'b@example.com', plan: 'max', dir, windows: [], checkedAt: null, limitedUntil: null }
    writeFileSync(join(root.dir, 'plan-logins.json'), JSON.stringify([login]))
    writeFileSync(join(root.dir, 'plan-login-picks.json'), JSON.stringify({ claude: 'claude-2' }))
    vi.resetModules()
    const m = await import('../plan-logins')
    expect(m.pickedLoginEnv('claude', cwd)).toEqual({ CLAUDE_CONFIG_DIR: dir })
    expect(readMine(dir).projects[cwd].hasTrustDialogAccepted).toBe(true)
  })
})
