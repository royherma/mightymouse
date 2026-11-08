import { getSupabase } from './supabase';
import { logAuthDiagnosticStartup, logInitAuthResult, logAuthStateChange } from './auth-diagnostic';
import { setAnalyticsUser, identify, track } from './analytics';
import { ANALYTICS_EVENT } from '../shared/analytics-events';
import { CONFIG } from '../shared/config';
import { isPreviewingAsUser } from './admin-preview';

/**
 * Auth = Supabase Email OTP (6-digit code). No deep links, no custom protocol,
 * no redirect server — the simplest flow that works in Electron.
 *
 * The hard gate is driven from index.ts via onAuthed / onSignedOut: when signed
 * out, the app's hotkey/capture tail is never started, so the app is inert.
 */

export interface AuthUser {
  email: string;
  userId: string;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
}

// Callbacks wired from index.ts to start/stop the gated app tail.
let onAuthedCb: (() => void) | null = null;
let onSignedOutCb: (() => void) | null = null;
let broadcastCb: ((user: AuthUser | null) => void) | null = null;

export function configureAuth(opts: {
  onAuthed?: () => void;
  onSignedOut?: () => void;
  broadcast?: (user: AuthUser | null) => void;
}): void {
  onAuthedCb = opts.onAuthed ?? null;
  onSignedOutCb = opts.onSignedOut ?? null;
  broadcastCb = opts.broadcast ?? null;
}

function userFromSession(session: { user?: { id?: string; email?: string } } | null): AuthUser | null {
  if (!session?.user?.id) return null;
  return { userId: session.user.id, email: session.user.email || '' };
}

/** Restore persisted session (if any) and seed analytics. Call once at boot. */
export async function initAuth(): Promise<AuthUser | null> {
  const supabase = getSupabase();

  // React to future auth changes (token refresh, sign-out from elsewhere).
  //
  // GoTrue fires INITIAL_SESSION once on client init with whatever it currently
  // has, which can race a slow disk-read/decrypt and report session=null even
  // though initAuth's own getSession() call (the authoritative restore, below)
  // succeeds moments later. Broadcasting that as a sign-out force-opens the auth
  // window and drops a fully-valid session (index.ts stopAppTail → showAuthWindow).
  // Only a genuine SIGNED_OUT event should trigger the hard sign-out callback;
  // every other event (including a null-session INITIAL_SESSION/TOKEN_REFRESHED)
  // just updates analytics and lets the current gate state stand.
  supabase.auth.onAuthStateChange((event, session) => {
    const user = userFromSession(session);
    setAnalyticsUser(user?.userId ?? null);
    const willBroadcast = event === 'SIGNED_OUT' || user !== null;
    logAuthStateChange(event, user !== null, willBroadcast && user === null);
    if (willBroadcast) {
      broadcastCb?.(user);
    }
    if (event === 'SIGNED_OUT' && user === null) onSignedOutCb?.();
  });

  // getSession() can trigger a token refresh that hangs with no built-in timeout —
  // a stalled network would freeze app startup so hotkeys/tray never register. Race
  // it against a ceiling; on timeout treat as signed-out (the correct fallback —
  // the auth window opens, and onAuthStateChange above still fires if it resolves later).
  // DIAGNOSTIC: snapshot encryption/decrypt state,
  // then time getSession() and record whether the timeout fallback fired.
  logAuthDiagnosticStartup();
  const started = Date.now();
  type SessionData = Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session'];
  const TIMED_OUT = Symbol('timeout');
  const raced = await withTimeout<SessionData | typeof TIMED_OUT>(
    supabase.auth.getSession().then(({ data }) => data.session),
    CONFIG.AUTH_INIT_TIMEOUT_MS,
    TIMED_OUT
  );
  const timedOut = raced === TIMED_OUT;
  const session = timedOut ? null : (raced as SessionData);
  const user = userFromSession(session);
  logInitAuthResult(Date.now() - started, timedOut, user !== null);
  setAnalyticsUser(user?.userId ?? null);
  return user;
}

/**
 * Resolve `p`, or `fallback` if it doesn't settle within `ms`. The promise keeps
 * running (we don't cancel it) — we just stop waiting on it. Used so a hung network
 * call or a wedged macOS permission probe can't block app startup.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: T): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => settle(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        settle(v);
      },
      () => {
        clearTimeout(timer);
        settle(fallback);
      }
    );
  });
}

export async function getSession(): Promise<AuthUser | null> {
  const { data } = await getSupabase().auth.getSession();
  return userFromSession(data.session);
}

/**
 * Staging-only: sign in the seeded test-admin (real Supabase password flow), so
 * the dev-bypass toggle yields a REAL JWT — RLS, the Edge proxy, and billing all
 * work exactly as in prod. Hard no-op in prod so it can never weaken the gate.
 * Reuses signInWithPassword, which persists the session via the fs-storage
 * adapter (auto-refreshed across restarts) and fires onAuthed → starts the tail.
 */
export async function signInTestAdmin(email?: string): Promise<AuthResult> {
  if (!CONFIG.IS_STAGING) return { ok: false, error: 'Test-admin sign-in is staging-only.' };
  const wanted = email?.toLowerCase();
  const account = wanted
    ? CONFIG.STAGING_TEST_ADMINS.find((a) => a.EMAIL.toLowerCase() === wanted)
    : CONFIG.STAGING_TEST_ADMINS[0];
  if (!account) return { ok: false, error: `No seeded test admin for ${email}.` };
  return signInWithPassword(account.EMAIL, account.PASSWORD);
}

