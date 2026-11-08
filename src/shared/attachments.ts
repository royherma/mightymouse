// Shared attachment classification — the ONE place a file path → AttachmentKind
// mapping lives, so the native picker (main) and drag-drop (renderer) agree. Kept
// in src/shared so both sides import the same logic instead of duplicating extension
// lists. The backend-side encoding (image-vision.ts, attachments.ts) is separate;
// this is purely "what kind of thing is this path".
import type { AttachmentKind, AttachmentSummary, MediaAttachment } from './types'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.caf'])

function ext(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = slash !== -1 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf('.')
  return dot !== -1 ? name.slice(dot).toLowerCase() : ''
}

/** Basename of a path (handles / and \ separators). */
export function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash !== -1 ? path.slice(slash + 1) : path
}

/** Infer the attachment kind from a path's extension. Anything not an image or a
 *  known audio format is treated as a generic 'file'. */
export function classifyAttachment(path: string): AttachmentKind {
  const e = ext(path)
  if (IMAGE_EXTS.has(e)) return 'image'
  if (AUDIO_EXTS.has(e)) return 'audio'
  return 'file'
}

/** Build a MediaAttachment from a path, inferring kind + display name. */
export function toAttachment(path: string): MediaAttachment {
  return { path, kind: classifyAttachment(path), name: basename(path) }
}

/** Roll a MediaAttachment list up into a by-kind count (audit + analytics).
 *  Returns all-zeros for an empty/undefined list. Shape: {@link AttachmentSummary}. */
export function summarizeAttachments(attachments?: MediaAttachment[]): AttachmentSummary {
  const summary: AttachmentSummary = { count: 0, images: 0, audio: 0, files: 0 }
  if (!attachments) return summary
  for (const a of attachments) {
    summary.count++
    if (a.kind === 'image') summary.images++
    else if (a.kind === 'audio') summary.audio++
    else summary.files++
  }
  return summary
}

/** File-dialog filter list for the attachment picker (images, audio, then all). */
export const ATTACHMENT_DIALOG_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
  { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'aiff', 'caf'] },
  { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'csv', 'json', 'html'] },
  { name: 'All Files', extensions: ['*'] }
]

/** Video is the one kind `classifyAttachment` has no word for -- it answers
 *  'file' for an .mp4 -- and only the chat surface renders one, so the list
 *  lives beside it rather than widening AttachmentKind for one consumer. */
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm'])

/** One turn's renderable media, in the order the phone indexes it.
 *
 *  ONE function, called by both the chat sender and the /chat-media route,
 *  because the wire ships positions rather than paths: if the two sides ever
 *  ordered this list differently, a credential would fetch a different file
 *  than the bubble asked for. Sources (what the user attached) come before
 *  artifacts (what the agent made), so a turn reads in the order it happened.
 *
 *  Lives in shared/ and takes the two arrays rather than a MightyTurn: the
 *  route that calls it must not import main/, which reaches Electron through
 *  run-mighty and takes 84 tests down with it. */
export function turnMedia(
  sources: string[] | undefined,
  artifacts: string[] | undefined
): { path: string; kind: 'image' | 'video'; mine: boolean }[] {
  const out: { path: string; kind: 'image' | 'video'; mine: boolean }[] = []
  const add = (path: string, mine: boolean): void => {
    const e = path.slice(path.lastIndexOf('.')).toLowerCase()
    if (VIDEO_EXTS.has(e)) out.push({ path, kind: 'video', mine })
    else if (classifyAttachment(path) === 'image') out.push({ path, kind: 'image', mine })
  }
  for (const p of sources ?? []) add(p, true)
  for (const p of artifacts ?? []) add(p, false)
  return out
}

/** Paths first, then the prose: a path trailing a sentence reads as part of it. */
export function agentMessageBody(paths: string[], text: string): string {
  return [...paths, text].filter((part) => part !== '').join('\n')
}

const PATH_LINE = /^(?:\/|~\/)\S.*\.[A-Za-z0-9]{1,8}$/
const SCREEN_HEADER = /^\[on screen: [^\n]*\]\n(?:\S+\n)?\n/
const BROWSER_HEADER = /^\[in the Browser tab: [^\n]*\]\n/
const PAGE_TAG_MAX = 300

export function browserPageTag(page: { url: string; title: string }): string {
  const title = page.title.replace(/\s+/g, ' ').trim().slice(0, 120)
  const where = `${title ? `"${title}" ` : ''}${page.url.replace(/\s+/g, '')}`.slice(0, PAGE_TAG_MAX)
  return `[in the Browser tab: ${where} - browser_read sees it; work in the background, touch the page only if the job needs it]\n`
}
const LEGACY_SCREENSHOT = /\n\nScreenshot: (\/[^\n]+)$/
const PASTED_IMAGE = /\[Image #\d+\]\s*/g

/** Inverse of `agentMessageBody`: what the person said, and the files that rode along. */
export function splitAgentMessage(body: string): { text: string; paths: string[] } {
  const lines = body.split('\n')
  const paths: string[] = []
  while (lines.length > 0 && PATH_LINE.test(lines[0].trim())) paths.push((lines.shift() as string).trim())
  let text = lines.join('\n')
  const legacy = LEGACY_SCREENSHOT.exec(text)
  if (legacy) {
    paths.push(legacy[1].trim())
    text = text.slice(0, legacy.index)
  }
  return { text: text.replace(SCREEN_HEADER, '').replace(BROWSER_HEADER, '').replace(PASTED_IMAGE, '').trim(), paths }
}

/** One message's identity across our own record and the agent's transcript, which spell it differently. */
export function agentMessageKey(text: string): string {
  return splitAgentMessage(text).text.replace(/\s+/g, ' ')
}

/** Keep only the usable paths off a wire payload no renderer is trusted to shape. */
export function cleanAttachmentPaths(paths: unknown): string[] {
  return Array.isArray(paths)
    ? paths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : []
}
