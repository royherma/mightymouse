import { existsSync } from 'fs'
import { open, stat } from 'fs/promises'
import { homedir } from 'os'
import { MIGHTY } from './store/mighty'
import { CONFIG } from '../shared/config'
import { buildSnippet, fuzzyMatch, type FuzzyMatch, type Snippet } from '../shared/fuzzy'
import { hasRealExchange, type MightySession } from '../shared/types'
import type { NavigatorContentHit, NavigatorSearchRef } from '../shared/navigator-targets'
import { nameFromMessage } from '../shared/relay-status'
import type { AgentTranscriptTurn } from '../shared/types'
import { claudeTranscriptPaths, readSessionTranscript, type TranscriptSession } from './agent-relay/session-transcript'

export type ResolveSession = (ref: string) => TranscriptSession | undefined
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
const turnDocs = new WeakMap<AgentTranscriptTurn[], Doc>()
const transcripts = new Map<string, Transcript>()
const reading = new Map<string, Promise<Transcript | null>>()

function turnsDoc(turns: AgentTranscriptTurn[]): Doc {
  let doc = turnDocs.get(turns)
  if (!doc) {
    const text = turns.filter((t) => t.role !== 'tool').map((t) => t.text).join('\n')
    doc = { text, lower: text.toLowerCase() }
    turnDocs.set(turns, doc)
  }
  return doc
}

async function sessionDoc(
  ref: NavigatorSearchRef,
  resolve: ResolveSession
): Promise<{ doc: Doc | null; title: string }> {
  const session = resolve(ref.sessionId)
  const turns = session ? readSessionTranscript(session) : []
  const title = nameFromMessage(turns.find((t) => t.role === 'you')?.text) ?? ''
  const claudeFile = claudeTranscriptPaths(homedir(), ref.cwd, ref.sessionId).find((p) => existsSync(p))
  const full = claudeFile ? await transcript(claudeFile) : null
  return { doc: full ?? (turns.length ? turnsDoc(turns) : null), title }
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
    .filter(hasRealExchange)
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
  refs: NavigatorSearchRef[],
  resolve: ResolveSession = () => undefined
): Promise<NavigatorContentHit[]> {
  const docs = await Promise.all(refs.map((r) => sessionDoc(r, resolve)))
  const words = queryWords(query)
  if (words.length === 0) return refs.flatMap((r, i) => (docs[i].title ? [{ id: r.id, title: docs[i].title, snippet: null }] : []))
  if (words.join('').length < MIN_QUERY_CHARS) return []
  const sessions = refs.flatMap((r, i) => {
    const { doc, title } = docs[i]
    const match = doc && matchAll(doc, words)
    return match ? [{ id: r.id, title, snippet: snippet(doc, match) }] : []
  })
  return [...searchChats(words), ...sessions]
}
