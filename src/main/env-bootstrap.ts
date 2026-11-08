/**
 * Applies the admin's runtime env override BEFORE anything reads CONFIG.
 *
 * Import this FIRST in src/main/index.ts, as a bare side-effect import, above
 * every other import. ES import order is preserved in the bundled main process,
 * and CONFIG resolves the active Supabase project during its own module eval —
 * so an override read even one import later is read too late and silently loses
 * to the build-time default.
 *
 * The mechanism is deliberately a plain env var rather than a disk read inside
 * src/shared/env.ts: that module is imported by the RENDERER too, where `fs`
 * does not exist and a static import of it blanks the window. Setting
 * MM_ENV_OVERRIDE here means every context — main, preload, renderer — agrees on
 * the env without any of them touching the filesystem.
 */
import { readEnvOverride, OVERRIDE_FILE_PATH } from './env-override'

const override = readEnvOverride()
// Log on BOTH paths, always. A silent "no override" is indistinguishable from
// "this file never ran", and telling those apart by their absence cost several
// rounds of on-device testing: the only evidence a switch left behind was a
// window title, which is painted by whichever boot got there last.
// The FILE is the source of truth, so this owns the var in BOTH directions —
// setting it is not enough. In dev the switcher relaunches by spawning `npm run
// dev`, and a child inherits our environment: if we merely leave a stale
// inherited MM_ENV_OVERRIDE alone, readAppEnv() (which reads the var, never the
// file) resolves the env we just switched AWAY from, and the app comes back in
// the old project with nothing in the log to say so.
const inherited = process.env.MM_ENV_OVERRIDE
if (override) {
  process.env.MM_ENV_OVERRIDE = override
  console.log(
    `[env] runtime override active: ${override}` +
      (inherited && inherited !== override ? ` (replacing inherited "${inherited}")` : '') +
      '. Clear it from the phone remote or Settings to return to this build default.'
  )
} else {
  delete process.env.MM_ENV_OVERRIDE
  console.log(
    `[env] no runtime override on disk (${OVERRIDE_FILE_PATH}) — using the build default` +
      (inherited ? ` (cleared inherited "${inherited}")` : '') +
      '.'
  )
}
