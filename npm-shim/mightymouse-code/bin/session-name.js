/**
 * Session name SSOT for every machine that runs this shim.
 *
 * Claude Code's /rename writes `Session renamed to: <name>` into the transcript
 * and nowhere else we can see. Hooks in ~/.claude ship to nobody, so THIS
 * process copies that line into ~/.claude/.session-names/<id> -- the file the
 * presence watcher already re-registers on. Phone + Code panel then agree.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'

export const RENAME_MARK = 'Session renamed to: '
const TAIL_BYTES = 65536
const NAME_MAX = 64
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export function sessionNameDir(home) {
  return join(home, '.claude', '.session-names')
}

export function sessionScoreDir(home) {
  return join(home, '.claude', '.session-name-scores')
}

// Two cwd encodings are live on disk; picking one blindly kills /rename sync.
export function claudeTranscriptPath(home, cwd, sessionId, configDir = join(home || '', '.claude')) {
  if (!home || !cwd || !sessionId || !SAFE_ID.test(sessionId)) return ''
  const slugs = [String(cwd).replace(/[/_.]/g, '-'), String(cwd).replace(/\//g, '-')]
  const paths = [...new Set(slugs)].map((slug) =>
    join(configDir, 'projects', slug, `${sessionId}.jsonl`)
  )
  return paths.find((p) => existsSync(p)) || paths[0]
}

const AI_TITLE_LINE = /"type":"ai-title","aiTitle":"((?:[^"\\]|\\.){3,200})"/g

// Claude Code's own auto title - the one cmux and the terminal tab show.
export function aiTitleFromTranscript(blob) {
  if (!blob) return ''
  const last = [...blob.matchAll(AI_TITLE_LINE)].at(-1)?.[1]
  if (!last) return ''
  try {
    return JSON.parse(`"${last}"`).trim().slice(0, NAME_MAX)
  } catch {
    return ''
  }
}

// Same charset as name_is_sane in ~/.claude/session-name-ssot.sh: a tool result quoting this mark must not become a manual name.
const RENAME_LINE = new RegExp(`${RENAME_MARK}([a-zA-Z0-9 ._-]{3,${NAME_MAX}})</local-command-stdout>`, 'g')

export function renameFromTranscript(blob) {
  if (!blob) return ''
  const names = [...blob.matchAll(RENAME_LINE)].map((m) => m[1].trim()).filter((n) => n.length >= 3)
  return names.at(-1) ?? ''
}

export function readPublishedName(dir, id) {
  if (!id || !SAFE_ID.test(id)) return ''
  try {
    return readFileSync(join(dir, id), 'utf8').trim().slice(0, NAME_MAX)
  } catch {
    return ''
  }
}

export function isManualName(scoreDir, id) {
  return Boolean(id) && existsSync(join(scoreDir, `${id}.manual`))
}

export function publishSessionName(nameDir, scoreDir, id, name, manual) {
  if (!id || !SAFE_ID.test(id) || !name) return false
  mkdirSync(nameDir, { recursive: true })
  writeFileSync(join(nameDir, id), name)
  if (manual) {
    mkdirSync(scoreDir, { recursive: true })
    writeFileSync(join(scoreDir, `${id}.manual`), '')
  }
  return true
}

export function tailFile(path, bytes = TAIL_BYTES) {
  try {
    const size = statSync(path).size
    if (size <= bytes) return readFileSync(path, 'utf8')
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      readSync(fd, buf, 0, bytes, size - bytes)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * Copy the latest /rename from the transcript into the name file.
 * Returns the name written, or '' when nothing changed.
 */
export function syncRenameFromTranscript({
  home,
  sessionId,
  transcriptPath,
  full = false
}) {
  if (!home || !sessionId || !SAFE_ID.test(sessionId) || !transcriptPath) return ''
  const blob = full
    ? existsSync(transcriptPath)
      ? readFileSync(transcriptPath, 'utf8')
      : ''
    : tailFile(transcriptPath)
  const name = renameFromTranscript(blob)
  if (!name) return ''
  const names = sessionNameDir(home)
  const scores = sessionScoreDir(home)
  if (readPublishedName(names, sessionId) === name && isManualName(scores, sessionId)) {
    return ''
  }
  publishSessionName(names, scores, sessionId, name, true)
  return name
}
