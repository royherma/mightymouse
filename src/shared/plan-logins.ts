export type PlanBackend = 'claude' | 'codex'
export type PlanWindowName = 'five_hour' | 'week'

export interface PlanWindow {
  name: PlanWindowName
  usedPct: number
  resetsAt: number
}

export interface PlanLogin {
  id: string
  backend: PlanBackend
  email: string
  plan: string
  dir: string | null
  windows: PlanWindow[]
  checkedAt: number | null
  limitedUntil: number | null
}

export type PlanLoginPicks = Record<PlanBackend, string>

export type PlanLoginsResult = { logins: PlanLogin[]; error: string | null }

export const PLAN_BACKENDS: readonly PlanBackend[] = ['claude', 'codex']

export const PLAN_BACKEND_LABEL: Record<PlanBackend, string> = { claude: 'Claude', codex: 'ChatGPT' }

export const PLAN_WINDOW_LABEL: Record<PlanWindowName, string> = { five_hour: '5-hour', week: 'Weekly' }

export const PLAN_LOGINS = {
  SIGN_IN_TIMEOUT_MS: 5 * 60_000,
  CHECK_TIMEOUT_MS: 60_000,
  LIMIT_FALLBACK_MS: 60 * 60_000,
  FULL_PCT: 100,
  WARN_PCT: 80
} as const

const PLAN_TIER_LABEL: Record<string, string> = { prolite: 'Pro Lite' }

export const planTierLabel = (plan: string): string =>
  plan === '' ? '' : PLAN_TIER_LABEL[plan] ?? plan[0].toUpperCase() + plan.slice(1)

export const isPlanLoginOpen = (l: PlanLogin, now: number): boolean =>
  (l.limitedUntil ?? 0) <= now && !l.windows.some((w) => w.usedPct >= PLAN_LOGINS.FULL_PCT && w.resetsAt > now)
