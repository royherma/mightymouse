/**
 * Dev-only harness for the agent-relay notification surfaces (PRD §6, §6b, §6c).
 *
 * Why this exists: a relay request renders in TWO places -- the iOS lock
 * screen and the Mac HUD row -- and the only way to see
 * any of them today is a real APNs round trip to a physical device. That loop
 * is too slow to iterate copy or layout in, so the verbs shipped without anyone
 * having looked at all four side by side. This renders every verb x surface x
 * edge case at once, from fixtures, with no server and no push.
 *
 * How real each column is, because that decides what it can be used to judge:
 *
 * - **Mac HUD** -- the real markup from HudApp.tsx's relay branch, styled by the
 *   real src/renderer/src/index.css with the real CONFIG.THEME_TOKENS injected.
 *   Not the component itself (it is welded to IPC and a ResizeObserver), but
 *   every class, string and color is the shipped one. Layout evidence.
 * - **iPhone** -- a MOCKUP, and the only column that is. iOS lays notifications
 *   out in SpringBoard, which no browser can render. Geometry here is
 *   approximate; what it IS good for is copy, truncation, which actions exist
 *   per verb, and whether the lock-screen answer path has a way in at all.
 *
 * That last point is the reason this column exists rather than being dropped:
 * `ask` is answerable from a locked phone via UNTextInputNotificationAction,
 * which is a real interaction with real states (collapsed banner -> expanded ->
 * text field -> sent), and it is the PRD's headline ship gate. Previewing it as
 * a dead placeholder would have been worse than not previewing it.
 *
 * Never imported by main.tsx. Reachable only via relay-harness.local.html.
 */

import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import type { RelayRequestWire } from '@shared/phone-remote-protocol'
import { AgentFace } from '@shared/agent-face-view'
import './theme.css'
import './skins/proII.css'
import './skins/cap.css'
import './skins/military.css'
import './skins/amethyst.css'
// The HUD column's real stylesheet. Its @tailwind directives are inert here
// (this config has no Tailwind), which is fine: every .hud-* rule is plain CSS
// against var(--token), and those tokens are injected below. Importing it is
// what makes that column real pixels instead of my approximation of them.
import '../../../renderer/src/index.css'
import './relay-harness.local.css'

/** Same call the renderer's main.tsx makes. Without it every var(--surface2) /
 *  var(--accent) in the HUD stylesheet resolves to nothing and the column
 *  renders as unstyled text that looks like a broken component. */
