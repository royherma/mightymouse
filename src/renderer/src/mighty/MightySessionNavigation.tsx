import { JSX, ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, Trash2, Check, MoreHorizontal, Pin, PinOff, Archive, ArchiveRestore, Loader2, Sparkles } from 'lucide-react'
import { Button } from '../components/Button'
import { Row, Stack } from '../components/Layout'
import { Modal } from '../components/Modal'
import { SuggestInput } from '../components/SuggestInput'
import { ProjectAvatar, ProjectIcon, PROJECT_ICONS } from '../components/ProjectIcon'
import { type ChatOpenState } from './pane-selection'
import { sessionRowTone, type PaneOpenColorId } from './pane-colors'
import { CONFIG } from '../../../shared/config'
import { type Snippet } from '../../../shared/fuzzy'
import { MODELS } from '../SettingsApp'
import { useModelCatalog } from '../components/ModelPicker'
import type { MightySession, MightyProject, BackendId } from '../../../shared/types'
import { SESSION_DRAG_TYPE } from '../../../shared/canvas'
import { cleanBrief, type InfraRecord } from '../../../shared/infra'
import {
  BRIEF_FILL_FAIL,
  BRIEF_WORDS,
  briefIdeas,
  likeYours,
  type BriefDraftFail
} from '../../../shared/brief'

import { timeAgo, MOVE_MENU_W, MOVE_MENU_GAP, MOVE_MENU_MARGIN } from './mighty-shared'
export function SnippetLine({
  snippet,
  markClassName = 'bg-accent-wash text-on-surface rounded-sm px-0.5'
}: {
  snippet: Snippet
  markClassName?: string
}): JSX.Element {
  const { text, index, length } = snippet
  if (index < 0) return <span>{text}</span>
  return (
    <>
      {text.slice(0, index)}
      <mark className={markClassName}>
        {text.slice(index, index + length)}
      </mark>
      {text.slice(index + length)}
    </>
  )
}

