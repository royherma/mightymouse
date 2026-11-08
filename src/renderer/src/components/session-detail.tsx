import { Button } from './Button'
/**
 * One agent session on its own -- the thing a card in the Sessions grid opens.
 *
 * Sibling of code-detail.tsx and deliberately the same chrome (a back bar, a
 * scrolling body), so the two read as one app rather than two designs. Where
 * they differ is what they are FOR: a request detail is a card you answer, this
 * is a session you talk to -- so the last thing it said and the box you answer
 * it in sit together at the top, and the facts are reference underneath.
 *
 * Shaped to match the phone's SessionList sheet deliberately: the same order,
 * the same collapsed facts, the same copy out of `CONFIG.UI_LABELS`. A session
 * read on the phone and on the Mac is the same session, so it should not be two
 * different screens.
 *
 * Every string still comes from `sessionRow`, the same formatter the card and
 * the hover strip use -- a name that looks wrong here is wrong in three places
 * at once, which is the point.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArchiveRestore, ChevronLeft, ExternalLink, Maximize2, MessageSquare, SquareTerminal, X } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import { RailEdgeToggle, RailModeSwitch, SideBrowser } from './side-browser'
import { useRailBrowserShortcut, useRailMode } from '../hooks/useRailMode'
import { useRailResize } from '../hooks/useRailResize'
import { sessionRow, isOriginResolvable, sessionIsWorking, recapLine, agentVendor, nameFromMessage, isPlaceholderName } from '../../../shared/relay-status'

import type {
  AgentChecklist,
  AgentRelaySessionInfo,
  AgentTranscriptTurn,
  MightyProject
} from '../../../shared/types'
import type { RelayRequestWire, RelayResponseWire } from '../../../shared/phone-remote-protocol'
import type { RosterAgent } from '../../../shared/coordination-roster'
import { AgentContextRail, FolderActions } from './agent-context-rail'
import { GitActions } from './git-actions'
import { AgentScreen } from './agent-screen'
import { SessionThread } from './session-thread'
import { ProjectAvatar } from './ProjectIcon'
import { ConversationMediaProvider } from './media-viewer'
import { mediaIn } from './local-path'
import { SHOW_STEPS_KEY, useSharedFlag, useTerminalView } from './ViewModeMenu'
import './SessionSheet.css'
import type { StartingInfo } from './starting-agent'

export function SessionDetail(props: {
  session: AgentRelaySessionInfo
  /** This session's traffic, newest first, already filtered by the caller --
   *  which holds the lists and the sender join, exactly as CodePanel does for
   *  the request detail. */
  history: RelayRequestWire[]
  onRespond: (requestId: string, response: RelayResponseWire) => void
  onBack: () => void
  /** What this agent is holding in shared work. Rendered in the rail beside the
   *  other context, so it is the same block whichever tab opened the sheet. */
  shared?: Pick<RosterAgent, 'work' | 'messages'>
  /** Only the entrances that REPLACE the pane pass this. The agents list keeps
   *  standing beside the sheet, so a back row there points at what is already
   *  on screen. */
  backLabel?: string
  backTo?: string
  /** The user's title-bar toggle: hides the standing column, never a different screen. */
  withRail?: boolean
  onToggleRail?: () => void
  /** The message that started this agent, while it is still being spawned. Shown
   *  from here because main cannot have recorded it yet. */
  opening?: { text: string; files: string[] }
  starting?: StartingInfo
  threadKey?: string
  project?: MightyProject
  archived?: boolean
  onArchive?: () => void
}): React.JSX.Element {
  const { session, history, onRespond, onBack, shared, backLabel, withRail, opening, starting } = props
  const sessionRef = session.sessionId ?? session.label
  const sheetRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const [railMode, setRailMode] = useRailMode(sessionRef)
  useRailBrowserShortcut(Boolean(withRail), () => setRailMode('browser'))
  const browsing = railMode === 'browser'
  const railResize = useRailResize(sheetRef, 'agent-projects-grip')

  // 1s, not the card's 60s: an exact uptime on a minute clock reads as frozen.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])

  const [jumpFailed, setJumpFailed] = useState(false)
  const [steppedIn, setSteppedIn] = useState(false)
  // Mid-turn means a reply is imminent, which is the only time a faster read
  // buys anything. Read off the same stamps the status dot uses, not a guess.
  const working = sessionIsWorking(session, now)
  const [transcript, setTranscript] = useState<{
    ref: string
    status: 'loading' | 'failed' | 'ready'
    turns: AgentTranscriptTurn[]
  }>({ ref: sessionRef, status: 'loading', turns: [] })
  // Polled, not just on `history.length`: an ordinary turn mints no card, so
  // that count never moves and the thread would sit on its first read forever.
  useEffect(() => {
    let live = true
    const load = (): void => {
      void window.api.agentRelaySessionTranscript(sessionRef).then(
        (turns) => {
          if (live) setTranscript({ ref: sessionRef, status: 'ready', turns })
        },
        () => {
          if (!live) return
          setTranscript((prev) =>
            prev.ref === sessionRef && prev.status === 'ready'
              ? prev
              : { ref: sessionRef, status: 'failed', turns: [] }
          )
        }
      )
    }
    load()
    const poll = setInterval(
      load,
      working ? CONFIG.AGENT_RELAY.THREAD_POLL_BUSY_MS : CONFIG.AGENT_RELAY.THREAD_POLL_MS
    )
    return () => {
      live = false
      clearInterval(poll)
    }
    // NOT `history.length`: a card arriving would tear the poll down and reset
    // the thread to its loading state, blanking turns that are already on screen.
  }, [sessionRef, working])
  const [checklist, setChecklist] = useState<{ ref: string; value?: AgentChecklist }>({
    ref: sessionRef
  })
  // 5s: the checklist is a file another process rewrites, so nothing pushes
  // when an item ticks.
  useEffect(() => {
    let live = true
    const load = (): void => {
      void window.api.agentRelaySessionChecklist(sessionRef).then(
        (value) => {
          if (live) setChecklist({ ref: sessionRef, value })
        },
        () => undefined
      )
    }
    load()
    const poll = setInterval(load, 5000)
    return () => {
      live = false
      clearInterval(poll)
    }
  }, [sessionRef])

  const row = sessionRow(session, now)

  // The label, not a wire copy of the origin: main looks the session up in its
  // own list, so a renderer can never hand the resolver an address to open.
  const jump = async (): Promise<void> => {
    const result = await window.api.agentRelayRevealSession(sessionRef)
    if (!result.ok) {
      setJumpFailed(true)
      setTimeout(() => setJumpFailed(false), 2600)
    }
  }

  const [showSteps, setShowSteps] = useSharedFlag(SHOW_STEPS_KEY, true)
  const [terminalView, setTerminalView] = useTerminalView()
  // Drives the copy under the actions. `stale` is set both by a real reaped
  // session and by the synthesized sheet a finished agent's cards open.
  const ended = row.health === 'ended'
  const folderName =
    row.repo.trim() || session.cwd?.split(/[/\\]/).filter(Boolean).pop() || 'folder'
  const canJump = isOriginResolvable(session.origin)
  const canStepIn = Boolean(session.origin?.tmuxPane) && !ended
  const terminal = terminalView && canStepIn
  const vendor = agentVendor(session.agent)
  const resumeHarness = vendor === 'claude' || vendor === 'codex' ? vendor : null
  const canResume = ended && resumeHarness !== null && Boolean(session.sessionId) && Boolean(session.cwd)
  const continueSession = async (message: string, paths: string[]): Promise<string | null> => {
    if (!canResume || !resumeHarness || !session.sessionId || !session.cwd) return null
    const result = await window.api.codeStartAgent({
      project: folderName,
      cwd: session.cwd,
      harness: resumeHarness,
      inApp: true,
      resume: session.sessionId,
      message,
      paths
    })
    return result.ok ? null : result.reason
  }
  // A new session's ref flips from its label to its id the moment the shim
  // registers, and the turns already on screen are the SAME session's -- blanking
  // them to `loading` for one poll is the flash of an empty thread on open.
  const transcriptNow =
    transcript.ref === sessionRef || transcript.turns.length > 0
      ? transcript
      : { ref: sessionRef, status: 'loading' as const, turns: [] as AgentTranscriptTurn[] }
  const media = useMemo(
    () => mediaIn(transcriptNow.turns.filter((t) => t.role !== 'tool'), session.cwd),
    [transcriptNow.turns, session.cwd]
  )

  const firstAsk = nameFromMessage(transcriptNow.turns.find((t) => t.role === 'you')?.text)
  const title = ((!row.name || isPlaceholderName(row.name, row.branch ?? row.repo)) && firstAsk) || row.name || row.repo

  const actionsBlock = (
    <div className="session-detail-actions">
      {/* Offered ONLY when the origin has something we can actually act on.
          Six of eighteen live sessions report no origin at all (they were
          started outside a terminal we can address), and for those a button
          that always dead-ends is worse than no button: it reads as broken
          rather than as absent. */}
      {canResume ? null : canStepIn || canJump ? (
        <>
          {canStepIn && !terminal && (
            <Button variant="bare" className="session-detail-action" data-primary="" onClick={() => setSteppedIn(true)}>
              <Maximize2 size={12} strokeWidth={2.5} />
              Step in
            </Button>
          )}
          {canJump && (
            <Button
              variant="bare"
              className="session-detail-action"
              data-primary={canStepIn && !terminal ? undefined : ''}
              onClick={jump}
              disabled={jumpFailed}
            >
              <ExternalLink size={12} strokeWidth={2.5} />
              {jumpFailed ? "Couldn't open its terminal" : 'Open terminal'}
            </Button>
          )}
        </>
      ) : ended ? (
        /* Reachable for hours after the process is gone: never claim it had no terminal. */
        <p className="session-detail-empty">
          This agent has finished. Everything it sent you is below.
        </p>
      ) : (
        <p className="session-detail-empty">
          This agent wasn&apos;t started from a terminal window, so there&apos;s nowhere to jump to.
          Its folder is below.
        </p>
      )}
      {session.cwd && <FolderActions cwd={session.cwd} title={`Open ${folderName}`} />}
      {props.onArchive && (
        <Button variant="bare" className="session-detail-action" onClick={props.onArchive}>
          {props.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {props.archived ? 'Restore' : 'Archive'}
        </Button>
      )}
      {session.cwd && <GitActions sessionRef={sessionRef} canAsk={!ended} />}
    </div>
  )

  const fillTerminal = (text: string): void => {
    void window.api.agentRelaySessionKeys(sessionRef, [{ key: 'C-u' }, { text }])
    terminalRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus()
  }
  const pasteTerminal = (text: string): void => {
    void window.api.agentRelaySessionKeys(sessionRef, [{ paste: text }])
    terminalRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus()
  }

  // Keyed on the SESSION, not the ref: a reply typed at one agent must never land in the next one.
  const thread = (
    <ConversationMediaProvider value={media}>
      <SessionThread
        key={props.threadKey ?? session.sessionId ?? session.label}
        session={session}
        sessionRef={sessionRef}
        history={history}
        ended={ended}
        now={now}
        spoken={transcriptNow.turns}
        transcriptStatus={transcriptNow.status}
        working={working}
        opening={opening}
        starting={starting}
        showSteps={showSteps}
        onRespond={onRespond}
        onResume={canResume ? continueSession : undefined}
        fillTerminal={terminal ? fillTerminal : undefined}
        pasteTerminal={terminal ? pasteTerminal : undefined}
      />
    </ConversationMediaProvider>
  )

  const railSwitch = <RailModeSwitch mode={railMode} onMode={setRailMode} />
  const rail = browsing ? (
    <SideBrowser conversationKey={sessionRef} head={railSwitch} cwd={session.cwd} chatAim={sessionRef} />
  ) : (
    <AgentContextRail
      head={railSwitch}
      screen={terminal ? <div className="agent-rail-chat">{thread}</div> : undefined}
      steps={{ on: showSteps, onChange: setShowSteps }}
      session={session}
      row={row}
      now={now}
      actions={actionsBlock}
      shared={shared}
      checklist={checklist.ref === sessionRef ? checklist.value : undefined}
      sessionRef={sessionRef}
      turns={transcriptNow.turns}
      transcriptStatus={transcriptNow.status}
    />
  )

  return (
    <div
      ref={sheetRef}
      className="code-detail session-detail"
      data-rail={withRail ? '' : undefined}
      data-rail-mode={withRail ? railMode : undefined}
      data-terminal={terminal ? '' : undefined}
      style={railResize.style}
    >
      <div className="code-detail-scroll">
        <div className="session-detail-head">
          {props.backTo && (
            <Button
              variant="icon"
              onClick={onBack}
              title={CONFIG.UI_LABELS.CODE_AGENTS_BACK_TO.replace('{name}', props.backTo)}
              aria-label={CONFIG.UI_LABELS.CODE_AGENTS_BACK_TO.replace('{name}', props.backTo)}
            >
              <ChevronLeft size={16} strokeWidth={2.5} />
            </Button>
          )}
          {backLabel && (
            <Button variant="bare" className="session-detail-back" onClick={onBack}>
              <ChevronLeft size={13} strokeWidth={2.5} />
              {backLabel}
            </Button>
          )}
          <h3 className="session-detail-title">
            {row.unnamed ? <span className="session-title-skeleton skeleton" aria-label="Naming this session" /> : title}
          </h3>
          <span className="session-detail-chip" title={props.project?.name ?? folderName}>
            <ProjectAvatar
              icon={props.project?.icon}
              imagePath={props.project?.imagePath}
              size={13}
              className="rounded-sm"
            />
            {props.project?.name ?? folderName}
          </span>
          <span className="code-detail-pos" data-health={row.health}>
            {row.state_text}
          </span>
          {canStepIn && (
            <Button
              variant="icon"
              onClick={() => setTerminalView(!terminal)}
              title={terminal ? 'Chat view for all agents' : 'Terminal view for all agents'}
              aria-label={terminal ? 'Chat view for all agents' : 'Terminal view for all agents'}
              aria-pressed={terminal}
            >
              {terminal ? <MessageSquare size={15} strokeWidth={2} /> : <SquareTerminal size={15} strokeWidth={2} />}
            </Button>
          )}
        </div>

        {!withRail && !terminal && recapLine(row) && (
          <div className="session-detail-tldr">
            <span className="session-tldr-tag">{CONFIG.UI_LABELS.CODE_SESSION_RECAP}</span>
            {recapLine(row)}
          </div>
        )}

        {terminal ? (
          <div ref={terminalRef} className="session-detail-terminal">
            <AgentScreen key={sessionRef} sessionRef={sessionRef} cwd={session.cwd} fill />
          </div>
        ) : (
          thread
        )}
      </div>
      {withRail && (
        <div {...railResize.gripProps}>
          {props.onToggleRail && <RailEdgeToggle open onToggle={props.onToggleRail} />}
        </div>
      )}
      {!withRail && props.onToggleRail && <RailEdgeToggle open={false} onToggle={props.onToggleRail} />}
      {withRail && <ConversationMediaProvider value={media}>{rail}</ConversationMediaProvider>}
      {steppedIn && canStepIn && (
        <div className="session-step-in" role="dialog" aria-label={`${title}, live terminal`}>
          <div className="session-step-in-bar">
            <span className="session-step-in-title">{title}</span>
            <span className="session-detail-project">{props.project?.name ?? folderName}</span>
            <span className="session-step-in-spacer" />
            {canJump && (
              <Button variant="ghost" className="session-step-in-btn" onClick={jump} disabled={jumpFailed}>
                <ExternalLink size={12} strokeWidth={2.5} />
                {jumpFailed ? "Couldn't open its terminal" : 'Open in terminal'}
              </Button>
            )}
            <Button variant="ghost" className="session-step-in-btn" onClick={() => setSteppedIn(false)}>
              <X size={12} strokeWidth={2.5} />
              Done
            </Button>
          </div>
          <AgentScreen sessionRef={sessionRef} cwd={session.cwd} fill />
        </div>
      )}
    </div>
  )
}
