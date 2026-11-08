/**
 * check-providers.mjs — a runnable provider × capability matrix.
 *
 * Loops every backend adapter in BACKENDS and runs a grouped checklist per
 * capability (Health / Wiring / Core-LLM), printing an emoji pass/fail matrix.
 * Built to catch exactly the "is recall wired on claude vs mightymouse?" class of
 * gap that a single chat message can't tell you: not-wired vs wired-but-degraded
 * vs CLI-errored all look the same in the panel, but different here.
 *
 * Usage:
 *   node scripts/check-providers.mjs                 # all providers, offline/cheap
 *   node scripts/check-providers.mjs claude          # one provider
 *   node scripts/check-providers.mjs claude codex     # a subset
 *   node scripts/check-providers.mjs --live          # + real LLM roundtrips (spends tokens)
 *   node scripts/check-providers.mjs claude --live    # subset, live
 *   node scripts/check-providers.mjs --json          # machine-readable output for CI
 *
 * Default is OFFLINE: no LLM calls, no token spend, runs in seconds. It checks the
 * things that are usually silently broken — binary resolution, auth probe, that
 * buildCommand produces a non-empty shell string, that parseOutput handles a sample
 * stream, and that the recall/timeline gates actually fire for a canonical query.
 * --live adds real `ask` roundtrips (and, per provider, is the only path that proves
 * the model end to end).
 *
 * No build step: TS modules are imported through jiti (already a dependency).
 */

import { createJiti } from 'jiti'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const jiti = createJiti(import.meta.url)

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const LIVE = argv.includes('--live')
const JSON_OUT = argv.includes('--json')
const requested = argv.filter((a) => !a.startsWith('--'))

// ── colours / marks (plain-friendly, degrade in non-TTY) ────────────────────────
const tty = process.stdout.isTTY && !JSON_OUT
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = (s) => c('1', s)
const dim = (s) => c('2', s)
const MARK = { pass: '✅', warn: '⚠️ ', skip: '⚪', fail: '❌' }
// status → sort/severity so a provider's worst result is easy to roll up
const RANK = { pass: 0, skip: 1, warn: 2, fail: 3 }

// ── load the real code under test ───────────────────────────────────────────────
const { BACKENDS } = await jiti.import(resolve(repoRoot, 'src/main/backend/adapters.ts'))
const { mightBeRecall, mightBeTimelineRecall, mightBeConnectorRecall } = await jiti.import(
  resolve(repoRoot, 'src/main/backend/recall-classifier.ts')
)

// Live-recall needs the real activity blob (backend-agnostic — built once, reused per
// provider). Import lazily and tolerate any failure so offline runs never touch it.
async function buildRecallBlob() {
  if (!LIVE) return null
  try {
    const { readContextEventsInRange } = await jiti.import(
      resolve(repoRoot, 'src/main/backend/context-memory.ts')
    )
    const { rankActivityForQuery, assembleActivityRecall } = await jiti.import(
      resolve(repoRoot, 'src/main/backend/activity-recall.ts')
    )
    const now = Date.now()
    const events = readContextEventsInRange(now - 3 * 86400000, now) // last 3 days
    const segments = rankActivityForQuery(events, 'what apps or sites did i use', [], 12, true)
    return { blob: assembleActivityRecall(segments) }
  } catch (e) {
    return { blob: '', error: String(e).slice(0, 80) }
  }
}
const recallBlob = await buildRecallBlob()

const providerIds = Object.keys(BACKENDS)
const targets = requested.length > 0 ? requested : providerIds

// Fail loudly on a typo'd provider name rather than silently checking nothing.
const unknown = targets.filter((t) => !providerIds.includes(t))
if (unknown.length > 0) {
  console.error(`Unknown provider(s): ${unknown.join(', ')}`)
  console.error(`Known: ${providerIds.join(', ')}`)
  process.exit(2)
}

// A single check result row.
const row = (name, status, detail = '') => ({ name, status, detail })

// Run a CLI probe (version/auth) with a hard timeout; never throw.
function probe(bin, args, timeoutMs = 8000) {
  try {
    const r = spawnSync(bin, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      // login shell so PATH/nvm match how the app resolves binaries
      shell: false
    })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    return { ok: r.status === 0, out, code: r.status, err: r.error }
  } catch (e) {
    return { ok: false, out: String(e), code: null, err: e }
  }
}

