import { existsSync, readFileSync, appendFileSync, copyFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'
import { PREFS } from './prefs'
import { encryptLine, decryptLine, isEncryptedLine, isEncryptionAvailable } from './safe-storage'
import {
  HistoryEntry,
  HistoryItem,
  RunFailReason,
  SelectionBarHistoryItem
} from '../../shared/types'

// UTC timestamp for a new history row, milliseconds stripped but the `Z` KEPT.
// Dropping the Z makes `new Date(ts)` in the renderer parse the instant as LOCAL
// instead of UTC, shifting every entry by the UTC offset (showed "7h ago" for a
// just-now request). Keep the Z so the string stays an unambiguous UTC instant.
export function historyTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

// Cap on `result_detail`. Unbounded stderr in a JSONL row is how a 6.6MB history
// becomes a 60MB one.
const DETAIL_MAX_CHARS = 200

// One line of selection at the bar's width. Longer just wraps into nothing useful.
const BAR_PREVIEW_CHARS = 48

// First N chars of raw stderr (or a thrown message) — what turns a bare `error`
// reason into a debuggable line. LOCAL FILE ONLY: never sent to the cloud, since
// process chatter carries file paths, selection text, and occasionally secrets.
export function failDetail(text: string): string | undefined {
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, DETAIL_MAX_CHARS)
}

// Parse a history row's `ts` to a Date, defaulting a tz-less legacy stamp to UTC.
// Moved here from ipc.ts so date-range retrieval and analytics share one parser.
// LEGACY rows were saved naive (`2026-05-30T09:33:43`), which `new Date()` reads as
// LOCAL — appending `Z` when no tz designator is present keeps every row on the same
// UTC instant it was recorded in.
export function parseTs(ts: string): Date {
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(ts)
  return new Date(hasTz ? ts : ts + 'Z')
}

// ── Warm in-memory cache ───────────────────────────────────────────────────────
// The JSONL is parsed once per app session into this array; append() pushes to it
// so reads never re-touch disk after the first load. At a heavy 30 runs/day this is
// ~11k rows/year — a few MB of JS objects, trivially cached. Sqlite/qmd is the named
// upgrade seam (see PRD) once a real user crosses ~20k rows.
let _cache: HistoryEntry[] | null = null
let _appendCount = 0

// Fires after every successful append so an open History flyout can refresh live
// instead of needing a reopen. In-memory, single listener — index/ipc wires it to
// push fresh rows to the panel. Decoupled like UNREAD: this store never imports the
// window layer, so no import cycle.
let _onAppend: (() => void) | null = null

/** Decode one stored line to a HistoryEntry, or null if it can't be read. */
function decodeLine(line: string): HistoryEntry | null {
  const plain = decryptLine(line) // legacy plaintext passes through; encrypted decrypts
  if (plain === null) return null // decrypt failed (wrong machine / corrupt) → skip row
  const t = plain.trim()
  if (t === '') return null
  try {
    return JSON.parse(t) as HistoryEntry
  } catch {
    return null
  }
}

/** Load + parse the whole history file into the cache (idempotent within a session). */
function loadCache(): HistoryEntry[] {
  if (_cache) return _cache
  const out: HistoryEntry[] = []
  if (existsSync(PATHS.HISTORY)) {
    try {
      const lines = readFileSync(PATHS.HISTORY, 'utf-8').split('\n')
      for (const line of lines) {
        if (line.trim() === '') continue
        const entry = decodeLine(line)
        if (entry) out.push(entry)
      }
    } catch (err) {
      console.error('Failed to read history:', err)
    }
  }
  _cache = out
  return out
}

/** Drop the cache so the next read re-loads from disk (after a format conversion). */
function invalidateCache(): void {
  _cache = null
}

// ── Backup-then-convert (encrypt ⇄ decrypt the whole file) ─────────────────────
// Roy's hard constraints: (1) never risk existing records, (2) the encryption state
// is a free-flip toggle. So every conversion COPIES the live file to a timestamped
// backup FIRST, writes the transformed file to a .tmp, then atomically renames over
// the original. ANY error leaves the original untouched and the backup in place.

