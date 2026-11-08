import { spawn } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { builtTagCounts, cleanTag, type BuiltItem } from '../../shared/built'
import { BACKENDS } from '../backend/adapters'
import { shell } from '../platform'
import { MIGHTY } from '../store/mighty'
import { PATHS } from '../store/paths'

const TAGS_FILE = join(PATHS.MIGHTY_DIR, 'built-tags.json')
const BATCH = 60
const MAX_TAGS = 2
const RETRY_AFTER_MS = 10 * 60_000
const RUN_TIMEOUT_MS = 120_000

let tags: Record<string, string[]> | null = null
let tagging = false
let failedAt = 0

function load(): Record<string, string[]> {
  if (tags) return tags
  try {
    tags = JSON.parse(readFileSync(TAGS_FILE, 'utf8')) as Record<string, string[]>
  } catch {
    tags = {}
  }
  return tags
}

function save(): void {
  mkdirSync(dirname(TAGS_FILE), { recursive: true })
  writeFileSync(TAGS_FILE, JSON.stringify(load()))
}

const tidy = (list: string[]): string[] => [...new Set(list.map(cleanTag).filter(Boolean))]

export function withTags(items: BuiltItem[]): BuiltItem[] {
  const t = load()
  return items.map((i) => (t[i.id]?.length ? { ...i, tags: t[i.id] } : i))
}

export function setBuiltTags(id: string, next: string[]): void {
  load()[id] = tidy(next)
  save()
}

function where(item: BuiltItem): string {
  if (item.url && item.kind === 'online') return 'published page'
  if (item.file) return item.file.split('/').pop() ?? ''
  return item.command ?? 'local app'
}

function prompt(project: string, used: string[], batch: BuiltItem[]): string {
  const lines = batch.map((item, n) => `${n + 1}. ${item.title} | chat: ${item.chat ?? '-'} | ${where(item)}`)
  return [
    `These are pages, tools and apps an AI agent built in the project "${project}".`,
    `Sort them so the owner can find things: give each 1 or ${MAX_TAGS} tags for what it is FOR.`,
    'A tag is 1-2 plain words, capitalised, like "Ads", "Videos", "Dashboards", "Review pages", "Landing pages".',
    'Aim for 4-10 tags across the whole project - broad buckets, not one tag per item.',
    used.length ? `Tags already in use here - reuse them where they fit: ${used.join(', ')}` : '',
    'Reply with only JSON mapping each number to its tags, e.g. {"1":["Ads"],"2":["Videos","Review pages"]}.',
    '',
    ...lines
  ]
    .filter((l) => l !== '')
    .join('\n')
}

function ask(text: string): Promise<string | null> {
  const bin = BACKENDS.claude.binPath ?? ''
  if (!bin) return Promise.resolve(null)
  return new Promise((resolve) => {
    const args = ['-p', text, '--model', 'haiku', '--tools', '', '--no-session-persistence', '--output-format', 'text']
    const child = spawn(bin, args, { env: shell.env(), cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out : null)
    })
  })
}

function parse(reply: string | null): Record<string, string[]> | null {
  const json = reply?.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
  try {
    return json ? (JSON.parse(json) as Record<string, string[]>) : null
  } catch {
    return null
  }
}

export function autoTagBuilt(items: BuiltItem[], onTagged: () => void): void {
  if (tagging || Date.now() - failedAt < RETRY_AFTER_MS) return
  const t = load()
  const todo = items.filter((i) => !(i.id in t))
  if (todo.length === 0) return
  tagging = true
  const names = new Map(MIGHTY.listProjects().map((p) => [p.id, p.name]))
  const byProject = new Map<string, BuiltItem[]>()
  for (const item of todo) byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item])
  void (async () => {
    try {
      for (const [projectId, list] of byProject) {
        for (let i = 0; i < list.length; i += BATCH) {
          const batch = list.slice(i, i + BATCH)
          const used = builtTagCounts(withTags(items.filter((x) => x.projectId === projectId))).map(([tag]) => tag)
          const reply = parse(await ask(prompt(names.get(projectId) ?? 'this project', used, batch)))
          if (!reply) {
            failedAt = Date.now()
            console.warn('[built] auto-tag failed; retrying in 10 min')
            return
          }
          batch.forEach((item, n) => {
            const got = reply[String(n + 1)]
            t[item.id] = Array.isArray(got) ? tidy(got.map(String)).slice(0, MAX_TAGS) : []
          })
          save()
          onTagged()
        }
      }
    } finally {
      tagging = false
    }
  })()
}
