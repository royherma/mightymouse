import { JSX, useState } from 'react'
import { Folder, FolderOpen, X } from 'lucide-react'
import { Button } from '../components/Button'
import { Row, Stack } from '../components/Layout'
import { Modal } from '../components/Modal'
import type { MightyProject, ProjectFolderScan } from '../../../shared/types'

const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~')

export function CreateProjectModal({
  onCancel,
  onCreate,
  noFolderHint = 'Chats only, no files'
}: {
  onCancel: () => void
  onCreate: (project: MightyProject) => Promise<unknown> | void
  noFolderHint?: string
}): JSX.Element {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<ProjectFolderScan | null>(null)
  const [picking, setPicking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const chooseFolder = async (): Promise<void> => {
    setPicking(true)
    setProblem(null)
    try {
      const scan = await window.api.mighty.scanProjectFolder()
      if (!scan) return
      setFolder(scan)
      setName((current) => (current.trim() === '' || current === folder?.name ? scan.name : current))
    } catch {
      setProblem('Could not open that folder.')
    } finally {
      setPicking(false)
    }
  }

  const trimmed = name.trim()
  const create = async (): Promise<void> => {
    if (trimmed === '' || creating) return
    setCreating(true)
    setProblem(null)
    const now = new Date().toISOString()
    try {
      await onCreate({
        id: crypto.randomUUID(),
        name: trimmed,
        created: now,
        updated: now,
        repoFolder: folder?.repoFolder,
        agentProjectId: folder?.agentProjectId
      })
    } catch {
      setProblem('Could not create this project.')
      setCreating(false)
    }
  }

  return (
    <Modal
      label="New project"
      onClose={onCancel}
      backdropClassName="fixed inset-0 z-50 grid place-items-start justify-items-center bg-black/40 pt-[18vh]"
      className="flex w-[28rem] max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-xl border border-surface3 bg-surface1 p-5 shadow-lg"
    >
      <Row className="justify-between">
        <div className="text-base font-bold text-on-surface">New project</div>
        <Button variant="icon" title="Close" onClick={onCancel}>
          <X size={15} />
        </Button>
      </Row>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold text-on-surface">Name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create()
          }}
          placeholder="e.g. Marketing site"
          className="rounded-lg border border-surface3 bg-surface2 px-3 py-2 text-sm text-on-surface outline-none placeholder:text-muted focus:border-accent focus:shadow-focus"
        />
      </label>

      <Stack gap={1.5}>
        <span className="text-xs font-bold text-on-surface">Folder</span>
        <Row gap={3} className="rounded-lg border border-surface3 bg-surface2/40 px-3 py-2.5">
          {folder ? (
            <FolderOpen size={16} className="shrink-0 text-accent-text" />
          ) : (
            <Folder size={16} className="shrink-0 text-muted" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-on-surface" title={folder?.repoFolder}>
              {folder ? folder.name : 'No folder'}
            </div>
            <div className="truncate text-micro text-muted">
              {folder
                ? `${shortPath(folder.repoFolder)}${folder.liveAgents > 0 ? ` · ${folder.liveAgents} chat${folder.liveAgents === 1 ? '' : 's'} already here` : ''}`
                : noFolderHint}
            </div>
          </div>
          <Button variant="ghost" disabled={picking} onClick={() => void chooseFolder()}>
            {picking ? 'Opening…' : folder ? 'Change' : 'Choose folder…'}
          </Button>
          {folder && (
            <Button variant="icon" title="Use no folder" onClick={() => setFolder(null)}>
              <X size={13} />
            </Button>
          )}
        </Row>
      </Stack>

      {problem && <div className="text-xs text-red">{problem}</div>}

      <Row gap={2} className="justify-end">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void create()} disabled={trimmed === '' || creating}>
          {creating ? 'Creating…' : 'Create project'}
        </Button>
      </Row>
    </Modal>
  )
}
