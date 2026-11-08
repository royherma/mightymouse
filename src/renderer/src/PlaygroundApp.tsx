// ── Component Playground ──────────────────────────────────────────────────────
// Single-page design-system preview. Every UI primitive in one scrollable view.
// Open via tray "Playground…" or Cmd+Opt+Shift+D (see playground-window.ts).
// To hide from production: comment out the ?window=playground branch in main.tsx
// and the showPlaygroundWindow() call in index.ts.

import { JSX, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { WindowFrame } from './WindowFrame'
import { GlowDot } from './components/GlowDot'
import { AgentFace, AgentFaceMark } from '../../shared/agent-face-view'
import { AGENT_SHAPES, AGENT_FACE_COLORS, AGENT_FACE_COUNT } from '../../shared/agent-face'
import { Kbd } from './components/Kbd'
import { SnailTrail, CursorFacingMouse, HeadingDemo } from './components/SnailTrail'
import { Card, SectionHeader } from './components/Card'
import { Row as FlexRow, Stack } from './components/Layout'
import { Muted } from './components/Text'
import { SuggestionLab } from './components/SuggestionLab'
import { MOUSE_FRAMES } from './assets/mouse'
import { CONFIG } from '../../shared/config'
import { VISIBLE_SHORTCUTS, comboGlyphs } from '../../shared/shortcuts'
import { modeChipVars, MODE_ORDER } from './mode-colors'
import type { AppMode } from '../../shared/types'
import { TOUR } from '../../shared/tour/constants'
import { HotkeyConfirm } from './tour/HotkeyConfirm'
import type { HotkeyConfirmState } from '../../shared/tour/types'
import { Pencil, HelpCircle, Zap, Search, Settings, X } from 'lucide-react'
import { Button } from './components/Button'
import { Switch } from './components/Switch'
import { KeyCap } from './components/KeyCap'
import { ModeTile } from './components/ModeTile'
import { HintCard } from './components/HintCard'
import { StepHeader } from './components/StepHeader'
import { MODE_COLORS } from './mode-colors'
import VoiceRouteApp, { type VoiceRoutePreview } from './VoiceRouteApp'
import { ActionRows } from './components/ActionRows'
import type {
  ActionChip,
  ActionIconName,
  ActionProposal,
  ActionSafety
} from '../../shared/action-engine'
import type { VoiceRouteHelperOption, VoiceRoutePayload } from '../../shared/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

const NavContext = createContext<{ register: (title: string) => void; query: string }>({
  register: () => {},
  query: ''
})

function sectionId(title: string): string {
  return (
    'pg-' +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): JSX.Element | null {
  const { register, query } = useContext(NavContext)
  useEffect(() => register(title), [register, title])
  if (query && !title.toLowerCase().includes(query)) return null
  return (
    <div id={sectionId(title)} className="mb-10 scroll-mt-16">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-lg font-semibold text-on-surface">{title}</span>
        <div className="flex-1 h-px bg-surface3" />
      </div>
      {children}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-4 mb-3">
      <span className="w-36 shrink-0 text-md text-muted pt-0.5">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

// Renders the REAL HotkeyConfirm component pinned to one static state, so the
// catalog can never drift from what the tour actually ships. `held` fakes the
// full mod trio down.
function HotkeyConfirmStatePreview({ state }: { state: HotkeyConfirmState }): JSX.Element {
  const held = state === TOUR.CONFIRM_STATE.held
  return (
    <HotkeyConfirm
      shortcutId="main"
      confirm={{
        state,
        unlocked: false,
        mods: { meta: held, alt: held, shift: held }
      }}
    />
  )
}

// ── Act Highlight demo ───────────────────────────────────────────────────────
// Live-tunable size/duration sliders — fires the real overlay via
// window.api.devFlashHighlight({ sizePx, durationMs }), no restart needed to
// try different values. Defaults mirror CONFIG.ACT_HIGHLIGHT.

function ActHighlightSection(): JSX.Element {
  const [sizePx, setSizePx] = useState(CONFIG.ACT_HIGHLIGHT.BOX_SIZE_PX)
  const [durationMs, setDurationMs] = useState(CONFIG.ACT_HIGHLIGHT.DURATION_MS)

  return (
    <Section title="Act Highlight — dashed box flash">
      <Row label="Size">
        <input
          type="range"
          min={40}
          max={400}
          step={10}
          value={sizePx}
          onChange={(e) => setSizePx(Number(e.target.value))}
        />
        <span className="text-sm text-muted w-16">{sizePx}px</span>
      </Row>
      <Row label="Duration">
        <input
          type="range"
          min={300}
          max={4000}
          step={100}
          value={durationMs}
          onChange={(e) => setDurationMs(Number(e.target.value))}
        />
        <span className="text-sm text-muted w-16">{durationMs}ms</span>
      </Row>
      <Row label="Fire at cursor">
        <Button variant="ghost"
          className="text-md font-semibold px-4 rounded-md border"
          style={{
            background: 'var(--violet-bg-subtle)',
            border: '1px solid var(--violet-border-subtle)',
            color: 'var(--violet)'
          }}
          onClick={() => window.api.devFlashHighlight({ sizePx, durationMs })}
        >
          Flash it now
        </Button>
        <span className="text-sm text-muted">
          Move your mouse anywhere, click this, watch the spot.
        </span>
      </Row>
    </Section>
  )
}

// ── Color swatch ──────────────────────────────────────────────────────────────

function Swatch({ name, value }: { name: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1 w-16">
      <div className="w-10 h-10 rounded-md border border-surface3" style={{ background: value }} />
      <span className="text-xs text-muted text-center leading-tight">{name}</span>
    </div>
  )
}

// ── Chat bubble preview ───────────────────────────────────────────────────────

function ChatBubbles(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 w-full max-w-sm">
      <div className="msg q flex justify-end">
        <div
          className="bubble px-3 py-2 rounded-lg text-md max-w-[80%]"
          style={{
            background: 'var(--accent-bg-subtle)',
            border: '1px solid var(--accent-border-subtle)',
            color: 'var(--on-surface)'
          }}
        >
          Make this shorter and punchier
        </div>
      </div>
      <div className="msg a flex justify-start">
        <div
          className="bubble px-3 py-2 rounded-lg text-md max-w-[80%]"
          style={{
            background: 'var(--surface1-alt)',
            border: '1px solid var(--surface-border-alt)',
            color: 'var(--on-surface)'
          }}
        >
          Cut the fluff. Ship it.
        </div>
      </div>
      <div className="flex items-center gap-2 px-1">
        <span className="typing-dots flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-muted"
              style={{ animation: `bounce 1s ease-in-out ${i * 0.2}s infinite` }}
            />
          ))}
        </span>
        <span className="text-xs text-muted">Thinking…</span>
      </div>
    </div>
  )
}

