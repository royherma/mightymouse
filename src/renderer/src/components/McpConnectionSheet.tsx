import { useState } from 'react'
import type { JSX } from 'react'
import { Plus, X } from 'lucide-react'
import type { McpConnection, McpScope, McpServerSpec } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'
import { KEY_PROVIDERS } from '../../../shared/key-providers'
import { Button } from './Button'
import { Modal } from './Modal'
import { KeyProviderIcon } from './KeyProviderIcon'
import { SegmentedControl } from './SegmentedControl'
import './KeysPanel.css'
import './mcp-connections.css'

const L = CONFIG.UI_LABELS
const NAME_RE = /^[A-Za-z0-9_.-]+$/
const SCOPES: McpScope[] = ['user', 'local', 'project']

export const MCP_WHERE: Record<McpConnection['scope'], string> = {
  user: L.MCP_WHERE_USER,
  local: L.MCP_WHERE_LOCAL,
  project: L.MCP_WHERE_PROJECT,
  'claude-ai': L.MCP_WHERE_CLAUDE_AI
}
type Kind = 'url' | 'command'

const SUGGESTED = KEY_PROVIDERS.filter((p) => p.mcpUrl).map((p) => ({ id: p.id, label: p.label, name: p.mcp?.[0] ?? p.id, url: p.mcpUrl ?? '' }))
type Pair = { k: string; v: string }

function toPairs(map: Record<string, string> | undefined): Pair[] {
  return Object.entries(map ?? {}).map(([k, v]) => ({ k, v }))
}

function fromPairs(pairs: Pair[]): Record<string, string> {
  return Object.fromEntries(pairs.filter((p) => p.k.trim()).map((p) => [p.k.trim(), p.v]))
}

function splitCommand(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^(["'])(.*)\1$/, '$2'))
}

function joinCommand(spec: McpServerSpec): string {
  return [spec.command ?? '', ...(spec.args ?? [])].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
}

function slug(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^(www|mcp|api)\./, '')
    return host.split('.')[0] ?? ''
  } catch {
    return ''
  }
}

function fromSnippet(text: string): { name: string; spec: McpServerSpec } | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const servers = (parsed.mcpServers ?? parsed.servers ?? parsed) as Record<string, Record<string, unknown>>
    const [name, raw] = Object.entries(servers)[0] ?? []
    if (!name || !raw || typeof raw !== 'object') return undefined
    if (typeof raw.url === 'string') {
      const transport = raw.type === 'sse' ? 'sse' : 'http'
      return { name, spec: { transport, url: raw.url, headers: (raw.headers as Record<string, string>) ?? {} } }
    }
    if (typeof raw.command !== 'string') return undefined
    return { name, spec: { transport: 'stdio', command: raw.command, args: (raw.args as string[]) ?? [], env: (raw.env as Record<string, string>) ?? {} } }
  } catch {
    return undefined
  }
}

function PairRows(props: { label: string; pairs: Pair[]; sep: string; onChange: (next: Pair[]) => void }): JSX.Element {
  const set = (i: number, patch: Partial<Pair>): void =>
    props.onChange(props.pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="keys-sheet-field">
      <span>{props.label}</span>
      {props.pairs.map((p, i) => (
        <span className="mcp-pair" key={i}>
          <input className="keys-sheet-mono" value={p.k} onChange={(e) => set(i, { k: e.target.value })} />
          <span className="mcp-pair-sep">{props.sep}</span>
          <input className="keys-sheet-mono" type="password" value={p.v} onChange={(e) => set(i, { v: e.target.value })} />
          <Button variant="icon" aria-label={L.MCP_REMOVE} onClick={() => props.onChange(props.pairs.filter((_, j) => j !== i))}>
            <X size={12} />
          </Button>
        </span>
      ))}
      <Button variant="ghost" className="mcp-action mcp-pair-add" onClick={() => props.onChange([...props.pairs, { k: '', v: '' }])}>
        <Plus size={12} />
        {L.MCP_ADD_ROW}
      </Button>
    </div>
  )
}