/** Is the on-disk file already in the desired encryption state? Samples the first data line. */
function fileMatchesEncryptionState(wantEncrypted: boolean): boolean {
  if (!existsSync(PATHS.HISTORY)) return true // nothing to convert
  try {
    const lines = readFileSync(PATHS.HISTORY, 'utf-8').split('\n')
    const firstData = lines.find((l) => l.trim() !== '')
    if (!firstData) return true // empty file — no rows to convert
    return isEncryptedLine(firstData) === wantEncrypted
  } catch {
    return true // can't read → don't attempt a destructive convert
  }
}

/**
 * Reconcile the history file to the encryption toggle. Call once at startup.
 * No-op when the file already matches the desired state (so toggling churns nothing).
 * Returns the path of the backup written, or null if no conversion happened.
 */
export function reconcileHistoryEncryption(): string | null {
  const want = PREFS.getHistoryEncryption()
  // Asked to encrypt but the OS can't → leave plaintext, don't pretend.
  if (want && !isEncryptionAvailable()) {
    console.warn('history: encryption requested but safeStorage unavailable; staying plaintext')
    return null
  }
  if (fileMatchesEncryptionState(want)) return null
  if (!existsSync(PATHS.HISTORY)) return null

  const stamp = historyTimestamp().replace(/[:]/g, '-')
  const backupPath = join(PATHS.BACKUPS, `rewrite-history-${stamp}.jsonl`)
  const tmpPath = PATHS.HISTORY + '.tmp'

  try {
    // 1. Backup the live file untouched, BEFORE any transform.
    copyFileSync(PATHS.HISTORY, backupPath)

    // 2. Transform every line into the target form, writing to .tmp.
    const lines = readFileSync(PATHS.HISTORY, 'utf-8').split('\n')
    const outLines: string[] = []
    for (const line of lines) {
      if (line.trim() === '') continue
      const plain = decryptLine(line) // normalize to plaintext first
      if (plain === null) {
        // Can't read a row — keep it verbatim so we never DROP data on convert.
        outLines.push(line)
        continue
      }
      outLines.push(want ? encryptLine(plain) : plain)
    }
    writeFileSync(tmpPath, outLines.length ? outLines.join('\n') + '\n' : '', 'utf-8')

    // 3. Atomic swap. POSIX rename is atomic on the same filesystem.
    renameSync(tmpPath, PATHS.HISTORY)
    invalidateCache()
    console.log(`history: converted to ${want ? 'encrypted' : 'plaintext'}, backup at ${backupPath}`)
    return backupPath
  } catch (err) {
    // Leave the original + backup intact; surface but never throw on startup.
    console.error('history: encryption conversion failed (original left intact):', err)
    return null
  }
}

// ── Read / write ───────────────────────────────────────────────────────────────

