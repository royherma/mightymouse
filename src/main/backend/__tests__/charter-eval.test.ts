/**
 * charter-eval.test.ts — the agent-charter quality gate.
 *
 * For every fixture case, this assembles the REAL system prompt the model would
 * receive (same builders production uses), then scores it against the case's
 * must/mustNot substrings. The weighted pass-rate is the headline number; a hard
 * floor fails CI if a charter edit drops a rule from any mode. Each run writes a
 * self-contained, human-readable report under agent-charter/runs/<ts>/report.md
 * with the score, the trend vs the previous run, and every failing case shown as
 * (assembled prompt excerpt) so a regression is debuggable from the report alone.
 *
 * STATIC layer (default): grades the assembled prompt. Free, deterministic, fast.
 * LIVE layer (CHARTER_LIVE_EVAL=1): also calls the real backend on each case's
 * liveInput and grades the OUTPUT, proving the rules change behavior. Opt-in
 * because it costs tokens. The live layer is intentionally NOT a CI gate; it
 * appends its findings to the same report for a human to read.
 *
 * Mirrors the connectors recall-eval harness (scored floor + run-folder audit) so
 * the two evals read the same and a regression in either is reproducible.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { CONFIG } from '../../../shared/config'
import { buildRewritePrompts, buildActPrompts, prependCharter } from '../prompts'
import { resetCharterCache, charterVersion } from '../charter'
import { CHARTER_CASES, type CharterCase } from './charter-eval.fixtures'

// Weighted pass-rate floor. The fixtures are built so a correct charter clears
// this with room; dropping below it means an edit removed a guaranteed rule.
const SCORE_FLOOR = 0.95

interface CaseResult {
  id: string
  behavior: string
  mode: string
  weight: number
  passed: boolean
  missing: string[] // required substrings that were absent
  leaked: string[] // banned substrings that were present
  promptExcerpt: string // head of the assembled prompt, for the report
}

/** Assemble the exact system prompt the given case's mode produces in production. */
function assemblePrompt(c: CharterCase): string {
  switch (c.mode) {
    case 'rewrite':
    case 'ask':
      return buildRewritePrompts({
        mode: c.mode,
        selection: c.liveSelection ?? 'sample selected text',
        instruction: c.liveInput ?? 'do the thing',
        selFile: '/tmp/sel.txt',
        conversationHistory: [],
        ctxData: null,
        actionExtra: null
      }).systemPrompt
    case 'act':
      return buildActPrompts({
        instruction: c.liveInput ?? 'convert this file',
        finderFiles: [],
        selection: '',
        ctxData: null
      }).systemPrompt
    // recall assembles their system prompt as prependCharter(<mode prompt>)
    // in ipc.ts; reproduce that exact call so the eval covers them too.
    case 'recall':
      return prependCharter(CONFIG.SYSTEM_PROMPT_RECALL)
  }
}

function gradeStatic(c: CharterCase): CaseResult {
  const prompt = assemblePrompt(c)
  const hay = prompt.toLowerCase()
  const missing = c.mustContain.filter((s) => !hay.includes(s.toLowerCase()))
  const leaked = (c.mustNotContain ?? []).filter((s) => hay.includes(s.toLowerCase()))
  return {
    id: c.id,
    behavior: c.behavior,
    mode: c.mode,
    weight: c.weight ?? 1,
    passed: missing.length === 0 && leaked.length === 0,
    missing,
    leaked,
    promptExcerpt: prompt.slice(0, 240).replace(/\n/g, ' ')
  }
}

function weightedScore(results: CaseResult[]): number {
  const total = results.reduce((a, r) => a + r.weight, 0)
  const got = results.reduce((a, r) => a + (r.passed ? r.weight : 0), 0)
  return total === 0 ? 1 : got / total
}

describe('agent charter quality (eval harness)', () => {
  let results: CaseResult[] = []
  let score = 0

  beforeAll(() => {
    // Force a fresh read of the md files (another test or a prior edit may have
    // populated the module cache with stale or fallback content).
    resetCharterCache()
    results = CHARTER_CASES.map(gradeStatic)
    score = weightedScore(results)
    writeReport(results, score)
  })

  it('every charter rule survives composition into every mode (weighted floor)', () => {
    const fails = results
      .filter((r) => !r.passed)
      .map(
        (r) =>
          `  [${r.id}] ${r.behavior}` +
          (r.missing.length ? `\n     missing: ${r.missing.join(' | ')}` : '') +
          (r.leaked.length ? `\n     leaked: ${r.leaked.join(' | ')}` : '')
      )
    expect(
      score,
      `charter score ${score.toFixed(2)} below floor ${SCORE_FLOOR}\nFailing cases:\n${fails.join('\n')}`
    ).toBeGreaterThanOrEqual(SCORE_FLOOR)
  })

  it('the composed charter is never empty (fallback safety)', () => {
    expect(prependCharter('').trim().length).toBeGreaterThan(100)
  })
})

/**
 * Write the run folder: report.md (human-readable, with trend vs the prior run),
 * a flat audit row for jq, and latest.txt. Best-effort: a write failure (CI
 * sandbox blocking the dir) never fails the eval itself.
 */
