// invite-email.ts — the ONE address check the referral-invite path uses.
//
// Why this lives in src/shared/: the same rule has to run in three places, and
// they can't import each other. The phone-remote React bundle is a standalone
// Vite build that may only import src/shared (see react/vite.config.ts); the
// IPC handler lives in src/main; the Edge function is a separate Deno program
// that can't import from this repo at all. Two of those three now share this
// module instead of hand-copying a regex, and the third (referral-invite/) is
// commented to point back here.
//
// THE THREE CHECKS ARE NOT REDUNDANT, and none may be removed as "already
// handled upstream":
//   phone  -> an affordance. Greys the Send button. Trivially bypassed.
//   Mac    -> the boundary guard. Everything arriving over WS is
//             attacker-controllable once the tunnel is on.
//   Edge   -> independently reachable by anyone holding a valid JWT.
//
// Deliberately permissive. This rejects junk (no @, no dot, spaces, a pasted
// sentence) and nothing else: full RFC 5322 is famously unimplementable in a
// regex, and a stricter pattern's failure mode is refusing to mail a real
// person, which is worse than passing a bad address to Resend and getting a
// bounce. Same shape waitlist-signup uses.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** RFC 5321's ceiling. Anything longer is a payload, not an address. */
export const MAX_INVITE_EMAIL_LEN = 254

/**
 * Trim + lowercase, exactly as the server will store it.
 *
 * Callers must compare and send THIS value, not the raw input: an address that
 * passes validation with a trailing space but is sent untrimmed would be
 * checked and mailed as two different strings.
 */
export function normalizeInviteEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * True if `raw` is plausibly a sendable address. Normalizes first, so a caller
 * can pass unmodified user input.
 */
export function isValidInviteEmail(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  const email = normalizeInviteEmail(raw)
  return email.length > 0 && email.length <= MAX_INVITE_EMAIL_LEN && EMAIL_RE.test(email)
}
