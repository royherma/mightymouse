import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  Circle,
  Coins,
  Layers,
  Clock,
  Cpu,
  Dot,
  FileText,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Gauge,
  Hash,
  ListTodo,
  ListTree,
  Send,
  Timer,
  LayoutGrid,
  MapPin,
  Play,
  SquareTerminal,
  Tag,
  Target,
  UserRound,
  Users,
  Wrench,
  BarChart3,
  type LucideIcon
} from 'lucide-react'
import { ProviderIcon, type ProviderIconId } from './ProviderIcon'
import { CONFIG } from '../../../shared/config'
import { agentVendor } from '../../../shared/relay-status'
import { planName } from '../../../shared/model-label'
import { relayProgressBand, relayProgressPct } from '../../../shared/relay-progress'
import type { AgentChecklist, AgentRelaySessionInfo, AgentSessionUsage, AgentTranscriptTurn } from '../../../shared/types'
import type { SessionRow } from '../../../shared/relay-status'
import type { RosterAgent } from '../../../shared/coordination-roster'
import { BUILT_KIND_LABELS, type BuiltItem } from '../../../shared/built'
import {
  Line,
  messageLine,
  messageSubs,
  workLine,
  workSubs
} from '../../../shared/coordination-lines'
import { Switch } from './Switch'
import { Button } from './Button'
import { CopyButton } from './CopyButton'
import { FileRow, fileFolder, findPaths, isFilePath, isMediaPath } from './local-path'
import { ProofSection, proofMoments } from './proof-timeline'
import { McpConnectionsSection } from './mcp-connections'
import { AffectsSection } from './affects-section'
import { ReportsRailSection } from './ReportsPanel'
import { AgentScreen } from './agent-screen'
import { exactUptime, startedAt, shortWhen, lastMessageAt } from './session-facts'
import { RAIL_PANEL } from '../hooks/useRailMode'

export function Fact(props: {
  label: string
  value?: string
  mono?: boolean
  title?: string
  mark?: React.ReactNode
  icon?: LucideIcon
}): React.JSX.Element | null {
  if (!props.value) return null
  const Icon = props.icon
  return (
    <div className="agent-rail-fact">
      <span className="agent-rail-fact-label">
        {Icon && <Icon size={13} strokeWidth={2} />}
        {props.label}
      </span>
      <span
        className="agent-rail-fact-value"
        data-mono={props.mono ? '' : undefined}
        title={props.title ?? props.value}
      >
        {props.mark}
        <span className="agent-rail-fact-text">{props.value}</span>
      </span>
    </div>
  )
}

const ISLANDS_MIN_WIDTH = 480
const IslandsGrid = createContext(false)

function RailIslands(props: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= ISLANDS_MIN_WIDTH))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <IslandsGrid.Provider value={wide}>
      <div ref={ref} className="agent-rail-islands" data-grid={wide || undefined}>
        {props.children}
      </div>
    </IslandsGrid.Provider>
  )
}

export function RailSection(props: {
  title: string
  open: boolean
  onToggle: () => void
  badge?: React.ReactNode
  pinned?: boolean
  icon?: LucideIcon
  children: React.ReactNode
}): React.JSX.Element {
  const Icon = props.icon
  const inGrid = useContext(IslandsGrid)
  const open = props.open || inGrid
  const pinned = props.pinned || inGrid
  return (
    <div className="agent-rail-section">
      <Button
        variant="bare"
        className="agent-rail-section-toggle"
        aria-expanded={open}
        onClick={pinned ? undefined : props.onToggle}
        data-pinned={pinned || undefined}
      >
        {!pinned && <ChevronRight size={12} strokeWidth={2.5} data-open={open || undefined} />}
        {Icon && <Icon className="agent-rail-section-icon" size={13} strokeWidth={2.25} />}
        {props.title}
        {props.badge && <span className="agent-rail-section-badge">{props.badge}</span>}
      </Button>
      {open && <div className="agent-rail-section-body">{props.children}</div>}
    </div>
  )
}

