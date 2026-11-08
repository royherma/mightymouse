/**
 * charter-eval.fixtures.ts — the ground truth for the agent charter.
 *
 * Each case is one behavior we want the charter to guarantee, expressed as
 * checks against a real assembled system prompt (the exact string the model
 * receives). The eval (charter-eval.test.ts) builds the prompt for the case's
 * mode via the same builders production uses, then asserts every `must` substring
 * is present and every `mustNot` substring is absent. That turns "did my charter
 * edit keep the rules intact?" into a score, not a hunch.
 *
 * Two layers share these fixtures:
 *   - STATIC (default, free, runs in CI): grades the assembled PROMPT. Proves the
 *     charter rules survive composition into every mode. No model call.
 *   - LIVE (opt-in via CHARTER_LIVE_EVAL=1): grades real model OUTPUT on `input`,
 *     using the same must/mustNot intent. Proves the rules actually change
 *     behavior, not just that the text is present. Costs tokens, so it is off by
 *     default. `liveInput` / `liveMustNot` drive that layer.
 *
 * Editing guide: add a case when you add or tighten a principle. `weight` lets a
 * load-bearing rule (no hallucination, no preamble) count more than a nicety.
 * Substrings are matched case-insensitively. No em or en dashes in this file.
 */
import type { AppMode } from '../../../shared/types'

/** A charter behavior, checked against the assembled prompt (static) + output (live). */
export interface CharterCase {
  /** Stable id, shown in the report. */
  id: string
  /** Which mode's prompt to assemble for the static check. */
  mode: AppMode | 'recall'
  /** Human-readable behavior this case guards. */
  behavior: string
  /** Substrings that MUST appear in the assembled system prompt (case-insensitive). */
  mustContain: string[]
  /** Substrings that must NOT appear in the assembled system prompt. */
  mustNotContain?: string[]
  /** Importance weight for the score. Default 1. */
  weight?: number
  /** A realistic user instruction, used by the LIVE layer to grade real output. */
  liveInput?: string
  /** Selection text for the live input (rewrite/ask modes). */
  liveSelection?: string
  /** Substrings that must NOT appear in real model OUTPUT (live layer). */
  liveMustNot?: string[]
}

// Charter rule fingerprints. These substrings come straight from
// agent-charter/principles.md + mission.md. If you rename a heading or reword a
// rule there, update the matching fingerprint here (the test will tell you which).
const RULE = {
  actNotAsk: 'Act, don',
  speed: 'Speed beats completeness',
  noPreamble: 'No preamble',
  honest: "honest about what you don't know",
  voiceNoDash: 'Never use em dashes or en dashes',
  mission: 'get the user what they actually want'
} as const

export const CHARTER_CASES: CharterCase[] = [
  {
    id: 'rewrite-has-charter',
    mode: 'rewrite',
    behavior: 'Rewrite mode inherits the full charter (mission + all principles)',
    mustContain: [RULE.mission, RULE.actNotAsk, RULE.speed, RULE.noPreamble, RULE.voiceNoDash],
    weight: 2,
    liveInput: 'make this punchier',
    liveSelection: 'We are writing to inform you that the meeting has been rescheduled.',
    liveMustNot: ['—', '–', 'Here is', 'Sure,', 'Based on']
  },
  {
    id: 'ask-has-charter',
    mode: 'ask',
    behavior: 'Ask mode inherits the charter and keeps no-preamble',
    mustContain: [RULE.mission, RULE.noPreamble, RULE.voiceNoDash],
    weight: 1,
    liveInput: 'what is the main risk here?',
    liveSelection: 'Our runway is 6 months and burn is climbing.',
    liveMustNot: ['—', '–', 'Looking at your screen', 'Based on the text']
  },
  {
    id: 'act-has-charter',
    mode: 'act',
    behavior: 'Act mode inherits the charter AND keeps its ACT_RESULT contract',
    mustContain: [RULE.actNotAsk, RULE.voiceNoDash, 'ACT_RESULT:'],
    weight: 2
  },
  {
    id: 'recall-honesty',
    mode: 'recall',
    behavior: 'Recall mode carries the honesty rule (never invent past activity)',
    mustContain: [RULE.honest, "don't have a record"],
    weight: 2,
    liveInput: 'what did I work on last Tuesday?',
    liveMustNot: ['—', '–']
  },
  {
    id: 'voice-no-dash-everywhere',
    mode: 'ask',
    behavior: 'The no-em-dash voice rule reaches every mode via the charter',
    mustContain: [RULE.voiceNoDash],
    weight: 1
  },
  {
    id: 'mode-mechanics-survive',
    mode: 'rewrite',
    behavior: 'Mode-specific mechanics still present alongside the charter',
    mustContain: ['Output ONLY the rewritten text'],
    weight: 1
  }
]
