/**
 * Setup Check — one model for "is MightyMouse actually ready to work?"
 *
 * WHY THIS EXISTS
 * Three probes already answered pieces of this question (permissions, capture
 * binaries, backend health) and each rendered its failure as a DIFFERENT shape:
 * permission cards (good), one grey sentence in OnboardingApp (dead end), and
 * another grey sentence (dead end). Two external testers on 2026-07-23 hit the
 * dead ends within hours of each other — one lost 9m51s in a terminal installing
 * a CLI we never told him how to install.
 *
 * THE INVARIANT: a check that can fail carries the ACTION that fixes it.
 * `SetupCheck.fix` is non-optional when `status === 'fail'`. A failing row with
 * no button is the bug this module exists to make impossible to write.
 *
 * THE OPACITY RULE (PRD §4.0): none of this vocabulary — npm, Node, Homebrew,
 * ffmpeg, CLI, PATH — may reach the user. A row names a CAPABILITY ("Screen
 * recording needs one more piece"), never our plumbing. Dependencies of
 * dependencies (installing Node so we can install a CLI) happen silently under
 * ONE button with ONE progress bar. See CONFIG.SETUP_CHECK for all user copy;
 * nothing in this file is user-visible.
 *
 * See prds/active/2026-07-23-1784776098-zero-dead-ends-setup-check.md
 */

/** Stable ids — one per thing that can be broken. Never shown to the user. */
export const SETUP_CHECK_ID = {
  accessibility: 'accessibility',
  screen: 'screen',
  microphone: 'microphone',
  recording: 'recording',
  transcription: 'transcription',
  backend: 'backend'
} as const

export type SetupCheckId = (typeof SETUP_CHECK_ID)[keyof typeof SETUP_CHECK_ID]

export const SETUP_STATUS = {
  /** Working. Nothing to do. */
  ok: 'ok',
  /** Broken and blocking. MUST carry a fix. */
  fail: 'fail',
  /** Broken but the app still works without it (e.g. mic). Carries a fix. */
  optional: 'optional',
  /** Probe hasn't answered yet. */
  checking: 'checking'
} as const

export type SetupStatus = (typeof SETUP_STATUS)[keyof typeof SETUP_STATUS]

/**
 * How a broken check gets fixed.
 *
 * `install` — we run it ourselves, streaming progress. The user taps once and
 *   watches a bar; what we fetch (and what we had to fetch FIRST to make that
 *   possible) is never surfaced.
 * `grant`   — an OS permission. Hands off to the existing PERMISSIONS.request().
 * `switch`  — move to a backend that needs no installation at all. The single
 *   highest-leverage action here: it converts a ten-minute terminal detour into
 *   one tap. May chain into sign-in or top-up (see SetupFix.chain).
 * `manual`  — genuinely not automatable (someone else's OAuth login). Last
 *   resort, and per §4.0 it is never the PRIMARY action on a row.
 */
export const SETUP_FIX_KIND = {
  install: 'install',
  grant: 'grant',
  switch: 'switch',
  manual: 'manual'
} as const

export type SetupFixKind = (typeof SETUP_FIX_KIND)[keyof typeof SETUP_FIX_KIND]

/**
 * What a `switch` fix must do BEFORE it can actually work.
 *
 * The zero-install backend needs a signed-in account with a non-zero balance
 * (probeBackend, ipc/settings.ts). Switching a signed-out user would land them
 * in a fourth dead end — the exact failure this PRD exists to kill — so the
 * fix declares what it has to chain through first, and the runner does it.
 */
export const SETUP_CHAIN = {
  /** Ready — just flip the backend. */
  none: 'none',
  /** Must open the sign-in window first. */
  signIn: 'signIn',
  /** Signed in, but $0. Must open top-up first. */
  topUp: 'topUp'
} as const

export type SetupChain = (typeof SETUP_CHAIN)[keyof typeof SETUP_CHAIN]

export interface SetupFix {
  kind: SetupFixKind
  /** Button label. User-facing — must obey the opacity rule. */
  label: string
  /** For `switch`: what must happen before the switch is meaningful. */
  chain?: SetupChain
  /**
   * Secondary escape hatch shown ALONGSIDE the primary fix. The one sanctioned
   * two-button case (§4.0 rule 3): "Connect Claude" vs "Use MightyMouse
   * instead" is a real product choice — different cost, different behavior.
   * "brew vs npm" is not, and never appears here.
   */
  alternate?: SetupFix
}

