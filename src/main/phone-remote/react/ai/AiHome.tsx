import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowUp, Check, ChevronDown, CircleOff, FolderPlus, MessageCircle, Mic, Monitor, Mouse, RefreshCw, Settings, Square } from 'lucide-react'
import { THOUGHT_MIC_CLASS } from '../mic-nodes'
import { CONFIG } from '@shared/config'
import type { AgentRelaySessionInfo } from '@shared/types'
import type { RelayProjectWire } from '@shared/phone-remote-protocol'
import type { ProjectIdea } from '@shared/project-ideas'
import { matchesSession, sessionActiveAt, sessionHaystack, sessionRow, shortAge, type SessionRow } from '@shared/relay-status'
import type { ChatSessionSummary } from '../chat-steps'
import { ProjectMark } from '../SessionDetail'
import { hapticTick } from '../haptics'
import { Sheet } from './Sheet'
import { Composer, type ComposerMic } from './Composer'
import { ProviderIcon, type ProviderIconId } from '@shared/provider-icon'
import type { IdeasState, Models } from './use-ai-session'
import { capabilities } from '../host-capabilities'
import { nativeBridge } from '../native-bridge'
import { PREVIEW_MODE } from '../hooks/use-mirror'
import { useRecordingElapsed } from '../use-recording-elapsed'
import { Button } from '@shared/ui/Button'

const IN_IOS_APP = capabilities.shell === 'native' || PREVIEW_MODE
const CAN_GO_BACK = nativeBridge.canHideDeck() || PREVIEW_MODE

export type AiMode = 'code' | 'chat'

const ARM_MS = 3000
const IDEAS_SHOWN = 2
const TINTS = ['', 'b', 'g', 'p']
export const SHOW_IDEAS = false

const IDEA_TAGS: Record<ProjectIdea['kind'], string> = { finish: 'Finish', next: 'Next', fix: 'Fix', try: 'Try' }
const STATUS_WORDS: Partial<Record<SessionRow['health'], string>> = {
  waiting: 'Your turn',
  'your-turn': 'Your turn',
  ended: 'Ended'
}
const AGENTS_SHOWN = 12
const CHATS_PER_GROUP = 5

export interface HomeMemory {
  query?: string
  agentLimit?: number
  openGroups?: ReadonlySet<number>
  scrollTop?: number
}
function MoreButton(props: { hidden: number; onClick: () => void }): React.JSX.Element | null {
  if (props.hidden <= 0) return null
  return (
    <Button variant="bare" type="button" className="aiMore" onClick={props.onClick}>
      {`Show ${props.hidden} more`}
    </Button>
  )
}

type Row = { session: AgentRelaySessionInfo; row: SessionRow; group: string; activeAt: number }

type Held = { order: string[]; needs: Set<string> }

function holdOf(rows: Row[], needsYou: (r: Row) => boolean): Held {
  return { order: rows.map((r) => r.session.label), needs: new Set(rows.filter(needsYou).map((r) => r.session.label)) }
}