export function SessionRow({
  s,
  openState,
  openColor,
  snippet,
  projects,
  moveMenuOpen,
  onOpen,
  onDelete,
  onTogglePin,
  onToggleArchive,
  onToggleMoveMenu,
  onMove,
  onNewProject,
  leading,
  nested = false
}: {
  s: MightySession
  openState: ChatOpenState
  /** Matches the pane border color when this session is open on screen. */
  openColor: PaneOpenColorId | null
  /** Set when this row matched on message text — shows WHY it matched. */
  snippet: Snippet | null
  projects: MightyProject[]
  moveMenuOpen: boolean
  onOpen: () => void
  onDelete: () => void
  onTogglePin: () => void
  onToggleArchive: () => void
  onToggleMoveMenu: () => void
  onMove: (projectId: string | undefined) => void
  onNewProject: () => void
  leading?: ReactNode
  nested?: boolean
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  // The menu is PORTALLED to <body> rather than positioned inside the row: the
  // session list is an `overflow-y-auto` scroller, and CSS cannot clip one axis
  // alone — `overflow-y` forces the x-axis to clip too, so an absolutely
  // positioned child gets cut off at the narrow sidebar's edge whichever side it
  // opens toward. A portal escapes the scroller; these are its screen coords.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!moveMenuOpen || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    // Open rightward from the button, then clamp so the menu can never leave the
    // window on either side — the sidebar is user-resizable, so neither a fixed
    // left nor a fixed right anchor stays correct at every width.
    const left = Math.min(
      Math.max(MOVE_MENU_MARGIN, r.left),
      window.innerWidth - MOVE_MENU_W - MOVE_MENU_MARGIN
    )
    setMenuPos({ top: r.bottom + MOVE_MENU_GAP, left })
  }, [moveMenuOpen])

  useEffect(() => {
    if (!moveMenuOpen) return
    const onClick = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) onToggleMoveMenu()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [moveMenuOpen, onToggleMoveMenu])

  const rowTone = sessionRowTone(openState, openColor)

  return (
    <div
      className={`group relative flex items-center gap-1 mx-2 py-1.5 pr-2.5 rounded-md cursor-pointer ${nested ? 'pl-[49px]' : 'pl-2.5'} ${rowTone}`}
      onClick={onOpen}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_DRAG_TYPE, s.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      {!nested && (
        <span className="mr-1.5 grid w-4 shrink-0 place-items-center text-muted" aria-hidden>
          {leading}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div
          className={`text-sm truncate text-on-surface ${
            openState === 'focused' ? 'font-medium' : 'font-normal'
          }`}
        >
          {s.title || CONFIG.UI_LABELS.UNTITLED_CHAT}
        </div>
        {snippet && (
          <div className="text-xs text-muted mt-0.5 truncate">
            <SnippetLine snippet={snippet} />
          </div>
        )}
      </div>
      <span className={`shrink-0 h-6 items-center text-xs text-muted tabular-nums ${moveMenuOpen ? 'hidden' : 'inline-flex group-hover:hidden'}`}>
        {s.runId ? <Loader2 size={13} className="animate-spin" /> : timeAgo(s.updated)}
      </span>
      <div className={`shrink-0 h-6 items-center gap-1 ${moveMenuOpen ? 'flex' : 'hidden group-hover:flex'}`}>
        <Button
          variant="icon"
          onClick={(e) => {
            e.stopPropagation()
            onTogglePin()
          }}
          title={s.pinned ? 'Unpin' : 'Pin to top'}
          aria-label={s.pinned ? 'Unpin' : 'Pin to top'}
        >
          {s.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </Button>
        <Button variant="bare"
          ref={btnRef}
          onClick={(e) => {
            e.stopPropagation()
            onToggleMoveMenu()
          }}
          className="grid place-items-center text-muted hover:text-on-surface rounded p-1"
          title="Move to project"
        >
          <MoreHorizontal size={13} />
        </Button>
        {moveMenuOpen &&
          createPortal(
            <div
              ref={menuRef}
              className="fixed rounded-lg border border-surface3 bg-surface1 shadow-lg py-1 z-50"
              style={{ top: menuPos.top, left: menuPos.left, width: MOVE_MENU_W }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Pinned at the top, always — the only item that's here whether you
                have zero projects or nine, so it's one stable target. With no
                projects it's also the way out of what was a dead-end menu. */}
              <Button variant="bare"
                onClick={onNewProject}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface2"
              >
                <Plus size={13} className="text-muted" />
                <span className="flex-1 truncate">New project</span>
              </Button>
              {projects.length > 0 && <div className="my-1 border-t border-surface3" />}
              {projects.map((p) => (
                <Button variant="bare"
                  key={p.id}
                  onClick={() => onMove(p.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface2"
                >
                  <ProjectAvatar icon={p.icon} imagePath={p.imagePath} size={13} />
                  <span className="flex-1 truncate">{p.name}</span>
                  {s.projectId === p.id && <Check size={13} className="text-accent-text" />}
                </Button>
              ))}
              {s.projectId && (
                <Button variant="bare"
                  onClick={() => onMove(undefined)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-muted hover:bg-surface2 border-t border-surface3 mt-1 pt-1.5"
                >
                  Move to Unassigned
                </Button>
              )}
            </div>,
            document.body
          )}
        <Button
          variant="icon"
          onClick={(e) => {
            e.stopPropagation()
            onToggleArchive()
          }}
          title={s.archived ? 'Unarchive' : 'Archive'}
          aria-label={s.archived ? 'Unarchive' : 'Archive'}
        >
          {s.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </Button>
        <Button
          variant="icon"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Delete"
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  )
}

// Create/rename/edit-defaults modal for a Project. `project.id === ''` means
// "not yet created" — Save calls upsert with a fresh id; onDelete is only wired
// up for an existing project (see the `id !== ''` gate at the call site).
export function ProjectSettingsModal({
  project,
  onCancel,
  onSave,
  onDelete,
  onPictureChanged
}: {
  project: MightyProject
  onCancel: () => void
  onSave: (project: MightyProject) => void
  onDelete?: () => void
  onPictureChanged?: () => void
}): JSX.Element {
  const [name, setName] = useState(project.name)
  const [icon, setIcon] = useState(project.icon ?? 'folder')
  const [imagePath, setImagePath] = useState(project.imagePath)
  const [pictureBusy, setPictureBusy] = useState(false)
  const [defaultBackend, setDefaultBackend] = useState<BackendId | ''>(project.defaultBackend ?? '')
  const [defaultModel, setDefaultModel] = useState(project.defaultModel ?? '')
  const modelCatalog = useModelCatalog()
  const [systemPrompt, setSystemPrompt] = useState(project.systemPrompt ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isNew = project.id === ''
  const [record, setRecord] = useState<InfraRecord | null>(null)
  const [what, setWhat] = useState('')
  const [audience, setAudience] = useState('')
  const [niche, setNiche] = useState('')
  const [briefFailed, setBriefFailed] = useState(false)
  const [fill, setFill] = useState<'idle' | 'busy' | 'done' | BriefDraftFail>('idle')
  const ideas = briefIdeas(record?.business ?? [])
  const title = isNew ? 'New project' : 'Project settings'
  const heading = 'text-xs font-bold uppercase tracking-wide text-muted'
  const field =
    'rounded-lg bg-surface2 border border-surface3 px-3 py-2 text-sm outline-none focus:border-accent focus:shadow-focus'

  const fillIn = async (): Promise<void> => {
    setFill('busy')
    const got = await window.api.infra
      .draftBrief(project.id)
      .catch(() => ({ fail: 'failed' as const }))
    if ('fail' in got) return setFill(got.fail)
    setWhat((old) => got.brief.what ?? old)
    setAudience((old) => got.brief.audience ?? old)
    setNiche((old) => got.brief.niche ?? old)
    setFill('done')
  }

  useEffect(() => {
    if (project.id === '') return
    let live = true
    void window.api.infra.list().then((all) => {
      const found = all.find((i) => i.projectId === project.id)?.record
      if (!live || !found) return
      setRecord(found)
      setWhat(found.brief?.what ?? '')
      setAudience(found.brief?.audience ?? '')
      setNiche(found.brief?.niche ?? '')
    })
    return () => {
      live = false
    }
  }, [project.id])

  const save = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (trimmedName === '') return
    const old = record?.brief
    if (
      record &&
      (what !== (old?.what ?? '') ||
        audience !== (old?.audience ?? '') ||
        niche !== (old?.niche ?? ''))
    ) {
      setBriefFailed(false)
      const got = await window.api.infra
        .setBrief(project.id, cleanBrief({ ...old, what, audience, niche }) ?? {})
        .catch(() => null)
      if (!got?.record) return setBriefFailed(true)
    }
    const now = new Date().toISOString()
    onSave({
      ...project,
      id: isNew ? crypto.randomUUID() : project.id,
      name: trimmedName,
      icon: icon === 'folder' ? undefined : icon,
      created: isNew ? now : project.created,
      updated: now,
      defaultBackend: defaultBackend === '' ? undefined : defaultBackend,
      defaultModel:
        defaultBackend === 'mightymouse' && defaultModel !== '' ? defaultModel : undefined,
      systemPrompt: systemPrompt.trim() !== '' ? systemPrompt : project.systemPrompt === undefined ? undefined : ''
    })
  }

  return (
    <Modal
      label={title}
      onClose={() => (confirmDelete ? setConfirmDelete(false) : onCancel())}
      className="flex max-h-[86vh] w-[46rem] max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-surface3 bg-surface1 shadow-lg"
    >
      <Row gap={3} className="border-b border-surface3 px-5 py-3.5">
        <ProjectAvatar icon={icon} imagePath={imagePath} size={24} className="rounded-md" />
        <div className="text-sm font-bold text-on-surface">{title}</div>
      </Row>

      <div className="grid grid-cols-1 gap-x-6 gap-y-4 overflow-y-auto px-5 py-4 sm:grid-cols-2">
        <Stack gap={4}>
          <label className="flex flex-col gap-1.5">
            <span className={heading}>Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
              placeholder="e.g. Marketing site"
              className={field}
            />
          </label>

          <Stack gap={1.5}>
            <span className={heading}>Icon</span>
            <Row gap={1.5} className="flex-wrap">
              {PROJECT_ICONS.map((choice) => (
                <Button variant="bare"
                  key={choice.id}
                  type="button"
                  title={choice.label}
                  aria-label={choice.label}
                  aria-pressed={icon === choice.id}
                  onClick={() => setIcon(choice.id)}
                  className={`grid place-items-center rounded-lg border p-2 ${
                    icon === choice.id
                      ? 'border-accent text-accent-text bg-accent-wash'
                      : 'border-surface3 text-muted hover:text-on-surface hover:bg-surface2'
                  }`}
                >
                  <ProjectIcon id={choice.id} size={15} />
                </Button>
              ))}
            </Row>
          </Stack>

          <Stack gap={1.5}>
            <span className={heading}>Picture</span>
            <Row gap={3}>
              <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-surface3 bg-surface2">
                {imagePath ? (
                  <ProjectAvatar icon={icon} imagePath={imagePath} size={48} className="rounded-lg" />
                ) : (
                  <span className="text-micro text-muted">None</span>
                )}
              </div>
              <Stack gap={1.5} className="min-w-0">
                <p className="text-xs text-muted">
                  Pick a photo so you spot this project fast in your lists.
                </p>
                <Row className="flex-wrap">
                  <Button
                    variant="ghost"
                    type="button"
                    disabled={isNew || pictureBusy}
                    onClick={() => {
                      if (isNew) return
                      setPictureBusy(true)
                      void window.api.mighty
                        .pickProjectImage(project.id)
                        .then((p) => {
                          if (p?.imagePath) setImagePath(p.imagePath)
                          onPictureChanged?.()
                        })
                        .finally(() => setPictureBusy(false))
                    }}
                  >
                    Choose picture…
                  </Button>
                  {imagePath && !isNew && (
                    <Button
                      variant="ghost"
                      type="button"
                      disabled={pictureBusy}
                      onClick={() => {
                        setPictureBusy(true)
                        void window.api.mighty
                          .clearProjectImage(project.id)
                          .then((p) => {
                            setImagePath(p?.imagePath)
                            onPictureChanged?.()
                          })
                          .finally(() => setPictureBusy(false))
                      }}
                    >
                      Remove picture
                    </Button>
                  )}
                </Row>
                {isNew && (
                  <span className="text-micro text-muted">
                    Save the project first, then add a picture.
                  </span>
                )}
              </Stack>
            </Row>
          </Stack>

          <label className="flex flex-col gap-1.5">
            <span className={heading}>Default backend</span>
            <select
              value={defaultBackend}
              onChange={(e) => setDefaultBackend(e.target.value as BackendId | '')}
              className={field}
            >
              <option value="">Use global default</option>
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {defaultBackend === 'mightymouse' && (
            <label className="flex flex-col gap-1.5">
              <span className={heading}>Default model</span>
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className={field}
              >
                <option value="">Use feature-routed default</option>
                {modelCatalog.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </Stack>

        <Stack gap={4}>
          {record && (
            <Stack gap={1.5}>
              <Row className="justify-between">
                <span className={heading}>{BRIEF_WORDS.about}</span>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={fill === 'busy'}
                  onClick={() => void fillIn()}
                  className="inline-flex items-center gap-1 !py-1 text-xs"
                >
                  {fill === 'busy' ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  {fill === 'busy' ? BRIEF_WORDS.filling : BRIEF_WORDS.fill}
                </Button>
              </Row>
              <SuggestInput
                label={BRIEF_WORDS.what}
                value={what}
                ideas={ideas.what}
                placeholder={BRIEF_WORDS.whatExample}
                onChange={setWhat}
              />
              <SuggestInput
                label={BRIEF_WORDS.audience}
                value={audience}
                ideas={ideas.audience}
                placeholder={BRIEF_WORDS.audienceExample}
                onChange={setAudience}
              />
              <SuggestInput
                label={likeYours(record.business ?? [])}
                value={niche}
                ideas={ideas.niche}
                placeholder={BRIEF_WORDS.nicheExample}
                onChange={setNiche}
              />
              <span className="text-micro text-muted">
                {fill === 'idle' || fill === 'busy' ? (
                  BRIEF_WORDS.aboutHint
                ) : (
                  <span className={fill === 'done' ? 'text-green' : 'text-red'}>
                    {fill === 'done' ? BRIEF_WORDS.filled : BRIEF_FILL_FAIL[fill]}
                  </span>
                )}{' '}
                Reports compares your numbers to projects like this one.
                Your goal and services are under Setup - Infrastructure.
              </span>
              {briefFailed && <span className="text-xs text-red">{BRIEF_WORDS.failed}</span>}
            </Stack>
          )}

          <label className="flex flex-1 flex-col gap-1.5">
            <span className={heading}>Context for this project</span>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              placeholder="Anything Mighty should always know when working in this project…"
              className={`min-h-24 flex-1 resize-none ${field}`}
            />
          </label>
        </Stack>
      </div>

      <Row className="justify-between border-t border-surface3 px-5 py-3">
        {onDelete ? (
          confirmDelete ? (
            <Row>
              <span className="text-xs text-muted">Chats move to Unassigned.</span>
              <Button variant="ghost" onClick={onDelete} className="text-red">
                Confirm delete
              </Button>
            </Row>
          ) : (
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1"
            >
              <Trash2 size={13} />
              Delete project
            </Button>
          )
        ) : (
          <span />
        )}
        <Row>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={name.trim() === ''}>
            Save
          </Button>
        </Row>
      </Row>
    </Modal>
  )
}

// One chat exchange (user bubble + Mighty bubble). Hovering either bubble reveals
// its timestamp and a copy button; clicking copy puts the bubble text on the clipboard.
// Exported: ConversationPane (the multi-pane-chat per-pane component) reuses this
// verbatim instead of forking a copy — it's fully prop-driven, no ChatTab coupling.

