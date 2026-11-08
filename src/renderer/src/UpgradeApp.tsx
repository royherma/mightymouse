import { JSX, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './components/Button'
import { Spinner } from './components/Spinner'
import { CONFIG } from '../../shared/config'
import { LIFETIME_ERROR } from '../../shared/types'
import type { BillingItemKind, LifetimeOffer, SubscriptionStatus, UpgradeReason } from '../../shared/types'

// The app's single paywall (?window=upgrade). Every upgrade CTA opens this with
// the limit that triggered it. Three states, no tabs: offer → waiting → result.
// Checkout/portal/return logic lifted out of SettingsApp, which now only shows
// balance, usage and a "Manage billing" link.

// One line per trigger, naming the limit the user just hit. A generic paywall
// makes the user re-derive why they're seeing it.
const REASON_LINE: Record<UpgradeReason, string> = {
  phone_remote_minutes: "You've used today's off-Wi-Fi minutes. Same Wi-Fi stays unlimited.",
  credits_empty: "You've used all your usage.",
  settings: 'A lot more usage every month, on every model.',
  panel: 'A lot more usage every month, on every model.',
  onboarding: 'Start with everything switched on.'
}

const PERKS = [
  'Use your phone as a remote, anywhere, with no time limit',
  'Up to 18x the usage of Free, refilled monthly',
  'Every model - text, images, and video'
]

type Phase =
  | { kind: 'offer' }
  | { kind: 'waiting' }
  | { kind: 'result'; ok: boolean; text: string }

export default function UpgradeApp(): JSX.Element {
  const [reason, setReason] = useState<UpgradeReason>('settings')
  const [phase, setPhase] = useState<Phase>({ kind: 'offer' })
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null)
  const [lifetime, setLifetime] = useState<LifetimeOffer | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [yearly, setYearly] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = `Upgrade ${CONFIG.APP_NAME}`
    void window.api.upgradeGetReason().then(setReason)
    void window.api.billingGetSubscription().then(setSubscription)
    void window.api.billingGetLifetimeOffer().then(setLifetime)

    // Re-opened from a different CTA while already showing: follow the new limit.
    const offReason = window.api.onUpgradeReason((r) => {
      setReason(r)
      setPhase({ kind: 'offer' })
    })

    // The mightymouse:// return. This window owns the outcome now — previously a
    // toast in Settings, which the buyer may never have had open.
    const offReturn = window.api.onBillingCheckoutReturn((status) => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      setPhase(
        status === 'success'
          ? { kind: 'result', ok: true, text: "You're all set. Everything's unlocked." }
          : { kind: 'result', ok: false, text: 'Checkout canceled. You have not been charged.' }
      )
      if (status === 'success') {
        void window.api.billingGetSubscription().then(setSubscription)
        void window.api.billingGetLifetimeOffer().then(setLifetime)
      }
    })

    return () => {
      offReason()
      offReturn()
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // Height is owned by the content, not a constant — the fixed-height mistake in
  // phone-remote-qr-window.ts is what leaves dead space when a short state renders.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const push = (): void => window.api.upgradeResize(el.getBoundingClientRect().height)
    push()
    const ro = new ResizeObserver(push)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const buy = useCallback(async (kind: BillingItemKind, id: string): Promise<void> => {
    setPending(id)
    let res: { ok: boolean; error?: string }
    try {
      res = await window.api.billingOpenCheckout({ kind, id, reason })
    } catch {
      res = { ok: false }
    }
    setPending(null)

    if (!res.ok) {
      // A Lifetime refusal is a real answer, not a failure. Both closed cases
      // share one message: the cap is never surfaced as a number, so "sold out"
      // and "switched off" must read identically to the buyer.
      const refusal =
        res.error === LIFETIME_ERROR.disabled || res.error === LIFETIME_ERROR.soldOut
          ? CONFIG.BILLING.LIFETIME.closed_message
          : res.error === LIFETIME_ERROR.alreadyOwned
            ? CONFIG.BILLING.LIFETIME.already_message
            : null
      if (refusal) {
        void window.api.billingGetLifetimeOffer().then(setLifetime)
        setPhase({ kind: 'result', ok: false, text: refusal })
        return
      }
      // Split from the old single "Could not start checkout" string — the three
      // causes need three different actions from the user.
      setPhase({
        kind: 'result',
        ok: false,
        text:
          res.error === 'not_signed_in'
            ? 'Sign in first, then try again.'
            : "Couldn't reach the payment page. Check your connection and try again."
      })
      return
    }

    setPhase({ kind: 'waiting' })
    if (pollRef.current) clearInterval(pollRef.current)
    let elapsed = 0
    pollRef.current = setInterval(async () => {
      elapsed += 5
      await window.api.billingGetBalance()
      if (elapsed >= 60 && pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }, 5000)
  }, [reason])

  const openPortal = useCallback(async (): Promise<void> => {
    setPending('portal')
    let res: { ok: boolean }
    try {
      res = await window.api.billingOpenPortal()
    } catch {
      res = { ok: false }
    }
    setPending(null)
    if (!res.ok) {
      setPhase({ kind: 'result', ok: false, text: "Couldn't open billing. Try again in a moment." })
    }
  }, [])

  const subscribed = !!subscription && subscription.status === 'active'
  const subscribedPlan = [...CONFIG.BILLING.PLANS, ...CONFIG.BILLING.YEARLY_PLANS].find((p) => p.id === subscription?.planId)

  return (
    <div ref={bodyRef} className="font-sans text-on-surface bg-bg px-6 pb-6 pt-11">
      {phase.kind === 'waiting' ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Spinner />
          <div className="text-lg font-semibold">Finish in your browser</div>
          <p className="text-muted text-md max-w-[320px]">
            We opened the payment page. This window updates the moment you&apos;re done.
          </p>
          <Button
            variant="bare"
            className="text-muted text-sm underline mt-1"
            onClick={() => setPhase({ kind: 'offer' })}
          >
            Back
          </Button>
        </div>
      ) : phase.kind === 'result' ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <div style={{ fontSize: '32px' }}>{phase.ok ? '🎉' : '💤'}</div>
          <div className="text-lg font-semibold">{phase.text}</div>
          {phase.ok ? (
            <Button onClick={() => window.close()} className="mt-1">
              Done
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setPhase({ kind: 'offer' })} className="mt-1">
              Back
            </Button>
          )}
        </div>
      ) : (
        <>
          <h1 className="font-bold m-0" style={{ fontSize: '22px' }}>
            Unlimited {CONFIG.APP_NAME}
          </h1>
          <p className="text-muted text-md mt-1 mb-4">{REASON_LINE[reason]}</p>

          {subscribed ? (
            <div className="rounded-md border border-surface3 bg-surface1 px-4 py-3 shadow-card">
              <div className="font-semibold text-md">
                You&apos;re on the {subscribedPlan?.name ?? 'monthly'} plan.
              </div>
              <p className="text-muted mt-1 mb-3" style={{ fontSize: '12px' }}>
                Renews automatically. Change or cancel any time.
              </p>
              <Button variant="ghost" onClick={openPortal} disabled={pending === 'portal'}>
                {pending === 'portal' ? 'Opening…' : 'Manage billing'}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {(yearly ? CONFIG.BILLING.YEARLY_PLANS : CONFIG.BILLING.PLANS).map((plan) => (
                <Button
                  key={plan.id}
                  variant={plan.name === 'Pro' ? 'primary' : 'ghost'}
                  onClick={() => buy('plan', plan.id)}
                  disabled={!!pending}
                  className="w-full py-2.5 text-lg"
                >
                  {pending === plan.id ? 'Opening…' : `${plan.name} - ${plan.label} · ${plan.bonus_label}`}
                </Button>
              ))}

              <Button variant="bare" className="text-muted text-sm underline self-center" onClick={() => setYearly((y) => !y)}>
                {yearly ? 'Pay monthly instead' : 'Pay yearly - 2 months free'}
              </Button>

              {lifetime?.alreadyOwned && (
                <p className="text-muted text-md m-0">{CONFIG.BILLING.LIFETIME.owned_label}</p>
              )}
            </div>
          )}

          <ul className="list-none p-0 mt-4 mb-0 flex flex-col gap-1.5">
            {PERKS.map((p) => (
              <li key={p} className="text-muted text-md flex gap-2">
                <span className="text-accent-text">✓</span>
                {p}
              </li>
            ))}
          </ul>

          {!subscribed && (
            <>
              <p className="text-muted text-sm mt-3 mb-0">{CONFIG.BILLING.FREE_TIER_NOTE}</p>
              <Button
                variant="bare"
                className="text-muted text-sm underline mt-4 p-0"
                onClick={openPortal}
                disabled={pending === 'portal'}
              >
                Already subscribed? Manage billing
              </Button>
            </>
          )}
        </>
      )}
    </div>
  )
}
