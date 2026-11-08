import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import {
  AlertTriangle,
  Check,
  Copy,
  EyeOff,
  Eye,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2
} from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import type { MightyProject } from '../../../shared/types'
import {
  KEY_CATEGORY_LABELS,
  daysUntil,
  type KeyRecord,
  type KeyRoute,
  type KeyScope,
  type ProjectKeyMap
} from '../../../shared/keys'
import { KEY_PROVIDERS, keyProvider } from '../../../shared/key-providers'
import { duplicateKeys } from '../../../shared/key-owner'
import { KeyProviderIcon } from './KeyProviderIcon'
import { ConfirmDialog } from './ConfirmDialog'
import { Button } from './Button'
import { KeyAddSheet } from './KeyAddSheet'
import { ProjectAvatar } from './ProjectIcon'
import { Tooltip, useTooltip } from './Tooltip'
import './KeysPanel.css'

const L = CONFIG.UI_LABELS

const SOURCE_LABEL: Record<KeyRecord['source'], string> = {
  keychain: 'Keychain',
  'env-file': 'Env file',
  'cli-login': 'CLI login',
  'mcp-config': 'MCP config',
  cloud: 'Cloud',
  manual: 'Keychain'
}

const STATUS_COLOR: Record<KeyRecord['status'], string> = {
  ready: 'var(--green)',
  unverified: 'var(--text-muted-light)',
  broken: 'var(--red)',
  expiring: 'var(--amber)',
  expired: 'var(--red)',
  missing: 'var(--red)'
}

function routeChips(routes: KeyRoute[]): JSX.Element | null {
  if (routes.length === 0) return null
  return (
    <span className="keys-routes">
      {routes.map((r) => (
        <span key={r} className="keys-route-chip">
          {r}
        </span>
      ))}
    </span>
  )
}

function providerLabel(providerId: string): string {
  return keyProvider(providerId)?.label ?? providerId
}

function RowSkeleton(): JSX.Element {
  return (
    <div className="keys-row keys-row-skeleton">
      <div className="skeleton" style={{ width: 18, height: 18, borderRadius: 999 }} />
      <div className="skeleton" style={{ width: 140, height: 12 }} />
      <div className="skeleton" style={{ width: 60, height: 12, marginLeft: 'auto' }} />
    </div>
  )
}

function KeysSkeleton(): JSX.Element {
  return (
    <div className="keys-main-body">
      <div className="keys-section">
        <div className="skeleton" style={{ width: 90, height: 11, marginBottom: 10 }} />
        <RowSkeleton />
        <RowSkeleton />
      </div>
      <div className="keys-section">
        <div className="skeleton" style={{ width: 70, height: 11, marginBottom: 10 }} />
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    </div>
  )
}

function evidencePath(evidence: string, repoFolder?: string): string {
  const bare = evidence.replace(/^(file|dir):/, '').replace(/:\d+$/, '')
  if (bare.startsWith('/') || !repoFolder) return bare
  return `${repoFolder}/${bare}`
}

const RESCAN_AFTER_MS = 10 * 60_000

function scopeLabel(scope: KeyScope, projects: MightyProject[]): string {
  if (scope === 'global') return L.CODE_KEYS_EVERYWHERE
  return projects.find((p) => p.id === scope)?.name ?? scope
}

