/**
 * Runtime environment helpers — the SINGLE SOURCE OF TRUTH for "are we in dev?".
 *
 * Use these instead of sprinkling `is.dev`, `process.env.NODE_ENV`, or
 * `app.isPackaged` checks around the codebase. One import, one meaning, so
 * dev-only surfaces (debug tray entries, the component playground, verbose logs)
 * can never accidentally ship in a packaged build.
 *
 * NOTE: this module is safe to import from BOTH main and renderer. It reads only
 * env vars and import.meta, never the Electron `app` object (which is main-only).
 */

/**
 * True in `npm run dev` / unpackaged builds, false in a packaged production app.
 *
 * Detection order:
 *   1. ELECTRON_RENDERER_URL — set by electron-vite only during `dev`.
 *   2. NODE_ENV === 'development'.
 *   3. import.meta.env.DEV (Vite renderer builds).
 */
export const IS_DEV: boolean = (() => {
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.ELECTRON_RENDERER_URL) return true
    if (process.env.NODE_ENV === 'development') return true
  }
  try {
    // import.meta.env exists in Vite-bundled renderer code.
    if (import.meta && import.meta.env && import.meta.env.DEV) return true
  } catch {
    // import.meta not available in this context — ignore.
  }
  return false
})()

/** True in a packaged production build. The inverse of {@link IS_DEV}. */
export const IS_PROD: boolean = !IS_DEV

/**
 * Marks a user-visible string as produced by a dev-only mock rather than by a
 * real check. Lives here because both the producer (main/ftue-replay.ts) and the
 * consumer (renderer/OnboardingApp.tsx) need it, and a hand-duplicated literal in
 * two files is exactly what drifts: the FTUE replay's "not granted yet" detail is
 * rendered verbatim by the wizard, so an un-marked mock reads as a genuine
 * diagnosis of the user's machine.
 */
export const DEV_MOCK_PREFIX = '[dev replay]'

/**
 * Run `fn` only in dev; no-op in production. Use to guard debug-only side effects.
 *
 * @example
 *   devOnly(() => menu.append(new MenuItem({ label: 'Debug…', click: openDebug })))
 */
export function devOnly(fn: () => void): void {
  if (IS_DEV) fn()
}

/**
 * Pick a value based on environment — `dev` in development, `prod` otherwise.
 *
 * @example
 *   const logLevel = pickByEnv('debug', 'error')
 */
export function pickByEnv<T>(dev: T, prod: T): T {
  return IS_DEV ? dev : prod
}

/**
 * Safely read a process env var from EITHER process (main) OR renderer. The
 * renderer is a browser context where bare `process` is undefined — touching
 * `process.env.X` there throws ReferenceError at module load and blanks the whole
 * window. Always read env vars through this, never `process.env.X` directly in
 * code that `src/shared` or `src/renderer` can import.
 */
export function envVar(name: string): string | undefined {
  return typeof process !== 'undefined' && process.env ? process.env[name] : undefined
}

export const IS_DEVTEST: boolean = envVar('MM_INSTANCE') === 'devtest'
export const DEVTEST_PORT_SHIFT = 200
export const instancePort = (port: number): number => (IS_DEVTEST ? port + DEVTEST_PORT_SHIFT : port)

/**
 * Reads APP_ENV across BOTH contexts: `process.env.APP_ENV` in main/preload
 * (Node), `import.meta.env.VITE_APP_ENV` in the renderer (browser — Vite only
 * exposes vars prefixed VITE_ to import.meta.env, and has no `process` at all).
 * Baked in at build time by electron.vite.config.ts's `define`/`envPrefix`, so a
 * signed packaged build can be built with APP_ENV=staging and have every context
 * agree — see src/shared/config.ts for why divergence between main and renderer
 * here would be a real bug (wrong Supabase project shown/used in the UI).
 */
export function readAppEnv(): string | undefined {
  const override = readRuntimeEnvOverride()
  if (override) return override
  const fromProcess = envVar('APP_ENV')
  if (fromProcess) return fromProcess
  try {
    if (import.meta && import.meta.env && import.meta.env.VITE_APP_ENV) {
      return import.meta.env.VITE_APP_ENV as string
    }
  } catch {
    // import.meta not available in this context — ignore.
  }
  return undefined
}

