/**
 * Where a session's one-line subject is kept between app runs.
 *
 * The live session map is in-memory on purpose (http-listener.ts) -- a session
 * must not outlive an app restart the agent never saw. But the SUBJECT should:
 * an agent that said what it was doing an hour ago should not have to say it
 * again because the app was relaunched, and it has no way to know that it must.
 *
 * So the line is written here, and the shim reads it back on its next connect
 * and hands it over in the facts header. Deliberately the same shape as the
 * naming hook's `~/.claude/.session-names/<id>`: one short file per session id,
 * named for the id, holding one line. The shim already watches that directory,
 * so recovering this one costs it a `readFileSync` of a file it knows the path
 * of -- never a transcript read, which is the cost the facts header exists to
 * avoid (mightymouse-code.js).
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** The longest TLDR a row will hold. One plain line on a phone card, so the cap
 *  is about what fits there, not about what the transport can carry.
 *  Lives here, not in http-listener: verbs.ts reads it at module scope and
 *  http-listener imports verbs back through build-server, so declaring it there
 *  is a TDZ crash on boot. */
export const TLDR_MAX = 120

/** Shortest prefix `recap` resolves. 8 = what `mm-relay sessions` prints, so
 *  anything shorter was typed, not copied -- and a unique typo still lands. */
export const SESSION_ID_MIN_PREFIX = 8

/** Same root as the naming hook's directory, one level along. */
function tldrDir(): string {
  return join(process.env.HOME || homedir(), '.claude', '.session-tldr')
}

/** A session id comes off a header, so it reaches a path join untrusted. Only
 *  the shape Claude Code and Codex actually issue is allowed through -- anything
 *  with a separator or a dot in it is refused rather than sanitised, because a
 *  cleaned-up id would silently address a different session's file. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

function fileFor(sessionId: string): string | null {
  const id = sessionId.trim()
  return SAFE_ID.test(id) ? join(tldrDir(), id) : null
}

/** Best-effort by construction: a home directory that cannot be written is a
 *  reason to lose the line across a restart, never to fail the agent's call. */
export function persistSessionTldr(sessionId: string, text: string): void {
  const file = fileFor(sessionId)
  if (!file) return
  const line = text.trim()
  try {
    if (!line) {
      // Cleared, not blanked: an empty file would read back as a session whose
      // subject is the empty string and keep overriding a later reclaim.
      rmSync(file, { force: true })
      return
    }
    mkdirSync(tldrDir(), { recursive: true })
    writeFileSync(file, `${line}\n`, 'utf8')
  } catch {
    // No home, read-only disk, a race with a cleanup -- all mean the same thing
    // here: this session's subject simply will not survive the next restart.
  }
}

/** Marks this session's subject as DECLARED by its agent, so the Stop-hook
 *  generator (`~/.claude/session-recap-ai.sh`) leaves it alone. The generator
 *  reads the opening prompt; an agent that called `recap` knows what the work
 *  actually turned into, so it outranks a model summarising the first message.
 *  Same precedence rule the naming hook uses for a hand-typed `/rename`.
 *
 *  A directory, not a file: `mkdir` is atomic, which is what makes the marker
 *  safe against two Stops landing together. */
export function markSessionTldrDeclared(sessionId: string): void {
  const id = sessionId.trim()
  if (!SAFE_ID.test(id)) return
  try {
    const dir = join(process.env.HOME || homedir(), '.claude', '.session-recap-marks')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, `${id}.manual`), { recursive: true })
  } catch {
    // Best-effort, exactly like the write above: failing to claim the marker
    // costs a generated line overwriting a declared one, never the agent's call.
  }
}

/** The persisted line, or undefined when nothing was ever written. Used by the
 *  local recovery path, the same way publishedNameFor recovers a name. */
export function persistedSessionTldr(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  const file = fileFor(sessionId)
  if (!file) return undefined
  try {
    return readFileSync(file, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
