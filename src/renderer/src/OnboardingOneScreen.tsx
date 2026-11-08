import { useEffect, useState, useCallback, useRef, JSX } from 'react'
import type {
  PermissionKey,
  PermissionCheck,
  BinaryStatus,
  BackendTestResult,
  BackendId
} from '../../shared/types'
import { CONFIG } from '../../shared/config'
import { IS_DEV } from '../../shared/env'
import { WindowFrame, LoadingBody } from './WindowFrame'
import { Button } from './components/Button'
import { ProviderIcon } from './components/ProviderIcon'
import { PermissionRow, rowState, type OnboardingRowKey } from './components/PermissionRow'
import { MODELS } from './SettingsApp'
import { Check, Sparkles, ShieldCheck, Zap, Lock, ChevronDown } from 'lucide-react'

// One-screen setup — the real first run since 2026-08-05.
//
// What this deliberately does NOT have, versus the wizard: no step machine, no
// auto-advance, no resume marker, no per-row restart button, and no pairing
// explainer.

// Row order is the ordering rationale the wizard expressed by gating: the hard
// requirement first, the two optional asks after. Nothing is locked — a user may
// grant the mic first if they want.
const ROWS: OnboardingRowKey[] = ['accessibility', 'microphone', 'screen']

const GRANT_POLL_MS = 1000
const GRANT_POLL_TRIES = 120

const params = new URLSearchParams(window.location.search)
const isReauth = params.get('reauth') === '1'
// Admin-only preview: never writes the completion marker and never releases the
// app-tail gate, so opening it on a set-up machine can't strand the real flow.
const isPreview = params.get('preview') === '1'
// Same dev harness hook the wizard uses — renders one row mid-grant so the busy
// state can be screenshotted without a real OS prompt.
const DEV_BUSY = (IS_DEV && params.get('busy')) as PermissionKey | null
// Harness hook: the provider list opens collapsed, and headless can't click.
const DEV_EXPANDED = IS_DEV && params.get('providers') === 'open'

function ProviderPicker({
  backend,
  isAdmin,
  expanded,
  onChoose
}: {
  backend: BackendId
  isAdmin: boolean
  expanded: boolean
  onChoose: (b: BackendId) => void
}): JSX.Element {
  const all = MODELS.filter((m) => isAdmin || !m.adminOnly || backend === m.value)
  // Collapsed shows the chosen card alone — a first-timer has nothing to decide.
  const visible = expanded ? all : all.filter((m) => m.value === backend)
  return (
    <div className="flex flex-col gap-2">
      {visible.map((m) => {
        const active = backend === m.value
        return (
          <Button
            variant="bare"
            key={m.value}
            onClick={() => onChoose(m.value)}
            aria-pressed={active}
            className={
              'relative w-full flex items-center gap-3 text-left rounded-xl px-3 py-2.5 text-on-surface border transition-colors ' +
              (active ? 'border-accent shadow-focus' : 'border-surface3 hover:border-muted-dark')
            }
            style={{ background: active ? 'var(--accent-wash)' : 'var(--surface1)' }}
          >
            <span
              className="flex items-center justify-center w-9 h-9 rounded-full bg-surface1 border border-surface3 shrink-0"
              aria-hidden
            >
              <ProviderIcon id={m.icon} size={19} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-md">{m.label}</span>
                {m.badge && (
                  <span
                    className="rounded-full font-semibold uppercase whitespace-nowrap leading-none"
                    style={{
                      fontSize: '8px',
                      letterSpacing: '0.04em',
                      padding: '2px 6px',
                      background: 'var(--amber-bg-subtle)',
                      border: '1px solid var(--amber-border-subtle)',
                      color: 'var(--amber)'
                    }}
                  >
                    {m.badge}
                  </span>
                )}
              </span>
              <span className="block text-sm text-muted leading-snug mt-0.5">{m.description}</span>
            </span>
            {active && (
              <span
                className="flex items-center justify-center w-5 h-5 rounded-full shrink-0"
                style={{ background: 'var(--accent)' }}
                aria-hidden
              >
                <Check size={12} strokeWidth={3.5} color="var(--surface1)" />
              </span>
            )}
          </Button>
        )
      })}
    </div>
  )
}

