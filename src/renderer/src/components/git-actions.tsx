import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, FileDiff, GitCommitHorizontal, GitMerge, GitPullRequest, Upload } from 'lucide-react'
import type { ChangeScope, ChangeSet, RepoGitState, RepoPull } from '../../../shared/types'
import { ChangedFiles } from '../../../shared/ui/ChangedFiles'
import { Button } from './Button'
import { Spinner } from './Spinner'

const COMMIT_ASK =
  'Commit only the files you changed in this session: git add each one by name (never -A or .), then commit with one line saying what changed. Do not push.'
const IDLE_POLL_MS = 10_000
const WATCH_POLL_MS = 1_500
const COMMIT_GIVE_UP_MS = 5 * 60_000
const DONE_SHOWN_MS = 8_000
const PULL_POLL_MS = 60_000
const CHANGE_SCOPES: Array<[ChangeScope, string]> = [
  ['message', 'Last message'],
  ['branch', 'Whole branch'],
  ['uncommitted', 'Uncommitted']
]

type Run =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'committing'; fromSha: string; since: number }
  | { kind: 'committed'; subject: string; sha: string }
  | { kind: 'pushing'; count: number; target: string }
  | { kind: 'pushed'; count: number; target: string }
  | { kind: 'opening' }
  | { kind: 'opened'; pull: RepoPull }
  | { kind: 'merging'; pull: RepoPull }
  | { kind: 'merged'; pull: RepoPull }
  | { kind: 'failed'; text: string }

function plural(n: number): string {
  return `${n} commit${n === 1 ? '' : 's'}`
}

