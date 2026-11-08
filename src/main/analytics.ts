import { randomUUID } from 'crypto';
import { getSupabase } from './supabase';
import { PREFS } from './store/prefs';
import { CONFIG } from '../shared/config';
import { IS_DEV, devLog } from '../shared/env';
import {
  ANALYTICS_EVENT,
  type AnalyticsEventName,
  type AnalyticsEventProps
} from '../shared/analytics-events';
import {
  BUG_REPORT_ACTIVITY_KIND,
  type BugReportActivityEntry,
  type BugReportActivityKind
} from '../shared/bug-report';
import { createDedupeTracker } from '../shared/analytics-dedupe';

// In dev, analytics is OFF by default so test runs never pollute the prod
// `events` table. Opt in to real inserts when verifying the pipeline end-to-end:
//   ANALYTICS_DEV=1 npm run dev
const ANALYTICS_ENABLED = !IS_DEV || process.env.ANALYTICS_DEV === '1';

/**
 * Analytics → Supabase public.events.
 *
 * Design:
 * - Anonymous-first: every event carries a stable anon_id (PREFS) even before
 *   sign-in. user_id is attached once the user signs in.
 * - session_id is minted per app launch (in-memory) for session grouping.
 * - track() is fire-and-forget: a dropped network call NEVER blocks the UI or
 *   throws. Failed inserts go to a small in-memory buffer and are retried on the
 *   next successful-ish opportunity (next track call), capped so it can't grow.
 */

const SESSION_ID = randomUUID();
const MAX_BUFFER = 50;
// Background retry-flush cadence. track() still flushes immediately; this loop
// only retries rows a failed insert re-buffered, so they don't wait for the next
// track() call (which may never come before the app quits).
const FLUSH_INTERVAL_MS = 15_000;

/** Stable id for this app launch — attached to every event, error, and bug report. */
export function getAnalyticsSessionId(): string {
  return SESSION_ID;
}

// Identity fields shared by every row we send (events + errors).
interface RowBase {
  anon_id: string;
  session_id: string;
  user_id: string | null;
  app_version: string;
  platform: string;
}

interface EventRow extends RowBase {
  event: string;
  props: Record<string, unknown>;
}

interface ErrorRow extends RowBase {
  kind: string;
  message: string;
  stack: string | null;
  source: string;
  props: Record<string, unknown>;
}

// Two independent buffers so a crash storm never starves product events, and so
// each flushes to its own table. Same retry semantics for both.
let eventBuffer: EventRow[] = [];
let errorBuffer: ErrorRow[] = [];
let currentUserId: string | null = null;

/**
 * Recent-activity ring buffer — the trail attached to a user-filed bug report.
 *
 * Separate from the send buffers above on purpose: those DRAIN on every
 * successful flush, so by the time a user opens the bug form they're usually
 * empty. This one only ever evicts by age/size, so "what was I doing just
 * before it broke" survives.
 *
 * METADATA ONLY (see src/shared/bug-report.ts): an event name, a mode, an error
 * kind — never the instruction, selection, result, or a file path. track()'s
 * props are deliberately NOT copied in here; only the name is.
 */
const ACTIVITY_RING_MAX = 50;
let activityRing: BugReportActivityEntry[] = [];

function pushActivity(kind: BugReportActivityKind, label: string, meta?: BugReportActivityEntry['meta']): void {
  // Incognito means zero cloud transmission, and a bug report is transmission.
  // Dropping at the push (not the read) means the trail never exists at all.
  if (PREFS.getIncognito()) return;
  activityRing.push({ ts: new Date().toISOString(), kind, label, meta });
  if (activityRing.length > ACTIVITY_RING_MAX) {
    activityRing = activityRing.slice(-ACTIVITY_RING_MAX);
  }
}

/** Snapshot the recent-activity trail, oldest-first. Safe to call any time. */
export function getRecentActivity(): BugReportActivityEntry[] {
  return activityRing.slice();
}

/**
 * Record a completed run for the activity trail. Called by the runner — metadata
 * only (mode, backend, duration, ok), never the instruction or the result.
 */
export function noteRunActivity(mode: string, backend: string, durationMs: number, ok: boolean): void {
  pushActivity(BUG_REPORT_ACTIVITY_KIND.run, mode, { backend, duration_ms: Math.round(durationMs), ok });
}

