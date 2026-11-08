/**
 * One sandboxed `PATHS` for every test that boots a real phone-remote server.
 *
 * Ten test files each hand-patched `ROOT` plus the one or two keys they knew
 * about. That is not equivalent: every key is `join(ROOT_DIR, ...)` resolved
 * at module load, so spreading `...actual.PATHS` copies the already-baked
 * REAL absolute path for every key nobody thought to list. The journal was one
 * of those, so the suite wrote connect/pair/revoke entries straight into
 * `~/MightyMouse Staging/phone-remote-journal.json` -- flooding the 200-entry
 * ring buffer that exists to diagnose Roy's phone, and evicting the real
 * disconnect it was being read for.
 *
 * Rebasing by string replacement rather than by listing keys is the point: a
 * key added to paths.ts later is sandboxed automatically instead of silently
 * pointing at the user's data the first time a test touches it.
 */

/** Rebase every path under the real root onto `root`, leaving anything outside
 *  it (absolute system paths, the env-override file in `$HOME`) untouched. */
export function sandboxPaths<T extends Record<string, unknown>>(actual: T, realRoot: string, root: string): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(actual)) {
    out[key] = typeof value === 'string' && value.startsWith(realRoot) ? root + value.slice(realRoot.length) : value
  }
  return out as T
}
