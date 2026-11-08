import { useEffect, useState, useCallback, useRef, JSX } from 'react'
import { CONFIG } from '../../shared/config'
import {
  SETUP_STATUS,
  SETUP_FIX_KIND,
  isSetupComplete,
  toSetupDiagnosticProps,
  type SetupCheck,
  type SetupCheckId,
  type SetupDiagnostic,
  type SetupFix
} from '../../shared/setup-check'
import { WindowFrame, LoadingBody } from './WindowFrame'
import { Button } from './components/Button'
import { Spinner } from './components/Spinner'
import { ProgressBar } from './components/ProgressBar'
import { Check, AlertTriangle, Minus } from 'lucide-react'

/**
 * Setup Check — every dependency the app needs, in one list, with a real button
 * on every failing row.
 *
 * This exists because two external testers on 2026-07-23 lost their setup to
 * copy that named our plumbing and offered no action. The rule this screen
 * enforces, structurally: a row that says something is broken ALWAYS renders
 * the control that fixes it. There is no state in which the user reads a
 * problem and has nothing to press.
 *
 * All copy comes from CONFIG.SETUP_CHECK — no user-facing string is written
 * here, so the opacity rule stays enforceable by grep + test.
 *
 */

const COPY = CONFIG.SETUP_CHECK

/** The dot at the head of a row. Status is carried by color AND glyph, never color alone. */
function StatusMark({ status }: { status: SetupCheck['status'] }): JSX.Element {
  if (status === SETUP_STATUS.ok) {
    return (
      <span
        className="flex items-center justify-center w-6 h-6 rounded-full shrink-0"
        style={{ background: 'var(--green-light)' }}
      >
        <Check size={14} strokeWidth={3} color="var(--surface1)" />
      </span>
    )
  }
  if (status === SETUP_STATUS.checking) {
    return (
      <span className="flex items-center justify-center w-6 h-6 shrink-0">
        <Spinner size="w-3.5 h-3.5" />
      </span>
    )
  }
  // Optional reads as "you can skip this" — a muted dash, not a warning, so a
  // missing mic doesn't look like a broken app.
  const optional = status === SETUP_STATUS.optional
  return (
    <span
      className="flex items-center justify-center w-6 h-6 rounded-full shrink-0"
      style={{
        background: optional ? 'var(--surface3)' : 'var(--amber-bg-subtle)',
        border: `1px solid ${optional ? 'var(--surface3)' : 'var(--amber-border-subtle)'}`
      }}
    >
      {optional ? (
        <Minus size={13} strokeWidth={3} color="var(--muted)" />
      ) : (
        <AlertTriangle size={13} strokeWidth={2.5} color="var(--amber)" />
      )}
    </span>
  )
}

/**
 * One row. The invariant lives here: `status !== ok` and a `fix` present means a
 * button renders. A failing row with no button is the bug this whole screen was
 * built to delete, so the fallback is the manual hint — never silence.
 */
function CheckRow({
  check,
  busy,
  progress,
  percent,
  onFix,
  onAlternate
}: {
  check: SetupCheck
  busy: boolean
  progress: string | null
  /** Undefined for fixes with no knowable progress — the row shows only the line. */
  percent: number | null
  onFix: (id: SetupCheckId, fix: SetupFix) => void
  onAlternate: (id: SetupCheckId, fix: SetupFix) => void
}): JSX.Element {
  const done = check.status === SETUP_STATUS.ok
  const fix = check.fix

  return (
    <div
      data-needs-tap={done ? undefined : ''}
      className="flex items-start gap-3 rounded-lg px-3 py-3 border"
      style={{
        background: done ? 'transparent' : 'var(--surface2)',
        borderColor: done ? 'var(--surface3)' : 'var(--surface3)'
      }}
    >
      <span className="mt-0.5">
        <StatusMark status={busy ? SETUP_STATUS.checking : check.status} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-md text-on-surface">{check.label}</span>
        <span className="block text-sm text-muted mt-0.5 leading-snug">
          {busy ? (progress ?? COPY.working) : check.detail}
        </span>
        {busy && percent !== null && (
          <span className="block mt-2">
            <ProgressBar pct={percent} height="h-1" />
          </span>
        )}
      </span>

      {!done && fix && (
        <span className="flex flex-col items-end gap-1.5 shrink-0">
          <Button
            onClick={() => onFix(check.id, fix)}
            disabled={busy}
            className="whitespace-nowrap"
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="w-3 h-3" accent="border-t-on-surface" />
                {COPY.working}
              </span>
            ) : (
              fix.label
            )}
          </Button>
          {/* The one sanctioned second button: a genuine
              product choice between using your own AI and using ours. Never a
              choice between two ways for US to install something. */}
          {fix.alternate && !busy && (
            <Button
              variant="ghost"
              onClick={() => onAlternate(check.id, fix.alternate as SetupFix)}
            >
              {fix.alternate.label}
            </Button>
          )}
        </span>
      )}
    </div>
  )
}