function useHeldRows(
  rows: Row[],
  needsYou: (r: Row) => boolean
): { rows: Row[]; needsYou: (r: Row) => boolean; updated: number; settle: () => void } {
  const fresh = holdOf(rows, needsYou)
  const freshRef = useRef(fresh)
  freshRef.current = fresh
  const [held, setHeld] = useState(fresh)
  useEffect(() => {
    const onShow = (): void => {
      if (document.visibilityState === 'visible') setHeld(freshRef.current)
    }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [])
  const heldAt = new Map(held.order.map((label, i) => [label, i]))
  const byLabel = new Map(rows.map((r) => [r.session.label, r]))
  const added = rows.filter((r) => !heldAt.has(r.session.label))
  const kept = held.order.flatMap((label) => byLabel.get(label) ?? [])
  const freshKept = fresh.order.filter((label) => heldAt.has(label))
  const keptAt = new Map(kept.map((r, i) => [r.session.label, i]))
  const updated = kept.filter(
    (r, i) => freshKept.indexOf(r.session.label) < i || held.needs.has(r.session.label) !== needsYou(r)
  ).length
  return {
    rows: [...added, ...kept],
    needsYou: (r) => (keptAt.has(r.session.label) ? held.needs.has(r.session.label) : needsYou(r)),
    updated,
    settle: () => setHeld(freshRef.current)
  }
}

function groupOf(session: AgentRelaySessionInfo, row: SessionRow): string {
  return session.project?.name ?? row.repo ?? 'Other'
}

function tintOf(name: string | undefined): string {
  let h = 0
  for (const c of name ?? '') h = (h + c.charCodeAt(0)) % TINTS.length
  return TINTS[h]
}

export function Avatar(props: {
  project?: AgentRelaySessionInfo['project'] | RelayProjectWire | null
  size?: number
  children?: React.ReactNode
}): React.JSX.Element {
  const size = props.size ?? 30
  return (
    <span className="aiAv" data-tint={tintOf(props.project?.name)} style={{ width: size, height: size }}>
      {props.children ?? <ProjectMark project={props.project ?? undefined} size={size} />}
    </span>
  )
}

export function RowStatus({ health, waiting }: { health: SessionRow['health']; waiting?: number }): React.JSX.Element | null {
  if (health === 'working') return <span className="aiSt" data-health="working"><i className="aiRing" /></span>
  const word = STATUS_WORDS[health]
  if (!word) return null
  const needs = health === 'waiting' || health === 'your-turn'
  return (
    <span className="aiSt" data-health={health}>
      {needs && <i className="aiNeedDot" />}
      {waiting && waiting > 1 ? `${word} · ${waiting}` : word}
    </span>
  )
}

function Ideas(props: {
  state?: IdeasState
  onRefresh: () => void
  onStart: (idea: ProjectIdea) => void
}): React.JSX.Element | null {
  const [armed, setArmed] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const tap = (idea: ProjectIdea): void => {
    hapticTick()
    window.clearTimeout(timer.current)
    if (armed === idea.label) {
      setArmed(null)
      props.onStart(idea)
      return
    }
    setArmed(idea.label)
    timer.current = window.setTimeout(() => setArmed(null), ARM_MS)
  }

  const ideas = (props.state?.ideas ?? []).slice(0, IDEAS_SHOWN)
  const loading = props.state?.loading && ideas.length === 0
  if (!loading && ideas.length === 0 && !props.state) return null
  return (
    <>
      <h2>
        Ideas
        <Button variant="bare" type="button" className="aiLink" aria-label="New ideas" onClick={props.onRefresh}>
          <RefreshCw size={15} />
        </Button>
      </h2>
      <div className="aiIdeas">
        {loading
          ? Array.from({ length: IDEAS_SHOWN }, (_, i) => <div key={i} className="aiIdea aiIdeaSkeleton" />)
          : ideas.map((idea) => (
              <Button
                variant="bare"
                key={idea.label}
                type="button"
                className="aiIdea"
                data-armed={armed === idea.label ? '' : undefined}
                onClick={() => tap(idea)}
              >
                <i>{armed === idea.label ? 'Tap again to start' : IDEA_TAGS[idea.kind]}</i>
                <span>{idea.emoji ? `${idea.emoji} ${idea.label}` : idea.label}</span>
              </Button>
            ))}
      </div>
      {!loading && ideas.length === 0 && <div className="aiEmpty">No ideas yet for this project</div>}
    </>
  )
}

export function ProjectPicker(props: {
  projects: RelayProjectWire[] | null
  current: string | null
  onPick: (project: RelayProjectWire | null) => void
  onClose: () => void
  allowNone?: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const nameCount = new Map<string, number>()
  for (const p of props.projects ?? []) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1)
  const shown = (props.projects ?? [])
    .filter((p) => !query.trim() || p.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
  return (
    <Sheet label="Pick a project" onClose={props.onClose}>
      <h1>Project</h1>
      <input
        className="aiSearch"
        type="search"
        placeholder="Search projects"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {props.projects === null ? (
        <div className="aiEmpty">Loading your projects…</div>
      ) : shown.length === 0 && (!props.allowNone || query.trim()) ? (
        <div className="aiEmpty">No projects match</div>
      ) : (
        <div className="aiPick">
          {props.allowNone && !query.trim() && (
            <Button
              variant="bare"
              type="button"
              className="aiRow"
              aria-pressed={props.current === null}
              onClick={() => {
                hapticTick()
                props.onPick(null)
              }}
            >
              <Avatar>
                <CircleOff size={16} />
              </Avatar>
              <div className="aiRowText">
                <b>{CONFIG.UI_LABELS.CODE_NO_PROJECT}</b>
                <span>{CONFIG.UI_LABELS.CODE_NO_PROJECT_HINT}</span>
              </div>
              {props.current === null && <em>Current</em>}
            </Button>
          )}
          {shown.map((p) => (
            <Button
              variant="bare"
              key={p.id}
              type="button"
              className="aiRow"
              aria-pressed={p.id === props.current}
              onClick={() => {
                hapticTick()
                props.onPick(p)
              }}
            >
              <Avatar project={p} />
              <div className="aiRowText">
                <b>{p.name}</b>
                {(nameCount.get(p.name) ?? 0) > 1 && p.folderName !== p.name && <span>{p.folderName}</span>}
              </div>
              {p.id === props.current && <em>Current</em>}
            </Button>
          ))}
        </div>
      )}
    </Sheet>
  )
}

export function ProviderLogo(props: { icon: string; size?: number }): React.JSX.Element {
  return (
    <span className="aiLogo">
      <ProviderIcon id={props.icon as ProviderIconId} size={props.size ?? 13} />
    </span>
  )
}

export function ModelPicker(props: {
  models: Models | null | undefined
  title: string
  note: string
  onPick: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet label={props.title} onClose={props.onClose}>
      <h1>{props.title}</h1>
      {!props.models ? (
        <div className="aiEmpty">Checking what your Mac can use…</div>
      ) : props.models.options.length === 0 ? (
        <div className="aiEmpty">Nothing set up on your Mac yet</div>
      ) : (
        <div className="aiPick">
          {props.models.options.map((o) => (
            <Button
              variant="bare"
              key={o.id}
              type="button"
              className="aiRow"
              aria-pressed={o.id === props.models?.current}
              onClick={() => {
                hapticTick()
                props.onPick(o.id)
              }}
            >
              <Avatar>
                <ProviderLogo icon={o.icon} size={18} />
              </Avatar>
              <div className="aiRowText">
                <b>{o.label}</b>
              </div>
              {o.id === props.models?.current && <Check size={18} strokeWidth={2.5} />}
            </Button>
          ))}
        </div>
      )}
      <div className="aiEmpty">{props.note}</div>
    </Sheet>
  )
}

function ModelChip(props: { models?: Models | null; onOpen: () => void }): React.JSX.Element | null {
  const current = props.models?.options.find((o) => o.id === props.models?.current)
  if (!current) return null
  return (
    <Button variant="bare" type="button" className="aiPjChip" onClick={props.onOpen}>
      <ProviderLogo icon={current.icon} />
      <span className="aiChipText">{current.label}</span>
      <ChevronDown size={14} strokeWidth={2.5} />
    </Button>
  )
}

function SessionRows(props: {
  rows: Row[]
  waitingFor: (session: AgentRelaySessionInfo) => number
  isPinned: (session: AgentRelaySessionInfo) => boolean
  onOpen: (label: string) => void
  showProject?: boolean
}): React.JSX.Element {
  const now = Date.now()
  return (
    <div className="aiList">
      {props.rows.map(({ session, row, group, activeAt }) => {
        const waiting = props.waitingFor(session)
        const health = waiting > 0 ? 'waiting' : row.health
        const stateText = STATUS_WORDS[health] ? null : row.state_text
        return (
          <Button variant="bare" key={session.label} type="button" className="aiRow" onClick={() => props.onOpen(session.label)}>
            <Avatar project={session.project} />
            <div className="aiRowText">
              <b>{`${props.isPinned(session) ? '📌 ' : ''}${row.tldr ?? group}`}</b>
              <span>
                {row.tldr && props.showProject && <b className="aiPj">{group}</b>}
                {stateText && (row.tldr && props.showProject ? ` · ${stateText}` : stateText)}
              </span>
            </div>
            <span className="aiRowMeta">
              <time>{shortAge(now - activeAt)}</time>
              <RowStatus health={health} waiting={waiting} />
            </span>
          </Button>
        )
      })}
    </div>
  )
}

function ChatRows(props: { chats: ChatSessionSummary[]; now: number; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <div className="aiList">
      {props.chats.map((c) => (
        <Button variant="bare" key={c.id} type="button" className="aiRow" onClick={() => props.onOpen(c.id)}>
          <Avatar project={c.project}>{c.project ? undefined : <MessageCircle size={16} />}</Avatar>
          <div className="aiRowText">
            <b>{c.title}</b>
            <span>{c.running ? (c.phase ?? 'Working…') : c.preview}</span>
          </div>
          <span className="aiRowMeta">
            <time>{shortAge(props.now - Date.parse(c.updated))}</time>
            {c.running && <RowStatus health="working" />}
          </span>
        </Button>
      ))}
    </div>
  )
}

// Opening the remote takes a few seconds to hear from the Mac; don't flash "not connected" meanwhile.
const LINK_DOWN_TOAST_DELAY_MS = 5_000

export function AiHome(props: {
  mode: AiMode
  onMode: (mode: AiMode) => void
  onClose: () => void
  project: RelayProjectWire | null
  onOpenPicker: () => void
  models?: Models | null
  onOpenModels?: () => void
  ideas?: IdeasState
  onRefreshIdeas: () => void
  onStart: (text: string, file: File | null) => void
  onStartIdea: (idea: ProjectIdea) => void
  startError?: string
  onChatAsk: (text: string) => boolean | void
  chatSessions: ChatSessionSummary[]
  onOpenChat: (id: string) => void
  sessions: AgentRelaySessionInfo[]
  recall: () => HomeMemory
  remember: (part: HomeMemory) => void
  waitingFor: (session: AgentRelaySessionInfo) => number
  isPinned: (session: AgentRelaySessionInfo) => boolean
  onOpenSession: (label: string) => void
  looseDecisions?: React.ReactNode
  startHere?: React.ReactNode
  needsCount: number
  deckCount: number
  onOpenDeck: () => void
  answeredCount: number
  onOpenAnswered: () => void
  archivedCount: number
  showArchived: boolean
  onShowArchived: (on: boolean) => void
  mic?: ComposerMic
  thoughtRecording?: boolean
  onOpenNotes?: () => void
  onWatch?: () => void
  onOpenSettings: () => void
  linkOk: boolean
}): React.JSX.Element {
  const { remember } = props
  const [kept] = useState(props.recall)
  const [query, setQuery] = useState(kept.query ?? '')
  const [linkDown, setLinkDown] = useState(false)
  const noteElapsed = useRecordingElapsed(props.thoughtRecording === true)
  useEffect(() => {
    if (props.linkOk) return setLinkDown(false)
    const t = setTimeout(() => setLinkDown(true), LINK_DOWN_TOAST_DELAY_MS)
    return () => clearTimeout(t)
  }, [props.linkOk])
  const now = Date.now()


  const rows = useMemo<Row[]>(
    () =>
      props.sessions.map((session) => {
        const row = sessionRow(session, now)
        return { session, row, group: groupOf(session, row), activeAt: sessionActiveAt(session) }
      })
        .sort((a, b) => b.activeAt - a.activeAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.sessions]
  )
  const live = useHeldRows(rows, (r) => props.waitingFor(r.session) > 0)
  const [agentLimit, setAgentLimit] = useState(kept.agentLimit ?? AGENTS_SHOWN)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<number>>(kept.openGroups ?? new Set())
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = kept.scrollTop ?? 0
  }, [kept])
  useEffect(() => remember({ query, agentLimit, openGroups }), [remember, query, agentLimit, openGroups])
  const searching = query.trim() !== ''
  const filtered = live.rows
    .filter((r) => !query.trim() || matchesSession(sessionHaystack(r.session, r.row), query))
    .sort((a, b) => Number(props.isPinned(b.session)) - Number(props.isPinned(a.session)))
  const needs = filtered.filter(live.needsYou)
  const rest = filtered.filter((r) => !live.needsYou(r))
  const shownRest = searching ? rest : rest.slice(0, agentLimit)
  const chats = props.chatSessions
    .filter((c) => !query.trim() || `${c.title} ${c.preview}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => a.group - b.group || Date.parse(b.updated) - Date.parse(a.updated))
  const chatGroups = [...new Set(chats.map((c) => c.group))].map((g) => chats.filter((c) => c.group === g))

  return (
    <>
      <div className="aiHead aiHeadBar">
        <div className="aiHeadSide">
          {CAN_GO_BACK && (
            <Button variant="bare" type="button" className="aiIconBtn" aria-label="Back to chat" onClick={() => nativeBridge.hideDeck()}>
              <ArrowLeft size={19} />
            </Button>
          )}
          {!IN_IOS_APP && <img className="aiMark" src="/icon-192.png" alt="MightyMouse" />}
          <Button variant="bare" type="button" className="aiIconBtn" aria-label="Settings" title="Settings" data-label="Settings" onClick={props.onOpenSettings}>
            <Settings size={19} />
          </Button>
        </div>
        <div className="aiSwitch" role="tablist">
          <Button variant="bare" type="button" aria-pressed={props.mode === 'chat'} onClick={() => props.onMode('chat')}>
            Chat
          </Button>
          <Button variant="bare" type="button" aria-pressed={props.mode === 'code'} onClick={() => props.onMode('code')}>
            Code
            {props.needsCount > 0 && <span className="aiBadge">{props.needsCount}</span>}
          </Button>
        </div>
        <div className="aiHeadSide" data-end="">
          {props.onWatch && (
            <Button variant="bare" type="button" className="aiIconBtn" aria-label="See your Mac screen" title="See your Mac screen" data-label="Screen" onClick={props.onWatch}>
              <Monitor size={19} />
            </Button>
          )}
          <Button variant="bare" type="button" className="aiIconBtn" aria-label="Control your Mac" title="Control your Mac" data-label="Remote" onClick={props.onClose}>
            <Mouse size={20} />
          </Button>
        </div>
      </div>
      <div
        className="aiScroll"
        ref={scroller}
        onScroll={(e) => {
          remember({ scrollTop: e.currentTarget.scrollTop })
        }}
      >
        <input
          className="aiSearch"
          type="search"
          placeholder={props.mode === 'chat' ? 'Search chats' : 'Search agents'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {linkDown && <div className="aiToast">Your Mac is not connected right now</div>}
        <div className="aiAsk">
          <h1>{props.mode === 'chat' ? 'Ask anything' : 'What should we build?'}</h1>
          <div className="aiAskSub">
            {props.mode === 'chat' && !props.onOpenModels ? null : (
              <>
                <Button variant="bare" type="button" className="aiPjChip" onClick={props.onOpenPicker}>
                  {props.project ? (
                    <Avatar project={props.project} size={20} />
                  ) : (
                    <span className="aiLogo">
                      {props.mode === 'chat' ? <FolderPlus size={12} /> : <CircleOff size={12} />}
                    </span>
                  )}
                  <span className="aiChipText">
                    {props.project?.name ?? (props.mode === 'chat' ? 'Add project' : CONFIG.UI_LABELS.CODE_NO_PROJECT)}
                  </span>
                  <ChevronDown size={14} strokeWidth={2.5} />
                </Button>
                {props.onOpenModels && <ModelChip models={props.models} onOpen={props.onOpenModels} />}
              </>
            )}
          </div>
        </div>
        <Composer
          bare
          placeholder={
            props.mode === 'chat'
              ? 'Message…'
              : props.project
                ? `Tell it what to build in ${props.project.name}…`
                : 'Tell it what to do…'
          }
          allowPhoto={props.mode === 'code'}
          mic={props.mic}
          error={props.mode === 'code' ? props.startError : undefined}
          onSend={(text, file) => (props.mode === 'chat' ? props.onChatAsk(text) : props.onStart(text, file))}
        />
        {!searching && props.startHere}

        {SHOW_IDEAS && props.mode === 'code' && props.project && (
          <Ideas state={props.ideas} onRefresh={props.onRefreshIdeas} onStart={props.onStartIdea} />
        )}

        {props.mode === 'code' ? (
          <>
            {(needs.length > 0 || props.looseDecisions) && (
              <div className="aiNeeds">
                <h2>
                  {`Needs you${needs.length > 0 ? ` · ${needs.length}` : ''}`}
                  {props.deckCount > 0 && (
                    <Button variant="bare" type="button" className="aiLink" onClick={props.onOpenDeck}>
                      Answer agents ›
                    </Button>
                  )}
                </h2>
                {props.looseDecisions}
                {needs.length > 0 && (
                  <SessionRows
                    rows={needs}
                    waitingFor={props.waitingFor}
                    isPinned={props.isPinned}
                    onOpen={props.onOpenSession}
                    showProject
                  />
                )}
              </div>
            )}
            {shownRest.length > 0 && (
              <>
                <h2>Recent</h2>
                <SessionRows rows={shownRest} waitingFor={props.waitingFor} isPinned={props.isPinned} onOpen={props.onOpenSession} showProject />
              </>
            )}
            {!searching && (
              <MoreButton hidden={rest.length - agentLimit} onClick={() => setAgentLimit((n) => n + AGENTS_SHOWN * 2)} />
            )}
            {filtered.length === 0 && (
              <div className="aiEmpty">{searching ? 'No agents match' : 'No agents running. Start one above.'}</div>
            )}
            {live.updated > 0 && !searching && (
              <Button
                variant="bare"
                type="button"
                className="aiUpdated"
                onClick={() => {
                  hapticTick()
                  live.settle()
                }}
              >
                <ArrowUp size={14} strokeWidth={2.5} />
                {`${live.updated} updated`}
              </Button>
            )}
            <div className="aiFootLinks">
              {props.answeredCount > 0 && (
                <Button variant="bare" type="button" className="aiLink" onClick={props.onOpenAnswered}>
                  {`Answered today · ${props.answeredCount}`}
                </Button>
              )}
              {props.onOpenNotes && (
                <Button variant="bare" type="button" className="aiLink" onClick={props.onOpenNotes}>
                  History
                </Button>
              )}
              {props.archivedCount > 0 && (
                <Button variant="bare" type="button" className="aiLink" onClick={() => props.onShowArchived(!props.showArchived)}>
                  {props.showArchived ? 'Hide archived' : `Show archived · ${props.archivedCount}`}
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <h2>
              Recent
              {props.onOpenNotes && (
                <Button variant="bare" type="button" className="aiLink" onClick={props.onOpenNotes}>
                  History
                </Button>
              )}
            </h2>
            {chats.length === 0 && <div className="aiEmpty">No chats yet. Ask anything above.</div>}
            {chatGroups.map((group) => {
              const first = group[0]
              const open = searching || openGroups.has(first.group)
              return (
                <Fragment key={first.group}>
                  <h2>
                    {first.pinned ? (
                      CONFIG.UI_LABELS.SIDEBAR_PINNED
                    ) : first.project ? (
                      <>
                        <Avatar project={first.project} size={18} />
                        {first.project.name}
                      </>
                    ) : (
                      CONFIG.UI_LABELS.SIDEBAR_CHATS
                    )}
                  </h2>
                  <ChatRows chats={open ? group : group.slice(0, CHATS_PER_GROUP)} now={now} onOpen={props.onOpenChat} />
                  {!open && (
                    <MoreButton
                      hidden={group.length - CHATS_PER_GROUP}
                      onClick={() => setOpenGroups((s) => new Set(s).add(first.group))}
                    />
                  )}
                </Fragment>
              )
            })}
          </>
        )}
      </div>
      {props.thoughtRecording !== undefined && (
        <Button
          variant="bare"
          type="button"
          className={`${THOUGHT_MIC_CLASS}${props.thoughtRecording ? ' recording' : ''}`}
          aria-label={props.thoughtRecording ? 'Stop and save the voice note' : 'Record a voice note'}
        >
          {props.thoughtRecording ? <Square size={14} fill="currentColor" /> : <Mic size={20} />}
          <span>{props.thoughtRecording ? `${noteElapsed} · Tap to save` : 'Voice note'}</span>
        </Button>
      )}
    </>
  )
}
