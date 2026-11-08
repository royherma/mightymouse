/**
 * Per-IP rate limiting for phone-remote's HTTP/WS entry points. Each caller
 * owns its own `Map<string, AttemptEntry>` bucket (declared where it's used)
 * so a flood on one route (e.g. /pair) can't exhaust another's budget.
 */
import { timingSafeEqual } from 'crypto'
import { CONFIG } from '../../shared/config'

export const RATE_LIMIT_MAX_ATTEMPTS = 5
export const RATE_LIMIT_WINDOW_MS = 60_000
export const RATE_LIMIT_COOLDOWN_MS = CONFIG.PHONE_REMOTE.RATE_LIMIT_COOLDOWN_MS

export type AttemptEntry = { count: number; windowStart: number; blockedUntil: number }

const buckets: Array<Map<string, AttemptEntry>> = []

// Registered here rather than listed in server-runtime, which had to import
// every owning module to build that list -- relay-http included, putting the
// two in a cycle that left its maps in the TDZ when entered from either side.
export function rateLimitBucket(): Map<string, AttemptEntry> {
  const bucket = new Map<string, AttemptEntry>()
  buckets.push(bucket)
  return bucket
}

export function allRateLimitBuckets(): ReadonlyArray<Map<string, AttemptEntry>> {
  return buckets
}

export function isRateLimited(bucket: Map<string, AttemptEntry>, ip: string): boolean {
  const entry = bucket.get(ip)
  if (!entry) return false
  return Date.now() < entry.blockedUntil
}

export function recordFailedAttempt(
  bucket: Map<string, AttemptEntry>,
  ip: string,
  max: number = RATE_LIMIT_MAX_ATTEMPTS
): void {
  const now = Date.now()
  const entry = bucket.get(ip)
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket.set(ip, { count: 1, windowStart: now, blockedUntil: 0 })
    return
  }
  entry.count += 1
  if (entry.count >= max) {
    entry.blockedUntil = now + RATE_LIMIT_COOLDOWN_MS
  }
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
