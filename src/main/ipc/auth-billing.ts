/**
 * Auth + Billing IPC — Email OTP / password sign-in, sign-out, session read,
 * credit balance + usage list, and Stripe checkout. Extracted verbatim from the
 * old monolithic `ipc.ts`.
 */
import { ipcMain, shell } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { track } from '../analytics'
import { ANALYTICS_EVENT } from '../../shared/analytics-events'
import { sendCode, verifyCode, signInWithPassword, signOut, getSession, deleteAccount } from '../auth'
import { getSupabase } from '../supabase'
import { fetchBalanceCents, listUsageEvents, fetchSubscriptionStatus, fetchUsage } from '../billing'
import { PREFS } from '../store/prefs'
import type { BillingCheckoutItem, LifetimeOffer } from '../../shared/types'
import { LIFETIME_ERROR } from '../../shared/types'

export function registerAuthBillingHandlers(): void {
  // ── Auth (Email OTP) + analytics ───────────────────────────────────────────
  ipcMain.handle(CHANNELS.authSendCode, async (_, email: string) => sendCode(email))

  // Each of these three changes who the tray thinks you are, and the menu is
  // built once from `currentUser` — so without an explicit refresh an admin who
  // just signed in keeps the signed-out menu (no Admin ▸, no env switcher) until
  // something unrelated happens to rebuild it. Signing out has the mirror
  // problem: the admin rows linger for a user who no longer has them.
  //
  // Imported lazily, at call time: index.ts pulls in this module to register
  // these handlers, so a static import back into it closes a cycle. No other
  // ipc/ module reaches into index.ts, and this is not the place to start.
  const refreshTrayMenu = async (): Promise<void> => {
    try {
      ;(await import('../index')).refreshTrayMenu()
    } catch (error) {
      // A stale menu is a cosmetic problem; never fail a sign-in over it.
      devLog.warn('[auth] could not refresh the tray menu:', error)
    }
  }
  ipcMain.handle(CHANNELS.authVerifyCode, async (_, payload: { email: string; token: string }) => {
    const result = await verifyCode(payload.email, payload.token)
    await refreshTrayMenu()
    return result
  })

  ipcMain.handle(
    CHANNELS.authPassword,
    async (_, payload: { email: string; password: string }) => {
      const result = await signInWithPassword(payload.email, payload.password)
      await refreshTrayMenu()
      return result
    }
  )

  ipcMain.handle(CHANNELS.authSignOut, async () => {
    await signOut()
    await refreshTrayMenu()
  })

  ipcMain.handle(CHANNELS.authDeleteAccount, async () => {
    const result = await deleteAccount()
    if (result.ok) await refreshTrayMenu()
    return result
  })

  ipcMain.handle(CHANNELS.authGetSession, async () => getSession())

  // One-shot read of the download-handoff email (deeplink → PREFS). Reading it
  // clears it so it never resurfaces on a later sign-in. Returns '' if none.
  ipcMain.handle(CHANNELS.authTakePendingEmail, async () => {
    const email = PREFS.getPendingAuthEmail()
    if (email) PREFS.clearPendingAuthEmail()
    return email
  })

  // ── Billing ────────────────────────────────────────────────────────────────

  // Returns the current balance in cents, or null when not signed in. Shares the
  // ONE query in billing.ts so this and the post-checkout push can't drift.
  ipcMain.handle(CHANNELS.billingGetBalance, async () => fetchBalanceCents())

  // Returns the user's recent billed calls (newest first) for the Settings → Usage
  // list. RLS guarantees own-rows-only; the query lives in billing.ts.
  ipcMain.handle(CHANNELS.billingListUsage, async (_, limit?: number) =>
    listUsageEvents(typeof limit === 'number' ? limit : 100)
  )

  // Returns the user's current subscription (status/plan/renewal), or null if
  // they have none. Shares the ONE query in billing.ts, same pattern as balance.
  ipcMain.handle(CHANNELS.billingGetSubscription, async () => fetchSubscriptionStatus())
  ipcMain.handle(CHANNELS.billingGetUsage, async () => fetchUsage())

  // getSession() shares a global per-storage-key lock (GoTrueClient#_acquireLock)
  // with the background auto-refresh timer. If a transient network blip (e.g. a
  // sleep/wake DNS hiccup) hits that timer's in-flight token refresh at the same
  // moment the user clicks a billing button, getSession() awaits the SAME
  // rejected promise and throws — the exact `quietFetch` "supabase offline
  // (ECONNRESET/ENOTFOUND)" error, NOT a checkout-specific failure. One retry is
  // enough: the background timer's refresh has settled by the second call, and a
  // real "signed out" case just returns a null session (no throw) either way.
  async function getJwtOrThrow(): Promise<string | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data } = await getSupabase().auth.getSession()
        return data.session?.access_token
      } catch (err) {
        if (attempt === 1) throw err
        devLog.warn('[billing] getSession() threw (likely a coalesced auto-refresh blip), retrying once', err)
      }
    }
    return undefined
  }

  // Calls the stripe-checkout Edge Function and opens the returned URL in the
  // user's default browser. The JWT travels only to our own Edge Function.
  // `item.kind` distinguishes a one-time pack from a recurring plan; the Edge
  // fn keys its Stripe Checkout mode ('payment' vs 'subscription') off it.
  //
  // IMPORTANT: send ONLY {kind, id} — never also a `packId` field. The Edge fn
  // checks `body.packId` FIRST for legacy-client back-compat and, if present,
  // forces kind='pack' regardless of what `kind` says. Sending both would
  // silently turn every plan checkout into a pack checkout.
  ipcMain.handle(CHANNELS.billingOpenCheckout, async (_, item: BillingCheckoutItem) => {
    // Funnel start. The webhook fires credits_purchased server-side on success
    // (durable even if the browser/app closes), so this pair brackets the funnel.
    track(ANALYTICS_EVENT.checkout_started, { pack_id: item.id, reason: item.reason })
    let jwt: string | undefined
    try {
      jwt = await getJwtOrThrow()
    } catch (err) {
      devLog.error('[checkout] getSession() failed', err)
      track(ANALYTICS_EVENT.checkout_failed, { pack_id: item.id, reason: 'session_error' })
      return { ok: false }
    }
    if (!jwt) {
      track(ANALYTICS_EVENT.checkout_failed, { pack_id: item.id, reason: 'not_signed_in' })
      return { ok: false }
    }
    let url: string | undefined
    let error: string | undefined
    try {
      const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/stripe-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ kind: item.kind, id: item.id })
      })
      // The fn returns a typed `error` code on a refusal (e.g. lifetime_sold_out)
      // so the UI can write real copy instead of a generic "checkout failed".
      ;({ url, error } = (await resp.json()) as { url?: string; error?: string })
    } catch (err) {
      // Never swallow silently — a bare catch{} here is what made this bug
      // undiagnosable in the first place (every failure looked like 'no_url').
      devLog.error('[checkout] fetch failed', err)
      url = undefined
    }
    if (url) {
      shell.openExternal(url)
      track(ANALYTICS_EVENT.checkout_opened, { pack_id: item.id })
    } else {
      // Only the KNOWN refusal codes are reported verbatim; anything else falls
      // back to 'no_url' so an unexpected server string can't widen the union.
      const known = (Object.values(LIFETIME_ERROR) as string[]).includes(error ?? '')
      track(ANALYTICS_EVENT.checkout_failed, {
        pack_id: item.id,
        reason: known ? (error as (typeof LIFETIME_ERROR)[keyof typeof LIFETIME_ERROR]) : 'no_url'
      })
    }
    return { ok: !!url, error }
  })

  // Is the Lifetime offer buyable right now? Server-decided: billing_config has
  // no client SELECT policy, so the app cannot evaluate enabled/cap itself and
  // asks the checkout fn (GET) instead. Returns null when signed out or the call
  // fails — the caller renders nothing, which is the correct fail-closed default
  // for a capped offer (never show a buy button we can't verify is live).
  ipcMain.handle(CHANNELS.billingGetLifetimeOffer, async (): Promise<LifetimeOffer | null> => {
    let jwt: string | undefined
    try {
      jwt = await getJwtOrThrow()
    } catch (err) {
      devLog.error('[lifetime] getSession() failed', err)
      return null
    }
    if (!jwt) return null
    try {
      const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/stripe-checkout`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${jwt}` }
      })
      if (!resp.ok) return null
      return (await resp.json()) as LifetimeOffer
    } catch (err) {
      devLog.error('[lifetime] offer fetch failed', err)
      return null
    }
  })

  // Opens the Stripe Customer Portal (manage/cancel subscription, update card,
  // view invoices) in the user's default browser. Mirrors the checkout call's
  // auth shape; the Edge fn resolves the Stripe customer from the verified JWT.
  ipcMain.handle(CHANNELS.billingOpenPortal, async () => {
    let jwt: string | undefined
    try {
      jwt = await getJwtOrThrow()
    } catch (err) {
      devLog.error('[portal] getSession() failed', err)
      return { ok: false }
    }
    if (!jwt) return { ok: false }
    let url: string | undefined
    try {
      const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/stripe-portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }
      })
      ;({ url } = (await resp.json()) as { url?: string })
    } catch (err) {
      devLog.error('[portal] fetch failed', err)
      url = undefined
    }
    if (url) shell.openExternal(url)
    return { ok: !!url }
  })
}
