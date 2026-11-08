import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  History,
  Zap,
  AlertCircle,
  ChevronDown,
  SlidersHorizontal,
  Check,
  RotateCw,
  Wand2,
  HelpCircle,
  PenLine,
  Mic,
  Video,
  Camera,
  Dot,
  X
} from 'lucide-react'
import { hapticTick } from './haptics'
import PhoneRemoteTitleBar from './PhoneRemoteTitleBar'
import { rowFailure } from './history-failure'
import {
  availableKinds,
  filterEntries,
  kindLabel,
  kindHue,
  getHiddenKinds,
  setHiddenKinds as persistHiddenKinds
} from './history-kinds'

/** One glyph per kind, so a row is identifiable before any text is read -- the
 *  lowercase word alone made every row look the same at a glance. Paired with
 *  KIND_HUES, never used as the only signal: color plus shape survives a
 *  colorblind reader and a washed-out screen in sunlight. */
const ACT_LONG_PRESS_MS = 500
const JUST_NOW_MS = 5 * 60_000

const KIND_ICONS: Record<string, typeof Wand2> = {
  rewrite: Wand2,
  ask: HelpCircle,
  act: Zap,
  write: PenLine,
  listen: Mic,
  recording: Video,
  screenshot: Camera
}

/** The kind badge, used by BOTH the list rows and the filter popover -- the two
 *  places a kind is named. Rendering it twice by hand is how the filter ended up
 *  showing plain grey labels for chips that were hued in the list right above it.
 *  `data-hue` carries the color; theme.css maps it to the THEME_TOKENS trio. */
function KindChip({ kind, muted }: { kind: string; muted?: boolean }): React.JSX.Element {
  const Icon = KIND_ICONS[kind] ?? Dot
  return (
    <span
      className={`historyRowKind${muted ? ' muted' : ''}`}
      data-hue={kindHue(kind) ?? undefined}
      title={kindLabel(kind)}
    >
      <Icon size={11} strokeWidth={2.5} />
      {kindLabel(kind)}
    </span>
  )
}

/** One past run. Re-exported so the existing importers keep their path -- the
 *  shape itself is the wire's, declared once in the shared protocol file. */
import type { DictationEntry } from '@shared/phone-remote-protocol'
import { Button } from '@shared/ui/Button'
export type { DictationEntry }

/** "just now" / "4m ago" / "2h ago" / "3d ago". Rendered against the PHONE's
 *  clock rather than a server-formatted string, so a row's age stays honest
 *  while the sheet sits open without the Mac having to push updates. */