// Lives OUTSIDE the scrolling list: expanded, the list scrolls, and a toggle
// inside it would sit below the fold — no way back to one card without scrolling.
function ProviderToggle({
  expanded,
  onExpand
}: {
  expanded: boolean
  onExpand: (next: boolean) => void
}): JSX.Element {
  return (
    <Button
      variant="bare"
      onClick={() => onExpand(!expanded)}
      aria-expanded={expanded}
      className="flex items-center justify-center gap-1 w-full text-sm text-muted hover:text-on-surface transition-colors py-1.5"
    >
      {expanded
        ? CONFIG.ONBOARDING_ONE_SCREEN.providerLess
        : CONFIG.ONBOARDING_ONE_SCREEN.providerMore}
      <ChevronDown
        size={13}
        aria-hidden
        style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
      />
    </Button>
  )
}

function FixLine({
  text,
  label = CONFIG.ONBOARDING_CAPTURE.fixLabel,
  onFix = () => void window.api.setup.open()
}: {
  text: string
  label?: string
  onFix?: () => void
}): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 mt-2 flex-wrap">
      <span className="text-sm text-muted text-center">{text}</span>
      <Button variant="ghost" onClick={onFix}>
        {label}
      </Button>
    </div>
  )
}

export default function OnboardingOneScreen(): JSX.Element {
  const [checks, setChecks] = useState<PermissionCheck[] | null>(null)
  const [binaries, setBinaries] = useState<BinaryStatus[] | null>(null)
  const [backendResult, setBackendResult] = useState<BackendTestResult | null>(null)
  const [busyKey, setBusyKey] = useState<PermissionKey | null>(DEV_BUSY)
  const [backend, setBackend] = useState<BackendId | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [providersExpanded, setProvidersExpanded] = useState(DEV_EXPANDED)
  const byKey = (k: PermissionKey): PermissionCheck | undefined => checks?.find((c) => c.key === k)

  const lastChecksLogRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const next = await window.api.onboarding.getChecks()
    const line = next
      .map((c) => `${c.key}=${c.test.ok ? 'ok' : `FAIL(${c.test.detail ?? '?'})`}`)
      .join(' ')
    if (line !== lastChecksLogRef.current) {
      lastChecksLogRef.current = line
      console.log('[onboarding1:checks]', line)
    }
    setChecks(next)
    return next
  }, [])

  // Live poll + focus refresh: the mechanism that catches a grant made over in
  // System Settings. One loop for the whole screen — the wizard needed one per
  // step because each step remounted.
  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 3000)
    return () => clearInterval(id)
  }, [refresh])

  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  useEffect(() => {
    window.api.onboarding.getBinaries().then(setBinaries)
  }, [])

  // Once per kind per visit: a user landing on setup with something already
  // broken is the population most likely to bounce, so it has to be countable.
  const blockedTrackedRef = useRef<{ binaries?: boolean; backend?: boolean }>({})
  useEffect(() => {
    if (
      isReauth &&
      binaries &&
      !binaries.every((b) => b.found) &&
      !blockedTrackedRef.current.binaries
    ) {
      blockedTrackedRef.current.binaries = true
      window.api.track('onboarding_blocked_shown', { kind: 'binaries', preview: isPreview })
    }
  }, [binaries])
  useEffect(() => {
    if (backendResult && !backendResult.ok && !blockedTrackedRef.current.backend) {
      blockedTrackedRef.current.backend = true
      window.api.track('onboarding_blocked_shown', { kind: 'backend', preview: isPreview })
    }
  }, [backendResult])

  useEffect(() => {
    void (async () => {
      const [prefs, live] = await Promise.all([
        window.api.settingsGetPrefs(),
        window.api.onboarding.getChecks()
      ])
      // A DEV REPLAY is a look at FIRST RUN, so it shows the first-run default —
      // The user's real `claude` pref otherwise made the replay open on Claude. Read
      // from a live getChecks, not `checks`, which this effect races.
      const replay = live.some((c) => c.test.mocked)
      setBackend(replay ? CONFIG.DEFAULT_BACKEND : prefs.backend)
      setIsAdmin(prefs.advancedMenu)
      setBackendResult(await window.api.settingsTestBackend(prefs.backend))
    })()
  }, [])

  // The window grows with the list. Without this the scroller gets whatever is
  // left of a fixed height, which at 640 is a ~10px sliver.
  const toggleProviders = useCallback((next: boolean) => {
    setProvidersExpanded(next)
    // Optional call: a running app on a stale preload has no setHeight, and a
    // toggle that throws is worse than one that doesn't resize.
    void window.api.onboarding.setHeight?.(
      next ? CONFIG.ONBOARDING_ONE_SCREEN.heightExpanded : CONFIG.ONBOARDING_ONE_SCREEN.height
    )
  }, [])

  const handleChooseBackend = useCallback(
    async (b: BackendId) => {
      setBackend(b)
      toggleProviders(false)
      window.api.track('onboarding_provider_picked', { backend: b, preview: isPreview })
      const confirmed = await window.api.settingsSetBackend(b)
      setBackend(confirmed)
      setBackendResult(await window.api.settingsTestBackend(confirmed))
    },
    [toggleProviders]
  )

  const grantRunRef = useRef(0)

  const handleGrant = useCallback(
    async (key: PermissionKey) => {
      const run = ++grantRunRef.current
      setBusyKey(key)
      window.api.track('onboarding_grant_attempted', { key, preview: isPreview })
      try {
        // Order is load-bearing: before requestPermission (it steals focus),
        // after the pane exists (the coach anchors to that window), and gated on
        // a LIVE self-test — `checks` is a render-old copy.
        if (CONFIG.ONBOARDING_DRAG_COACH.panesWithList.includes(key)) {
          const before = await window.api.onboarding.runSelfTest(key)
          if (!before.ok) {
            await window.api.settingsOpenPane(key)
            void window.api.dragCoach.show(key)
          }
        }
        console.log(`[onboarding1:grant] ${key} pressed Allow`)
        await window.api.settingsRequestPermission(key)
        let granted = false
        let lastDetail = 'never_passed'
        for (let i = 0; i < GRANT_POLL_TRIES && run === grantRunRef.current; i++) {
          await new Promise((r) => setTimeout(r, GRANT_POLL_MS))
          const test = await window.api.onboarding.runSelfTest(key)
          console.log(
            `[onboarding1:grant] ${key} retry ${i + 1}/${GRANT_POLL_TRIES} ` +
              (test.ok
                ? 'ok'
                : `FAIL(${test.detail ?? '?'})${test.needsRestart ? ' needsRestart' : ''}`)
          )
          if (test.ok) {
            granted = true
            window.api.track('onboarding_permission_granted', { key, preview: isPreview })
            break
          }
          if (test.needsRestart) break
          lastDetail = test.detail ?? 'unknown'
        }
        if (!granted && run === grantRunRef.current) {
          window.api.track('onboarding_grant_failed', {
            key,
            detail: lastDetail,
            preview: isPreview
          })
        }
      } finally {
        await refresh()
        if (run === grantRunRef.current) setBusyKey(null)
      }
    },
    [refresh]
  )

  const accessibilityOk = !!byKey('accessibility')?.test.ok

  const chimedRef = useRef(false)
  useEffect(() => {
    if (accessibilityOk && !chimedRef.current) {
      chimedRef.current = true
      window.api.track('onboarding_required_verified')
    }
  }, [accessibilityOk])

  // The coach panel is always-on-top, so it must close itself once the thing
  // it's explaining is done — or it floats over the desktop until a quit.
  useEffect(() => {
    if (accessibilityOk) void window.api.dragCoach.close()
  }, [accessibilityOk])

  useEffect(() => {
    return () => void window.api.dragCoach.close()
  }, [])

  const ready = !!checks
  const viewTrackedRef = useRef(false)
  useEffect(() => {
    if (!ready || viewTrackedRef.current) return
    viewTrackedRef.current = true
    window.api.track('onboarding_screen_viewed', { preview: isPreview })
  }, [ready])

  // Granted-but-stale: macOS caches a per-process "denied" TCC read, so the
  // grant doesn't apply until relaunch. The restart happens ONCE, as the finish
  // action — never mid-flow, and never as a per-row button.
  const needsRestart = !!checks && checks.some((c) => c.status === 'granted' && c.test.needsRestart)

  const restartTrackedRef = useRef(false)
  useEffect(() => {
    if (needsRestart && !restartTrackedRef.current) {
      restartTrackedRef.current = true
      window.api.track('onboarding_needs_restart', { preview: isPreview })
    }
  }, [needsRestart])

  const retryBackend = useCallback(async () => {
    if (backend) setBackendResult(await window.api.settingsTestBackend(backend))
  }, [backend])

  const handleFinish = useCallback(async () => {
    // A preview must not write the completion marker or release the app-tail
    // gate — it's a look at the screen, not a real setup run.
    if (isPreview) {
      window.close()
      return
    }
    await window.api.onboarding.complete('onescreen')
    // Completion is written FIRST: the user is done, and the relaunch is our
    // chore to clear the TCC cache, not another step of theirs.
    if (needsRestart) await window.api.onboarding.restart()
  }, [needsRestart])

  if (!checks) {
    return (
      <WindowFrame title={CONFIG.ONBOARDING_ONE_SCREEN.title}>
        <LoadingBody label="Checking permissions…" />
      </WindowFrame>
    )
  }

  const copy = CONFIG.ONBOARDING_ONE_SCREEN
  const stepsCopy = CONFIG.ONBOARDING_STEPS
  const mocked = checks.some((c) => c.test.mocked)
  // One outstanding OS prompt at a time. macOS queues or drops a second dialog,
  // so with three Allow buttons live at once a fast user can fire two and lose
  // one. The rows stay visible; only the other buttons go inert.
  const anyBusy = busyKey !== null
  const allGranted = ROWS.every((k) => byKey(k)?.test.ok)
  const showingFix =
    (isReauth && !!binaries && !binaries.every((b) => b.found)) ||
    (!isReauth && !!backendResult && !backendResult.ok)

  return (
    <WindowFrame title={copy.title}>
      <div className="flex flex-col h-[calc(100vh-2.75rem)]">
        {isPreview && (
          <div
            className="shrink-0 px-5 py-1.5 text-center text-xs font-mono font-semibold w-full"
            style={{
              background: 'var(--amber-bg-subtle)',
              borderBottom: '1px solid var(--amber-border-subtle)',
              color: 'var(--amber)'
            }}
          >
            {copy.previewBanner}
          </div>
        )}
        {mocked && (
          <Button
            variant="bare"
            className="shrink-0 px-5 py-1.5 text-center text-xs font-mono font-semibold w-full"
            style={{
              background: 'var(--amber-bg-subtle)',
              borderBottom: '1px solid var(--amber-border-subtle)',
              color: 'var(--amber)'
            }}
            onClick={async () => {
              await window.api.onboarding.exitMock()
              await refresh()
            }}
          >
            {stepsCopy.mockBanner}
          </Button>
        )}

        <div className="px-5 pb-4 pt-1 flex flex-col min-h-0 flex-1">
          <div className="flex flex-col items-center text-center gap-1.5 mb-4 shrink-0">
            <span className="text-[44px] leading-none">{CONFIG.BRAND_ICON}</span>
            {/* Version rides the header so every screenshot names the build —
                the support path that works when telemetry doesn't. */}
            <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-muted bg-surface2 border border-surface3">
              v{CONFIG.APP_VERSION}
            </span>
            {isReauth ? (
              <h1 className="text-xl font-bold text-on-surface">{stepsCopy.reauthTitle}</h1>
            ) : (
              <h1 className="text-[26px] font-extrabold leading-tight text-on-surface">
                {copy.welcomePrefix}{' '}
                <span
                  style={{
                    backgroundImage: 'linear-gradient(90deg, var(--red-light), var(--accent))',
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    color: 'transparent'
                  }}
                >
                  {CONFIG.PRODUCT_NAME}
                </span>
              </h1>
            )}
            <p className="text-sm text-muted max-w-[340px]">
              {isReauth ? stepsCopy.reauthBlurb : copy.tagline}
            </p>
          </div>

          {/* The provider list is the ONLY scrolling region — an admin sees 7
              cards, which overflows 680px. Without min-h-0 the flex child
              refuses to shrink and pushes the CTA off-screen entirely.
              Collapsed it's ONE card, so flex-1 would leave a dead gap. */}
          {!isReauth && (
            <div className={'flex flex-col min-h-0 ' + (providersExpanded ? 'flex-1' : 'shrink-0')}>
              <div className="shrink-0 mb-2">
                <h2 className="flex items-center gap-2 text-md font-bold text-on-surface">
                  <Sparkles size={15} color="var(--accent)" aria-hidden />
                  {copy.providerHeading}
                </h2>
                <p className="text-sm text-muted mt-0.5 ml-[23px]">{copy.providerSub}</p>
              </div>
              <div
                className={
                  'min-h-0 -mx-1 px-1 ' + (providersExpanded ? 'overflow-y-auto flex-1 pt-1.5' : '')
                }
                style={
                  providersExpanded
                    ? {
                        maskImage:
                          'linear-gradient(to bottom, black calc(100% - 20px), transparent)',
                        WebkitMaskImage:
                          'linear-gradient(to bottom, black calc(100% - 20px), transparent)'
                      }
                    : undefined
                }
              >
                {backend && (
                  <ProviderPicker
                    backend={backend}
                    isAdmin={isAdmin}
                    expanded={providersExpanded}
                    onChoose={handleChooseBackend}
                  />
                )}
                {providersExpanded && <div className="h-5 shrink-0" aria-hidden />}
              </div>
              <div className="shrink-0">
                <ProviderToggle expanded={providersExpanded} onExpand={toggleProviders} />
              </div>
            </div>
          )}

          <div className="shrink-0 pt-3">
            <div className="mb-2">
              <h2 className="flex items-center gap-2 text-md font-bold text-on-surface">
                <ShieldCheck size={15} color="var(--accent)" aria-hidden />
                {isReauth ? copy.permsHeadingReauth : copy.permsHeading}
              </h2>
              <p className="text-sm text-muted mt-0.5 ml-[23px]">{copy.permsSub}</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {ROWS.map((key, i) => (
                <PermissionRow
                  key={key}
                  pkey={key}
                  check={byKey(key)}
                  busy={busyKey === key}
                  disabled={anyBusy && busyKey !== key}
                  onGrant={() => handleGrant(key)}
                  hintAlign={i === 0 ? 'left' : 'right'}
                />
              ))}
            </div>
            {anyBusy && <p className="text-sm text-center text-muted mt-2">{copy.waitingHint}</p>}
          </div>

          <div className="shrink-0 pt-3">
            <Button
            size="lg"
              variant="success"
              className="w-full rounded-xl"
              style={{ background: 'linear-gradient(180deg, var(--green-light), var(--green))' }}
              disabled={!accessibilityOk}
              onClick={handleFinish}
            >
              <span className="flex flex-col items-center leading-tight">
                <span className="flex items-center gap-1.5 text-lg font-bold">
                  <Zap size={15} fill="currentColor" aria-hidden />
                  {needsRestart ? copy.restartFinish : copy.done}
                </span>
                {!showingFix && (
                  <span className="text-sm font-medium opacity-90">
                    {allGranted ? copy.allSet : copy.ctaSub}
                  </span>
                )}
              </span>
            </Button>
            {/* A dead button with no reason reads as broken. Naming the one
                missing permission is the difference between a gate and a bug. */}
            {!accessibilityOk && !anyBusy && (
              <p className="text-sm text-center text-muted mt-2">{copy.gateHint}</p>
            )}
            {/* First run: every fresh Mac lacks ffmpeg until Setup downloads it,
                so this line was red for 100% of new users on their first screen. */}
            {isReauth && binaries && !binaries.every((b) => b.found) && (
              <FixLine text={CONFIG.ONBOARDING_CAPTURE.missing} />
            )}
            {needsRestart && (
              <p className="text-sm text-center text-muted mt-2">{copy.restartNote}</p>
            )}
            {backendResult &&
              !backendResult.ok &&
              !isReauth &&
              (backend === CONFIG.DEFAULT_BACKEND ? (
                <FixLine
                  text={CONFIG.ONBOARDING_BACKEND.missingOwn}
                  label={CONFIG.ONBOARDING_BACKEND.retryLabel}
                  onFix={retryBackend}
                />
              ) : (
                <FixLine text={CONFIG.ONBOARDING_BACKEND.missing} />
              ))}
            {!showingFix && !anyBusy && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-muted mt-2.5">
                <Lock size={11} aria-hidden />
                {copy.privacyFooter}
              </p>
            )}
          </div>
        </div>
      </div>
    </WindowFrame>
  )
}

// Re-exported so the tests can assert row state without mounting the window.
export { rowState }