export function GitActions(props: { sessionRef: string; canAsk: boolean }): React.JSX.Element | null {
  const { sessionRef } = props
  const [state, setState] = useState<RepoGitState | null>(null)
  const [run, setRun] = useState<Run>({ kind: 'idle' })
  const [confirming, setConfirming] = useState(false)
  const [confirmingMerge, setConfirmingMerge] = useState(false)
  const runRef = useRef(run)
  runRef.current = run

  const refresh = useCallback(async (): Promise<RepoGitState | null> => {
    const next = await window.api.repoGitState(sessionRef).catch(() => null)
    setState(next)
    const current = runRef.current
    if (next && current.kind === 'committing' && next.head.sha !== current.fromSha) {
      setRun({ kind: 'committed', subject: next.head.subject, sha: next.head.sha })
    } else if (current.kind === 'committing' && Date.now() - current.since > COMMIT_GIVE_UP_MS) {
      setRun({ kind: 'failed', text: 'No commit yet. Check what the agent said.' })
    }
    return next
  }, [sessionRef])

  const watching = run.kind === 'committing'
  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), watching ? WATCH_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(id)
  }, [refresh, watching])

  const [pull, setPull] = useState<RepoPull | null>(null)
  const [changes, setChanges] = useState<ChangeSet | null | 'loading' | 'error'>(null)
  const [scope, setScope] = useState<ChangeScope>('message')
  const refreshPull = useCallback(async (): Promise<void> => {
    setPull(await window.api.repoGitPull(sessionRef).catch(() => null))
  }, [sessionRef])
  useEffect(() => {
    void refreshPull()
    const id = setInterval(() => void refreshPull(), PULL_POLL_MS)
    return () => clearInterval(id)
  }, [refreshPull])

  const settled = run.kind === 'committed' || run.kind === 'pushed' || run.kind === 'opened' || run.kind === 'merged'
  useEffect(() => {
    if (!settled) return
    const id = setTimeout(() => setRun({ kind: 'idle' }), DONE_SHOWN_MS)
    return () => clearTimeout(id)
  }, [settled, run])

  if (!state) return null

  const commit = async (): Promise<void> => {
    setRun({ kind: 'asking' })
    const sent = await window.api.agentRelaySessionReply(sessionRef, COMMIT_ASK).catch(() => ({ ok: false as const }))
    if (!sent.ok) {
      setRun({ kind: 'failed', text: "Couldn't reach this agent to ask it to commit." })
      return
    }
    setRun({ kind: 'committing', fromSha: state.head.sha, since: Date.now() })
  }

  const push = async (): Promise<void> => {
    setConfirming(false)
    const target = state.remoteHost ?? state.upstream ?? `origin/${state.branch}`
    setRun({ kind: 'pushing', count: state.ahead, target })
    const result = await window.api.repoGitPush(sessionRef).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    setRun(result.ok ? { kind: 'pushed', count: result.pushed, target: result.upstream } : { kind: 'failed', text: result.error })
    void refresh()
  }

  const openPull = async (): Promise<void> => {
    setRun({ kind: 'opening' })
    const result = await window.api.repoGitOpenPull(sessionRef).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    if (result.ok) setPull(result.pull)
    setRun(result.ok ? { kind: 'opened', pull: result.pull } : { kind: 'failed', text: result.error })
    void refresh()
  }

  const merge = async (target: RepoPull): Promise<void> => {
    setRun({ kind: 'merging', pull: target })
    const result = await window.api.repoGitMerge(sessionRef).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    if (result.ok) setPull(result.pull)
    setRun(result.ok ? { kind: 'merged', pull: result.pull } : { kind: 'failed', text: result.error })
  }

  const loadChanges = async (next: ChangeScope): Promise<void> => {
    setScope(next)
    setChanges('loading')
    const got = await window.api.repoGitChanges(sessionRef, next).catch(() => null)
    setChanges(got ?? 'error')
  }

  const toggleChanges = async (): Promise<void> => {
    if (changes !== null) setChanges(null)
    else await loadChanges(scope)
  }

  const busy =
    run.kind === 'asking' || run.kind === 'committing' || run.kind === 'pushing' || run.kind === 'opening' || run.kind === 'merging'
  const openPullRequest = pull?.state === 'open' ? pull : null
  const nothingToCommit = state.dirty === 0
  const nothingToPush = state.ahead === 0
  const where = state.remoteHost ?? state.upstream ?? 'the remote'
  const commitCaption = !props.canAsk
    ? 'Agent has finished'
    : nothingToCommit
      ? 'No changes to save'
      : 'Agent saves its changes'

  return (
    <>
      <Button
        variant="bare"
        className="session-detail-action git-action"
        data-tone="commit"
        onClick={() => void commit()}
        disabled={busy || !props.canAsk || nothingToCommit}
        title="Asks the agent to save the files it changed as a commit on this Mac. Nothing is uploaded."
      >
        <GitCommitHorizontal size={12} strokeWidth={2.5} />
        Commit
        <span className="git-action-caption">{commitCaption}</span>
      </Button>
      <Button
        variant="bare"
        className="session-detail-action git-action"
        data-tone="push"
        data-armed={confirming || undefined}
        onClick={() => setConfirming((v) => !v)}
        disabled={busy || nothingToPush}
      >
        <Upload size={12} strokeWidth={2.5} />
        {nothingToPush ? 'Push' : `Push ${state.ahead}`}
        <span className="git-action-caption">
          {nothingToPush ? 'Everything is uploaded' : `Upload to ${where}`}
        </span>
      </Button>
      <Button
        variant="bare"
        className="session-detail-action git-action"
        data-tone="changes"
        data-armed={changes !== null || undefined}
        onClick={() => void toggleChanges()}
      >
        <FileDiff size={12} />
        Changes
        <span className="git-action-caption">See every line it changed</span>
      </Button>
      {state.remoteHost === 'GitHub' &&
        (openPullRequest ? (
          <Button
            variant="bare"
            className="session-detail-action git-action"
            data-tone="merge"
            data-armed={confirmingMerge || undefined}
            onClick={() => setConfirmingMerge((v) => !v)}
            disabled={busy}
            title={openPullRequest.blocker}
          >
            <GitMerge size={12} />
            Merge #{openPullRequest.number}
            <span className="git-action-caption">{openPullRequest.blocker ?? `Into ${openPullRequest.base}`}</span>
          </Button>
        ) : (
          <Button
            variant="bare"
            className="session-detail-action git-action"
            data-tone="pull"
            onClick={() => void openPull()}
            disabled={busy || state.dirty > 0}
            title={state.dirty > 0 ? 'Commit first, then open the pull request.' : undefined}
          >
            <GitPullRequest size={12} />
            Open PR
            <span className="git-action-caption">{state.dirty > 0 ? 'Commit first' : 'Ask for a review on GitHub'}</span>
          </Button>
        ))}
      {confirmingMerge && openPullRequest && !busy && (
        <div className="git-push-confirm" role="dialog" aria-label="Confirm merge">
          <p className="git-push-confirm-title">
            Merge #{openPullRequest.number} into {openPullRequest.base}?
          </p>
          <p className="git-push-confirm-sub">
            {openPullRequest.blocker ?? 'GitHub squashes it into one commit when the repo allows that.'}
          </p>
          <div className="git-push-confirm-buttons">
            <Button
              variant="bare"
              className="git-push-confirm-go"
              onClick={() => {
                setConfirmingMerge(false)
                void merge(openPullRequest)
              }}
            >
              Merge now
            </Button>
            <Button variant="bare" className="git-push-confirm-cancel" onClick={() => void window.api.openExternal(openPullRequest.url)}>
              Open on GitHub
            </Button>
            <Button variant="bare" className="git-push-confirm-cancel" onClick={() => setConfirmingMerge(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {changes !== null && (
        <div className="git-changes">
          <div className="flex gap-1">
            {CHANGE_SCOPES.map(([id, label]) => (
              <Button
                key={id}
                variant={scope === id ? 'secondary' : 'text'}
                className="!px-2 !text-xs"
                onClick={() => void loadChanges(id)}
              >
                {label}
              </Button>
            ))}
          </div>
          {changes === 'loading' ? (
            <span className="text-xs text-muted">Reading the changes…</span>
          ) : changes === 'error' ? (
            <span className="text-xs text-red">
              Couldn&apos;t read the changes.{' '}
              <Button variant="text" className="!px-1 !text-xs underline" onClick={() => void loadChanges(scope)}>
                Try again
              </Button>
            </span>
          ) : (
            <>
              <span className="text-xs text-muted">Compared with {changes.base}</span>
              <ChangedFiles files={changes.files} patch={changes.patch} truncated={changes.truncated} empty="No changes" />
            </>
          )}
        </div>
      )}
      {confirming && !busy && !nothingToPush && (
        <div className="git-push-confirm" role="dialog" aria-label="Confirm push">
          <p className="git-push-confirm-title">
            Upload {plural(state.ahead)} to {where}?
          </p>
          <p className="git-push-confirm-sub">
            From <code>{state.branch}</code> to <code>{state.upstream ?? `origin/${state.branch}`}</code>. Anyone
            with access to the repo will see them.
          </p>
          <ul className="git-push-confirm-list">
            {state.pending.map((subject, i) => (
              <li key={`${i}-${subject}`} title={subject}>
                {subject}
              </li>
            ))}
            {state.ahead > state.pending.length && (
              <li className="git-push-confirm-more">and {state.ahead - state.pending.length} more</li>
            )}
          </ul>
          <div className="git-push-confirm-buttons">
            <Button variant="bare" className="git-push-confirm-go" onClick={() => void push()}>
              Push now
            </Button>
            <Button variant="bare" className="git-push-confirm-cancel" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {run.kind !== 'idle' && <GitRunLine run={run} onRetry={() => setRun({ kind: 'idle' })} />}
    </>
  )
}

function GitRunLine(props: { run: Run; onRetry: () => void }): React.JSX.Element | null {
  const { run } = props
  const [text, icon] = runLine(run)
  if (!text) return null
  return (
    <div className="git-run-line" data-kind={run.kind} role="status">
      {icon}
      <span className="git-run-line-text" title={text}>
        {text}
      </span>
      {run.kind === 'failed' && (
        <Button variant="bare" className="git-run-line-dismiss" onClick={props.onRetry}>
          OK
        </Button>
      )}
    </div>
  )
}

function runLine(run: Run): [string | null, React.JSX.Element | null] {
  const working = <Spinner key="s" size="w-3 h-3" />
  const done = <Check key="c" size={12} />
  switch (run.kind) {
    case 'asking':
      return ['Asking the agent to save its changes…', working]
    case 'committing':
      return ['Agent is committing. Waiting for the new commit…', working]
    case 'committed':
      return [`Saved on this Mac: ${run.subject}`, done]
    case 'pushing':
      return [`Uploading ${plural(run.count)} to ${run.target}…`, working]
    case 'pushed':
      return [`Uploaded ${plural(run.count)} to ${run.target}`, done]
    case 'opening':
      return ['Opening the pull request on GitHub…', working]
    case 'opened':
      return [`Opened #${run.pull.number} into ${run.pull.base}`, done]
    case 'merging':
      return [`Merging #${run.pull.number} into ${run.pull.base}…`, working]
    case 'merged':
      return [`Merged #${run.pull.number} into ${run.pull.base}`, done]
    case 'failed':
      return [run.text, <AlertCircle key="a" size={12} />]
    case 'idle':
      return [null, null]
  }
}
