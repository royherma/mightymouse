/**
 * Which mirror settings produced which numbers, kept across restarts.
 *
 * Mirror tuning is a long series of small trades -- codec, capture size,
 * bitrate, jitter target, whether the encoder downscales during motion -- and
 * every one of them was judged by how the glasses FELT in the minutes after the
 * change. That failed twice in one session: the numbers live in
 * /tmp/mightymouse-dev.log, which `make restart` truncates, so each rebuild
 * erased the evidence for the config it replaced. "Not as good as a few
 * versions ago" was unanswerable, because nothing tied a bench result to the
 * knobs that made it.
 *
 * So: one line per mirror session with the full knob set and the git SHA (the
 * fingerprint), then one line per bench summary that arrives afterwards. jsonl
 * rather than the connection journal's rewrite-the-array shape because this
 * only ever appends and wants to be greppable; a run is reconstructed by
 * reading forward to the newest `config` line before a `bench`.
 *
 * Diagnostic only. Nothing reads it back at runtime, so a write failure is
 * logged and swallowed -- it must never be able to interrupt a live mirror.
 */

import { appendFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { PATHS } from '../store/paths'
import { context } from '../platform'
import { devLog } from '../../shared/env'

/** The knobs that decide how the mirror looks, as one flat record.
 *
 *  Deliberately untyped beyond `unknown`: the knob SET is what changes between
 *  sessions, and a fixed interface would have to be edited in lockstep with
 *  every experiment -- exactly the coupling that makes people skip the ledger.
 *  The caller passes whatever it currently believes matters. */
export type MirrorConfigFingerprint = Record<string, unknown>

type LedgerLine =
  | { at: number; kind: 'config'; sha: string; config: MirrorConfigFingerprint }
  | { at: number; kind: 'bench'; line: string; app: string }
  | { at: number; kind: 'switch'; line: string; ms: number; source: string }

/** Resolved once per process: the SHA cannot change under a running app, and
 *  spawning git on every bench line would put a process launch in the path of a
 *  log write. `unknown` when git is unavailable (a packaged build has no repo),
 *  which is honest and still lets the knob set be compared. */
let cachedSha: string | null = null

function headSha(): string {
  if (cachedSha) return cachedSha
  try {
    cachedSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    cachedSha = 'unknown'
  }
  return cachedSha
}

function append(line: LedgerLine): void {
  try {
    appendFileSync(PATHS.MIRROR_TUNING_LEDGER, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  } catch (err) {
    devLog.warn('[mirror] could not append tuning ledger', err)
  }
}

/** Stamp the knob set at the start of a mirror session. Every bench line after
 *  this one belongs to this config until the next call. */
export function recordMirrorConfig(config: MirrorConfigFingerprint): void {
  append({ at: Date.now(), kind: 'config', sha: headSha(), config })
}

/** 8s, just under the 10s bench cadence: long enough that a run of bench lines
 *  costs one lookup rather than one each, short enough that switching apps shows
 *  up on the next line rather than several later. */
const FRONTMOST_CACHE_MS = 8_000
let frontmostCache = { at: 0, id: '' }

/** Which app was in front when a bench line landed, so two runs can be compared
 *  on the same activity -- desktop numbers and video numbers are different
 *  measurements and were being averaged together.
 *
 *  Cached because the underlying lookup is a ~240ms spawnSync, and swallowed
 *  whole: this module must never be able to throw into a live mirror. */
function frontmostApp(): string {
  const now = Date.now()
  if (now - frontmostCache.at < FRONTMOST_CACHE_MS) return frontmostCache.id
  try {
    frontmostCache = { at: now, id: context.frontmostBundleId() }
  } catch {
    frontmostCache = { at: now, id: '' }
  }
  return frontmostCache.id
}

/** Record one bench summary verbatim.
 *
 *  Stored as the raw formatted string rather than parsed fields: the BENCH
 *  format has already gained columns twice mid-investigation, and a parser here
 *  would silently drop whichever column was added last -- the one being
 *  measured. */
export function recordMirrorBench(line: string): void {
  append({ at: Date.now(), kind: 'bench', line, app: frontmostApp() })
}

/** Record one switch-latency sample.
 *
 *  `ms` and `source` are stored as real fields, unlike the bench line above:
 *  this is one scalar whose entire purpose is being compared across runs, so
 *  making a reader re-parse it out of prose would be the same mistake in the
 *  other direction. The rendered line rides along so a run is still readable by
 *  eye without a query. */
export function recordMirrorSwitch(line: string, ms: number, source: string): void {
  append({ at: Date.now(), kind: 'switch', line, ms, source })
}
