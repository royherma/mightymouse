import { JSX, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { SquareTerminal } from 'lucide-react'
import { SessionDetail } from '../components/session-detail'
import { BrowserPageContext } from '../components/session-thread'
import { AgentDraftPane } from '../components/AgentDraftPane'
import { StartingAgent, startedSession } from '../components/starting-agent'
import { Button } from '../components/Button'
import { Row } from '../components/Layout'
import type { AgentRelayFeed } from '../hooks/useAgentRelay'
import { titleUnderlineTone, type PaneOpenColorId } from './pane-colors'
import { relayStatusLine } from '../../../shared/relay-status'
import { CONFIG } from '../../../shared/config'
import { mightyProjectForCwd } from '../../../shared/relay-sessions'
import { browserPageTag } from '../../../shared/attachments'
import { previousList, senderMatchKey } from '../../../shared/relay-cards'
import type { AgentModelChoice, AgentRelaySessionInfo, MightyProject } from '../../../shared/types'
import type { ReasoningEffort } from '../../../shared/model-sources'

export type CodeAgentRelay = Pick<
  AgentRelayFeed,
  'status' | 'clients' | 'pending' | 'resolved' | 'dismissed' | 'respond'
>

type Starting = { since: number; pane?: string }

function findSession(
  names: AgentRelaySessionInfo[],
  label: string
): AgentRelaySessionInfo | undefined {
  return names.find((s) => s.sessionId === label || s.label === label || s.stated === label)
}

export function CodeAgentPane({
  label,
  cwd,
  relay,
  projects,
  slotColor,
  headerAddAction,
  headerCloseAction,
  onAgent,
  onClose,
  firstSend,
  onFirstSendTaken,
  onProjectChange,
  onStart,
  bare = false
}: {
  label?: string
  cwd?: string
  relay: CodeAgentRelay
  projects: MightyProject[]
  slotColor: PaneOpenColorId | null
  headerAddAction?: ReactNode
  headerCloseAction?: ReactNode
  onAgent: (label: string | undefined) => void
  onClose: () => void
  firstSend?: { message: string; paths: string[] }
  onFirstSendTaken?: () => void
  onProjectChange?: (projectId: string | undefined) => void
  onStart?: (opening: { text: string; files: string[] }) => void
  bare?: boolean
}): JSX.Element {
  const names = useMemo(
    () => relayStatusLine(relay.status, relay.clients).names,
    [relay.status, relay.clients]
  )
  const live = label ? findSession(names, label) : undefined
  const session: AgentRelaySessionInfo = live ?? { label: label ?? '', stale: true }
  const key = senderMatchKey(session.stated ?? session.label)
  const history = useMemo(
    () =>
      label
        ? [...relay.pending, ...previousList(relay.resolved, relay.dismissed ?? [])]
            .filter((r) => senderMatchKey(r.params.from) === key)
            .sort((a, b) => b.createdAt - a.createdAt)
        : [],
    [label, relay.pending, relay.resolved, relay.dismissed, key]
  )

  const project = mightyProjectForCwd(live?.cwd ?? cwd, projects)
  const projectName = project?.name ?? cwd?.split('/').pop() ?? ''
  const memoryKey = useId()
  const [starting, setStarting] = useState<Starting | null>(null)
  const [failure, setFailure] = useState<{ message: string; reason: string } | undefined>()
  const [now, setNow] = useState(() => Date.now())
  const browserPage = useContext(BrowserPageContext)

  useEffect(() => {
    if (!starting) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [starting])

  useEffect(() => {
    if (!starting || !cwd) return
    const pick = startedSession(names, { ...starting, cwd })
    if (!pick) return
    setStarting(null)
    onAgent(pick.sessionId ?? pick.stated ?? pick.label)
  }, [names, starting, cwd, onAgent])

  const start = async (
    message: string,
    paths: string[],
    model: AgentModelChoice | null,
    effort?: ReasoningEffort
  ): Promise<void> => {
    if (!cwd) return
    const since = Date.now()
    setFailure(undefined)
    setStarting({ since })
    setNow(since)
    const page = browserPage?.()
    const result = await window.api.codeStartAgent({
      project: projectName,
      cwd,
      inApp: true,
      message: page ? browserPageTag(page) + message : message,
      paths,
      ...(model ? { harness: model.harness, model: model.model } : {}),
      effort
    })
    if (!result.ok) {
      setStarting(null)
      setFailure({ message, reason: result.reason })
      return
    }
    onStart?.({ text: message, files: paths })
    setStarting((prev) => (prev?.since === since ? { ...prev, pane: result.pane } : prev))
  }

  useEffect(() => {
    if (!firstSend || label || !cwd) return
    onFirstSendTaken?.()
    void start(firstSend.message, firstSend.paths, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSend])

  const name = live
    ? live.tldr || live.stated || live.label
    : label
      ? CONFIG.UI_LABELS.CODE_AGENT_PANE_NAME
      : projectName

  const body = (): JSX.Element => {
    if (!label && cwd && starting)
      return (
        <StartingAgent
          pane={starting.pane}
          project={projectName}
          since={starting.since}
          now={now}
          onClose={() => setStarting(null)}
        />
      )
    if (!label && cwd)
      return (
        <AgentDraftPane
          draft={{
            groupId: project?.id ?? cwd,
            name: projectName,
            cwd,
            projectId: project?.id,
            icon: project?.icon,
            imagePath: project?.imagePath
          }}
          projects={projects}
          onSend={start}
          onProjectChange={onProjectChange}
          failure={failure}
          memoryKey={memoryKey}
          compact
        />
      )
    if (!live && history.length === 0)
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted">
          <p>{CONFIG.UI_LABELS.CODE_AGENT_PANE_GONE}</p>
          {cwd && (
            <Button variant="ghost" onClick={() => onAgent(undefined)}>
              {CONFIG.UI_LABELS.CODE_AGENT_PANE_NEW}
            </Button>
          )}
        </div>
      )
    return (
      <SessionDetail
        session={session}
        history={history}
        onRespond={relay.respond}
        onBack={onClose}
        withRail={false}
        project={project ?? undefined}
      />
    )
  }

  return (
    <div className="h-full flex flex-col min-h-0 bg-surface1">
      {!bare && <Row className="shrink-0 gap-2 px-3 py-1.5 border-b border-surface2">
        <SquareTerminal size={14} className="text-muted shrink-0" />
        <span
          title={name}
          className={`text-sm font-medium text-on-surface truncate inline-block w-fit max-w-full pb-0.5 ${titleUnderlineTone(slotColor)}`}
        >
          {name}
        </span>
        <span className="flex-1 min-w-0" aria-hidden />
        {headerAddAction}
        {headerCloseAction}
      </Row>}
      <div className="flex-1 min-h-0 flex flex-col">{body()}</div>
    </div>
  )
}
