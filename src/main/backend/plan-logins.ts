import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, sep } from 'path'
import { PATHS } from '../store/paths'
import { shell } from '../platform'
import { BACKENDS } from './adapters'
import {
  PLAN_BACKENDS,
  PLAN_LOGINS,
  isPlanLoginOpen,
  type PlanBackend,
  type PlanLogin,
  type PlanLoginPicks,
  type PlanLoginsResult,
  type PlanWindow,
  type PlanWindowName
} from '../../shared/plan-logins'

const STORE_FILE = join(PATHS.ROOT, 'plan-logins.json')
const LOGINS_DIR = join(PATHS.ROOT, 'plan-logins')
const PICKS_FILE = join(PATHS.ROOT, 'plan-login-picks.json')
const HOME_ENV: Record<PlanBackend, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
const DEFAULT_HOME: Record<PlanBackend, string> = {
  claude: join(homedir(), '.claude'),
  codex: join(homedir(), '.codex')
}
const SHARED_CONFIG: Record<PlanBackend, string[]> = {
  claude: ['CLAUDE.md', 'settings.json', 'skills', 'agents', 'commands', 'hooks', 'plugins', 'rules'],
  codex: ['config.toml', 'AGENTS.md', 'instructions.md', 'hooks.json', 'skills', 'prompts']
}
const SIGN_IN_ARGS: Record<PlanBackend, string[]> = { claude: ['auth', 'login'], codex: ['login'] }
const CLAUDE_PROBE_ARGS = ['-p', 'Reply with ok', '--model', 'haiku', '--tools', '', '--output-format', 'stream-json', '--verbose']
const LIMIT_TEXT = /usage limit|hit your (?:usage )?limit|limit reached/i
const FIVE_HOUR_MINS = 300

interface Account {
  email: string
  plan: string
  windows?: PlanWindow[]
  limitedUntil?: number | null
}

let cache: PlanLogin[] | null = null
let signingIn: ChildProcess | null = null

export const isPlanBackend = (b: string): b is PlanBackend => (PLAN_BACKENDS as readonly string[]).includes(b)

const blankLogin = (backend: PlanBackend, id: string, dir: string | null): PlanLogin => ({
  id, backend, email: '', plan: '', dir, windows: [], checkedAt: null, limitedUntil: null
})

function load(): PlanLogin[] {
  if (cache) return cache
  let saved: PlanLogin[] = []
  try {
    saved = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as PlanLogin[]
  } catch { /* no file yet: only the default logins exist */ }
  const defaults = PLAN_BACKENDS.filter((b) => !saved.some((l) => l.backend === b && l.dir === null)).map(
    (b) => blankLogin(b, `${b}-default`, null)
  )
  cache = [...defaults, ...saved]
  return cache
}

function save(next: PlanLogin[]): void {
  cache = next
  writeFileSync(STORE_FILE, JSON.stringify(next, null, 2), 'utf-8')
}

function patch(id: string, fields: Partial<PlanLogin>): void {
  save(load().map((l) => (l.id === id ? { ...l, ...fields } : l)))
}

const envFor = (l: PlanLogin): Record<string, string> => (l.dir ? { [HOME_ENV[l.backend]]: l.dir } : {})