// ── HUD card preview ──────────────────────────────────────────────────────────

function HudPreview({ state }: { state: 'running' | 'ok' | 'fail' }): JSX.Element {
  const iconBg =
    state === 'running'
      ? 'var(--accent-bg-subtle)'
      : state === 'ok'
        ? 'var(--green-bg-subtle)'
        : 'var(--red-bg-subtle)'
  const iconColor =
    state === 'running' ? 'var(--accent)' : state === 'ok' ? 'var(--green)' : 'var(--red)'
  const icon = state === 'running' ? '⏳' : state === 'ok' ? '✓' : '✕'
  const title = state === 'running' ? 'Transcribing…' : state === 'ok' ? 'Done' : 'Failed'
  const subtitle =
    state === 'running'
      ? 'whisper-cli running'
      : state === 'ok'
        ? 'Copied to clipboard'
        : 'whisper not found'

  return (
    <div
      className="hud-container rounded-xl px-3 py-2.5 flex items-start gap-3 w-72"
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--surface3)',
        boxShadow: 'var(--shadow-panel)'
      }}
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 text-lg"
        style={{ background: iconBg, color: iconColor }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-md font-semibold text-on-surface truncate">{title}</span>
          <span className="text-xs text-muted shrink-0">0.8s</span>
        </div>
        <div className="text-sm text-muted truncate">{subtitle}</div>
        {state === 'ok' && (
          <div className="flex gap-1.5 mt-2">
            {(['Ask', 'Act', 'Copy'] as const).map((label) => (
              <Button variant="ghost"
                key={label}
                className="px-2 rounded text-xs font-medium border"
                style={{
                  background: 'var(--surface2)',
                  border: '1px solid var(--surface3)',
                  color: 'var(--muted)'
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Toggle switch ─────────────────────────────────────────────────────────────

function Toggle({ label, on }: { label: string; on: boolean }): JSX.Element {
  const [active, setActive] = useState(on)
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <Switch on={active} onChange={setActive} />
      <span className="text-md text-on-surface">{label}</span>
    </label>
  )
}

// ── Action rows ──────────────────────────────────────────────────────────────

function proposal(
  proposalId: string,
  title: string,
  icon: ActionIconName,
  percent: number,
  chips: ActionChip[],
  safety: ActionSafety = 'safe'
): ActionProposal {
  return {
    proposalId,
    actionId: proposalId,
    capabilityId: 'playground',
    title,
    icon,
    chips,
    percent,
    safety,
    preselected: false
  }
}

const PICKER_APPS = [
  'Spotify',
  'Spark',
  'Slack',
  'Safari',
  'Sublime Text',
  'Screen Sharing',
  'Sketch',
  'Signal',
  'Notion',
  'Numbers',
  'Notes'
].map((name) => ({ value: name, label: name }))

const ACTION_SETS: Array<{ name: string; proposals: ActionProposal[] }> = [
  {
    name: 'Pickable chips',
    proposals: [
      proposal('p1', 'Open app', 'app-window', 78, [
        { key: 'app', label: 'App', value: 'Spotify', options: PICKER_APPS, confidence: 0.92 }
      ]),
      proposal('p2', 'Open app', 'app-window', 52, [
        { key: 'app', label: 'App', value: 'Spark', options: PICKER_APPS, confidence: 0.41 }
      ]),
      proposal('p3', 'Send it to Slack', 'send', 37, [
        {
          key: 'channel',
          label: 'Channel',
          value: '#general',
          options: [
            { value: '#general', label: '#general' },
            { value: '#eng', label: '#eng' },
            { value: '#design', label: '#design' },
            { value: '#random', label: '#random' }
          ],
          confidence: 0.55
        },
        { key: 'as', label: 'As', value: 'a thread reply' }
      ])
    ]
  },
  {
    name: 'One row',
    proposals: [
      proposal('a1', 'Set volume to 40%', 'volume-2', 82, [
        { key: 'level', label: 'Level', value: '40%' }
      ])
    ]
  },
  {
    name: 'Many rows + chips',
    proposals: [
      proposal('b1', 'Set volume to 40%', 'volume-2', 82, [
        { key: 'level', label: 'Level', value: '40%' }
      ]),
      proposal('b2', 'Open this in Cursor', 'app-window', 61, [
        { key: 'app', label: 'App', value: 'Cursor' },
        { key: 'branch', label: 'Branch', value: 'dev' }
      ]),
      proposal('b3', 'Turn on Do Not Disturb', 'moon', 44, [
        { key: 'until', label: 'Until', value: '6:00 PM' }
      ]),
      proposal('b4', 'Send it to Slack', 'send', 31, [
        { key: 'channel', label: 'Channel', value: '#general' },
        { key: 'as', label: 'As', value: 'a thread reply' }
      ]),
      proposal('b5', 'Search the web for it', 'search', 18, [
        { key: 'engine', label: 'Engine', value: 'Google' }
      ]),
      proposal('b6', 'Start a timer', 'calendar', 9, [
        { key: 'length', label: 'Length', value: '25 min' }
      ])
    ]
  },
  {
    name: 'Long titles, many chips',
    proposals: [
      proposal('c1', 'Rewrite the selected paragraph to be shorter and punchier', 'sparkles', 77, [
        { key: 'tone', label: 'Tone', value: 'blunt' },
        { key: 'length', label: 'Length', value: 'half' },
        { key: 'lang', label: 'Language', value: 'English' }
      ]),
      proposal('c2', 'Create a calendar event from what you just said', 'calendar', 52, [
        { key: 'when', label: 'When', value: 'Tomorrow 9:00 AM' },
        { key: 'cal', label: 'Calendar', value: 'Work' },
        { key: 'dur', label: 'Duration', value: '30 min' },
        { key: 'alert', label: 'Alert', value: '10 min before' }
      ])
    ]
  },
  {
    name: 'Needs confirming',
    proposals: [
      proposal(
        'd1',
        'Delete the last recording',
        'zap',
        68,
        [{ key: 'file', label: 'File', value: 'note-14.wav' }],
        'confirm'
      ),
      proposal(
        'd2',
        'Run the deploy script',
        'terminal',
        40,
        [{ key: 'env', label: 'Env', value: 'staging' }],
        'confirm'
      )
    ]
  }
]

function ActionRowsSection(): JSX.Element {
  const [setName, setSetName] = useState(ACTION_SETS[0].name)
  const [selectedId, setSelectedId] = useState('p1')
  const [busyId, setBusyId] = useState('')
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const base = ACTION_SETS.find((s) => s.name === setName) ?? ACTION_SETS[0]
  const set = {
    ...base,
    proposals: base.proposals.map((p) => ({
      ...p,
      chips: p.chips.map((c) => {
        const picked = overrides[`${p.proposalId}.${c.key}`]
        return picked === undefined ? c : { ...c, value: picked, confidence: undefined }
      })
    }))
  }

  return (
    <Section title="Action Rows — Want me to…">
      <Row label="Example">
        {ACTION_SETS.map((s) => {
          const on = s.name === setName
          return (
            <Button variant="ghost"
              key={s.name}
              onClick={() => {
                setSetName(s.name)
                setSelectedId(s.proposals[0].proposalId)
                setBusyId('')
                setOverrides({})
              }}
              className="text-md px-3 py-1 rounded-md border transition-colors"
              style={{
                background: on ? 'var(--accent-bg-subtle)' : 'var(--surface1)',
                border: `1px solid ${on ? 'var(--accent-border-subtle)' : 'var(--surface3)'}`,
                color: on ? 'var(--accent)' : 'var(--muted)'
              }}
            >
              {s.name}
            </Button>
          )
        })}
      </Row>
      <Row label="Busy row">
        <Button variant="ghost"
          className="text-md px-3 rounded-md border"
          style={{
            background: 'var(--surface1)',
            border: '1px solid var(--surface3)',
            color: 'var(--muted)'
          }}
          onClick={() => setBusyId((b) => (b === '' ? selectedId : ''))}
        >
          {busyId === '' ? 'Show “Doing it…”' : 'Clear busy'}
        </Button>
      </Row>
      <Muted>
        Click a row to select it, click again to confirm. A chip with an arrow opens the ranked
        options — type to filter. The tinted chip is one the model was unsure about.
      </Muted>
      <div
        className="mt-3 rounded-xl p-4"
        style={{ background: 'var(--bg-dark)', border: '1px solid var(--surface3)', width: 460 }}
      >
        <span className="actions-label">Want me to…</span>
        <ActionRows
          proposals={set.proposals}
          selectedId={selectedId}
          busyId={busyId}
          doneId=""
          doneOk={false}
          onSelect={setSelectedId}
          onConfirm={(id) => setSelectedId(id)}
          onChipChange={(proposalId, slotKey, value) =>
            setOverrides((o) => ({ ...o, [`${proposalId}.${slotKey}`]: value }))
          }
        />
      </div>
    </Section>
  )
}

// ── Voice routing card ───────────────────────────────────────────────────────

const VROUTE_HELPERS: VoiceRouteHelperOption[] = [
  {
    sinkId: 'skill:wip-scan',
    label: '/wip-scan',
    kind: 'skill',
    description: 'List every uncommitted change across your repos',
    percent: 62,
    project: '',
    branch: '',
    cwd: '',
    activity: ''
  },
  {
    sinkId: 'skill:tweet',
    label: '/tweet',
    kind: 'skill',
    description: 'Draft a post from these words',
    percent: 18,
    project: '',
    branch: '',
    cwd: '',
    activity: ''
  },
  {
    sinkId: 'skill:release-notes',
    label: '/release-notes',
    kind: 'skill',
    description: 'Write the notes for the next release',
    percent: 7,
    project: '',
    branch: '',
    cwd: '',
    activity: ''
  },
  {
    sinkId: 'agent:1',
    label: 'main - pro-paywall',
    kind: 'agent',
    description: 'Wiring the upgrade prompt into the panel',
    percent: 41,
    project: 'MightyMouse',
    branch: 'main',
    cwd: '',
    activity: 'working right now'
  },
  {
    sinkId: 'agent:2',
    label: 'dev - voice-routing',
    kind: 'agent',
    description: 'Ranking destinations for a voice note',
    percent: 23,
    project: 'MightyMouse',
    branch: 'dev',
    cwd: '',
    activity: 'idle'
  },
  {
    sinkId: 'agent:3',
    label: 'main - feed-poster',
    kind: 'agent',
    description: 'Posting the daily feed',
    percent: 9,
    project: 'Remi',
    branch: 'main',
    cwd: '',
    activity: 'disconnected'
  },
  {
    sinkId: 'new-agent:mightymouse',
    label: 'MightyMouse',
    kind: 'new-agent',
    description: 'Start a fresh session in this repo',
    percent: 15,
    project: 'MightyMouse',
    branch: 'dev',
    cwd: '',
    activity: ''
  }
]

const VROUTE_ROUTE: VoiceRoutePayload = {
  runId: 'playground',
  options: [],
  latencyMs: 1240,
  suggestedSinkId: '',
  confident: false,
  submitNow: false,
  offerGoTo: true,
  preview: 'make this shorter and punchier, then tell me what changed',
  screenshotName: 'Screenshot 2026-09-20 at 10.02.14.png',
  screenshotThumb: '',
  helperOptions: VROUTE_HELPERS,
  suggestedHelperId: 'skill:wip-scan',
  newAgentHost: 'Ghostty',
  picks: {},
  sent: {
    appName: 'Google Chrome',
    title: 'Pricing — MightyMouse',
    url: 'https://getmightymouse.com/pricing',
    screenshotName: 'Screenshot 2026-09-20 at 10.02.14.png',
    transcript: 'make this shorter and punchier, then tell me what changed'
  }
}

const VROUTE_APPS: VoiceRoutePayload = {
  ...VROUTE_ROUTE,
  confident: true,
  screenshotName: '',
  helperOptions: [],
  suggestedHelperId: '',
  suggestedSinkId: 'app:cursor',
  options: [
    { sinkId: 'app:cursor', label: 'Cursor', appName: 'Cursor', percent: 71 },
    { sinkId: 'app:notes', label: 'Notes', appName: 'Notes', percent: 19 },
    { sinkId: 'app:slack', label: 'Slack', appName: 'Slack', percent: 6 }
  ]
}

const VROUTE_STATES: Array<{ name: string; preview: VoiceRoutePreview }> = [
  {
    name: 'Ranking (skeleton)',
    preview: {
      waiting: {
        runId: 'playground',
        preview: 'make this shorter and punchier, then tell me what changed',
        bands: ['Skills', 'Agents', 'New agent']
      }
    }
  },
  {
    name: 'Ranking failed (in the card)',
    preview: {
      waiting: {
        runId: 'playground',
        preview: 'make this shorter and punchier, then tell me what changed',
        bands: ['Skills', 'Agents', 'New agent']
      },
      result: {
        runId: 'playground',
        ok: false,
        submitted: false,
        appName: '',
        canGo: false,
        canRetry: true,
        reason: 'The ranking took too long.'
      }
    }
  },
  { name: 'Ranked — skills & agents', preview: { route: VROUTE_ROUTE } },
  {
    name: 'Row — session started',
    preview: {
      route: VROUTE_ROUTE,
      result: {
        runId: 'playground',
        sinkId: 'new-agent:mightymouse',
        ok: true,
        submitted: true,
        appName: 'Claude',
        canGo: true,
        where: 'Ghostty — ShowAndTell',
        reason: ''
      }
    }
  },
  {
    name: 'Row — session failed',
    preview: {
      route: VROUTE_ROUTE,
      result: {
        runId: 'playground',
        sinkId: 'new-agent:mightymouse',
        ok: false,
        submitted: false,
        appName: 'Claude',
        canGo: false,
        canPickAgain: true,
        reason: "Couldn't start Claude: the folder is gone."
      }
    }
  },
  { name: 'Ranked — apps fallback', preview: { route: VROUTE_APPS } },
  {
    name: 'Result — sent',
    preview: {
      route: VROUTE_ROUTE,
      result: {
        runId: 'playground',
        ok: true,
        submitted: true,
        appName: 'Cursor',
        canGo: false,
        reason: ''
      }
    }
  },
  {
    name: 'Result — sent, go to it',
    preview: {
      route: VROUTE_ROUTE,
      result: {
        runId: 'playground',
        ok: true,
        submitted: true,
        appName: 'a new agent',
        canGo: true,
        reason: ''
      }
    }
  },
  {
    name: 'Result — failed',
    preview: {
      route: VROUTE_ROUTE,
      result: {
        runId: 'playground',
        ok: false,
        submitted: false,
        appName: 'Slack',
        canGo: false,
        reason: "Slack didn't take the text"
      }
    }
  }
]

function VoiceRoutingSection(): JSX.Element {
  const [stateName, setStateName] = useState(VROUTE_STATES[1].name)
  const active = VROUTE_STATES.find((s) => s.name === stateName) ?? VROUTE_STATES[1]

  return (
    <Section title="Action Routing — the Send to card">
      <Row label="State">
        {VROUTE_STATES.map((s) => {
          const on = s.name === stateName
          return (
            <Button variant="ghost"
              key={s.name}
              onClick={() => setStateName(s.name)}
              className="text-md px-3 py-1 rounded-md border transition-colors"
              style={{
                background: on ? 'var(--accent-bg-subtle)' : 'var(--surface1)',
                border: `1px solid ${on ? 'var(--accent-border-subtle)' : 'var(--surface3)'}`,
                color: on ? 'var(--accent)' : 'var(--muted)'
              }}
            >
              {s.name}
            </Button>
          )
        })}
      </Row>
      <Muted>
        The real VoiceRouteApp with a frozen payload — hover a row for its chips and buttons.
      </Muted>
      {/* The card normally owns its own window and reserves 264px on the left
          for the hover tip; inside the page that gutter is dead space. */}
      <div
        className="mt-3 rounded-xl p-4 [&_.hud-shell.vroute-shell]:!pl-[13px]"
        style={{ background: 'var(--bg-dark)', border: '1px solid var(--surface3)', width: 520 }}
      >
        <VoiceRouteApp key={stateName} preview={active.preview} />
      </div>
    </Section>
  )
}

// ── Contents sidebar + search ────────────────────────────────────────────────

function ContentsSidebar({
  titles,
  query,
  onQuery,
  activeTitle
}: {
  titles: string[]
  query: string
  onQuery: (v: string) => void
  activeTitle: string | null
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="sticky top-0 self-start w-56 shrink-0 pt-5 pb-10 pl-6 pr-2">
      <div className="relative mb-3">
        <Search
          size={13}
          className="absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: 'var(--muted)' }}
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Search components"
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onQuery('')
          }}
          className="w-full text-md rounded-md pl-7 pr-2 py-1.5 outline-none"
          style={{
            background: 'var(--surface1)',
            border: '1px solid var(--surface3)',
            color: 'var(--on-surface)'
          }}
        />
      </div>
      <div className="flex flex-col gap-0.5 max-h-[calc(100vh-7rem)] overflow-y-auto">
        {titles.length === 0 && (
          <span className="text-sm text-muted px-2 py-1">No components match.</span>
        )}
        {titles.map((title) => {
          const active = title === activeTitle
          return (
            <Button variant="ghost"
              key={title}
              onClick={() =>
                document.getElementById(sectionId(title))?.scrollIntoView({ behavior: 'smooth' })
              }
              className="text-left text-sm rounded px-2 py-1 truncate transition-colors"
              style={{
                background: active ? 'var(--accent-bg-subtle)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--muted)'
              }}
              title={title}
            >
              {title}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main playground ───────────────────────────────────────────────────────────

export default function PlaygroundApp(): JSX.Element {
  const palette = CONFIG.THEME_TOKENS
  const [titles, setTitles] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [activeTitle, setActiveTitle] = useState<string | null>(null)

  const q = query.trim().toLowerCase()
  const navValue = useMemo(
    () => ({
      register: (title: string) =>
        setTitles((prev) => (prev.includes(title) ? prev : [...prev, title])),
      query: q
    }),
    [q]
  )
  const visibleTitles = useMemo(
    () => (q ? titles.filter((t) => t.toLowerCase().includes(q)) : titles),
    [titles, q]
  )

  useEffect(() => {
    if (visibleTitles.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (top) setActiveTitle(top.target.getAttribute('data-section-title'))
      },
      { rootMargin: '-44px 0px -70% 0px' }
    )
    for (const title of visibleTitles) {
      const el = document.getElementById(sectionId(title))
      if (el) {
        el.setAttribute('data-section-title', title)
        observer.observe(el)
      }
    }
    return () => observer.disconnect()
  }, [visibleTitles])

  const accentColors = [
    { name: 'accent', value: palette.accent },
    { name: 'cyan', value: palette.cyan },
    { name: 'violet', value: palette.violet },
    { name: 'green', value: palette.green },
    { name: 'amber', value: palette.amber },
    { name: 'blue', value: palette.blue },
    { name: 'magenta', value: palette.magenta },
    { name: 'red', value: palette.red },
    { name: 'yellow', value: palette.yellow }
  ]

  const surfaceColors = [
    { name: 'bg', value: palette.bg },
    { name: 'surface1', value: palette.surface1 },
    { name: 'surface2', value: palette.surface2 },
    { name: 'surface3', value: palette.surface3 },
    { name: 'bgDark', value: palette.bgDark },
    { name: 'surface1Alt', value: palette.surface1Alt }
  ]

  const textColors = [
    { name: 'onSurface', value: palette.onSurface },
    { name: 'muted', value: palette.muted },
    { name: 'textMutedMedium', value: palette.textMutedMedium },
    { name: 'textMutedLight', value: palette.textMutedLight },
    { name: 'textMutedDark', value: palette.textMutedDark }
  ]

  const fontSizes = [
    { name: '2xs / 8px', cls: 'text-xlg' },
    { name: 'xs / 10px', cls: 'text-xs' },
    { name: 'sm / 11px', cls: 'text-sm' },
    { name: 'md / 12px', cls: 'text-md' },
    { name: 'mlg / 14px (chat body)', cls: 'text-mlg' },
    { name: 'lg / 14px', cls: 'text-lg' },
    { name: 'xl / 16px', cls: 'text-xl' },
    { name: 'display / 24px', cls: 'text-display' }
  ]

  return (
    <WindowFrame title="🎨 Component Playground">
      <div className="flex items-start">
        <ContentsSidebar
          titles={visibleTitles}
          query={query}
          onQuery={setQuery}
          activeTitle={activeTitle}
        />
        <div className="flex-1 min-w-0 px-6 pb-10 pt-5">
          <NavContext.Provider value={navValue}>
            {/* ── Layout primitives — Card / SectionHeader / Row / Stack / Muted ── */}
            <Section title="Layout — Card, SectionHeader, Row, Stack, Muted">
              <SectionHeader className="mt-0">A section header</SectionHeader>
              <Card>
                <FlexRow gap={3} className="justify-between mb-2">
                  <span className="text-md font-semibold">Card with a Row header</span>
                  <Kbd glyphs={['⌘', 'K']} />
                </FlexRow>
                <Muted>Muted helper text inside the standard Card.</Muted>
              </Card>
              <Card>
                <Stack gap={2}>
                  <FlexRow>
                    <GlowDot color="var(--green)" /> Stack row one
                  </FlexRow>
                  <FlexRow>
                    <GlowDot color="var(--amber)" /> Stack row two
                  </FlexRow>
                  <Muted size="2xs">2xs muted caption</Muted>
                </Stack>
              </Card>
            </Section>

            {/* ── Suggestion Lab — server-free WRITE preview interaction sandbox ── */}
            <VoiceRoutingSection />

            <ActionRowsSection />

            <Section title="Suggestion Lab — hover → preview → paste">
              <SuggestionLab />
            </Section>

            {/* ── Colors ──────────────────────────────────────────────────────── */}
            <Section title="Colors — Accents">
              <div className="flex flex-wrap gap-3">
                {accentColors.map((c) => (
                  <Swatch key={c.name} name={c.name} value={c.value} />
                ))}
              </div>
            </Section>

            <Section title="Colors — Surfaces">
              <div className="flex flex-wrap gap-3">
                {surfaceColors.map((c) => (
                  <Swatch key={c.name} name={c.name} value={c.value} />
                ))}
              </div>
            </Section>

            <Section title="Colors — Text">
              <div className="flex flex-wrap gap-3">
                {textColors.map((c) => (
                  <Swatch key={c.name} name={c.name} value={c.value} />
                ))}
              </div>
            </Section>

            {/* ── Typography ──────────────────────────────────────────────────── */}
            <Section title="Typography">
              <div className="flex flex-col gap-2">
                {fontSizes.map((f) => (
                  <div key={f.name} className="flex items-baseline gap-4">
                    <span className="w-32 text-xs text-muted shrink-0">{f.name}</span>
                    <span className={`${f.cls} text-on-surface`}>The quick brown MightyMouse</span>
                  </div>
                ))}
              </div>
            </Section>

            {/* ── Chips & Badges ──────────────────────────────────────────────── */}
            <Section title="Chips & Badges">
              <Row label="Mode badges">
                {MODE_ORDER.filter((m): m is AppMode => m !== 'listen').map((m) => (
                  <span key={m} className="badge" style={modeChipVars(m)}>
                    {m}
                  </span>
                ))}
              </Row>
              <Row label="Backend chips">
                <span className="backend-chip claude">claude</span>
                <span className="backend-chip codex">codex</span>
              </Row>
              <Row label="Action chips">
                {['✦ Fix', '✦ Translate', '✦ Summarize', '✦ Explain'].map((label) => (
                  <Button variant="ghost" key={label} className="action-chip">
                    {label}
                  </Button>
                ))}
              </Row>
              <Row label="Selection preview">
                <span className="preview" style={{ fontSize: 'var(--font-xs)' }}>
                  ◆ Selected text preview here
                </span>
              </Row>
            </Section>

            <Section title="Buttons">
              <Row label="Primary">
                <Button>Primary</Button>
              </Row>
              <Row label="Ghost">
                <Button variant="ghost">Ghost</Button>
              </Row>
              <Row label="Success">
                <Button variant="success">Done</Button>
              </Row>
              <Row label="Bare">
                <Button variant="bare">Row</Button>
              </Row>
              <Row label="Icon">
                <Button variant="icon" title="Close">
                  <X size={14} />
                </Button>
                <Button variant="icon" title="Settings">
                  <Settings size={14} />
                </Button>
              </Row>
            </Section>

            {/* ── Act Highlight ───────────────────────────────────────────────── */}
            <ActHighlightSection />

            {/* ── Inputs ──────────────────────────────────────────────────────── */}
            <Section title="Inputs">
              <Row label="Text input">
                <input
                  id="playground-input"
                  className="w-64 bg-surface2 border border-surface3 rounded-lg px-3 py-2 text-md text-on-surface placeholder-muted outline-none"
                  placeholder="make it shorter, fix grammar…"
                  style={{ boxShadow: 'none' }}
                  readOnly
                />
              </Row>
              <Row label="Focused">
                <input
                  className="w-64 bg-surface2 rounded-lg px-3 py-2 text-md text-on-surface outline-none"
                  defaultValue="Type an instruction…"
                  style={{
                    border: '1px solid var(--accent)',
                    boxShadow: 'var(--focus-ring)'
                  }}
                  readOnly
                />
              </Row>
            </Section>

            {/* ── Toggles ─────────────────────────────────────────────────────── */}
            <Section title="Toggles">
              <Row label="Ctx toggle">
                <Toggle label="Context on" on={true} />
                <Toggle label="Context off" on={false} />
              </Row>
            </Section>

            {/* ── Status Indicators ───────────────────────────────────────────── */}
            <Section title="GlowDot — Status">
              <Row label="States">
                <GlowDot color="var(--green-light)" label="Granted" />
                <GlowDot color="var(--red-light)" label="Denied" />
                <GlowDot color="var(--gray-muted)" label="N/A" />
                <GlowDot color="var(--amber)" label="Pending" />
              </Row>
              <Row label="Sizes">
                <GlowDot color="var(--cyan)" size="w-2 h-2" />
                <GlowDot color="var(--cyan)" size="w-2.5 h-2.5" />
                <GlowDot color="var(--cyan)" size="w-3.5 h-3.5" />
              </Row>
            </Section>

            <Section title="AgentFace — session marks">
              <Row label="Hashed ids">
                {['sess-alpha', 'sess-beta', 'ShowAndTell/dev - mm', 'codex-1', 'cursor-pane'].map(
                  (id) => (
                    <span key={id} className="inline-flex items-center gap-1.5 mr-3">
                      <AgentFace id={id} size={22} />
                      <span className="text-xs text-muted">{id}</span>
                    </span>
                  )
                )}
              </Row>
              <Row label={`${AGENT_FACE_COUNT} combos`}>
                {AGENT_FACE_COLORS.map((color) => (
                  <span key={color} className="inline-flex gap-0.5">
                    {AGENT_SHAPES.map((shape) => (
                      <AgentFaceMark key={shape} shape={shape} color={color} size={18} />
                    ))}
                  </span>
                ))}
              </Row>
            </Section>

            {/* ── Keyboard Keys ───────────────────────────────────────────────── */}
            <Section title="Kbd — Key Caps">
              {VISIBLE_SHORTCUTS.slice(0, 3).map((s) => (
                <Row key={s.id} label={s.title}>
                  <Kbd glyphs={comboGlyphs(s)} />
                </Row>
              ))}
            </Section>

            {/* ── Tour press-to-confirm — the 4 cap states ────────── */}
            <Section title="Tour — Hotkey Confirm States">
              <Row label="idle">
                <HotkeyConfirmStatePreview state={TOUR.CONFIRM_STATE.idle} />
              </Row>
              <Row label="held">
                <HotkeyConfirmStatePreview state={TOUR.CONFIRM_STATE.held} />
              </Row>
              <Row label="confirmed">
                <HotkeyConfirmStatePreview state={TOUR.CONFIRM_STATE.confirmed} />
              </Row>
              <Row label="wrong">
                <HotkeyConfirmStatePreview state={TOUR.CONFIRM_STATE.wrong} />
              </Row>
            </Section>

            {/* ── Wizard step primitives — shared by the tour + onboarding ────── */}
            <Section title="KeyCap — the 4 states, both sizes">
              <Row label="lg (default)">
                <FlexRow className="gap-2">
                  <KeyCap glyph="⌘" state={TOUR.CONFIRM_STATE.idle} />
                  <KeyCap glyph="⌥" state={TOUR.CONFIRM_STATE.held} />
                  <KeyCap glyph="⇧" state={TOUR.CONFIRM_STATE.confirmed} />
                  <KeyCap glyph="O" state={TOUR.CONFIRM_STATE.wrong} />
                </FlexRow>
              </Row>
              <Row label="md">
                <FlexRow className="gap-2">
                  <KeyCap glyph="⌘" size="md" />
                  <KeyCap glyph="⌥" size="md" state={TOUR.CONFIRM_STATE.held} />
                </FlexRow>
              </Row>
            </Section>

            <Section title="ModeTile — the three modes">
              <Row label="tiles">
                <FlexRow className="gap-3 w-[420px]">
                  <ModeTile
                    label="Rewrite & Type"
                    accent={MODE_COLORS.rewrite}
                    highlighted
                    icon={<Pencil size={22} strokeWidth={2.25} />}
                  />
                  <ModeTile
                    label="Ask"
                    accent={MODE_COLORS.ask}
                    icon={<HelpCircle size={22} strokeWidth={2.25} />}
                  />
                  <ModeTile
                    label="Act"
                    accent={MODE_COLORS.act}
                    icon={<Zap size={22} strokeWidth={2.25} />}
                  />
                </FlexRow>
              </Row>
            </Section>

            <Section title="HintCard — inline callout">
              <Row label="info">
                <div className="w-[420px]">
                  <HintCard
                    title={CONFIG.UI_LABELS.TOUR_CONFIRM_UNLOCKED}
                    subtitle={CONFIG.UI_LABELS.TOUR_HINT_REVISIT}
                  />
                </div>
              </Row>
              <Row label="warn">
                <div className="w-[420px]">
                  <HintCard
                    severity="warn"
                    title={CONFIG.UI_LABELS.TOUR_SHORTCUTS_NOT_RESPONDING}
                    subtitle={CONFIG.UI_LABELS.TOUR_HINT_REVISIT}
                  />
                </div>
              </Row>
            </Section>

            <Section title="StepHeader — wizard progress">
              <Row label="40%">
                <div className="w-[420px]">
                  <StepHeader stepLabel="Step 2 of 5" pct={40} />
                </div>
              </Row>
              <Row label="confirmed tint">
                <div className="w-[420px]">
                  <StepHeader stepLabel="Step 3 of 5" pct={60} progressColor="var(--green)" />
                </div>
              </Row>
              {/* Chunked mode — one segment per screen, for wizards where progress is
              a countable number of steps rather than a ratio (the permissions
              onboarding). Percent readout is off: the chunks already say it. */}
              <Row label="chunked (2 of 4)">
                <div className="w-[420px]">
                  <StepHeader
                    stepLabel="Step 2 of 4"
                    pct={50}
                    segments={4}
                    showPct={false}
                    progressColor="var(--green-light)"
                  />
                </div>
              </Row>
              <Row label="chunked (4 of 4)">
                <div className="w-[420px]">
                  <StepHeader
                    stepLabel="Step 4 of 4"
                    pct={100}
                    segments={4}
                    showPct={false}
                    progressColor="var(--green-light)"
                  />
                </div>
              </Row>
            </Section>

            {/* ── Cards ───────────────────────────────────────────────────────── */}
            <Section title="Cards">
              <Row label="Surface card">
                <div
                  className="rounded-md px-4 py-3 w-64"
                  style={{
                    background: 'var(--surface1)',
                    border: '1px solid var(--surface3)',
                    boxShadow: 'var(--shadow-card)'
                  }}
                >
                  <div className="text-md font-semibold text-on-surface mb-1">Card Title</div>
                  <div className="text-sm text-muted">Secondary description text lives here.</div>
                </div>
              </Row>
              <Row label="Tinted cards">
                {[
                  {
                    bg: 'var(--accent-bg-subtle)',
                    border: 'var(--accent-border-subtle)',
                    label: 'Accent',
                    color: 'var(--accent)'
                  },
                  {
                    bg: 'var(--cyan-bg-subtle)',
                    border: 'var(--cyan-border-subtle)',
                    label: 'Cyan',
                    color: 'var(--cyan)'
                  },
                  {
                    bg: 'var(--violet-bg-subtle)',
                    border: 'var(--violet-border-subtle)',
                    label: 'Violet',
                    color: 'var(--violet)'
                  },
                  {
                    bg: 'var(--green-bg-subtle)',
                    border: 'var(--green-border-subtle)',
                    label: 'Green',
                    color: 'var(--green)'
                  },
                  {
                    bg: 'var(--red-bg-subtle)',
                    border: 'var(--red)',
                    label: 'Red',
                    color: 'var(--red)'
                  },
                  {
                    bg: 'var(--amber-bg-subtle)',
                    border: 'var(--amber-border-subtle)',
                    label: 'Amber',
                    color: 'var(--amber)'
                  }
                ].map((c) => (
                  <div
                    key={c.label}
                    className="rounded-md px-3 py-2"
                    style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.color }}
                  >
                    <span className="text-md font-semibold">{c.label}</span>
                  </div>
                ))}
              </Row>
            </Section>

            {/* ── HUD Card ────────────────────────────────────────────────────── */}
            <Section title="HUD Card">
              <div className="flex flex-col gap-3">
                <Row label="Running">
                  <HudPreview state="running" />
                </Row>
                <Row label="Success">
                  <HudPreview state="ok" />
                </Row>
                <Row label="Failed">
                  <HudPreview state="fail" />
                </Row>
              </div>
            </Section>

            {/* ── Chat Bubbles ────────────────────────────────────────────────── */}
            <Section title="Chat Bubbles">
              <Row label="Thread">
                <ChatBubbles />
              </Row>
            </Section>

            {/* ── Busy State ──────────────────────────────────────────────────── */}
            <Section title="Busy / Loading">
              <Row label="Spinner">
                <span className="w-5 h-5 rounded-full border-2 border-surface3 border-t-blue animate-spin" />
                <span className="w-8 h-8 rounded-full border-2 border-surface3 border-t-cyan animate-spin" />
              </Row>
              <Row label="Phase text">
                <div
                  className="rounded-xl px-4 py-3 w-64"
                  style={{ background: 'var(--surface1)', border: '1px solid var(--surface3)' }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-4 h-4 rounded-full border-2 border-surface3 border-t-blue animate-spin shrink-0" />
                    <span className="busy-phase text-md font-semibold text-on-surface">
                      Rewriting…
                    </span>
                  </div>
                  <div className="busy-detail text-sm text-muted">claude rewrite · 1.4s</div>
                </div>
              </Row>
            </Section>

            {/* ── Elevation ───────────────────────────────────────────────────── */}
            <Section title="Elevation / Shadow">
              <Row label="Levels">
                {[
                  { label: 'card', shadow: 'var(--shadow-card)' },
                  { label: 'panel', shadow: 'var(--shadow-panel)' },
                  { label: 'focus ring', shadow: 'var(--focus-ring)' }
                ].map((e) => (
                  <div
                    key={e.label}
                    className="w-20 h-12 rounded-lg flex items-center justify-center text-xs text-muted"
                    style={{
                      background: 'var(--surface1)',
                      border: '1px solid var(--surface3)',
                      boxShadow: e.shadow
                    }}
                  >
                    {e.label}
                  </div>
                ))}
              </Row>
            </Section>

            {/* ── Radius ──────────────────────────────────────────────────────── */}
            <Section title="Border Radius">
              <Row label="Scale">
                {[
                  { label: 'sm / 6px', r: 'var(--radius-sm)' },
                  { label: 'md / 10px', r: 'var(--radius-md)' },
                  { label: 'lg / 14px', r: 'var(--radius-lg)' }
                ].map((r) => (
                  <div key={r.label} className="flex flex-col items-center gap-1">
                    <div
                      className="w-14 h-10"
                      style={{
                        background: 'var(--surface2)',
                        border: '1px solid var(--surface3)',
                        borderRadius: r.r
                      }}
                    />
                    <span className="text-xs text-muted">{r.label}</span>
                  </div>
                ))}
              </Row>
            </Section>

            {/* ── Toast ───────────────────────────────────────────────────────── */}
            <Section title="Toast">
              <Row label="Pill">
                <div
                  className="px-3 py-1.5 rounded-full text-md font-semibold"
                  style={{
                    background: 'var(--surface2)',
                    border: '1px solid var(--surface3)',
                    color: 'var(--on-surface)',
                    boxShadow: 'var(--shadow-panel)'
                  }}
                >
                  Copied to clipboard
                </div>
              </Row>
            </Section>

            {/* ── SnailTrail ───────────────────────────────────────────────────── */}
            <Section title="SnailTrail">
              {/* Demo 1 — Auto crawl, dark background (island-like) */}
              <Row label="Auto horizontal">
                <div
                  style={{
                    width: 320,
                    height: 52,
                    background: 'var(--bg-dark, #0d0d0d)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--surface3)',
                    position: 'relative',
                    overflow: 'visible'
                  }}
                >
                  {/* SnailTrail fills the box interior; padding lets the sprite travel
                  edge-to-edge without clipping on the sides */}
                  <SnailTrail
                    axis="horizontal"
                    size={32}
                    speed={4}
                    trailLength={10}
                    style={{ position: 'absolute', inset: '10px 16px' }}
                  />
                </div>
              </Row>

              <Row label="Auto vertical">
                <div
                  style={{
                    width: 52,
                    height: 160,
                    background: 'var(--bg-dark, #0d0d0d)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--surface3)',
                    position: 'relative',
                    overflow: 'visible'
                  }}
                >
                  <SnailTrail
                    axis="vertical"
                    size={28}
                    speed={3}
                    trailLength={8}
                    style={{ position: 'absolute', inset: '12px 12px' }}
                  />
                </div>
              </Row>

              <Row label="Slower / longer">
                <div
                  style={{
                    width: 320,
                    height: 52,
                    background: 'var(--bg-dark, #0d0d0d)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--surface3)',
                    position: 'relative',
                    overflow: 'visible'
                  }}
                >
                  <SnailTrail
                    axis="horizontal"
                    size={22}
                    speed={7}
                    trailLength={14}
                    style={{ position: 'absolute', inset: '15px 14px' }}
                  />
                </div>
              </Row>

              {/* Demo 2 — Cursor-driven: sprite faces the user's cursor */}
              <Row label="Cursor-facing">
                <div>
                  <div
                    style={{
                      width: 180,
                      height: 180,
                      background: 'var(--bg-dark, #0d0d0d)',
                      borderRadius: 'var(--radius-md)',
                      border: '1px solid var(--surface3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'crosshair'
                    }}
                  >
                    <CursorFacingMouse size={52} />
                  </div>
                  <p className="text-xs text-muted mt-1.5">
                    Move cursor over the box — sprite tracks it via vectorToFrame
                  </p>
                </div>
              </Row>

              {/* Heading ring — all 8 ground-plane angles at 45° steps */}
              <Row label="Heading ring">
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  {([0, 45, 90, 135, 180, 225, 270, 315] as const).map((deg) => (
                    <HeadingDemo key={deg} deg={deg} size={30} />
                  ))}
                </div>
              </Row>

              {/* Full frame sheet — all 20 poses */}
              <Row label="All 20 frames">
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {(Object.entries(MOUSE_FRAMES) as [string, string][]).map(([name, src]) => (
                    <div
                      key={name}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 3
                      }}
                    >
                      <img
                        src={src}
                        alt={name}
                        style={{ width: 32, height: 32, objectFit: 'contain' }}
                      />
                      <span
                        style={{
                          fontSize: 8,
                          color: 'var(--muted)',
                          fontFamily: 'monospace',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {name}
                      </span>
                    </div>
                  ))}
                </div>
              </Row>
            </Section>
          </NavContext.Provider>
        </div>
      </div>
    </WindowFrame>
  )
}