/**
 * The admin's runtime env override, or undefined. Highest precedence in
 * readAppEnv() — it is a deliberate, per-launch choice, so it must beat the
 * build-time bake-in rather than the other way round.
 *
 * This is read from the environment, NOT from disk, and that indirection is the
 * whole design. `src/main/env-override.ts` owns the file; `env-bootstrap.ts` is
 * the first import in main/index.ts and turns the file into MM_ENV_OVERRIDE
 * before anything reads CONFIG. By the time any module here evaluates, the
 * answer is already an env var — in main and preload. The renderer has no
 * `process` at all, which is what the globalThis fallback below is for.
 *
 * Doing it that way avoids two traps: this module is imported by the RENDERER,
 * which has no `fs` and would blank the window on a static fs import; and it is
 * imported by config.ts during its own module eval, so importing a main-process
 * module here would risk a cycle that silently resolves the wrong project.
 *
 * MM_ENV_OVERRIDE is set by our own bootstrap, never by a user's shell — a stray
 * value only reaches the same place the Settings toggle would.
 */
function readRuntimeEnvOverride(): string | undefined {
  const fromEnv = envVar('MM_ENV_OVERRIDE')
  if (fromEnv === 'staging' || fromEnv === 'prod') return fromEnv
  // The RENDERER has no `process`, so the env var above is always undefined
  // there and it would silently fall through to the build-time VITE_APP_ENV --
  // main resolving prod while every window still says Staging. That shipped:
  // the sign-in sheet read CONFIG.IS_STAGING and showed a STAGING badge under a
  // title bar that already said MightyMouse.
  //
  // The preload is the bridge: it DOES have `process` (every window runs
  // sandbox:false) and it finishes before any renderer module evaluates, so it
  // hands the value over via contextBridge — see src/preload/env-stamp.ts. Not
  // the query string: windows are routed by `?window=` and several are opened
  // without one.
  //
  // Checked on `globalThis` too, not just `window`: contextIsolation is on
  // everywhere today so the bridge puts it on `window`, but with isolation off
  // the preload writes it directly to the shared global instead. Reading both
  // means neither mode silently falls through to the build-time default.
  try {
    const stamped =
      (globalThis as { __MM_ENV_OVERRIDE__?: string }).__MM_ENV_OVERRIDE__ ??
      (typeof window !== 'undefined'
        ? (window as { __MM_ENV_OVERRIDE__?: string }).__MM_ENV_OVERRIDE__
        : undefined)
    if (stamped === 'staging' || stamped === 'prod') return stamped
  } catch {
    // Nothing stamped — the env var above already answered for main/preload.
  }
  return undefined
}

/** Console logger that stays silent in production. */
export const devLog = {
  log: (...args: unknown[]): void => {
    if (IS_DEV) console.log(...args)
  },
  warn: (...args: unknown[]): void => {
    if (IS_DEV) console.warn(...args)
  },
  // Errors always surface, even in production — never swallow a real failure.
  error: (...args: unknown[]): void => console.error(...args)
}

/**
 * The native Swift helpers under native/<name>/ (ocr, mic-recorder, notch-info,
 * mm-input, ...) are built arm64-only — no universal-binary build is in scope.
 * On Intel Macs they either fail existsSync (dev, unbuilt) or fail to exec
 * (packaged, wrong slice), and every call site already degrades gracefully
 * (empty OCR text, no notch info, a no-op click). That silent degradation is
 * correct behavior but was previously unobservable — this makes it a one-time
 * log instead of nothing. Not user-facing: an Intel user just never gets these
 * bonus features, which is expected until a universal build exists.
 */
const archWarned = new Set<string>()
export function warnIfArchMismatch(helperName: string): void {
  if (process.platform !== 'darwin' || process.arch === 'arm64') return
  if (archWarned.has(helperName)) return
  archWarned.add(helperName)
  devLog.warn(
    `[${helperName}] native helper is arm64-only and this Mac is ${process.arch} — ` +
      'skipping (feature degrades gracefully, no universal build yet).'
  )
}
