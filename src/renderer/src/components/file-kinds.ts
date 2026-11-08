export type FileMode = 'preview' | 'edit'
export type Kind =
  | 'markdown'
  | 'json'
  | 'jsonl'
  | 'html'
  | 'csv'
  | 'tsv'
  | 'image'
  | 'video'
  | 'text'

const KINDS: [RegExp, Kind][] = [
  [/\.(md|markdown)$/i, 'markdown'],
  [/\.json$/i, 'json'],
  [/\.jsonl$/i, 'jsonl'],
  [/\.html?$/i, 'html'],
  [/\.csv$/i, 'csv'],
  [/\.tsv$/i, 'tsv'],
  [/\.(png|jpe?g|gif|webp|svg)$/i, 'image'],
  [/\.(mp4|mov|webm)$/i, 'video']
]
export const MAX_TABLE_ROWS = 1000

export interface Draft {
  text: string
  saved: string
  mtimeMs: number
}

export const drafts = new Map<string, Draft>()

export function filePathOf(url: string | undefined): string | null {
  if (!url?.startsWith('file:///')) return null
  try {
    return decodeURIComponent(url.slice('file://'.length).replace(/[?#].*$/, ''))
  } catch {
    return null
  }
}

export function fileKind(path: string): Kind {
  return KINDS.find(([re]) => re.test(path))?.[1] ?? 'text'
}

export function defaultFileMode(path: string): FileMode {
  return fileKind(path) === 'text' ? 'edit' : 'preview'
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function confirmCloseFile(tabKey: string, path: string): boolean {
  const draft = drafts.get(tabKey)
  if (
    draft &&
    draft.text !== draft.saved &&
    !window.confirm(`Close ${fileName(path)} without saving your changes?`)
  )
    return false
  drafts.delete(tabKey)
  return true
}

export function parseJson(text: string, lines: boolean): { value?: unknown; error?: string } {
  try {
    return {
      value: lines
        ? text
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l) as unknown)
        : (JSON.parse(text) as unknown)
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export function parseTable(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < MAX_TABLE_ROWS; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}
