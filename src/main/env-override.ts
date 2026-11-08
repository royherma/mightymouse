/**
 * Runtime environment override — the admin escape hatch that lets ONE installed
 * build point at either Supabase project without being rebuilt.
 *
 * Precedence, resolved in src/shared/env.ts: this override > build-time APP_ENV >
 * the IS_DEV default. Unset means today's behavior, byte for byte.
 *
 * Two constraints shape this file, and both are easy to break by accident:
 *
 * 1. It is read DURING config.ts's module evaluation, so it must not import
 *    anything that imports CONFIG (a cycle would read a half-built module and
 *    silently resolve the wrong project). Hence: node builtins only, no CONFIG,
 *    no logger, no store.
 *
 * 2. The file lives OUTSIDE the per-env root dir. That dir's own name derives
 *    from the resolved env, so storing the override inside it would need the
 *    answer before it could be read. It sits at ~/.mightymouse-env instead —
 *    one flat file, deliberately boring.
 *
 * Every failure path returns null, i.e. "no override", i.e. today's behavior. A
 * corrupt or unreadable file must never stop the app booting.
 */
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'

export type EnvOverride = 'staging' | 'prod'

/** Flat file outside every per-env root — see note 2 above. */
const OVERRIDE_FILE = join(homedir(), '.mightymouse-env')

/** Exported for logging only — env-bootstrap names the path it just read, so a
 *  "no override" line is provably about the same file the switcher writes. */
export const OVERRIDE_FILE_PATH = OVERRIDE_FILE

function isEnvOverride(v: string): v is EnvOverride {
  return v === 'staging' || v === 'prod'
}

/**
 * The override, or null if unset/invalid/unreadable. Synchronous on purpose:
 * config.ts needs the answer at module-eval time, where a promise is unusable.
 */
export function readEnvOverride(): EnvOverride | null {
  try {
    if (!existsSync(OVERRIDE_FILE)) return null
    const raw = readFileSync(OVERRIDE_FILE, 'utf8').trim().toLowerCase()
    return isEnvOverride(raw) ? raw : null
  } catch {
    // Unreadable = no override. Never throw here: this runs before the app boots.
    return null
  }
}

/**
 * Persist the override, or clear it with null. Callers MUST verify the user is a
 * real admin first — this module has no idea who is asking, by design (importing
 * auth here would create the config cycle described above).
 *
 * Takes effect on the next launch; nothing re-reads CONFIG in a live process.
 */
export function writeEnvOverride(env: EnvOverride | null): void {
  if (env === null) {
    try {
      if (existsSync(OVERRIDE_FILE)) unlinkSync(OVERRIDE_FILE)
    } catch (err) {
      console.error('[env-override] could not clear the override:', err)
    }
    return
  }
  try {
    writeFileSync(OVERRIDE_FILE, `${env}\n`, 'utf8')
  } catch (err) {
    console.error(`[env-override] could not persist "${env}":`, err)
  }
}