export default function SetupCheckApp(): JSX.Element {
  const [checks, setChecks] = useState<SetupCheck[] | null>(null)
  const [busyId, setBusyId] = useState<SetupCheckId | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [percent, setPercent] = useState<number | null>(null)
  // A ref, not state: the diagnostic reads it when the board settles, and a
  // re-render on every fix would re-probe rows that are already correct.
  const lastFixRef = useRef<SetupDiagnostic['ranFix'] | null>(null)
  /** Bumped per fix attempt so repeated identical failures stay distinguishable. */
  const fixAttemptRef = useRef(0)

  // Returns the fresh checks as well as storing them, so a caller that needs to
  // know whether a fix ACTUALLY took can read the re-probe instead of trusting
  // the fix's own return value.
  const refresh = useCallback(async () => {
    const next = await window.api.setup.getChecks()
    setChecks(next)
    return next
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A permission granted in System Settings, or a CLI installed in a terminal,
  // should show up here without the user hunting for a refresh button. Same
  // poll + focus pattern the onboarding wizard uses.
  useEffect(() => {
    const id = setInterval(() => {
      // Never re-probe mid-install — a poll landing on a half-installed tool
      // would flip the row back to "broken" while its own button is spinning.
      if (!busyId) void refresh()
    }, CONFIG.SETUP_POLL_MS)
    return () => clearInterval(id)
  }, [refresh, busyId])

  useEffect(() => {
    const onFocus = (): void => {
      if (!busyId) void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, busyId])

  // Live progress while a fix runs. Main sends plain-English lines only.
  useEffect(() => {
    return window.api.setup.onFixProgress((payload) => {
      if (payload.done) {
        setProgress(null)
        setPercent(null)
        return
      }
      setProgress(payload.message || null)
      setPercent(payload.percent ?? null)
    })
  }, [])

  const handleFix = useCallback(
    async (id: SetupCheckId, fix: SetupFix) => {
      setBusyId(id)
      setProgress(null)
      setPercent(null)
      try {
        if (fix.kind === SETUP_FIX_KIND.switch) {
          await window.api.setup.switchBackend()
        } else {
          await window.api.setup.runFix(id)
        }
      } finally {
        // Always re-probe, success or failure — the row's next state is the
        // honest answer, not an optimistic one. A fix that didn't take leaves
        // the row failing WITH its button, which is still a live path forward.
        const next = await refresh()

        // Track the RE-PROBE, not the fix's return value. `runFix` reports
        // whether it managed to run, which for a permission means "we called
        // the OS", not "the user granted it" — so a grant that silently no-ops
        // logged ok:true while the row stayed broken. That mismatch is exactly
        // what hid the §2.5 defect from us: the funnel said the fix worked.
        const row = next.find((c) => c.id === id)
        // `optional` is a FAILING optional row, not a fixed one -- counting it
        // as ok meant transcription/recording/microphone could never log
        // ok:false, which is what hid a six-press transcription failure.
        const ok = row ? row.status === SETUP_STATUS.ok : false
        // A route that keeps failing on real machines has to be visible without
        // waiting for someone to record a ten-minute video about it.
        window.api.track('setup_fix_ran', { check: id, kind: fix.kind, ok })
        lastFixRef.current = { id, kind: fix.kind, ok }
        fixAttemptRef.current += 1

        setBusyId(null)
        setProgress(null)
      }
    },
    [refresh]
  )

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('[data-needs-tap]')?.scrollIntoView({ block: 'start' })
  }, [!!checks])

  const chimedRef = useRef(false)
  const complete = !!checks && isSetupComplete(checks)
  // Counts every row still carrying an action, optional included — the blurb is
  // describing the list underneath it, and that list shows both.
  const needsWorkCount = checks?.filter((c) => c.status !== SETUP_STATUS.ok).length ?? 0
  useEffect(() => {
    if (complete && !chimedRef.current) {
      chimedRef.current = true
      window.api.track('setup_check_complete')
    }
  }, [complete])

  // The board as a single row, so "what % of installs are parked on WHICH
  // dependency" is one query. Deliberately NOT gated on `complete`: an install
  // stuck on a missing CLI never reaches complete, and that is exactly the
  // population this is meant to count. Deduped so the re-probe poll doesn't
  // emit a row every tick — but keyed on the attempt count too, or a board that
  // fails identically after each retry looks like one event instead of three.
  const lastDiagRef = useRef<string>('')
  useEffect(() => {
    if (!checks) return
    // A board still probing is an unanswered question, not a diagnosis.
    if (checks.some((c) => c.status === SETUP_STATUS.checking)) return
    const props = toSetupDiagnosticProps({
      checks: checks.map((c) => ({ id: c.id, status: c.status })),
      ranFix: lastFixRef.current ?? undefined
    })
    const key = `${fixAttemptRef.current}:${JSON.stringify(props)}`
    if (key === lastDiagRef.current) return
    lastDiagRef.current = key
    window.api.track('setup_diagnostic', props)
  }, [checks])

  useEffect(() => {
    if (!checks) return
    window.api.track('setup_check_viewed', {
      failing: checks.filter((c) => c.status === SETUP_STATUS.fail).length
    })
    // Fires once per window open, on the first payload — not on every re-probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!checks])

  if (!checks) {
    return (
      <WindowFrame title={COPY.title}>
        <LoadingBody label={COPY.working} />
      </WindowFrame>
    )
  }

  return (
    <WindowFrame title={COPY.title}>
      <div className="px-5 pb-5 pt-1 flex flex-col h-[calc(100vh-2.75rem)]">
        <div className="flex flex-col items-center text-center gap-1.5 mb-4 shrink-0">
          <h1 className="text-xl font-bold text-on-surface">
            {complete ? COPY.headingAllGood : COPY.headingNeedsWork}
          </h1>
          <p className="text-md text-muted max-w-[360px]">
            {complete ? COPY.blurbAllGood : COPY.blurbNeedsWork(needsWorkCount)}
          </p>
        </div>

        <div
          ref={listRef}
          className="flex flex-col gap-2 overflow-y-auto min-h-0 flex-1 -mx-1 px-1 pb-5"
          style={{
            maskImage: 'linear-gradient(to bottom, black calc(100% - 20px), transparent)',
            WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 20px), transparent)'
          }}
        >
          {checks.map((c) => (
            <CheckRow
              key={c.id}
              check={c}
              busy={busyId === c.id}
              progress={busyId === c.id ? progress : null}
              percent={busyId === c.id ? percent : null}
              onFix={handleFix}
              onAlternate={handleFix}
            />
          ))}
        </div>

        <div className="shrink-0 pt-3 flex items-center gap-2">
          <Button variant="ghost" onClick={() => void refresh()} disabled={!!busyId}>
            {COPY.recheck}
          </Button>
          <Button
            size="lg"
            variant={complete ? 'success' : 'primary'}
            className="flex-1 text-lg"
            onClick={() => window.close()}
          >
            {busyId ? COPY.doneWhileFixing : COPY.done}
          </Button>
        </div>
      </div>
    </WindowFrame>
  )
}
