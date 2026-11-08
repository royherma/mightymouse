import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Clock, CornerDownLeft, Paperclip, Pencil, Pin, Plus, RotateCw, Settings, X, Zap } from 'lucide-react'
import { CONFIG } from '../../shared/config'
import { FAST_SUBMODEL } from '../../shared/model-label'
import type {
  SelectionBarAction,
  SelectionBarHistoryItem,
  SelectionBarResultPayload
} from '../../shared/types'
import { SuggestionPreview } from './components/SuggestionPreview'
import { ContextIcon } from './components/AppIcon'
import { Button } from './components/Button'

// The preview claims interactivity on OUR window, not the cursor overlay. The bar
// already catches clicks, so only the focusable half (for the edit textarea) needs
// a real call — the default claims would drive the wrong window entirely.
const BAR_CLAIMS = {
  clickable: () => () => {},
  focusable: () => {
    window.api.selectionBarSetFocusable(true)
    return () => window.api.selectionBarSetFocusable(false)
  }
}

const DRAG_SLOP_PX = 4

// The bar that pops above text the user just highlighted. Buttons only — main
// owns every decision about when this appears (see selection-watcher.ts), so
// there is no state here beyond "which buttons am I currently showing".
//
// The one exception is the gear menu: it lives here because it's pure UI, but
// opening it has to tell main to grow the window (the frame is a fixed 40px and
// would clip the dropdown).

// Titles are user-authored, and the window is a fixed width — so the chip cuts
// the text rather than the bar growing to fit it.
function truncate(label: string): string {
  const max = CONFIG.SELECTION_BAR.MAX_LABEL_CHARS
  return label.length > max ? `${label.slice(0, max - 1)}…` : label
}