function injectRendererTheme(): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(CONFIG.THEME_TOKENS)) {
    root.style.setProperty(`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, value)
  }
}
injectRendererTheme()

const MINUTE = 60_000

/** Fixtures are laid out relative to a FIXED clock, not Date.now(), so the
 *  "asked 4m ago" / "times out in 90s" split renders the same on every reload.
 *  A harness whose urgent card drifts back to normal after ten minutes stops
 *  showing the state it exists to show. */
const NOW = Date.now()

/** The lock-screen action buttons, mirrored from
 *  ios/MightyMouse/RelayNotificationCategory.swift. Titles are duplicated here
 *  on purpose -- Swift cannot be imported into a Vite bundle -- so this table
 *  is the one thing in the harness that can silently go stale. It is asserted
 *  against the Swift source by relay-harness-strings.test.ts; if that test
 *  fails, the Swift file changed and this table is the thing to fix.
 *
 *  `show`/`notify` carry NO actions: neither has anything to answer, so a tap --
 *  which deep-links to that exact request -- is the whole interaction. The
 *  "Open the screen" button they used to carry was removed 2026-08-14 as a
 *  duplicate of the tap. */
const IOS_ACTIONS: Record<RelayRequestWire['verb'], string[]> = {
  ask: ['Answer'],
  approve: ['Approve', "Don't"],
  show: [],
  notify: [],
  // The picker needs the app foregrounded to draw a photo sheet, so a tap that
  // opens it IS the interaction -- a lock-screen button could not fulfil it.
  photos_get: []
}

/** `ask` is the one verb whose buttons are not fixed: the NSE registers a
 *  per-request category whose action titles ARE the agent's `options`, so this
 *  mirrors that rather than reading the table. Free text trails them and
 *  changes label when options exist, matching `answerAction(for:)` in Swift.
 *
 *  iOS renders the first two inline and collapses the rest behind a long-press.
 *  The harness shows all of them: which ones collapse is a lock-screen layout
 *  detail, and hiding them here would misreport what is reachable. */
function iosActions(request: RelayRequestWire): string[] {
  if (request.verb !== 'ask') return IOS_ACTIONS[request.verb]
  const options = request.params.options ?? []
  return options.length > 0 ? [...options, 'Something else'] : ['Answer']
}

/** Title/body exactly as NotificationService.swift rewrites them, so a copy
 *  change there shows up here rather than only on a locked phone.
 *
 *  The subtitle is NOT in the switch: the Edge function sets it from `sender`
 *  and no verb touches it, because `from` already names the agent in the
 *  header iOS draws above the card -- writing it here too printed the session
 *  twice on every notification. */
function iosContent(request: RelayRequestWire): {
  title: string
  subtitle?: string
  body: string
} {
  const { verb, params } = request
  const subtitle = params.from
  if (verb === 'ask') {
    return { title: '❓ Your Agent Needs an Answer', subtitle, body: params.question ?? '' }
  }
  if (verb === 'approve') {
    return {
      title: params.risk === 'high' ? '🔑 Your Agent Needs Your OK (Unlock Required)' : '🔑 Your Agent Needs Your OK',
      subtitle,
      body: [params.action, params.detail].filter(Boolean).join(' — ')
    }
  }
  if (verb === 'show') {
    return { title: '👀 Your Agent Sent You Something', subtitle, body: params.caption ?? '' }
  }
  // notify's title is always populated upstream (state-derived when the agent
  // passed none), so the fallback here is for a malformed wire row only.
  return { title: params.title ?? 'MightyMouse', subtitle, body: params.body ?? '' }
}

function request(
  over: Partial<RelayRequestWire> & { verb: RelayRequestWire['verb'] }
): RelayRequestWire {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    verb: over.verb,
    params: over.params ?? {},
    createdAt: over.createdAt ?? NOW - 4 * MINUTE,
    timeoutMs: over.timeoutMs ?? 10 * MINUTE,
    status: over.status ?? 'pending',
    response: over.response ?? null
  }
}

interface Scenario {
  id: string
  label: string
  /** What this row is here to catch -- the reason it earns a row rather than
   *  being one more happy-path card. */
  note: string
  request: RelayRequestWire
}

const SCENARIOS: Scenario[] = [
  {
    id: 'notify',
    label: 'notify — plain',
    note: 'No answer expected. Must not look answerable on any surface.',
    request: request({
      verb: 'notify',
      params: {
        from: 'mm-dev-298 - ShowAndTell/dev',
        title: 'Tests green',
        body: '412 passed in 38s.',
        // Mid-band, so the meter on a card body is on screen at a value that
        // proves it measures rather than pins to an end.
        progress: 0.52
      }
    })
  },
  {
    id: 'notify-error',
    label: 'notify — error level',
    note: 'level:error. The only signal is the level, so it must read as bad.',
    request: request({
      verb: 'notify',
      params: {
        from: 'mm-deploy-04 - ShowAndTell/main',
        title: 'Deploy failed',
        body: 'agent-relay-push returned 500 on the third retry.',
        level: 'error'
      }
    })
  },
  {
    id: 'ask-chips',
    label: 'ask — with option chips',
    note: 'Chips plus a free-text field. The chips must not crowd out typing.',
    request: request({
      verb: 'ask',
      params: {
        from: 'mm-dev-298 - ShowAndTell/dev',
        question: 'Which auth library do you want for the portal?',
        options: ['Lucia', 'Auth.js', 'Roll our own']
      }
    })
  },
  {
    id: 'ask-long',
    label: 'ask — long question, no chips',
    note: 'Long body with code in it. The iOS banner truncates; the card must not.',
    request: request({
      verb: 'ask',
      params: {
        from: 'mm-dev-301 - ShowAndTell/feature/agent-relay',
        question:
          'The store keys requests by request_id but the audit log keys rows by ts + verb, so a late duplicate resolve writes two rows that cannot be joined. Do you want the audit row keyed by request_id too, or should a late resolve stay a separate dropped-late row?'
      }
    })
  },
  {
    id: 'ask-urgent',
    label: 'ask — about to time out',
    note: 'Past the 3/4 mark, so the card flips from "asked ago" to "times out in".',
    request: request({
      verb: 'ask',
      params: { from: 'mm-dev-298 - ShowAndTell/dev', question: 'Ship it or hold for the review?' },
      createdAt: NOW - 9 * MINUTE,
      timeoutMs: 10 * MINUTE
    })
  },
  {
    id: 'ask-unknown',
    label: 'ask — unknown sender',
    note: 'No `from`. Must say so, never render as a card that merely lacks a chip.',
    request: request({
      verb: 'ask',
      params: { question: 'What should I name the migrations table?' }
    })
  },
  {
    id: 'approve-low',
    label: 'approve — low risk',
    note: 'Ordinary yes/no. Approve is a plain button, no unlock.',
    request: request({
      verb: 'approve',
      params: {
        from: 'mm-dev-298 - ShowAndTell/dev',
        action: 'Install 3 new dependencies',
        detail: 'zod, superjson, ts-pattern',
        risk: 'low'
      }
    })
  },
  {
    id: 'approve-high',
    label: 'approve — HIGH risk',
    note: 'Face ID gated on iOS, "Yes, do it" on the card. Must not look like the low-risk one.',
    request: request({
      verb: 'approve',
      params: {
        from: 'mm-deploy-04 - ShowAndTell/main',
        action: 'Drop and recreate the events table on prod',
        detail: '1.4M rows. This cannot be undone.',
        risk: 'high'
      }
    })
  },
  {
    id: 'show-image',
    label: 'show — image, no ack',
    note: 'Fire and forget with an attachment. iOS shows a thumbnail.',
    request: request({
      verb: 'show',
      params: {
        from: 'mm-dev-298 - ShowAndTell/dev',
        imagePath: '/tmp/diff.png',
        hasImage: true,
        caption: 'The landing hero after the copy change.'
      }
    })
  },
  {
    id: 'show-ack',
    label: 'show — waits for ack',
    note: 'wait_for_ack blocks the agent, so this one DOES need a button.',
    request: request({
      verb: 'show',
      params: {
        from: 'mm-dev-301 - ShowAndTell/feature/agent-relay',
        imagePath: '/tmp/error.png',
        hasImage: true,
        caption: 'This is the error on screen. Look before I retry.',
        waitForAck: true
      }
    })
  }
]

type IosState = 'collapsed' | 'expanded' | 'replying' | 'sent'

function IosBanner({
  request: req,
  locked,
  glance,
  onAnswer
}: {
  request: RelayRequestWire
  locked: boolean
  glance: boolean
  onAnswer: (line: string) => void
}): React.JSX.Element {
  const { title, subtitle, body } = iosContent(req)
  const actions = iosActions(req)
  const gated = req.verb === 'approve' && req.params.risk === 'high'
  const [state, setState] = useState<IosState>(glance ? 'collapsed' : 'expanded')
  const [draft, setDraft] = useState('')
  const [authed, setAuthed] = useState(false)
  const fieldRef = useRef<HTMLInputElement | null>(null)

  // The page-level switch drives all ten cards at once. It resets a card that
  // has already been answered too, because the alternative -- flipping the
  // switch and having three cards stay stuck on "Sent" -- reads as the switch
  // being broken rather than as state being preserved.
  useEffect(() => {
    setState(glance ? 'collapsed' : 'expanded')
    setAuthed(false)
  }, [glance])

  useEffect(() => {
    if (state === 'replying') fieldRef.current?.focus()
  }, [state])

  const send = (): void => {
    if (draft.trim() === '') return
    onAnswer(`iOS lock screen → ${draft.trim()}`)
    setDraft('')
    setState('sent')
  }

  const tapAction = (action: string): void => {
    if (action === 'Answer') return setState('replying')
    if (action === 'Approve' && gated && !authed) return setAuthed(true)
    onAnswer(`iOS → ${action}`)
    setState('sent')
  }

  return (
    <div className="hIosPhone" data-locked={locked ? '' : undefined}>
      <div className="hIosBanner" data-expanded={state !== 'collapsed' ? '' : undefined}>
        <div className="hIosBannerHead">
          {/* A communication notification draws the SENDER's blob at icon size
              and badges the app into its corner; a card with no `from` has no
              face to hash, so it keeps the plain app square. */}
          {req.params.from ? (
            <span className="hIosFaceWrap">
              <AgentFace id={req.params.from} size={22} />
              <span className="hIosFaceBadge" aria-hidden="true" />
            </span>
          ) : (
            <div className="hIosAppIcon" aria-hidden="true" />
          )}
          {/* A communication notification headers as `sender · group`, so a card
              with a `from` names the agent first and the app second. */}
          <span className="hIosAppName">
            {req.params.from ? `${req.params.from} · ${CONFIG.APP_NAME}` : CONFIG.APP_NAME.toUpperCase()}
          </span>
          <span className="hIosTime">now</span>
        </div>
        <div className="hIosTitle">{title}</div>
        {subtitle && <div className="hIosSubtitle">{subtitle}</div>}
        {/* Collapsed clamps to 2 lines, expanded to 4 -- the clamp IS the thing
            worth looking at, because a question that only reads in full is a
            question the lock screen cannot answer. */}
        <div className="hIosBody" data-lines={state === 'collapsed' ? '2' : '4'}>
          {body}
        </div>
        {req.params.imagePath &&
          (state === 'collapsed' ? (
            <div className="hIosThumb" aria-hidden="true" />
          ) : (
            <img className="hIosImage" src={FAKE_IMAGE} alt={req.params.caption ?? ''} />
          ))}
      </div>

      {state === 'sent' ? (
        <div className="hIosSent">Sent — the agent is unblocked.</div>
      ) : state === 'replying' ? (
        <div className="hIosReplyRow">
          <input
            ref={fieldRef}
            className="hIosReplyField"
            placeholder="Type your answer"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
          />
          <button className="hIosSend" disabled={draft.trim() === ''} onClick={send}>
            Send
          </button>
        </div>
      ) : state === 'expanded' ? (
        <>
          {gated && authed && (
            <div className="hIosAuthed">Face ID — approved, tap again to confirm</div>
          )}
          {/* The options gap is CLOSED as of 2026-08-14 -- `actions` above
              already contains the agent's own option strings for an `ask`, so
              they render below as real buttons. The struck-through "dropped by
              iOS" block that used to sit here described the old behaviour and
              would now be showing a defect that no longer exists. Only the
              inline/collapsed split remains, marked per-button. */}
          <div className="hIosActions">
            {actions.map((action, index) => (
              <button
                key={action}
                className="hIosAction"
                data-destructive={action === "Don't" ? '' : undefined}
                // iOS lays out two actions inline and puts the rest behind a
                // long-press. Marked rather than hidden: all of them ARE
                // reachable, and hiding them would misreport the card.
                data-collapsed={index >= 2 ? '' : undefined}
                onClick={() => tapAction(action)}
              >
                {action}
                {gated && action === 'Approve' && !authed && (
                  <span className="hIosFaceId">Face ID required</span>
                )}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="hIosHint">Long press to see the buttons</div>
      )}
    </div>
  )
}

/**
 * The Mac HUD row. This is HudApp.tsx's relay branch transplanted verbatim --
 * same class names, same strings, same unlock gate -- styled by the renderer's
 * own index.css. The component itself cannot be imported: it is one branch
 * inside a 900-line window that owns IPC handles, a ResizeObserver and a run
 * timer, none of which exist outside Electron.
 *
 * The strings here are therefore a copy, and copies drift. relay-harness-strings
 * .test.ts asserts every one of them against HudApp.tsx for exactly that reason.
 * When it fails, HudApp changed and THIS is what gets updated.
 */
function HudRow({
  request: req,
  onAnswer
}: {
  request: RelayRequestWire
  onAnswer: (line: string) => void
}): React.JSX.Element {
  const { params, verb } = req
  const [answer, setAnswer] = useState('')
  const [note, setNote] = useState('')

  // The HUD renders a relay card as `waiting` with a ⚡ icon and no timer --
  // a pending request is not a finished run and must never claim a ✓.
  return (
    <div className="hHudStage">
      <div className="hud-container interactive waiting">
        <div className="hud-main">
          <div className="hud-icon-wrap">⚡</div>
          <div className="hud-title">{params.from ?? 'Unknown agent'}</div>
        </div>

        {verb === 'notify' && (
          <div className="hud-body">
            {params.title}
            {params.body ? ` — ${params.body}` : ''}
          </div>
        )}
        {verb === 'ask' && <div className="hud-body">{params.question}</div>}
        {verb === 'approve' && <div className="hud-body">{params.action}</div>}

        <div className="hud-action-group">
          {verb === 'ask' && (
            <>
              {params.options && params.options.length > 0 && (
                <div className="hud-actions">
                  {params.options.map((option) => (
                    <button
                      key={option}
                      className="btn hud-action-btn"
                      onClick={() => onAnswer(`HUD chip → ${option}`)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
              <input
                className="hud-action-input"
                placeholder="Type an answer…"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && answer.trim()) {
                    onAnswer(`HUD typed → ${answer.trim()}`)
                    setAnswer('')
                  }
                }}
              />
            </>
          )}

          {verb === 'approve' && (
            <>
              {params.detail && <div className="hud-body">{params.detail}</div>}
              <div className="hud-actions">
                <button
                  className="btn hud-action-btn hud-confirm-btn"
                  onClick={() => onAnswer('HUD → approved')}
                >
                  Approve
                </button>
                <button
                  className="btn hud-action-btn hud-cancel-btn"
                  onClick={() => onAnswer('HUD → denied')}
                >
                  Deny
                </button>
              </div>
              <input
                className="hud-action-input"
                placeholder="Optional note…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          )}

          {verb === 'show' && (
            <>
              {params.imagePath && (
                <div className="hud-preview">
                  <img src={FAKE_IMAGE} alt={params.caption ?? ''} />
                </div>
              )}
              {params.caption && <div className="hud-body">{params.caption}</div>}
              {params.waitForAck && (
                <button
                  className="btn hud-action-btn hud-confirm-btn"
                  onClick={() => onAnswer('HUD → acked')}
                >
                  Got it
                </button>
              )}
            </>
          )}

          <button className="btn hud-action-copy" onClick={() => onAnswer('HUD → go to the agent')}>
            Go to the agent
          </button>
        </div>
      </div>
    </div>
  )
}

/** One scenario across all three surfaces. The row IS the comparison -- reading
 *  left to right is how you catch a verb that says three different things.
 *
 *  All three columns write into ONE log, because "first answer wins regardless
 *  of which surface it came from" (PRD §6b) is the behaviour, and a per-column
 *  log would show three independent toys instead of three doors to one request. */
function ScenarioRow({
  scenario,
  locked,
  glance
}: {
  scenario: Scenario
  locked: boolean
  glance: boolean
}): React.JSX.Element {
  const [log, setLog] = useState<string[]>([])
  const answer = (line: string): void => setLog((prev) => [line, ...prev].slice(0, 5))

  return (
    <section className="hRow">
      <header className="hRowHead">
        <h2>{scenario.label}</h2>
        <p>{scenario.note}</p>
      </header>
      <div className="hSurfaces">
        <div className="hSurface">
          <div className="hSurfaceLabel">
            iPhone — lock screen <span className="hMock">mockup</span>
          </div>
          <IosBanner
            request={scenario.request}
            locked={locked}
            glance={glance}
            onAnswer={answer}
          />
        </div>
        <div className="hSurface">
          <div className="hSurfaceLabel">
            Mac — HUD row <span className="hReal">real markup + CSS</span>
          </div>
          <HudRow request={scenario.request} onAnswer={answer} />
        </div>
      </div>
      {log.length > 0 && (
        <div className="hLog">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </section>
  )
}

/** Inline so the harness never depends on a file the Mac would have served.
 *  A real `show` card fetches over the tunnel; here the point is only that an
 *  image-shaped thing lands in the right box at the right size. */
const FAKE_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
       <rect width="320" height="180" fill="#1d2433"/>
       <rect x="16" y="16" width="180" height="12" rx="6" fill="#3d4a63"/>
       <rect x="16" y="40" width="240" height="12" rx="6" fill="#2c3648"/>
       <rect x="16" y="64" width="120" height="12" rx="6" fill="#2c3648"/>
       <text x="16" y="150" fill="#6b7a99" font-family="ui-monospace,monospace" font-size="13">agent screenshot</text>
     </svg>`
  )

/** Grid mode: every scenario at once in ONE surface, so ten cases fit on a
 *  screen or two instead of ten scroll-lengths. This is the view for judging a
 *  copy or spacing change ACROSS cases; Compare mode is for judging one case
 *  across surfaces. Neither replaces the other, so both ship. */
function SurfaceGrid({
  surface,
  locked,
  glance
}: {
  surface: 'ios' | 'hud'
  locked: boolean
  glance: boolean
}): React.JSX.Element {
  const [log, setLog] = useState<string[]>([])
  const answer = (line: string): void => setLog((prev) => [line, ...prev].slice(0, 6))

  return (
    <>
      <div className="hGrid" data-surface={surface}>
        {SCENARIOS.map((scenario) => (
          <div className="hGridCell" key={scenario.id}>
            <div className="hGridLabel">{scenario.label}</div>
            {surface === 'ios' && (
              <IosBanner
                request={scenario.request}
                locked={locked}
                glance={glance}
                onAnswer={answer}
              />
            )}
            {surface === 'hud' && <HudRow request={scenario.request} onAnswer={answer} />}
          </div>
        ))}
      </div>
      {log.length > 0 && (
        <div className="hLog hLogFixed">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
    </>
  )
}

type View = 'grid-ios' | 'grid-hud' | 'compare'

const VIEWS: { id: View; label: string }[] = [
  { id: 'grid-ios', label: 'All · iPhone' },
  { id: 'grid-hud', label: 'All · Mac HUD' },
  { id: 'compare', label: 'Compare surfaces' }
]

function Harness(): React.JSX.Element {
  const [locked, setLocked] = useState(true)
  const [glance, setGlance] = useState(false)
  const [view, setView] = useState<View>('grid-ios')

  return (
    <div className="hPage">
      <header className="hPageHead">
        <h1>Agent relay — notification surfaces</h1>
        <p>
          Every verb and edge case from fixtures. No server, no push, no device. The HUD is the real markup and stylesheet; the
          iPhone column is a mockup of iOS layout, driven by the same fixtures and the same strings
          the Swift uses.
        </p>
        <div className="hControls">
          <div className="hViewTabs" role="tablist">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={view === v.id}
                className="hViewTab"
                data-active={view === v.id || undefined}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
          <label className="hToggle">
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
            Locked screen
          </label>
          {/* One switch for all ten cards. It used to be per-card, which meant
              ten clicks to answer the question the page exists for -- "which
              verbs show which buttons". Defaults OFF (expanded) for the same
              reason: a grid of ten identical buttonless banners shows nothing. */}
          <label className="hToggle">
            <input type="checkbox" checked={glance} onChange={(e) => setGlance(e.target.checked)} />
            Glance only (collapsed, no buttons)
          </label>
        </div>
      </header>

      {view === 'compare' ? (
        SCENARIOS.map((scenario) => (
          <ScenarioRow key={scenario.id} scenario={scenario} locked={locked} glance={glance} />
        ))
      ) : (
        <SurfaceGrid
          surface={view === 'grid-ios' ? 'ios' : 'hud'}
          locked={locked}
          glance={glance}
        />
      )}

    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
)
