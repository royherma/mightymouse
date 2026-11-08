import { JSX, useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  SlidersHorizontal,
  X
} from 'lucide-react'
import type { MightyProject, MightySession } from '../../../shared/types'
import type { CoordinationProject, CoordinationSnapshot } from '../../../shared/coordination'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'
import { Row, Stack } from '../components/Layout'
import { ProjectAvatar } from '../components/ProjectIcon'
import { ProjectSettingsModal } from './MightySessionNavigation'
import { CreateProjectModal } from './CreateProjectModal'
import { ImportProjectsModal } from './ImportProjectsModal'

type Loaded = {
  projects: MightyProject[]
  sessions: MightySession[]
  agents: CoordinationSnapshot | null
}
type RowFailure = { text: string; retry: () => void }

const TOP = 'top'
const NEW_PROJECT: MightyProject = { id: '', name: '', created: '', updated: '' }
const ROW = 'mighty-project-row grid items-center gap-3 rounded-lg px-2'
const AVATAR_SLOT = 'grid w-7 shrink-0 place-items-center'
const FOLDER_SLOT = 'mighty-project-folder flex min-w-0 justify-start'

function folderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function countLabel(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

function NameField({
  name,
  disabled,
  onRename
}: {
  name: string
  disabled: boolean
  onRename: (name: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])
  const commit = (): void => {
    const next = draft.trim()
    if (next === '' || next === name) return setDraft(name)
    onRename(next)
  }
  return (
    <input
      value={draft}
      disabled={disabled}
      aria-label="Project name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.stopPropagation()
          setDraft(name)
        }
      }}
      className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-on-surface outline-none hover:border-surface3 focus:border-accent focus:shadow-focus"
    />
  )
}

