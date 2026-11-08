import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BarChart3, Clock, Coins, Cpu, EyeOff, Folder, FolderGit2, Hash, Hourglass, ListChecks, ListTree, MapPin, MessageSquare, Send, SquareTerminal, Timer } from 'lucide-react'
import { Fact, FilesSection, FolderActions, RailSection } from '../components/agent-context-rail'
import { ProofSection, proofMoments } from '../components/proof-timeline'
import { findPaths, isFilePath, isMediaPath } from '../components/local-path'
import { CHAT_SHOW_STEPS_KEY, useSharedFlag } from '../components/ViewModeMenu'
import { Switch } from '../components/Switch'
import { Button } from '../components/Button'
import { useIsAdmin } from '../hooks/useIsAdmin'
import '../components/AgentScreen.css'
import { ProviderIcon, type ProviderIconId } from '../components/ProviderIcon'
import { exactUptime, shortWhen, startedAt } from '../components/session-facts'
import { planName, runLabel } from '../../../shared/model-label'
import type { AgentTranscriptTurn, MightyProject, MightySession, MightyTurn } from '../../../shared/types'
import { formatDuration } from './mighty-shared'

const SHOW_TIMING_EVENT = 'mm.showTiming'

export function useChatShowSteps(): [boolean, (next: boolean) => void] {
  return useSharedFlag(CHAT_SHOW_STEPS_KEY, true)
}

// Mirrors PREFS showTiming; the rail and every open pane share one value without a reload.
export function useShowTiming(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const sync = (): void => void window.api.settingsGetPrefs().then((p) => setOn(p.showTiming))
    sync()
    window.addEventListener(SHOW_TIMING_EVENT, sync)
    return () => window.removeEventListener(SHOW_TIMING_EVENT, sync)
  }, [])
  const set = (next: boolean): void => {
    setOn(next)
    void window.api.settingsSetShowTiming(next).then(() => window.dispatchEvent(new Event(SHOW_TIMING_EVENT)))
  }
  return [on, set]
}

function usageTotals(turns: MightyTurn[]): { tokens: number; planUsd: number; plans: Set<string>; chargedUsd: number } | null {
  let tokens = 0
  let planUsd = 0
  let chargedUsd = 0
  const plans = new Set<string>()
  let any = false
  for (const t of turns) {
    if (!t.usage) continue
    any = true
    tokens += t.usage.inputTokens + t.usage.outputTokens
    if (t.usage.free || t.usage.costUsd === undefined) continue
    const plan = planName(t.backend)
    if (plan) {
      plans.add(plan)
      planUsd += t.usage.costUsd
    } else chargedUsd += t.usage.costUsd
  }
  return any ? { tokens, planUsd, plans, chargedUsd } : null
}

function workTotals(turns: MightyTurn[]): { steps: number; failed: number; ms: number } {
  let steps = 0
  let failed = 0
  let ms = 0
  for (const t of turns) {
    steps += t.toolCalls?.length ?? 0
    failed += t.toolCalls?.filter((call) => !call.ok).length ?? 0
    ms += t.durationMs ?? 0
  }
  return { steps, failed, ms }
}

function transcriptOf(turns: MightyTurn[]): AgentTranscriptTurn[] {
  return turns.flatMap((t) => {
    const at = Date.parse(t.ts)
    return [
      { role: 'you' as const, at, text: t.q, files: t.sources },
      { role: 'agent' as const, at, text: t.a, files: t.artifacts }
    ]
  })
}

function namedFiles(turns: MightyTurn[], cwd?: string): string[] {
  const listed = new Set(turns.flatMap((t) => [...(t.artifacts ?? []), ...(t.sources ?? [])]))
  const named = [...turns].reverse().flatMap((t) => findPaths(t.a, cwd).map((found) => found.path))
  return [...new Set(named)].filter((path) => isFilePath(path) && !isMediaPath(path) && !listed.has(path))
}

function providerOf(backend: string | undefined): ProviderIconId | undefined {
  if (!backend) return undefined
  if (/claude/i.test(backend)) return 'claude'
  if (/codex|openai|gpt/i.test(backend)) return 'codex'
  if (/gemini/i.test(backend)) return 'gemini'
  return undefined
}

const CHAT_TERMINAL_SHOWN_KEY = 'chat-terminal-shown'
const TERMINAL_POLL_MS = 1000
const TERMINAL_PINNED_PX = 24

function ChatTerminal(props: { sessionId: string; running: boolean; turnKey: string }): React.JSX.Element {
  const [shown, setShown] = useSharedFlag(CHAT_TERMINAL_SHOWN_KEY, false)
  const [text, setText] = useState<string | null>(null)
  const boxRef = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    if (!shown) return
    let alive = true
    const load = (): void =>
      void window.api.mighty
        .runTerminal(props.sessionId)
        .catch(() => '')
        .then((next) => {
          if (alive) setText(next)
        })
    load()
    const timer = props.running ? setInterval(load, TERMINAL_POLL_MS) : undefined
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [shown, props.sessionId, props.running, props.turnKey])

  useLayoutEffect(() => {
    const box = boxRef.current
    if (box && pinned.current) box.scrollTop = box.scrollHeight
  }, [text, shown])

  if (!shown)
    return (
      <Button variant="bare" className="agent-screen-show" onClick={() => setShown(true)}>
        <SquareTerminal size={13} strokeWidth={2} />
        Show terminal
      </Button>
    )
  const empty = text === null ? 'Loading…' : props.running ? 'Waiting for the first output…' : 'No terminal output for this reply.'
  return (
    <div className="agent-screen-wrap">
      <pre
        ref={boxRef}
        className="agent-screen agent-screen-raw"
        onScroll={(e) => {
          const box = e.currentTarget
          pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < TERMINAL_PINNED_PX
        }}
      >
        {text || empty}
      </pre>
      <Button variant="bare" className="agent-screen-hide" title="Hide terminal" aria-label="Hide terminal" onClick={() => setShown(false)}>
        <EyeOff size={13} strokeWidth={2} />
      </Button>
    </div>
  )
}

