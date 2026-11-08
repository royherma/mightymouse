import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, LogIn, Pencil, Plug, Plus, RotateCw, Trash2, ExternalLink } from 'lucide-react'
import type { McpConnection, McpHealthRow, McpScope, McpStatus } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import { RailSection } from './agent-context-rail'
import { Button } from './Button'
import { ConfirmDialog } from './ConfirmDialog'
import { getFavicon } from './AppIcon'
import { McpConnectionSheet, MCP_WHERE } from './McpConnectionSheet'
import { appLook, ToolIcon } from './tools-used'
import './tools-used.css'
import './mcp-connections.css'

const L = CONFIG.UI_LABELS
const CLAUDE_AI_PREFIX = 'claude.ai '

const STATUS_TEXT: Record<McpStatus, string> = {
  connected: L.MCP_CONNECTED,
  'needs-login': L.MCP_NEEDS_LOGIN,
  failed: L.MCP_FAILED,
  'pending-approval': L.MCP_PENDING
}

type Row = McpConnection & { health?: McpHealthRow }
type Sheet = { mode: 'add' } | { mode: 'edit'; row: McpConnection }

function target(row: Row): string {
  if (row.spec.transport !== 'stdio') return row.spec.url ?? ''
  return [row.spec.command, ...(row.spec.args ?? [])].join(' ')
}

function merge(conns: McpConnection[], health: McpHealthRow[] | undefined): Row[] {
  const byName = new Map((health ?? []).map((h) => [h.name, h]))
  const rows: Row[] = conns.map((c) => ({ ...c, health: byName.get(c.name) }))
  for (const h of health ?? []) {
    if (!h.name.startsWith(CLAUDE_AI_PREFIX)) continue
    rows.push({ name: h.name.slice(CLAUDE_AI_PREFIX.length), scope: 'claude-ai', spec: { transport: 'http', url: h.target }, health: h })
  }
  return rows
}

