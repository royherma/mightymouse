import { app, shell, Notification } from 'electron'
import { trackError } from './analytics'
import { devLog } from '../shared/env'
import { CONFIG } from '../shared/config'

/**
 * Crash + uncaught-error capture → public.errors (Supabase) via trackError().
 *
 * No third-party SDK, no signup: we already ship an anonymous-first, retry-
 * buffered insert pipeline (analytics.ts). A crash is just a row in a dedicated
 * `errors` table. This buys the "what broke today?" signal for one SQL query.
 *
 * Any 'uncaughtException' listener keeps the process alive, so every one is logged, not just the first.
 */

let installed = false

const MAX_DISTINCT_UNCAUGHT = 100
const reportedUncaught = new Set<string>()

// Transient-offline noise, NOT a crash. The Supabase auth client (GoTrueClient)
// runs a background token-refresh timer; when a DNS/network blip hits at refresh
// time it rejects with `fetch failed` / `ENOTFOUND <ref>.supabase.co`. GoTrue
// retries on its own next tick and the session stays valid, so these are pure
// log/analytics noise. Drop them from the error pipeline rather than report a
// healthy session as a crash. A real auth bug surfaces a non-network message
// (4xx, bad JWT) and still flows through untouched.
function isTransientNetworkError(err: Error): boolean {
  const msg = err.message ?? ''
  const networky =
    msg.includes('fetch failed') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ENETUNREACH') ||
    msg.includes('EAI_AGAIN')
  if (!networky) return false
  // Confirm it's a Supabase host so we never swallow an unrelated network crash.
  const cause = (err as { cause?: { hostname?: string } }).cause
  const host = cause?.hostname ?? ''
  return host.endsWith('.supabase.co') || err.stack?.includes('@supabase/') === true
}

// Declining a getDisplayMedia request is done by answering the handler with an
// empty callback (main/index.ts), and Electron turns that into a rejected
// promise in the renderer that resurfaces here. It is a HANDLED outcome —
// WebrtcCaptureApp catches its own failure and reports it to the phone via
// webrtcCaptureError — so reporting it as a main-process crash overstates it.
// The reason we declined is already logged at the decline site, which is the
// line that actually explains it (usually a missing Screen Recording grant).
//
// "One-time callback was called more than once" is the sibling race: phone
// disconnect tears the capture window down while desktopCapturer.getSources is
// still in flight, Electron already answered/aborted, then our late callback
// double-fires. Main once-guards the answer; this swallow is defense in depth.
//
// Matched on Chromium's exact wording, deliberately narrow: any other capture
// failure still flows through untouched.
function isHandledMirrorRejection(err: Error): boolean {
  const msg = err.message ?? ''
  return (
    msg.includes('Video was requested, but no video stream was provided') ||
    msg.includes('One-time callback was called more than once')
  )
}

/**
 * Build the mailto: URL for a bug report. This is the FALLBACK path now — the
 * in-app form (?window=bug) is primary. It survives because a report that fails
 * to POST (offline, function down) must not evaporate: the form hands the user
 * this link with everything they already typed still in it.
 */
export function buildBugReportMailto(body?: string, steps?: string): string {
  const subject = `${CONFIG.BRAND_NAME} bug report (v${CONFIG.APP_VERSION})`
  const lines = [
    ...(body ? [body, ''] : ['', '']),
    ...(steps ? [`What I was doing: ${steps}`, ''] : []),
    `--- diagnostics (feel free to trim) ---`,
    `App version: ${CONFIG.APP_VERSION}`,
    `Platform: ${process.platform} ${process.arch}`,
    ...(lastCrashMessage ? [`Last error: ${lastCrashMessage}`] : [])
  ]
  return `mailto:${CONFIG.SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`
}

/** Open the email fallback directly. Kept for callers with no window available. */
export function openBugReportEmail(): void {
  void shell.openExternal(buildBugReportMailto())
}

// Most-recent captured error message. Read by the bug-report form so a report
// filed right after a crash carries the crash with it, and by the mailto
// fallback. Never persisted to disk.
let lastCrashMessage: string | null = null

export function getLastCrashMessage(): string | null {
  return lastCrashMessage
}

// Set by index.ts at startup. Injected rather than imported directly so crash.ts
// (loaded early, in the uncaughtException path) never pulls the window/renderer
// module graph in behind it.
let openReportWindow: (() => void) | null = null

export function setBugReportWindowOpener(open: () => void): void {
  openReportWindow = open
}

function notifyUserOfCrash(kind: string, message: string): void {
  lastCrashMessage = `${kind}: ${message}`.slice(0, 500)
  if (!Notification.isSupported()) return
  try {
    const notification = new Notification({
      title: `${CONFIG.APP_NAME} hit a snag`,
      body: 'Click to tell us what happened.'
    })
    notification.on('click', () => {
      if (openReportWindow) openReportWindow()
      else openBugReportEmail()
    })
    notification.show()
  } catch (err) {
    devLog.error('[crash] failed to show crash notification:', err)
  }
}

export function installCrashHandlers(): void {
  if (installed) return
  installed = true

  process.on('uncaughtException', (err) => {
    if (isTransientNetworkError(err)) {
      devLog.warn('[crash] ignoring transient Supabase network blip:', err.message)
      return
    }
    devLog.error('[crash] uncaughtException:', err)
    const message = err?.message ?? String(err)
    if (reportedUncaught.has(message) || reportedUncaught.size >= MAX_DISTINCT_UNCAUGHT) return
    reportedUncaught.add(message)
    trackError({
      kind: 'uncaughtException',
      message,
      stack: err?.stack,
      source: 'main'
    })
  })

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    if (isTransientNetworkError(err)) {
      devLog.warn('[crash] ignoring transient Supabase network blip:', err.message)
      return
    }
    if (isHandledMirrorRejection(err)) {
      devLog.warn('[crash] mirror rejection (handled):', err.message)
      return
    }
    devLog.error('[crash] unhandledRejection:', err)
    trackError({
      kind: 'unhandledRejection',
      message: err.message,
      stack: err.stack,
      source: 'main'
    })
  })

  // A renderer window crashed / was killed (white screen, OOM, GPU fault).
  app.on('render-process-gone', (_e, _wc, details) => {
    devLog.error('[crash] render-process-gone:', details)
    const message = `renderer ${details.reason} (exit ${details.exitCode})`
    trackError({
      kind: 'render-process-gone',
      message,
      source: 'renderer',
      props: { reason: details.reason, exitCode: details.exitCode }
    })
    notifyUserOfCrash('render-process-gone', message)
  })

  // A utility / GPU child process died.
  app.on('child-process-gone', (_e, details) => {
    devLog.error('[crash] child-process-gone:', details)
    const message = `${details.type} ${details.reason} (exit ${details.exitCode})`
    trackError({
      kind: 'child-process-gone',
      message,
      source: 'main',
      props: { type: details.type, reason: details.reason, exitCode: details.exitCode }
    })
    notifyUserOfCrash('child-process-gone', message)
  })
}
