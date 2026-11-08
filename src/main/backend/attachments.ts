// attachments.ts — normalize a MediaAttachment[] into the per-backend forms each
// adapter needs. Translation lives in the adapters; this is the shared encoding
// layer they call, the file-side sibling of image-vision.ts.
//
// Capability reality per backend (verified against each CLI's real flag surface):
//   • images → ALL backends ingest natively (codex `-i`, claude Read off --add-dir,
//     mightymouse http base64 image block).
//   • files  → claude Reads any path; mightymouse http sends a `document` block;
//     codex has NO file flag (it only takes `-i` images) so its adapter inlines the
//     file's TEXT into the prompt. A binary file (PDF/docx) can't be inlined as text,
//     so codex degrades to a one-line "couldn't read" note — honest, never silent.
//   • audio  → NO backend ingests audio. Transcribed to text (Whisper) in a hud-run
//     pre-step BEFORE any adapter runs; audio attachments never reach here.
import { existsSync, readFileSync, statSync } from 'fs'
import { CONFIG } from '../../shared/config'
import type { MediaAttachment } from '../../shared/types'

/** Attachments grouped by kind, for adapters that fan out per-kind. */
export interface SplitAttachments {
  images: MediaAttachment[]
  files: MediaAttachment[]
  audio: MediaAttachment[]
}

/** Split a flat list into per-kind buckets (missing kinds → empty arrays). */
export function splitAttachments(attachments: readonly MediaAttachment[]): SplitAttachments {
  const out: SplitAttachments = { images: [], files: [], audio: [] }
  for (const a of attachments) {
    if (a.kind === 'image') out.images.push(a)
    else if (a.kind === 'audio') out.audio.push(a)
    else out.files.push(a)
  }
  return out
}

/** Display name for an attachment — its explicit name, else the path basename. */
export function attachmentName(a: MediaAttachment): string {
  if (a.name && a.name !== '') return a.name
  const slash = a.path.lastIndexOf('/')
  return slash !== -1 ? a.path.slice(slash + 1) : a.path
}

// Extensions we'll inline as UTF-8 text for the codex fallback. Anything else is
// treated as binary (can't be inlined as text) and gets the "couldn't read" note.
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.log', '.ts', '.tsx', '.js', '.jsx', '.py', '.rb',
  '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cc', '.sh', '.css', '.scss',
  '.sql', '.toml', '.ini', '.env', '.tex'
])

function ext(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot !== -1 ? path.slice(dot).toLowerCase() : ''
}

/** True if a path is a text file we can safely inline into a prompt as UTF-8. */
export function isTextFile(path: string): boolean {
  return TEXT_EXTS.has(ext(path))
}

/**
 * Read a text file's content for inlining into a prompt (codex's no-file-flag
 * fallback). Truncated to CONFIG.ATTACHMENT_INLINE_MAX_CHARS so one huge file can't
 * blow the context. Returns null for a missing/binary/unreadable file — the caller
 * turns that into a visible "couldn't read" note rather than failing the run.
 */
export function readFileText(path: string): string | null {
  if (!existsSync(path) || !isTextFile(path)) return null
  try {
    const max = CONFIG.ATTACHMENT_INLINE_MAX_CHARS
    const text = readFileSync(path, 'utf8')
    return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text
  } catch {
    return null
  }
}

/**
 * Build the prompt-inline block codex gets for FILE attachments (it has no file
 * flag — only `-i` for images). Each text file is fenced with its name; each binary
 * file gets a one-line note that codex can't read it (switch to claude for those).
 * Returns '' when there are no file attachments, so callers can concat blindly.
 */
export function inlineFilesForPrompt(files: readonly MediaAttachment[]): string {
  if (files.length === 0) return ''
  const parts: string[] = []
  for (const f of files) {
    const name = attachmentName(f)
    const text = readFileText(f.path)
    if (text !== null) {
      parts.push(`--- attached file: ${name} ---\n${text}\n--- end ${name} ---`)
    } else {
      parts.push(
        `--- attached file: ${name} (binary — this backend can't read it; ask the user to switch to the Claude backend to view it) ---`
      )
    }
  }
  return `\n\n${parts.join('\n\n')}`
}

/** A base64 document payload for the http `document` content block. */
export interface DocumentPayload {
  /** MIME type, e.g. application/pdf or text/plain. */
  mediaType: string
  /** Base64-encoded file bytes. */
  data: string
  /** Filename for display / citations. */
  name: string
}

// MIME type by extension for the http document block. Defaults to text/plain for
// known text files and application/octet-stream otherwise (the proxy decides what
// it accepts; we just label it honestly).
const DOC_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html'
}

/**
 * Load FILE attachments as base64 document payloads for the http path's `document`
 * content blocks. Skips oversized files (> CONFIG.ATTACHMENT_DOC_MAX_BYTES) and
 * unreadable paths — callers get back only what's safe to send.
 */
export function loadDocumentsForHttp(files: readonly MediaAttachment[]): DocumentPayload[] {
  const out: DocumentPayload[] = []
  for (const f of files) {
    if (!existsSync(f.path)) continue
    try {
      if (statSync(f.path).size > CONFIG.ATTACHMENT_DOC_MAX_BYTES) continue
      const bytes = readFileSync(f.path)
      out.push({
        mediaType: DOC_MIME[ext(f.path)] ?? 'application/octet-stream',
        data: bytes.toString('base64'),
        name: attachmentName(f)
      })
    } catch {
      /* unreadable file → skip; never fail the whole run for one bad path */
    }
  }
  return out
}
