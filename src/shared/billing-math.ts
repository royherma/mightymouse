/** Pure charge helpers shared by the Edge Function and Vitest. */

/** Fallback prices; the server can override them via billing_config. */
export const ANTHROPIC_PRICES_PER_M = {
  input: 15.0, // USD per 1M tokens, all four
  output: 75.0,
  cache_read: 1.5,
  cache_creation: 3.75
} as const

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

/** Convert the OpenRouter cost in USD to a marked-up integer-cent charge. */
export function computeChargeCentsFromCost(costUsd: number, markupMultiplier: number = 1.4): number {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return 0
  const chargeCents = Math.round(costUsd * markupMultiplier * 100)
  return Math.max(0, chargeCents)
}

export function computeChargeCents(usage: TokenUsage, markupMultiplier: number = 1.4): number {
  const {
    input_tokens,
    output_tokens,
    cache_read_tokens = 0,
    cache_creation_tokens = 0
  } = usage

  const costUsd =
    (input_tokens * ANTHROPIC_PRICES_PER_M.input +
      output_tokens * ANTHROPIC_PRICES_PER_M.output +
      cache_read_tokens * ANTHROPIC_PRICES_PER_M.cache_read +
      cache_creation_tokens * ANTHROPIC_PRICES_PER_M.cache_creation) /
    1_000_000

  const chargeCents = Math.round(costUsd * markupMultiplier * 100)
  return Math.max(0, chargeCents)
}

/** Classify the proxy response for the adapter. */
export type HttpResponseClass = 'ok' | 'out_of_credits' | 'error'

export function classifyProxyResponse(status: number): HttpResponseClass {
  if (status === 402) return 'out_of_credits'
  if (status >= 200 && status < 300) return 'ok'
  return 'error'
}

/** Map the proxy response class to the adapter's exit code. */
export function proxyResponseClassToExitCode(cls: HttpResponseClass, httpStatus: number): number {
  switch (cls) {
    case 'ok':             return 0
    case 'out_of_credits': return -2
    case 'error':          return httpStatus > 0 ? httpStatus : -1
  }
}

/** Sum pack and subscription credits into the spendable balance. */
export function spendableCents(balanceCents: number | null | undefined, subscriptionCents: number | null | undefined): number {
  return (balanceCents ?? 0) + (subscriptionCents ?? 0)
}

export interface UsageMeter {
  plan: string
  planLeftCents: number
  planLimitCents: number
  extraCents: number
  resetsAt: string | null
}

// null = limits are not switched on server-side yet; callers keep showing the dollar balance.
export function parseUsageMeter(row: unknown): UsageMeter | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  if (r.limits_on !== true || typeof r.plan_limit_cents !== 'number' || r.plan_limit_cents <= 0) return null
  return {
    plan: typeof r.plan === 'string' ? r.plan : 'free',
    planLeftCents: Number(r.plan_left_cents ?? 0),
    planLimitCents: r.plan_limit_cents,
    extraCents: Number(r.extra_cents ?? 0),
    resetsAt: typeof r.resets_at === 'string' ? r.resets_at : null
  }
}

export function usagePercentLeft(meter: UsageMeter): number {
  const pct = Math.round((meter.planLeftCents / meter.planLimitCents) * 100)
  return Math.min(100, Math.max(0, pct))
}

export function usageResetText(resetsAt: string | null, now: Date = new Date()): string {
  if (!resetsAt) return ''
  const at = new Date(resetsAt)
  const days = (at.getTime() - now.getTime()) / 86_400_000
  if (Number.isNaN(days)) return ''
  if (days <= 0) return 'Refills on your next message'
  if (at.toDateString() === now.toDateString()) return 'Refills today'
  if (days < 7) return `Refills ${at.toLocaleDateString(undefined, { weekday: 'long' })}`
  return `Refills ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/** Show the split only when both credit buckets contain funds. */
export function shouldShowBucketBreakdown(packCents: number, subCents: number): boolean {
  return packCents > 0 && subCents > 0
}
