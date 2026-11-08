import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronRight, FileText, Folder, Search, X } from 'lucide-react'
import { Button } from './Button'
import { fileName } from './file-kinds'
import './file-view.css'

const MAX_RESULTS = 80

interface Dir {
  dirs: Map<string, Dir>
  files: string[]
}

interface Row {
  rel: string
  dir: boolean
  depth: number
  folder?: string
}

const listed = new Map<string, string[]>()
const opened = new Map<string, Set<string>>()

function score(path: string, query: string): number {
  const lower = path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  const at = name.indexOf(query)
  if (at >= 0) return 10000 - (at === 0 ? 0 : 500) - lower.length
  let total = 0
  let run = 0
  let from = 0
  for (const ch of query) {
    const i = lower.indexOf(ch, from)
    if (i < 0) return -1
    run = i === from ? run + 1 : 0
    total += 10 + run * 5 + (i === 0 || lower[i - 1] === '/' ? 15 : 0)
    from = i + 1
  }
  return total - lower.length
}

function search(files: string[], query: string): Row[] {
  return files
    .map((f) => [f, score(f, query)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RESULTS)
    .map(([rel]) => ({
      rel,
      dir: false,
      depth: 0,
      folder: rel.slice(0, rel.lastIndexOf('/') + 1)
    }))
}

function buildTree(files: string[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] }
  for (const rel of files) {
    let dir = root
    for (const part of rel.split('/').slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (!next) dir.dirs.set(part, (next = { dirs: new Map(), files: [] }))
      dir = next
    }
    dir.files.push(rel)
  }
  return root
}

function visibleRows(dir: Dir, expanded: Set<string>, prefix = '', depth = 0): Row[] {
  const rows: Row[] = []
  for (const name of [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
    const rel = prefix + name
    rows.push({ rel, dir: true, depth })
    if (expanded.has(rel))
      rows.push(...visibleRows(dir.dirs.get(name) as Dir, expanded, rel + '/', depth + 1))
  }
  for (const rel of [...dir.files].sort((a, b) => fileName(a).localeCompare(fileName(b))))
    rows.push({ rel, dir: false, depth })
  return rows
}

function ancestors(rel: string): string[] {
  const parts = rel.split('/').slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

export function FilePicker(props: {
  root: string
  current?: string
  onPick: (path: string) => void
  onClose: () => void
}): ReactElement {
  const { onPick, onClose } = props
  const root = props.root.replace(/\/$/, '')
  const currentRel = props.current?.startsWith(root + '/')
    ? props.current.slice(root.length + 1)
    : undefined
  const [files, setFiles] = useState<string[] | null>(() => listed.get(root) ?? null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const saved = new Set(opened.get(root))
    if (currentRel) ancestors(currentRel).forEach((a) => saved.add(a))
    return saved
  })
  const [sel, setSel] = useState<string | undefined>(currentRel)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    void window.api.files.list(root).then((found) => {
      listed.set(root, found)
      if (live) setFiles(found)
    })
    return () => {
      live = false
    }
  }, [root])

  useEffect(() => {
    opened.set(root, expanded)
  }, [root, expanded])

  const tree = useMemo(() => buildTree(files ?? []), [files])
  const q = query.trim().toLowerCase().replace(/\s+/g, '')
  const rows = useMemo(
    () => (q ? search(files ?? [], q) : visibleRows(tree, expanded)),
    [q, files, tree, expanded]
  )
  const at = Math.max(
    0,
    rows.findIndex((r) => r.rel === sel)
  )
  const selected = rows[at]

  useEffect(() => {
    list.current?.querySelector('[data-on]')?.scrollIntoView({ block: 'nearest' })
  }, [selected?.rel])

  const toggle = (rel: string, open?: boolean): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (open ?? !next.has(rel)) next.add(rel)
      else next.delete(rel)
      return next
    })
  const activate = (row: Row | undefined): void => {
    if (!row) return
    if (row.dir) toggle(row.rel)
    else onPick(`${root}/${row.rel}`)
  }
  const move = (step: number): void => {
    if (rows.length) setSel(rows[(at + step + rows.length) % rows.length].rel)
  }

  const folder = fileName(root)
  return (
    <div className="file-tree">
      <div className="side-browser-bar file-tree-head">
        <Search size={13} className="file-view-icon" />
        <input
          autoFocus
          className="file-tree-input"
          value={query}
          placeholder={`Search ${folder}`}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.currentTarget.value)
            setSel(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (query) setQuery('')
              else onClose()
            } else if (e.key === 'Enter') activate(selected)
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              move(e.key === 'ArrowDown' ? 1 : -1)
            } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && selected?.dir) {
              e.preventDefault()
              toggle(selected.rel, e.key === 'ArrowRight')
            }
          }}
        />
        <Button
          variant="bare"
          className="side-browser-nav"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
        >
          <X size={13} />
        </Button>
      </div>
      <div ref={list} className="file-tree-list" role="tree" aria-label={folder}>
        {!files ? (
          <p className="file-tree-note">Finding files…</p>
        ) : files.length === 0 ? (
          <p className="file-tree-note">No files in {folder}.</p>
        ) : rows.length === 0 ? (
          <p className="file-tree-note">No file matches &ldquo;{query}&rdquo;.</p>
        ) : (
          rows.map((row) => (
            <Button
              key={row.rel}
              variant="bare"
              role="treeitem"
              aria-expanded={row.dir ? expanded.has(row.rel) : undefined}
              aria-selected={row === selected}
              className="file-tree-row"
              data-on={row === selected ? '' : undefined}
              data-current={row.rel === currentRel ? '' : undefined}
              style={{ paddingLeft: 8 + row.depth * 14 + (row.dir || q ? 0 : 18) }}
              title={row.rel}
              onClick={() => {
                setSel(row.rel)
                activate(row)
              }}
            >
              {row.dir ? (
                <>
                  <ChevronRight
                    size={12}
                    className="file-tree-chevron"
                    data-open={expanded.has(row.rel) ? '' : undefined}
                  />
                  <Folder size={13} className="file-tree-icon" />
                </>
              ) : (
                <FileText size={13} className="file-tree-icon" />
              )}
              <span className="file-tree-name">{fileName(row.rel)}</span>
              {row.folder && <span className="file-tree-folder">{row.folder}</span>}
            </Button>
          ))
        )}
      </div>
    </div>
  )
}
