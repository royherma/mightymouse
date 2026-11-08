import { JSX, useCallback, useEffect, useState } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { Button } from '../components/Button'
import { Row, Stack } from '../components/Layout'
import { Modal } from '../components/Modal'
import { isKeepableProject, type ProjectFolderScan } from '../../../shared/types'

function detail(scan: ProjectFolderScan): string {
  const parts: string[] = []
  if (scan.liveAgents > 0) {
    parts.push(`${scan.liveAgents.toLocaleString()} chat${scan.liveAgents === 1 ? '' : 's'}`)
  }
  if (scan.skills > 0) parts.push(`${scan.skills} skill${scan.skills === 1 ? '' : 's'}`)
  if (scan.agents > 0) parts.push(`${scan.agents} agent${scan.agents === 1 ? '' : 's'}`)
  if (scan.hasInstructions) parts.push('instructions')
  return parts.join(' · ')
}

export function ImportProjectsModal({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: (count: number) => void
}): JSX.Element | null {
  const [found, setFound] = useState<ProjectFolderScan[] | null>(null)
  const [take, setTake] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const scans = await window.api.mighty.foundProjects()
        setFound(scans)
        setTake(new Set(scans.filter((s) => isKeepableProject(s.name) && s.liveAgents > 0).map((s) => s.agentProjectId)))
      } catch {
        setFound([])
      }
    })()
  }, [])

  const importNow = useCallback(async (): Promise<void> => {
    if (!found) return
    setBusy(true)
    setFailed(false)
    try {
      const chosen = found.filter((s) => take.has(s.agentProjectId))
      const made = chosen.length === 0 ? 0 : await window.api.mighty.importProjects(chosen)
      onImported(made)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }, [found, take, onImported])

  if (found !== null && found.length === 0) return null

  const toggle = (id: string): void =>
    setTake((all) => {
      const next = new Set(all)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Modal
      label="Import the work we found"
      onClose={() => !busy && onClose()}
      dismissOnBackdrop={false}
      backdropClassName="fixed inset-0 z-50 grid place-items-start justify-items-center bg-black/40 pt-[13vh]"
      className="flex max-h-[74vh] w-[32rem] max-w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto rounded-xl border border-surface3 bg-surface1 p-5 shadow-lg"
    >
      <div className="flex items-start justify-between gap-4">
        <Stack gap={1}>
          <div className="text-base font-bold text-on-surface">Import the work we found</div>
          <div className="text-xs text-muted">
            Agents have already been working in these folders. Pick the ones you want as projects.
          </div>
        </Stack>
        <Button variant="icon" title="Not now" onClick={onClose} disabled={busy} className="shrink-0">
          <X size={15} />
        </Button>
      </div>

      {found === null ? (
        <Stack gap={1}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded-lg bg-surface2" />
          ))}
        </Stack>
      ) : (
        <div className={`flex flex-col ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          {found.map((scan) => (
            <label
              key={scan.agentProjectId}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface2/60"
            >
              <input
                type="checkbox"
                checked={take.has(scan.agentProjectId)}
                onChange={() => toggle(scan.agentProjectId)}
                className="h-3.5 w-3.5 shrink-0 accent-accent"
              />
              <FolderOpen size={14} className="shrink-0 text-muted" />
              <span
                title={scan.repoFolder || undefined}
                className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface"
              >
                {scan.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">{detail(scan)}</span>
            </label>
          ))}
        </div>
      )}

      {failed && (
        <Row className="text-xs text-red">
          <span>Could not import those.</span>
          <Button variant="ghost" onClick={() => void importNow()}>
            Try again
          </Button>
        </Row>
      )}

      <Row className="justify-end">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Not now
        </Button>
        <Button variant="primary" onClick={() => void importNow()} disabled={busy || found === null}>
          {busy
            ? 'Importing…'
            : take.size === 0
              ? 'Skip all'
              : `Import ${take.size} project${take.size === 1 ? '' : 's'}`}
        </Button>
      </Row>
    </Modal>
  )
}
