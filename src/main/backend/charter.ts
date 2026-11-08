/**
 * charter.ts — composes the agent charter (mission + principles) into the single
 * block that prepends to EVERY mode prompt and EVERY backend.
 *
 * The charter is the agent's governing document: who it is (mission.md) and how
 * it decides when things conflict (principles.md). It lives in markdown so it is
 * diffable and tweakable without a recompile; this module reads those files,
 * strips their HTML-comment authoring headers, joins them in CHARTER_FILES order,
 * and hands back one string.
 *
 * Backend-agnostic by construction: this runs in prompt assembly (prompts.ts /
 * ipc.ts), BEFORE the adapter layer ever sees the prompt. Local `claude`/`codex`
 * and the paid `mightymouse` proxy all inherit the identical charter. There is no
 * per-backend branch here, on purpose (mirrors the no-`if (backend === ...)` rule).
 *
 * Resolution + safety:
 *  - Files are found relative to the charter dir (repo root in dev, app path when
 *    packaged). Resolution tries a few roots so it works in both.
 *  - The composed string is cached after first read (it is sent on every request;
 *    re-reading disk per call would be wasteful). Call resetCharterCache() in
 *    tests or after editing the md to force a re-read.
 *  - If the files cannot be read (unexpected packaging), composeCharter NEVER
 *    returns empty: it falls back to CHARTER_FALLBACK so the agent always has its
 *    governing rules. A charterless prompt is the one outcome we refuse to ship.
 */
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import { devLog } from '../../shared/env'
import { CHARTER_FILES, CHARTER_VERSION } from '../../../agent-charter/version'

/** Strip the leading HTML authoring comment (<!-- ... -->) from a charter md file. */
function stripHeader(md: string): string {
  return md.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim()
}

/**
 * Candidate directories that may contain the agent-charter/*.md files. Tried in
 * order; the first that holds the first charter file wins. Covers: dev (repo
 * root via cwd), packaged (app path / resources), and this module's own location.
 */
function charterDirCandidates(): string[] {
  const dirs: string[] = []
  // 1. Packaged + dev: the Electron app path is the project root in dev and the
  //    app.asar (or unpacked) root when packaged.
  try {
    if (app?.getAppPath) dirs.push(join(app.getAppPath(), 'agent-charter'))
  } catch {
    // app not available (pure-node test context) — fall through to cwd.
  }
  // 2. Dev / tests: current working directory is the repo root.
  dirs.push(join(process.cwd(), 'agent-charter'))
  // 3. Relative to this compiled module, walking up out of out/main or src/main.
  try {
    dirs.push(join(dirname(__dirname), '..', '..', 'agent-charter'))
  } catch {
    // __dirname may be undefined in some bundlers — ignore.
  }
  return dirs
}

/** Resolve the charter directory by finding the first candidate that has mission.md. */
function resolveCharterDir(): string | null {
  for (const dir of charterDirCandidates()) {
    if (existsSync(join(dir, CHARTER_FILES[0]))) return dir
  }
  return null
}

let cached: string | null = null

/**
 * The composed charter block: mission + principles, header-comments stripped,
 * joined with blank lines, in CHARTER_FILES order. Cached after first call.
 *
 * Always returns a non-empty governing block: real files when found, else the
 * baked-in fallback (so a packaging miss degrades the prose, never removes the
 * rules). The result is meant to be PREPENDED to a mode prompt with a separator.
 */
export function composeCharter(): string {
  if (cached !== null) return cached
  const dir = resolveCharterDir()
  if (dir) {
    try {
      const parts = CHARTER_FILES.map((f) => stripHeader(readFileSync(join(dir, f), 'utf-8')))
      cached = parts.join('\n\n')
      return cached
    } catch (e) {
      devLog.warn('[charter] read failed, using fallback:', e)
    }
  } else {
    devLog.warn('[charter] agent-charter/ not found in any candidate dir, using fallback')
  }
  cached = CHARTER_FALLBACK
  return cached
}

/** Force a re-read on the next composeCharter() call (tests, or after editing md). */
export function resetCharterCache(): void {
  cached = null
}

/** Current charter version, surfaced for eval reports + telemetry. */
export function charterVersion(): number {
  return CHARTER_VERSION
}

/**
 * Last-resort governing rules, inlined so the agent is NEVER charterless even if
 * the md files fail to load in a packaged build. Keep this a faithful, compressed
 * mirror of mission.md + principles.md. If you change the md substantially, sync
 * the spirit of it here too.
 */
export const CHARTER_FALLBACK = `# MightyMouse — Agent Mission
Get the user what they actually want, faster than they could themselves. Read the intent, not just the literal words. Finish the task. Stay out of the way. Be warm and plain.

# How MightyMouse Decides
- Act, don't ask: make the most reasonable interpretation and do it. Never block on a clarifying question.
- Speed beats completeness: lead with the result, cut anything that does not change what the user does next.
- No preamble, no narration: output the result directly, no "Here is" / "Based on" / "Looking at your screen".
- Be honest about what you don't know: when answering from the user's own records, never invent. Say you don't have a record.
- Voice: plain, warm, short. Never use em dashes or en dashes in user facing output.`