export function ChatDetails(props: {
  name: string
  turns: MightyTurn[]
  session?: MightySession
  project?: MightyProject
}): React.JSX.Element {
  const { name, turns, session, project } = props
  const [open, setOpen] = useState({ proof: true, files: true, chat: true, usage: true, where: true })
  const toggle = (key: keyof typeof open): void => setOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  const [showSteps, setShowSteps] = useChatShowSteps()
  const [showTiming, setShowTiming] = useShowTiming()
  const isAdmin = useIsAdmin()
  const now = Date.now()

  const replied = [...turns].reverse().find((t) => t.a.trim() !== '')
  const lastSent = turns.at(-1)
  const backend = replied?.backend || session?.backend
  const created = session?.created ? Date.parse(session.created) : undefined
  const totals = usageTotals(turns)
  const replies = turns.filter((t) => t.a.trim() !== '').length
  const work = workTotals(turns)
  const proof = proofMoments(transcriptOf(turns), project?.repoFolder)
  const files = namedFiles(turns, project?.repoFolder)

  return (
    <div className="agent-rail chat-details">
      {isAdmin && session && (
        <ChatTerminal sessionId={session.id} running={lastSent?.a === ''} turnKey={`${turns.length}:${lastSent?.ts}`} />
      )}

      {proof.length > 0 && (
        <ProofSection moments={proof} agentName={name} now={now} open={open.proof} onToggle={() => toggle('proof')} />
      )}

      {files.length > 0 && <FilesSection files={files} open={open.files} onToggle={() => toggle('files')} />}

      <RailSection title="Chat" icon={MessageSquare} open={open.chat} onToggle={() => toggle('chat')}>
        <Fact
          label="Model"
          icon={Cpu}
          value={backend ? runLabel(backend, replied?.model) : undefined}
          mark={providerOf(backend) && <ProviderIcon id={providerOf(backend)!} size={13} />}
        />
        <Fact
          label={`${name} replied`}
          icon={Clock}
          value={replied ? shortWhen(Date.parse(replied.ts), now) : 'Not yet'}
          title={replied ? startedAt(Date.parse(replied.ts)) : undefined}
        />
        <Fact
          label="You sent"
          icon={Send}
          value={lastSent ? shortWhen(Date.parse(lastSent.ts), now) : undefined}
          title={lastSent ? startedAt(Date.parse(lastSent.ts)) : undefined}
        />
        <Fact label="Started" icon={Timer} value={exactUptime(created, now) && `${exactUptime(created, now)} ago`} title={startedAt(created)} />
        <Fact label="Last reply took" icon={Hourglass} value={replied?.durationMs ? formatDuration(replied.durationMs) : undefined} />
        <label className="agent-rail-fact" data-setting="">
          <span className="agent-rail-fact-label">
            <ListTree size={13} strokeWidth={2} />
            Show steps
          </span>
          <Switch on={showSteps} onChange={setShowSteps} />
        </label>
        <label className="agent-rail-fact" data-setting="">
          <span className="agent-rail-fact-label">
            <BarChart3 size={13} strokeWidth={2} />
            Show time and cost under replies
          </span>
          <Switch on={showTiming} onChange={setShowTiming} />
        </label>
      </RailSection>

      {(totals || work.steps > 0 || work.ms > 0) && (
        <RailSection title="Usage" icon={Coins} open={open.usage} onToggle={() => toggle('usage')}>
          <Fact label="Replies" icon={Hash} value={String(replies)} />
          <Fact label="Tokens" icon={BarChart3} value={totals?.tokens.toLocaleString()} />
          <Fact
            label="Steps"
            icon={ListChecks}
            value={work.steps > 0 ? `${work.steps}${work.failed > 0 ? ` · ${work.failed} failed` : ''}` : undefined}
          />
          <Fact label="Time working" icon={Hourglass} value={work.ms > 0 ? formatDuration(work.ms) : undefined} />
          {totals && totals.plans.size > 0 && (
            <div className="agent-rail-fact" title={`$${totals.planUsd.toFixed(2)} at API prices`}>
              <span className="agent-rail-fact-label">
                <Coins size={13} strokeWidth={2} />
                Cost
              </span>
              <span className="chat-details-plan-chip">Included in your {[...totals.plans].join(' and ')}</span>
            </div>
          )}
          {totals && totals.chargedUsd > 0 && <Fact label="Charged" icon={Coins} value={`$${totals.chargedUsd.toFixed(2)}`} />}
          {totals && totals.plans.size === 0 && totals.chargedUsd === 0 && <Fact label="Cost" icon={Coins} value="Free" />}
        </RailSection>
      )}

      {project && (
        <RailSection title="Location" icon={MapPin} open={open.where} onToggle={() => toggle('where')}>
          <Fact label="Project" icon={FolderGit2} value={project.name} />
          <Fact label="Folder" icon={Folder} value={project.repoFolder} mono />
          {project.repoFolder && (
            <div className="session-detail-actions">
              <FolderActions cwd={project.repoFolder} />
            </div>
          )}
        </RailSection>
      )}
    </div>
  )
}