export async function isAuthed(): Promise<boolean> {
  return (await getSession()) !== null;
}

/**
 * Is the signed-in user an admin? Controls Admin-dashboard UI visibility only —
 * the real boundary is the admin-stats Edge Function, which re-checks the email
 * server-side. A non-admin (or signed-out) user sees no admin surfaces; even if
 * they forced one open, the function returns 403.
 *
 * Answers false while "View as user" is on, so every admin surface disappears
 * for the preview. Use isRealAdmin() where the answer must ignore the preview.
 */
export async function isCurrentUserAdmin(): Promise<boolean> {
  if (isPreviewingAsUser()) return false;
  return isRealAdmin();
}

/** The unpreviewable truth — the signed-in email against the allowlist. */
export async function isRealAdmin(): Promise<boolean> {
  const user = await getSession();
  const email = user?.email?.toLowerCase();
  if (!email) return false;
  return CONFIG.ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(email);
}

export async function sendCode(email: string): Promise<AuthResult> {
  const clean = (email || '').trim();
  if (clean === '') return { ok: false, error: 'Enter an email address.' };
  try {
    const { error } = await getSupabase().auth.signInWithOtp({
      email: clean,
      options: { shouldCreateUser: true, emailRedirectTo: `${new URL(CONFIG.WEB_CHAT_URL).origin}/app-code` }
    });
    if (error) return { ok: false, error: error.message };
    track(ANALYTICS_EVENT.signin_started);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to send code.' };
  }
}

export async function verifyCode(email: string, token: string): Promise<AuthResult> {
  const cleanEmail = (email || '').trim();
  const cleanToken = (token || '').trim();
  if (cleanToken === '') return { ok: false, error: 'Enter the 6-digit code.' };
  try {
    const { data, error } = await getSupabase().auth.verifyOtp({
      email: cleanEmail,
      token: cleanToken,
      type: 'email'
    });
    if (error) return { ok: false, error: error.message };
    const user = userFromSession(data.session);
    if (!user) return { ok: false, error: 'Verification failed.' };

    track(ANALYTICS_EVENT.signin_completed, { method: 'otp' });
    await identify(user.userId);
    broadcastCb?.(user);
    onAuthedCb?.();

    // Fire-and-forget: ask the server to grant free starter credits on first sign-in.
    // The Edge Function is idempotent (checks for an existing 'grant' ledger row),
    // so calling it on every sign-in is safe. A failure here must never break sign-in.
    if (data.session) {
      fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/grant-signup-credits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'app' })
      }).catch(() => {});
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to verify code.' };
  }
}

/**
 * Email + password auth. No email delivery needed — works instantly, unlimited.
 * Same Supabase users table as OTP, so switching back to codes later is a UI-only
 * change with no data migration. signUp falls back to signIn if the user exists.
 */
export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const cleanEmail = (email || '').trim()
  if (cleanEmail === '') return { ok: false, error: 'Enter an email address.' }
  if ((password || '').length < 6) return { ok: false, error: 'Password must be at least 6 characters.' }
  track(ANALYTICS_EVENT.signin_started, { method: 'password' })
  try {
    const supabase = getSupabase()
    // Try sign-in first; if the account doesn't exist, create it.
    const signIn = await supabase.auth.signInWithPassword({ email: cleanEmail, password })
    let session = signIn.data.session
    let err = signIn.error
    let createdWithoutSession = false
    if (err && /invalid login credentials/i.test(err.message)) {
      const signUp = await supabase.auth.signUp({ email: cleanEmail, password })
      session = signUp.data.session
      err = signUp.error
      createdWithoutSession = !err && !session
    }
    if (err) return { ok: false, error: err.message }
    const user = userFromSession(session)
    if (!user) {
      const error = createdWithoutSession
        ? 'New here? Sign in with the email code to create your account.'
        : 'Could not start a session. Check your password.'
      return { ok: false, error }
    }
    track(ANALYTICS_EVENT.signin_completed, { method: 'password' })
    await identify(user.userId)
    broadcastCb?.(user)
    onAuthedCb?.()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Sign-in failed.' }
  }
}

export async function signOut(): Promise<void> {
  track(ANALYTICS_EVENT.signout);
  try {
    await getSupabase().auth.signOut();
  } catch (err) {
    console.error('signOut failed:', err);
  }
  setAnalyticsUser(null);
  broadcastCb?.(null);
  onSignedOutCb?.();
}

/**
 * Permanently delete the signed-in account, then tear the session down exactly
 * as a sign-out does. Exists because App Review Guideline 5.1.1(v) requires an
 * in-app deletion path for any app that creates accounts.
 *
 * The server does the work (`delete-account` Edge Function): the anon client
 * here cannot remove an auth user, and the row sweep needs the service role.
 * We only pass the caller's own access token, so the function can never be
 * aimed at somebody else's account.
 *
 * On success the local session is dropped without calling `signOut()`, because
 * that would POST a logout for a user the server has already deleted and log a
 * spurious failure.
 */
export async function deleteAccount(): Promise<AuthResult> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, error: 'You are not signed in.' };

  try {
    const response = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/delete-account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error || 'Could not delete your account. Please try again.' };
    }
  } catch (err) {
    console.error('deleteAccount failed:', err);
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' };
  }

  // Local teardown only — the server-side user is already gone.
  try {
    await getSupabase().auth.signOut({ scope: 'local' });
  } catch (err) {
    console.error('deleteAccount local sign-out failed:', err);
  }
  setAnalyticsUser(null);
  broadcastCb?.(null);
  onSignedOutCb?.();
  return { ok: true };
}
