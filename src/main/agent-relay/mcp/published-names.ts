/**
 * A LOCAL-ONLY fallback for sessions whose shim never told us their name.
 *
 * The durable path is the wire: the shim sends its name in a header, which works
 * over any transport and is the only thing that can work once an agent runs off
 * this Mac. But a shim that booted before that header existed cannot send it and
 * cannot reconnect while the app stays up, so its row is stuck showing the
 * 8-char session-id head the shim derived instead. Claude Code's naming hook has
 * meanwhile written the real name to a file named after the full session id, and
 * that head is its prefix -- so on this machine we can recover the name the row
 * should have had. Off this machine there is no directory to read, the lookup
 * simply finds nothing, and the header path carries the name as it always did.
 */

import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Where Claude Code's naming hook publishes `<session-id>` -> chosen name. */
function nameDir(): string {
  return join(process.env.HOME || homedir(), '.claude', '.session-names')
}

/** The shim's fallback tag is exactly 8 hex chars — the head of a session id.
 *  Anything else is a name a person or a host already chose, so it is left be. */
const ID_HEAD = /^[0-9a-f]{8}$/i

/** One readdir serves every row in a render pass. Sessions are named once and
 *  the list re-renders on every card, so re-reading the directory per row turned
 *  a hover into hundreds of stat calls. */
let cache: { at: number; files: string[] } | null = null
const CACHE_MS = 5_000

function nameFiles(): string[] {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_MS) return cache.files
  let files: string[] = []
  try {
    files = readdirSync(nameDir())
  } catch {
    // No naming hook on this machine, which is the normal case for most users.
  }
  cache = { at: now, files }
  return files
}

/** Test seam: the cache would otherwise carry one test's directory into the next. */
export function clearPublishedNameCache(): void {
  cache = null
}

/**
 * The name published for a session id head, or undefined when nothing matches.
 * `head` is the 8-char tag the shim derived; the file is named for the full id.
 */
export function publishedNameFor(head: string | undefined): string | undefined {
  if (!head || !ID_HEAD.test(head)) return undefined
  const match = nameFiles().find((f) => f.startsWith(head.toLowerCase()))
  if (!match) return undefined
  try {
    // Bounded because this lands in a row: the hook writes one short line, but a
    // truncated name still renders where an unbounded read could break the list.
    return readFileSync(join(nameDir(), match), 'utf8').trim().slice(0, 60) || undefined
  } catch {
    return undefined
  }
}
