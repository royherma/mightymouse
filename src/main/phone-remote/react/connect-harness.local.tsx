/**
 * Dev-only harness for every "you are not driving your Mac yet" screen —
 * the pairing + connection gates in `hooks/use-mirror.tsx` (~5646-5810).
 *
 * Why this exists: those gates are the FIRST thing a new user sees and the
 * only thing they see when something goes wrong, and until now the sole way
 * to look at one was to cause it on a real phone — revoke a credential, fill
 * the viewer slot, spend the rate limiter. Several of the eleven have almost
 * certainly never been looked at. `mac-busy`'s three forks in particular
 * decide what "you were kicked out" says, which is exactly the copy nobody
 * could see.
 *
 * How real this is, because that decides what it can be used to judge:
 *
 * - The frames render the REAL `TerminalState` / `PairDeviceForm` /
 *   `ApprovalWaiting` / `.bootGate` markup, styled by the real `theme.css`
 *   plus the real skin. Layout, copy and contrast are all evidence.
 * - The `title`/`body`/`action` values are TRANSCRIBED from use-mirror's
 *   branches, not imported — the gates are inline JSX inside a 5,800-line
 *   component with no seam to call. `connect-harness-parity.test.ts` fails
 *   the build when a string here and the string there drift apart, which is
 *   the only thing making a copy trustworthy as evidence.
 *
 * Never imported by main.tsx. Reachable only via connect-harness.local.html.
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import { BLOCKED_REASON_INFO } from '../connection-state'
import type { BlockedReason } from '../connection-state'
import { KeyRound, Radar, RadioTower, Smartphone, Timer, UserRound } from 'lucide-react'
import { TerminalBack, TerminalState, UnpairButton } from './TerminalState'
import { ApprovalWaiting } from './ApprovalPrompt'
import { PairDeviceForm } from './PairDeviceForm'
import { Button } from '@shared/ui/Button'
import ReconnectBanner from './ReconnectBanner'
import './theme.css'
import './skins/proII.css'
import './skins/cap.css'
import './skins/military.css'
import './skins/amethyst.css'
import './connect-harness.local.css'

/** The same call `main.tsx` makes on boot. Without it every `var(--bg)`,
 *  `var(--accent)` and type token the gates are built from resolves to nothing,
 *  and all fifteen render as black boxes in the browser default font -- which
 *  is exactly how this harness shipped its first draft. The tokens live in
 *  CONFIG, camelCase, and are kebab on the wire. */