function ConnectionRow(props: {
  row: Row
  checking: boolean
  busy: boolean
  onEdit: () => void
  onRemove: () => void
  onLogin: () => void
}): React.JSX.Element {
  const { row } = props
  const [open, setOpen] = useState(false)
  const status = row.health?.status
  const statusText = status ? STATUS_TEXT[status] : props.checking ? L.MCP_CHECKING : undefined
  const editable = row.scope !== 'claude-ai'
  return (
    <li className="tools-used-item" data-open={open || undefined}>
      <Button variant="bare" className="tools-used-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ToolIcon site={appLook(row.name).site} icon={Plug} kind="app" />
        <span className="tools-used-text">
          <span className="tools-used-name">{row.name}</span>
          <span className="tools-used-meta">
            {statusText && (
              <span className="mcp-status" data-status={status ?? 'checking'}>
                {statusText}
              </span>
            )}
            {statusText && ' · '}
            {MCP_WHERE[row.scope]}
          </span>
        </span>
        <ChevronRight className="tools-used-chevron" size={12} strokeWidth={2.5} />
      </Button>
      {open && (
        <div className="tools-used-more mcp-more">
          <p className="mcp-target" title={target(row)}>
            {target(row)}
          </p>
          {row.health && row.health.status !== 'connected' && row.health.detail && (
            <p className="mcp-detail">{row.health.detail}</p>
          )}
          <div className="mcp-actions">
            {status === 'needs-login' && editable && (
              <Button variant="primary" className="mcp-action" onClick={props.onLogin} disabled={props.busy}>
                <LogIn size={12} />
                {props.busy ? L.MCP_SIGNING_IN : L.MCP_SIGN_IN}
              </Button>
            )}
            {editable ? (
              <>
                <Button variant="ghost" className="mcp-action" onClick={props.onEdit} disabled={props.busy}>
                  <Pencil size={12} />
                  {L.MCP_EDIT}
                </Button>
                <Button variant="ghost" className="mcp-action" onClick={props.onRemove} disabled={props.busy}>
                  <Trash2 size={12} />
                  {L.MCP_REMOVE}
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="mcp-action" onClick={() => void window.api.mcp.openClaudeConnectors()}>
                <ExternalLink size={12} />
                {L.MCP_MANAGE_ON_CLAUDE_AI}
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

const SUMMARY_NAMES = 3

const appName = (id: string): string => id.split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

function SummaryFace(props: { name: string }): React.JSX.Element {
  const site = appLook(props.name).site
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    setSrc(null)
    if (!site) return
    let live = true
    void getFavicon(site).then((path) => {
      if (live && path) setSrc(window.api.mediaUrl(path))
    })
    return () => {
      live = false
    }
  }, [site])
  return <span>{src ? <img src={src} alt="" /> : appName(props.name).charAt(0)}</span>
}

export function McpSummaryLine(props: { cwd: string; onManage: () => void }): React.JSX.Element {
  const [conns, setConns] = useState<McpConnection[]>([])
  const [health, setHealth] = useState<McpHealthRow[] | undefined>()
  useEffect(() => {
    let live = true
    void window.api.mcp.list(props.cwd).then((c) => live && setConns(c))
    void window.api.mcp.health(props.cwd, false).then((h) => live && setHealth(h))
    return () => {
      live = false
    }
  }, [props.cwd])
  const rows = merge(conns, health)
  const shown = rows.slice(0, SUMMARY_NAMES)
  const more = rows.length - shown.length
  return (
    <div className="mcp-summary">
      {shown.length > 0 && (
        <>
          <span className="mcp-summary-faces" aria-hidden>
            {shown.map((r) => (
              <SummaryFace key={`${r.scope}:${r.name}`} name={r.name} />
            ))}
          </span>
          <span className="mcp-summary-text">
            {L.CODE_DRAFT_APPS_WORKS_WITH.replace('{names}', shown.map((r) => appName(r.name)).join(', '))}
            {more > 0 && L.CODE_DRAFT_APPS_AND_MORE.replace('{n}', String(more))}
          </span>
        </>
      )}
      <Button variant="bare" className="mcp-summary-manage" onClick={props.onManage}>
        {L.CODE_DRAFT_APPS_MANAGE}
      </Button>
    </div>
  )
}

export function McpConnectionsSection(props: { cwd: string; open: boolean; onToggle: () => void }): React.JSX.Element {
  const [count, setCount] = useState(0)
  return (
    <RailSection title={L.MCP_TITLE} icon={Plug} open={props.open} onToggle={props.onToggle} badge={count ? String(count) : undefined}>
      <McpConnectionsList cwd={props.cwd} onCount={setCount} />
    </RailSection>
  )
}

export function McpConnectionsList(props: { cwd: string; onCount?: (n: number) => void }): React.JSX.Element {
  const { cwd, onCount } = props
  const [conns, setConns] = useState<McpConnection[]>([])
  const [health, setHealth] = useState<McpHealthRow[] | undefined>()
  const [checking, setChecking] = useState(false)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [removing, setRemoving] = useState<McpConnection | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null)

  const load = useCallback(
    (fresh: boolean) => {
      let live = true
      void window.api.mcp.list(cwd).then((c) => live && setConns(c))
      setChecking(true)
      void window.api.mcp
        .health(cwd, fresh)
        .then((h) => live && setHealth(h))
        .finally(() => live && setChecking(false))
      return () => {
        live = false
      }
    },
    [cwd]
  )
  useEffect(() => {
    setHealth(undefined)
    return load(false)
  }, [load])

  const after = (result: { ok: true } | { ok: false; error: string }, okText?: string): void => {
    setNote(result.ok ? (okText ? { text: okText } : null) : { text: result.error, error: true })
    load(true)
  }

  const rows = merge(conns, health)
  const key = (c: McpConnection): string => `${c.scope}:${c.name}`
  useEffect(() => onCount?.(rows.length), [onCount, rows.length])

  return (
    <>
      {rows.length === 0 && !checking && <p className="mcp-empty">{L.MCP_EMPTY}</p>}
      {rows.length > 0 && (
        <ul className="tools-used-list">
          {rows.map((row) => (
            <ConnectionRow
              key={key(row)}
              row={row}
              checking={checking}
              busy={busy === key(row)}
              onEdit={() => setSheet({ mode: 'edit', row })}
              onRemove={() => setRemoving(row)}
              onLogin={() => {
                setBusy(key(row))
                void window.api.mcp
                  .login(cwd, row.name)
                  .then((r) => after(r))
                  .finally(() => setBusy(null))
              }}
            />
          ))}
        </ul>
      )}
      {note && (
        <p className="mcp-note" data-error={note.error || undefined}>
          {note.text}
        </p>
      )}
      <div className="mcp-footer">
        <Button variant="bare" className="mcp-action mcp-add" onClick={() => setSheet({ mode: 'add' })}>
          <Plus size={12} />
          {L.MCP_ADD}
        </Button>
        <Button variant="icon" className="mcp-recheck" onClick={() => load(true)} disabled={checking} title={L.MCP_RECHECK} aria-label={L.MCP_RECHECK}>
          <RotateCw size={12} className={checking ? 'mcp-spin' : undefined} />
        </Button>
      </div>
      {sheet && (
        <McpConnectionSheet
          cwd={cwd}
          initial={sheet.mode === 'edit' ? sheet.row : undefined}
          taken={conns.map((c) => c.name)}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null)
            after({ ok: true }, L.MCP_NEW_SESSIONS)
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={L.MCP_REMOVE_TITLE}
          body={`${removing.name} · ${MCP_WHERE[removing.scope]}. ${L.MCP_REMOVE_BODY}`}
          confirmLabel={L.MCP_REMOVE}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing
            setRemoving(null)
            setBusy(key(target))
            void window.api.mcp
              .remove(cwd, target.name, target.scope as McpScope)
              .then((r) => after(r))
              .finally(() => setBusy(null))
          }}
        />
      )}
    </>
  )
}