export function McpConnectionSheet(props: {
  cwd: string
  initial?: McpConnection
  taken: string[]
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const { initial } = props
  const spec = initial?.spec
  const [kind, setKind] = useState<Kind>(spec?.transport === 'stdio' ? 'command' : 'url')
  const [name, setName] = useState(initial?.name ?? '')
  const [nameTouched, setNameTouched] = useState(Boolean(initial))
  const [url, setUrl] = useState(spec?.url ?? '')
  const [command, setCommand] = useState(spec?.transport === 'stdio' ? joinCommand(spec) : '')
  const [headers, setHeaders] = useState<Pair[]>(toPairs(spec?.headers))
  const [env, setEnv] = useState<Pair[]>(toPairs(spec?.env))
  const [scope, setScope] = useState<McpScope>(initial && initial.scope !== 'claude-ai' ? initial.scope : 'user')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const applySnippet = (text: string): boolean => {
    const hit = fromSnippet(text.trim())
    if (!hit) return false
    setName(hit.name)
    setNameTouched(true)
    if (hit.spec.transport === 'stdio') {
      setKind('command')
      setCommand(joinCommand(hit.spec))
      setEnv(toPairs(hit.spec.env))
    } else {
      setKind('url')
      setUrl(hit.spec.url ?? '')
      setHeaders(toPairs(hit.spec.headers))
    }
    return true
  }

  const urlValid = /^https?:\/\/\S+$/.test(url.trim())
  const nameClash = name !== initial?.name && props.taken.includes(name)
  const nameValid = NAME_RE.test(name) && !nameClash
  const canSave = nameValid && !saving && (kind === 'url' ? urlValid : command.trim().length > 0)

  const save = (): void => {
    if (!canSave) return
    const parts = splitCommand(command)
    const next: McpServerSpec =
      kind === 'url'
        ? { transport: /\/sse\/?$/.test(url.trim()) ? 'sse' : 'http', url: url.trim(), headers: fromPairs(headers) }
        : { transport: 'stdio', command: parts[0], args: parts.slice(1), env: fromPairs(env) }
    setSaving(true)
    setError(null)
    void window.api.mcp
      .save({
        cwd: props.cwd,
        name,
        scope,
        spec: next,
        previous: initial && initial.scope !== 'claude-ai' ? { name: initial.name, scope: initial.scope } : undefined
      })
      .then((r) => (r.ok ? props.onSaved() : setError(r.error)))
      .finally(() => setSaving(false))
  }

  const title = initial ? L.MCP_SHEET_EDIT_TITLE : L.MCP_SHEET_ADD_TITLE
  return (
    <Modal label={title} onClose={props.onClose} backdropClassName="keys-sheet-backdrop" className="keys-sheet mcp-sheet">
      <div className="keys-sheet-title">{title}</div>
      {!initial && <p className="keys-sheet-intro">{L.MCP_SHEET_INTRO}</p>}

      {!initial && (
        <div className="keys-sheet-field">
          <span>{L.MCP_POPULAR}</span>
          <div className="mcp-suggest">
            {SUGGESTED.filter((p) => !props.taken.includes(p.name)).map((p) => (
              <Button
                key={p.id}
                variant="ghost"
                className={`mcp-suggest-tile${kind === 'url' && url === p.url ? ' is-picked' : ''}`}
                onClick={() => {
                  setKind('url')
                  setUrl(p.url)
                  setName(p.name)
                  setNameTouched(true)
                }}
              >
                <KeyProviderIcon provider={p.id} size={14} />
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      <SegmentedControl<Kind>
        items={[
          { id: 'url', label: L.MCP_KIND_URL },
          { id: 'command', label: L.MCP_KIND_COMMAND }
        ]}
        active={kind}
        onChange={setKind}
        textSize="text-xs"
      />

      {kind === 'url' ? (
        <label className="keys-sheet-field">
          <span>{L.MCP_URL}</span>
          <input
            className="keys-sheet-mono"
            autoFocus
            placeholder="https://mcp.example.com/mcp"
            value={url}
            onPaste={(e) => {
              if (applySnippet(e.clipboardData.getData('text'))) e.preventDefault()
            }}
            onChange={(e) => {
              setUrl(e.target.value)
              if (!nameTouched) setName(slug(e.target.value))
            }}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </label>
      ) : (
        <label className="keys-sheet-field">
          <span>{L.MCP_COMMAND}</span>
          <input
            className="keys-sheet-mono"
            autoFocus
            placeholder="npx -y @example/mcp-server"
            value={command}
            onPaste={(e) => {
              if (applySnippet(e.clipboardData.getData('text'))) e.preventDefault()
            }}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </label>
      )}

      <label className="keys-sheet-field">
        <span>{L.MCP_NAME}</span>
        <input
          className="keys-sheet-mono"
          value={name}
          onChange={(e) => {
            setNameTouched(true)
            setName(e.target.value.replace(/\s+/g, '-'))
          }}
        />
        {name.length > 0 && !nameValid && (
          <span className="keys-sheet-err">{nameClash ? L.MCP_NAME_TAKEN : L.MCP_NAME_INVALID}</span>
        )}
      </label>

      {kind === 'url' ? (
        <PairRows label={L.MCP_HEADERS} pairs={headers} sep=":" onChange={setHeaders} />
      ) : (
        <PairRows label={L.MCP_ENV} pairs={env} sep="=" onChange={setEnv} />
      )}

      <label className="keys-sheet-field">
        <span>{L.MCP_WHERE}</span>
        <select value={scope} onChange={(e) => setScope(e.target.value as McpScope)}>
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {MCP_WHERE[s]}
            </option>
          ))}
        </select>
      </label>

      {error && <span className="keys-sheet-err">{error}</span>}

      <div className="keys-sheet-actions">
        <Button variant="ghost" className="mcp-sheet-btn" onClick={props.onClose}>
          Cancel
        </Button>
        <Button variant="primary" className="mcp-sheet-btn" onClick={save} disabled={!canSave}>
          {saving ? L.MCP_SAVING : L.MCP_SAVE}
        </Button>
      </div>
    </Modal>
  )
}
