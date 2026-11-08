import { BrowserWindow } from 'electron'
import { getSupabase } from './supabase'
import { getSession } from './auth'
import { CHANNELS } from '../shared/ipc'
import { CONFIG } from '../shared/config'
import { spendableCents, parseUsageMeter, type UsageMeter } from '../shared/billing-math'
import type { UsageEvent, SubscriptionStatus } from '../shared/types'

/**
 * Billing helpers shared by the IPC handler (renderer pull) and the checkout
 * deep-link handler (push after a purchase). Keeping the balance query in ONE
 * place means the two paths can never drift on table/column names.
 */

/**
 * Current SPENDABLE credit balance in cents for the signed-in user, or null
 * when signed out — the sum of both buckets (packs, never expire + monthly
 * subscription, resets each cycle; migration 0016). RLS on credit_balances
 * guarantees we only ever read the caller's own row.
 */
export async function fetchBalanceCents(): Promise<number | null> {
  const user = await getSession()
  if (!user) return null
  const { data } = await getSupabase()
    .from('credit_balances')
    .select('balance_cents, subscription_cents')
    .eq('user_id', user.userId)
    .single()
  return spendableCents(data?.balance_cents, data?.subscription_cents)
}

/**
 * Recent billed calls for the signed-in user, newest first. RLS
 * (usage_events_select_own) guarantees only the caller's own rows come back, so
 * no user_id filter is strictly required — we add it anyway as defense-in-depth.
 * `limit` is clamped to a sane ceiling so a bad caller can't pull the whole table.
 */
// Fallback shown only if billing_config has no display_model_name row yet. The
// real value is server-controlled in billing_config so it can change without a ship.
const DEFAULT_DISPLAY_NAME = `${CONFIG.PRODUCT_NAME} AI`

/** The user-facing product name for the AI, from billing_config.display_model_name.
 *  Deliberately a server lookup so the raw provider/model is never the thing the
 *  client sees, and the name is changeable without an app release. */
async function fetchDisplayModelName(): Promise<string> {
  const { data } = await getSupabase()
    .from('billing_config')
    .select('value')
    .eq('key', 'display_model_name')
    .maybeSingle()
  const v = data?.value
  return typeof v === 'string' && v.trim() !== '' ? v : DEFAULT_DISPLAY_NAME
}

export async function listUsageEvents(limit = 100): Promise<UsageEvent[]> {
  const user = await getSession()
  if (!user) return []
  const capped = Math.min(Math.max(1, limit), 500)
  // Raw `model` is selected for potential server-side use but is NEVER put on the
  // returned object — the client only ever sees the resolved display name.
  const [{ data, error }, displayName] = await Promise.all([
    getSupabase()
      .from('usage_events')
      .select('id, created_at, run_id, feature, model, input_tokens, output_tokens, charged_cents, cost_usd_micros, duration_ms')
      .eq('user_id', user.userId)
      .gt('cost_usd_micros', 0)
      .order('created_at', { ascending: false })
      .limit(capped),
    fetchDisplayModelName()
  ])
  if (error || !data) return []
  // Map snake_case DB columns → the camelCase shape the renderer consumes.
  return data.map((r) => ({
    id: r.id as number,
    createdAt: r.created_at as string,
    runId: r.run_id as string,
    feature: (r.feature as string) ?? 'unknown',
    displayName,
    inputTokens: (r.input_tokens as number) ?? 0,
    outputTokens: (r.output_tokens as number) ?? 0,
    chargedCents: (r.charged_cents as number) ?? 0,
    costUsdMicros: (r.cost_usd_micros as number) ?? 0,
    durationMs: (r.duration_ms as number) ?? 0
  }))
}

/**
 * The signed-in user's subscription row (billing_subscriptions), or null when
 * they have none / aren't subscribed. RLS (billing_subscriptions_select_own)
 * guarantees we only ever read the caller's own row. Written by the
 * stripe-webhook function on customer.subscription.created/updated/deleted —
 * this is a pure read, no writes from the client.
 */
export async function fetchSubscriptionStatus(): Promise<SubscriptionStatus | null> {
  const user = await getSession()
  if (!user) return null
  const { data } = await getSupabase()
    .from('billing_subscriptions')
    .select('status, plan_id, current_period_end')
    .eq('user_id', user.userId)
    .maybeSingle()
  if (!data) return null
  return {
    status: data.status as string,
    planId: (data.plan_id as string) ?? null,
    currentPeriodEnd: (data.current_period_end as string) ?? null
  }
}

export async function fetchUsage(): Promise<UsageMeter | null> {
  const user = await getSession()
  if (!user) return null
  const { data, error } = await getSupabase().rpc('my_usage_status')
  if (error) return null
  return parseUsageMeter(data)
}

/** Push the latest balance to every open window (Settings shows it live). */
export async function broadcastBalance(): Promise<void> {
  const cents = await fetchBalanceCents()
  if (cents === null) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.billingBalanceChanged, cents)
  }
}
