import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUp, MessageSquare } from 'lucide-react'
import { Button } from './Button'
import { BranchPicker } from './BranchPicker'
import { CONFIG } from '../../../shared/config'
import { ProjectScopePicker } from './ProjectScopePicker'
import { AgentSettingsChip, HARNESS_NAME, triggerLabel, useAgentModels } from './AgentModelPicker'
import type { ReasoningEffort } from '../../../shared/model-sources'
import { DraftRail } from './agent-context-rail'
import { McpSummaryLine } from './mcp-connections'
import type { SessionEntry } from '../../../shared/relay-sessions'
import { RailEdgeToggle, RailModeSwitch, SideBrowser } from './side-browser'
import { draftBrowserKey, releaseDraftBrowserKey, useRailBrowserShortcut, useRailMode } from '../hooks/useRailMode'
import { useRailResize } from '../hooks/useRailResize'
import './SessionSheet.css'
import { ProjectAvatar } from './ProjectIcon'
import { AttachBar, AttachButton } from './AttachBar'
import { TalkButton, TalkSendButton } from './TalkButton'
import { useAttachments, useComposerInbox, usePasteToComposer } from '../hooks/useAttachments'
import { useRememberedText } from '../hooks/useRememberedText'
import { useSlashMenu } from './composer-slash-menu'
import './AgentProjects.css'
import type { AgentModelChoice, AgentRelaySessionInfo, MightyProject } from '../../../shared/types'

const MAX_AGENTS = 6

export type AgentDraft = {
  groupId: string
  name: string
  cwd: string
  projectId?: string
  icon?: string
  imagePath?: string
}