function runCli(l: PlanLogin, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const bin = BACKENDS[l.backend].binPath ?? ''
    if (bin === '') return resolve({ code: -1, out: '' })
    const child = spawn(bin, args, { env: { ...shell.env(), ...envFor(l) }, cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', () => resolve({ code: -1, out }))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

function windowName(mins: number): PlanWindowName {
  return mins <= FIVE_HOUR_MINS ? 'five_hour' : 'week'
}

export function parseClaudeLimits(stdout: string): { windows: PlanWindow[]; rejectedUntil: number | null } | null {
  const line = stdout.split('\n').reverse().find((l) => l.includes('"rate_limit_event"'))
  if (!line) return null
  try {
    const info = JSON.parse(line).rate_limit_info
    const w = info.unifiedWindows ?? {}
    const pairs: [PlanWindowName, { utilization: number; resetsAt: number } | undefined][] = [
      ['five_hour', w.five_hour],
      ['week', w.seven_day]
    ]
    const windows = pairs.flatMap(([name, v]) =>
      v ? [{ name, usedPct: Math.round(v.utilization * 100), resetsAt: v.resetsAt * 1000 }] : []
    )
    return { windows, rejectedUntil: info.status === 'rejected' && info.resetsAt ? info.resetsAt * 1000 : null }
  } catch {
    return null
  }
}

type CodexLimit = { usedPercent: number; windowDurationMins: number; resetsAt: number } | null

function codexAccount(l: PlanLogin): Promise<Account | null> {
  return new Promise((resolve) => {
    const bin = BACKENDS.codex.binPath ?? ''
    if (bin === '') return resolve(null)
    const child = spawn(bin, ['app-server'], { env: { ...shell.env(), ...envFor(l) }, stdio: ['pipe', 'pipe', 'ignore'] })
    const results: Record<number, Record<string, unknown>> = {}
    let buf = ''
    let settled = false
    const finish = (v: Account | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), PLAN_LOGINS.CHECK_TIMEOUT_MS)
    child.on('error', () => finish(null))
    child.on('close', () => finish(null))
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try {
          const msg = JSON.parse(line)
          if (typeof msg.id === 'number') results[msg.id] = msg.result ?? {}
        } catch { /* notifications and non-JSON lines are not ours */ }
      }
      if (!results[2] || !results[3]) return
      const account = results[3].account as { email?: string; planType?: string } | null
      if (!account?.email) return finish(null)
      const limits = results[2].rateLimits as
        | { primary: CodexLimit; secondary: CodexLimit; rateLimitReachedType: string | null }
        | undefined
      const windows = [limits?.primary, limits?.secondary].flatMap((w) =>
        w ? [{ name: windowName(w.windowDurationMins), usedPct: w.usedPercent, resetsAt: w.resetsAt * 1000 }] : []
      )
      const full = windows.filter((w) => w.usedPct >= PLAN_LOGINS.FULL_PCT).map((w) => w.resetsAt)
      const reached = Boolean(limits?.rateLimitReachedType) || full.length > 0
      const limitedUntil = !reached ? null : full.length > 0 ? Math.max(...full) : Date.now() + PLAN_LOGINS.LIMIT_FALLBACK_MS
      finish({ email: account.email, plan: account.planType ?? '', windows, limitedUntil })
    })
    child.stdin.on('error', () => {})
    child.stdin.write(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'mightymouse', version: '1' } } },
        { jsonrpc: '2.0', method: 'initialized' },
        { jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' },
        { jsonrpc: '2.0', id: 3, method: 'account/read', params: {} }
      ]
        .map((m) => JSON.stringify(m))
        .join('\n') + '\n'
    )
  })
}

async function readAccount(l: PlanLogin): Promise<Account | null> {
  if (l.backend === 'codex') return codexAccount(l)
  const { out } = await runCli(l, BACKENDS.claude.authArgs ?? [], PLAN_LOGINS.CHECK_TIMEOUT_MS)
  try {
    const j = JSON.parse(out) as { loggedIn?: boolean; email?: string; subscriptionType?: string }
    return j.loggedIn && j.email ? { email: j.email, plan: j.subscriptionType ?? '' } : null
  } catch {
    return null
  }
}

async function refreshLogin(l: PlanLogin, withUsageProbe: boolean): Promise<void> {
  const account = await readAccount(l)
  if (!account) return
  const fields: Partial<PlanLogin> = { email: account.email, plan: account.plan }
  if (account.windows) Object.assign(fields, { windows: account.windows, checkedAt: Date.now(), limitedUntil: account.limitedUntil ?? null })
  if (l.backend === 'claude' && withUsageProbe) {
    const probe = parseClaudeLimits((await runCli(l, CLAUDE_PROBE_ARGS, PLAN_LOGINS.CHECK_TIMEOUT_MS)).out)
    if (probe) Object.assign(fields, { windows: probe.windows, checkedAt: Date.now(), limitedUntil: probe.rejectedUntil })
  }
  patch(l.id, fields)
}

export async function listPlanLogins(): Promise<PlanLogin[]> {
  await Promise.all(load().filter((l) => l.backend === 'codex' || l.email === '').map((l) => refreshLogin(l, false)))
  return load()
}

export async function checkPlanUsage(): Promise<PlanLogin[]> {
  await Promise.all(load().map((l) => refreshLogin(l, true)))
  return load()
}

function linkSharedConfig(backend: PlanBackend, dir: string): void {
  for (const name of SHARED_CONFIG[backend]) {
    const from = join(DEFAULT_HOME[backend], name)
    if (existsSync(from)) symlinkSync(from, join(dir, name))
  }
}

function removeDir(dir: string): void {
  if (dir.startsWith(LOGINS_DIR + sep)) rmSync(dir, { recursive: true, force: true })
}

function signIn(l: PlanLogin): Promise<void> {
  return new Promise((resolve) => {
    const bin = BACKENDS[l.backend].binPath ?? ''
    if (bin === '') return resolve()
    const child = spawn(bin, SIGN_IN_ARGS[l.backend], { env: { ...shell.env(), ...envFor(l) }, stdio: 'ignore' })
    signingIn = child
    const timer = setTimeout(() => child.kill(), PLAN_LOGINS.SIGN_IN_TIMEOUT_MS)
    const done = (): void => {
      clearTimeout(timer)
      signingIn = null
      resolve()
    }
    child.on('error', done)
    child.on('close', done)
  })
}

