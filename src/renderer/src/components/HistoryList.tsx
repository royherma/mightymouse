import React, { useEffect, useRef, useState } from 'react'
import { Check, Maximize2, RotateCcw, Search, SlidersHorizontal, Waypoints, X } from 'lucide-react'
import type { FeedbackEntry, FeedbackRating, HistoryItem, RunKind, RunState } from '../../../shared/types'
import { isAppMode } from '../../../shared/mode'
import { modeChipVars, MODE_LABELS, MODE_COLORS } from '../mode-colors'
import { CONFIG } from '../../../shared/config'
import { Markdown } from './Markdown'
import { FeedbackRow } from './FeedbackRow'
import { Tooltip, useTooltip } from './Tooltip'
import { formatRunDuration } from '../hud-timer'
import { Button } from './Button'
import { CopyButton } from './CopyButton'

// Shared History view — same rows/filter/expand/copy/feedback the compact Panel's
// History flyout shows, extracted so the full-screen Mighty window can mount an
// identical "History" tab. Self-contained: fetches its own rows + filter + feedback
// state via window.api, same as PanelApp used to do inline. `onReuse`/`onContinue`
// are the only behavior that differs by host window (Panel refills its own input;
// Mighty switches to its Chat tab) — everything else lives here once.

const HISTORY_FILTER_KEYS: readonly RunKind[] = [
  'rewrite',
  'ask',
  'act',
  'write',
  'listen',
  'recording',
  'screenshot'
]

const HISTORY_FILTER_KINDS: ReadonlyArray<{ key: RunKind; label: string; color: string }> =
  HISTORY_FILTER_KEYS.map((key) => ({ key, label: MODE_LABELS[key], color: MODE_COLORS[key] }))

function kindsFromHidden(hidden: string[]): Record<RunKind, boolean> {
  const h = new Set(hidden)
  return HISTORY_FILTER_KINDS.reduce(
    (acc, k) => ({ ...acc, [k.key]: !h.has(k.key) }),
    {} as Record<RunKind, boolean>
  )
}

function hiddenFromKinds(active: Record<RunKind, boolean>): RunKind[] {
  return HISTORY_FILTER_KINDS.filter((k) => active[k.key] === false).map((k) => k.key)
}

// Only the two fields the list actually reads are compared — a deep compare of
// every entry would cost more than the render it saves.
export function sameFeedback(
  a: Record<string, FeedbackEntry>,
  b: Record<string, FeedbackEntry>
): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k]?.rating === b[k]?.rating && a[k]?.note === b[k]?.note)
}

// Every finished run re-pushes the whole recent list, so most pushes carry rows
// identical to the ones on screen. Rows are keyed by run_id but a row in flight
// still grows, so the fields that can change after the append are compared too.
export function sameHistory(a: HistoryItem[], b: HistoryItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((it, i) => {
      const o = b[i]
      return (
        it.run_id === o.run_id &&
        it.result === o.result &&
        it.ok === o.ok &&
        it.run_state === o.run_state &&
        (it.turns?.length ?? 0) === (o.turns?.length ?? 0) &&
        // The final answer grows while a run streams, and its length is the only
        // part of the thread that changes after the turn is appended.
        it.turns?.at(-1)?.a === o.turns?.at(-1)?.a
      )
    })
  )
}

/** Same relative/absolute formatting as the Panel's History flyout — kept in sync
 *  by copy rather than import so this component has no PanelApp dependency. */
