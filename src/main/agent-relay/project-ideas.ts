import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { withoutAttachments } from '../../shared/relay-status'
import {
  doneCheckPrompt,
  parseDoneCheck,
  parseProjectIdeas,
  projectIdeasPrompt,
  type ProjectIdeaCheck,
  type ProjectIdea,
  type ProjectIdeaFeedback,
  type ProjectIdeaVerdict,
  type ProjectIdeasResult,
  type ProjectSignals
} from '../../shared/project-ideas'
import { runBackend } from '../backend/runner'
import { projectBrief, projectBusiness } from './factory/execution'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'

const run = promisify(execFile)
const IDEAS = CONFIG.AGENT_RELAY.PROJECT_IDEAS
const CACHE_FILE = join(PATHS.ROOT, 'project-ideas.json')
const FEEDBACK_FILE = join(PATHS.ROOT, 'project-ideas-feedback.json')
const PLAN_DIRS = ['prds/active', 'docs/plans', 'plans']
const NOTE_FILES = ['TODO.md', 'ROADMAP.md', 'NEXT.md', 'PRODUCT.md', 'README.md']

type CacheEntry = { signature: string; ideas: ProjectIdea[]; at: number }
const inFlight = new Map<string, Promise<ProjectIdeasResult | null>>()

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout: IDEAS.GIT_TIMEOUT_MS,
      maxBuffer: 1 << 20
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

function lines(text: string, max: number): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max)
}

function plans(cwd: string): string[] {
  const out: string[] = []
  for (const dir of PLAN_DIRS) {
    const full = join(cwd, dir)
    if (!existsSync(full)) continue
    const files = readdirSync(full)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ f, t: statSync(join(full, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, IDEAS.MAX_PLANS)
    for (const { f } of files) {
      const head = readHead(join(full, f), 2048)
      const title = head.match(/^#\s+(.+)$/m)?.[1]?.trim()
      const status = head.match(/\*\*Status:\*\*\s*(.+)$/m)?.[1]?.trim()
      out.push([`${dir}/${f}`, title, status && `status: ${status}`].filter(Boolean).join(' - '))
    }
  }
  return out.slice(0, IDEAS.MAX_PLANS)
}

function readHead(path: string, bytes: number): string {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function notes(cwd: string): string | undefined {
  const file = NOTE_FILES.find((f) => existsSync(join(cwd, f)))
  return file ? `${file}:\n${readHead(join(cwd, file), IDEAS.NOTES_CHARS)}` : undefined
}

function firstAsk(path: string): string | undefined {
  for (const line of readHead(path, IDEAS.TRANSCRIPT_HEAD_BYTES).split('\n')) {
    if (!line.includes('"type":"user"')) continue
    try {
      const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
      const text = typeof content === 'string' ? withoutAttachments(content).trim() : ''
      if (text && !text.startsWith('<')) return text.replace(/\s+/g, ' ').slice(0, IDEAS.ASK_CHARS)
    } catch {
      continue
    }
  }
  return undefined
}

function transcriptDirs(cwd: string): string[] {
  const root = join(homedir(), '.claude', 'projects')
  return [...new Set([cwd.replace(/[/_.]/g, '-'), cwd.replace(/\//g, '-')])].map((slug) => join(root, slug))
}

const askBySession = new Map<string, string>()

function transcriptPath(cwd: string, sessionId: string): string | undefined {
  return transcriptDirs(cwd).map((dir) => join(dir, `${sessionId}.jsonl`)).find((f) => existsSync(f))
}

export function sessionFirstAsk(cwd: string, sessionId: string): string | undefined {
  const cached = askBySession.get(sessionId)
  if (cached) return cached
  const path = transcriptPath(cwd, sessionId)
  const ask = path ? firstAsk(path) : undefined
  if (ask) askBySession.set(sessionId, ask)
  return ask
}

const AI_TITLE_ROW = /"type":"ai-title","aiTitle":"((?:[^"\\]|\\.){3,200})"/g
const titleBySession = new Map<string, { at: number; title?: string }>()

function readTail(path: string, bytes: number): string {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(bytes, size))
    const n = readSync(fd, buf, 0, buf.length, size - buf.length)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function sessionAiTitle(cwd: string, sessionId: string): string | undefined {
  const cached = titleBySession.get(sessionId)
  if (cached && (cached.title || Date.now() - cached.at < IDEAS.TITLE_RECHECK_MS)) return cached.title
  const path = transcriptPath(cwd, sessionId)
  const last = path ? [...readTail(path, IDEAS.TITLE_TAIL_BYTES).matchAll(AI_TITLE_ROW)].at(-1)?.[1] : undefined
  let title: string | undefined
  try {
    title = last ? (JSON.parse(`"${last}"`) as string).trim() || undefined : undefined
  } catch {
    title = undefined
  }
  titleBySession.set(sessionId, { at: Date.now(), title })
  return title
}

function recentAsks(cwd: string): string[] {
  const files: Array<{ path: string; t: number }> = []
  for (const dir of transcriptDirs(cwd)) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      try {
        files.push({ path: join(dir, f), t: statSync(join(dir, f)).mtimeMs })
      } catch {
        continue
      }
    }
  }
  return files
    .sort((a, b) => b.t - a.t)
    .slice(0, IDEAS.MAX_ASKS * 2)
    .map((f) => firstAsk(f.path))
    .filter((a): a is string => Boolean(a))
    .slice(0, IDEAS.MAX_ASKS)
}

export async function gatherProjectSignals(
  cwd: string,
  name: string,
  titles: string[]
): Promise<ProjectSignals> {
  const [branch, status, log, ahead] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--short']),
    git(cwd, ['log', `-${IDEAS.MAX_COMMITS}`, '--format=%s (%cr)']),
    git(cwd, ['rev-list', '--count', '@{u}..HEAD'])
  ])
  return {
    name: name || basename(cwd),
    branch: branch || undefined,
    uncommitted: lines(status, IDEAS.MAX_DIRTY),
    unpushed: Number(ahead) || undefined,
    recentCommits: lines(log, IDEAS.MAX_COMMITS),
    plans: plans(cwd),
    notes: notes(cwd),
    recentAsks: recentAsks(cwd),
    sessionTitles: titles.slice(0, IDEAS.MAX_TITLES),
    feedback: readFeedback()[cwd],
    business: projectBusiness(cwd),
    brief: projectBrief(cwd)
  }
}