function injectTheme(): void {
  const root = document.documentElement
  for (const [key, val] of Object.entries(CONFIG.THEME_TOKENS)) {
    root.style.setProperty(`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, val)
  }
}
injectTheme()

/** The gates read `expiresAt` as an absolute epoch and count down from it. A
 *  fixed offset keeps every screenshot showing the same number instead of a
 *  value that ticks while you read the page. */
const APPROVAL_EXPIRES_AT = Date.now() + 30_000

/** No-op: every action here would reach a Mac the harness has none of. The
 *  buttons still render and still respond, which is the point — their size,
 *  wrap and stacking are the thing being judged. */
const noop = (): void => {}

type Group = 'native' | 'blocked' | 'waiting' | 'transient'

/** Which host the screen belongs to. The native shell and the web bundle each
 *  own a slice of the connect flow and they look nothing alike, so a frame that
 *  does not say which one it is gets read as the other -- which is exactly how
 *  the SwiftUI lobby went missing from this harness for months. */
type Shell = 'native' | 'web'

interface Scenario {
  id: string
  /** The short label on the tab. */
  label: string
  group: Group
  /** Defaults to `web` -- everything below the native lobby is the bundle. */
  shell?: Shell
  /** Which `ConnState` / branch in use-mirror produces this, so a reader can
   *  get from a screenshot back to the code that made it. */
  origin: string
  /** What the user actually did to land here, in their own terms. */
  trigger: string
  /** Anything worth knowing that the picture cannot show. */
  note?: string
  render: () => React.JSX.Element
}

function CantFindMac({ macPageUrl }: { macPageUrl?: string }): React.JSX.Element {
  return (
    <TerminalState
      icon={RadioTower}
      title="Can’t find your Mac"
      body="Make sure MightyMouse is open on your Mac and you’re on the same Wi-Fi."
      onBack={noop}
      backConfirm="Unpair this phone"
    >
      <Button variant="bare" className="strandedGuardBtn" onClick={noop}>
        Try again
      </Button>
      <UnpairButton label="Unpair this phone" onUnpair={noop} />
      <div className="pairOrDivider">or pair again</div>
      <PairDeviceForm onPaired={noop} />
      {macPageUrl && (
        <div className="strandedGuardBody">
          Still stuck?{' '}
          <a className="strandedGuardLink" href={macPageUrl} target="_blank" rel="noreferrer">
            Open your Mac’s page
          </a>
          . If Safari shows a warning, tap Show Details, then “visit this website”.
        </div>
      )}
    </TerminalState>
  )
}

/* ── The eleven screens, in the order use-mirror decides them ───────────── */

const SCENARIOS: Scenario[] = [
  {
    id: 'busy-evicted',
    label: 'Kicked out',
    group: 'blocked',
    origin: 'blocked · mac-busy (evicted, no-room, cursorless)',
    trigger: 'Another device has the Mac: it took control from this phone, or every slot is taken.',
    note: 'One screen for every busy case. The title names the other device when the Mac sent one. A cursorless host (glasses) gets no Take control — the Mac refuses its takeover.',
    render: () => (
      <TerminalState
        icon={UserRound}
        tier="blocked"
        title="Another device is using your Mac"
        body="Take control to use it here. The other device will stop."
        action={{ label: 'Take control', onClick: noop }}
      />
    )
  },
  {
    id: 'no-credential',
    label: 'Never paired',
    group: 'blocked',
    origin: 'blocked · no-credential / credential-revoked',
    trigger: 'This phone has no credential — a fresh install, wiped storage, or the Mac disconnected it.',
    note: 'No retry button: reconnecting with nothing can only fail, so the code form IS the action. When the Mac disconnected it, one line sits on top: "This phone was disconnected in MightyMouse settings."',
    render: () => (
      <TerminalState
        icon={KeyRound}
        title="Let’s connect your Mac"
        onBack={noop}
      >
        <PairDeviceForm onPaired={noop} />
      </TerminalState>
    )
  },
  {
    id: 'unreachable-safari',
    label: 'Unreachable (Safari)',
    group: 'blocked',
    origin: 'blocked · mac-unreachable · canRecoverCertificateWarning',
    trigger: 'Running in Safari and the Mac is not answering — usually its certificate was never trusted.',
    note: 'The same screen as the one below, plus one line only a Safari tab gets: it is the one host that can trust the cert and come back.',
    render: () => <CantFindMac macPageUrl="#" />
  },
  {
    id: 'mac-unreachable',
    label: 'Can’t find your Mac',
    group: 'blocked',
    origin: 'blocked · mac-unreachable, or connecting · reconnectAttempt > 1',
    trigger: 'The Mac is not answering, on the first connect or after a known host went quiet.',
    note: 'The first-connect retry shows the same screen without the code form. Back is armed behind a confirm here — the credential is still LIVE, so leaving also unpairs.',
    render: () => <CantFindMac />
  },
  {
    id: 'rate-limited',
    label: 'Rate limited',
    group: 'blocked',
    origin: 'blocked · rate-limited',
    trigger: 'Too many connection attempts from this network in a short window.',
    note: 'The code form is deliberately absent: the same limiter guards POST /pair, so typing a code cannot help until it clears.',
    render: () => (
      <TerminalState
        icon={Timer}
        tier="blocked"
        title="Too many tries to connect"
        body="Give it a moment, then try again."
        action={{ label: 'Try again in 30s', onClick: noop, disabled: true }}
        onBack={noop}
      />
    )
  },
  {
    id: 'awaiting-approval',
    label: 'Waiting for approval',
    group: 'waiting',
    origin: 'awaitingApproval',
    trigger: 'A second device with no credential asked the already-paired phone to vouch for it.',
    note: 'Sits ABOVE the boot gate on purpose — otherwise an anonymous spinner would cover the one screen that explains the wait. No action: the answer is being tapped elsewhere.',
    render: () => (
      <TerminalState
        icon={Smartphone}
        title="Waiting for approval"
        body="Open MightyMouse on your connected phone and tap Allow."
      >
        <ApprovalWaiting expiresAt={APPROVAL_EXPIRES_AT} />
      </TerminalState>
    )
  }
]

/* ── The two non-terminal screens, which are markup rather than components ── */

function BootGate(): React.JSX.Element {
  return (
    <div className="bootGate">
      <TerminalBack />
      <div className="bootGateMark">{CONFIG.PRODUCT_NAME}</div>
      <div className="bootGateIcon" aria-hidden="true">
        <Radar size={26} strokeWidth={1.75} />
      </div>
      <div className="bootGateBody" role="status" aria-live="polite">
        Connecting to your Mac…
      </div>
    </div>
  )
}

const TRANSIENT: Scenario[] = [
  {
    id: 'boot-connecting',
    label: 'Connecting',
    group: 'transient',
    origin: "connecting · !everConnected",
    trigger: 'First load on a phone that has never reached this Mac.',
    note: 'One wait screen while connecting or looking. After the first failed try it becomes "Can\'t find your Mac".',
    render: () => <BootGate />
  },
  {
    id: 'reconnect-banner',
    label: 'Reconnect banner',
    group: 'transient',
    origin: 'connected-before · reconnectSlow',
    trigger: 'An ordinary mid-session drop on a phone that HAS connected before.',
    note: 'A banner, not a takeover: the deck underneath stays readable. This is what a brief drop looks like — contrast it with "Kicked out", which replaces the whole screen.',
    render: () => (
      <div className="hDeckStub">
        <ReconnectBanner
          attempt={2}
          searching={false}
          onRetryNow={noop}
          switchingTo={null}
          tunnelReach={null}
        />
        <div className="hDeckStubBody">the deck stays here, still readable</div>
      </div>
    )
  }
]

/* ── The native lobby, which is SwiftUI and cannot render here ──────────── */

/** Every frame here is a real simulator capture, one per `-D MM_UI_STATE_LOBBY_*`
 *  build (ladder at AppModel.swift:41-56, seeded by `forceLobbyState`). The four
 *  non-searching headings key off `Prefs.lastRemoteURL` / `searchOutcome` at
 *  RUNTIME, so each needed its own flag before it could be photographed at all. */
const SHOT = (name: string): string => `harness-shots/ios-lobby-${name}.png`

const NATIVE: Scenario[] = [
  {
    id: 'lobby-firstrun',
    label: 'Lobby — first run',
    group: 'native',
    shell: 'native',
    origin: 'AppModel.swift:630 · !hasConnectedBefore — MM_UI_STATE_LOBBY_FIRSTRUN',
    trigger: 'The app opens on a phone that has never reached a Mac.',
    note: 'The only screen a brand-new user sees. One action: scan. No retry button — there is nothing to retry yet.',
    render: () => <img className="hShot" src={SHOT('firstrun')} alt="MightyMouse runs on your Mac" />
  },
  {
    id: 'lobby-searching',
    label: 'Lobby — looking',
    group: 'native',
    shell: 'native',
    origin: 'AppModel.swift:623 · hasConnectedBefore && localNetworkAsked && outcome == nil',
    trigger: 'The app opens on a phone that has paired before, and a sweep is in flight.',
    note: 'Note what is NOT here: no keypad, no second card. Scan is the only action. A good scan spends ?c= before the first WS, so this must not bounce into Let’s connect.',
    render: () => <img className="hShot" src={SHOT('searching')} alt="Looking for your Mac" />
  },
  {
    id: 'lobby-notfound',
    label: 'Lobby — not found',
    group: 'native',
    shell: 'native',
    origin: 'AppModel.swift:630 · hasConnectedBefore && !searching — MM_UI_STATE_LOBBY_NOTFOUND',
    trigger: 'The sweep finished and no Mac answered.',
    note: 'Retry is secondary ("Look again") and scan stays primary — the QR carries the address, so it works when the sweep cannot.',
    render: () => <img className="hShot" src={SHOT('notfound')} alt="Can't find your Mac" />
  },
  {
    id: 'lobby-blocked',
    label: 'Lobby — Local Network denied',
    group: 'native',
    shell: 'native',
    origin: 'AppModel.swift:610 · searchOutcome == .blocked — MM_UI_STATE_LOBBY_BLOCKED',
    trigger: 'iOS denied Local Network, so no sweep can ever answer.',
    note: 'The one screen allowed to say "Local Network": the term now names a switch the user can actually see. Secondary is "Open Settings", not "Look again" — a retry here loops forever.',
    render: () => <img className="hShot" src={SHOT('blocked')} alt="Turn on Local Network" />
  }
]

const ALL: Scenario[] = [...NATIVE, ...SCENARIOS, ...TRANSIENT]

const GROUP_LABEL: Record<Group, string> = {
  native:
    'Native iOS shell — before the web bundle loads at all. All five are real simulator captures. Scan is the only way in: no keypad, no code entry, anywhere in this group.',
  blocked: 'Blocked — the socket closed and stated why',
  waiting: 'Waiting on someone else',
  transient: 'Transient — still trying, nothing is wrong yet'
}

function Frame({ scenario }: { scenario: Scenario }): React.JSX.Element {
  return (
    <section className="hCard">
      <header className="hCardHead">
        <h3>
          {scenario.label}
          <span className="hShell" data-shell={scenario.shell ?? 'web'}>
            {scenario.shell === 'native' ? 'native iOS' : 'web bundle'}
          </span>
        </h3>
        <code>{scenario.origin}</code>
      </header>
      {/* `.strandedGuard` and `.bootGate` are both `position: fixed; inset: 0`,
          so without a containing block every frame would stack on the viewport
          and only the last would be visible. `transform` on the parent makes
          each frame the fixed root for its own gate — the same trick the deck
          harness uses, and the reason these can sit side by side at all. */}
      <div className="hPhone">
        <div className="hPhoneScreen">{scenario.render()}</div>
      </div>
      <p className="hTrigger">{scenario.trigger}</p>
      {scenario.note && <p className="hNote">{scenario.note}</p>}
    </section>
  )
}

/** The id in `#state=<id>`, or null for the all-states view. Unknown ids fall
 *  back to All rather than an empty page -- a stale link from a renamed
 *  scenario otherwise looks like the harness broke. */
function readHash(): string | null {
  const id = new URLSearchParams(window.location.hash.slice(1)).get('state')
  return id && ALL.some((s) => s.id === id) ? id : null
}

function Harness(): React.JSX.Element {
  const [only, setOnly] = useState<string | null>(readHash)

  // Deep link both ways: the hash is the source of truth, so a pasted URL opens
  // one state and Back/Forward walk the states you looked at.
  useEffect(() => {
    const sync = (): void => setOnly(readHash())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const select = useCallback((id: string | null): void => {
    // Writing the hash drives `setOnly` through the listener above -- one
    // writer, so the URL and the view can never disagree.
    window.location.hash = id ? `state=${id}` : ''
  }, [])

  const shown = useMemo(() => (only ? ALL.filter((s) => s.id === only) : ALL), [only])
  const groups = useMemo(() => {
    const order: Group[] = ['native', 'blocked', 'waiting', 'transient']
    return order
      .map((g) => ({ group: g, items: shown.filter((s) => s.group === g) }))
      .filter((g) => g.items.length > 0)
  }, [shown])

  return (
    <div className="hPage">
      <div className="hPageHead">
        <h1>Pairing &amp; connection — every state</h1>
        <p>
          Every screen a user can be stopped on before they are driving their Mac. Decided in{' '}
          <code>hooks/use-mirror.tsx</code> (~5646-5810); all of them render through{' '}
          <code>TerminalState</code>.
        </p>
        <div className="hControls">
          <button
            className="hViewTab"
            data-active={only === null ? '' : undefined}
            onClick={() => select(null)}
          >
            All {ALL.length}
          </button>
          {ALL.map((s) => (
            <button
              key={s.id}
              className="hViewTab"
              data-active={only === s.id ? '' : undefined}
              onClick={() => select(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {groups.map(({ group, items }) => (
        <div key={group} className="hGroup">
          <h2 className="hGroupHead">{GROUP_LABEL[group]}</h2>
          <div className="hGrid">
            {items.map((s) => (
              <Frame key={s.id} scenario={s} />
            ))}
          </div>
        </div>
      ))}

      <div className="hPageHead hFoot">
        <h2>The five reasons the Mac can send</h2>
        <p>
          Straight from <code>BLOCKED_REASON_INFO</code> — the semantic contract. The screens
          above are the copy written against it.
        </p>
        <table className="hTable">
          <thead>
            <tr>
              <th>reason</th>
              <th>means</th>
              <th>one action</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(BLOCKED_REASON_INFO) as BlockedReason[]).map((r) => (
              <tr key={r}>
                <td>
                  <code>{r}</code>
                </td>
                <td>{BLOCKED_REASON_INFO[r].summary}</td>
                <td>{BLOCKED_REASON_INFO[r].action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>
)