function formatTs(ts: string): string {
  if (!ts) return ''
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(ts) ? ts + 'Z' : ts
  const then = new Date(utc)
  const ms = then.getTime()
  if (Number.isNaN(ms)) return ts
  const diffSec = Math.round((Date.now() - ms) / 1000)
  if (diffSec < 45) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const sameYear = then.getFullYear() === new Date().getFullYear()
  return then.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

const SEARCH_DEBOUNCE_MS = 150

/**
 * Why a run isn't ok. A plain "failed" reads as "the agent screwed up", which is
 * wrong for a run the app killed on its way out or one that's still going — and
 * now that unattended jobs can run for an hour, those are the interesting cases.
 */
function RunStateChip({ state }: { state?: RunState }): React.JSX.Element {
  if (state === 'interrupted') {
    return (
      <span className="history-row-failed" title={CONFIG.UI_LABELS.HISTORY_ROW_INTERRUPTED_TOOLTIP}>
        {CONFIG.UI_LABELS.HISTORY_ROW_INTERRUPTED}
      </span>
    )
  }
  // Still in flight: written at spawn, not settled yet. Reads as live, not broken.
  if (state === 'pending') {
    return <span className="history-row-running">{CONFIG.UI_LABELS.HISTORY_ROW_RUNNING}</span>
  }
  return <span className="history-row-failed">failed</span>
}

export function HistoryList({
  onReuse,
  onContinue,
  onClose,
  onContentChange,
  filterPopRef: filterPopRefProp,
  className = ''
}: {
  /** Refill the host's own input with this instruction (mode = it.mode for LLM rows, else 'ask'). */
  onReuse: (item: HistoryItem) => void
  /** Resume this run's thread in the host's own chat surface. */
  onContinue: (item: HistoryItem) => void
  /** Panel renders this as a dismissable flyout (shows an × button); Mighty mounts
   *  it as a standing tab and omits this — there's nothing to close. */
  onClose?: () => void
  /** Fires whenever rows/expand/filter state changes the rendered height — the
   *  Panel host uses this to re-fit its auto-sized BrowserWindow (it used to key a
   *  ResizeObserver effect directly off historyItems/expandedRunId/filterOpen,
   *  which now live in here instead of at the panel's top level). */
  onContentChange?: () => void
  /** Panel's measureAndReport reads this ref directly (it's position:absolute, so
   *  it doesn't grow the flow layout and needs to be measured separately to keep
   *  the auto-sized window tall enough to show it uncropped). Mighty's tab has no
   *  such auto-sizing, so it omits this and an internal ref is used instead. */
  filterPopRef?: React.RefObject<HTMLDivElement | null>
  /** Extra class on the outer wrapper — lets the host override .history-flyout's
   *  popup-sized max-height/margin for a full-screen tab layout. */
  className?: string
}): React.ReactElement {
  const { tip, hoverProps } = useTooltip()
  const [items, setItems] = useState<HistoryItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeKinds, setActiveKinds] = useState<Record<RunKind, boolean>>(() =>
    kindsFromHidden([])
  )
  const [feedbackEnabled, setFeedbackEnabled] = useState(true)
  const [showTiming, setShowTiming] = useState(true)
  const [canRoute, setCanRoute] = useState(false)
  const [routingRunId, setRoutingRunId] = useState<string | null>(null)
  const [feedbackByRun, setFeedbackByRun] = useState<Record<string, FeedbackEntry>>({})
  const filterRef = useRef<HTMLDivElement>(null)
  const filterPopRefOwn = useRef<HTMLDivElement>(null)
  const filterPopRef = filterPopRefProp ?? filterPopRefOwn

  useEffect(() => {
    void window.api.settingsGetPrefs().then((p) => {
      setActiveKinds(kindsFromHidden(p.historyFilterHidden ?? []))
      setFeedbackEnabled(p.feedbackEnabled)
      setShowTiming(p.showTiming)
    })
    void window.api.voiceRoutingConfigGet().then((cfg) => setCanRoute(cfg.mode !== 'off'))
  }, [])

  useEffect(() => {
    setItems([])
    setLoaded(false)
    return window.api.onHistoryData((rows) => {
      setItems((prev) => (sameHistory(prev, rows) ? prev : rows))
      setLoaded(true)
      // A fresh object every push would re-render the list even when the rows
      // above were unchanged, so only swap when a rating/note actually differs.
      void window.api.feedbackList().then((next) => {
        setFeedbackByRun((prev) => (sameFeedback(prev, next) ? prev : next))
      })
    })
  }, [])

  useEffect(() => {
    const q = query.trim()
    const t = setTimeout(() => window.api.historyRequest(q), q ? SEARCH_DEBOUNCE_MS : 0)
    return () => clearTimeout(t)
  }, [query])

  // activeKinds belongs here: filtering changes how many rows render, so it changes
  // the height the panel window must be measured against. Omitting it let a filter
  // that SHRANK the list (deselect-all → the single empty row) leave the window at
  // its old size, clipping the filter popup against the stale bottom edge.
  useEffect(() => {
    onContentChange?.()
  }, [items, expandedRunId, filterOpen, activeKinds, onContentChange])

  useEffect(() => {
    if (!filterOpen) return
    const onClick = (e: MouseEvent): void => {
      if (
        !filterRef.current?.contains(e.target as Node) &&
        !filterPopRef.current?.contains(e.target as Node)
      ) {
        setFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [filterOpen])

  const toggleItem = (item: HistoryItem): void => {
    setExpandedRunId((cur) => (cur === item.run_id ? null : item.run_id))
  }

  const applyKinds = (next: Record<RunKind, boolean>): void => {
    setActiveKinds(next)
    window.api.settingsSetHistoryFilter(hiddenFromKinds(next))
  }

  const toggleKind = (key: RunKind): void => {
    applyKinds({ ...activeKinds, [key]: !activeKinds[key] })
  }

  const visibleHistory = items.filter((it) => activeKinds[it.mode] !== false)
  const someFilterOff = HISTORY_FILTER_KINDS.some((k) => !activeKinds[k.key])

  const submitFeedback = (runId: string, rating: FeedbackRating | null, note?: string): void => {
    setFeedbackByRun((prev) => ({
      ...prev,
      [runId]: { run_id: runId, rating, note, ts: prev[runId]?.ts ?? '' }
    }))
    window.api.feedbackSubmit(runId, rating, note).then((entry) => {
      if (entry) setFeedbackByRun((prev) => ({ ...prev, [runId]: entry }))
    })
  }

  return (
    <div className={`history-flyout visible ${className}`}>
      <Tooltip tip={tip} />
      <div className="history-flyout-header">
        <span>History</span>
        <div className="history-header-actions">
          <div className="history-filter" ref={filterRef}>
            <Button
              variant="bare"
              className={`history-filter-btn ${filterOpen ? 'active' : ''} ${someFilterOff ? 'dirty' : ''}`}
              onClick={() => setFilterOpen((v) => !v)}
              aria-label="Filter history"
              {...hoverProps('Filter what shows')}
            >
              <SlidersHorizontal size={13} strokeWidth={2.25} />
              {someFilterOff && <span className="history-filter-dot" />}
            </Button>
            {filterOpen && (
              <div className="history-filter-pop" ref={filterPopRef}>
                <div className="history-filter-pop-head">
                  <span>Show</span>
                  <Button
                    variant="bare"
                    className="history-filter-all"
                    onClick={() =>
                      applyKinds(
                        someFilterOff
                          ? kindsFromHidden([])
                          : kindsFromHidden(HISTORY_FILTER_KINDS.map((k) => k.key))
                      )
                    }
                  >
                    {someFilterOff ? 'All' : 'None'}
                  </Button>
                </div>
                {HISTORY_FILTER_KINDS.map((k) => {
                  const on = activeKinds[k.key] !== false
                  return (
                    <Button
                      variant="bare"
                      key={k.key}
                      className={`history-filter-row ${on ? 'on' : ''}`}
                      onClick={() => toggleKind(k.key)}
                    >
                      <span className="history-filter-swatch" style={{ background: k.color }} />
                      <span className="history-filter-label">{k.label}</span>
                      <span className="history-filter-check">
                        {on && <Check size={13} strokeWidth={3} />}
                      </span>
                    </Button>
                  )
                })}
              </div>
            )}
          </div>
          {onClose && (
            <Button variant="bare" className="history-close" onClick={onClose}>
              ×
            </Button>
          )}
        </div>
      </div>
      <div className="history-search">
        <div className="code-session-search">
          <Search size={13} strokeWidth={2.5} aria-hidden="true" />
          <input
            className="code-session-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape' || query === '') return
              e.stopPropagation()
              setQuery('')
            }}
            placeholder={CONFIG.UI_LABELS.HISTORY_SEARCH}
            aria-label="Search history"
          />
          {query && (
            <Button
              variant="bare"
              className="code-session-search-clear"
              onClick={() => setQuery('')}
              title="Clear"
            >
              <X size={12} strokeWidth={2.5} />
            </Button>
          )}
        </div>
      </div>
      <div className="history-list">
        {!loaded ? (
          <div className="history-empty history-loading">
            <span className="spinner" />
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="history-empty">
            {query.trim()
              ? CONFIG.UI_LABELS.HISTORY_SEARCH_EMPTY.replace('{q}', query.trim())
              : 'No history yet.'}
          </div>
        ) : visibleHistory.length === 0 ? (
          <div className="history-empty">Nothing matches the filter.</div>
        ) : (
          visibleHistory.map((it, idx) => {
            const expanded = expandedRunId === it.run_id
            const hasResult = !!(it.result && it.result.trim() !== '')
            // listen / recording / screenshot — everything that isn't an LLM mode.
            const isCapture = !isAppMode(it.mode)
            const hasWords =
              !isCapture ||
              it.instruction !==
                CONFIG.CAPTURE_HISTORY_LABEL[it.mode as keyof typeof CONFIG.CAPTURE_HISTORY_LABEL]
            const routing = routingRunId === it.run_id
            return (
              <div key={it.run_id || idx} className={`history-row ${expanded ? 'expanded' : ''}`}>
                <div className="history-row-head" onClick={() => toggleItem(it)}>
                  <span className="history-row-mode" style={modeChipVars(it.mode)}>
                    {MODE_LABELS[it.mode]}
                  </span>
                  <div className="history-row-body">
                    <div className="history-row-text">{it.instruction}</div>
                    <div className="history-row-meta">
                      <span title={it.ts}>{formatTs(it.ts)}</span>
                      {showTiming && typeof it.duration_ms === 'number' && (
                        <span>{formatRunDuration(it.duration_ms)}</span>
                      )}
                      {it.backend && <span>{it.backend}</span>}
                      {!it.ok && <RunStateChip state={it.run_state} />}
                    </div>
                  </div>
                  {/* Open-in-Finder is hidden for now: a run folder is a developer
                      detail, and three icons per row crowded the ones people
                      actually use. `open_path` is still carried on the item, so
                      restoring this is uncommenting it. */}
                  {canRoute && hasWords && (
                    <Button
                      variant="bare"
                      className={`history-reuse-icon ${routing ? 'routing' : ''}`}
                      disabled={routingRunId !== null}
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        setRoutingRunId(it.run_id)
                        void window.api
                          .voiceRouteFromHistory(it.run_id)
                          .finally(() => setRoutingRunId(null))
                      }}
                      aria-label="Action Route"
                      {...hoverProps(
                        routing
                          ? CONFIG.UI_LABELS.ROUTE_FINDING_TOOLTIP
                          : CONFIG.UI_LABELS.ROUTE_TOOLTIP
                      )}
                    >
                      {routing ? (
                        <span className="spinner" />
                      ) : (
                        <Waypoints size={14} strokeWidth={2.25} />
                      )}
                    </Button>
                  )}
                  {(isCapture ? hasResult : (it.turns?.length ?? 0) > 0 || hasResult) && (
                    <Button
                      variant="bare"
                      className="history-reuse-icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        onContinue(it)
                      }}
                      aria-label={isCapture ? 'Start a chat from this' : 'Continue in full chat'}
                      {...hoverProps(
                        isCapture
                          ? CONFIG.UI_LABELS.START_CONVO_TOOLTIP
                          : CONFIG.UI_LABELS.CONTINUE_TOOLTIP
                      )}
                    >
                      <Maximize2 size={14} strokeWidth={2.25} />
                    </Button>
                  )}
                  {/* Reuse refills the box with the instruction so you can re-run it.
                      That's meaningless for a capture: a transcript is something you
                      talk ABOUT, not an instruction to run again — so captures get
                      "start a chat from this" (above) as their only action. */}
                  {!isCapture && (
                    <Button
                      variant="bare"
                      className="history-reuse-icon"
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        onReuse(it)
                      }}
                      aria-label="Reuse"
                      {...hoverProps(CONFIG.UI_LABELS.REUSE_TOOLTIP)}
                    >
                      <RotateCcw size={14} strokeWidth={2.25} />
                    </Button>
                  )}
                  <span className="history-row-caret">{expanded ? '▴' : '▾'}</span>
                </div>
                {expanded && (
                  <div className="history-row-detail">
                    {it.turns && it.turns.length > 0 ? (
                      <div className="history-thread">
                        {it.turns.map((turn, ti) => {
                          return (
                            <React.Fragment key={ti}>
                              <div className="msg q">
                                <div className="bubble">
                                  {turn.q}
                                  <span className="contents" onClick={(e) => e.stopPropagation()}>
                                    <CopyButton label="Copy message" text={turn.q} className="bubble-copy" />
                                  </span>
                                </div>
                              </div>
                              <div className="msg a">
                                <div className="bubble">
                                  <Markdown>{turn.a}</Markdown>
                                  <span className="contents" onClick={(e) => e.stopPropagation()}>
                                    <CopyButton label="Copy message" text={turn.a} className="bubble-copy" />
                                  </span>
                                </div>
                              </div>
                            </React.Fragment>
                          )
                        })}
                      </div>
                    ) : hasResult ? (
                      <>
                        <div className="history-result">
                          <Markdown>{it.result ?? ''}</Markdown>
                        </div>
                        <div className="history-row-actions">
                          <span className="contents" onClick={(e) => e.stopPropagation()}>
                            <CopyButton showLabel label="Copy" text={it.result ?? ''} />
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="history-row-actions">
                        <span className="history-no-result">No result saved.</span>
                      </div>
                    )}
                    {feedbackEnabled && (!isAppMode(it.mode) || it.turns?.length || hasResult) && (
                      <FeedbackRow
                        rating={feedbackByRun[it.run_id]?.rating ?? null}
                        note={feedbackByRun[it.run_id]?.note ?? null}
                        noteOnly={!isAppMode(it.mode)}
                        onSubmit={(rating, note) => submitFeedback(it.run_id, rating, note)}
                      />
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