export function setAnalyticsUser(userId: string | null): void {
  currentUserId = userId;
}

/** The signed-in user id, synchronously. Auth's own getSession() is async, and
 *  /pair replies inside a sync handler -- this is already the live mirror of it. */
export function getAnalyticsUser(): string | null {
  return currentUserId;
}

function identityFields(): RowBase {
  return {
    anon_id: PREFS.getAnonId(),
    session_id: SESSION_ID,
    user_id: currentUserId,
    app_version: CONFIG.APP_VERSION,
    platform: process.platform
  };
}

type SendRows<T> = (rows: T[]) => PromiseLike<{ error: unknown }>;

// Events go through events-ingest because a PostgREST insert carries no IP, so Mac alerts had no location.
const sendEvents: SendRows<EventRow> = (rows) => getSupabase().functions.invoke('events-ingest', { body: rows });
const sendErrors: SendRows<ErrorRow> = (rows) => getSupabase().from('errors').insert(rows as never[]);

async function flushTable<T>(send: SendRows<T>, get: () => T[], put: (rows: T[]) => void): Promise<void> {
  const batch = get();
  if (batch.length === 0) return;
  put([]);
  try {
    const { error } = await send(batch);
    if (error) {
      // Re-buffer (newest-dropped) so we never grow unbounded.
      put(batch.concat(get()).slice(0, MAX_BUFFER));
    }
  } catch {
    put(batch.concat(get()).slice(0, MAX_BUFFER));
  }
}

async function flush(): Promise<void> {
  await Promise.all([
    flushTable(sendEvents, () => eventBuffer, (r) => { eventBuffer = r; }),
    flushTable(sendErrors, () => errorBuffer, (r) => { errorBuffer = r; })
  ]);
}

// Burst guard for this process. See src/shared/analytics-dedupe.ts for the
// measured numbers and why the window is deliberately short.
const dedupe = createDedupeTracker();

/**
 * Send a typed cloud event to public.events. Generic over the event taxonomy
 * (src/shared/analytics-events.ts): the name must be a known event, and `props`
 * must match that event's declared shape — a typo or a missing/extra prop is a
 * compile error, not a silent runtime drift.
 */
export function track<K extends AnalyticsEventName>(
  event: K,
  ...rest: {} extends AnalyticsEventProps<K> ? [props?: AnalyticsEventProps<K>] : [props: AnalyticsEventProps<K>]
): void {
  const props = (rest[0] ?? {}) as Record<string, unknown>;
  // Incognito = zero cloud transmission. Checked here, the single chokepoint every
  // event (incl. trackFromRenderer) flows through, so nothing reaches the buffer.
  if (PREFS.getIncognito()) return;
  // Structural backstop for re-render/double-handler storms, so a new call site
  // can't reintroduce the bug 168 call sites made possible. Before pushActivity:
  // a duplicate shouldn't crowd the 50-slot bug-report trail either.
  if (dedupe.isDuplicate(event, props)) {
    devLog.log('[analytics:dup-suppressed]', event);
    return;
  }
  // Name only — props can carry free-form context, and the bug-report trail is
  // metadata-only by contract. Recorded before the dev-drop below so the form is
  // testable in dev, where no row is ever sent.
  pushActivity(BUG_REPORT_ACTIVITY_KIND.event, event);
  if (!ANALYTICS_ENABLED) {
    devLog.log('[analytics:dev-drop]', event, props);
    return;
  }
  eventBuffer.push({ event, props, ...identityFields() });
  if (eventBuffer.length > MAX_BUFFER) eventBuffer = eventBuffer.slice(-MAX_BUFFER);
  // Fire-and-forget; errors handled inside flush.
  void flush();
}

/**
 * Forward an event that originated in the renderer (via the preload `track`
 * bridge → CHANNELS.track IPC). The renderer's own typed bridge is the guard at
 * the source; here we re-enter the strict `track()` with a cast at this ONE
 * trust boundary, since the payload crossed an untyped IPC channel.
 */
export function trackFromRenderer(event: string, props: Record<string, unknown>): void {
  (track as (e: string, p: Record<string, unknown>) => void)(event, props);
}

export interface ErrorReport {
  kind: string;
  message: string;
  stack?: string | null;
  source?: string;
  props?: Record<string, unknown>;
}

