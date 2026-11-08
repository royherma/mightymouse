/**
 * ONE contract for "the backend refused an off-Wi-Fi grant, and here's why".
 *
 * The backend STATES the refusal; the client only reads it. Same convention as
 * `BlockedReason` on the phone side — no layer between the RPC and the pixel is
 * allowed to re-derive intent from a status code, a timing, or a substring.
 *
 * WHY THIS FILE EXISTS: `{error: string}` was doing double duty. Sometimes it
 * held a machine code (`remote_limit_reached`), sometimes raw human prose
 * (`Method not allowed`), and the app had no way to tell which — so it printed
 * whatever arrived. That's how the enum `remote_limit_reached` reached Settings
 * in red. A code the UI can branch on and a sentence it can print are two
 * different fields, and they're separated here.
 *
 * The two CODE strings are mirrored in `supabase/functions/_shared/refusal.ts`
 * because Deno cannot import from `src/shared` (same constraint documented in
 * `_shared/lifecycle-eligibility.ts`). Only the codes cross — the copy below is
 * app-only, since the server never renders UI. Change a code in one file and
 * `remote-refusal.test.ts` fails on the other.
 */

/** Machine-readable refusal codes. The UI branches on these; never on `message`. */
export const REFUSAL_CODE = {
  /** Free tier, one of the usage windows is exhausted. The upgrade moment. */
  remoteLimitReached: 'remote_limit_reached',
  /** Runaway-client abuse ceiling (distinct installIds/day), not a tier rule. */
  dailyCapExceeded: 'daily_cap_exceeded'
} as const

export type RefusalCode = (typeof REFUSAL_CODE)[keyof typeof REFUSAL_CODE]

const REFUSAL_CODES: readonly string[] = Object.values(REFUSAL_CODE)

/** Which allowance window ran out. Mirrors the RPC's `reason` union. */
export type RefusalWindow = 'daily' | 'weekly' | 'monthly'

export interface RefusalUsage {
  day: number
  week: number
  month: number
}

/**
 * The body every refusing response sends. `message` is always present and always
 * printable — a client that understands nothing else can still show it.
 */
export interface RemoteRefusal {
  code: RefusalCode
  /** Human sentence, safe to render verbatim. Never an enum. */
  message: string
  /** Present only for `remote_limit_reached`; Pro short-circuits before metering. */
  usage?: {
    used: RefusalUsage
    limits: RefusalUsage
    /** The narrowest exhausted window — what the copy should name. */
    window: RefusalWindow
  }
}

/** True ⟺ this is a refusal the UI can branch on, rather than an opaque failure. */
export function isRemoteRefusal(body: unknown): body is RemoteRefusal {
  const b = body as RemoteRefusal
  return (
    !!b &&
    typeof b === 'object' &&
    typeof b.message === 'string' &&
    REFUSAL_CODES.includes(b.code)
  )
}

/**
 * The upgrade pitch, built from what the user actually spent.
 *
 * Rendered from `usage`, never hardcoded: a user can be capped on all three
 * windows at once (Roy's staging account is), so a blanket "back tomorrow" is a
 * lie for exactly the people who hit this most. `window` is the narrowest
 * exhausted one because that's the soonest they get anything back.
 */
export const REFUSAL_WINDOW_LABEL: Record<RefusalWindow, string> = {
  daily: 'today',
  weekly: 'this week',
  monthly: 'this month'
}

/** When the named window refills, in the second person. */
export const REFUSAL_WINDOW_RESET: Record<RefusalWindow, string> = {
  daily: 'Resets tomorrow.',
  weekly: 'Resets next week.',
  monthly: 'Resets next month.'
}

/**
 * Names the OUTCOME, not a product. "See Lifetime" pointed at a card that only
 * renders when the offer is live and unowned — so for a subscriber, or once the
 * cap sells out, the button promised a thing that wasn't on the screen it
 * scrolled to. Every plan on that section lifts this limit, so the button says
 * what the user gets and the section shows them how to get it.
 */
export const UPGRADE_CTA = 'Upgrade for unlimited'

export interface RefusalCopy {
  /** One sentence naming what ran out. */
  headline: string
  /** The number, or null when the backend sent no usage block. */
  detail: string | null
  /** Label for the upgrade button, or null when upgrading wouldn't help. */
  cta: string | null
}

/**
 * The ONE reason→copy map. Both pairing surfaces and any future one render this;
 * a second `switch` on `RefusalCode` anywhere in the app is this bug coming back.
 */
export function refusalCopy(refusal: RemoteRefusal): RefusalCopy {
  if (refusal.code === REFUSAL_CODE.dailyCapExceeded) {
    // An abuse ceiling, not a tier limit — Pro wouldn't lift it, so no CTA.
    return {
      headline: 'Off-Wi-Fi access is paused for today.',
      detail: 'This Mac set up too many new addresses today. Try again tomorrow.',
      cta: null
    }
  }

  const usage = refusal.usage
  if (!usage) {
    return {
      headline: "You've used all your off-Wi-Fi access on the free plan.",
      detail: null,
      cta: UPGRADE_CTA
    }
  }

  const { used, limits, window } = usage
  const spent = window === 'daily' ? used.day : window === 'weekly' ? used.week : used.month
  const cap = window === 'daily' ? limits.day : window === 'weekly' ? limits.week : limits.month

  return {
    headline: `You've used your off-Wi-Fi minutes ${REFUSAL_WINDOW_LABEL[window]}.`,
    detail: `${spent} of ${cap} minutes on the free plan. ${REFUSAL_WINDOW_RESET[window]} Same Wi-Fi stays unlimited.`,
    cta: UPGRADE_CTA
  }
}