// The canonical recall queries the gates must classify, so a regression in the
// keyword gates (the free-backend recall path) shows up here.
const RECALL_Q = 'what did i work on yesterday'
const TIMELINE_Q = 'recap my week'
const CONNECTOR_Q = 'what did sarah email me about pricing'

// ── per-provider check groups ───────────────────────────────────────────────────

function checkHealth(adapter) {
  const rows = []
  const isHttp = typeof adapter.transport === 'function' || adapter.transport === 'http'

  // 1. binary resolves (shell adapters only; http has no binary)
  const bin = adapter.binPath
  if (isHttp && !bin) {
    rows.push(row('binary', 'skip', 'http transport, no binary'))
  } else if (bin && bin !== '') {
    rows.push(row('binary', 'pass', bin))
  } else {
    rows.push(row('binary', 'fail', 'not found on PATH / no override'))
  }

  // 2. --version + 3. auth status — only meaningful for a resolvable shell binary
  if (bin && bin !== '') {
    if (adapter.versionArgs) {
      const v = probe(bin, adapter.versionArgs)
      const line = (v.out || '').split('\n').find((l) => l.trim())?.slice(0, 40) || ''
      rows.push(row('version', v.ok ? 'pass' : 'warn', v.ok ? line : `exit ${v.code}`))
    }
    if (adapter.authArgs && adapter.parseAuth) {
      const a = probe(bin, adapter.authArgs)
      try {
        const st = adapter.parseAuth(a.out, a.ok)
        rows.push(row('auth', st.loggedIn ? 'pass' : 'warn', st.detail))
      } catch (e) {
        rows.push(row('auth', 'warn', `parseAuth threw: ${String(e).slice(0, 40)}`))
      }
    }
  } else if (isHttp) {
    rows.push(row('auth', 'skip', 'auth is server-side (JWT)'))
  }

  return rows
}