export function AgentDraftPane({
  draft,
  projects,
  onSend,
  resume = [],
  onContinue,
  onProjectChange,
  onEditProject,
  onNewProject,
  withRail,
  onToggleRail,
  failure,
  memoryKey,
  compact,
  onOpenSideBySide
}: {
  draft: AgentDraft
  projects: MightyProject[]
  onSend: (message: string, paths: string[], model: AgentModelChoice | null, effort?: ReasoningEffort, count?: number, plan?: boolean) => Promise<void>
  resume?: SessionEntry[]
  onContinue?: (session: AgentRelaySessionInfo) => void
  onProjectChange?: (projectId: string | undefined) => void
  onEditProject?: (project: MightyProject) => void
  onNewProject?: () => void
  withRail?: boolean
  onToggleRail?: () => void
  failure?: { message: string; reason: string }
  memoryKey?: string
  compact?: boolean
  onOpenSideBySide?: (count: number) => void
}): React.JSX.Element {
  const railKey = `draft:${draft.cwd}`
  const [railMode, setRailMode] = useRailMode(railKey)
  const browserKey = draftBrowserKey(railKey)
  useRailBrowserShortcut(Boolean(withRail), () => setRailMode('browser'))
  const sheetRef = useRef<HTMLDivElement>(null)
  const rail = useRailResize(sheetRef, 'agent-projects-grip')
  const [text, setText] = useRememberedText(memoryKey ?? `draft:${draft.cwd}`, failure?.message)
  const [problem, setProblem] = useState(failure?.reason ?? '')
  const [failed, setFailed] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [agents, setAgents] = useState(1)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [talkLive, setTalkLive] = useState(false)
  const att = useAttachments()
  const models = useAgentModels()
  const appendText = useCallback((t: string) => setText((prev) => prev + t), [])
  usePasteToComposer(inputRef, att.paste, appendText)
  useComposerInbox(inputRef, att.addPaths)
  const slash = useSlashMenu({ draft: text, setDraft: setText, inputRef, cwd: draft.cwd, claude: models.selected?.harness === 'claude', newSession: true })
  const L = CONFIG.UI_LABELS

  useEffect(() => {
    inputRef.current?.focus()
  }, [draft.cwd])

  const submit = async (): Promise<void> => {
    const message = text.trim()
    const files = att.attachments
    // An attachment on its own is a message: the agent opens the file itself.
    if (!message && files.length === 0) return
    setFailed(false)
    setProblem('')
    try {
      await onSend(
        message,
        files.map((a) => a.path),
        models.selected,
        models.effort === 'default' ? undefined : models.effort,
        compact ? 1 : agents,
        models.plan
      )
      setText('')
      att.clear()
      if (!compact) releaseDraftBrowserKey(railKey)
    } catch {
      setFailed(true)
      setTimeout(() => setFailed(false), 2600)
    }
  }

  const [before, after] = (
    draft.projectId ? CONFIG.UI_LABELS.CODE_AGENTS_DRAFT_HEADLINE : CONFIG.UI_LABELS.CODE_AGENTS_DRAFT_HEADLINE_NO_PROJECT
  ).split('{name}')
  const empty = text.trim() === '' && att.attachments.length === 0

  return (
    <div
      ref={sheetRef}
      className="session-detail agent-draft-layout"
      data-rail={withRail ? '' : undefined}
      style={rail.style}
    >
      <div
        className="agent-draft"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDropping(true)
        }}
        // relatedTarget, not any dragleave: a child fires one and flickers the highlight off.
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        }}
        onDrop={(e) => {
          setDropping(false)
          att.drop(e)
        }}
      >
        <div className="agent-draft-stage">
          <ProjectAvatar icon={draft.icon} imagePath={draft.imagePath} size={48} className="rounded-xl" />
          <h2 className="agent-draft-title">
            {before}
            {after !== undefined && <span className="agent-draft-title-name">{draft.name}</span>}
            {after}
          </h2>
        </div>

        <div className="agent-draft-dock">
          <div className="agent-draft-card" data-dropping={dropping ? '' : undefined}>
            {slash.menu}
            {att.attachments.length > 0 && (
              <AttachBar attachments={att.attachments} onRemove={att.remove} />
            )}
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (slash.onKeyDown(e)) return
                if (e.key === 'Enter' && (e.metaKey || !e.shiftKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
              rows={2}
              placeholder={att.attachments.length > 0 ? CONFIG.UI_LABELS.CODE_ATTACHED_PLACEHOLDER : CONFIG.UI_LABELS.CODE_AGENTS_DRAFT_PLACEHOLDER}
              aria-label={CONFIG.UI_LABELS.CODE_AGENTS_DRAFT_PLACEHOLDER}
              className="agent-draft-input"
            />
            <div className="agent-draft-row">
              <AttachButton onClick={() => void att.pick()} />
              <ProjectScopePicker
                projects={projects}
                valueId={draft.projectId}
                onChange={onProjectChange}
                onEditProject={onEditProject}
                onNewProject={onNewProject}
                readOnly={!onProjectChange}
              />
              {draft.projectId && <BranchPicker cwd={draft.cwd} />}
              <AgentSettingsChip
                models={models}
                agents={compact ? undefined : { count: agents, max: MAX_AGENTS, onChange: setAgents, onOpenSideBySide }}
              />
              <span className="agent-draft-row-gap" />
              {failed && (
                <span className="agent-draft-failed">
                  {CONFIG.UI_LABELS.CODE_AGENTS_DRAFT_FAILED}
                </span>
              )}
              <TalkButton inputRef={inputRef} label onLiveChange={setTalkLive} />
              {talkLive ? (
                <TalkSendButton className="agent-draft-send" />
              ) : (
                <Button
                  variant="bare"
                  className="agent-draft-send"
                  onClick={() => void submit()}
                  disabled={empty}
                  aria-label="Start agent"
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </Button>
              )}
            </div>
          </div>
          {slash.popup}
          {problem && (
            <p className="agent-draft-problem" role="alert">
              {problem}
            </p>
          )}
          {!compact && <McpSummaryLine cwd={draft.cwd} onManage={slash.openMcp} />}
          {!compact && resume.length > 0 && (
            <section className="agent-draft-resume">
              <h3>{L.CODE_DRAFT_RESUME_TITLE}</h3>
              <ul>
                {resume.map(({ session, row }) => (
                  <li key={session.sessionId ?? session.stated ?? session.label}>
                    <Button variant="bare" className="agent-draft-resume-row" onClick={() => onContinue?.(session)}>
                      <span className="agent-draft-resume-icon">
                        <MessageSquare size={15} strokeWidth={1.75} />
                      </span>
                      <span className="agent-draft-resume-text">
                        <b>{row.name ?? row.tldr ?? session.stated}</b>
                        <span>{row.label ? [row.label, row.waitAge].filter(Boolean).join(' · ') : row.started}</span>
                      </span>
                      <span className="agent-draft-resume-go">
                        {L.CODE_DRAFT_RESUME_CONTINUE}
                        <ArrowRight size={14} strokeWidth={1.75} />
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
      {withRail && (
        <div {...rail.gripProps}>{onToggleRail && <RailEdgeToggle open onToggle={onToggleRail} />}</div>
      )}
      {!withRail && onToggleRail && <RailEdgeToggle open={false} onToggle={onToggleRail} />}
      {withRail && railMode === 'browser' && (
        <SideBrowser
          conversationKey={browserKey}
          head={<RailModeSwitch mode={railMode} onMode={setRailMode} />}
          cwd={draft.cwd}
          chatAim={{ cwd: draft.cwd }}
        />
      )}
      {withRail && railMode === 'details' && (
        <DraftRail
          head={<RailModeSwitch mode={railMode} onMode={setRailMode} />}
          projectName={draft.name}
          cwd={draft.cwd}
          harness={models.selected ? HARNESS_NAME[models.selected.harness] : undefined}
          model={
            models.selected && models.selected.model
              ? triggerLabel(models.options, models.selected)
              : undefined
          }
        />
      )}
    </div>
  )
}