export function ChecklistStep(props: { item: AgentChecklist['items'][number] }): React.JSX.Element {
  const { item } = props
  const mark =
    item.status === 'completed' ? (
      <Check size={11} strokeWidth={3} />
    ) : item.status === 'in_progress' ? (
      <Dot size={14} strokeWidth={4} />
    ) : (
      <Circle size={8} strokeWidth={2.5} />
    )
  return (
    <div className="agent-rail-step" data-status={item.status} data-waiting={item.waiting || undefined}>
      <span className="agent-rail-step-mark">{mark}</span>
      <span className="agent-rail-step-label">
        {item.label}
        {item.waiting && <span className="agent-rail-step-waiting">needs you</span>}
      </span>
    </div>
  )
}

const SET_GOAL_ASK =
  'Before the next step: what is the goal of what you are doing right now, and what are the steps to get there? Run the exec-checklist skill so it shows up here.'

function GoalEmpty(props: { sessionRef: string }): React.JSX.Element {
  const [sent, setSent] = useState<'idle' | 'sending' | 'ok' | 'failed'>('idle')
  const ask = (): void => {
    setSent('sending')
    void window.api.agentRelaySessionReply(props.sessionRef, SET_GOAL_ASK).then(
      (r) => setSent(r.ok ? 'ok' : 'failed'),
      () => setSent('failed')
    )
  }
  return (
    <div className="agent-rail-goal-empty">
      <p className="agent-rail-goal-empty-text">
        {sent === 'ok'
          ? 'Asked. Its goal and steps show up here once it answers.'
          : sent === 'failed'
            ? "Couldn't reach this agent. Open it and ask there."
            : 'No goal set.'}
      </p>
      {sent !== 'ok' && (
        <Button
          variant="bare"
          className="agent-rail-goal-empty-button"
          onClick={ask}
          disabled={sent === 'sending'}
        >
          {sent === 'sending' ? 'Asking…' : sent === 'failed' ? 'Try again' : 'Set a goal'}
        </Button>
      )}
    </div>
  )
}

const MODEL_VENDORS: ReadonlyArray<[RegExp, ProviderIconId]> = [
  [/claude|opus|sonnet|haiku|fable/i, 'claude'],
  [/gpt|codex|\bo\d/i, 'codex'],
  [/gemini/i, 'gemini']
]

function modelVendor(model: string | undefined): ProviderIconId | undefined {
  return model ? MODEL_VENDORS.find(([re]) => re.test(model))?.[1] : undefined
}

function vendorMark(vendor: string | undefined): React.ReactNode {
  return vendor ? <ProviderIcon id={vendor as ProviderIconId} size={13} /> : undefined
}

const SAID_LINES = 3
const SAID_CHARS = 280

export function workingOn(tldr: string | undefined, said: string | undefined): string {
  const recap = tldr?.trim()
  if (recap) return recap
  const text = said?.trim()
  if (!text) return 'Nothing reported yet.'
  const clipped = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, SAID_LINES)
    .join('\n')
  if (clipped.length <= SAID_CHARS) return clipped
  return `${clipped.slice(0, SAID_CHARS).trimEnd()}…`
}

const FILES_SHOWN = 6

function threadFiles(turns: readonly AgentTranscriptTurn[], cwd?: string): string[] {
  const seen = new Set<string>()
  for (const turn of [...turns].reverse()) {
    if (turn.role === 'you') continue
    for (const found of findPaths(turn.text, cwd)) if (isFilePath(found.path) && !isMediaPath(found.path)) seen.add(found.path)
  }
  return [...seen]
}

// Groups keep the newest-first order: a folder sits where its most recent file was.
function groupByFolder(paths: string[]): [string, string[]][] {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const folder = fileFolder(path)
    groups.set(folder, [...(groups.get(folder) ?? []), path])
  }
  return [...groups]
}

