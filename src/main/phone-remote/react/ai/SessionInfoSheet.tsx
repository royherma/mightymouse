import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Archive,
  ArchiveRestore,
  FileText,
  GitMerge,
  GitPullRequest,
  ListTree,
  MessageCircle,
  Maximize2,
  Minimize2,
  Monitor,
  MonitorPlay,
  Pin,
  PinOff,
  SquarePen
} from 'lucide-react'
import type { AgentRelaySessionInfo } from '@shared/types'
import { isOriginResolvable, sessionRow } from '@shared/relay-status'
import { InfoCard, InfoRow, SessionInfoBody } from '@shared/session-info'
import { Button } from '@shared/ui/Button'
import { Avatar } from './AiHome'
import { hapticTick } from '../haptics'
import { Sheet } from './Sheet'
import type { SessionGitOp } from '@shared/phone-remote-protocol'
import type { GitNote, SessionGitWire, SessionInfoWire } from './use-ai-session'

export interface SessionInfoActions {
  onGoTo?: (label: string) => void
  goToFailed?: boolean
  onWatch?: () => void
  onZoom?: (label: string, on: boolean) => void
  zoomed?: boolean
  onRaw?: () => void
  showSteps: boolean
  onSteps: () => void
  pinned: boolean
  onPin: (on: boolean) => void
  archived: boolean
  onArchive: (on: boolean) => void
}

export interface SessionGitActions {
  state?: SessionGitWire
  busy?: SessionGitOp
  note?: GitNote
  onAsk: (op: SessionGitOp) => void
  onClearNote: () => void
}

const SECURE_URL = /^https:\/\//
const CONFIRM_BTN = 'min-h-[44px] flex-1 rounded-[12px] bg-surface2 px-3 text-center text-[15px] font-semibold text-inherit no-underline'