function checkWiring(adapter) {
  const rows = []
  const feature = 'ask'
  const transport =
    typeof adapter.transport === 'function' ? adapter.transport(feature) : adapter.transport

  // 1. buildCommand produces a non-empty shell string (shell adapters).
  if (transport === 'shell') {
    if (typeof adapter.buildCommand !== 'function') {
      rows.push(row('buildCommand', 'fail', 'shell transport but no buildCommand'))
    } else {
      try {
        const cmd = adapter.buildCommand({
          runDir: '/tmp/mm-check',
          promptFile: '/tmp/mm-check/prompt.txt',
          outFile: '/tmp/mm-check/out.txt',
          addDirs: ['/tmp/mm-check'],
          attachments: [],
          shellQuote: (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
        })
        const okCmd = typeof cmd === 'string' && cmd.trim().length > 0
        rows.push(row('buildCommand', okCmd ? 'pass' : 'fail', okCmd ? dim(cmd.slice(0, 60) + '…') : 'empty'))
      } catch (e) {
        // BinaryNotFoundError is expected when the CLI isn't installed — that's a
        // health failure, not a wiring bug, so downgrade to warn here.
        const msg = String(e?.message ?? e)
        const isMissing = /not found/i.test(msg)
        rows.push(row('buildCommand', isMissing ? 'warn' : 'fail', msg.slice(0, 50)))
      }
    }
  } else {
    rows.push(
      row('runHttp', typeof adapter.runHttp === 'function' ? 'pass' : 'fail', transport + ' transport')
    )
  }

  // 2. parseOutput handles a sample stream without throwing (returns a string).
  try {
    const out = adapter.parseOutput('not json\n{"type":"nope"}\n')
    rows.push(row('parseOutput', typeof out === 'string' ? 'pass' : 'fail', typeof out))
  } catch (e) {
    rows.push(row('parseOutput', 'fail', String(e).slice(0, 40)))
  }

  // 3. parsePhase tolerates a junk line (must return null, not throw).
  try {
    const p = adapter.parsePhase('garbage-not-json')
    rows.push(row('parsePhase', p === null ? 'pass' : 'warn', p === null ? 'null on junk' : 'non-null on junk'))
  } catch (e) {
    rows.push(row('parsePhase', 'fail', String(e).slice(0, 40)))
  }

  return rows
}

// A shellQuote impl matching the runner's (single-quote, escape embedded quotes).
const SQ = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Build a command with a given attachment list, returning {cmd, threw}.
function tryBuild(adapter, attachments, extra = {}) {
  try {
    const cmd = adapter.buildCommand({
      runDir: '/tmp/mm-check',
      promptFile: '/tmp/mm-check/prompt.txt',
      outFile: '/tmp/mm-check/out.txt',
      addDirs: ['/tmp/mm-check'],
      attachments,
      shellQuote: SQ,
      ...extra
    })
    return { cmd: typeof cmd === 'string' ? cmd : '', threw: null }
  } catch (e) {
    return { cmd: '', threw: e }
  }
}

// Attachments: each provider ingests images/files differently (claude via --add-dir
// grant, codex -i for images + inlined text for files, opencode -f, gemini none).
// Check the command still builds with an image + a file attached, and — where the
// provider has a distinct flag — that the flag/path shows up. gemini has no attach
// path (documented out-of-scope), so a missing flag there is expected, not a fail.
function checkAttachments(adapter) {
  const rows = []
  const feature = 'ask'
  const transport =
    typeof adapter.transport === 'function' ? adapter.transport(feature) : adapter.transport
  if (transport !== 'shell' || typeof adapter.buildCommand !== 'function') {
    rows.push(row('attach (img+file)', 'skip', 'http path handles attachments in runHttp'))
    return rows
  }
  const img = { path: '/tmp/mm-check/shot.png', kind: 'image', name: 'shot.png' }
  const file = { path: '/tmp/mm-check/notes.txt', kind: 'file', name: 'notes.txt' }
  const { cmd, threw } = tryBuild(adapter, [img, file])
  if (threw) {
    const msg = String(threw?.message ?? threw)
    // BinaryNotFoundError is a health issue (CLI missing), not an attachment bug.
    rows.push(row('attach (img+file)', /not found/i.test(msg) ? 'warn' : 'fail', msg.slice(0, 44)))
    return rows
  }
  // The image path (or its parent dir, for claude's --add-dir) should appear.
  const imgSeen = cmd.includes('shot.png') || cmd.includes('/tmp/mm-check')
  rows.push(row('attach (img+file)', imgSeen ? 'pass' : 'warn', imgSeen ? 'cmd references attachment' : 'attachment not in cmd'))
  return rows
}

// Fast tier: suggestions run with fast:true and should use fastModelName when set.
// If fastModelName is absent, the adapter has no fast tier and must fall back to the
// flagship (never spawn a blank --model). Both are valid; a THROW or empty cmd is not.
function checkFastTier(adapter) {
  const rows = []
  const feature = 'ask'
  const transport =
    typeof adapter.transport === 'function' ? adapter.transport(feature) : adapter.transport
  if (transport !== 'shell' || typeof adapter.buildCommand !== 'function') {
    rows.push(row('fast tier', 'skip', 'http path chooses model server-side'))
    return rows
  }
  const { cmd, threw } = tryBuild(adapter, [], { fast: true })
  if (threw) {
    const msg = String(threw?.message ?? threw)
    rows.push(row('fast tier', /not found/i.test(msg) ? 'warn' : 'fail', msg.slice(0, 44)))
    return rows
  }
  const hasFast = typeof adapter.fastModelName === 'string' && adapter.fastModelName !== ''
  // A blank model = `--model`/`-m` with NO value after it (end-of-string, or straight
  // into another `-flag`). A real value like `--model claude-sonnet-4-6` is fine.
  const blankModel = /(?:--model|-m)\s+(?:-|$)/.test(cmd) || /(?:--model|-m)$/.test(cmd.trim())
  const okCmd = cmd.trim().length > 0 && !blankModel
  rows.push(
    row('fast tier', okCmd ? 'pass' : 'fail', hasFast ? `fast: ${adapter.fastModelName}` : 'no fast tier → flagship')
  )
  return rows
}

// Transport fork: prove the per-feature transport function resolves correctly.
// mightymouse is the only one that varies (act→shell, rewrite/ask→http); the rest
// are static. This catches a regression where the fork stops routing act to the CLI.
function checkTransport(adapter) {
  const rows = []
  const resolve = (f) =>
    typeof adapter.transport === 'function' ? adapter.transport(f) : adapter.transport
  const ask = resolve('ask')
  const act = resolve('act')
  const varies = typeof adapter.transport === 'function'
  // Each resolved transport must be one of the two known kinds.
  const valid = [ask, act].every((t) => t === 'shell' || t === 'http')
  rows.push(row('transport', valid ? 'pass' : 'fail', varies ? `ask→${ask}, act→${act}` : `static: ${ask}`))
  // If it's a shell transport, buildCommand must exist; if http, runHttp must exist.
  const shellOk = act === 'http' || typeof adapter.buildCommand === 'function'
  const httpOk = ask === 'shell' || typeof adapter.runHttp === 'function'
  rows.push(row('transport impls', shellOk && httpOk ? 'pass' : 'fail', shellOk && httpOk ? 'match declared transport' : 'missing impl'))
  return rows
}

// parseStep (tool-call timing) must tolerate a junk line → null, not throw. Optional
// on http adapters (no per-tool events), so absent is a skip, not a fail.
function checkParseStep(adapter) {
  const rows = []
  if (typeof adapter.parseStep !== 'function') {
    rows.push(row('parseStep', 'skip', 'no per-tool events (http)'))
    return rows
  }
  try {
    const s = adapter.parseStep('garbage-not-json')
    rows.push(row('parseStep', s === null ? 'pass' : 'warn', s === null ? 'null on junk' : 'non-null on junk'))
  } catch (e) {
    rows.push(row('parseStep', 'fail', String(e).slice(0, 40)))
  }
  return rows
}

// Recall gates are backend-agnostic (they run before the adapter), so this group is
// identical across providers — but it's the check that would have caught the "recall
// not answering" confusion, so it's worth showing per provider for a complete matrix.
function checkRecall() {
  const rows = []
  rows.push(row('recall gate', mightBeRecall(RECALL_Q) ? 'pass' : 'fail', `"${RECALL_Q}"`))
  rows.push(row('timeline gate', mightBeTimelineRecall(TIMELINE_Q) ? 'pass' : 'fail', `"${TIMELINE_Q}"`))
  rows.push(
    row('connector gate', mightBeConnectorRecall(CONNECTOR_Q) ? 'pass' : 'fail', `"${CONNECTOR_Q}"`)
  )
  return rows
}

// --live: a real `ask` roundtrip via the shell CLI. Proves the model actually
// answers end to end. http/mightymouse needs a JWT + running proxy, so it's marked
// skip here (that path is exercised by the app, not this offline harness).
function checkLive(adapter) {
  const rows = []
  const feature = 'ask'
  const transport =
    typeof adapter.transport === 'function' ? adapter.transport(feature) : adapter.transport
  const bin = adapter.binPath

  if (transport !== 'shell') {
    rows.push(row('ask roundtrip', 'skip', 'http path needs the app + JWT'))
    return rows
  }
  if (!bin || bin === '') {
    rows.push(row('ask roundtrip', 'fail', 'no binary'))
    return rows
  }

  // Cheapest possible prompt with a deterministic-ish answer.
  const Q = 'Reply with only the number: what is 2+2?'
  try {
    const cmd = adapter.buildCommand({
      runDir: repoRoot,
      promptFile: '/dev/stdin',
      outFile: '/tmp/mm-check-out.txt',
      addDirs: [repoRoot],
      attachments: [],
      shellQuote: (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
    })
    // buildCommand reads the prompt from promptFile via $(cat ...). We swapped in
    // /dev/stdin, so feed the prompt on stdin. 45s ceiling — a real agent turn.
    const r = spawnSync('/bin/zsh', ['-lc', cmd], {
      input: Q,
      timeout: 45000,
      encoding: 'utf8',
      cwd: repoRoot
    })
    if (r.error) {
      rows.push(row('ask roundtrip', 'fail', String(r.error).slice(0, 50)))
      return rows
    }
    const answer = (adapter.parseOutput(r.stdout ?? '') || '').trim()
    const got4 = /\b4\b|four/i.test(answer)
    rows.push(
      row(
        'ask roundtrip',
        answer ? (got4 ? 'pass' : 'warn') : 'fail',
        answer ? `"${answer.slice(0, 40).replace(/\n/g, ' ')}"` : `exit ${r.status}`
      )
    )
  } catch (e) {
    rows.push(row('ask roundtrip', 'fail', String(e).slice(0, 50)))
  }
  return rows
}

// --live recall: the exact bug that started this. Asks the provider "what did I do
// yesterday?" WITH the real activity blob injected (same as the panel does), then
// checks the answer names a real app/site from the blob rather than refusing or
// hallucinating. Needs the context-log enabled + non-empty; otherwise skip honestly.
async function checkLiveRecall(adapter, recall) {
  const rows = []
  const transport =
    typeof adapter.transport === 'function' ? adapter.transport('ask') : adapter.transport
  const bin = adapter.binPath
  if (transport !== 'shell') {
    rows.push(row('recall roundtrip', 'skip', 'http path needs the app + JWT'))
    return rows
  }
  if (!bin || bin === '') {
    rows.push(row('recall roundtrip', 'fail', 'no binary'))
    return rows
  }
  if (!recall || !recall.blob || recall.blob.trim() === '') {
    rows.push(row('recall roundtrip', 'skip', 'context-log off or empty — nothing to recall'))
    return rows
  }

  // Feed the recall system prompt + activity blob + the question, exactly like the
  // panel's ask path. If the model names an app/site from the blob, recall works
  // end to end on this backend; a refusal ("I don't have that") is the failure.
  const question = 'What apps or sites did I use recently? Name a couple from my activity.'
  const fullPrompt = `${recall.blob}\n\n${question}`
  try {
    const cmd = adapter.buildCommand({
      runDir: repoRoot,
      promptFile: '/dev/stdin',
      outFile: '/tmp/mm-check-recall.txt',
      addDirs: [repoRoot],
      attachments: [],
      shellQuote: SQ
    })
    const r = spawnSync('/bin/zsh', ['-lc', cmd], {
      input: fullPrompt,
      timeout: 60000,
      encoding: 'utf8',
      cwd: repoRoot
    })
    if (r.error) {
      rows.push(row('recall roundtrip', 'fail', String(r.error).slice(0, 50)))
      return rows
    }
    const answer = (adapter.parseOutput(r.stdout ?? '') || '').trim()
    // A refusal is the specific failure we're hunting.
    const refused = /don't have|do not have|no (?:access|activity|data)|can't see|cannot see/i.test(answer)
    // Did the answer echo any host/app token that appears in the blob? Cheap overlap.
    const blobTokens = new Set((recall.blob.toLowerCase().match(/[a-z][a-z0-9.]{3,}/g) || []))
    const answerTokens = (answer.toLowerCase().match(/[a-z][a-z0-9.]{3,}/g) || [])
    const overlap = answerTokens.some((t) => blobTokens.has(t) && !['your','recent','activity','from','device'].includes(t))
    const status = !answer ? 'fail' : refused ? 'fail' : overlap ? 'pass' : 'warn'
    rows.push(
      row(
        'recall roundtrip',
        status,
        refused ? 'refused despite blob' : `"${answer.slice(0, 44).replace(/\n/g, ' ')}"`
      )
    )
  } catch (e) {
    rows.push(row('recall roundtrip', 'fail', String(e).slice(0, 50)))
  }
  return rows
}

// ── run + render ────────────────────────────────────────────────────────────────

const report = []

for (const id of targets) {
  const adapter = BACKENDS[id]
  const groups = {
    Health: checkHealth(adapter),
    Wiring: checkWiring(adapter),
    Transport: checkTransport(adapter),
    Attachments: checkAttachments(adapter),
    'Fast tier': checkFastTier(adapter),
    Steps: checkParseStep(adapter),
    Recall: checkRecall()
  }
  if (LIVE) {
    groups['Live'] = [...checkLive(adapter), ...(await checkLiveRecall(adapter, recallBlob))]
  }
  report.push({ id, label: adapter.label, groups })
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('')
  console.log(bold(`MightyMouse provider check`) + dim(`  (${LIVE ? 'live' : 'offline'}, ${targets.length} provider${targets.length > 1 ? 's' : ''})`))
  console.log('')
  for (const p of report) {
    // roll up the worst status across all groups for the header line
    const all = Object.values(p.groups).flat()
    const worst = all.reduce((w, r) => (RANK[r.status] > RANK[w] ? r.status : w), 'pass')
    console.log(`${MARK[worst]} ${bold(p.id.toUpperCase())} ${dim('· ' + p.label)}`)
    for (const [group, rows] of Object.entries(p.groups)) {
      console.log(`  ${dim(group)}`)
      for (const r of rows) {
        const nm = r.name.padEnd(16)
        console.log(`    ${MARK[r.status]} ${nm} ${dim(r.detail)}`)
      }
    }
    console.log('')
  }
  // final summary line
  const counts = report
    .flatMap((p) => Object.values(p.groups).flat())
    .reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {})
  console.log(
    dim('summary  ') +
      `${MARK.pass} ${counts.pass || 0}  ${MARK.warn} ${counts.warn || 0}  ${MARK.skip} ${counts.skip || 0}  ${MARK.fail} ${counts.fail || 0}`
  )
  if (!LIVE) console.log(dim('run with --live to add real LLM roundtrips (spends tokens)'))
  console.log('')
}

// exit non-zero if anything hard-failed (CI-friendly)
const anyFail = report.some((p) => Object.values(p.groups).flat().some((r) => r.status === 'fail'))
process.exit(anyFail ? 1 : 0)