export const HISTORY = {
  /** Register the post-append listener (ipc.ts wires this to push rows to the panel). */
  onAppend(fn: () => void): void {
    _onAppend = fn
  },

  append(entry: HistoryEntry): void {
    if (PREFS.getIncognito()) return
    try {
      const json = JSON.stringify(entry)
      const line = PREFS.getHistoryEncryption() ? encryptLine(json) : json
      appendFileSync(PATHS.HISTORY, line + '\n', 'utf-8')
      // Keep the warm cache in lockstep so reads never re-hit disk.
      if (_cache) _cache.push(entry)
      // Notify last, after the cache is consistent, so a live reader sees this row.
      _onAppend?.()
      // Soft-cap canary: log every 1000 rows as the signal to ship the sqlite/qmd
      // upgrade. Linear scan stays <200ms well past this; the warning is a tripwire.
      if (++_appendCount % 1000 === 0) {
        console.warn(`history: ${_cache?.length ?? '?'} rows — consider the sqlite/qmd upgrade seam`)
      }
    } catch (err) {
      console.error('Failed to append to history:', err)
    }
  },

  /**
   * Write the run's row at SPAWN, marked `pending`, before it has a result.
   *
   * Why this exists: every other append fires from a completion path, so a run the
   * app never saw finish (crash, force-quit, power loss) left NO row at all — an
   * hour of unattended work with zero evidence it ever happened. This row is that
   * evidence. The run's own completion re-writes the same run_id with no run_state,
   * and the latest-wins dedupe in readRecent/readByDate collapses the pair to the
   * settled row — so a normal run looks exactly as it did before.
   *
   * `ok: false` until proven otherwise: an unsettled run is not a success, and if
   * we never hear back that's the truth we want frozen on disk.
   */
  appendPending(entry: Omit<HistoryEntry, 'run_state' | 'ok'>): void {
    HISTORY.append({ ...entry, ok: false, run_state: 'pending' })
  },

  /**
   * All decoded entries, oldest→newest (skips unreadable rows). Backs analytics + recall.
   *
   * Returns a COPY: callers chain mutating array methods on this (`.reverse()` in the
   * resumeSession handler), and handing out the live cache let one of those flip the
   * shared array in place — every later readRecent then walked from the oldest row and
   * the History flyout rendered oldest-first until the app restarted.
   */
  readAllEntries(): HistoryEntry[] {
    return loadCache().slice()
  },

  /**
   * The typed failure on the LATEST row for `runId`, or null if it settled ok.
   * Walks backward because a run can be rewritten (ask turns, resumed acts) and
   * only the last row is the verdict.
   */
  failureFor(runId: string): { reason?: RunFailReason; detail?: string } | null {
    const entries = loadCache()
    for (let i = entries.length - 1; i >= 0; i--) {
      const row = entries[i]
      if (!row || row.run_id !== runId) continue
      if (row.ok) return null
      return { reason: row.reason, detail: row.result_detail }
    }
    return null
  },

  readRecent(limit = 30, query = ''): HistoryItem[] {
    const entries = loadCache()
    const out: HistoryItem[] = []
    const seen = new Set<string>()
    const needles = query.toLowerCase().split(/\s+/).filter(Boolean)

    // Read backward (most recent first)
    for (let i = entries.length - 1; i >= 0; i--) {
      if (out.length >= limit) break
      const row = entries[i]
      if (row && typeof row.instruction === 'string' && row.instruction.trim() !== '') {
        // Dedup by run_id (each run is distinct) so multiple runs of the same
        // instruction each keep their own result. Fall back to mode|instruction|ts
        // for legacy rows written before run_id was persisted.
        const key = row.run_id || `${row.mode || 'rewrite'}|${row.instruction}|${row.ts}`
        if (!seen.has(key)) {
          seen.add(key)
          if (needles.length > 0) {
            const hay = [row.instruction, row.result, ...(row.turns ?? []).flatMap((t) => [t.q, t.a])]
              .join('\n')
              .toLowerCase()
            if (!needles.every((n) => hay.includes(n))) continue
          }
          let selPrev = row.selection || ''
          if (selPrev.length > 60) {
            selPrev = selPrev.substring(0, 60) + '...'
          }
          out.push({
            run_id: row.run_id || key,
            instruction: row.instruction,
            // A capture row carries its kind in capture_kind (its `mode` is a
            // placeholder AppMode); show that as the chip. LLM rows use `mode`.
            mode: row.capture_kind || row.mode || 'rewrite',
            ts: row.ts || '',
            backend: row.backend || '',
            selection_preview: selPrev,
            result: row.result,
            turns: row.turns,
            ok: row.ok !== false,
            // Lets the panel distinguish "the agent failed" from "we killed it" /
            // "it's still going". Absent on settled rows.
            run_state: row.run_state,
            // The run's own folder (~/MightyMouse/runs/<run_id>/ or the act working
            // dir), so the panel can reveal the exact run in Finder. Absent for rows
            // with no LLM run / incognito runs, so the panel hides the button.
            open_path: row.run_dir || undefined,
            // Pre-duration_ms rows only have whole seconds; promoting those keeps
            // old history showing a time rather than going blank.
            duration_ms:
              typeof row.duration_ms === 'number'
                ? row.duration_ms
                : typeof row.duration_s === 'number' && row.duration_s > 0
                  ? row.duration_s * 1000
                  : undefined
          })
        }
      }
    }
    return out
  },

  /**
   * The last `limit` runs fired FROM the selection bar, newest first. Its own
   * reader rather than a filter over readRecent(): that one caps at 30 rows of
   * every source, so a user who dictates all day would see no bar runs at all.
   */
  readSelectionBarRecent(limit: number): SelectionBarHistoryItem[] {
    const entries = loadCache()
    const out: SelectionBarHistoryItem[] = []
    const seen = new Set<string>()
    for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
      const row = entries[i]
      if (!row || row.source !== 'selection-bar') continue
      const key = row.run_id || `${row.instruction}|${row.ts}`
      if (seen.has(key)) continue
      seen.add(key)
      const sel = row.selection || ''
      out.push({
        run_id: key,
        ts: row.ts || '',
        instruction: row.instruction || '',
        selection_preview:
          sel.length > BAR_PREVIEW_CHARS ? `${sel.slice(0, BAR_PREVIEW_CHARS)}…` : sel,
        result: row.result,
        ok: row.ok !== false
      })
    }
    return out
  },

  /**
   * Entries whose ts falls in [from, to), most-recent first. Powers date-scoped
   * recall ("what did I ask yesterday"). Dedups by run_id so a re-written ask
   * conversation collapses to its latest row.
   */
  readByDate(from: Date, to: Date): HistoryEntry[] {
    const entries = loadCache()
    const out: HistoryEntry[] = []
    const seen = new Set<string>()
    for (let i = entries.length - 1; i >= 0; i--) {
      const row = entries[i]
      if (!row || !row.ts) continue
      const t = parseTs(row.ts).getTime()
      if (t < from.getTime() || t >= to.getTime()) continue
      const key = row.run_id || `${row.mode}|${row.instruction}|${row.ts}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(row)
    }
    return out
  },

  /**
   * Entries containing ALL the given terms (case-insensitive substring) across
   * instruction / result / front_app / window_title. Most-recent first, deduped.
   * This is the keyword-recall path; semantic (embedding) recall is a named seam.
   */
  searchText(terms: string[]): HistoryEntry[] {
    const needles = terms.map((t) => t.toLowerCase()).filter((t) => t !== '')
    if (needles.length === 0) return []
    const entries = loadCache()
    const out: HistoryEntry[] = []
    const seen = new Set<string>()
    for (let i = entries.length - 1; i >= 0; i--) {
      const row = entries[i]
      if (!row) continue
      const hay =
        `${row.instruction || ''}\n${row.result || ''}\n${row.front_app || ''}\n${row.window_title || ''}`.toLowerCase()
      if (!needles.every((n) => hay.includes(n))) continue
      const key = row.run_id || `${row.mode}|${row.instruction}|${row.ts}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(row)
    }
    return out
  },

  /**
   * Settle every still-`pending` row left behind by a previous app session.
   *
   * Called once at launch. A pending row that survives a restart means the app died
   * holding that run (crash / force-quit / power loss) — the process is long gone,
   * so the row can never settle itself. We re-write it as `interrupted` so the user
   * sees "this ran and was cut off" instead of a row that lies about being live.
   *
   * Safe to call with nothing pending (returns 0). Appends rather than rewrites the
   * file: same run_id + latest-wins means the interrupted row shadows the pending
   * one, with no destructive edit to a file that may hold encrypted rows we can't
   * read on this machine.
   */
  reconcilePendingRuns(): number {
    // Latest row per run_id decides — a run that DID settle before the quit has a
    // newer settled row, and must not be dragged back to interrupted.
    const latest = new Map<string, HistoryEntry>()
    for (const row of loadCache()) {
      if (row?.run_id) latest.set(row.run_id, row)
    }
    let settled = 0
    for (const row of latest.values()) {
      if (row.run_state !== 'pending') continue
      HISTORY.append({ ...row, ok: false, run_state: 'interrupted' })
      settled++
    }
    if (settled > 0) {
      console.warn(`history: settled ${settled} interrupted run(s) from a previous session`)
    }
    return settled
  },

  /** Wipe all history. Backs up first so a mis-click is recoverable. Used by Settings. */
  clear(): string | null {
    if (!existsSync(PATHS.HISTORY)) {
      invalidateCache()
      return null
    }
    try {
      const stamp = historyTimestamp().replace(/[:]/g, '-')
      const backupPath = join(PATHS.BACKUPS, `rewrite-history-cleared-${stamp}.jsonl`)
      copyFileSync(PATHS.HISTORY, backupPath)
      writeFileSync(PATHS.HISTORY, '', 'utf-8')
      invalidateCache()
      return backupPath
    } catch (err) {
      console.error('Failed to clear history:', err)
      return null
    }
  }
}
