import { mkdirSync, writeFileSync, existsSync, readdirSync, renameSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'
import { RunKind, RunContext } from '../../shared/types'

// One folder per ACTION — LLM run (ask/rewrite/act/write) OR capture (listen/
// recording/screenshot). Every action type funnels through here so they all share
// ONE organized home instead of ask/rewrite dumping flat into tmp/ and captures
// living in a separate captures/ tree. The folder is permanent — the history row
// points here via `run_dir`, so it must survive (NOT swept like tmp).
//
// Folder name: <ts>-<kind>-<slug>-<run_id> — timestamp FIRST so `ls`/Finder sorts
// actions chronologically, then the KIND (ask/listen/screenshot/…) so a glance
// groups action types, then a readable slug, then the run_id (the stable unique key).
//
//   ~/MightyMouse/runs/2026-06-14T10-00-00Z-ask-what-day-is-it-r-3f2a/
//   ├── run.json     ← audit metadata (run_id, ts, kind, instruction, backend) +
//   │                  a `context` block: front app / window / URL / screenshot
//   │                  path / selection size at action time. ONE uniform shape
//   │                  across every kind so the run-details view reads it the same
//   │                  way whether it's a rewrite or a recording.
//   ├── input.txt    ← the selected text an LLM run acted on (written here, NOT in
//   │                  tmp/ which gets swept — so an old run stays replayable)
//   ├── .prompt-*.txt ← what went to the model, incl. the system prompt (written by
//   │                   runner.ts). Dot-prefixed so Finder hides it — the assembled
//   │                   prompt is our secret sauce we don't surface to customers.
//   └── .out-*.txt    ← raw model output (written by runner.ts). Also dot-hidden.
//
//   ~/MightyMouse/runs/2026-06-14T10-02-00Z-listen-summarize-this-l-9f1a/
//   ├── run.json     ← kind: 'listen'
//   ├── audio.*      ← the recording (written by the capture recorder)
//   └── transcript.txt
//
// A new action type just passes its `kind`; nothing else here changes — that's the
// "fully adaptable" property. Incognito is the caller's call: an incognito action
// skips createRunFolder entirely so nothing persists.

export interface RunFolderMeta {
  runId: string
  ts: string
  /** The action that produced this folder — an LLM mode or a capture kind. */
  kind: RunKind
  instruction: string
  backend: string
  /**
   * Where the user was when they fired this action — front app / window / URL /
   * screenshot path / selection size. Written into run.json's `context` block so
   * the run-details view shows "you had Chrome/Runway open" for EVERY kind, not
   * just captures. Omitted (no block) when there's nothing to record.
   */
  context?: RunContext
  /**
   * The input the LLM run acted on (the highlighted text for rewrite/ask). Written
   * to input.txt INSIDE the folder so the run is self-contained — the live copy in
   * tmp/ gets swept, this one doesn't. Empty/undefined → no input.txt.
   */
  selection?: string
  /**
   * A capture's already-populated working dir (e.g. captures/listen-<stamp>/ with
   * its audio.wav + transcript.txt). When set, createRunFolder MOVES that dir to
   * the canonical runs/<ts>-<kind>-<slug>-<id> name instead of making an empty one,
   * so the capture's files come along and a later Ask/Act on the same run_id lands
   * in the SAME folder (createRunFolder is idempotent by trailing run_id).
   */
  adoptFrom?: string
}

// run_id can carry a ':' (e.g. 'r:3f2a', 'cheese:1a2b', 'sf:<uuid>') which is a
// legal-but-ugly dir name on macOS and breaks reveal-in-Finder selection; swap it
// for '-' so the folder name is a clean, shell-safe slug.
function safeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

// A short, readable slug of the instruction for the folder name — lowercase, only
// a-z0-9, hyphen-collapsed, capped so the path stays sane. Empty instruction → 'run'.
function slugify(instruction: string): string {
  const s = instruction
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40)
    .replace(/-+$/g, '')
  return s || 'run'
}

/**
 * Create (or reuse) the per-run folder and seed its run.json. Returns the absolute
 * dir path to store on the history row + hand to the backend as its run dir. Best
 * effort: a filesystem failure returns null so a run is never blocked on logging.
 *
 * Idempotent by run_id: multi-turn ask reuses the SAME folder across turns even as
 * the instruction (slug) changes — we match on the trailing `-<run_id>` rather than
 * the full name, so a later turn lands in the first turn's dir and just rewrites
 * run.json. A first turn with no existing match creates `<ts>-<slug>-<run_id>`.
 */
export function createRunFolder(meta: RunFolderMeta): string | null {
  const idSuffix = `-${safeRunId(meta.runId)}`
  try {
    // Reuse an existing dir for this run_id (multi-turn) so turns don't fork dirs.
    if (existsSync(PATHS.RUNS)) {
      const existing = readdirSync(PATHS.RUNS).find((name) => name.endsWith(idSuffix))
      if (existing) {
        const dir = join(PATHS.RUNS, existing)
        seedFolder(dir, meta)
        return dir
      }
    }
    const dir = join(PATHS.RUNS, `${meta.ts}-${meta.kind}-${slugify(meta.instruction)}${idSuffix}`)
    // A capture hands us a working dir already full of files — move it into place
    // rather than make an empty one. mkdirSync(RUNS) first so the rename target's
    // parent exists; renameSync is atomic on the same filesystem (~/MightyMouse/*).
    if (meta.adoptFrom && existsSync(meta.adoptFrom) && meta.adoptFrom !== dir) {
      mkdirSync(PATHS.RUNS, { recursive: true })
      renameSync(meta.adoptFrom, dir)
    } else {
      mkdirSync(dir, { recursive: true })
    }
    seedFolder(dir, meta)
    return dir
  } catch {
    return null
  }
}

/** Write run.json (+ input.txt when there's a selection) into a run folder. Called
 * for both a fresh folder and a reused multi-turn one, so a later turn re-seeds with
 * the latest meta (instruction/context can change across an ask conversation). */
function seedFolder(dir: string, meta: RunFolderMeta): void {
  writeRunJson(dir, meta)
  // Only LLM runs carry a selection; captures pass none. Write the actual text so
  // the folder replays without the swept tmp/ copy. Skip an empty selection — an
  // empty input.txt is noise (act has no selFile, rewrite-of-nothing is rare).
  if (meta.selection) {
    writeFileSync(join(dir, 'input.txt'), meta.selection, 'utf-8')
  }
}

function writeRunJson(dir: string, meta: RunFolderMeta): void {
  // Drop empty/undefined context fields so the block only carries what we actually
  // know — a run.json full of nulls reads worse than a tight object.
  const context = meta.context
    ? Object.fromEntries(Object.entries(meta.context).filter(([, v]) => v !== undefined && v !== ''))
    : undefined
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify(
      {
        run_id: meta.runId,
        ts: meta.ts,
        kind: meta.kind,
        instruction: meta.instruction,
        backend: meta.backend,
        ...(context && Object.keys(context).length > 0 ? { context } : {})
      },
      null,
      2
    ),
    'utf-8'
  )
}