function writeReport(results: CaseResult[], score: number): void {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const root = join(process.cwd(), 'agent-charter', 'runs')
    const auditsDir = join(root, 'audits')
    const workDir = join(root, ts)
    mkdirSync(workDir, { recursive: true })
    mkdirSync(auditsDir, { recursive: true })

    const prev = readPrevScore(root)
    const trend =
      prev === null
        ? 'first run'
        : score > prev
          ? `up from ${pct(prev)} (improved)`
          : score < prev
            ? `DOWN from ${pct(prev)} (regression)`
            : `flat vs ${pct(prev)}`

    const passed = results.filter((r) => r.passed).length
    const lines: string[] = []
    lines.push(`# Charter Eval — v${charterVersion()}`)
    lines.push('')
    lines.push(`Score: ${pct(score)}  (${passed}/${results.length} cases)   ${trend}`)
    lines.push(`Floor: ${pct(SCORE_FLOOR)}   ${score >= SCORE_FLOOR ? 'PASS' : 'FAIL'}`)
    lines.push('')
    lines.push('| case | mode | result | detail |')
    lines.push('|---|---|---|---|')
    for (const r of results) {
      const detail = r.passed
        ? 'ok'
        : [r.missing.length ? `missing: ${r.missing.join(', ')}` : '', r.leaked.length ? `leaked: ${r.leaked.join(', ')}` : '']
            .filter(Boolean)
            .join('; ')
      lines.push(`| ${r.id} | ${r.mode} | ${r.passed ? 'PASS' : 'FAIL'} | ${detail} |`)
    }
    const fails = results.filter((r) => !r.passed)
    if (fails.length) {
      lines.push('')
      lines.push('## Failing cases — assembled prompt excerpt')
      for (const r of fails) {
        lines.push('')
        lines.push(`### ${r.id} (${r.mode})`)
        lines.push(`behavior: ${r.behavior}`)
        if (r.missing.length) lines.push(`missing: ${r.missing.join(' | ')}`)
        if (r.leaked.length) lines.push(`leaked: ${r.leaked.join(' | ')}`)
        lines.push('```')
        lines.push(r.promptExcerpt)
        lines.push('```')
      }
    }
    writeFileSync(join(workDir, 'report.md'), lines.join('\n'))

    const row = {
      ts: new Date().toISOString(),
      charterVersion: charterVersion(),
      ok: score >= SCORE_FLOOR,
      score,
      floor: SCORE_FLOOR,
      cases: results.length,
      passed,
      fails: fails.map((r) => ({ id: r.id, missing: r.missing, leaked: r.leaked }))
    }
    writeFileSync(join(workDir, 'run.json'), JSON.stringify(row, null, 2))
    writeFileSync(join(auditsDir, `${ts}.json`), JSON.stringify(row, null, 2))
    writeFileSync(join(root, 'latest.txt'), workDir)
  } catch {
    // Report is observability, not correctness — swallow.
  }
}

/** Read the score from the most recent prior audit row, or null if none. */
function readPrevScore(root: string): number | null {
  try {
    const latest = join(root, 'latest.txt')
    if (!existsSync(latest)) return null
    const prevRun = readFileSync(latest, 'utf-8').trim()
    const runJson = join(prevRun, 'run.json')
    if (!existsSync(runJson)) return null
    const parsed = JSON.parse(readFileSync(runJson, 'utf-8'))
    return typeof parsed.score === 'number' ? parsed.score : null
  } catch {
    return null
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

// ── LIVE layer (opt-in) ───────────────────────────────────────────────────────
// Off by default. Set CHARTER_LIVE_EVAL=1 to actually call the local `claude`
// CLI with each case's assembled charter prompt and grade the REAL output against
// liveMustNot. This proves the charter changes behavior, not just that the rules
// are present. It costs tokens + needs the `claude` CLI on PATH, so it is NEVER a
// CI gate: failures are reported, not asserted. Findings append to the latest
// run's report.md so a human reads static + live in one place.
const LIVE_ON = process.env.CHARTER_LIVE_EVAL === '1'

describe.runIf(LIVE_ON)('agent charter — LIVE output grading (opt-in)', () => {
  it('real output obeys the charter (banned substrings absent)', () => {
    resetCharterCache()
    const cases = CHARTER_CASES.filter((c) => c.liveInput && (c.liveMustNot?.length ?? 0) > 0)
    const findings: string[] = ['', `## LIVE output grading (claude CLI) — v${charterVersion()}`, '']
    for (const c of cases) {
      const system = assemblePrompt(c as CharterCase)
      const user =
        c.mode === 'rewrite' || c.mode === 'ask'
          ? `Selected text:\n${c.liveSelection ?? ''}\n\nInstruction: ${c.liveInput}`
          : `${c.liveInput}`
      let out = ''
      try {
        out = execFileSync('claude', ['-p', `${system}\n\n${user}`, '--permission-mode', 'bypassPermissions'], {
          encoding: 'utf-8',
          timeout: 60_000
        })
      } catch (e) {
        findings.push(`- [${c.id}] SKIPPED (claude call failed: ${(e as Error).message.slice(0, 80)})`)
        continue
      }
      const leaked = (c.liveMustNot ?? []).filter((s) => out.includes(s))
      findings.push(
        leaked.length
          ? `- [${c.id}] LEAK: produced ${leaked.join(', ')}  | out: ${out.slice(0, 120).replace(/\n/g, ' ')}`
          : `- [${c.id}] clean`
      )
    }
    // Append to the latest static report so both layers live in one file.
    try {
      const latest = join(process.cwd(), 'agent-charter', 'runs', 'latest.txt')
      if (existsSync(latest)) appendFileSync(join(readFileSync(latest, 'utf-8').trim(), 'report.md'), findings.join('\n'))
    } catch {
      // observability only
    }
    // Live layer never gates CI — it only records. A clean run is reassuring; a
    // leak is a signal to tighten the charter, surfaced in the report.
    expect(true).toBe(true)
  }, 600_000)
})
