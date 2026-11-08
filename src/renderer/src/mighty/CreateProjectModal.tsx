import { JSX, useCallback, useState } from 'react'
import { FileText, FolderOpen, FolderPlus, Sparkles, Users, X } from 'lucide-react'
import { Button } from '../components/Button'
import { Row, Stack } from '../components/Layout'
import { Modal } from '../components/Modal'
import type { MightyProject, ProjectFolderScan, ProjectImportKey } from '../../../shared/types'

type Picked = { scan: ProjectFolderScan; take: Set<ProjectImportKey> }

const ASSETS: { key: ProjectImportKey; icon: typeof FileText; label: (s: ProjectFolderScan) => string }[] = [
  { key: 'instructions', icon: FileText, label: () => 'Project instructions' },
  { key: 'skills', icon: Sparkles, label: (s) => `${s.skills} skill${s.skills === 1 ? '' : 's'}` },
  { key: 'agents', icon: Users, label: (s) => `${s.agents} saved agent${s.agents === 1 ? '' : 's'}` },
  {
    key: 'liveAgents',
    icon: Users,
    label: (s) => `${s.liveAgents.toLocaleString()} chat${s.liveAgents === 1 ? '' : 's'} already here`
  }
]

function has(scan: ProjectFolderScan, key: ProjectImportKey): boolean {
  return key === 'instructions' ? scan.hasInstructions : scan[key] > 0
}

export function everything(scan: ProjectFolderScan): Set<ProjectImportKey> {
  return new Set(ASSETS.map((a) => a.key).filter((k) => has(scan, k)))
}

export function CreateProjectModal({
  onCancel,
  onCreate
}: {
  onCancel: () => void
  onCreate: (project: MightyProject, take: Set<ProjectImportKey>) => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Picked[]>([])
  const [picking, setPicking] = useState(false)
  const [pickFailed, setPickFailed] = useState(false)

  const addFolder = useCallback(async (): Promise<void> => {
    setPicking(true)
    setPickFailed(false)
    try {
      const scan = await window.api.mighty.scanProjectFolder()
      if (!scan) return
      setPicked((all) =>
        all.some((p) => p.scan.repoFolder === scan.repoFolder)
          ? all
          : [...all, { scan, take: everything(scan) }]
      )
      setName((current) => (current.trim() === '' ? scan.name : current))
    } catch {
      setPickFailed(true)
    } finally {
      setPicking(false)
    }
  }, [])

  const toggle = (folder: string, key: ProjectImportKey): void =>
    setPicked((all) =>
      all.map((p) => {
        if (p.scan.repoFolder !== folder) return p
        const take = new Set(p.take)
        if (take.has(key)) take.delete(key)
        else take.add(key)
        return { ...p, take }
      })
    )

  const trimmed = name.trim()
  const first = picked[0]
  const create = (): void => {
    if (trimmed === '') return
    const now = new Date().toISOString()
    onCreate(
      {
        id: crypto.randomUUID(),
        name: trimmed,
        created: now,
        updated: now,
        repoFolder: first?.scan.repoFolder,
        agentProjectId: first?.scan.agentProjectId
      },
      first?.take ?? new Set()
    )
  }

  return (
    <Modal
      label="Create project"
      onClose={onCancel}
      backdropClassName="fixed inset-0 z-50 grid place-items-start justify-items-center bg-black/40 pt-[14vh]"
      className="flex max-h-[72vh] w-[30rem] max-w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto rounded-xl border border-surface3 bg-surface1 p-5 shadow-lg"
    >
      <Row className="justify-between">
        <div className="text-base font-bold text-on-surface">Create project</div>
        <Button variant="icon" title="Close" onClick={onCancel}>
          <X size={15} />
        </Button>
      </Row>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-bold text-on-surface">Project name</span>
        <div className="flex items-center gap-2 rounded-lg border border-surface3 bg-surface2 px-3 focus-within:border-accent focus-within:shadow-focus">
          <FolderOpen size={14} className="shrink-0 text-muted" />
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
            placeholder="Copenhagen Trip"
            className="min-w-0 flex-1 bg-transparent py-2 text-sm text-on-surface outline-none placeholder:text-muted"
          />
        </div>
      </label>

      <Stack gap={1.5}>
        <span className="text-xs font-bold text-on-surface">Source folders</span>
        {picked.map(({ scan, take }) => (
          <Stack key={scan.repoFolder} gap={1} className="rounded-lg border border-surface3 bg-surface2/40 p-3">
            <Row>
              <FolderOpen size={14} className="shrink-0 text-muted" />
              <span title={scan.repoFolder} className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">
                {scan.name}
              </span>
              <Button
                variant="icon"
                title="Remove folder"
                onClick={() => setPicked((all) => all.filter((p) => p.scan.repoFolder !== scan.repoFolder))}
              >
                <X size={13} />
              </Button>
            </Row>
            {ASSETS.filter((a) => has(scan, a.key)).map(({ key, icon: Icon, label }) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md py-0.5 pl-6 pr-1 text-xs text-on-surface hover:bg-surface2">
                <input
                  type="checkbox"
                  checked={take.has(key)}
                  onChange={() => toggle(scan.repoFolder, key)}
                  className="h-3.5 w-3.5 shrink-0 accent-accent"
                />
                <Icon size={12} className="shrink-0 text-muted" />
                <span>{label(scan)}</span>
              </label>
            ))}
          </Stack>
        ))}
        <Button variant="bare"
          onClick={() => void addFolder()}
          disabled={picking}
          className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-surface3 py-6 text-xs text-muted hover:border-accent hover:text-on-surface disabled:opacity-50"
        >
          <FolderPlus size={16} />
          {picking ? 'Opening…' : 'Add folders MightyMouse can read and edit'}
        </Button>
        {pickFailed && (
          <Row className="text-xs text-red">
            <span>Could not read that folder.</span>
            <Button variant="ghost" onClick={() => void addFolder()}>
              Try again
            </Button>
          </Row>
        )}
      </Stack>

      <div className="rounded-lg bg-surface2/60 px-3 py-2.5 text-xs text-muted">
        A project keeps chats, folders and instructions in one place. Add a folder and every chat
        here works inside it.
      </div>

      <Row className="justify-end">
        <Button variant="primary" onClick={create} disabled={trimmed === ''}>
          Create project
        </Button>
      </Row>
    </Modal>
  )
}
