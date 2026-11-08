import { useMemo, useState, type JSX } from 'react'
import type { ChangedFile } from '../types'
import { Button } from './Button'

const META_LINE = /^(index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) |Binary files )/

function splitPatch(patch: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>()
  let current: string[] | null = null
  for (const line of patch.split('\n')) {
    const head = /^diff --git a\/.+? b\/(.+)$/.exec(line)
    if (head) {
      current = []
      byFile.set(head[1], current)
      continue
    }
    if (current && !META_LINE.test(line)) current.push(line)
  }
  return byFile
}

function lineTone(line: string): string {
  if (line.startsWith('@@')) return 'text-accent'
  if (line.startsWith('+')) return 'text-green'
  if (line.startsWith('-')) return 'text-red'
  return 'text-muted'
}

function Counts({ file }: { file: ChangedFile }): JSX.Element {
  if (file.added === undefined && file.removed === undefined) return <span className="text-muted">new</span>
  return (
    <span className="shrink-0 tabular-nums">
      {file.added ? <span className="text-green">+{file.added}</span> : null}
      {file.added && file.removed ? ' ' : null}
      {file.removed ? <span className="text-red">-{file.removed}</span> : null}
    </span>
  )
}

export function ChangedFiles({
  files,
  patch,
  truncated = false,
  empty = 'No file changes yet.'
}: {
  files: ChangedFile[]
  patch: string
  truncated?: boolean
  empty?: string
}): JSX.Element {
  const sections = useMemo(() => splitPatch(patch), [patch])
  const [open, setOpen] = useState<string | null>(files.length === 1 ? files[0].path : null)
  if (files.length === 0) return <span className="text-sm text-muted">{empty}</span>
  const added = files.reduce((sum, f) => sum + (f.added ?? 0), 0)
  const removed = files.reduce((sum, f) => sum + (f.removed ?? 0), 0)
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="text-muted">
        {files.length} file{files.length === 1 ? '' : 's'} changed <span className="text-green">+{added}</span>{' '}
        <span className="text-red">-{removed}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {files.map((f) => {
          const lines = sections.get(f.path)
          const isOpen = open === f.path && lines !== undefined
          return (
            <li key={f.path} className="rounded-md bg-surface2">
              <Button
                variant="bare"
                className="flex w-full items-center justify-between gap-3 px-3 py-1 text-left hover:bg-surface3"
                onClick={() => setOpen(isOpen ? null : f.path)}
                disabled={lines === undefined}
                aria-expanded={isOpen}
              >
                <span className="min-w-0 truncate font-mono" title={f.path}>
                  {f.path}
                </span>
                <Counts file={f} />
              </Button>
              {isOpen && (
                <pre className="max-h-72 overflow-auto whitespace-pre border-t border-surface3 px-3 py-2 font-mono leading-snug">
                  {lines.map((line, i) => (
                    <div key={i} className={lineTone(line)}>
                      {line || ' '}
                    </div>
                  ))}
                </pre>
              )}
            </li>
          )
        })}
      </ul>
      {truncated && <span className="text-muted">The rest of the changes are too long to show here.</span>}
    </div>
  )
}
