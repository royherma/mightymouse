/**
 * Phone-side connect attempts, shared by the phone buffer and the Mac ingest.
 *
 * One formatter so `bin/mm-phone-log` cannot drift from the producer. The body
 * carries an outcome and a host, never a credential — POST /connect-log is
 * unauthenticated, same as GET /whoami.
 */

export const CONNECT_OUTCOMES = [
  'no-stored-credential',
  'no-host-found',
  'dial-failed',
  'rejected',
  'rate-limited',
  'conflict',
  'gave-up',
  'unpaired-self',
  'cleared-credential'
] as const

export type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number]

export type ConnectAttempt = {
  at: number
  outcome: ConnectOutcome
  detail: string | null
  host: string | null
  hadCredential: boolean
  attempt: number
  /** Set on socket closes: whether THIS dial reached onopen. Absent when no
   *  socket was opened (no-host-found, unpaired-self). */
  opened?: boolean
  /** Which shell the phone thinks it is, and the two independent signals that
   *  decided it. Separate booleans on purpose: a native app whose message
   *  handler is missing reports shell='pwa' and is indistinguishable in the
   *  log from a genuine Home Screen PWA -- which cost an hour on 2026-08-23,
   *  because `cred=no` looked like an unpaired phone rather than a native
   *  launch that never read its Keychain. `handler` is the message handler,
   *  `bootstrap` the injected credential object; native sets both. */
  shell?: string
  handler?: boolean
  bootstrap?: boolean
}

export const CONNECT_LOG_MAX_ENTRIES = 40

const OUTCOME_SET: ReadonlySet<string> = new Set(CONNECT_OUTCOMES)
const ALLOWED_ATTEMPT_KEYS = new Set([
  'at',
  'outcome',
  'detail',
  'host',
  'hadCredential',
  'attempt',
  'opened',
  'shell',
  'handler',
  'bootstrap'
])
const FORBIDDEN_KEYS = new Set(['credential', 'token', 'secret', 'password', 'd'])
const MAX_DETAIL_CHARS = 200
const MAX_HOST_CHARS = 256

export function formatAttempt(entry: ConnectAttempt): string {
  const parts: string[] = [entry.outcome]
  if (entry.detail) parts.push(entry.detail)
  if (entry.host) parts.push(`host=${entry.host}`)
  parts.push(`cred=${entry.hadCredential ? 'yes' : 'no'}`)
  if (typeof entry.opened === 'boolean') parts.push(`opened=${entry.opened ? 'yes' : 'no'}`)
  if (entry.shell) parts.push(`shell=${entry.shell}`)
  // Only when they disagree with the shell they produced -- a native app
  // missing its handler, or a bootstrap with no handler. The healthy cases add
  // nothing, so the row stays short and the broken one is unmissable.
  if (entry.handler === false && entry.bootstrap === true) parts.push('BRIDGE-HANDLER-MISSING')
  if (entry.attempt > 0) parts.push(`try=${entry.attempt}`)
  return parts.join(' ')
}

/** Returns the attempts, or null if the body is malformed or looks like it
 *  is carrying a secret. Null means reject the whole POST — never ingest a
 *  partial hostile payload. */
export function parseConnectLogBody(raw: unknown): ConnectAttempt[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (hasForbidden(obj)) return null
  if (Object.keys(obj).some((key) => key !== 'entries')) return null
  if (!Array.isArray(obj.entries)) return null
  if (obj.entries.length < 1 || obj.entries.length > CONNECT_LOG_MAX_ENTRIES) return null
  const out: ConnectAttempt[] = []
  for (const item of obj.entries) {
    const parsed = parseAttempt(item)
    if (!parsed) return null
    out.push(parsed)
  }
  return out
}

function hasForbidden(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) return true
  }
  return false
}

function parseAttempt(raw: unknown): ConnectAttempt | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (hasForbidden(obj)) return null
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_ATTEMPT_KEYS.has(key)) return null
  }
  if (typeof obj.at !== 'number' || !Number.isFinite(obj.at)) return null
  if (typeof obj.outcome !== 'string' || !OUTCOME_SET.has(obj.outcome)) return null
  if (!isOptionalString(obj.detail, MAX_DETAIL_CHARS)) return null
  if (!isOptionalString(obj.host, MAX_HOST_CHARS)) return null
  if (typeof obj.hadCredential !== 'boolean') return null
  if (typeof obj.attempt !== 'number' || !Number.isInteger(obj.attempt) || obj.attempt < 0 || obj.attempt > 100) {
    return null
  }
  if (obj.opened !== undefined && typeof obj.opened !== 'boolean') return null
  if (obj.shell !== undefined && (typeof obj.shell !== 'string' || obj.shell.length > 16)) return null
  if (obj.handler !== undefined && typeof obj.handler !== 'boolean') return null
  if (obj.bootstrap !== undefined && typeof obj.bootstrap !== 'boolean') return null
  return {
    at: obj.at,
    outcome: obj.outcome as ConnectOutcome,
    detail: typeof obj.detail === 'string' ? obj.detail : null,
    host: typeof obj.host === 'string' ? obj.host : null,
    hadCredential: obj.hadCredential,
    attempt: obj.attempt,
    ...(typeof obj.opened === 'boolean' ? { opened: obj.opened } : {}),
    ...(typeof obj.shell === 'string' ? { shell: obj.shell } : {}),
    ...(typeof obj.handler === 'boolean' ? { handler: obj.handler } : {}),
    ...(typeof obj.bootstrap === 'boolean' ? { bootstrap: obj.bootstrap } : {})
  }
}

function isOptionalString(value: unknown, max: number): boolean {
  if (value == null) return true
  return typeof value === 'string' && value.length <= max
}