export default function SelectionBarApp(): JSX.Element | null {
  const [actions, setActions] = useState<SelectionBarAction[]>([])
  const [fast, setFast] = useState(false)
  const [backendLabel, setBackendLabel] = useState('Your AI')
  const [runLabel, setRunLabel] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  // Which chip the editor is open on: a key to edit, '' for a new one, null for
  // closed. One piece of state so "editing" and "adding" can't both be true.
  const [editing, setEditing] = useState<string | null>(null)
  // An inline (Fast) run's progress, and the Ask question row. Both replace the
  // chips rather than sitting beside them — the bar is one line wide.
  const [run, setRun] = useState<SelectionBarResultPayload | null>(null)
  const [asking, setAsking] = useState(false)
  // Prompts typed into Ask before, offered under the field. Loaded on open
  // rather than sent with the bar, so keeping one updates them without a reshow.
  const [recents, setRecents] = useState<string[]>([])
  // The bar's own History list, opened from the gear menu. Like the menu it
  // REPLACES the chips rather than sitting beside them.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRows, setHistoryRows] = useState<SelectionBarHistoryItem[]>([])
  // What the current run was fired with, so a failure can be re-fired verbatim.
  // The result payload doesn't carry it, and a retry that guessed the action
  // would silently run something the user never picked.
  const lastFired = useRef<{ key: string; question?: string } | null>(null)
  const [ctxOn, setCtxOn] = useState(false)
  const [ctxApp, setCtxApp] = useState('')
  const [ctxURL, setCtxURL] = useState('')
  const [ctxLabel, setCtxLabel] = useState('')
  const grab = useRef<{ dx: number; dy: number; moved: boolean } | null>(null)
  // The resting pill, measured to size the window to its content.
  const cardRef = useRef<HTMLDivElement | null>(null)
  // Draggable for the WHOLE run, not just the finished preview: the bar lands on
  // top of the text you selected, and "move it off my sentence" is most needed
  // while it's still working — by the time the result shows, you've been blocked.
  const draggable = !!run

  useEffect(() => {
    const offShow = window.api.onSelectionBarShow((p) => {
      setActions(p.actions)
      setFast(p.fast)
      setBackendLabel(p.backendLabel)
      setRunLabel(p.runLabel)
      setCtxOn(p.ctxOn)
      setCtxApp(p.ctxApp)
      setCtxURL(p.ctxURL)
      setCtxLabel(p.ctxLabel)
      setMenuOpen(false)
      setEditing(null)
      setRun(null)
      setAsking(false)
      setHistoryOpen(false)
    })
    const offHide = window.api.onSelectionBarHide(() => {
      setActions([])
      setMenuOpen(false)
      setEditing(null)
      setRun(null)
      setAsking(false)
    })
    const offResult = window.api.onSelectionBarResult((p) => {
      setRun(p)
      // The question has been sent, so the field has done its job either way.
      setAsking(false)
    })
    return () => {
      offShow()
      offHide()
      offResult()
    }
  }, [])

  // Drive the window height off menu state, so the two can never disagree. The
  // menu grows with the chip list, and again for the open editor.
  useEffect(() => {
    const {
      HEIGHT,
      MENU_HEIGHT,
      MENU_ROW_HEIGHT,
      EDITOR_HEIGHT,
      ASK_HEIGHT,
      PREVIEW_HEIGHT,
      RECENT_ROW_HEIGHT,
      HISTORY_ROW_HEIGHT,
      HISTORY_CHROME
    } = CONFIG.SELECTION_BAR
    // Natural content width: what the row WANTS before flex resolves it. Chips
    // are `flex: 1 1 0`, so they STRETCH to fill whatever the card already is —
    // their scrollWidth just reports the current window and one chip measures the
    // same as four. A Range over the label's own text node is immune to that: it
    // gives the ink width, which plus the chip's padding is the width it needs.
    // Main clamps the total to MIN_WIDTH..MAX_WIDTH, so an absurd chip title
    // cannot make the bar wider than the screen.
    const measureWidth = (): number | undefined => {
      const card = cardRef.current
      if (!card) return undefined
      let want = 0
      for (const el of Array.from(card.children) as HTMLElement[]) {
        const style = getComputedStyle(el)
        want += parseFloat(style.marginLeft) + parseFloat(style.marginRight)
        if (!el.classList.contains('selection-bar-btn')) {
          want += el.offsetWidth
          continue
        }
        // A Range over the live chip measures what is PAINTED, which is already
        // ellipsised at the current width — so the bar could never ask for more
        // room than it had, and "Shorter" stayed "Shor…" forever. Measure an
        // off-screen clone with truncation off to get the full label instead.
        const ghost = el.cloneNode(true) as HTMLElement
        ghost.style.cssText = `${style.cssText};position:absolute;visibility:hidden;width:auto;max-width:none;overflow:visible;text-overflow:clip;flex:0 0 auto;`
        card.appendChild(ghost)
        const ink = ghost.getBoundingClientRect().width
        ghost.remove()
        want += Math.ceil(ink)
      }
      const cardStyle = getComputedStyle(card)
      const pad = parseFloat(cardStyle.paddingLeft) + parseFloat(cardStyle.paddingRight)
      const gap = parseFloat(cardStyle.columnGap || '0') * Math.max(0, card.children.length - 1)
      return Math.ceil(want + pad + gap + 2)
    }
    // The preview REPLACES the pill, so it sizes the window on its own rather
    // than adding to the bar's height.
    if (run?.state === 'done' && run.text) {
      window.api.selectionBarResize(PREVIEW_HEIGHT)
      return
    }
    if (historyOpen) {
      window.api.selectionBarResize(
        HISTORY_CHROME + Math.max(1, historyRows.length) * HISTORY_ROW_HEIGHT
      )
      return
    }
    if (!menuOpen) {
      const ask = asking ? ASK_HEIGHT + recents.length * RECENT_ROW_HEIGHT : 0
      window.api.selectionBarResize(HEIGHT + ask, measureWidth())
      return
    }
    const rows = actions.length * MENU_ROW_HEIGHT
    window.api.selectionBarResize(
      MENU_HEIGHT + rows + (editing === null ? 0 : EDITOR_HEIGHT),
      measureWidth()
    )
    // Labels, not just the count: renaming a chip changes the width the bar
    // wants without changing how many there are.
  }, [
    menuOpen,
    editing,
    asking,
    historyOpen,
    historyRows.length,
    recents.length,
    actions.map((a) => a.label).join('\u0000'),
    run
  ])

  // The list is only ever read while the field is open, so it loads on that edge
  // instead of riding along with every single time the bar appears.
  useEffect(() => {
    if (!asking) return
    void window.api.selectionBarListRecents().then(setRecents)
  }, [asking])

  useEffect(() => {
    if (!historyOpen) return
    void window.api.selectionBarListHistory().then(setHistoryRows)
  }, [historyOpen])

  // The window is focusable:false so it never costs the user their selection —
  // which also means its text fields get no keystrokes until we flip it.
  useEffect(() => {
    const needsKeys = (menuOpen && editing !== null) || asking
    window.api.selectionBarSetFocusable(needsKeys)
    return () => {
      if (needsKeys) window.api.selectionBarSetFocusable(false)
    }
  }, [menuOpen, editing, asking])

  if (actions.length === 0) return null

  const T = CONFIG.THEME_TOKENS

  // Ask leads the bar: it's the one chip that takes the user's own words, so it
  // reads as the way in rather than the leftover after the presets. Sorted here
  // rather than in DEFAULT_ACTIONS because the stored list is already on disk
  // for every existing user, and the store never re-seeds.
  const ordered = [...actions].sort((a, b) => Number(!!a.instruction) - Number(!!b.instruction))

  // Every run goes through here so `lastFired` can't drift from what main ran.
  const fire = (key: string, question?: string): void => {
    lastFired.current = { key, question }
    window.api.selectionBarAction(key, question)
  }

  const choose = (next: boolean): void => {
    setFast(next)
    setMenuOpen(false)
    void window.api.selectionBarSetFast(next)
  }

  const onIslandPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggable) return
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    grab.current = { dx: e.clientX, dy: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onIslandPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = grab.current
    if (!g) return
    if (!g.moved && Math.hypot(e.clientX - g.dx, e.clientY - g.dy) < DRAG_SLOP_PX) return
    g.moved = true
    window.api.selectionBarMove(Math.round(e.screenX - g.dx), Math.round(e.screenY - g.dy))
  }
  const onIslandPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (grab.current) e.currentTarget.releasePointerCapture(e.pointerId)
    grab.current = null
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        padding: CONFIG.SELECTION_BAR.PAD,
        WebkitAppRegion: 'no-drag',
        cursor: draggable ? 'grab' : undefined
      } as React.CSSProperties}
      onMouseEnter={() => window.api.selectionBarHover(true)}
      onMouseLeave={() => window.api.selectionBarHover(false)}
      onPointerDown={onIslandPointerDown}
      onPointerMove={onIslandPointerMove}
      onPointerUp={onIslandPointerUp}
    >
      {/* A finished run is an OFFER: the full rewrite, scrollable and editable,
          with the accept button as the only thing that touches the document. */}
      {historyOpen ? (
        <HistoryPanel
          rows={historyRows}
          onBack={() => setHistoryOpen(false)}
          onPaste={(runId) => window.api.selectionBarPasteHistory(runId)}
        />
      ) : run?.state === 'done' && run.text ? (
        <SuggestionPreview
          draft={run.text}
          confirmLabel="Replace"
          claims={BAR_CLAIMS}
          onConfirm={(finalText) => {
            setRun(null)
            window.api.selectionBarAccept(finalText)
          }}
          onClose={() => {
            setRun(null)
            window.api.selectionBarDismiss()
          }}
        />
      ) : (
      <div
        ref={cardRef}
        className="selection-bar-card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          height: CONFIG.SELECTION_BAR.HEIGHT,
          padding: '0 6px'
        }}
      >
        {run ? (
          <RunRow
            run={run}
            runLabel={runLabel}
            // Dismissing a finished run dismisses the BAR: clearing the row alone
            // would leave the chips up over text that has already been rewritten.
            onDismiss={() => {
              setRun(null)
              window.api.selectionBarDismiss()
            }}
            // Retry re-fires the same action; edit drops back to the chips with
            // the selection still live, so the user can pick a different one.
            onRetry={
              lastFired.current
                ? () => {
                    const last = lastFired.current
                    if (last) fire(last.key, last.question)
                  }
                : undefined
            }
            onEdit={() => setRun(null)}
          />
        ) : (
          <>
            {ordered.map((a) => (
              <Button
                variant="ghost"
                key={a.key}
                className={`selection-bar-btn${a.instruction ? '' : ' has-icon'}`}
                // Ask has no stored instruction, so it opens the question field
                // right here instead of firing a run with nothing to say.
                onClick={() => (a.instruction ? fire(a.key) : setAsking((v) => !v))}
                // The instruction, not the label — the label is already on the chip,
                // so repeating it tells the user nothing they can't see.
                title={a.instruction ?? `${a.label} — type your own instruction`}
                style={{ color: !a.instruction && asking ? T.accent : undefined }}
              >
                {/* The pencil says "you write this one" — the other chips run
                    something already written, and the label alone doesn't. */}
                {!a.instruction && (
                  <Pencil size={11} strokeWidth={2.2} style={{ flex: '0 0 auto' }} />
                )}
                {truncate(a.label)}
              </Button>
            ))}

            <div className="selection-bar-rule" />

            <div
              className={`ctx-toggle ${ctxOn ? 'on' : ''}`}
              onClick={() => {
                const next = !ctxOn
                setCtxOn(next)
                window.api.ctxToggle(next)
              }}
              title={
                ctxLabel
                  ? `${CONFIG.UI_LABELS.CONTEXT_TOOLTIP} ${ctxLabel}`
                  : CONFIG.UI_LABELS.CONTEXT_TOOLTIP
              }
            >
              {ctxApp ? (
                <ContextIcon app={ctxApp} url={ctxURL} size={14} />
              ) : (
                <Paperclip size={13} strokeWidth={2} />
              )}
              <div className="sw"></div>
            </div>

            <div className="selection-bar-rule" />

            {fast && (
              <span
                title={runLabel}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  color: T.accent,
                  flex: '0 0 auto',
                  padding: '0 2px'
                }}
              >
                <Zap size={12} strokeWidth={2.4} />
              </span>
            )}

            <Button
              variant="icon"
              className="selection-bar-gear"
              onClick={() => setMenuOpen((v) => !v)}
              title="Settings"
              aria-label="Settings"
              style={{ color: menuOpen || fast ? T.accent : T.muted }}
            >
              <Settings size={13} strokeWidth={2} />
            </Button>
          </>
        )}
      </div>
      )}

      {asking && !run && (
        <AskRow
          recents={recents}
          onCancel={() => setAsking(false)}
          onSend={(q) => {
            const ask = actions.find((a) => !a.instruction)
            if (ask) fire(ask.key, q)
          }}
          // Keeping is the one thing here that doesn't run anything: the field
          // stays open so the user can still type the prompt they came for.
          onKeep={(q) => {
            void window.api.selectionBarKeepRecent(q).then((r) => {
              setActions(r.actions)
              setRecents(r.recents)
            })
          }}
        />
      )}

      {menuOpen && (
        <div className="selection-bar-card" style={{ marginTop: 6, padding: 6 }}>
          <SpeedRow label="Fast" selected={fast} onClick={() => choose(true)} />
          <SpeedRow label={backendLabel} selected={!fast} onClick={() => choose(false)} />

          <div className="selection-bar-rule" style={{ width: '100%', height: 1, margin: '4px 0' }} />

          {/* Every run the bar made is already a history row — this is the way
              back to one whose paste never landed. */}
          <Button
            variant="ghost"
            className="selection-bar-menu-item"
            onClick={() => {
              setMenuOpen(false)
              setHistoryOpen(true)
            }}
            style={{ color: T.onSurface, width: '100%' }}
          >
            <Clock size={12} strokeWidth={2.2} />
            {CONFIG.UI_LABELS.SELECTION_BAR_HISTORY}
          </Button>

          <div className="selection-bar-rule" style={{ width: '100%', height: 1, margin: '4px 0' }} />

          {actions.map((a) => (
            <div key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Button
                variant="ghost"
                className="selection-bar-menu-item"
                onClick={() => setEditing(a.key)}
                title={a.instruction ?? `${a.label} — type your own instruction`}
                style={{ color: T.onSurface, flex: 1, minWidth: 0 }}
              >
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {a.label}
                </span>
              </Button>
              <Button
                variant="icon"
                className="selection-bar-menu-item"
                onClick={() => void window.api.selectionBarDeleteAction(a.key).then(setActions)}
                title={`Remove ${a.label}`}
                aria-label={`Remove ${a.label}`}
                style={{ color: T.muted, flex: '0 0 auto', width: 28, justifyContent: 'center' }}
              >
                <X size={12} strokeWidth={2.2} />
              </Button>
            </div>
          ))}

          {editing !== null ? (
            <ActionEditor
              // Remount per target: the fields seed from props, so editing a
              // second chip without this would keep the first one's text.
              key={editing}
              action={actions.find((a) => a.key === editing) ?? null}
              onCancel={() => setEditing(null)}
              onSave={(label, instruction) => {
                void window.api
                  .selectionBarSaveAction(editing || null, label, instruction)
                  .then(setActions)
                setEditing(null)
              }}
            />
          ) : (
            <div style={{ display: 'flex', gap: 2 }}>
              <Button
                variant="ghost"
                className="selection-bar-menu-item"
                onClick={() => setEditing('')}
                style={{ color: T.accent, flex: 1, justifyContent: 'center' }}
              >
                <Plus size={12} strokeWidth={2.2} />
                Add
              </Button>
              <Button
                variant="ghost"
                className="selection-bar-menu-item"
                onClick={() => void window.api.selectionBarResetActions().then(setActions)}
                style={{ color: T.muted, flex: 1, justifyContent: 'center' }}
              >
                Reset
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Relative time, coarse on purpose — the list is short and "2h" is all the
 *  disambiguation six rows ever need. */
function ago(ts: string): string {
  const then = new Date(ts).getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`
}

/** The bar's own History: only the runs IT fired, newest first. Two lines a row —
 *  what was asked, what came back — and one action, because the single reason
 *  this surface exists is a rewrite whose paste never landed. The panel's flyout
 *  is still the full record; this is the short way back to the last few. */
function HistoryPanel(props: {
  rows: SelectionBarHistoryItem[]
  onBack: () => void
  onPaste: (runId: string) => void
}): JSX.Element {
  const T = CONFIG.THEME_TOKENS

  return (
    <div className="selection-bar-card" style={{ flexDirection: 'column', alignItems: 'stretch', padding: 6, gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 4px 4px' }}>
        <Clock size={12} strokeWidth={2.2} style={{ color: T.muted, flex: '0 0 auto' }} />
        <span style={{ color: T.onSurface, fontSize: 12, fontWeight: 600, flex: 1 }}>
          {CONFIG.UI_LABELS.SELECTION_BAR_HISTORY}
        </span>
        <Button
          variant="icon"
          className="selection-bar-menu-item"
          onClick={props.onBack}
          aria-label="Back"
          style={{ color: T.muted, flex: '0 0 auto', width: 24, justifyContent: 'center' }}
        >
          <X size={12} strokeWidth={2.2} />
        </Button>
      </div>

      {props.rows.length === 0 ? (
        <div style={{ color: T.muted, fontSize: 11, padding: '6px 4px', lineHeight: 1.4 }}>
          {CONFIG.UI_LABELS.SELECTION_BAR_HISTORY_EMPTY}
        </div>
      ) : (
        props.rows.map((r) => (
          <Button
            variant="ghost"
            key={r.run_id}
            className="selection-bar-menu-item"
            // A failed run has no result, so there is nothing to paste — the row
            // stays visible (that IS the answer to "did it run?") but inert.
            disabled={!r.result}
            onClick={() => r.result && props.onPaste(r.run_id)}
            title={r.result ? CONFIG.UI_LABELS.SELECTION_BAR_HISTORY_PASTE : undefined}
            style={{
              flexDirection: 'column',
              alignItems: 'stretch',
              gap: 1,
              height: CONFIG.SELECTION_BAR.HISTORY_ROW_HEIGHT - 4,
              textAlign: 'left',
              opacity: r.result ? 1 : 0.55,
              cursor: r.result ? 'pointer' : 'default'
            }}
          >
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, width: '100%' }}>
              <span
                style={{
                  color: T.onSurface,
                  fontSize: 11,
                  fontWeight: 600,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {r.instruction}
              </span>
              <span style={{ color: T.muted, fontSize: 10, flex: '0 0 auto' }}>{ago(r.ts)}</span>
            </span>
            <span
              style={{
                color: r.result ? T.muted : T.onSurface,
                fontSize: 10,
                width: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {r.result ?? CONFIG.UI_LABELS.SELECTION_BAR_HISTORY_FAILED}
            </span>
          </Button>
        ))
      )}
    </div>
  )
}

/** The question field for Ask, under the chips. Enter sends, Escape backs out.
 *  Prompts typed before sit underneath: one tap re-runs one, the pin keeps it. */
function AskRow(props: {
  recents: string[]
  onSend: (q: string) => void
  onKeep: (q: string) => void
  onCancel: () => void
}): JSX.Element {
  const T = CONFIG.THEME_TOKENS
  const [q, setQ] = useState('')
  const ready = q.trim().length > 0

  return (
    <div
      className="selection-bar-card"
      style={{
        marginTop: 6,
        padding: '0 8px'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          height: CONFIG.SELECTION_BAR.ASK_HEIGHT - 6
        }}
      >
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && ready) props.onSend(q)
          if (e.key === 'Escape') props.onCancel()
        }}
        placeholder={CONFIG.UI_LABELS.SELECTION_BAR_ASK_PLACEHOLDER}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          background: 'transparent',
          color: T.onSurface,
          font: 'inherit',
          fontSize: 12,
          padding: '0 4px',
          outline: 'none'
        }}
      />
      <Button
        variant="icon"
        className="selection-bar-gear"
        onClick={() => ready && props.onSend(q)}
        title="Send"
        aria-label="Send"
        style={{ color: ready ? T.accent : T.muted, opacity: ready ? 1 : 0.5 }}
      >
        <CornerDownLeft size={13} strokeWidth={2.2} />
      </Button>
      </div>

      {props.recents.map((r) => (
        <div
          key={r}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            height: CONFIG.SELECTION_BAR.RECENT_ROW_HEIGHT
          }}
        >
          <Button
            variant="ghost"
            className="selection-bar-menu-item"
            onClick={() => props.onSend(r)}
            title={r}
            style={{ color: T.muted, flex: 1, minWidth: 0 }}
          >
            <span
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {r.length > CONFIG.SELECTION_BAR.MAX_RECENT_CHARS
                ? `${r.slice(0, CONFIG.SELECTION_BAR.MAX_RECENT_CHARS - 1)}…`
                : r}
            </span>
          </Button>
          <Button
            variant="icon"
            className="selection-bar-menu-item"
            onClick={() => props.onKeep(r)}
            title="Keep this as a button"
            aria-label="Keep this as a button"
            style={{ color: T.muted, flex: '0 0 auto', width: 28, justifyContent: 'center' }}
          >
            <Pin size={12} strokeWidth={2.2} />
          </Button>
        </div>
      ))}
    </div>
  )
}

/** The bar mid-run: a filling bar that reaches ~90% over the measured warm
 *  round-trip, so the wait reads as progress rather than a frozen window. */
function RunRow(props: {
  run: SelectionBarResultPayload
  runLabel: string
  onDismiss: () => void
  onRetry?: () => void
  onEdit: () => void
}): JSX.Element {
  const T = CONFIG.THEME_TOKENS
  const [pct, setPct] = useState(0)

  useEffect(() => {
    if (props.run.state !== 'running') return
    const started = Date.now()
    // A CLI run pays process startup before the model even begins, so pacing it
    // against the hosted round-trip would peg the bar at 90% for most of the wait.
    const { FAST_EXPECTED_MS, OWN_EXPECTED_MS } = CONFIG.SELECTION_BAR
    const expected = props.run.runLabel?.includes(FAST_SUBMODEL)
      ? FAST_EXPECTED_MS
      : OWN_EXPECTED_MS
    const id = setInterval(() => {
      const frac = (Date.now() - started) / expected
      // Ease toward 90 and hold: claiming 100% before the paste lands would be a
      // lie the user watches sit still.
      setPct(Math.min(90, 90 * (1 - Math.exp(-2 * frac))))
    }, 60)
    return () => clearInterval(id)
  }, [props.run.state, props.run.runLabel])

  const L = CONFIG.UI_LABELS
  if (props.run.state === 'error') {
    return (
      <>
        <span
          title={props.run.message}
          style={{
            color: T.muted,
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            padding: '0 6px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {props.run.message ?? L.SELECTION_BAR_FAST_FAILED}
        </span>
        {props.onRetry && (
          <Button
            variant="icon"
            className="selection-bar-gear"
            onClick={props.onRetry}
            title={L.SELECTION_BAR_RETRY}
            aria-label={L.SELECTION_BAR_RETRY}
            style={{ color: T.accent }}
          >
            <RotateCw size={13} strokeWidth={2.2} />
          </Button>
        )}
        <Button
          variant="icon"
          className="selection-bar-gear"
          onClick={props.onEdit}
          title={L.SELECTION_BAR_PICK_ANOTHER}
          aria-label={L.SELECTION_BAR_PICK_ANOTHER}
          style={{ color: T.muted }}
        >
          <Pencil size={13} strokeWidth={2.2} />
        </Button>
        {/* An explicit ✕: the message used to BE the button, which reads as a
            label, so there was nothing that looked like a way out. */}
        <Button
          variant="icon"
          className="selection-bar-gear"
          onClick={props.onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
          style={{ color: T.muted }}
        >
          <X size={13} strokeWidth={2.2} />
        </Button>
      </>
    )
  }

  const done = props.run.state === 'done'
  return (
    <div style={{ flex: 1, minWidth: 0, padding: '0 6px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          fontSize: 11,
          marginBottom: 4,
          whiteSpace: 'nowrap'
        }}
      >
        <span style={{ color: done ? T.accent : T.muted }}>
          {done ? L.SELECTION_BAR_DONE : L.SELECTION_BAR_RUNNING}
        </span>
        {/* Who answered. Same base·submodel shape the panel and Mighty chips use,
            so the bar can't disagree with them about the same run. */}
        <span
          style={{ color: T.muted, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {props.run.runLabel || props.runLabel}
        </span>
      </div>
      <div style={{ height: 3, borderRadius: 2, background: T.accentBorderSubtle }}>
        <div
          style={{
            height: '100%',
            width: `${done ? 100 : pct}%`,
            borderRadius: 2,
            background: T.accent,
            transition: 'width 120ms linear'
          }}
        />
      </div>
    </div>
  )
}

/** Title + prompt, inline in the expanded bar. `action` null means a new chip. */
function ActionEditor(props: {
  action: SelectionBarAction | null
  onSave: (label: string, instruction: string) => void
  onCancel: () => void
}): JSX.Element {
  const T = CONFIG.THEME_TOKENS
  const [label, setLabel] = useState(props.action?.label ?? '')
  const [instruction, setInstruction] = useState(props.action?.instruction ?? '')
  const ready = label.trim().length > 0 && instruction.trim().length > 0

  const field: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    marginTop: 4,
    padding: '5px 7px',
    borderRadius: 7,
    border: `1px solid ${T.borderDark}`,
    background: T.surface2,
    color: T.onSurface,
    font: 'inherit',
    fontSize: 12,
    outline: 'none'
  }

  return (
    <div style={{ marginTop: 4 }}>
      <input
        autoFocus
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Button name"
        maxLength={CONFIG.SELECTION_BAR.MAX_LABEL_CHARS * 2}
        style={field}
      />
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="What should it do to your text?"
        rows={2}
        style={{ ...field, resize: 'none' }}
      />
      <div style={{ display: 'flex', gap: 2, marginTop: 4 }}>
        <Button
          variant="primary"
          className="selection-bar-menu-item"
          onClick={() => ready && props.onSave(label, instruction)}
          style={{
            color: ready ? T.accent : T.muted,
            flex: 1,
            justifyContent: 'center',
            opacity: ready ? 1 : 0.5
          }}
        >
          Save
        </Button>
        <Button
          variant="ghost"
          className="selection-bar-menu-item"
          onClick={props.onCancel}
          style={{ color: T.muted, flex: 1, justifyContent: 'center' }}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

function SpeedRow(props: { label: string; selected: boolean; onClick: () => void }): JSX.Element {
  const T = CONFIG.THEME_TOKENS
  return (
    <Button
      variant="ghost"
      className="selection-bar-menu-item"
      onClick={props.onClick}
      style={{ color: T.onSurface, background: props.selected ? T.accentWash : 'transparent' }}
    >
      <span style={{ width: 14, flex: '0 0 auto', color: T.accent, display: 'flex' }}>
        {props.selected ? <Check size={12} strokeWidth={2.4} /> : null}
      </span>
      <span style={{ fontWeight: 600 }}>{props.label}</span>
    </Button>
  )
}
