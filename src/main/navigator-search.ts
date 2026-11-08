import { open, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { MIGHTY } from './store/mighty'
import { CONFIG } from '../shared/config'
import { buildSnippet, fuzzyMatch, type FuzzyMatch, type Snippet } from '../shared/fuzzy'
import type { MightySession } from '../shared/types'
import type { NavigatorContentHit, NavigatorSearchRef } from '../shared/navigator-targets'

const CLAUDE_TRANSCRIPTS = join(homedir(), '.claude', 'projects')
const READ_CHUNK_BYTES = 8 * 1024 * 1024
const MIN_QUERY_CHARS = 2
const MAX_CHAT_HITS = 30
const SNIPPET_WINDOW = 400
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

interface Doc {
  text: string
  lower: string
}

interface Transcript extends Doc {
  size: number
  carry: Buffer
}

const chatDocs = new WeakMap<Readonly<MightySession>, Doc>()
const transcripts = new Map<string, Transcript>()
const reading = new Map<string, Promise<Transcript | null>>()

function claudeTranscriptPath(sessionId: string, cwd: string): string {
  return join(CLAUDE_TRANSCRIPTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
}

function queryWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

function matchAll(doc: Doc, words: string[]): FuzzyMatch | null {
  let first: FuzzyMatch | null = null
  for (const w of words) {
    const m = fuzzyMatch(doc.lower, w)
    if (m.index < 0) return null
    first ??= m
  }
  return first
}

function snippet(doc: Doc, match: FuzzyMatch): Snippet {
  const from = Math.max(0, match.index - SNIPPET_WINDOW)
  const window = doc.text.slice(from, match.index + SNIPPET_WINDOW)
  return buildSnippet(window, { ...match, index: match.index - from })
}

function chatDoc(session: Readonly<MightySession>): Doc {
  let doc = chatDocs.get(session)
  if (!doc) {
    const text = session.turns.flatMap((t) => [t.q, t.a]).join('\n')
    doc = { text, lower: text.toLowerCase() }
    chatDocs.set(session, doc)
  }
  return doc
}

function lineText(line: string): string {
  if (line.includes('"isMeta":true')) return ''
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return ''
  try {
    const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (b): b is { type: 'text'; text: string } =>
                  b?.type === 'text' && typeof b.text === 'string'
              )
              .map((b) => b.text)
              .join('\n')
          : ''
    return text.replace(SYSTEM_REMINDER, '').trim()
  } catch {
    return ''
  }
}

async function readTranscript(path: string): Promise<Transcript | null> {
  const st = await stat(path).catch(() => null)
  if (!st) return null
  let doc = transcripts.get(path)
  if (doc && doc.size === st.size) return doc
  if (!doc || st.size < doc.size) doc = { size: 0, carry: Buffer.alloc(0), text: '', lower: '' }
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return doc.size > 0 ? doc : null
  const parts: string[] = []
  let { size: pos, carry } = doc
  try {
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, st.size - pos))
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const all = Buffer.concat([carry, buf.subarray(0, bytesRead)])
      const cut = all.lastIndexOf(0x0a)
      carry = Buffer.from(all.subarray(cut + 1))
      if (cut < 0) continue
      for (const line of all.subarray(0, cut).toString('utf8').split('\n')) {
        const text = lineText(line)
        if (text) parts.push(text)
      }
    }
  } finally {
    await fh.close()
  }
  const added = parts.join('\n')
  const next: Transcript = {
    size: pos,
    carry,
    text: doc.text ? `${doc.text}\n${added}` : added,
    lower: doc.lower ? `${doc.lower}\n${added.toLowerCase()}` : added.toLowerCase()
  }
  transcripts.set(path, next)
  return next
}

function transcript(path: string): Promise<Transcript | null> {
  const pending = reading.get(path)
  if (pending) return pending
  const run = readTranscript(path)
    .catch(() => transcripts.get(path) ?? null)
    .finally(() => reading.delete(path))
  reading.set(path, run)
  return run
}

function searchChats(words: string[]): NavigatorContentHit[] {
  return MIGHTY.readSessions()
    .filter((s) => s.turns.length > 0)
    .sort((a, b) => (a.updated < b.updated ? 1 : -1))
    .flatMap((s) => {
      const doc = chatDoc(s)
      const title = s.title.toLowerCase()
      const match = matchAll(doc, words)
      if (!match && !words.every((w) => title.includes(w))) return []
      return [
        {
          id: `chat:${s.id}`,
          title: s.title || CONFIG.UI_LABELS.UNTITLED_CHAT,
          snippet: match ? snippet(doc, match) : null
        }
      ]
    })
    .slice(0, MAX_CHAT_HITS)
}

export async function searchConversations(
  query: string,
  refs: NavigatorSearchRef[]
): Promise<NavigatorContentHit[]> {
  const docs = await Promise.all(
    refs.map((r) => transcript(claudeTranscriptPath(r.sessionId, r.cwd)))
  )
  const words = queryWords(query)
  if (words.join('').length < MIN_QUERY_CHARS) return []
  const sessions = refs.flatMap((r, i) => {
    const doc = docs[i]
    const match = doc && matchAll(doc, words)
    return match ? [{ id: r.id, title: '', snippet: snippet(doc, match) }] : []
  })
  return [...searchChats(words), ...sessions]
}
