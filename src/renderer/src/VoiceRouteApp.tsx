// VoiceRouteApp — "where should this go?" after a voice note.
//
// Collapsed it shows the top three destinations with a score each; hovering the
// card reveals the whole ranked list, and hovering a row its send buttons.
// Reuses .hud-shell/.hud-container so it is the same card as the HUD by
// construction, not a lookalike that drifts the next time the HUD is restyled.
//
// The card shows ONE FULL-WIDTH BAND PER KIND you switched on, stacked top to
// bottom: skills, agents, new agent. With either on, the main process sends no
// apps at all (see route-voice.ts) — picking the window to paste into is the
// worse answer once you can send the words to the thing that does the work.
// Apps are the fallback band, shown only when both are off.
import { Check, ExternalLink, GitBranch, Image, Info, Link, MonitorSmartphone, Plus, Quote, Slash, Sparkles, Terminal, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { avatarFor } from '../../shared/agent-face'
import { agentName, badgeLetter, SKELETON_WIDTHS, skillName } from './voice-route-labels'
import { ActionsSection } from './components/ActionsSection'
import { ProjectMark, VoiceRouteSearch } from './VoiceRouteSearch'
import { AppIcon } from './components/AppIcon'
import { Button } from './components/Button'
import { HoverScroll } from './components/hover-scroll'
import { EnhanceBand } from './VoiceRouteEnhance'
import { useIpcSubscriptions } from './hooks/useIpcSubscriptions'
import type {
  MightyProject,
  VoiceRouteEnhancePayload,
  VoiceRouteMode,
  VoiceRoutePayload,
  VoiceRoutePendingPayload,
  VoiceRouteResultPayload,
  VoiceRouteSent
} from '../../shared/types'

const VROUTE_ICON_SIZE = 16 // matches .vroute-icon in index.css

/** One rendered row, whichever list it came from. */
interface Row {
  sinkId: string
  label: string
  percent: number
  kind: 'app' | 'skill' | 'agent' | 'new-agent'
  description: string
  /** Mac app this row sends to, '' for skills/agents — resolves to its bundle icon. */
  appName: string
  suggested: boolean
  /** Repo the agent works in, '' otherwise — the source of the letter badge. */
  project: string
  cwd: string
  branch: string
  activity: string
}

/** Where a new agent can be started. Order is the click order: the first is
 *  what a plain row click uses. */
// 300ms — the pointer crosses a 16px gap the card does not own to reach the side menu; at 0 the menu closes mid-reach.
const TIP_CLOSE_GRACE_MS = 300

/** Rows shown per band before the card is hovered. Three made sense when the
 *  three groups sat side by side and cost one card-height between them; stacked
 *  they cost three, so the same 3 would open a ~9-row card you have to read.
 *  Two keeps the resting card near its old height while still showing a runner-
 *  up per band, which is what makes the ranking legible rather than a single
 *  pick you either take or expand past. */
const COLLAPSED_ROWS = 2

/** How many placeholder rows a skeleton band draws. Matches COLLAPSED_ROWS so
 *  the card is the height it will still be once the real rows land — a skeleton
 *  that resizes on fill is the jank it exists to prevent. */
const SKELETON_ROWS = COLLAPSED_ROWS

/** Placeholder row widths, as a percentage of the name column. Varied rather
 *  than uniform because equal-length bars read as a table being drawn, not as
 *  names arriving. Indexed by row, wrapping. */

/** Room the rest of the card needs beside the bands: the window's top offset,
 *  the shadow gutters, the head, the transcript line and the action block. The
 *  bands get the screen minus this, so a huge ranked list scrolls rather than
 *  being drawn past the bottom edge. */
const BANDS_SCREEN_RESERVE = 260

/** Longest transcript the panel prints before it starts scrolling its own box.
 *  A two-minute dictation would otherwise be the whole card. */
const SENT_TEXT_CLAMP = 600

/** What is travelling with the words, item by item. `appsOnly` flips the note
 *  at the bottom: a paste into an app is the verbatim transcript and nothing
 *  else, while a skill or agent also receives the screen line above it. */
function SentPanel({
  sent,
  appsOnly
}: {
  sent: VoiceRouteSent
  appsOnly: boolean
}): React.JSX.Element {
  const text =
    sent.transcript.length > SENT_TEXT_CLAMP
      ? `${sent.transcript.slice(0, SENT_TEXT_CLAMP)}…`
      : sent.transcript
  const hasScreen = sent.appName !== '' || sent.title !== '' || sent.url !== ''
  return (
    <div className="vroute-sent">
      <div className="vroute-sent-title">What gets sent</div>
      <div className="vroute-sent-item">
        <Quote size={11} strokeWidth={2.5} />
        <span className="vroute-sent-val">{text}</span>
      </div>
      {sent.appName !== '' && (
        <div className="vroute-sent-item">
          <MonitorSmartphone size={11} strokeWidth={2.5} />
          <span className="vroute-sent-val">
            {sent.appName}
            {sent.title !== '' && <span className="vroute-sent-dim"> — {sent.title}</span>}
          </span>
        </div>
      )}
      {sent.url !== '' && (
        <div className="vroute-sent-item">
          <Link size={11} strokeWidth={2.5} />
          <span className="vroute-sent-val is-url">{sent.url}</span>
        </div>
      )}
      {sent.screenshotName !== '' && (
        <div className="vroute-sent-item">
          <Image size={11} strokeWidth={2.5} />
          <span className="vroute-sent-val">{sent.screenshotName}</span>
        </div>
      )}
      <div className="vroute-sent-note">
        {appsOnly
          ? 'Pasting into an app sends the words only.'
          : hasScreen
            ? 'The page above goes along as one line before your words.'
            : "Nothing was readable on screen, so only your words go."}
      </div>
    </div>
  )
}

/** A frozen card for the component playground. With this set the card renders
 *  the given state and every timer, resize report and IPC subscription stays
 *  off — a preview that dismissed itself after 8s would be useless. */
export interface VoiceRoutePreview {
  route?: VoiceRoutePayload | null
  waiting?: VoiceRoutePendingPayload | null
  result?: VoiceRouteResultPayload | null
  enhance?: VoiceRouteEnhancePayload | null
}

export default function VoiceRouteApp({
  preview
}: {
  preview?: VoiceRoutePreview
} = {}): React.JSX.Element | null {
  const [route, setRoute] = useState<VoiceRoutePayload | null>(preview?.route ?? null)
  // The card before the ranking lands: the words being routed plus the bands it
  // is about to fill. Replaced by `route`, never shown alongside it.
  const [waiting, setWaiting] = useState<VoiceRoutePendingPayload | null>(
    preview?.waiting ?? null
  )
  const [result, setResult] = useState<VoiceRouteResultPayload | null>(preview?.result ?? null)
  const [projects, setProjects] = useState<MightyProject[]>([])
  useEffect(() => {
    void window.api.mighty.listProjects().then(setProjects).catch(() => {})
  }, [])
  const [hovered, setHovered] = useState('')
  // A row the user CLICKED open, which hover can no longer close. Reaching from
  // the row title down to its buttons crosses sibling rows, and each one fires
  // onMouseEnter and stole `hovered` — the menu vanished mid-reach.
  // Which bands the user clicked open, by title. Per-band and click-only: one
  // shared flag meant brushing the card unfolded all three at once, and the
  // card jumping to its full height under the pointer is the thing that makes
  // it hard to aim at the row you were already reading.
  const [openBands, setOpenBands] = useState<string[]>([])
  const cardRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const openRowRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const placeTip = useCallback(() => {
    const row = openRowRef.current
    const tip = tipRef.current
    if (!row || !tip) return
    const margin = parseFloat(getComputedStyle(tip).getPropertyValue('--hud-overhang')) || 0
    const maxTop = window.innerHeight - tip.offsetHeight - margin
    tip.style.top = `${Math.max(margin, Math.min(row.getBoundingClientRect().top, maxTop))}px`
  }, [])
  useLayoutEffect(placeTip)
  // An action card is up and waiting on a yes. Also gates the idle dismiss:
  // retiring the window would take the pending action with it.
  const [acting, setActing] = useState(false)
  const [showSent, setShowSent] = useState(false)
  const [showShot, setShowShot] = useState(false)
  const [starting, setStarting] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchPick, setSearchPick] = useState('')
  const [sending, setSending] = useState('')
  const [enhance, setEnhance] = useState<VoiceRouteEnhancePayload | null>(preview?.enhance ?? null)

  const runId = preview ? '' : (route?.runId ?? waiting?.runId ?? '')

  useIpcSubscriptions(() => preview ? [] : [
    window.api.onVoiceRoutePending((payload) => setWaiting(payload)),
    window.api.onVoiceRouteInit((payload) => {
      setRoute(payload)
      setWaiting(null)
    }),
    window.api.onVoiceRouteResult((payload) => {
      setResult(payload)
      setStarting('')
      setSending('')
    }),
    window.api.onVoiceRouteEnhanced((payload) => setEnhance(payload)),
    window.api.onVoiceRouteReset(() => {
      setRoute(null)
      setWaiting(null)
      setResult(null)
      setHovered('')
      setOpenBands([])
      setActing(false)
      setShowSent(false)
      setShowShot(false)
      setStarting('')
      setSearching(false)
      setSearchPick('')
      setSending('')
      setEnhance(null)
    }),
    window.api.onVoiceRouteSearchOpen(() => setSearching(true))
  ])

  // Report our rendered height so the window grows when a row expands on hover.
  useEffect(() => {
    const el = cardRef.current
    if (!el || !runId) return
    let last = 0
    const report = (): void => {
      const h = Math.ceil(el.offsetHeight)
      if (h > 0 && Math.abs(h - last) >= 1) {
        last = h
        window.api.voiceRouteResize(runId, h)
      }
    }
    const ro = new ResizeObserver(report)
    ro.observe(el)
    report()
    return () => ro.disconnect()
  }, [runId])

  // Width is dragged, not measured: the card grows to the left (it is anchored
  // to the HUD stack's right edge), so the handle sits on the left edge and a
  // rightward pull narrows it. Native window resizing is unavailable here — the
  // window is non-focusable, so it never receives the drag.
  const startWidthDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!runId || preview) return
      e.preventDefault()
      const startX = e.screenX
      // The CARD's width, not the window's: the window is the chip gutter wider
      // on each side, so seeding from window.innerWidth would jump the card
      // wider by that gutter the instant a drag began.
      const startWidth = e.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
      if (startWidth === 0) return
      const onMove = (ev: PointerEvent): void => {
        window.api.voiceRouteWidth(runId, startWidth + (startX - ev.screenX))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [runId, preview]
  )

  const startMoveDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (!runId || (e.target as HTMLElement).closest('button')) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      let lastX = e.screenX
      let lastY = e.screenY
      const onMove = (ev: PointerEvent): void => {
        window.api.voiceRouteMove(runId, ev.screenX - lastX, ev.screenY - lastY)
        lastX = ev.screenX
        lastY = ev.screenY
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [runId]
  )

  const dismiss = useCallback(
    (id: string): void => {
      if (preview) return
      window.api.voiceRouteDismiss(id)
    },
    [preview]
  )

  const closeCard = useCallback((): void => dismiss(runId), [dismiss, runId])

  const goTo = useCallback(
    (id: string, sinkId: string): void => {
      if (preview) return
      window.api.voiceRouteGo(id, sinkId)
    },
    [preview]
  )

  const startAgent = useCallback(
    (sinkId: string, query?: string): void => {
      if (!route || preview) return
      setStarting(sinkId)
      window.api.voiceRoutePick({ runId: route.runId, sinkId, mode: 'goto', submit: route.submitNow, query })
    },
    [route, preview]
  )

  const send = useCallback(
    (sinkId: string, mode: VoiceRouteMode, query?: string): void => {
      if (!route || preview) return
      setSending(sinkId)
      window.api.voiceRoutePick({
        runId: route.runId,
        sinkId,
        mode,
        submit: route.submitNow,
        query
      })
    },
    [route, preview]
  )

  const closeSearch = useCallback((): void => {
    setSearching(false)
    if (runId) window.api.voiceRouteSearchFocus(runId, false)
  }, [runId])

  const runEnhance = useCallback(
    (select?: number): void => {
      if (runId) window.api.voiceRouteEnhance(runId, hovered, select)
    },
    [runId, hovered]
  )

  const wantSearchFocus = useCallback((): void => {
    if (runId) window.api.voiceRouteSearchFocus(runId, true)
  }, [runId])

  // A failure that arrived while the skeleton was up belongs IN the skeleton.
  // Swapping the card for a smaller box moved the words out from under the
  // pointer that was waiting on them, which is the jump this avoids.
  const rankFailed = !route && waiting !== null && result !== null && !result.ok

  // The skeleton. Same shell, same head, same band structure as the real card
  // below — it is the ranked card with the names not yet known, so nothing moves
  // when they arrive.
  if (!route && waiting && (!result || rankFailed)) {
    return (
      <div ref={cardRef} className="hud-shell vroute-shell">
        <div className="hud-container">
          <div className="vroute-head" onPointerDown={startMoveDrag}>
            <span className="vroute-label">Where should this go?</span>
            <Button
              variant="icon"
              className="vroute-close"
              title="Just paste it here"
              aria-label="Just paste it here"
              onClick={() => dismiss(waiting.runId)}
            >
              <X size={12} strokeWidth={2.5} />
            </Button>
          </div>
          <div className="vroute-preview">{waiting.preview}</div>
          {/* Same block the real row lands in, so the card does not jump when
              the decision arrives. Mounted here too, which is what keeps the
              action subscription alive across the skeleton. */}
          <div className="vroute-do">
            {!acting && (
              <div className="vroute-do-skel">
                <div className="actions-head">
                  <span className="actions-label">Want me to…</span>
                </div>
                <div className="vroute-row is-skeleton">
                  <div className="vroute-top">
                    <span className="skeleton vroute-skel-badge" />
                    <span className="skeleton vroute-skel-name" style={{ width: SKELETON_WIDTHS[0] }} />
                    <span className="skeleton vroute-skel-pct" />
                  </div>
                </div>
              </div>
            )}
            <ActionsSection heading="Want me to…" onActive={setActing} persist onClose={closeCard} />
          </div>
          {rankFailed ? (
            <div className="vroute-failed">
              <span className="vroute-failed-text">{result.reason}</span>
              <span className="vroute-failed-buttons">
                {result.canRetry && (
                  <Button
                    variant="primary"
                    className="vroute-result-go"
                    onClick={() => {
                      setResult(null)
                      window.api.voiceRouteRetry(result.runId)
                    }}
                  >
                    Try again
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="vroute-result-go"
                  onClick={() => dismiss(result.runId)}
                >
                  Close
                </Button>
              </span>
            </div>
          ) : (
            <div className="vroute-columns" aria-busy="true">
              {waiting.bands.map((title) => (
                <div key={title} className="vroute-rows">
                  <div className="vroute-col-title">{title}</div>
                  {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                    <div key={i} className="vroute-row is-skeleton">
                      <div className="vroute-top">
                        <span className="skeleton vroute-skel-badge" />
                        <span
                          className="skeleton vroute-skel-name"
                          style={{ width: SKELETON_WIDTHS[i % SKELETON_WIDTHS.length] }}
                        />
                        <span className="skeleton vroute-skel-pct" />
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // A result that names the row it came from is printed in that row below, so
  // the ranked card stays exactly where the user's pointer left it. The box is
  // still the answer when there is no card behind it to write into.
  const inRow =
    result !== null && result.sinkId !== undefined && result.sinkId !== '' && route !== null

  if (result && !inRow) {
    return (
      <div ref={cardRef} className="hud-shell vroute-shell">
        <div className={`hud-container vroute-result${result.where ? ' is-detailed' : ''}`}>
          <span className="vroute-result-text">
            {result.ok
              ? `${result.submitted ? 'Sent to' : 'Pasted into'} ${result.appName}`
              : result.canPickAgain
                ? `Couldn't start ${result.appName}: ${result.reason}`
                : result.reason || `Couldn't reach ${result.appName}`}
          </span>
          {result.where ? <span className="vroute-result-where">{result.where}</span> : null}
          <span className="vroute-result-buttons">
          {result.canGo ? (
            // The send started something the user cannot see — a detached tmux
            // window, an agent in another surface. Without this the only proof
            // it worked is the sentence above it, which is why "I sent it
            // somewhere" reads as scary rather than done.
            <Button
              variant="primary"
              className="vroute-result-go"
              onClick={() => goTo(result.runId, '')}
            >
              Go to it
            </Button>
          ) : null}
          {result.canRetry ? (
            <Button
              variant="primary"
              className="vroute-result-go"
              onClick={() => window.api.voiceRouteRetry(result.runId)}
            >
              Try again
            </Button>
          ) : null}
          {result.canPickAgain ? (
            <Button
              variant={result.canRetry ? 'ghost' : 'primary'}
              className="vroute-result-go"
              onClick={() => setResult(null)}
            >
              Pick another
            </Button>
          ) : null}
          {!result.ok || result.where ? (
            <Button
              variant="ghost"
              className="vroute-result-go"
              onClick={() => dismiss(result.runId)}
            >
              Close
            </Button>
          ) : null}
          </span>
        </div>
      </div>
    )
  }

  if (!route) return null

  // Split what arrived into one column per kind. Skills and agents are separate
  // lists because they are different things to pick between: a skill is work you
  // start, an agent is a conversation you continue. Apps are the fallback column
  // and only arrive when both of the other two are switched off.
  // A 0% row is one Jev actively ruled out, so showing it is pure noise: the
  // real answers were being pushed off the card by ~40 of them. The suggested
  // row survives regardless, so the pre-selection can never vanish.
  const helperRows: Row[] = route.helperOptions
    .filter(
      (o) =>
        o.percent > 0 ||
        o.kind === 'new-agent' ||
        o.kind === 'agent' ||
        o.sinkId === route.suggestedHelperId ||
        o.sinkId === searchPick
    )
    .sort((a, b) => Number(b.sinkId === searchPick) - Number(a.sinkId === searchPick))
    .map((o) => ({
      sinkId: o.sinkId,
      label: o.kind === 'agent' ? agentName(o.label) : skillName(o.label),
      percent: o.percent,
      kind: o.kind,
      description: o.description,
      appName: '',
      suggested: o.sinkId === route.suggestedHelperId,
      project: o.project,
      cwd: o.cwd,
      branch: o.branch,
      activity: o.activity
    }))

  const columns: Array<{ title: string; rows: Row[] }> =
    helperRows.length > 0
      ? [
          { title: 'Skills', rows: helperRows.filter((r) => r.kind === 'skill') },
          { title: 'Agents', rows: helperRows.filter((r) => r.kind === 'agent') },
          { title: 'New agent', rows: helperRows.filter((r) => r.kind === 'new-agent') }
        ].filter((c) => c.rows.length > 0)
      : [
          {
            title: 'Apps',
            rows: route.options
              .filter((o) => o.percent > 0 || o.sinkId === route.suggestedSinkId)
              .map((o) => ({
                sinkId: o.sinkId,
                label: o.label,
                percent: o.percent,
                kind: 'app' as const,
                description: '',
                appName: o.appName,
                suggested: o.sinkId === route.suggestedSinkId,
                project: '',
                cwd: '',
                branch: '',
                activity: ''
              }))
          }
        ]

  const picked = enhance?.status === 'done' && enhance.selected >= 0 ? enhance.variants[enhance.selected] : undefined
  const sentNow = picked ? { ...route.sent, transcript: picked.text } : route.sent

  const rankedRows = columns.flatMap((column) => column.rows)
  const topRankedId =
    rankedRows.length === 0
      ? ''
      : rankedRows.reduce((best, row) => (row.percent > best.percent ? row : best)).sinkId

  return (
    <div
      ref={cardRef}
      className="hud-shell vroute-shell"
      /* Off the SCREEN, never off this window: main caps the card to the work
         area, and a cap measured from our own height would clamp the content
         that is supposed to be telling main how tall to grow. */
      style={{ '--vroute-bands-max': `${screen.availHeight - BANDS_SCREEN_RESERVE}px` } as React.CSSProperties}
    >
      <div className="hud-container">
        <div
          className="vroute-grip"
          onPointerDown={startWidthDrag}
          title="Drag to resize"
          aria-hidden="true"
        />
        <div className="vroute-head" onPointerDown={startMoveDrag}>
          <span className="vroute-label">Where should this go?</span>
          {!route.confident && <span className="vroute-unsure">pick one</span>}
          {/* Hover to read, click to keep it open while you reach for the URL.
              Next to the timer rather than down in a row: it describes the whole
              send, not one destination. */}
          <span
            className="vroute-info-wrap"
            onMouseEnter={() => setShowSent(true)}
            onMouseLeave={() => setShowSent(false)}
          >
            <Button
              variant="icon"
              className={`vroute-info${showSent ? ' is-open' : ''}`}
              aria-label="What gets sent"
              onClick={() => setShowSent((open) => !open)}
            >
              <Info size={12} strokeWidth={2.5} />
            </Button>
            {showSent && <SentPanel sent={sentNow} appsOnly={helperRows.length === 0} />}
          </span>
          <Button
            variant={enhance ? 'ghost' : 'primary'}
            className="!px-2 !text-xs"
            disabled={enhance?.status === 'running'}
            title="Rewrite what you said three better ways"
            onClick={() => runEnhance()}
          >
            <Sparkles size={12} strokeWidth={2.5} />
            {enhance ? '⌘E' : 'Rewrite 3 ways ⌘E'}
          </Button>
          {/* Dismissing still pastes the text the usual way, so ignoring the card costs nothing. */}
          <Button
            variant="icon"
            className="vroute-close"
            title="Just paste it here"
            aria-label="Just paste it here"
            onClick={() => dismiss(route.runId)}
          >
            <X size={12} strokeWidth={2.5} />
          </Button>
        </div>
        <div className="vroute-preview">{route.preview}</div>
        {route.screenshotName !== '' && (
          <div
            className="vroute-shot"
            title={route.screenshotThumb === '' ? route.screenshotName : undefined}
            onMouseEnter={() => setShowShot(true)}
            onMouseLeave={() => setShowShot(false)}
          >
            Sending your screenshot too: {route.screenshotName}
            {showShot && route.screenshotThumb !== '' && (
              <div className="vroute-sent vroute-shot-tip">
                <img src={route.screenshotThumb} alt={route.screenshotName} />
              </div>
            )}
          </div>
        )}

        {enhance && (
          <EnhanceBand
            enhance={enhance}
            original={route.sent.transcript}
            onSelect={(i) => runEnhance(i)}
            onCopy={(i) => {
              if (runId) window.api.voiceRouteEnhance(runId, hovered, i, true)
            }}
            onRetry={() => runEnhance()}
          />
        )}

        {/* Its own block, not a band in the destination list: doing the thing
            and picking where to paste are different answers to different
            questions, and stacking them read as one more place to send text. */}
        <div className="vroute-do">
          <ActionsSection
              heading="Want me to…"
              onActive={setActing}
              persist
              onClose={closeCard}
            />
        </div>

        {helperRows.length > 0 && (
          <VoiceRouteSearch
            key={searching ? 'open' : 'closed'}
            options={route.helperOptions}
            projects={projects}
            picks={route.picks}
            open={searching}
            onOpen={() => setSearching(true)}
            onClose={closeSearch}
            onWantFocus={wantSearchFocus}
            onPick={(option, query) => {
              closeSearch()
              setSearchPick(option.sinkId)
              if (option.kind === 'new-agent') startAgent(option.sinkId, query)
              else send(option.sinkId, 'paste', query)
            }}
          />
        )}

        {/* Hover only opens the ROW under the pointer now. Growing the whole
            card on hover moved the rows out from under the cursor mid-read. */}
        {!searching && (
        <div
          className="vroute-columns is-filled"
          onMouseEnter={() => window.clearTimeout(closeTimer.current)}
          onScroll={placeTip}
          onMouseLeave={() => {
            window.clearTimeout(closeTimer.current)
            closeTimer.current = window.setTimeout(() => {
              setHovered('')
            }, TIP_CLOSE_GRACE_MS)
          }}
        >
          {columns.map((column) => {
            const bandOpen = openBands.includes(column.title)
            return (
              <div key={column.title} className="vroute-rows">
                <div className="vroute-col-title">{column.title}</div>

                {column.rows.slice(0, bandOpen ? column.rows.length : COLLAPSED_ROWS).map((row) => {
                  const rowResult = inRow && result!.sinkId === row.sinkId ? result! : null
                  const isNewAgent = row.kind === 'new-agent'
                  const isOpen =
                    !isNewAgent && (hovered === row.sinkId || rowResult !== null)
                  const sentOk = rowResult !== null && rowResult.ok
                  return (
                    <div
                      key={row.sinkId}
                      ref={isOpen ? openRowRef : undefined}
                      className={`vroute-row hover-scroll-host${row.suggested ? ' is-suggested' : ''}${isOpen ? ' is-open' : ''}`}
                      style={
                        sentOk
                          ? { background: 'var(--green-bg-subtle)', borderColor: 'var(--green)' }
                          : undefined
                      }
                      onMouseEnter={() => {
                        setHovered(row.sinkId)
                      }}
                    >
                      {/* main + go side by side. The arrow used to be absolutely
                        positioned in the corner, where it sat on top of the
                        percentage; as a flex sibling it takes real width after
                        it and the two can never overlap. */}
                      <div className="vroute-top">
                        <Button
                          variant="ghost"
                          className="vroute-main"
                          onClick={() =>
                            isNewAgent
                              ? starting === '' && startAgent(row.sinkId)
                              : send(row.sinkId, 'paste')
                          }
                          title={isNewAgent && rowResult && !rowResult.ok ? rowResult.reason : row.description}
                        >
                          {row.appName !== '' ? (
                            <span className="vroute-icon">
                              <AppIcon app={row.appName} size={VROUTE_ICON_SIZE} />
                            </span>
                          ) : row.kind === 'agent' ? (
                            <ProjectMark cwd={row.cwd} projects={projects}>
                            <span
                              className="vroute-avatar"
                              title={row.project}
                              /* Keyed on the project, not the session: every agent
                             in one repo should share one colour, so the column
                             groups by sight even though the rows are ranked. */
                              style={
                                { '--face': avatarFor(row.project).color } as React.CSSProperties
                              }
                            >
                              {badgeLetter(row.project, row.label)}
                            </span>
                            </ProjectMark>
                          ) : row.kind === 'new-agent' ? (
                            <ProjectMark cwd={row.cwd} projects={projects}>
                              <span className="vroute-kind">
                                <Plus size={13} strokeWidth={2.5} />
                              </span>
                            </ProjectMark>
                          ) : (
                            <span className="vroute-kind">
                              {row.kind === 'skill' ? (
                                <Slash size={13} strokeWidth={2.5} />
                              ) : (
                                <Terminal size={13} strokeWidth={2.5} />
                              )}
                            </span>
                          )}
                          <span
                            className={`vroute-name${row.sinkId === topRankedId ? ' text-md font-semibold' : ' text-sm font-normal text-muted'}`}
                          >
                            {row.label}
                          </span>
                          {/* The reclaimed width, spent per kind: an agent's repo and
                          branch are short and bounded so they fit whole, while a
                          skill's sentence only ever fits its opening — the full
                          text stays one hover away either way. */}
                          {row.kind === 'agent' && row.project !== '' ? (
                            <span className="vroute-context">
                              {row.project}
                              {row.branch !== '' && (
                                <>
                                  <span className="vroute-context-sep">/</span>
                                  {row.branch}
                                </>
                              )}
                            </span>
                          ) : row.kind === 'skill' && row.description !== '' ? (
                            <span className="vroute-context">{row.description}</span>
                          ) : null}
                          <span className="vroute-pct">
                            {isNewAgent && rowResult
                              ? rowResult.ok
                                ? `Started in ${route.newAgentHost}`
                                : rowResult.reason || "Couldn't start"
                              : isNewAgent && starting === row.sinkId
                                ? 'Starting…'
                                : `${row.percent}%`}
                          </span>
                        </Button>
                        {isNewAgent && rowResult && (
                          <span className="flex shrink-0 gap-1 pl-1">
                            {rowResult.canGo && (
                              <Button variant="primary" onClick={() => goTo(rowResult.runId, '')}>
                                Go to it
                              </Button>
                            )}
                            {rowResult.canPickAgain && (
                              <Button
                                variant="primary"
                                onClick={() => {
                                  setResult(null)
                                  setStarting('')
                                }}
                              >
                                Try again
                              </Button>
                            )}
                            <Button variant="ghost" onClick={() => dismiss(rowResult.runId)}>
                              Close
                            </Button>
                          </span>
                        )}

                        {/* Takes you there WITHOUT sending, which is what makes it
                        a way to walk between agents rather than a second
                        delivery verb. Sibling of .vroute-main, never inside it:
                        a button cannot nest in a button. */}
                        {isOpen && route.offerGoTo && row.kind === 'agent' && (
                          <Button
                            variant="icon"
                            className="vroute-go"
                            aria-label={`Go to ${row.label}`}
                            title={`Go to ${row.label}`}
                            onClick={() => goTo(route.runId, row.sinkId)}
                          >
                            <ExternalLink size={12} strokeWidth={2.5} />
                          </Button>
                        )}
                        {!isNewAgent &&
                          (sentOk ? (
                            <span className="mr-1 flex shrink-0 items-center gap-1 text-xs font-semibold text-green">
                              <Check size={12} strokeWidth={3} />
                              {rowResult!.submitted || row.kind !== 'app' ? 'Sent' : 'Pasted'}
                            </span>
                          ) : (
                            (isOpen || row.suggested || sending === row.sinkId) &&
                            !rowResult && (
                              <Button
                                variant="success"
                                className="mr-1 shrink-0 !px-2.5 !text-xs"
                                disabled={sending !== ''}
                                onClick={() => send(row.sinkId, 'paste')}
                              >
                                {sending === row.sinkId ? 'Sending…' : row.kind === 'skill' ? 'Run' : 'Send'}
                                {row.suggested && sending === '' && ' ⏎'}
                              </Button>
                            )
                          ))}
                      </div>

                      {isOpen && (row.project !== '' || rowResult) && (
                        <div ref={tipRef} className="vroute-tip">
                          {row.project !== '' && (
                            <div className="vroute-chips">
                              <span className="vroute-chip is-project">{row.project}</span>
                              {row.branch !== '' && (
                                <span className="vroute-chip is-branch">
                                  <GitBranch size={10} strokeWidth={2.5} />
                                  {row.branch}
                                </span>
                              )}
                              {row.activity !== '' && (
                                <span
                                  className={`vroute-chip is-activity${row.activity === 'working right now' ? ' is-live' : ''}`}
                                >
                                  <span className="vroute-dot" />
                                  <HoverScroll text={row.activity} />
                                </span>
                              )}
                            </div>
                          )}
                          {row.description !== '' && row.kind === 'agent' && (
                            <div className="vroute-desc">{row.description}</div>
                          )}

                          {rowResult ? (
                            <div className={`vroute-outcome${rowResult.ok ? ' is-ok' : ''}`}>
                              <span className="vroute-outcome-text">
                                {rowResult.ok
                                  ? `${rowResult.submitted ? 'Sent to' : 'Pasted into'} ${rowResult.appName}${rowResult.where ? ` · ${rowResult.where}` : ''}`
                                  : rowResult.reason || `Couldn't reach ${rowResult.appName}`}
                              </span>
                              <span className="vroute-outcome-buttons">
                                {rowResult.canGo && (
                                  <Button variant="primary" onClick={() => goTo(rowResult.runId, '')}>
                                    Go to it
                                  </Button>
                                )}
                                {!rowResult.ok && (
                                  <Button
                                    variant="primary"
                                    onClick={() => {
                                      setResult(null)
                                      setStarting('')
                                    }}
                                  >
                                    {rowResult.canPickAgain ? 'Pick another' : 'Back'}
                                  </Button>
                                )}
                                <Button variant="ghost" onClick={() => dismiss(rowResult.runId)}>
                                  Close
                                </Button>
                              </span>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Opens THIS band only, and only on a click, so the rest of the
                  card stays where the user left it. */}
                {column.rows.length > COLLAPSED_ROWS && (
                  <Button
                    variant="ghost"
                    className="vroute-more"
                    onClick={() =>
                      setOpenBands((open) =>
                        bandOpen ? open.filter((t) => t !== column.title) : [...open, column.title]
                      )
                    }
                  >
                    {bandOpen ? 'Show less' : `${column.rows.length - COLLAPSED_ROWS} more`}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
        )}
      </div>
    </div>
  )
}
