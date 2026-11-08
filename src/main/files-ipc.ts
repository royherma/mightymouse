import { ipcMain, type WebContents } from 'electron'
import { execFile } from 'child_process'
import { watch, type FSWatcher } from 'fs'
import { open, readdir, realpath, rename, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, normalize } from 'path'
import { CHANNELS } from '../shared/ipc'
import type { FileReadResult, FileWriteResult } from '../shared/types'
import { SECRET_FILE } from './media-protocol'

const MAX_TEXT_BYTES = 5 * 1024 * 1024
const SNIFF_BYTES = 8000
const CHANGE_DEBOUNCE_MS = 150
const MAX_LISTED = 20000
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.cache', 'DerivedData'])
const SECRET_DIR = /\/(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config\/gcloud|Library\/Keychains)\//

function allowed(path: unknown): path is string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('..')) return false
  if (normalize(path) !== path || isSecret(path)) return false
  const roots = [homedir() + '/', '/private/tmp/', '/tmp/']
  return roots.some((root) => path.startsWith(root))
}

function isSecret(path: string): boolean {
  return SECRET_FILE.test(basename(path)) || SECRET_DIR.test(path)
}

async function refusal(path: unknown): Promise<'secret' | 'outside' | null> {
  if (typeof path !== 'string') return 'outside'
  const real = await realpath(path).catch(() => path)
  if (isSecret(path) || isSecret(real)) return 'secret'
  return allowed(path) && allowed(real) ? null : 'outside'
}

async function readFileFor(path: string, limit: number): Promise<FileReadResult> {
  const base: FileReadResult = { path, size: 0, mtimeMs: 0 }
  const refused = await refusal(path)
  if (refused) return { ...base, error: refused }
  const info = await stat(path).catch(() => null)
  if (!info) return { ...base, error: 'missing' }
  if (info.isDirectory()) return { ...base, error: 'directory' }
  const result = { ...base, size: info.size, mtimeMs: info.mtimeMs }
  if (info.size > MAX_TEXT_BYTES && limit >= MAX_TEXT_BYTES) return { ...result, tooBig: true }
  const handle = await open(path, 'r')
  try {
    const length = Math.min(info.size, limit)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, 0)
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return { ...result, binary: true }
    return { ...result, text: buf.toString('utf8') }
  } finally {
    await handle.close()
  }
}

async function writeFileFor(path: string, text: string, expectMtimeMs: number): Promise<FileWriteResult> {
  if ((await refusal(path)) || typeof text !== 'string') return { ok: false, reason: 'forbidden' }
  const info = await stat(path).catch(() => null)
  if (info && Math.abs(info.mtimeMs - expectMtimeMs) > 1) return { ok: false, reason: 'conflict' }
  const temp = join(dirname(path), `.${basename(path)}.mm-${process.pid}.tmp`)
  try {
    await writeFile(temp, text, { mode: info ? info.mode & 0o777 : 0o644 })
    await rename(temp, path)
    return { ok: true, mtimeMs: (await stat(path)).mtimeMs }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

function gitFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) =>
    execFile(
      'git',
      ['ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      (err, out) => resolve(err ? null : out.split('\0').filter(Boolean).slice(0, MAX_LISTED))
    )
  )
}

async function walkFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const queue = ['']
  while (queue.length && found.length < MAX_LISTED) {
    const rel = queue.shift() as string
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(child)
      } else if (entry.isFile()) found.push(child)
    }
  }
  return found
}

async function listFiles(root: string): Promise<string[]> {
  if (!allowed(root) || !(await stat(root).catch(() => null))?.isDirectory()) return []
  return (await gitFiles(root)) ?? walkFiles(root)
}

interface DirWatch {
  watcher: FSWatcher
  listeners: Map<string, Set<WebContents>>
  timers: Map<string, NodeJS.Timeout>
}

const dirWatches = new Map<string, DirWatch>()

function unwatch(path: string, sender: WebContents): void {
  const dir = dirWatches.get(dirname(path))
  const set = dir?.listeners.get(basename(path))
  if (!dir || !set) return
  set.delete(sender)
  if (set.size === 0) dir.listeners.delete(basename(path))
  if (dir.listeners.size === 0) {
    dir.watcher.close()
    dir.timers.forEach(clearTimeout)
    dirWatches.delete(dirname(path))
  }
}

// Watches the folder, not the file: agents save by rename, which orphans a watcher on the old inode.
function watchPath(path: string, sender: WebContents): void {
  const folder = dirname(path)
  let dir = dirWatches.get(folder)
  if (!dir) {
    let watcher: FSWatcher
    try {
      watcher = watch(folder, { persistent: false })
    } catch {
      return
    }
    const created: DirWatch = { watcher, listeners: new Map(), timers: new Map() }
    watcher.on('change', (_event, name) => {
      const file = String(name ?? '')
      const targets = created.listeners.get(file)
      if (!targets) return
      clearTimeout(created.timers.get(file))
      created.timers.set(
        file,
        setTimeout(() => {
          const changed = join(folder, file)
          for (const wc of targets) if (!wc.isDestroyed()) wc.send(CHANNELS.filesChanged, changed)
        }, CHANGE_DEBOUNCE_MS)
      )
    })
    watcher.on('error', () => undefined)
    dirWatches.set(folder, created)
    dir = created
  }
  const name = basename(path)
  const set = dir.listeners.get(name) ?? new Set<WebContents>()
  if (!set.has(sender)) sender.once('destroyed', () => unwatch(path, sender))
  set.add(sender)
  dir.listeners.set(name, set)
}

export function registerFilesHandlers(): void {
  ipcMain.handle(CHANNELS.filesRead, (_e, path: string, limit?: number) =>
    readFileFor(path, typeof limit === 'number' && limit > 0 ? Math.min(limit, MAX_TEXT_BYTES) : MAX_TEXT_BYTES)
  )
  ipcMain.handle(CHANNELS.filesWrite, (_e, path: string, text: string, expectMtimeMs: number) =>
    writeFileFor(path, text, expectMtimeMs)
  )
  ipcMain.handle(CHANNELS.filesList, (_e, root: string) => listFiles(root))
  ipcMain.handle(CHANNELS.filesWatch, (e, path: string, on: boolean) => {
    if (!allowed(path)) return
    if (on) watchPath(path, e.sender)
    else unwatch(path, e.sender)
  })
}
