import { JSX, useEffect, useMemo, useState } from 'react'
import { CONFIG } from '../../../shared/config'
import type { ConductorWorkspace } from '../../../shared/conductor'
import { Button } from './Button'
import { usePostNotice } from './SidebarNotices'
import { timeAgo } from '../mighty/mighty-shared'

type Progress = { state: 'starting' } | { state: 'started' } | { state: 'failed'; reason: string }

export function ConductorImport({ onStarted }: { onStarted: (pane: string) => void }): null {
  const [rows, setRows] = useState<ConductorWorkspace[]>([])
  const [progress, setProgress] = useState<Record<string, Progress>>({})

  useEffect(() => {
    void window.api.codeConductorWorkspaces().then(setRows, () => setRows([]))
  }, [])

  const notice = useMemo(() => {
    if (rows.length === 0) return null
    const L = CONFIG.UI_LABELS
    const run = (id: string): void => {
      setProgress((p) => ({ ...p, [id]: { state: 'starting' } }))
      window.api
        .codeContinueConductor(id)
        .then((result) => {
          if (result.ok) onStarted(result.pane)
          setProgress((p) => ({ ...p, [id]: result.ok ? { state: 'started' } : { state: 'failed', reason: result.reason } }))
        })
        .catch(() => setProgress((p) => ({ ...p, [id]: { state: 'failed', reason: 'Could not start. Try again.' } })))
    }
    return {
      id: 'conductor-import',
      version: rows.map((row) => row.id).sort().join(','),
      title: `${L.CODE_CONDUCTOR_TITLE} (${rows.length})`,
      detail: L.CODE_CONDUCTOR_DETAIL,
      body: rows.map((row) => <ConductorRow key={row.id} row={row} progress={progress[row.id]} onRun={run} />)
    }
  }, [rows, progress, onStarted])

  usePostNotice(notice)
  return null
}

function ConductorRow(props: { row: ConductorWorkspace; progress?: Progress; onRun: (id: string) => void }): JSX.Element {
  const { row, progress: p } = props
  const L = CONFIG.UI_LABELS
  return (
    <div className="flex items-center gap-2 py-1.5 text-[12px]">
      <div className="min-w-0 flex-1">
        <div className="truncate text-on-surface" title={row.title}>
          {row.title}
        </div>
        <div className="truncate text-muted">
          {[row.repo, row.branch].filter(Boolean).join(' · ')} · {timeAgo(row.updatedAt)}
        </div>
        {p?.state === 'failed' && <div className="text-muted">{p.reason}</div>}
        {p?.state === 'started' && <div className="text-muted">{L.CODE_CONDUCTOR_STARTED}</div>}
      </div>
      {p?.state !== 'started' && (
        <Button variant="bare" disabled={p?.state === 'starting'} onClick={() => props.onRun(row.id)}>
          {p?.state === 'starting'
            ? L.CODE_CONDUCTOR_STARTING
            : p?.state === 'failed'
              ? L.CODE_CONDUCTOR_RETRY
              : L.CODE_CONDUCTOR_CONTINUE}
        </Button>
      )}
    </div>
  )
}
