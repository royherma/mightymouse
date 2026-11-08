import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import { arch, release } from 'os'
import { getSupabase } from './supabase'
import { getSession } from './auth'
import { getRecentActivity, getAnalyticsSessionId } from './analytics'
import { PREFS } from './store/prefs'
import { CONFIG } from '../shared/config'
import { devLog } from '../shared/env'
import { getLastCrashMessage, buildBugReportMailto } from './crash'
import {
  BUG_REPORT_LIMITS,
  type BugReportContext,
  type BugReportDiagnostics,
  type BugReportDraft,
  type BugReportResult
} from '../shared/bug-report'

/**
 * User-filed bug reports — collect context, upload an optional screenshot, POST
 * to the `bug-report` Edge Function.
 *
 * Why main owns this rather than the renderer: only main knows the backend, the
 * last mode, the crash message, and the anon/session ids. Assembling in the
 * renderer would mean shipping all of that across IPC just to ship it back.
 *
 * Nothing here throws at the caller. A bug report that fails to send falls back
 * to a prefilled mailto: (see BugReportResult.emailFallback) — the one thing we
 * must never do is lose a report the user already typed.
 */

const SCREENSHOT_BUCKET = 'bug-screenshots'
// Extension → MIME, restricted to what the bucket's allowed_mime_types accepts
// (0026_bug_reports.sql). Anything else is dropped rather than guessed at.
const SCREENSHOT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function collectDiagnostics(signedIn: boolean): BugReportDiagnostics {
  return {
    appVersion: CONFIG.APP_VERSION,
    platform: process.platform,
    arch: arch(),
    osRelease: release(),
    backend: PREFS.getBackend(),
    lastMode: PREFS.getLastMode(),
    signedIn,
    lastError: getLastCrashMessage()
  }
}

/**
 * Everything the form needs to render: the diagnostics block, the recent-activity
 * trail, and a prefilled reply address. The user sees all of it before submitting
 * — nothing is attached that isn't shown.
 */
export async function getBugReportContext(): Promise<BugReportContext> {
  const user = await getSession().catch(() => null)
  const activity = getRecentActivity()
  return {
    diagnostics: collectDiagnostics(!!user),
    activity: activity.slice(-BUG_REPORT_LIMITS.ACTIVITY_MAX),
    email: user?.email ?? null,
    // Incognito drops entries at push time, so an empty trail while incognito is
    // on means "suppressed", not "nothing happened". The form says which.
    activitySuppressed: PREFS.getIncognito()
  }
}

/**
 * Upload a user-attached screenshot to the private bug-screenshots bucket.
 * Returns the object path, or null if there's nothing to upload / it failed —
 * a failed image must never sink the text report, which is the actual payload.
 */
async function uploadScreenshot(path: string, anonId: string): Promise<string | null> {
  try {
    const ext = extname(path).toLowerCase()
    const contentType = SCREENSHOT_MIME[ext]
    if (!contentType) {
      devLog.warn('[bug-report] unsupported screenshot type, skipping:', ext)
      return null
    }
    const bytes = await readFile(path)
    if (bytes.byteLength > BUG_REPORT_LIMITS.SCREENSHOT_BYTES_MAX) {
      devLog.warn('[bug-report] screenshot too large, skipping:', bytes.byteLength)
      return null
    }
    // Path is anon-scoped + time-stamped so two reports can't collide and a
    // listing (service_role only) groups by reporter.
    const objectPath = `${anonId}/${Date.now()}-${basename(path)}`
    const { error } = await getSupabase()
      .storage.from(SCREENSHOT_BUCKET)
      .upload(objectPath, bytes, { contentType, upsert: false })
    if (error) {
      devLog.warn('[bug-report] screenshot upload failed:', error.message)
      return null
    }
    return objectPath
  } catch (err) {
    devLog.warn('[bug-report] screenshot upload threw:', err)
    return null
  }
}

/**
 * Send a report. Attaches the diagnostics + activity trail collected at submit
 * time (not at form-open time) so anything that happened while the user was
 * typing is included.
 */
export async function submitBugReport(draft: BugReportDraft): Promise<BugReportResult> {
  const body = draft.body.trim().slice(0, BUG_REPORT_LIMITS.BODY_MAX)
  const steps = draft.steps.trim().slice(0, BUG_REPORT_LIMITS.STEPS_MAX)
  const fallback = (): string => buildBugReportMailto(body, steps)

  try {
    const user = await getSession().catch(() => null)
    const anonId = PREFS.getAnonId()

    const screenshotPath = draft.screenshotPath
      ? await uploadScreenshot(draft.screenshotPath, anonId)
      : null

    // Invoke through the Supabase client so the user's JWT rides along
    // automatically when signed in — the function treats it as optional and
    // files the report either way.
    const { data, error } = await getSupabase().functions.invoke('bug-report', {
      body: {
        body,
        steps: steps || null,
        replyEmail: draft.replyEmail.trim().slice(0, BUG_REPORT_LIMITS.EMAIL_MAX) || null,
        diagnostics: collectDiagnostics(!!user),
        activity: getRecentActivity().slice(-BUG_REPORT_LIMITS.ACTIVITY_MAX),
        screenshotPath,
        anonId,
        sessionId: getAnalyticsSessionId(),
        appVersion: CONFIG.APP_VERSION,
        platform: process.platform
      }
    })

    if (error) {
      devLog.error('[bug-report] submit failed:', error.message)
      return { ok: false, error: error.message, emailFallback: fallback() }
    }
    const id = typeof data?.id === 'number' ? data.id : null
    return { ok: true, id }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    devLog.error('[bug-report] submit threw:', message)
    return { ok: false, error: message, emailFallback: fallback() }
  }
}
