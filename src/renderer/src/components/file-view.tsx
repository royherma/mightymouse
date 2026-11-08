import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import { AlertTriangle, FileText, FolderOpen, Save } from 'lucide-react'
import type { FileReadResult } from '../../../shared/types'
import { Button } from './Button'
import { Markdown } from './Markdown'
import { MediaBrowser, useConversationMedia } from './media-viewer'
import {
  drafts,
  fileKind,
  fileName,
  MAX_TABLE_ROWS,
  parseJson,
  parseTable,
  type Draft,
  type FileMode,
  type Kind
} from './file-kinds'
import './file-view.css'
const FileEditor = lazy(() => import('./file-editor'))

const OPEN_ARRAY_LIMIT = 20

function JsonNode({
  name,
  value,
  depth
}: {
  name?: string
  value: unknown
  depth: number
}): ReactElement {
  const label = name !== undefined && <span className="file-json-key">{name}: </span>
  if (value === null || typeof value !== 'object') {
    const kind = value === null ? 'null' : typeof value
    return (
      <div className="file-json-leaf">
        {label}
        <span className={`file-json-${kind}`}>{JSON.stringify(value)}</span>
      </div>
    )
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>)
  const summary = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`
  return (
    <details className="file-json-branch" open={depth < 2 && entries.length <= OPEN_ARRAY_LIMIT}>
      <summary>
        {label}
        <span className="file-json-count">{summary}</span>
      </summary>
      {entries.map(([k, v]) => (
        <JsonNode key={k} name={k} value={v} depth={depth + 1} />
      ))}
    </details>
  )
}

function Preview({ kind, path, text }: { kind: Kind; path: string; text: string }): ReactElement {
  if (kind === 'markdown')
    return (
      <div className="file-view-doc">
        <Markdown cwd={path.slice(0, path.lastIndexOf('/'))}>{text}</Markdown>
      </div>
    )
  if (kind === 'json' || kind === 'jsonl') {
    const { value, error } = parseJson(text, kind === 'jsonl')
    if (error)
      return (
        <div className="file-view-doc">
          <p className="file-view-warn">
            <AlertTriangle size={13} /> Not valid JSON: {error}
          </p>
          <pre className="file-view-raw">{text}</pre>
        </div>
      )
    return (
      <div className="file-view-doc file-json">
        <JsonNode value={value} depth={0} />
      </div>
    )
  }
  if (kind === 'csv' || kind === 'tsv') {
    const [head, ...rows] = parseTable(text, kind === 'csv' ? ',' : '\t')
    return (
      <div className="file-view-doc">
        <table className="file-view-table">
          <thead>
            <tr>
              {head?.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length + 1 >= MAX_TABLE_ROWS && (
          <p className="file-view-note">
            Showing the first {MAX_TABLE_ROWS} rows. Edit to see all of it.
          </p>
        )}
      </div>
    )
  }
  return <pre className="file-view-raw">{text}</pre>
}

function Message({ children, path }: { children: ReactNode; path: string }): ReactElement {
  return (
    <div className="side-browser-empty">
      {children}
      <Button variant="ghost" onClick={() => void window.api.openPath(path)}>
        <FolderOpen size={13} />
        Show in Finder
      </Button>
    </div>
  )
}

export function FileView(props: {
  tabKey: string
  path: string
  mode: FileMode
  onMode: (mode: FileMode) => void
  onDirty: (dirty: boolean) => void
  page?: ReactNode
  pageViewId?: string
  onPath?: (path: string) => void
}): ReactElement {
  const { tabKey, path, mode, onMode, onDirty, pageViewId } = props
  const conversationMedia = useConversationMedia()
  const kind = fileKind(path)
  const media = kind === 'image' || kind === 'video'
  const [file, setFile] = useState<FileReadResult | null>(null)
  const [draft, setDraftState] = useState<Draft | null>(() => drafts.get(tabKey) ?? null)
  const [clash, setClash] = useState<'disk' | 'save' | null>(null)
  const [saving, setSaving] = useState(false)
  const reloadPage = useCallback(() => {
    if (pageViewId) void window.api.sideBrowser.command(pageViewId, 'reload')
  }, [pageViewId])
  const dirty = Boolean(draft && draft.text !== draft.saved)

  const setDraft = useCallback(
    (next: Draft) => {
      drafts.set(tabKey, next)
      setDraftState(next)
    },
    [tabKey]
  )

  const apply = useCallback(
    (read: FileReadResult, keepEdits: boolean) => {
      setFile(read)
      if (read.text === undefined) return
      const current = drafts.get(tabKey)
      if (keepEdits && current && current.text !== current.saved) {
        if (read.mtimeMs !== current.mtimeMs) setClash('disk')
        return
      }
      setClash(null)
      setDraft({ text: read.text, saved: read.text, mtimeMs: read.mtimeMs })
    },
    [tabKey, setDraft]
  )
  const reload = (): void => void window.api.files.read(path).then((r) => apply(r, false))

  useEffect(() => {
    if (media) return
    let live = true
    const refresh = (): void => void window.api.files.read(path).then((r) => live && apply(r, true))
    refresh()
    const off = window.api.files.watch(path, () => {
      const current = drafts.get(tabKey)
      if (current && current.text === current.saved) reloadPage()
      refresh()
    })
    return () => {
      live = false
      off()
    }
  }, [media, path, tabKey, apply, reloadPage])

  useEffect(() => onDirty(dirty), [dirty, onDirty])

  const save = useCallback(
    async (overwrite = false) => {
      const current = drafts.get(tabKey)
      if (!current || current.text === current.saved) return
      setSaving(true)
      const base = overwrite
        ? ((await window.api.files.read(path, 1)).mtimeMs ?? 0)
        : current.mtimeMs
      const result = await window.api.files.write(path, current.text, base)
      setSaving(false)
      if (!result.ok) {
        setClash(result.reason === 'conflict' ? 'save' : null)
        if (result.reason !== 'conflict') window.alert(`Couldn't save ${fileName(path)}.`)
        return
      }
      setClash(null)
      setDraft({ text: current.text, saved: current.text, mtimeMs: result.mtimeMs })
      reloadPage()
    },
    [path, tabKey, setDraft, reloadPage]
  )

  const canPreview = kind !== 'text' && !media
  const text = draft?.text ?? ''
  let body: ReactNode
  if (media) body = <MediaBrowser list={conversationMedia} start={path} onPath={props.onPath} />
  else if (kind === 'html' && mode === 'preview') body = props.page
  else if (!file) body = <div className="side-browser-empty">Opening…</div>
  else if (file.error === 'outside')
    body = (
      <Message path={path}>
        This file is outside your home folder, so it opens in Finder instead.
      </Message>
    )
  else if (file.error === 'secret')
    body = (
      <Message path={path}>This file may hold passwords or keys, so it stays closed here.</Message>
    )
  else if (file.error === 'missing')
    body = <div className="side-browser-empty">This file isn&apos;t there anymore.</div>
  else if (file.error === 'directory') body = <Message path={path}>This is a folder.</Message>
  else if (file.tooBig || file.binary)
    body = (
      <Message path={path}>
        {file.tooBig ? 'This file is too big to open here.' : "This file isn't text."}
      </Message>
    )
  else if (mode === 'edit' || !canPreview)
    body = (
      <Suspense fallback={<div className="side-browser-empty">Opening…</div>}>
        <FileEditor
          path={path}
          text={text}
          onChange={(next) => draft && setDraft({ ...draft, text: next })}
          onSave={() => void save()}
        />
      </Suspense>
    )
  else body = <Preview kind={kind} path={path} text={text} />

  const folder = path.slice(0, path.lastIndexOf('/'))
  return (
    <div className="file-view">
      <div className="side-browser-bar file-view-bar">
        <FileText size={13} className="file-view-icon" />
        <span className="file-view-name" title={path}>
          {fileName(path)}
        </span>
        <span className="file-view-folder" title={folder}>
          {folder.split('/').slice(-2).join('/')}
        </span>
        {canPreview && (
          <div className="file-view-modes" role="tablist">
            {(['preview', 'edit'] as const).map((m) => (
              <Button
                key={m}
                variant="bare"
                role="tab"
                aria-selected={mode === m}
                data-on={mode === m ? '' : undefined}
                className="file-view-mode"
                onClick={() => onMode(m)}
              >
                {m === 'preview' ? 'Preview' : 'Edit'}
              </Button>
            ))}
          </div>
        )}
        {!media && (
          <Button
            variant="bare"
            className="side-browser-nav"
            aria-label="Save"
            title="Save (⌘S)"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            <Save size={13} />
          </Button>
        )}
        <Button
          variant="bare"
          className="side-browser-nav"
          aria-label="Show in Finder"
          title="Show in Finder"
          onClick={() => void window.api.openPath(path)}
        >
          <FolderOpen size={13} />
        </Button>
      </div>
      {clash && (
        <div className="side-browser-permission">
          <span>
            {clash === 'disk'
              ? 'This file changed on disk while you were editing.'
              : 'This file changed on disk since you opened it.'}
          </span>
          <Button variant="ghost" onClick={reload}>
            Load the new version
          </Button>
          <Button variant="primary" onClick={() => void save(true)}>
            Keep mine
          </Button>
        </div>
      )}
      {body}
    </div>
  )
}
