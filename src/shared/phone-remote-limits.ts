/**
 * The off-LAN relay allowance, as the client sees it.
 *
 * WHY A SHARED FILE: this crosses three boundaries that cannot import each
 * other. The rule lives in Postgres, the fetch lives in the Electron main
 * process, and the copy renders in the phone's standalone Vite bundle — which
 * may only import `src/shared/**` (see src/main/phone-remote/CLAUDE.md). Without
 * one home, the reason strings would be hand-typed in three places and drift
 * silently, which is exactly the failure the no-magic-strings rule exists for.
 *
 * `REMOTE_CAP_REASON` mirrors the capped half of the server's
 * `RemoteEntitlementReason` (supabase/functions/_shared/remote-entitlement.ts).
 * The uncapped reasons (`pro`, `within_limits`, `disabled`, `check_failed`) never
 * reach the client as a cap: they all mean "allowed", and the fail-open posture
 * (§4d of the entitlement PRD) is deliberate — a broken limiter must not break
 * pairing. So an unrecognised reason resolves to NOT capped, never to capped.
 */

/** The three windows a free account can exhaust. Nothing else caps the relay. */
export const REMOTE_CAP_REASON = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly'
} as const

export type RemoteCapReason = (typeof REMOTE_CAP_REASON)[keyof typeof REMOTE_CAP_REASON]

/**
 * What the phone needs to render the capped state honestly.
 *
 * `resetsAt` is an ISO timestamp the SERVER computed. The client never derives it
 * — a window boundary depends on the limits row and on the DB's clock, and a
 * client-side "midnight" would be wrong for anyone whose Mac disagrees with it.
 * Absent means unknown, which renders as RESETS_UNKNOWN rather than a guess.
 */
export interface RemoteCapState {
  reason: RemoteCapReason
  /** Minutes used in the window that ran out. Display only. */
  used?: number
  /** The allowance for that window, from the server's config. */
  limit?: number
  /** ISO timestamp when the window rolls over, if the server knew it. */
  resetsAt?: string
}

/**
 * True for the reasons that actually deny the relay. Anything else is allowed.
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype, so `'toString'` off the
 * wire would pass the guard and then index LIMIT_TITLE to `undefined` — a blank
 * limit notice for a user who has no limit.
 */
export function isRemoteCapReason(v: unknown): v is RemoteCapReason {
  return typeof v === 'string' && Object.hasOwn(REMOTE_CAP_REASON, v)
}

/**
 * Build the cap state from an entitlement response, or null when not capped.
 *
 * Takes the loose shape straight off the wire because the caller is parsing an
 * HTTP body: everything is validated here so no unchecked value reaches the UI.
 * Returns null — not a capped state — for `check_failed`, honouring fail-open.
 */
export function toRemoteCapState(body: {
  capped?: unknown
  reason?: unknown
  used?: unknown
  limits?: unknown
  resetsAt?: unknown
}): RemoteCapState | null {
  if (body.capped !== true) return null
  const reason = body.reason
  if (!isRemoteCapReason(reason)) return null

  // `used`/`limits` arrive keyed by window (day/week/month); pick the one that
  // ran out so the UI never has to know which reason maps to which key.
  const windowKey = { daily: 'day', weekly: 'week', monthly: 'month' }[reason]
  const pick = (v: unknown): number | undefined => {
    const n = (v as Record<string, unknown> | null | undefined)?.[windowKey]
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined
  }

  return {
    reason,
    used: pick(body.used),
    limit: pick(body.limits),
    resetsAt: typeof body.resetsAt === 'string' && body.resetsAt ? body.resetsAt : undefined
  }
}

/**
 * "in 3h 20m" / "in 12m" — a relative countdown, from the server's timestamp.
 *
 * Relative, not absolute: "resets at 00:00 UTC" is unreadable, and a local-time
 * render would need a timezone the phone and Mac can disagree about. Returns
 * null when the timestamp is missing, unparseable, or already past, so the
 * caller falls back to RESETS_UNKNOWN instead of printing "in -4m".
 */
export function formatCapReset(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return null
  const mins = Math.ceil((at - now) / 60_000)
  if (mins <= 0) return null
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) {
    const rem = mins % 60
    return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`
  }
  const days = Math.round(hours / 24)
  return days === 1 ? '1 day' : `${days} days`
}