export async function addPlanLogin(backend: PlanBackend): Promise<PlanLoginsResult> {
  const fail = (error: string): PlanLoginsResult => ({ logins: load(), error })
  if (signingIn) return fail('A sign-in is already open in your browser.')
  await Promise.all(load().filter((l) => l.email === '').map((l) => refreshLogin(l, false)))
  const id = `${backend}-${Date.now().toString(36)}`
  const dir = join(LOGINS_DIR, id)
  mkdirSync(dir, { recursive: true })
  linkSharedConfig(backend, dir)
  const login = blankLogin(backend, id, dir)
  await signIn(login)
  const account = await readAccount(login)
  if (!account) {
    removeDir(dir)
    return fail('Sign-in did not finish. Try again.')
  }
  if (load().some((l) => l.backend === backend && l.email === account.email)) {
    await runCli(login, BACKENDS[backend].logoutArgs ?? [], PLAN_LOGINS.CHECK_TIMEOUT_MS)
    removeDir(dir)
    return fail(`${account.email} is already added. Sign in with a different account.`)
  }
  save([...load(), { ...login, email: account.email, plan: account.plan }])
  await refreshLogin(load().find((l) => l.id === id)!, true)
  return { logins: load(), error: null }
}

export function cancelPlanSignIn(): void {
  signingIn?.kill()
}

export async function removePlanLogin(id: string): Promise<PlanLogin[]> {
  const login = load().find((l) => l.id === id)
  if (!login?.dir) return load()
  await runCli(login, BACKENDS[login.backend].logoutArgs ?? [], PLAN_LOGINS.CHECK_TIMEOUT_MS)
  removeDir(login.dir)
  save(load().filter((l) => l.id !== id))
  return load()
}

function readPicks(): Partial<PlanLoginPicks> {
  try {
    return JSON.parse(readFileSync(PICKS_FILE, 'utf-8')) as Partial<PlanLoginPicks>
  } catch {
    return {}
  }
}

export function planLoginPicks(): PlanLoginPicks {
  const saved = readPicks()
  const logins = load()
  const pickFor = (b: PlanBackend): string => {
    const mine = logins.filter((l) => l.backend === b)
    return (mine.find((l) => l.id === saved[b]) ?? mine.find((l) => l.dir === null) ?? mine[0])?.id ?? ''
  }
  return { claude: pickFor('claude'), codex: pickFor('codex') }
}

export function setPlanLoginPick(backend: PlanBackend, id: string): PlanLoginPicks {
  if (load().some((l) => l.backend === backend && l.id === id)) {
    writeFileSync(PICKS_FILE, JSON.stringify({ ...readPicks(), [backend]: id }, null, 2), 'utf-8')
  }
  return planLoginPicks()
}

export function pickedLoginEnv(backend: string): Record<string, string> {
  if (!isPlanBackend(backend)) return {}
  const login = load().find((l) => l.id === planLoginPicks()[backend])
  return login ? envFor(login) : {}
}

export function pickPlanLogin(backend: string): { id: string; env: Record<string, string> } | null {
  if (!isPlanBackend(backend)) return null
  const mine = load().filter((l) => l.backend === backend)
  const pick = mine.find((l) => isPlanLoginOpen(l, Date.now())) ?? mine[0]
  return pick ? { id: pick.id, env: envFor(pick) } : null
}

export function planLoginHasRoom(backend: string): boolean {
  return load().some((l) => l.backend === backend && isPlanLoginOpen(l, Date.now()))
}

// Returns true when this run failed because the login hit its plan limit.
export function recordPlanRun(id: string, code: number | null, stdout: string, stderr: string): boolean {
  const login = load().find((l) => l.id === id)
  if (!login) return false
  const now = Date.now()
  const claude = login.backend === 'claude' ? parseClaudeLimits(stdout) : null
  const windows = claude?.windows ?? login.windows
  let until = claude?.rejectedUntil ?? null
  if (until === null && code !== 0 && LIMIT_TEXT.test(`${stdout}\n${stderr}`)) {
    const full = windows.filter((w) => w.resetsAt > now).map((w) => w.resetsAt)
    until = full.length > 0 ? Math.min(...full) : now + PLAN_LOGINS.LIMIT_FALLBACK_MS
  }
  patch(id, {
    windows,
    checkedAt: claude ? now : login.checkedAt,
    ...(until !== null ? { limitedUntil: until } : {})
  })
  if (login.backend === 'codex') void refreshLogin(login, false)
  return until !== null
}

const outsideAccounts = new Map<string, Promise<Account | null>>()

export async function planAccountFor(backend: PlanBackend, dir: string): Promise<{ email: string; plan: string } | null> {
  const loginDir = dir === DEFAULT_HOME[backend] ? null : dir
  const known = load().find((l) => l.backend === backend && l.dir === loginDir)
  if (known && known.email === '') await refreshLogin(known, false)
  const saved = known && load().find((l) => l.id === known.id)
  if (saved?.email) return { email: saved.email, plan: saved.plan }
  if (known) return null
  const key = `${backend}:${dir}`
  if (!outsideAccounts.has(key)) outsideAccounts.set(key, readAccount(blankLogin(backend, key, dir)))
  const account = await outsideAccounts.get(key)
  return account ? { email: account.email, plan: account.plan } : null
}
