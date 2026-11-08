import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { AlertCircle, Check, Loader2, Plus, RefreshCw, ShieldCheck, Wrench, X } from 'lucide-react'
import type { MightyProject } from '../../../shared/types'
import type { ProjectKeyMap } from '../../../shared/keys'
import { keyProvider } from '../../../shared/key-providers'
import { keyBook } from '../../../shared/key-owner'
import {
  APP_KIND_LABELS,
  BUSINESS_LABELS,
  BUSINESS_TYPES,
  INFRA_GROUP_LABELS,
  INFRA_KINDS,
  INFRA_RECORD_PATH,
  infraNeeds,
  infraFixPrompt,
  infraProvider,
  infraSetupPrompt,
  kindApplies,
  kindWanted,
  providerFits,
  suggestedBy,
  usualProvider,
  type InfraEntry,
  type InfraEnvironment,
  type InfraKind,
  type InfraProvider,
  type InfraRecord,
  type InfraSetup,
  type ProjectInfra,
  type SetupState,
  type TagField
} from '../../../shared/infra'
import { ENV_LABELS, infraHits, type InfraHit, type InfraJump } from '../../../shared/infra-search'
import { Button } from './Button'
import { CopyButton, ICON_SIZE } from './CopyButton'
import { Modal } from './Modal'
import { PublishSite } from './PublishSite'
import { BriefRows } from './InfraBrief'
import { KeyProviderIcon } from './KeyProviderIcon'
import { KeyAddSheet } from './KeyAddSheet'
import { ProjectAvatar } from './ProjectIcon'
import {
  DOT_TEXT,
  INFRA_GROUPS,
  InfraScorecard,
  ProviderIcon,
  brokenKeys,
  keyDot,
  keyProblem,
  type KeyDot
} from './InfraScorecard'
import './KeysPanel.css'
import './InfraPanel.css'

function entryLabel(kindId: string, entry: InfraEntry): string {
  return infraProvider(kindId, entry.provider)?.label ?? entry.label ?? entry.provider
}

function clock(iso: string): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