export function KeysPanel({ variant = 'flyout' }: { variant?: 'flyout' | 'tab' }): JSX.Element {
  const [projects, setProjects] = useState<MightyProject[]>([])
  const [maps, setMaps] = useState<ProjectKeyMap[] | null>(null)
  const [scope, setScope] = useState<KeyScope>('global')
  const [scanning, setScanning] = useState<Record<string, boolean>>({})
  const [showHidden, setShowHidden] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addSeed, setAddSeed] = useState<{ name: string; provider?: string } | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void window.api.mighty
      .listProjects()
      .then(setProjects)
      .catch(() => setProjects([]))
  }, [])

  const scan = useCallback((target: KeyScope) => {
    setScanning((prev) => ({ ...prev, [target]: true }))
    void window.api.keys
      .scan(target)
      .catch(() => null)
      .finally(() => setScanning((prev) => ({ ...prev, [target]: false })))
  }, [])

  useEffect(() => {
    void window.api.keys.list().then((all) => {
      setMaps(all)
      const last = all.find((m) => m.projectId === scope)?.scannedAt
      if (!last || Date.now() - Date.parse(last) > RESCAN_AFTER_MS) scan(scope)
    })
    return window.api.keys.onChanged(setMaps)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const scopes: KeyScope[] = useMemo(
    () => ['global', ...projects.filter((p) => !p.archived).map((p) => p.id)],
    [projects]
  )

  const missingCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const m of maps ?? []) out[m.projectId] = m.missing.length
    return out
  }, [maps])

  const map = maps?.find((m) => m.projectId === scope) ?? null
  const q = query.trim().toLowerCase()
  const hit = (name: string, provider: string): boolean =>
    !q || name.toLowerCase().includes(q) || providerLabel(provider).toLowerCase().includes(q)
  const readyKeys = (map?.keys ?? []).filter((k) => !k.hidden && hit(k.name, k.provider))
  const hiddenKeys = (map?.keys ?? []).filter((k) => k.hidden && hit(k.name, k.provider))
  const twins = new Map<string, string>()
  for (const [a, b] of duplicateKeys(map?.keys ?? [])) {
    if (!twins.has(a.id)) twins.set(a.id, b.name)
    if (!twins.has(b.id)) twins.set(b.id, a.name)
  }
  const missing = (map?.missing ?? []).filter((n) => hit(n.name, n.provider))
  const missingNames = new Set((map?.missing ?? []).map((n) => n.name))
  const haveNames = new Set((map?.keys ?? []).map((k) => k.name))
  const optional = (map?.needs ?? []).filter(
    (n) =>
      !missingNames.has(n.name) &&
      !haveNames.has(n.name) &&
      (n.optional === true || n.satisfiedByCli === true) &&
      hit(n.name, n.provider)
  )
  const cloud = (map?.cloud ?? [])
    .map((b) => ({ ...b, names: b.names.filter((n) => hit(n, b.host)) }))
    .filter((b) => b.names.length > 0)
  const expiringCount = readyKeys.filter((k) => k.status === 'expiring' || k.status === 'expired')
    .length

  const openAdd = (seed?: { name: string; provider?: string }): void => {
    setAddSeed(seed ?? null)
    setAddOpen(true)
  }

  const copy = (id: string): void => {
    void window.api.keys.copy(id).then((ok) => {
      if (!ok) return
      setCopiedId(id)
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500)
    })
  }

  const check = (id: string): void => {
    setCheckingId(id)
    void window.api.keys.probe(id).finally(() => setCheckingId((cur) => (cur === id ? null : cur)))
  }

  const scopeProject = projects.find((p) => p.id === scope)
  const removeTarget = (map?.keys ?? []).find((k) => k.id === removingId) ?? null

  return (
    <div className="keys-panel" data-variant={variant}>
      <div className="keys-rail">
        <Button
          variant="bare"
          className="keys-rail-row"
          data-active={scope === 'global' || undefined}
          onClick={() => setScope('global')}
        >
          <span className="keys-rail-name">{L.CODE_KEYS_EVERYWHERE}</span>
          {missingCounts.global > 0 && <span className="keys-rail-missing">{missingCounts.global}</span>}
        </Button>
        {projects
          .filter((p) => !p.archived)
          .map((p) => (
            <Button
              variant="bare"
              key={p.id}
              className="keys-rail-row"
              data-active={scope === p.id || undefined}
              onClick={() => setScope(p.id)}
            >
              <ProjectAvatar icon={p.icon} imagePath={p.imagePath} size={16} className="rounded-sm" />
              <span className="keys-rail-name">{p.name}</span>
              {(missingCounts[p.id] ?? 0) > 0 && (
                <span className="keys-rail-missing">{missingCounts[p.id]}</span>
              )}
            </Button>
          ))}
      </div>

      <div className="keys-main">
        <div className="keys-main-head">
          {scopeProject && (
            <ProjectAvatar
              icon={scopeProject.icon}
              imagePath={scopeProject.imagePath}
              size={20}
              className="rounded-sm"
            />
          )}
          <span className="keys-scope-name">{scopeLabel(scope, projects)}</span>
          {map && (
            <span className="keys-counts">
              <span className="keys-count" data-tone="green">
                {readyKeys.length} {L.CODE_KEYS_READY_COUNT}
              </span>
              <span className="keys-count" data-tone="red">
                {missing.length} {L.CODE_KEYS_MISSING_COUNT}
              </span>
              {expiringCount > 0 && (
                <span className="keys-count" data-tone="amber">
                  {expiringCount} {L.CODE_KEYS_EXPIRING_COUNT}
                </span>
              )}
            </span>
          )}
          <span className="keys-head-actions">
            <input
              className="keys-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={L.CODE_KEYS_SEARCH}
              aria-label={L.CODE_KEYS_SEARCH}
            />
            <Button
              variant="secondary"
              onClick={() => scan(scope)}
              disabled={scanning[scope] === true}
            >
              <RefreshCw size={12} strokeWidth={2.5} className={scanning[scope] ? 'animate-spin' : undefined} />
              {scanning[scope] ? L.CODE_KEYS_SCANNING : L.CODE_KEYS_SCAN}
            </Button>
            <Button variant="primary" className="keys-add-btn" onClick={() => openAdd()}>
              <Plus size={13} strokeWidth={2.5} />
              {L.CODE_KEYS_ADD}
            </Button>
          </span>
        </div>

        {map?.errors.map((e) => (
          <div key={e} className="keys-error-line">
            <AlertTriangle size={12} strokeWidth={2.5} />
            {e}
          </div>
        ))}

        {!map ? (
          <KeysSkeleton />
        ) : scope !== 'global' && !map.repoFolder ? (
          <div className="keys-no-folder">{L.CODE_KEYS_NO_FOLDER}</div>
        ) : (
          <div className="keys-main-body">
            <section className="keys-section">
              <h3 className="keys-section-head" data-tone="red">
                {L.CODE_KEYS_MISSING_HEAD}
              </h3>
              {missing.length === 0 ? (
                <div className="keys-empty-good">
                  <Check size={13} strokeWidth={2.5} />
                  {L.CODE_KEYS_MISSING_EMPTY}
                </div>
              ) : (
                missing.map((need) => (
                  <div key={need.name} className="keys-row keys-row-missing">
                    <KeyProviderIcon provider={need.provider} size={16} />
                    <span className="keys-row-main">
                      <span className="keys-row-name">{need.name}</span>
                      {routeChips(need.routes)}
                      {need.evidence[0] && (
                        <Button
                          variant="bare"
                          className="keys-evidence"
                          onClick={() => void window.api.openPath(evidencePath(need.evidence[0], map.repoFolder))}
                          title={L.CODE_KEYS_EVIDENCE_REVEAL}
                        >
                          {need.evidence[0]}
                        </Button>
                      )}
                    </span>
                    <Button
                      variant="bare"
                      className="keys-row-add"
                      onClick={() => openAdd({ name: need.name, provider: need.provider })}
                    >
                      {L.CODE_KEYS_ROW_ADD}
                    </Button>
                  </div>
                ))
              )}
            </section>

            {optional.length > 0 && (
              <section className="keys-section">
                <h3 className="keys-section-head">{L.CODE_KEYS_OPTIONAL_HEAD}</h3>
                <div className="keys-section-note">{L.CODE_KEYS_OPTIONAL_NOTE}</div>
                {optional.map((need) => (
                  <div key={need.name} className="keys-row">
                    <KeyProviderIcon provider={need.provider} size={16} />
                    <span className="keys-row-main">
                      <span className="keys-row-name">{need.name}</span>
                      {routeChips(need.routes)}
                      {need.satisfiedByCli ? (
                        <span className="keys-row-note">{L.CODE_KEYS_OPTIONAL_CLI}</span>
                      ) : (
                        need.evidence[0] && (
                          <Button
                            variant="bare"
                            className="keys-evidence"
                            onClick={() =>
                              void window.api.openPath(evidencePath(need.evidence[0], map.repoFolder))
                            }
                            title={L.CODE_KEYS_EVIDENCE_REVEAL}
                          >
                            {need.evidence[0]}
                          </Button>
                        )
                      )}
                    </span>
                    <Button
                      variant="bare"
                      className="keys-row-add"
                      onClick={() => openAdd({ name: need.name, provider: need.provider })}
                    >
                      {L.CODE_KEYS_ROW_ADD}
                    </Button>
                  </div>
                ))}
              </section>
            )}

            <section className="keys-section">
              <h3 className="keys-section-head">{L.CODE_KEYS_READY_HEAD}</h3>
              {readyKeys.map((k) => (
                <KeyRow
                  key={k.id}
                  record={k}
                  projects={projects}
                  twin={twins.get(k.id)}
                  editing={editingId === k.id}
                  copied={copiedId === k.id}
                  checking={checkingId === k.id}
                  onEdit={() => setEditingId(k.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onCopy={() => copy(k.id)}
                  onCheck={() => check(k.id)}
                  onHide={() => void window.api.keys.update(k.id, { hidden: true })}
                  onRemove={() => setRemovingId(k.id)}
                />
              ))}
            </section>

            {cloud.length > 0 && (
              <section className="keys-section">
                <h3 className="keys-section-head">{L.CODE_KEYS_CLOUD_HEAD}</h3>
                <p className="keys-cloud-note">{L.CODE_KEYS_CLOUD_NOTE}</p>
                {cloud.map((bucket) => (
                  <div key={`${bucket.host}:${bucket.target}`} className="keys-cloud-card">
                    <KeyProviderIcon provider={bucket.host} size={16} />
                    <span className="keys-cloud-target" title={bucket.target}>
                      {bucket.label ?? bucket.target}
                    </span>
                    <span className="keys-cloud-names">
                      {bucket.names.map((n) => (
                        <span key={n} className="keys-cloud-chip">
                          {n}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {hiddenKeys.length > 0 && (
              <section className="keys-section">
                <Button
                  variant="bare"
                  className="keys-hidden-toggle"
                  onClick={() => setShowHidden((v) => !v)}
                >
                  {hiddenKeys.length} {hiddenKeys.length === 1 ? L.CODE_KEYS_HIDDEN_ONE : L.CODE_KEYS_HIDDEN_MANY}
                </Button>
                {showHidden &&
                  hiddenKeys.map((k) => (
                    <KeyRow
                      key={k.id}
                      record={k}
                      projects={projects}
                      editing={editingId === k.id}
                      copied={copiedId === k.id}
                      checking={checkingId === k.id}
                      onEdit={() => setEditingId(k.id)}
                      onCancelEdit={() => setEditingId(null)}
                      onCopy={() => copy(k.id)}
                      onCheck={() => check(k.id)}
                      onHide={() => void window.api.keys.update(k.id, { hidden: false })}
                      unhide
                      onRemove={() => setRemovingId(k.id)}
                    />
                  ))}
              </section>
            )}
          </div>
        )}
      </div>

      {removeTarget && (
        <ConfirmDialog
          title={L.CODE_KEYS_REMOVE_TITLE}
          confirmLabel={L.CODE_KEYS_REMOVE_DELETE}
          cancelLabel={L.CODE_KEYS_REMOVE_FORGET}
          onCancel={() => {
            void window.api.keys.remove(removeTarget.id, false)
            setRemovingId(null)
          }}
          onConfirm={() => {
            void window.api.keys.remove(removeTarget.id, true)
            setRemovingId(null)
          }}
        />
      )}

      {addOpen && (
        <KeyAddSheet
          scope={scope}
          scopes={scopes}
          projects={projects}
          seedName={addSeed?.name}
          seedProvider={addSeed?.provider}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  )
}

function KeyRow({
  record,
  projects,
  twin,
  editing,
  copied,
  checking,
  onEdit,
  onCancelEdit,
  onCopy,
  onCheck,
  onHide,
  onRemove,
  unhide
}: {
  record: KeyRecord
  projects: MightyProject[]
  twin?: string
  editing: boolean
  copied: boolean
  checking: boolean
  onEdit: () => void
  onCancelEdit: () => void
  onCopy: () => void
  onCheck: () => void
  onHide: () => void
  onRemove: () => void
  unhide?: boolean
}): JSX.Element {
  const expiry = daysUntil(record.expiresAt)
  const { tip, setTip, hoverProps } = useTooltip()
  return (
    <div className="keys-row">
      <span className="keys-status-dot" style={{ background: STATUS_COLOR[record.status] }} />
      <KeyProviderIcon provider={record.provider} size={16} />
      <span className="keys-row-main">
        <span className="keys-row-name">{record.name}</span>
        <span className="keys-row-provider">{providerLabel(record.provider)}</span>
        {routeChips(record.routes)}
        <span className="keys-source-badge" title={record.sourcePath}>
          {SOURCE_LABEL[record.source]}
        </span>
        {record.length > 0 && (
          <span className="keys-shape">
            {record.shape} ({record.length})
          </span>
        )}
        {record.status === 'expired' ? (
          <span className="keys-expiry" data-tone="red">
            {L.CODE_KEYS_EXPIRED}
          </span>
        ) : expiry !== null && expiry <= 14 ? (
          <span className="keys-expiry" data-tone="amber">
            in {expiry} days
          </span>
        ) : null}
        {record.projects?.length ? (
          <span className="keys-source-badge">
            {L.CODE_KEYS_USED_BY} {record.projects.map((id) => scopeLabel(id, projects)).join(', ')}
          </span>
        ) : null}
        {twin && (
          <span className="keys-expiry" data-tone="amber">
            {L.CODE_KEYS_LOOKS_LIKE} {twin}
          </span>
        )}
        {record.lastDetail && <span className="keys-last-detail">{record.lastDetail}</span>}
      </span>
      {editing ? (
        <KeyRowEditor record={record} projects={projects} onDone={onCancelEdit} />
      ) : (
        <span className="keys-row-actions">
          <Button
            variant="bare"
            className="keys-row-action"
            aria-label={L.CODE_KEYS_ROW_COPY}
            {...hoverProps(copied ? L.CODE_KEYS_ROW_COPIED : L.CODE_KEYS_ROW_COPY_TIP)}
            onClick={onCopy}
          >
            {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2.5} />}
          </Button>
          <Button
            variant="bare"
            className="keys-row-action"
            aria-label={L.CODE_KEYS_ROW_CHECK}
            {...hoverProps(L.CODE_KEYS_ROW_CHECK_TIP)}
            onClick={() => {
              setTip(null)
              onCheck()
            }}
            disabled={checking}
          >
            <ShieldCheck size={13} strokeWidth={2.5} data-spin={checking ? '' : undefined} />
          </Button>
          <Button
            variant="bare"
            className="keys-row-action"
            aria-label={L.CODE_KEYS_ROW_EDIT}
            {...hoverProps(L.CODE_KEYS_ROW_EDIT_TIP)}
            onClick={() => {
              setTip(null)
              onEdit()
            }}
          >
            <Pencil size={13} strokeWidth={2.5} />
          </Button>
          <Button
            variant="bare"
            className="keys-row-action"
            aria-label={unhide ? L.CODE_KEYS_ROW_UNHIDE : L.CODE_KEYS_ROW_HIDE}
            {...hoverProps(unhide ? L.CODE_KEYS_ROW_UNHIDE_TIP : L.CODE_KEYS_ROW_HIDE_TIP)}
            onClick={onHide}
          >
            {unhide ? <Eye size={13} strokeWidth={2.5} /> : <EyeOff size={13} strokeWidth={2.5} />}
          </Button>
          <Button
            variant="bare"
            className="keys-row-action"
            aria-label={L.CODE_KEYS_ROW_REMOVE}
            {...hoverProps(L.CODE_KEYS_ROW_REMOVE_TIP)}
            onClick={onRemove}
          >
            <Trash2 size={13} strokeWidth={2.5} />
          </Button>
        </span>
      )}
      <Tooltip tip={tip} />
    </div>
  )
}

function KeyRowEditor({
  record,
  projects,
  onDone
}: {
  record: KeyRecord
  projects: MightyProject[]
  onDone: () => void
}): JSX.Element {
  const [provider, setProvider] = useState(record.provider)
  const [routes, setRoutes] = useState<KeyRoute[]>(record.routes)
  const [expiresAt, setExpiresAt] = useState(record.expiresAt ?? '')
  const [note, setNote] = useState(record.note ?? '')
  const [usedBy, setUsedBy] = useState<string[]>(record.projects ?? [])
  const [saving, setSaving] = useState(false)

  const toggleRoute = (r: KeyRoute): void =>
    setRoutes((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]))

  const save = (): void => {
    setSaving(true)
    void window.api.keys
      .update(record.id, {
        provider,
        routes,
        expiresAt: expiresAt || undefined,
        note: note || undefined,
        ...(record.scope === 'global' ? { projects: usedBy.length ? usedBy : undefined } : {})
      })
      .finally(() => {
        setSaving(false)
        onDone()
      })
  }

  const grouped = useMemo(() => {
    const byCategory = new Map<string, typeof KEY_PROVIDERS>()
    for (const p of KEY_PROVIDERS) {
      const list = byCategory.get(p.category) ?? []
      list.push(p)
      byCategory.set(p.category, list)
    }
    return byCategory
  }, [])

  return (
    <span className="keys-editor">
      <select value={provider} onChange={(e) => setProvider(e.target.value)}>
        {[...grouped.entries()].map(([cat, list]) => (
          <optgroup key={cat} label={KEY_CATEGORY_LABELS[cat as keyof typeof KEY_CATEGORY_LABELS]}>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="keys-editor-routes">
        {(['api', 'cli', 'mcp'] as const).map((r) => (
          <Button
            variant="bare"
            key={r}
            className="keys-route-chip keys-route-toggle"
            data-on={routes.includes(r) || undefined}
            onClick={() => toggleRoute(r)}
          >
            {r}
          </Button>
        ))}
      </span>
      <input
        type="date"
        value={expiresAt.slice(0, 10)}
        onChange={(e) => setExpiresAt(e.target.value ? new Date(e.target.value).toISOString() : '')}
      />
      {record.scope === 'global' && (
        <span className="keys-editor-routes" title={L.CODE_KEYS_USED_BY}>
          <Button
            variant="bare"
            className="keys-route-chip keys-route-toggle"
            data-on={usedBy.length === 0 || undefined}
            onClick={() => setUsedBy([])}
          >
            {L.CODE_KEYS_USED_BY_ALL}
          </Button>
          {projects
            .filter((p) => !p.archived)
            .map((p) => (
              <Button
                variant="bare"
                key={p.id}
                className="keys-route-chip keys-route-toggle"
                data-on={usedBy.includes(p.id) || undefined}
                onClick={() =>
                  setUsedBy((cur) =>
                    cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]
                  )
                }
              >
                {p.name}
              </Button>
            ))}
        </span>
      )}
      <input
        type="text"
        placeholder={L.CODE_KEYS_ADD_NOTE}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button  onClick={save} disabled={saving}>
        {L.CODE_KEYS_ROW_SAVE}
      </Button>
      <Button variant="secondary"  onClick={onDone}>
        {L.CODE_KEYS_ROW_CANCEL}
      </Button>
    </span>
  )
}