function relativeTime(at: number, now: number): string {
  if (at === 0) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * History sheet: past runs, newest first. Tapping the row body re-pastes the
 * text at the Mac's cursor -- the biggest hit area gets the most common
 * action. A small Act label sits in the meta row for the second action: run
 * the same instruction as an Act on the Mac instead of pasting it, so a past
 * voice command can drive the computer again, not just re-type itself. Acting
 * takes over the Mac, so a tap asks for confirmation first; a long-press runs
 * it straight away. Both stop propagation so they don't also fire the paste.
 *
 * Paged rather than one big list: a row can carry a full LLM result, so pushing
 * every run at once would be a fat payload over a tunnel for rows the user will
 * likely never scroll to.
 */
export default function HistorySheet(props: {
  open: boolean
  entries: DictationEntry[]
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onClose: () => void
  onPaste: (id: string) => void
  onAct: (id: string) => void
  /** Glows this row once when the sheet was opened from a "done" toast tap,
   *  so the just-finished run is unmistakable even though it's already
   *  first in the newest-first list. */
  highlightId?: string | null
  /** Fires when the filter turns on or off, so the top bar's History button can
   *  carry the same dot -- a persisted filter is otherwise invisible until the
   *  sheet is open, which reads as missing history. */
  onFilterChange?: (filtering: boolean) => void
  /** Injectable for tests; defaults to the real clock. */
  now?: number
}): React.JSX.Element {
  const {
    open,
    entries,
    hasMore,
    loadingMore,
    onLoadMore,
    onClose,
    onPaste,
    onAct,
    highlightId,
    onFilterChange
  } = props
  const now = props.now ?? Date.now()
  // Which failed row is showing its stderr. One at a time: two open blocks push
  // the rest of the list off a phone screen.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Which row is showing the Act confirm strip. One at a time, same reason.
  const [confirmActId, setConfirmActId] = useState<string | null>(null)
  const actPress = useRef<{ timer: number; fired: boolean } | null>(null)

  const runAct = (id: string): void => {
    hapticTick()
    setConfirmActId(null)
    onAct(id)
    onClose()
  }
  const startActPress = (id: string): void => {
    if (actPress.current) window.clearTimeout(actPress.current.timer)
    actPress.current = {
      fired: false,
      timer: window.setTimeout(() => {
        if (actPress.current) actPress.current.fired = true
        runAct(id)
      }, ACT_LONG_PRESS_MS)
    }
  }
  const endActPress = (): void => {
    if (actPress.current && !actPress.current.fired) {
      window.clearTimeout(actPress.current.timer)
      actPress.current = null
    }
  }
  const [filterOpen, setFilterOpen] = useState(false)
  // DESELECTED kinds -- see filterEntries. Restored from localStorage so a
  // "only show me acts" choice survives closing the sheet; the top-bar dot is
  // what stops a persisted filter from reading as missing history.
  const [hiddenKinds, setHiddenKindsState] = useState<ReadonlySet<string>>(getHiddenKinds)

  // The ONE writer: state and storage move together, so no call site can set a
  // filter that silently fails to survive the next open.
  const applyHidden = (next: ReadonlySet<string>): void => {
    setHiddenKindsState(next)
    persistHiddenKinds(next)
    onFilterChange?.(next.size > 0)
  }

  // Off ALL loaded entries, never the filtered view -- deselecting the last
  // visible kind would otherwise drop its own toggle and strand the filter.
  // A filter restored from storage never passes through applyHidden, so the top
  // bar would start with no dot on a phone that IS filtering.
  useEffect(() => {
    onFilterChange?.(hiddenKinds.size > 0)
    // Mount only: every later change goes through applyHidden.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A confirm left open would greet the next open of the sheet.
  useEffect(() => {
    if (!open) setConfirmActId(null)
  }, [open])

  const kinds = useMemo(() => availableKinds(entries), [entries])
  const visible = useMemo(() => filterEntries(entries, hiddenKinds), [entries, hiddenKinds])
  const filtering = hiddenKinds.size > 0

  const toggleKind = (kind: string): void => {
    hapticTick()
    const next = new Set(hiddenKinds)
    if (next.has(kind)) next.delete(kind)
    else next.add(kind)
    applyHidden(next)
  }

  return (
    <>
      {/* Tap-outside-to-dismiss. Rendered only while open so it never eats
          touches meant for the trackpad underneath. */}
      {open && <div className="historyScrim" onClick={onClose} />}
      <div
        data-sheet
        className={`historySheet${open ? ' open' : ''}`}
        role="dialog"
        aria-label="History"
      >
        <PhoneRemoteTitleBar
          className="historyHeader"
          title={
            <>
              <History size={17} strokeWidth={2.25} />
              <span className="historyTitle">History</span>
            </>
          }
          actions={
            <>
              {kinds.length > 1 && (
                <div className="historyFilter">
                  <Button
                    variant="bare"
                    type="button"
                    className={`historyFilterBtn${filterOpen ? ' open' : ''}${
                      filtering ? ' dirty' : ''
                    }`}
                    aria-label="Filter history"
                    aria-expanded={filterOpen}
                    onClick={() => {
                      hapticTick()
                      setFilterOpen((v) => !v)
                    }}
                  >
                    <SlidersHorizontal size={15} strokeWidth={2.25} />
                    {filtering && <span className="historyFilterDot" />}
                  </Button>

                  {filterOpen && (
                    <>
                      <div className="historyFilterScrim" onClick={() => setFilterOpen(false)} />
                      <div className="historyFilterPop" role="group" aria-label="Show kinds">
                        <div className="historyFilterHead">
                          <span>Show</span>
                          <Button
                            variant="bare"
                            type="button"
                            className="historyFilterAll"
                            onClick={() => {
                              hapticTick()
                              applyHidden(filtering ? new Set() : new Set(kinds))
                            }}
                          >
                            {filtering ? 'All' : 'None'}
                          </Button>
                        </div>
                        {kinds.map((kind) => {
                          const on = !hiddenKinds.has(kind)
                          return (
                            <Button
                              variant="bare"
                              key={kind}
                              type="button"
                              className={`historyFilterRow${on ? ' on' : ''}`}
                              aria-pressed={on}
                              onClick={() => toggleKind(kind)}
                            >
                              {/* Deselected kinds render muted rather than hued: the
                              color is the "this is on" signal, so a full-strength
                              chip beside an empty checkbox reads as contradictory. */}
                              <KindChip kind={kind} muted={!on} />
                              <span className="historyFilterCheck">
                                {on && <Check size={14} strokeWidth={3} />}
                              </span>
                            </Button>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
              <Button
                variant="bare"
                type="button"
                className="historyCloseBtn phoneRemoteTitleBarCloseButton"
                aria-label="Close history"
                onClick={() => {
                  hapticTick()
                  onClose()
                }}
              >
                <X size={18} strokeWidth={2.25} />
              </Button>
            </>
          }
        />

        {entries.length === 0 ? (
          <div className="historyEmpty">
            <Mic size={16} /> Hold the mic and talk. Everything you say shows up here. Tap one to paste it on your Mac.
          </div>
        ) : visible.length === 0 ? (
          <div className="historyEmpty">
            Nothing matches this filter.{' '}
            <Button variant="bare" className="historyEmptyReset" onClick={() => applyHidden(new Set())}>
              Show all
            </Button>
          </div>
        ) : (
          <div className="historyList">
            <p className="historyHint">Everything you say shows up here. Tap one to paste it on your Mac.</p>
            {visible.map((entry, i) => {
              const failure = rowFailure(entry)
              const expanded = expandedId === entry.id
              const recent = now - entry.at < JUST_NOW_MS
              const prevRecent = i > 0 && now - visible[i - 1].at < JUST_NOW_MS
              const group = i === 0 ? (recent ? 'Just now' : null) : prevRecent && !recent ? 'Earlier' : null
              return (
                <Fragment key={entry.id}>
                {group && <div className="historyGroup">{group}</div>}
                <Button
                  variant="bare"
                  className={`historyRow${entry.id === highlightId ? ' highlight' : ''}${
                    failure ? ` failed tone-${failure.tone}` : ''
                  }`}
                  aria-expanded={failure ? expanded : undefined}
                  onClick={() => {
                    hapticTick()
                    // A tap anywhere off the confirm strip backs out of it
                    // instead of pasting -- the row's meaning changed when the
                    // question appeared.
                    if (confirmActId === entry.id) {
                      setConfirmActId(null)
                      return
                    }
                    // Not pasteable (see rowIsPasteable) -- open the error instead,
                    // and stay up so it can be read.
                    if (failure) {
                      setExpandedId(expanded ? null : entry.id)
                      return
                    }
                    onPaste(entry.id)
                    // Close on tap: the user's attention is going back to the Mac
                    // where the text lands, so leaving the sheet up would just
                    // cover the trackpad they're about to reach for.
                    onClose()
                  }}
                >
                  <div className="historyRowText">{entry.text}</div>

                  {failure && (
                    <div className="historyRowError">
                      <AlertCircle size={13} strokeWidth={2.25} />
                      <span className="historyRowErrorMsg">{failure.message}</span>
                      {failure.detail && (
                        <ChevronDown
                          size={13}
                          strokeWidth={2.25}
                          className={`historyRowChevron${expanded ? ' open' : ''}`}
                        />
                      )}
                    </div>
                  )}
                  {failure?.detail && expanded && (
                    <div className="historyRowDetail">{failure.detail}</div>
                  )}

                  <div className="historyRowMeta">
                    <span className="historyRowLeft">
                      {entry.kind !== 'listen' && <KindChip kind={entry.kind} muted />}
                      {failure && (
                        <span className={`historyRowChip ${failure.tone}`}>{failure.chip}</span>
                      )}
                      <span className="historyRowAge">{relativeTime(entry.at, now)}</span>
                    </span>
                    <span className="historyRowActions">
                      <span
                        className={`historyRowAct${failure ? ' retry' : ''}`}
                        role="button"
                        aria-label={failure ? 'Retry' : 'Do it on your Mac'}
                        tabIndex={0}
                        onPointerDown={() => {
                          if (!failure) startActPress(entry.id)
                        }}
                        onPointerUp={endActPress}
                        onPointerLeave={endActPress}
                        onPointerCancel={endActPress}
                        onClick={(e) => {
                          e.stopPropagation()
                          // The long-press already ran it; this click is the
                          // finger coming back up.
                          if (actPress.current?.fired) {
                            actPress.current = null
                            return
                          }
                          // Retry re-runs a choice already made once -- no
                          // second ask. A fresh Act confirms first.
                          if (failure) {
                            runAct(entry.id)
                            return
                          }
                          hapticTick()
                          setConfirmActId((v) => (v === entry.id ? null : entry.id))
                        }}
                      >
                        {failure ? (
                          <>
                            <RotateCw size={13} strokeWidth={2.5} />
                            Retry
                          </>
                        ) : (
                          <Zap size={15} strokeWidth={2.25} />
                        )}
                      </span>
                    </span>
                  </div>

                  {confirmActId === entry.id && !failure && (
                    <div className="historyActConfirm" onClick={(e) => e.stopPropagation()}>
                      <span className="historyActConfirmText">
                        Your Mac will actually do this, not just paste it. Long-press the bolt to skip
                        this check.
                      </span>
                      <span className="historyActConfirmBtns">
                        <span
                          role="button"
                          tabIndex={0}
                          className="historyActConfirmCancel"
                          onClick={() => {
                            hapticTick()
                            setConfirmActId(null)
                          }}
                        >
                          Cancel
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className="historyActConfirmGo"
                          onClick={() => runAct(entry.id)}
                        >
                          <Zap size={13} strokeWidth={2.5} />
                          Run it
                        </span>
                      </span>
                    </div>
                  )}
                </Button>
                </Fragment>
              )
            })}

            {hasMore && (
              <Button variant="bare" className="historyMore" onClick={onLoadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