export interface SetupCheck {
  id: SetupCheckId
  /** User-facing capability name. Never a binary name. */
  label: string
  status: SetupStatus
  /** One short user-facing line. Never a path (leaks $HOME → a real name). */
  detail: string
  /** Present whenever status is `fail` or `optional`. See the invariant above. */
  fix?: SetupFix
}

/** Live progress for a running fix, streamed to the row. */
export interface SetupFixProgress {
  id: SetupCheckId
  /** Plain-English line: "Setting up…". Never raw brew/npm output. */
  message: string
  /** 0-100 when knowable, else undefined — the row shows elapsed instead. */
  percent?: number
  done?: boolean
  ok?: boolean
}

/**
 * Anonymous rollup posted for the setup diagnostic. Ids + booleans ONLY —
 * never paths, never raw tool output. This is the payload that tells us how
 * many installs are silently parked on a missing dependency, instead of
 * finding out by WhatsApp.
 */
export interface SetupDiagnostic {
  checks: { id: SetupCheckId; status: SetupStatus }[]
  /** Which fix (if any) the user just ran, and whether it worked. */
  ranFix?: { id: SetupCheckId; kind: SetupFixKind; ok: boolean }
}

/**
 * Flatten a diagnostic into the `setup_diagnostic` analytics payload.
 *
 * Lives here, not in the renderer, so the privacy invariant above is enforced
 * in one testable place: only ids and counts cross the wire. `failing_ids` is a
 * sorted comma-joined string rather than an array because `events.props` is
 * queried with SQL — a scalar is groupable, a jsonb array needs unnesting.
 */
export function toSetupDiagnosticProps(d: SetupDiagnostic): {
  ok: number
  failing: number
  failing_ids: string
  optional_ids: string
  ran_fix: string
} {
  const failing = d.checks.filter((c) => c.status === SETUP_STATUS.fail)
  const optional = d.checks.filter((c) => c.status === SETUP_STATUS.optional)
  return {
    // `optional` counts as ok — it does not block a working install (isSetupComplete agrees).
    ok: d.checks.filter(
      (c) => c.status === SETUP_STATUS.ok || c.status === SETUP_STATUS.optional
    ).length,
    failing: failing.length,
    failing_ids: failing.map((c) => c.id).sort().join(','),
    // A broken Voice row logged `failing:0` for a day while a real user was
    // stuck on it — non-blocking is not the same as fine.
    optional_ids: optional.map((c) => c.id).sort().join(','),
    ran_fix: d.ranFix ? `${d.ranFix.id}:${d.ranFix.kind}:${d.ranFix.ok ? 'ok' : 'fail'}` : '',
  }
}

/**
 * What the Voice row should say, given the engine and the microphone.
 *
 * Lives here rather than beside the other capture rows because it is pure
 * decision logic and this is the file a test can import without booting
 * Electron — the reason the original defect had no test at all.
 *
 * THE DEFECT IT ENCODES: the row used to be `whisper && model`, which proves
 * the FILES exist, never that voice works. A real user (2026-09-06) read
 * "Voice transcription — Ready" while his microphone was blocked, pressed the
 * install button four times in four minutes, re-fetched a 148MB engine that was
 * already on disk, and never transcribed a word. A capability row has to
 * describe the capability, not one of its parts.
 */
export function voiceRowState(enginePresent: boolean, micOk: boolean): {
  status: SetupStatus
  /** `grant` when only the mic is missing — re-downloading fixes nothing. */
  fixKind?: SetupFixKind
} {
  if (enginePresent && micOk) return { status: SETUP_STATUS.ok }
  // Engine missing wins even when the mic is off too: granting a mic with no
  // engine still leaves the user unable to transcribe.
  if (!enginePresent) {
    return { status: SETUP_STATUS.optional, fixKind: SETUP_FIX_KIND.install }
  }
  return { status: SETUP_STATUS.optional, fixKind: SETUP_FIX_KIND.grant }
}

/**
 * True when every blocking check passes. `optional` failures don't block.
 *
 * A `checking` row is NOT complete — it's an unanswered question. Reading it as
 * complete would flash "Everything's ready" over a probe still in flight, which
 * is the same category of lie this whole feature exists to delete.
 */
export function isSetupComplete(checks: SetupCheck[]): boolean {
  return checks.every(
    (c) => c.status === SETUP_STATUS.ok || c.status === SETUP_STATUS.optional
  )
}
