// auth-diagnostic.ts — OPT-IN diagnostic for auth + backend-detection weirdness.
//
// KEEPER, not throwaway: this proved the app's Supabase session persists fine
// (decryptLine=>OK, restoredUser=true) and is a reusable "why is auth/detection
// acting up" probe. It's OFF by default now — enable per-run with the env var
// MM_AUTH_DIAG=1 (e.g. `MM_AUTH_DIAG=1 open -a MightyMouse`) to append a report to
// ~/MightyMouse/auth-diagnostic.log. When on, it snapshots: safeStorage backend +
// whether the session file decrypts, the storage key GoTrue uses, and getSession()
// timing/timeout — enough to distinguish decrypt-fail / timeout / pre-ready / key
// mismatch without a rebuild.

import { app, safeStorage } from 'electron'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { PATHS } from './store/paths'
import { isEncryptedLine, decryptLine } from './store/safe-storage'
import { envVar } from '../shared/env'

// Resolved lazily: this diagnostic is off by default, so reading PATHS at module
// load would make an unused probe a load-order dependency for every importer.
const logPath = (): string => PATHS.ROOT + '/auth-diagnostic.log'

/** Diagnostic writes only when explicitly enabled — no per-launch log spam. */
function enabled(): boolean {
  return envVar('MM_AUTH_DIAG') === '1'
}

function line(msg: string): void {
  if (!enabled()) return
  try {
    // ISO-ish timestamp without Date.now-in-workflow constraints (this is main, fine).
    const ts = new Date().toISOString()
    appendFileSync(logPath(), `[${ts}] ${msg}\n`, 'utf-8')
  } catch {
    // best-effort; never throw from a diagnostic
  }
}

/** One-shot header snapshot: encryption backend + whether the session decrypts. */
export function logAuthDiagnosticStartup(): void {
  if (!enabled()) return // no work at all when the diagnostic is off
  line('──────── startup ────────')
  line(`app.isReady=${app.isReady()}`)

  // Hypothesis A/C — encryption availability + backend + can we decrypt the file NOW?
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch (e) {
    line(`isEncryptionAvailable() THREW: ${String(e)}`)
  }
  line(`safeStorage.isEncryptionAvailable=${available}`)
  try {
    // getSelectedStorageBackend is macOS/Linux only; guard it.
    const anyStore = safeStorage as unknown as { getSelectedStorageBackend?: () => string }
    if (typeof anyStore.getSelectedStorageBackend === 'function') {
      line(`safeStorage.backend=${anyStore.getSelectedStorageBackend()}`)
    }
  } catch (e) {
    line(`getSelectedStorageBackend() THREW: ${String(e)}`)
  }

  // Read the actual session file and try to decrypt it, logging exactly what happens.
  try {
    if (!existsSync(PATHS.AUTH_SESSION)) {
      line('auth-session.json: MISSING (no session to restore — first run or cleared)')
      return
    }
    const raw = readFileSync(PATHS.AUTH_SESSION, 'utf-8')
    line(`auth-session.json: present, ${raw.length} bytes, encryptedEnvelope=${isEncryptedLine(raw)}`)
    const decrypted = decryptLine(raw)
    if (decrypted === null) {
      // Hypothesis A CONFIRMED if we reach here with a valid envelope.
      line('decryptLine => NULL  ← DECRYPT FAILED (hypothesis A). The app cannot read its own session.')
    } else {
      const looksLikeSession = decrypted.includes('access_token') || decrypted.includes('refresh_token')
      line(`decryptLine => OK, ${decrypted.length} chars, looksLikeSession=${looksLikeSession}`)
      line('  → decrypt works; if still re-prompting, suspect B (timeout) or D (key mismatch).')
    }
  } catch (e) {
    line(`reading/decrypting auth-session.json THREW: ${String(e)}`)
  }
}

/** Log each storage key GoTrue reads/writes (hypothesis D) + timing of restore (B). */
export function logStorageKey(op: 'get' | 'set' | 'remove', key: string, hit: boolean): void {
  line(`fsStorage.${op}(key=${JSON.stringify(key)}) hit=${hit}`)
}

/** Log initAuth timing + whether the timeout fallback fired (hypothesis B). */
export function logInitAuthResult(ms: number, timedOut: boolean, restoredUser: boolean): void {
  line(`initAuth: ${ms}ms, timedOut=${timedOut}, restoredUser=${restoredUser}`)
  if (timedOut) line('  → TIMEOUT fired (hypothesis B): getSession() exceeded the ceiling → treated as signed-out.')
  line('──────── end ────────')
}

/** Log every post-boot onAuthStateChange event (hypothesis E: post-boot sign-out). */
export function logAuthStateChange(event: string, hasUser: boolean, willBroadcastSignOut: boolean): void {
  line(`onAuthStateChange: event=${event} hasUser=${hasUser} willBroadcastSignOut=${willBroadcastSignOut}`)
}