function signatureOf(s: ProjectSignals): string {
  const basis = [
    'detail',
    s.branch,
    s.uncommitted?.length,
    s.recentCommits?.[0],
    s.plans?.join('|'),
    s.recentAsks?.[0],
    s.sessionTitles?.join('|'),
    s.brief
  ]
  return createHash('sha1').update(JSON.stringify(basis)).digest('hex')
}

function readCache(): Record<string, CacheEntry> {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, CacheEntry>
  } catch {
    return {}
  }
}

function writeCache(cwd: string, entry: CacheEntry): void {
  const all = readCache()
  all[cwd] = entry
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(all))
  } catch (err) {
    devLog.log('[project-ideas] cache write failed', err)
  }
}

function readFeedback(): Record<string, ProjectIdeaFeedback[]> {
  try {
    return JSON.parse(readFileSync(FEEDBACK_FILE, 'utf8')) as Record<string, ProjectIdeaFeedback[]>
  } catch {
    return {}
  }
}

const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function projectIdeaFeedback(
  cwd: string,
  label: string,
  why: string | undefined,
  verdict: ProjectIdeaVerdict | null
): void {
  const all = readFeedback()
  const kept = (all[cwd] ?? []).filter((f) => !sameLabel(f.label, label))
  all[cwd] = (verdict ? [...kept, { label, why, verdict, at: Date.now() }] : kept).slice(-IDEAS.MAX_FEEDBACK)
  try {
    writeFileSync(FEEDBACK_FILE, JSON.stringify(all))
  } catch (err) {
    devLog.log('[project-ideas] feedback write failed', err)
  }
}