export function FilesSection(props: {
  files: string[]
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const [all, setAll] = useState(false)
  const shown = all ? props.files : props.files.slice(0, FILES_SHOWN)
  return (
    <RailSection
      title="Files"
      icon={FileText}
      open={props.open}
      onToggle={props.onToggle}
      badge={String(props.files.length)}
    >
      {groupByFolder(shown).map(([folder, paths]) => (
        <div key={folder} className="agent-rail-file-group">
          <span className="agent-rail-file-folder" title={folder}>
            <Folder size={12} strokeWidth={2} />
            {folder || 'Project root'}
          </span>
          {paths.map((path) => (
            <FileRow key={path} path={path} inGroup />
          ))}
        </div>
      ))}
      {props.files.length > FILES_SHOWN && (
        <Button variant="bare" className="agent-rail-files-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${props.files.length}`}
        </Button>
      )}
    </RailSection>
  )
}

function MadeSection(props: { sessionId: string; open: boolean; onToggle: () => void }): React.JSX.Element | null {
  const [items, setItems] = useState<BuiltItem[]>([])
  const [all, setAll] = useState(false)
  useEffect(() => {
    void window.api.built.list().then((list) => setItems(list ?? []))
    return window.api.built.onChanged(setItems)
  }, [])
  const made = items
    .filter((item) => item.sessionId === props.sessionId)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  if (made.length === 0) return null
  const shown = all ? made : made.slice(0, FILES_SHOWN)
  return (
    <RailSection title="Made" icon={LayoutGrid} open={props.open} onToggle={props.onToggle} badge={String(made.length)}>
      {shown.map((item) => (
        <Button
          key={item.id}
          variant="bare"
          className="local-path local-path-row"
          title={item.url ?? item.file}
          onClick={() => void window.api.built.open(item.id, 'open')}
        >
          <LayoutGrid size={13} strokeWidth={2} />
          <span className="local-path-row-name">{item.title}</span>
          <span className="local-path-row-folder">{BUILT_KIND_LABELS[item.kind]}</span>
        </Button>
      ))}
      {made.length > FILES_SHOWN && (
        <Button variant="bare" className="agent-rail-files-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${made.length}`}
        </Button>
      )}
    </RailSection>
  )
}

const compactTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000).toLocaleString()}k` : String(n))

function UsageSection(props: {
  sessionRef: string
  refreshKey: string
  plan?: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const [usage, setUsage] = useState<AgentSessionUsage | null>(null)
  useEffect(() => {
    let live = true
    void window.api.agentRelaySessionUsage(props.sessionRef).then((u) => live && setUsage(u))
    return () => {
      live = false
    }
  }, [props.sessionRef, props.refreshKey])
  if (!usage) return null
  const context = usage.context
    ? usage.contextWindow
      ? `${compactTokens(usage.context)} of ${compactTokens(usage.contextWindow)}`
      : compactTokens(usage.context)
    : undefined
  return (
    <RailSection title="Usage" icon={Coins} open={props.open} onToggle={props.onToggle}>
      <Fact label="Tokens written" icon={BarChart3} value={usage.output.toLocaleString()} />
      <Fact label="Context now" icon={Layers} value={context} title="How much the agent is holding in mind right now" />
      {usage.planUsedPct !== undefined && <Fact label="Plan limit used" icon={Gauge} value={`${Math.round(usage.planUsedPct)}%`} />}
      {usage.account && <Fact label="Account" icon={UserRound} value={usage.account} />}
      {props.plan && (
        <div className="agent-rail-fact">
          <span className="agent-rail-fact-label">
            <Coins size={13} strokeWidth={2} />
            Cost
          </span>
          <span className="agent-rail-fact-value">
            <span className="chat-details-plan-chip">Included in your {props.plan}</span>
          </span>
        </div>
      )}
    </RailSection>
  )
}

export function FolderActions(props: { cwd: string; title?: string }): React.JSX.Element {
  return (
    <>
      <Button
        variant="bare"
        className="session-detail-action"
        onClick={() => void window.api.openPath(props.cwd)}
        title={props.title}
      >
        <FolderOpen size={12} strokeWidth={2.5} />
        Open folder
      </Button>
      <CopyButton showLabel label="Copy path" text={props.cwd} />
    </>
  )
}

export interface AgentContextRailProps {
  session: AgentRelaySessionInfo
  row: SessionRow
  now: number
  actions?: React.ReactNode
  shared?: Pick<RosterAgent, 'work' | 'messages'>
  turns?: readonly AgentTranscriptTurn[]
  transcriptStatus?: 'loading' | 'failed' | 'ready'
  checklist?: AgentChecklist
  sessionRef: string
  steps?: { on: boolean; onChange: (next: boolean) => void }
  head?: React.ReactNode
  screen?: React.ReactNode
}

export function AgentContextRail(props: AgentContextRailProps): React.JSX.Element {
  const { session, row, now, actions, shared, checklist, sessionRef } = props
  const [open, setOpen] = useState<Record<string, boolean>>({
    plan: false,
    affects: true,
    shared: true,
    where: true,
    files: true,
    made: true,
    proof: true,
    apps: true,
    numbers: true,
    usage: true,
    what: false,
    session: false
  })
  const toggle = (key: string): void => setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  const plan = checklist && (checklist.goal || checklist.items.length > 0) ? checklist : undefined
  const agentAt = lastMessageAt(props.turns ?? [], 'agent')
  const userAt = lastMessageAt(props.turns ?? [], 'you')
  const missingTime = props.transcriptStatus === 'loading'
    ? 'Loading…'
    : props.transcriptStatus === 'failed'
      ? 'Unavailable'
      : (props.turns ?? []).length === 0
        ? CONFIG.UI_LABELS.CODE_SESSION_NOT_YET
        : 'Not in recent history'
  const hasShared = shared && (shared.work.length > 0 || shared.messages.length > 0)
  const files = threadFiles(props.turns ?? [], session.cwd)
  const proof = proofMoments(props.turns ?? [], session.cwd)

  return (
    <aside className="agent-rail" data-closes={RAIL_PANEL}>
      {props.head}
      {props.screen ?? <RailScreen sessionRef={sessionRef} />}

      {session.progress !== undefined && relayProgressBand(session.progress) && (
        <div className="agent-rail-progress" data-band={relayProgressBand(session.progress)}>
          <div className="agent-rail-progress-head">
            <span className="agent-rail-tldr-label">Progress</span>
            <span className="agent-rail-progress-count">
              {plan && plan.items.length > 0 && `${plan.done} of ${plan.items.length} steps · `}
              <strong>{relayProgressPct(session.progress)}%</strong>
            </span>
          </div>
          <div className="agent-rail-progress-track">
            <div className="agent-rail-progress-fill" style={{ width: `${relayProgressPct(session.progress)}%` }} />
          </div>
        </div>
      )}

      <RailSection
        title="Goal"
        icon={Target}
        open={plan ? open.plan : true}
        onToggle={() => toggle('plan')}
        pinned={!plan}
        badge={plan && plan.items.length > 0 ? `${plan.done}/${plan.items.length}` : undefined}
      >
        {plan ? (
          <>
            {plan.goal && <p className="agent-rail-goal">{plan.goal}</p>}
            {plan.items.map((item, i) => (
              <ChecklistStep key={`${i}-${item.label}`} item={item} />
            ))}
          </>
        ) : (
          <GoalEmpty sessionRef={sessionRef} />
        )}
      </RailSection>

      <div className="agent-rail-activity">
        <Fact
          label="Agent replied"
          icon={Clock}
          value={agentAt ? shortWhen(agentAt, now) : missingTime}
          title={agentAt ? startedAt(agentAt) : undefined}
        />
        <Fact
          label="You sent"
          icon={Send}
          value={userAt ? shortWhen(userAt, now) : missingTime}
          title={userAt ? startedAt(userAt) : undefined}
        />
        <Fact label="Session age" icon={Timer} value={exactUptime(session.since, now)} title={startedAt(session.since)} />
        {props.steps && (
          <label className="agent-rail-fact" data-setting="">
            <span className="agent-rail-fact-label">
              <ListTree size={13} strokeWidth={2} />
              Show steps for all agents
            </span>
            <Switch on={props.steps.on} onChange={props.steps.onChange} />
          </label>
        )}
      </div>

      {actions}

      <RailIslands>
        <UsageSection
          sessionRef={sessionRef}
          refreshKey={`${props.turns?.length}:${props.turns?.at(-1)?.at}`}
          plan={planName(agentVendor(session.agent))}
          open={open.usage}
          onToggle={() => toggle('usage')}
        />

        <AffectsSection
          sessionRef={sessionRef}
          refreshKey={`${props.turns?.length}:${props.turns?.at(-1)?.at}`}
          now={now}
          open={open.affects}
          onToggle={() => toggle('affects')}
        />

        {proof.length > 0 && (
          <ProofSection moments={proof} now={now} open={open.proof} onToggle={() => toggle('proof')} />
        )}

        {hasShared && (
          <RailSection title="Shared work" icon={Users} open={open.shared} onToggle={() => toggle('shared')}>
            {shared.work.map((item) => (
              <div key={item.id} className="agent-rail-shared-row">
                {!item.emoji && <ListTodo size={14} strokeWidth={2} />}
                <Line title={item.title} meta={workLine(item)} subs={workSubs(item)} emoji={item.emoji} />
              </div>
            ))}
            {shared.messages.map((entry) => {
              const Arrow = entry.outgoing ? ArrowUpRight : ArrowDownLeft
              return (
                <div key={entry.message.id + String(entry.outgoing)} className="agent-rail-shared-row">
                  <Arrow size={14} strokeWidth={2} />
                  <Line
                    title={`${entry.outgoing ? 'To' : 'From'} ${entry.otherLabel}: ${entry.message.subject}`}
                    meta={messageLine(entry.message.state, entry.message.offeredAt)}
                    subs={messageSubs(entry.message)}
                  />
                </div>
              )
            })}
          </RailSection>
        )}

        {session.sessionId && (
          <MadeSection sessionId={session.sessionId} open={open.made} onToggle={() => toggle('made')} />
        )}

        {files.length > 0 && (
          <FilesSection files={files} open={open.files} onToggle={() => toggle('files')} />
        )}

        {session.cwd && (
          <ReportsRailSection
            cwd={session.cwd}
            section={({ badge, children }) => (
              <RailSection
                title={CONFIG.UI_LABELS.REPORTS_RAIL_TITLE}
                icon={BarChart3}
                open={open.numbers}
                onToggle={() => toggle('numbers')}
                badge={badge}
              >
                {children}
              </RailSection>
            )}
          />
        )}

        {session.cwd && agentVendor(session.agent) === 'claude' && (
          <McpConnectionsSection cwd={session.cwd} open={open.apps} onToggle={() => toggle('apps')} />
        )}

        <RailSection title="Location" icon={MapPin} open={open.where} onToggle={() => toggle('where')}>
          <Fact label="Repo" value={row.repo} icon={FolderGit2} />
          <Fact label="Branch" value={row.branch} icon={GitBranch} mono />
          <Fact label="Folder" value={session.cwd} icon={Folder} mono />
          <Fact
            label="App"
            icon={SquareTerminal}
            value={session.hostAppName}
            mark={
              session.hostAppIconPngBase64 ? (
                <img
                  className="agent-rail-fact-app-icon"
                  src={`data:image/png;base64,${session.hostAppIconPngBase64}`}
                  alt=""
                />
              ) : undefined
            }
          />
          <Fact label="Where" value={session.whereLabel} icon={MapPin} mono />
        </RailSection>

        <RailSection title="Agent" icon={Bot} open={open.what} onToggle={() => toggle('what')}>
          <Fact label="Harness" value={row.agent} icon={Bot} mark={vendorMark(agentVendor(session.agent))} />
          <Fact label="Model" value={row.model} icon={Cpu} mark={vendorMark(modelVendor(row.model))} />
          <Fact label="Effort" value={row.effort} icon={Gauge} />
          <Fact label="Started by" value={session.entrypoint} icon={Play} />
        </RailSection>

        <RailSection title="Technical details" icon={Wrench} open={open.session} onToggle={() => toggle('session')}>
          <Fact label="Started" value={startedAt(session.since)} icon={Clock} />
          <Fact label="Process" value={session.pid ? String(session.pid) : undefined} icon={Cpu} mono />
          <Fact label="Session id" value={session.sessionId} icon={Hash} mono />
          <Fact label="Full name" value={session.label} icon={Tag} mono />
        </RailSection>
      </RailIslands>
    </aside>
  )
}

const RAIL_SCREEN_HIDDEN_KEY = 'agent-rail-screen-hidden'

function RailScreen(props: { sessionRef: string }): React.JSX.Element {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(RAIL_SCREEN_HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const remember = (next: boolean): void => {
    setHidden(next)
    try {
      localStorage.setItem(RAIL_SCREEN_HIDDEN_KEY, next ? '1' : '0')
    } catch {
      return
    }
  }
  if (hidden)
    return (
      <Button variant="bare" className="agent-screen-show" onClick={() => remember(false)}>
        <SquareTerminal size={13} strokeWidth={2} />
        Show terminal
      </Button>
    )
  return <AgentScreen sessionRef={props.sessionRef} onHide={() => remember(true)} />
}

export function DraftRail(props: {
  projectName: string
  cwd: string
  harness?: string
  model?: string
  head?: React.ReactNode
}): React.JSX.Element {
  return (
    <aside className="agent-rail" data-closes={RAIL_PANEL}>
      {props.head}
      <div className="agent-rail-activity">
        <Fact label="Agent replied" icon={Clock} value="Not started" />
        <Fact label="You sent" icon={Send} value="Not yet" />
        <Fact label="Session age" icon={Timer} value="Not started" />
      </div>

      {props.cwd && (
        <div className="session-detail-actions">
          <FolderActions cwd={props.cwd} />
        </div>
      )}

      <RailSection title="Goal" icon={Target} open pinned onToggle={() => {}}>
        <p className="agent-rail-goal-empty-text">Its goal and steps show up here once it starts.</p>
      </RailSection>

      <RailIslands>
        <RailSection title="Location" icon={MapPin} open pinned onToggle={() => {}}>
          <Fact label="Project" value={props.projectName} icon={FolderGit2} />
          <Fact label="Folder" value={props.cwd} icon={Folder} mono />
        </RailSection>

        {props.cwd && agentVendor(props.harness) === 'claude' && <DraftApps cwd={props.cwd} />}

        <RailSection title="Agent" icon={Bot} open pinned onToggle={() => {}}>
          <Fact label="Harness" value={props.harness ?? 'Loading…'} icon={Bot} mark={vendorMark(agentVendor(props.harness))} />
          <Fact label="Model" value={props.model ?? 'Default'} icon={Cpu} mark={vendorMark(modelVendor(props.model))} />
        </RailSection>
      </RailIslands>
    </aside>
  )
}

function DraftApps(props: { cwd: string }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return <McpConnectionsSection cwd={props.cwd} open={open} onToggle={() => setOpen((v) => !v)} />
}
