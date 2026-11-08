/**
 * Carries the admin's runtime env override from the preload into the renderer.
 *
 * Import this FIRST in src/preload/index.ts, as a bare side-effect import, above
 * every other import — the same rule as env-bootstrap.ts in the main process,
 * for the same reason: ES import order is preserved in the bundled output, and
 * CONFIG resolves the active Supabase project during its own module eval.
 *
 * Why it has to exist at all: `src/shared/env.ts` reads MM_ENV_OVERRIDE from
 * `process.env`, and the RENDERER has no `process`. So the override was invisible
 * there and every window silently fell back to the build-time VITE_APP_ENV. Main
 * would resolve prod while the UI still rendered as staging — which shipped as a
 * STAGING badge on the sign-in sheet sitting under a title bar that already read
 * "MightyMouse", and read as "the env switch doesn't work".
 *
 * It MUST go across contextBridge, not a plain globalThis assignment. Every
 * window here sets contextIsolation:true, which puts the preload and the renderer
 * in separate V8 worlds — a globalThis write lands somewhere the renderer never
 * reads, so the first version of this file typechecked, passed its tests (they
 * only cover main) and changed nothing on screen. `sandbox:false` on those same
 * lines is what grants the preload `process`; it does NOT merge the two worlds.
 *
 * exposeInMainWorld is safe to use this early: the preload finishes before any
 * renderer module evaluates, so the value is already on `window` by the time
 * config.ts asks for it at module-eval time. That timing is the whole reason a
 * plain value is exposed rather than an IPC getter — env.ts needs the answer
 * synchronously, before any bridge round trip could resolve.
 */
import { contextBridge } from 'electron'

const override = process.env.MM_ENV_OVERRIDE
if (override === 'staging' || override === 'prod') {
  if (process.contextIsolated) {
    try {
      contextBridge.exposeInMainWorld('__MM_ENV_OVERRIDE__', override)
    } catch (error) {
      console.error('[env-stamp] failed to expose env override to the renderer:', error)
    }
  } else {
    // contextIsolation off: the preload and renderer share one world, so the
    // bridge is unavailable and a direct assignment is the only route.
    ;(globalThis as { __MM_ENV_OVERRIDE__?: string }).__MM_ENV_OVERRIDE__ = override
  }
}