function SessionGitBlock(props: { git: SessionGitActions; confirming: boolean; onConfirming: (on: boolean) => void }): React.JSX.Element | null {
  const { git, confirming } = props
  const pull = git.state?.pull?.state === 'open' ? git.state.pull : null
  const files = git.state?.files ?? 0
  const status = git.busy
    ? git.busy === 'open'
      ? 'Opening the pull request on GitHub…'
      : `Merging #${pull?.number} into ${pull?.base}…`
    : null
  const changes = files > 0 ? `Changes: ${files} file${files === 1 ? '' : 's'} +${git.state?.added} -${git.state?.removed}` : null
  if (!confirming && !status && !git.note && !changes) return null
  return (
    <div className="mt-2 flex flex-col gap-2 text-[14px]" role="status">
      {confirming && pull && !git.busy && (
        <div className="flex flex-col gap-2 rounded-[14px] border border-surface3 bg-surface1 p-3.5" role="dialog" aria-label="Confirm merge">
          <b className="text-[16px]">
            Merge #{pull.number} into {pull.base}?
          </b>
          <span className="text-muted">{pull.blocker ?? 'GitHub squashes it into one commit when the repo allows that.'}</span>
          <div className="flex gap-2">
            <Button
              variant="bare"
              className={CONFIRM_BTN}
              onClick={() => {
                props.onConfirming(false)
                hapticTick()
                git.onAsk('merge')
              }}
            >
              Merge now
            </Button>
            {SECURE_URL.test(pull.url) && (
              <a className={`${CONFIRM_BTN} grid place-items-center`} href={pull.url} target="_blank" rel="noreferrer">
                Open on GitHub
              </a>
            )}
            <Button variant="bare" className={CONFIRM_BTN} onClick={() => props.onConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {status && (
        <p className="flex items-center justify-center gap-1.5 text-muted">
          <Loader2 size={13} className="animate-spin" /> {status}
        </p>
      )}
      {git.note && !status && (
        <p className="flex items-center justify-center gap-2" data-failed={git.note.failed ? '' : undefined} style={git.note.failed ? { color: 'var(--ai-danger)' } : undefined}>
          {git.note.text}
          {git.note.failed && (
            <Button variant="bare" className="font-semibold underline" onClick={git.onClearNote}>
              OK
            </Button>
          )}
        </p>
      )}
      {changes && <p className="text-center text-muted">{changes}</p>}
    </div>
  )
}

function Tile(props: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}): React.JSX.Element {
  return (
    <Button
      variant="bare"
      className="aiTile"
      disabled={props.disabled}
      data-danger={props.danger ? '' : undefined}
      onClick={props.onClick}
    >
      <i>{props.icon}</i>
      {props.label}
    </Button>
  )
}

export function ChatInfoSheet(props: {
  title: string
  messages: number
  busy: boolean
  showSteps: boolean
  onSteps: () => void
  onNewChat: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Sheet label="About this chat" onClose={props.onClose}>
      <div className="aiHeadTitle">
        <Avatar project={null} size={36}>
          <MessageCircle size={19} />
        </Avatar>
        <div className="aiRowText">
          <b>{props.title}</b>
          <span>{props.busy ? 'Answering…' : 'Chat with your Mac'}</span>
        </div>
      </div>
      <div className="aiTiles">
        <Tile
          icon={<ListTree size={18} />}
          label={props.showSteps ? 'Hide work' : 'Show work'}
          onClick={() => {
            hapticTick()
            props.onSteps()
          }}
        />
        <Tile
          icon={<SquarePen size={18} />}
          label="New chat"
          onClick={() => {
            hapticTick()
            props.onNewChat()
          }}
        />
      </div>
      <InfoCard>
        <InfoRow label="Messages">{props.messages}</InfoRow>
      </InfoCard>
    </Sheet>
  )
}

export function SessionInfoSheet(props: {
  session: AgentRelaySessionInfo
  info?: SessionInfoWire
  onRequestInfo: (label: string) => void
  actions: SessionInfoActions
  git?: SessionGitActions
  onClose: () => void
}): React.JSX.Element {
  const { session, info, actions, onRequestInfo, git } = props
  const [archiveArmed, setArchiveArmed] = useState(false)
  const [confirmingMerge, setConfirmingMerge] = useState(false)
  const now = Date.now()
  const row = sessionRow(session, now)

  useEffect(() => {
    onRequestInfo(session.label)
  }, [session.label, onRequestInfo])

  const act = (fn: () => void): void => {
    hapticTick()
    fn()
  }

  const gitOnAsk = git?.onAsk
  useEffect(() => {
    gitOnAsk?.('status')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.label])

  const openPull = git?.state?.pull?.state === 'open' ? git.state.pull : null
  const canGoTo = actions.onGoTo && isOriginResolvable(session.origin)
  const canZoom = actions.onZoom && session.origin?.tmuxPane

  return (
    <Sheet label="About this session" onClose={props.onClose}>
      <SessionInfoBody
        session={session}
        row={row}
        info={info}
        now={now}
        title={row.name ?? row.repo ?? session.label}
        mark={<Avatar project={session.project} size={52} />}
        state={row.state_text}
        actions={
          <div className="aiTiles">
            {canGoTo && (
              <Tile
                icon={<Monitor size={18} />}
                label={actions.goToFailed ? 'Try again' : 'Open on Mac'}
                onClick={() => act(() => actions.onGoTo?.(session.label))}
              />
            )}
            {actions.onWatch && (
              <Tile
                icon={<MonitorPlay size={18} />}
                label="Watch"
                onClick={() => act(() => actions.onWatch?.())}
              />
            )}
            {canZoom && (
              <Tile
                icon={actions.zoomed ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                label={actions.zoomed ? 'Unzoom' : 'Zoom'}
                onClick={() => act(() => actions.onZoom?.(session.label, !actions.zoomed))}
              />
            )}
            <Tile
              icon={<ListTree size={18} />}
              label={actions.showSteps ? 'Hide work' : 'Show work'}
              onClick={() => act(actions.onSteps)}
            />
            {actions.onRaw && (
              <Tile
                icon={<FileText size={18} />}
                label="Full log"
                onClick={() => act(() => actions.onRaw?.())}
              />
            )}
            {git?.state?.github &&
              (openPull ? (
                <Tile
                  icon={<GitMerge size={18} />}
                  label={`Merge #${openPull.number}`}
                  disabled={Boolean(git.busy)}
                  onClick={() => act(() => setConfirmingMerge((v) => !v))}
                />
              ) : (
                <Tile
                  icon={<GitPullRequest size={18} />}
                  label={git.state.dirty > 0 ? 'Commit first' : 'Open PR'}
                  disabled={Boolean(git.busy) || git.state.dirty > 0}
                  onClick={() => act(() => git.onAsk('open'))}
                />
              ))}
            <Tile
              icon={actions.pinned ? <PinOff size={18} /> : <Pin size={18} />}
              label={actions.pinned ? 'Unpin' : 'Pin'}
              onClick={() => act(() => actions.onPin(!actions.pinned))}
            />
            <Tile
              icon={actions.archived ? <ArchiveRestore size={18} /> : <Archive size={18} />}
              label={actions.archived ? 'Unarchive' : archiveArmed ? 'Tap again to archive' : 'Archive'}
              danger={!actions.archived}
              onClick={() =>
                act(() => {
                  if (!actions.archived && !archiveArmed) return setArchiveArmed(true)
                  actions.onArchive(!actions.archived)
                  props.onClose()
                })
              }
            />
          </div>
        }
        note={git?.state?.github ? <SessionGitBlock git={git} confirming={confirmingMerge} onConfirming={setConfirmingMerge} /> : undefined}
      />
    </Sheet>
  )
}