const SENTRY_DSN = process.env.SENTRY_DSN ?? '';

function stackFrames(stack: string | null | undefined): { function: string; filename: string; lineno: number; colno: number }[] {
  return (stack ?? '').split('\n').flatMap((line) => {
    const m = line.match(/^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    return m ? [{ function: m[1] ?? '?', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) }] : [];
  }).reverse();
}

async function sendToSentry(report: ErrorReport, row: RowBase): Promise<void> {
  if (!SENTRY_DSN) return;
  const eventId = randomUUID().replace(/-/g, '');
  const frames = stackFrames(report.stack);
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    release: `mightymouse@${row.app_version}`,
    environment: CONFIG.ENV_NAME,
    tags: { kind: report.kind, source: report.source || 'main', os: row.platform },
    user: { id: row.user_id ?? row.anon_id },
    extra: report.props || {},
    exception: { values: [{ type: report.kind, value: (report.message || '').slice(0, 4000), ...(frames.length ? { stacktrace: { frames } } : {}) }] }
  };
  try {
    const dsn = new URL(SENTRY_DSN);
    await fetch(`${dsn.protocol}//${dsn.host}/api${dsn.pathname}/envelope/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.username}, sentry_client=mightymouse/${row.app_version}`
      },
      body: `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}`
    });
  } catch (err) {
    devLog.warn('[analytics] sentry send failed:', err);
  }
}

/**
 * Report a caught error / crash to the dedicated public.errors table. Same
 * fire-and-forget + retry-buffer contract as track(): never throws, never
 * blocks. Kept separate from track() so crashes can't pollute funnel events.
 */
export function trackError(report: ErrorReport): void {
  // Incognito suppresses crash/error reporting too — it's still activity tied to
  // the user's session/anon_id. Covers main + renderer crash hooks (both funnel here).
  if (PREFS.getIncognito()) return;
  // Kind + source only. The message can quote user content (a failed prompt, a
  // path), so it stays out of the trail — the full message still goes to
  // public.errors, which is admin-read-only.
  pushActivity(BUG_REPORT_ACTIVITY_KIND.error, report.kind, { source: report.source || 'main' });
  if (!ANALYTICS_ENABLED) {
    devLog.log('[analytics:dev-drop-error]', report.kind, report.message);
    return;
  }
  errorBuffer.push({
    kind: report.kind,
    message: (report.message || '').slice(0, 4000),
    stack: report.stack ? report.stack.slice(0, 8000) : null,
    source: report.source || 'main',
    props: report.props || {},
    ...identityFields()
  });
  if (errorBuffer.length > MAX_BUFFER) errorBuffer = errorBuffer.slice(-MAX_BUFFER);
  void flush();
  void sendToSentry(report, identityFields());
}

/**
 * On sign-in: fire `identify` and backfill user_id onto all prior anonymous
 * rows for this device via the stitch_identity RPC.
 */
export async function identify(userId: string): Promise<void> {
  setAnalyticsUser(userId);
  track(ANALYTICS_EVENT.identify);
  if (!ANALYTICS_ENABLED) return; // skip prod-row backfill in dev
  try {
    await getSupabase().rpc('stitch_identity', {
      p_anon: PREFS.getAnonId(),
      p_user: userId
    });
  } catch (err) {
    console.error('stitch_identity failed:', err);
  }
}

/**
 * Fired once when the gated app tail starts (post-auth). No heartbeat.
 * `firstRun` flags a genuine first-time user (fresh onboarding completion) so the
 * dashboard can anchor activation + retention cohorts on new-vs-returning.
 */
export function trackSessionStart(firstRun?: boolean): void {
  track(ANALYTICS_EVENT.session_start, { first_run: firstRun });
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background retry-flush loop. Call once at app startup. Idempotent.
 * Without this, a row that fails its initial insert sits in the buffer until the
 * NEXT track() call — which often never happens before the user quits, so the
 * event is lost (e.g. signin_completed firing right before the app closes).
 */
export function startAnalyticsFlushLoop(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  // Don't keep the process alive just for analytics.
  flushTimer.unref?.();
}

/**
 * Drain any buffered rows before quit. Stops the loop and returns the flush
 * promise so the caller can await it during app.before-quit.
 */
export function flushAnalyticsNow(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  return flush();
}