export function checkIdeaDone(cwd: string, label: string): Promise<ProjectIdeaCheck> {
  const idea = readCache()[cwd]?.ideas.find((i) => sameLabel(i.label, label))
  if (!idea) return Promise.resolve({ done: true })
  return new Promise<ProjectIdeaCheck>((resolve) => {
    void runBackend({
      backend: PREFS.getBackend(),
      runId: `project-idea-check:${randomUUID()}`,
      systemPrompt: '',
      userPrompt: doneCheckPrompt(idea),
      runDir: PATHS.TMP,
      workDir: cwd,
      timeoutMs: IDEAS.DONE_CHECK_TIMEOUT_MS,
      mode: 'ask',
      fast: true,
      lean: true,
      unattended: true,
      onPhase: () => {},
      onDone: (raw) => resolve(raw ? parseDoneCheck(raw) : { done: true })
    }).catch(() => resolve({ done: true }))
  }).then((check) => {
    devLog.log(`[project-ideas] done-check ${basename(cwd)} "${label}" ${JSON.stringify(check)}`)
    if (!check.done) reopenIdea(cwd, idea, check.reason)
    return check
  })
}

function reopenIdea(cwd: string, idea: ProjectIdea, reason: string): void {
  projectIdeaFeedback(cwd, idea.label, undefined, null)
  const entry = readCache()[cwd]
  if (!entry) return
  writeCache(cwd, {
    ...entry,
    ideas: entry.ideas.map((i) => (sameLabel(i.label, idea.label) ? { ...i, why: reason } : i))
  })
}

function withoutJudged(cwd: string, ideas: ProjectIdea[]): ProjectIdea[] {
  const judged = readFeedback()[cwd] ?? []
  return ideas.filter((i) => !judged.some((f) => sameLabel(f.label, i.label)))
}

function generate(
  cwd: string,
  signals: ProjectSignals,
  signature: string
): Promise<ProjectIdeasResult | null> {
  const existing = inFlight.get(cwd)
  if (existing) return existing
  const job = new Promise<ProjectIdeasResult | null>((resolve) => {
    const started = Date.now()
    void runBackend({
      backend: PREFS.getBackend(),
      runId: `project-ideas:${randomUUID()}`,
      systemPrompt: '',
      userPrompt: projectIdeasPrompt(signals),
      runDir: PATHS.TMP,
      timeoutMs: IDEAS.TIMEOUT_MS,
      mode: 'ask',
      fast: true,
      lean: true,
      onPhase: () => {},
      onDone: (raw) => {
        const ideas = raw ? withoutJudged(cwd, parseProjectIdeas(raw)) : []
        devLog.log(`[project-ideas] ${basename(cwd)} n=${ideas.length} ${Date.now() - started}ms`)
        if (ideas.length === 0) return resolve(null)
        const entry = { signature, ideas, at: Date.now() }
        writeCache(cwd, entry)
        resolve({ ideas, at: entry.at, stale: false })
      }
    }).catch(() => resolve(null))
  }).finally(() => inFlight.delete(cwd))
  inFlight.set(cwd, job)
  return job
}

export type ProjectIdeasMode = 'cached' | 'generate' | 'refresh'

export async function projectIdeas(
  cwd: string,
  name: string,
  titles: string[],
  mode: ProjectIdeasMode
): Promise<ProjectIdeasResult | null> {
  const entry = readCache()[cwd]
  const cached = entry && { ...entry, ideas: withoutJudged(cwd, entry.ideas) }
  if (mode === 'cached') return cached ? { ideas: cached.ideas, at: cached.at, stale: true } : null
  const signals = await gatherProjectSignals(cwd, name, titles)
  const signature = signatureOf(signals)
  const age = cached ? Date.now() - cached.at : Infinity
  const fresh =
    cached &&
    cached.ideas.length > 0 &&
    (age < IDEAS.MIN_REGEN_MS || (cached.signature === signature && age < IDEAS.TTL_MS))
  if (mode === 'generate' && fresh) return { ideas: cached.ideas, at: cached.at, stale: false }
  return generate(cwd, signals, signature)
}
