/**
 * Bug reports — the shared contract between the renderer form, the main-process
 * collector, the Edge Function, and the admin dashboard.
 *
 * Everything about a report that both sides need to agree on lives here: the
 * status vocabulary, the length caps, and the payload shapes. No other file
 * types a status string or a cap by hand (see CLAUDE.md "No magic strings").
 *
 * Why a dedicated table instead of reusing public.errors: an error row is
 * something the app noticed; a bug report is something a human deliberately
 * wrote. Different volume, different retention, and only one of them has a
 * triage lifecycle. Mixing them would mean a crash storm buries the one report
 * that has a human sentence in it.
 */

/** Triage lifecycle. Mirrored by the CHECK constraint in 0026_bug_reports.sql. */
export const BUG_REPORT_STATUS = Object.freeze({
  new: 'new',
  open: 'open',
  fixed: 'fixed',
  wontfix: 'wontfix'
} as const)

export type BugReportStatus = (typeof BUG_REPORT_STATUS)[keyof typeof BUG_REPORT_STATUS]

/** Sidebar/queue order: unhandled first, closed last. */
export const BUG_REPORT_STATUS_ORDER: readonly BugReportStatus[] = [
  BUG_REPORT_STATUS.new,
  BUG_REPORT_STATUS.open,
  BUG_REPORT_STATUS.fixed,
  BUG_REPORT_STATUS.wontfix
]

/** Human labels for the admin UI. */
export const BUG_REPORT_STATUS_LABEL: Record<BugReportStatus, string> = {
  [BUG_REPORT_STATUS.new]: 'New',
  [BUG_REPORT_STATUS.open]: 'Open',
  [BUG_REPORT_STATUS.fixed]: 'Fixed',
  [BUG_REPORT_STATUS.wontfix]: "Won't fix"
}

/** A report is "still work" until it's fixed or explicitly declined. */
export function isOpenStatus(status: BugReportStatus): boolean {
  return status === BUG_REPORT_STATUS.new || status === BUG_REPORT_STATUS.open
}

/**
 * Length + count caps. Enforced on BOTH sides on purpose: the renderer uses them
 * for maxLength/counters, and the Edge Function re-applies them because a
 * client-side cap is a UI affordance, never a trust boundary.
 */
export const BUG_REPORT_LIMITS = Object.freeze({
  BODY_MAX: 4000,
  STEPS_MAX: 2000,
  EMAIL_MAX: 200,
  NOTES_MAX: 4000,
  /** Activity entries kept per report. */
  ACTIVITY_MAX: 50,
  /** Screenshot ceiling — a Retina full-screen PNG lands well under this. */
  SCREENSHOT_BYTES_MAX: 8 * 1024 * 1024,
  /** Reports one anon_id may file per hour before the function starts rejecting. */
  RATE_LIMIT_PER_HOUR: 5
})

/** Minimum viable report: a body with actual words in it. */
export const BUG_REPORT_BODY_MIN = 5

/**
 * One line of the recent-activity trail attached to every report.
 *
 * METADATA ONLY — hard rule. `label` is an event name / mode / error kind, never
 * the user's instruction, selection, result, or a file path. The history store
 * holds the user's actual content and none of it belongs in a bug report. See
 * the design's content rule.
 */
export interface BugReportActivityEntry {
  /** ISO-8601. */
  ts: string
  kind: BugReportActivityKind
  /** Event name, mode, or error kind — never user content. */
  label: string
  /** Small scalar extras (duration_ms, ok, backend). Never free text. */
  meta?: Record<string, string | number | boolean | null>
}

export const BUG_REPORT_ACTIVITY_KIND = Object.freeze({
  event: 'event',
  error: 'error',
  run: 'run'
} as const)

export type BugReportActivityKind =
  (typeof BUG_REPORT_ACTIVITY_KIND)[keyof typeof BUG_REPORT_ACTIVITY_KIND]

/**
 * The environment snapshot attached to a report. Assembled in main (it's the only
 * side that knows the backend/mode) and shown to the user in the form BEFORE they
 * submit — nothing here is a secret, and the user should be able to read exactly
 * what they're sending.
 */
export interface BugReportDiagnostics {
  appVersion: string
  platform: string
  arch: string
  osRelease: string
  backend: string
  lastMode: string | null
  signedIn: boolean
  /** Most recent captured crash/error message, if the app has one. */
  lastError: string | null
}

/** What the renderer hands main on submit. */
export interface BugReportDraft {
  body: string
  steps: string
  replyEmail: string
  /** Absolute path to a user-attached screenshot, or null. */
  screenshotPath: string | null
}

/** What main hands the renderer when the form opens. */
export interface BugReportContext {
  diagnostics: BugReportDiagnostics
  activity: BugReportActivityEntry[]
  /** Prefills the reply field when the user is signed in. */
  email: string | null
  /** True when incognito suppressed the activity trail (form says so). */
  activitySuppressed: boolean
}

/** Submit outcome. `emailFallback` carries a prefilled mailto: for the offline path. */
export type BugReportResult =
  | { ok: true; id: number | null }
  | { ok: false; error: string; emailFallback: string }

/**
 * One report in full, as the admin detail view reads it. Lives here rather than
 * beside the React section so the main process can type its IPC handler without
 * importing the dashboard's .tsx module graph.
 */
export type BugReportDetail = AdminBugReport & { screenshotUrl: string | null }

/** A report as the admin dashboard sees it (service-role read, never client-side). */
export interface AdminBugReport {
  id: number
  createdAt: string
  status: BugReportStatus
  body: string
  steps: string | null
  replyEmail: string | null
  appVersion: string | null
  platform: string | null
  anonId: string | null
  userId: string | null
  userEmail: string | null
  hasScreenshot: boolean
  adminNotes: string | null
  resolvedAt: string | null
  diagnostics: BugReportDiagnostics | null
  activity: BugReportActivityEntry[]
}