export function AllProjectsPanel({
  onChanged,
  embedded = false,
  onRequestClose
}: {
  onChanged: () => void
  embedded?: boolean
  onRequestClose?: () => void
}): JSX.Element {
  const [data, setData] = useState<Loaded | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [failed, setFailed] = useState<Record<string, RowFailure>>({})
  const [editing, setEditing] = useState<MightyProject | null>(null)
  const [attaching, setAttaching] = useState<string | null>(null)
  const [showAway, setShowAway] = useState(false)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoadFailed(false)
    try {
      const [projects, sessions, snapshot] = await Promise.all([
        window.api.mighty.listProjects(),
        window.api.mighty.listSessions(),
        window.api.coordinationGet().catch(() => null)
      ])
      setData({ projects, sessions, agents: snapshot?.enabled ? snapshot : null })
    } catch {
      setLoadFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void (async () => {
      try {
        const settings = await window.api.mighty.getSettings()
        if (settings.importedFoundProjects !== true) setImporting(true)
      } catch {
        // No settings file yet is not a reason to block the list.
      }
    })()
  }, [])

  const closeImport = useCallback(async (): Promise<void> => {
    setImporting(false)
    try {
      const settings = await window.api.mighty.getSettings()
      await window.api.mighty.setSettings({ ...settings, importedFoundProjects: true })
    } catch {
      // Worst case it offers once more next time.
    }
  }, [])

  const act = useCallback(
    async (rowId: string, text: string, fn: () => Promise<unknown>): Promise<void> => {
      setBusy((b) => ({ ...b, [rowId]: true }))
      setFailed(({ [rowId]: _, ...rest }) => rest)
      try {
        const result = await fn()
        if (result === null || result === false) throw new Error(text)
        await load()
        onChanged()
      } catch {
        setFailed((f) => ({ ...f, [rowId]: { text, retry: () => void act(rowId, text, fn) } }))
      } finally {
        setBusy(({ [rowId]: _, ...rest }) => rest)
      }
    },
    [load, onChanged]
  )

  const save = (p: MightyProject, change: Partial<MightyProject>, text: string): Promise<void> =>
    act(p.id, text, () =>
      window.api.mighty.upsertProject({ ...p, ...change, updated: new Date().toISOString() })
    )

  const attachFolder = (p: MightyProject): Promise<void> =>
    act(p.id, 'Could not add that folder.', async () => {
      const link = await window.api.mighty.pickProjectFolder()
      if (!link) return true
      return window.api.mighty.upsertProject({ ...p, ...link, updated: new Date().toISOString() })
    })

  const attachAgents = (agent: CoordinationProject, target: MightyProject | null): Promise<void> =>
    act(agent.id, 'Could not attach these agents.', async () => {
      const cwd = data?.agents?.sessions.find((s) => s.project === agent.id)?.cwd
      const link = cwd ? await window.api.mighty.pickProjectFolder(cwd) : null
      const now = new Date().toISOString()
      const base = target ?? {
        ...NEW_PROJECT,
        id: crypto.randomUUID(),
        name: agent.name,
        created: now
      }
      setAttaching(null)
      return window.api.mighty.upsertProject({
        ...base,
        repoFolder: link?.repoFolder,
        agentProjectId: agent.id,
        updated: now
      })
    })

  const failureLine = (rowId: string): JSX.Element | null => {
    const failure = failed[rowId]
    if (!failure) return null
    return (
      <Row className="px-4 pb-1 text-xs text-red">
        <span>{failure.text}</span>
        <Button variant="ghost" onClick={failure.retry}>
          Try again
        </Button>
      </Row>
    )
  }

  const linkedIds = new Set(data?.projects.map((p) => p.agentProjectId).filter(Boolean))
  const open = data?.projects.filter((p) => !p.archived) ?? []
  const away = data?.projects.filter((p) => p.archived) ?? []
  const looseAgents = data?.agents?.projects.filter((a) => !linkedIds.has(a.id)) ?? []
  const looseOpen = looseAgents.filter((a) => a.state === 'active')
  const looseAway = looseAgents.filter((a) => a.state === 'archived')
  const attachTargets = open.filter((p) => !p.agentProjectId)

  const projectRow = (p: MightyProject): JSX.Element => {
    const chats = data?.sessions.filter((s) => s.projectId === p.id).length ?? 0
    const agents =
      data?.agents?.sessions.filter((s) => s.project === p.agentProjectId && !s.stale).length ?? 0
    return (
      <div key={p.id} className={busy[p.id] ? 'pointer-events-none opacity-50' : ''}>
        <div className={`${ROW} hover:bg-surface2/50`}>
          <div className={AVATAR_SLOT}>
            <ProjectAvatar icon={p.icon} imagePath={p.imagePath} size={22} className="rounded-md" />
          </div>
          <NameField
            name={p.name}
            disabled={busy[p.id] === true}
            onRename={(name) => void save(p, { name }, 'Could not rename this project.')}
          />
          <div className={FOLDER_SLOT}>
            {p.repoFolder ? (
              <span
                title={p.repoFolder}
                className="flex min-w-0 items-center gap-1.5 rounded-md bg-surface2 py-1 pl-2 pr-1 text-xs text-on-surface"
              >
                <FolderOpen size={13} className="shrink-0 text-muted" />
                <span className="truncate">{folderName(p.repoFolder)}</span>
                <Button
                  variant="icon"
                  title="Remove folder"
                  onClick={() =>
                    void save(
                      p,
                      { repoFolder: undefined, agentProjectId: undefined },
                      'Could not remove the folder.'
                    )
                  }
                >
                  <X size={12} />
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                onClick={() => void attachFolder(p)}
                className="inline-flex shrink-0 items-center gap-1.5"
              >
                <FolderPlus size={13} />
                Add folder
              </Button>
            )}
          </div>
          <span className="mighty-project-count text-right text-xs tabular-nums text-muted">
            {countLabel(chats, 'chat')}
            {p.agentProjectId && data?.agents ? `, ${countLabel(agents, 'agent')}` : ''}
          </span>
          <details className="mighty-project-actions">
            <summary aria-label={`Actions for ${p.name}`}><MoreHorizontal size={20} /></summary>
          <Button
            variant="ghost"
            title="Project settings"
            onClick={() => setEditing(p)}
            className="shrink-0"
          >
            <SlidersHorizontal size={14} /> Settings
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setShowAway(true)
              void save(
                p,
                { archived: !p.archived },
                p.archived
                  ? 'Could not bring this project back.'
                  : 'Could not put this project away.'
              )
            }}
            className="whitespace-nowrap shrink-0"
          >
            {p.archived ? 'Bring back' : 'Put away'}
          </Button>
          </details>
        </div>
        {failureLine(p.id)}
      </div>
    )
  }

  const agentRow = (a: CoordinationProject): JSX.Element => {
    const agents = data?.agents?.sessions.filter((s) => s.project === a.id && !s.stale).length ?? 0
    const away = a.state === 'archived'
    return (
      <div key={a.id} className={busy[a.id] ? 'pointer-events-none opacity-50' : ''}>
        <div className={`${ROW} hover:bg-surface2/50`}>
          <div className={AVATAR_SLOT}>
            <ProjectAvatar size={22} className="rounded-md" />
          </div>
          <span className="min-w-0 flex-1 truncate px-2 text-sm text-on-surface">{a.name}</span>
          <div className={FOLDER_SLOT}>
            {!away &&
              (attaching === a.id ? (
                <select
                  autoFocus
                  defaultValue=""
                  aria-label={`Attach ${a.name} to a project`}
                  onBlur={() => setAttaching(null)}
                  onChange={(e) => {
                    const target = attachTargets.find((p) => p.id === e.target.value) ?? null
                    void attachAgents(a, target)
                  }}
                  className="w-full rounded-md border border-surface3 bg-surface2 px-2 py-1 text-xs outline-none focus:border-accent focus:shadow-focus"
                >
                  <option value="" disabled>
                    Attach to...
                  </option>
                  <option value="new">New project "{a.name}"</option>
                  {attachTargets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setAttaching(a.id)}
                  className="shrink-0"
                >
                  Attach to a project
                </Button>
              ))}
          </div>
          <span className="mighty-project-count text-right text-xs tabular-nums text-muted">
            {countLabel(agents, 'agent')}
          </span>
          <details className="mighty-project-actions">
            <summary aria-label={`Actions for ${a.name}`}><MoreHorizontal size={20} /></summary>
          <Button
            variant="ghost"
            onClick={() => {
              setShowAway(true)
              void act(
                a.id,
                away ? 'Could not bring these agents back.' : 'Could not put these agents away.',
                () => window.api.coordinationArchiveProject(a.id, !away)
              )
            }}
            className="whitespace-nowrap shrink-0"
          >
            {away ? 'Bring back' : 'Put away'}
          </Button>
          </details>
        </div>
        {failureLine(a.id)}
      </div>
    )
  }

  const awayCount = away.length + looseAway.length

  const body = (
    <>
        <div className="flex flex-wrap items-start justify-between gap-6">
          <Stack gap={1}>
            <div className="mighty-page-title font-semibold text-on-surface">Projects</div>
            <div className={`text-xs text-muted ${embedded ? '' : 'max-w-[34rem]'}`}>
              Keep related chats and agents together.
            </div>
          </Stack>
          <Row className="shrink-0 flex-wrap justify-end">
            {open.length + away.length > 0 && (
              <Button
                variant="ghost"
                type="button"
                title="Looks in each project's folder for a picture to use as its icon."
                onClick={() =>
                  void act(TOP, 'Could not find project icons.', () =>
                    window.api.mighty.discoverProjectImages().then((n) => n >= 0)
                  )
                }
              >
                Find project icons
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5"
            >
              <FolderPlus size={14} />
              New project
            </Button>
            {!embedded && onRequestClose && (
              <Button variant="icon" title="Close" onClick={onRequestClose}>
                <X size={15} />
              </Button>
            )}
          </Row>
        </div>

        {failureLine(TOP)}
        {loadFailed ? (
          <Row className="px-2 py-6 text-sm text-red">
            <span>Could not load your projects.</span>
            <Button variant="ghost" onClick={() => void load()}>
              Try again
            </Button>
          </Row>
        ) : !data ? (
          <Stack gap={1}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-surface2" />
            ))}
          </Stack>
        ) : (
          <>
            {open.length === 0 ? (
              <div className="px-2 py-6 text-sm text-muted">
                No projects yet. A project keeps related chats together.
              </div>
            ) : (
              <div className="flex flex-col">{open.map(projectRow)}</div>
            )}

            {looseOpen.length > 0 && (
              <Stack gap={1}>
                <div className="px-2 text-xs font-bold uppercase tracking-wide text-muted">
                  Chats with no project yet
                </div>
                <div className="flex flex-col">{looseOpen.map(agentRow)}</div>
              </Stack>
            )}

            {awayCount > 0 && (
              <Stack gap={1}>
                <Button variant="bare"
                  onClick={() => setShowAway((v) => !v)}
                  aria-expanded={showAway}
                  className="flex items-center gap-1 px-2 text-xs font-bold uppercase tracking-wide text-muted hover:text-on-surface"
                >
                  {showAway ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  Put away ({awayCount})
                </Button>
                {showAway && (
                  <div className="flex flex-col">
                    {away.map(projectRow)}
                    {looseAway.map(agentRow)}
                  </div>
                )}
              </Stack>
            )}
          </>
        )}
    </>
  )

  const overlays = (
    <>
      {importing && (
        <div onClick={(e) => e.stopPropagation()}>
          <ImportProjectsModal
            onClose={() => void closeImport()}
            onImported={() => {
              void closeImport()
              void load()
              onChanged()
            }}
          />
        </div>
      )}

      {creating && (
        <div onClick={(e) => e.stopPropagation()}>
          <CreateProjectModal
            onCancel={() => setCreating(false)}
            onCreate={(project) => {
              setCreating(false)
              void act(TOP, 'Could not create this project.', () =>
                window.api.mighty.upsertProject(project)
              )
            }}
          />
        </div>
      )}

      {editing && (
        <div onClick={(e) => e.stopPropagation()}>
          <ProjectSettingsModal
            project={editing}
            onCancel={() => setEditing(null)}
            onSave={(p) => {
              setEditing(null)
              const rowId = data?.projects.some((x) => x.id === p.id) ? p.id : TOP
              void act(rowId, 'Could not save this project.', () =>
                window.api.mighty.upsertProject(p)
              )
            }}
            onPictureChanged={() => {
              void load()
              onChanged()
            }}
            onDelete={
              editing.id !== ''
                ? () => {
                    const { id } = editing
                    setEditing(null)
                    void act(id, 'Could not delete this project.', () =>
                      window.api.mighty.deleteProject(id)
                    )
                  }
                : undefined
            }
          />
        </div>
      )}
    </>
  )

  if (embedded) {
    return (
      <Stack gap={4} className="min-h-0">
        {body}
        {overlays}
      </Stack>
    )
  }

  return (
    <>
      <Modal
        label="Projects"
        onClose={() => (attaching ? setAttaching(null) : onRequestClose?.())}
        backdropClassName="fixed inset-0 z-50 grid place-items-start justify-items-center bg-black/40 pt-[12vh]"
        className="flex max-h-[76vh] w-[44rem] max-w-[calc(100vw-2rem)] flex-col gap-4 overflow-y-auto rounded-xl border border-surface3 bg-surface1 p-5 shadow-lg"
      >
        {body}
      </Modal>
      {overlays}
    </>
  )
}

export function AllProjectsModal({
  onClose,
  onChanged
}: {
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  return <AllProjectsPanel onChanged={onChanged} onRequestClose={onClose} />
}