function namesList(ids: string[], projects: MightyProject[]): string {
  const names = ids.map((id) => projects.find((p) => p.id === id)?.name ?? '').filter(Boolean)
  return names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

function ago(iso: string): string {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000)
  if (!(min >= 1)) return 'just now'
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`
}

const SETUP_TEXT: Record<SetupState, (label: string) => string> = {
  starting: (label) => `Starting an agent to add ${label}`,
  working: (label) => `An agent is adding ${label}`,
  waiting: () => 'The agent is waiting for you',
  stopped: (label) => `The agent stopped before ${label} showed up in the code`
}

function SetupLine({
  label,
  setup,
  state,
  onOpen,
  onRetry,
  onAdded,
  onForget
}: {
  label: string
  setup: InfraSetup
  state: SetupState
  onOpen?: () => void
  onRetry: () => void
  onAdded: () => void
  onForget: () => void
}): JSX.Element {
  const ended = state === 'waiting' || state === 'stopped'
  return (
    <div className="infra-setup" data-state={state}>
      {state === 'stopped' ? (
        <AlertCircle size={13} strokeWidth={2.5} />
      ) : state === 'waiting' ? (
        <span className="infra-setup-wait" />
      ) : (
        <Loader2 size={13} strokeWidth={2.5} data-spin="" />
      )}
      <span className="infra-setup-text">
        {SETUP_TEXT[state](label)}
        <span> · started {ago(setup.startedAt)}</span>
      </span>
      {state === 'stopped' ? (
        <Button variant="primary" onClick={onRetry}>
          Try again
        </Button>
      ) : (
        onOpen && (
          <Button variant={state === 'waiting' ? 'primary' : 'ghost'} onClick={onOpen}>
            Open in Agents
          </Button>
        )
      )}
      {ended && (
        <Button variant="ghost" onClick={onAdded}>
          It&apos;s added
        </Button>
      )}
      <Button variant="bare" className="infra-link" onClick={onForget}>
        Stop watching
      </Button>
    </div>
  )
}

type SheetState = {
  kindId: string
  provider?: string
  starting?: string
  error?: string
  other?: boolean
}

export function InfraPanel({ onOpenAgent }: { onOpenAgent?: (pane: string) => void }): JSX.Element {
  const [projects, setProjects] = useState<MightyProject[]>([])
  const [all, setAll] = useState<ProjectInfra[]>([])
  const [maps, setMaps] = useState<ProjectKeyMap[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [otherName, setOtherName] = useState('')
  const [added, setAdded] = useState<Record<string, boolean>>({})
  const [fixing, setFixing] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<Record<string, string>>({})
  const [, setMinute] = useState(0)
  const [query, setQuery] = useState('')
  const [addKey, setAddKey] = useState<InfraHit | null>(null)
  const latest = useRef<ProjectInfra[]>([])
  const searchBox = useRef<HTMLInputElement>(null)
  const jump = useRef<InfraJump | null>(null)

  useEffect(() => {
    void window.api.mighty
      .listProjects()
      .then((list) => {
        const live = list.filter((p) => !p.archived)
        setProjects(live)
        const first = live.find((p) => p.repoFolder)?.id ?? live[0]?.id
        if (first) select(first)
      })
      .catch(() => setProjects([]))
    void window.api.infra.list().then(setAll)
    void window.api.keys.list().then(setMaps)
    const offInfra = window.api.infra.onChanged((next) => {
      flashAdded(latest.current.find((p) => p.projectId === next.projectId)?.record, next)
      setAll((prev) => [...prev.filter((p) => p.projectId !== next.projectId), next])
    })
    const offKeys = window.api.keys.onChanged(setMaps)
    return () => {
      offInfra()
      offKeys()
    }
  }, [])

  const check = (projectId: string): void => {
    setChecking((prev) => ({ ...prev, [projectId]: true }))
    void window.api.infra
      .check(projectId)
      .catch(() => null)
      .finally(() => setChecking((prev) => ({ ...prev, [projectId]: false })))
  }

  function select(projectId: string): void {
    setSelected(projectId)
    setOpenRow(null)
    check(projectId)
  }

  function flashAdded(prev: InfraRecord | null | undefined, next: ProjectInfra): void {
    const fresh = Object.keys(prev?.setups ?? {})
      .filter(
        (kindId) =>
          !next.record?.setups?.[kindId] &&
          (next.record?.services[kindId] ?? []).length > (prev?.services[kindId] ?? []).length
      )
      .map((kindId) => `${next.projectId}:${kindId}`)
    if (fresh.length === 0) return
    setAdded((cur) => ({ ...cur, ...Object.fromEntries(fresh.map((k) => [k, true])) }))
    setTimeout(
      () =>
        setAdded((cur) =>
          Object.fromEntries(Object.entries(cur).filter(([k]) => !fresh.includes(k)))
        ),
      8_000
    )
  }

  useEffect(() => {
    latest.current = all
  }, [all])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchBox.current?.focus()
        searchBox.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const book = useMemo(() => keyBook(maps, projects, all), [maps, projects, all])
  const hits = useMemo(() => infraHits(query, projects, all, maps), [query, projects, all, maps])
  const searching = query.trim().length > 0
  const project = projects.find((p) => p.id === selected) ?? null
  const current = all.find((p) => p.projectId === selected) ?? null
  const record = current?.record ?? null
  const needs = useMemo(() => infraNeeds(record), [record])
  const broken = useMemo(
    () => (project ? brokenKeys(record, project.id, book) : []),
    [record, project, book]
  )
  const todo = needs.length + broken.length
  const scored = project?.repoFolder && !current?.error ? project : null
  const hooked = record
    ? INFRA_KINDS.filter((k) => (record.services[k.id] ?? []).length > 0).length
    : 0

  const settingUp = Object.keys(record?.setups ?? {}).length > 0
  useEffect(() => {
    if (!settingUp) return
    const timer = setInterval(() => setMinute((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [settingUp])

  const startSetup = (kind: InfraKind, provider: InfraProvider): void => {
    if (!project?.repoFolder) return
    const projectId = project.id
    const keyNames =
      provider.keyProvider && !provider.noKey
        ? (keyProvider(provider.keyProvider)?.envNames ?? [])
        : []
    const failed = (error: string): void =>
      setSheet({ kindId: kind.id, provider: provider.id, error })
    setSheet({ kindId: kind.id, provider: provider.id, starting: provider.label })
    void window.api
      .codeStartAgent({
        project: project.name,
        cwd: project.repoFolder,
        inApp: true,
        message: infraSetupPrompt(kind, provider, keyNames, record?.business, record?.brief)
      })
      .then(async (result) => {
        if (!result.ok) return failed(result.reason)
        await window.api.infra.setup(projectId, kind.id, {
          provider: provider.id,
          pane: result.pane || undefined
        })
        setSheet(null)
      })
      .catch(() => failed('Something went wrong on this Mac.'))
  }

  const startFix = (kind: InfraKind, entry: InfraEntry, problem: string): void => {
    if (!project?.repoFolder) return
    const provider = infraProvider(kind.id, entry.provider)
    const id = `${project.id}:${kind.id}:${entry.provider}`
    const keyName =
      entry.key ?? keyProvider(provider?.keyProvider ?? '')?.envNames?.[0] ?? 'its key'
    setFixing((cur) => ({ ...cur, [id]: '' }))
    const done = (error?: string): void =>
      setFixing((cur) => {
        const rest = { ...cur }
        delete rest[id]
        return error ? { ...rest, [id]: error } : rest
      })
    void window.api
      .codeStartAgent({
        project: project.name,
        cwd: project.repoFolder,
        inApp: true,
        message: infraFixPrompt(kind, entryLabel(kind.id, entry), entry, keyName, problem)
      })
      .then((result) => {
        if (!result.ok) return done(result.reason)
        done()
        if (result.pane) setRunning((cur) => ({ ...cur, [id]: result.pane as string }))
      })
      .catch(() => done('Something went wrong on this Mac.'))
  }

  const fixButton = (
    kind: InfraKind,
    entry: InfraEntry,
    problem: string,
    fix: string | undefined,
    lead: boolean
  ): JSX.Element => {
    const pane = running[`${project?.id}:${kind.id}:${entry.provider}`]
    if (pane && fix === undefined) {
      return (
        <Button variant="ghost" onClick={onOpenAgent ? () => onOpenAgent(pane) : undefined}>
          <span className="infra-btn-inner">
            <Loader2 size={12} strokeWidth={2.5} data-spin="" />
            Agent running · Open
          </span>
        </Button>
      )
    }
    return (
      <Button
        variant={lead ? 'primary' : 'ghost'}
        disabled={fix === ''}
        onClick={() => startFix(kind, entry, problem)}
      >
        <span className="infra-btn-inner">
          {fix === '' ? (
            <Loader2 size={12} strokeWidth={2.5} data-spin="" />
          ) : (
            <Wrench size={12} strokeWidth={2.5} />
          )}
          {fix === '' ? 'Starting an agent…' : fix ? 'Try again' : 'Fix it'}
        </span>
      </Button>
    )
  }

  const jumpTo = (kindId: string): void => {
    setOpenRow(kindId)
    requestAnimationFrame(() =>
      (
        document.querySelector(`[data-kind-todo="${kindId}"]`) ??
        document.querySelector(`[data-kind-row="${kindId}"]`)
      )?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    )
  }

  const setupLine = (kind: InfraKind): JSX.Element | null => {
    const setup = record?.setups?.[kind.id]
    if (!setup || !project) return null
    const provider = infraProvider(kind.id, setup.provider)
    const label = provider?.label ?? setup.provider
    return (
      <SetupLine
        label={label}
        setup={setup}
        state={current?.live?.[kind.id] ?? 'starting'}
        onOpen={setup.pane && onOpenAgent ? () => onOpenAgent(setup.pane as string) : undefined}
        onRetry={() => (provider ? startSetup(kind, provider) : setSheet({ kindId: kind.id }))}
        onAdded={() => void window.api.infra.add(project.id, kind.id, label)}
        onForget={() => void window.api.infra.setup(project.id, kind.id, null)}
      />
    )
  }

  const saveOther = (): void => {
    if (!selected || !sheet || !otherName.trim()) return
    void window.api.infra.add(selected, sheet.kindId, otherName).then(() => {
      setOtherName('')
      setSheet(null)
    })
  }

  useEffect(() => {
    const to = jump.current
    if (!to || !record) return
    jump.current = null
    const target = to.kind
      ? `[data-kind-row="${to.kind}"]`
      : to.env
        ? `[data-env-row="${to.env}"]`
        : null
    if (target)
      document.querySelector(target)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })

  const pick = (hit?: InfraHit): void => {
    if (!hit?.projectId) return
    setQuery('')
    if (hit.projectId !== selected) select(hit.projectId)
    setOpenRow(hit.jump.kind ?? null)
    jump.current = hit.jump
  }

  const sheetKind = sheet ? INFRA_KINDS.find((k) => k.id === sheet.kindId) : undefined
  const leadNeed = broken.length ? undefined : needs.find((k) => !setupLine(k))?.id

  return (
    <div className="keys-panel infra-panel" data-scored={scored && !searching ? '' : undefined}>
      <div className="keys-rail">
        <div className="infra-search-wrap">
          <input
            ref={searchBox}
            className="keys-search infra-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
              if (e.key === 'Enter') pick(hits.find((h) => h.projectId))
            }}
            placeholder="Search all projects  ⌘F"
            aria-label="Search all projects"
          />
          {query && (
            <Button
              variant="quiet"
              className="infra-search-clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => {
                setQuery('')
                searchBox.current?.focus()
              }}
            >
              <X size={ICON_SIZE - 2} />
            </Button>
          )}
        </div>
        {projects.map((p) => {
          const r = all.find((x) => x.projectId === p.id)?.record ?? null
          const count = infraNeeds(r).length + brokenKeys(r, p.id, book).length
          return (
            <Button
              key={p.id}
              variant="bare"
              className="keys-rail-row"
              data-active={selected === p.id || undefined}
              onClick={() => select(p.id)}
            >
              <ProjectAvatar
                icon={p.icon}
                imagePath={p.imagePath}
                size={16}
                className="rounded-sm"
              />
              <span className="keys-rail-name">{p.name}</span>
              {r && count > 0 && <span className="keys-rail-missing">{count}</span>}
            </Button>
          )
        })}
      </div>

      {searching && (
        <div className="keys-main">
          <div className="keys-main-head">
            <span className="keys-scope-name">Search</span>
            <span className="keys-count">
              {hits.length} {hits.length === 1 ? 'match' : 'matches'} for &quot;{query.trim()}&quot;
            </span>
          </div>
          <InfraSearchResults hits={hits} projects={projects} onPick={pick} onAddKey={setAddKey} />
        </div>
      )}

      <div className="keys-main" hidden={searching}>
        <div className="keys-main-head">
          {project && (
            <ProjectAvatar
              icon={project.icon}
              imagePath={project.imagePath}
              size={20}
              className="rounded-sm"
            />
          )}
          <span className="keys-scope-name">{project?.name ?? ''}</span>
          {record && (
            <span className="keys-count">
              {hooked} connected · checked {clock(record.checkedAt)}
            </span>
          )}
          <span className="keys-head-actions">
            {selected && project?.repoFolder && (
              <Button
                variant="ghost"
                onClick={() => check(selected)}
                disabled={checking[selected] === true}
              >
                <span className="infra-btn-inner">
                  <RefreshCw
                    size={12}
                    strokeWidth={2.5}
                    data-spin={checking[selected] ? '' : undefined}
                  />
                  {checking[selected] ? 'Checking…' : 'Check again'}
                </span>
              </Button>
            )}
          </span>
        </div>

        {!project ? (
          <div className="keys-no-folder">Add a project to see what it&apos;s connected to.</div>
        ) : !project.repoFolder || current?.error ? (
          <div className="keys-no-folder">
            {current?.error ?? 'This project has no folder on this Mac.'}
          </div>
        ) : !record ? (
          <div className="keys-no-folder">Looking through the code…</div>
        ) : (
          <div className="keys-main-body">
            <section className="infra-tags">
              <TagRow projectId={project.id} record={record} field="business" />
              <BriefRows key={project.id} projectId={project.id} record={record} />
              <TagRow projectId={project.id} record={record} field="appKinds" />
            </section>
            <section className="infra-tags">
              <h3 className="keys-section-head">What should it do? For example: let people sign in, or take payments.</h3>
              {INFRA_KINDS.filter((k) => k.ask).map((kind) => (
                <AskRow
                  key={kind.id}
                  projectId={project.id}
                  record={record}
                  kind={kind}
                  onSetUp={() => setSheet({ kindId: kind.id })}
                />
              ))}
            </section>
            {todo > 0 && (
              <section className="infra-needs">
                <h3 className="keys-section-head" data-tone="red">
                  {todo} {todo === 1 ? 'thing' : 'things'} to {broken.length ? 'fix' : 'connect'}
                </h3>
                {broken.map(({ kind, entry, problem }, i) => {
                  const fix = fixing[`${project.id}:${kind.id}:${entry.provider}`]
                  return (
                    <div key={kind.id} className="infra-need" data-kind-todo={kind.id}>
                      <span className="infra-need-text">
                        <b>{kind.label}</b>
                        <span>
                          {fix
                            ? `The agent couldn't start: ${fix}`
                            : `${entryLabel(kind.id, entry)} is connected - ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`}
                        </span>
                      </span>
                      {fixButton(kind, entry, problem, fix, i === 0)}
                    </div>
                  )
                })}
                {needs.map((kind) => {
                  const usual = usualProvider(kind, all, project.id)
                  const inProgress = setupLine(kind)
                  if (inProgress) {
                    return (
                      <div
                        key={kind.id}
                        className="infra-need"
                        data-setup=""
                        data-kind-todo={kind.id}
                      >
                        <b className="infra-need-text">{kind.label}</b>
                        {inProgress}
                      </div>
                    )
                  }
                  return (
                    <div key={kind.id} className="infra-need" data-kind-todo={kind.id}>
                      <span className="infra-need-text">
                        <b>{kind.label}</b>
                        <span>{kind.missing}</span>
                      </span>
                      <Button
                        variant="ghost"
                        onClick={() => void window.api.infra.skip(project.id, kind.id, true)}
                      >
                        Not needed
                      </Button>
                      {usual ? (
                        <Button
                          variant={kind.id === leadNeed ? 'primary' : 'ghost'}
                          onClick={() => startSetup(kind, usual.provider)}
                        >
                          <span className="infra-btn-inner">
                            <ProviderIcon provider={usual.provider} />
                            Add {usual.provider.label}
                          </span>
                        </Button>
                      ) : (
                        <Button
                          variant={kind.id === leadNeed ? 'primary' : 'ghost'}
                          onClick={() => setSheet({ kindId: kind.id })}
                        >
                          Add
                        </Button>
                      )}
                    </div>
                  )
                })}
              </section>
            )}

            {record.environments?.length ? (
              <EnvironmentsSection environments={record.environments} />
            ) : null}

            {INFRA_GROUPS.map((group) => {
              const kinds = INFRA_KINDS.filter(
                (k) =>
                  k.group === group &&
                  (kindApplies(k, record.appKinds) ||
                    (record.want ?? []).includes(k.id) ||
                    (record.services[k.id] ?? []).length > 0)
              )
              if (kinds.length === 0) return null
              return (
                <section key={group} className="keys-section">
                  <h3 className="keys-section-head">{INFRA_GROUP_LABELS[group]}</h3>
                  {kinds.map((kind) => {
                    const entries = record.services[kind.id] ?? []
                    const skipped = record.skip.includes(kind.id)
                    const open = openRow === kind.id
                    return (
                      <div
                        key={kind.id}
                        className="infra-row"
                        data-open={open || undefined}
                        data-kind-row={kind.id}
                      >
                        <Button
                          variant="bare"
                          className="infra-row-head"
                          onClick={() => setOpenRow(open ? null : kind.id)}
                          aria-expanded={open}
                        >
                          <span className="infra-kind">
                            {kind.label}
                            {kind.optional && <span className="infra-extra">Extra</span>}
                          </span>
                          <span className="infra-chips">
                            {entries.length === 0 ? (
                              <span className="infra-empty">
                                {record.setups?.[kind.id]
                                  ? 'An agent is adding it'
                                  : skipped
                                    ? 'Not needed'
                                    : 'Nothing yet'}
                              </span>
                            ) : (
                              entries.map((e) => {
                                const provider = infraProvider(kind.id, e.provider)
                                const dot = keyDot(provider, e, project.id, book)
                                return (
                                  <span key={e.provider} className="infra-chip">
                                    <ProviderIcon provider={provider} />
                                    {entryLabel(kind.id, e)}
                                    {dot && (
                                      <span
                                        className="keys-status-dot infra-dot"
                                        data-dot={dot}
                                        title={keyProblem(provider, e, project.id, book)}
                                      />
                                    )}
                                  </span>
                                )
                              })
                            )}
                            {added[`${project.id}:${kind.id}`] && (
                              <span className="infra-added">
                                <Check size={11} strokeWidth={3} /> Added
                              </span>
                            )}
                          </span>
                        </Button>
                        <Button
                          variant="bare"
                          className="infra-row-add"
                          onClick={() => setSheet({ kindId: kind.id })}
                          title={`Add ${kind.label.toLowerCase()}`}
                        >
                          <Plus size={12} strokeWidth={2.5} /> Add
                        </Button>
                        {!needs.includes(kind) && setupLine(kind) && (
                          <div className="infra-row-setup">{setupLine(kind)}</div>
                        )}
                        {kind.id === 'hosting' && (
                          <PublishSite
                            key={project.id}
                            project={project}
                            hostedElsewhere={entries.length > 0}
                            onOpenAgent={onOpenAgent}
                          />
                        )}
                        {open && (
                          <div className="infra-detail">
                            {entries.map((e) => {
                              const provider = infraProvider(kind.id, e.provider)
                              const dot = keyDot(provider, e, project.id, book)
                              const page = e.foundIn?.startsWith('https://') ? e.foundIn : undefined
                              const [file] = page ? [] : (e.foundIn ?? '').split(':')
                              const fixId = `${project.id}:${kind.id}:${e.provider}`
                              const fix = fixing[fixId]
                              const broken = dot === 'none' || dot === 'failed'
                              const problem = keyProblem(provider, e, project.id, book)
                              return (
                                <dl key={e.provider} className="infra-facts">
                                  <dt>{entryLabel(kind.id, e)}</dt>
                                  <dd>
                                    {page
                                      ? `Seen on the live site ${page}`
                                      : e.foundIn
                                        ? `Found in ${e.foundIn}`
                                        : 'Added by hand'}
                                    {dot &&
                                      ` · ${e.key ?? provider?.keyProvider} - ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`}
                                  </dd>
                                  {fix && (
                                    <dd className="keys-sheet-err">
                                      The agent couldn&apos;t start: {fix}
                                    </dd>
                                  )}
                                  <dd className="infra-actions">
                                    {broken && fixButton(kind, e, problem, fix, true)}
                                    {file && (
                                      <Button
                                        variant="ghost"
                                        onClick={() =>
                                          void window.api.openPath(`${project.repoFolder}/${file}`)
                                        }
                                      >
                                        Open file
                                      </Button>
                                    )}
                                    {page && (
                                      <Button
                                        variant="ghost"
                                        onClick={() => void window.api.openExternal(page)}
                                      >
                                        Open site
                                      </Button>
                                    )}
                                    {e.manual && (
                                      <Button
                                        variant="ghost"
                                        onClick={() =>
                                          void window.api.infra.remove(
                                            project.id,
                                            kind.id,
                                            e.provider
                                          )
                                        }
                                      >
                                        Remove
                                      </Button>
                                    )}
                                  </dd>
                                </dl>
                              )
                            })}
                            {skipped && (
                              <Button
                                variant="ghost"
                                onClick={() =>
                                  void window.api.infra.skip(project.id, kind.id, false)
                                }
                              >
                                Needed after all
                              </Button>
                            )}
                            <p className="infra-told">
                              Agents read this list in {INFRA_RECORD_PATH}.
                            </p>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </section>
              )
            })}

            <div className="infra-legend">
              {(['works', 'unchecked', 'none'] as KeyDot[]).map((d) => (
                <span key={d}>
                  <span className="keys-status-dot infra-dot" data-dot={d} />
                  {DOT_TEXT[d]}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {scored && !searching && (
        <InfraScorecard
          projectId={scored.id}
          record={record}
          all={all}
          book={book}
          onJump={jumpTo}
        />
      )}

      {addKey?.addKey && (
        <KeyAddSheet
          scope={addKey.projectId ?? 'global'}
          scopes={['global', ...projects.map((p) => p.id)]}
          projects={projects}
          seedName={addKey.addKey.name}
          seedProvider={addKey.addKey.provider}
          onClose={() => setAddKey(null)}
        />
      )}

      {sheet && sheetKind && project && (
        <Modal
          label={`Add ${sheetKind.label.toLowerCase()}`}
          onClose={() => setSheet(null)}
          backdropClassName="keys-sheet-backdrop"
          className="keys-sheet infra-sheet"
        >
          <div className="infra-sheet-top">
            <span className="keys-sheet-title">
              Add {sheetKind.label.toLowerCase()} to {project.name}
            </span>
            <Button variant="icon" onClick={() => setSheet(null)} aria-label="Close">
              <X size={13} strokeWidth={2.5} />
            </Button>
          </div>

          {sheet.starting ? (
            <p className="keys-sheet-intro infra-btn-inner">
              <Loader2 size={13} strokeWidth={2.5} data-spin="" />
              Starting an agent to add {sheet.starting}…
            </p>
          ) : sheet.error ? (
            <>
              <p className="keys-sheet-err">The agent couldn&apos;t start: {sheet.error}</p>
              <div className="keys-sheet-actions">
                <Button variant="ghost" onClick={() => setSheet(null)}>
                  Close
                </Button>
                <Button variant="ghost" onClick={() => setSheet({ kindId: sheet.kindId })}>
                  Pick another
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    const retry = sheet.provider
                      ? infraProvider(sheet.kindId, sheet.provider)
                      : undefined
                    if (retry) startSetup(sheetKind, retry)
                    else setSheet({ kindId: sheet.kindId })
                  }}
                >
                  Try again
                </Button>
              </div>
            </>
          ) : (
            <>
              <SheetChoices
                kind={sheetKind}
                all={all}
                projectId={project.id}
                projects={projects}
                onPick={(p) => startSetup(sheetKind, p)}
              />
              {sheet.other ? (
                <div className="infra-other">
                  <input
                    autoFocus
                    list="infra-other-list"
                    value={otherName}
                    placeholder="Its name"
                    onChange={(e) => setOtherName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveOther()
                    }}
                  />
                  <datalist id="infra-other-list">
                    {sheetKind.providers.map((p) => (
                      <option key={p.id} value={p.label} />
                    ))}
                  </datalist>
                  <Button variant="primary" onClick={saveOther} disabled={!otherName.trim()}>
                    Save
                  </Button>
                </div>
              ) : (
                <Button
                  variant="bare"
                  className="infra-link"
                  onClick={() => setSheet({ ...sheet, other: true })}
                >
                  I already use something else
                </Button>
              )}
              <ol className="infra-how">
                <li>
                  An agent adds it to the code in this project&apos;s folder. You approve each
                  change.
                </li>
                <li>
                  Anything only you can do, like making an account, the agent asks for one step at a
                  time.
                </li>
                <li>Keys go in Keys - saved once, checked for you.</li>
              </ol>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

const ACCOUNT_LABELS: Record<string, string> = { supabase: 'Supabase', stripe: 'Stripe' }

const TAG_ROWS: Record<
  TagField,
  { title: string; options: { id: string; label: string; hint?: string }[] }
> = {
  business: {
    title: 'What it is',
    options: BUSINESS_TYPES.map((id) => ({ id, ...BUSINESS_LABELS[id] }))
  },
  appKinds: {
    title: 'Runs on',
    options: Object.entries(APP_KIND_LABELS).map(([id, label]) => ({ id, label }))
  }
}

function TagRow({
  projectId,
  record,
  field
}: {
  projectId: string
  record: InfraRecord
  field: TagField
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const { title, options } = TAG_ROWS[field]
  const chosen: string[] = record[field] ?? []
  const byHand = record.pinned?.includes(field) ?? false
  const save = (values: string[] | null): void => {
    setFailed(false)
    void window.api.infra
      .setTags(projectId, field, values)
      .then((next) => setFailed(!next.record))
      .catch(() => setFailed(true))
  }
  const toggle = (id: string): void =>
    save(chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id])
  return (
    <div className="infra-tag-row" data-tag-field={field}>
      <span className="infra-kind">{title}</span>
      <span className="infra-chips">
        {open ? (
          options.map((o) => (
            <Button
              key={o.id}
              variant="bare"
              className="infra-chip"
              data-on={chosen.includes(o.id) ? '' : undefined}
              aria-pressed={chosen.includes(o.id)}
              title={o.hint}
              onClick={() => toggle(o.id)}
            >
              {chosen.includes(o.id) && <Check size={11} strokeWidth={2.5} />}
              {o.label}
            </Button>
          ))
        ) : chosen.length ? (
          options
            .filter((o) => chosen.includes(o.id))
            .map((o) => (
              <span key={o.id} className="infra-chip" title={o.hint}>
                {o.label}
              </span>
            ))
        ) : (
          <span className="infra-empty">Not set yet</span>
        )}
        {failed && <span className="infra-empty">That did not save - try again.</span>}
      </span>
      <span className="infra-tag-side">
        {open && byHand && (
          <Button variant="bare" className="infra-link" onClick={() => save(null)}>
            Use what the code says
          </Button>
        )}
        {!open && <span className="infra-extra">{byHand ? 'Set by you' : 'From your code'}</span>}
        <Button variant="bare" className="infra-link" onClick={() => setOpen((v) => !v)}>
          {open ? 'Done' : 'Change'}
        </Button>
      </span>
    </div>
  )
}

function AskRow({
  projectId,
  record,
  kind,
  onSetUp
}: {
  projectId: string
  record: InfraRecord
  kind: InfraKind
  onSetUp: () => void
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  const entries = record.services[kind.id] ?? []
  const yes = kindWanted(kind, record)
  const answered = record.skip.includes(kind.id) || (record.want ?? []).includes(kind.id)
  const answer = (want: boolean): void => {
    setFailed(false)
    void (
      want
        ? window.api.infra.want(projectId, kind.id)
        : window.api.infra.skip(projectId, kind.id, true)
    )
      .then((next) => setFailed(!next.record))
      .catch(() => setFailed(true))
  }
  return (
    <div className="infra-tag-row" data-ask={kind.id}>
      <span className="infra-kind">{kind.ask}</span>
      <span className="infra-chips">
        {entries.length > 0 ? (
          <span className="infra-chip" data-on="">
            <Check size={11} strokeWidth={2.5} />
            Yes - {entries.map((e) => entryLabel(kind.id, e)).join(', ')}
          </span>
        ) : (
          [true, false].map((want) => (
            <Button
              key={String(want)}
              variant="bare"
              className="infra-chip"
              data-on={yes === want ? '' : undefined}
              aria-pressed={yes === want}
              onClick={() => answer(want)}
            >
              {want ? 'Yes' : 'No'}
            </Button>
          ))
        )}
        {failed && <span className="infra-empty">That did not save - try again.</span>}
      </span>
      <span className="infra-tag-side">
        <span className="infra-extra">
          {entries.length > 0
            ? 'From your code'
            : answered
              ? 'Set by you'
              : suggestedBy(kind, record).length
                ? `Usual for: ${suggestedBy(kind, record)
                    .map((b) => BUSINESS_LABELS[b].label.toLowerCase())
                    .join(', ')}`
                : 'Our guess'}
        </span>
        {entries.length === 0 &&
          yes &&
          (record.setups?.[kind.id] ? (
            <span className="infra-extra">An agent is adding it</span>
          ) : (
            <Button variant="bare" className="infra-link" onClick={onSetUp}>
              Set it up
            </Button>
          ))}
      </span>
    </div>
  )
}

function EnvironmentsSection({ environments }: { environments: InfraEnvironment[] }): JSX.Element {
  return (
    <section className="keys-section">
      <h3 className="keys-section-head">Environments</h3>
      {environments.map((env) => (
        <div key={env.name} className="infra-row" data-env-row={env.name}>
          <div className="infra-row-head infra-env-head">
            <span className="infra-kind">{ENV_LABELS[env.name] ?? env.name}</span>
            <span className="infra-chips">
              {env.accounts.map((a) => (
                <span
                  key={`${a.provider}:${a.id}`}
                  className="infra-chip"
                  title={`${ACCOUNT_LABELS[a.provider]} ${a.id} - ${a.foundIn}`}
                >
                  <KeyProviderIcon provider={a.provider} size={14} />
                  {ACCOUNT_LABELS[a.provider]}
                </span>
              ))}
              {env.urls.map((url) => (
                <Button
                  key={url}
                  variant="bare"
                  className="infra-chip infra-env-url"
                  onClick={() => void window.api.openExternal(url)}
                  title={`Open ${url}`}
                >
                  {new URL(url).host}
                </Button>
              ))}
              {env.accounts.length === 0 && env.urls.length === 0 && (
                <span className="infra-empty">Named in {env.foundIn[0]}</span>
              )}
            </span>
          </div>
        </div>
      ))}
    </section>
  )
}

function SheetChoices({
  kind,
  all,
  projectId,
  projects,
  onPick
}: {
  kind: InfraKind
  all: ProjectInfra[]
  projectId: string
  projects: MightyProject[]
  onPick: (provider: InfraProvider) => void
}): JSX.Element {
  const usual = usualProvider(kind, all, projectId)
  const mine = all.find((p) => p.projectId === projectId)?.record
  const appKinds = mine?.appKinds ?? []
  const have = new Set((mine?.services[kind.id] ?? []).map((e) => e.provider))
  const ranked = [
    ...(usual ? [usual.provider] : []),
    ...kind.providers.filter((p) => p.id !== usual?.provider.id && !p.fallback)
  ]
    .filter((p) => !have.has(p.id) && providerFits(p, appKinds))
    .slice(0, 4)
  return (
    <div className="infra-choices">
      {ranked.map((p, i) => (
        <div key={p.id} className="infra-choice">
          <ProviderIcon provider={p} size={18} />
          <span className="infra-choice-text">
            <b>
              {p.label}
              {i === 0 && usual?.usedIn.length ? (
                <span className="infra-tag">Your usual</span>
              ) : null}
              {p.offer && (
                <span className="infra-tag" data-tone="offer">
                  Partner offer
                </span>
              )}
            </b>
            {i === 0 && usual?.usedIn.length ? (
              <span>Used in {namesList(usual.usedIn, projects)}</span>
            ) : null}
            {p.offer && <span>{p.offer}</span>}
          </span>
          <Button variant={i === 0 ? 'primary' : 'ghost'} onClick={() => onPick(p)}>
            Set it up
          </Button>
        </div>
      ))}
    </div>
  )
}

function SearchHitRow({
  hit,
  onPick,
  onAddKey
}: {
  hit: InfraHit
  onPick: (hit: InfraHit) => void
  onAddKey: (hit: InfraHit) => void
}): JSX.Element {
  const [checking, setChecking] = useState(false)
  const keyId = hit.keyId
  const text = (
    <>
      <b>{hit.title}</b>
      <span>{hit.detail}</span>
    </>
  )
  return (
    <div className="infra-search-hit">
      {hit.projectId ? (
        <Button variant="bare" className="infra-search-text" onClick={() => onPick(hit)}>
          {text}
        </Button>
      ) : (
        <span className="infra-search-text">{text}</span>
      )}
      {hit.shape && <code className="infra-search-shape">{hit.shape}</code>}
      {keyId && (
        <>
          <Button
            variant="quiet"
            disabled={checking}
            title={checking ? 'Testing this key…' : 'Test this key'}
            aria-label={checking ? 'Testing this key' : 'Test this key'}
            onClick={() => {
              setChecking(true)
              void window.api.keys.probe(keyId).finally(() => setChecking(false))
            }}
          >
            {checking ? (
              <Loader2 size={ICON_SIZE} data-spin="" />
            ) : (
              <ShieldCheck size={ICON_SIZE} />
            )}
          </Button>
          <CopyButton
            label="Copy key"
            failedLabel="Not saved on this Mac"
            copy={() => window.api.keys.copy(keyId)}
          />
        </>
      )}
      {hit.addKey && (
        <Button variant="primary" onClick={() => onAddKey(hit)}>
          <span className="infra-btn-inner">
            <Plus size={12} strokeWidth={2.5} />
            Add key
          </span>
        </Button>
      )}
    </div>
  )
}

function InfraSearchResults({
  hits,
  projects,
  onPick,
  onAddKey
}: {
  hits: InfraHit[]
  projects: MightyProject[]
  onPick: (hit: InfraHit) => void
  onAddKey: (hit: InfraHit) => void
}): JSX.Element {
  if (hits.length === 0) {
    return <div className="keys-no-folder">Nothing matches in any project.</div>
  }
  const groups = [...new Set(hits.map((h) => h.projectId))]
  return (
    <div className="keys-main-body infra-search-results">
      {groups.map((projectId) => {
        const project = projects.find((p) => p.id === projectId)
        return (
          <section key={projectId ?? 'global'} className="keys-section">
            <h3 className="keys-section-head infra-search-head">
              {project && (
                <ProjectAvatar
                  icon={project.icon}
                  imagePath={project.imagePath}
                  size={14}
                  className="rounded-sm"
                />
              )}
              {project?.name ?? 'All projects'}
            </h3>
            {hits
              .filter((h) => h.projectId === projectId)
              .map((h) => (
                <SearchHitRow key={h.id} hit={h} onPick={onPick} onAddKey={onAddKey} />
              ))}
          </section>
        )
      })}
    </div>
  )
}
