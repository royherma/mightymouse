// skill-sinks.ts — your Claude Code skills, as routing destinations.
//
// The third source of sinks, alongside the open apps (sinks.ts) and the running
// agents (agent-sinks.ts). Picking one runs `/<name> <transcript>`: the Claude
// CLI resolves a leading slash command in print mode, so the dictated text
// becomes the skill's argument exactly as if it had been typed.
//
// ALL skills are offered, and the budget that pays for that is shortDescription
// below. Raw, the ~150 descriptions on disk total ~17k tokens; trimmed, the same
// 150 cost 4,873 — measured, not modelled. An earlier version capped the list at
// the 30 most-used against that 17k figure, but the trimmer already runs first,
// so the cap was paying 120 unreachable skills to save 3,791 tokens. On a fresh
// install with no usage counts it ranked alphabetically, which offered nine
// adsinagents-* variants and hid every mightymouse-* skill.
import { SKILLS } from '../store/skills'
import type { JevSink } from './jev-client'

/** A SKILL.md description is written to tell the skill LOADER when to fire, not
 *  to identify the skill to a ranking model: it runs long (p90 ~850 chars),
 *  repeats itself, and most end with a "Triggers: /name, 'phrase', 'phrase'..."
 *  clause that is pure alias/trigger-phrase noise for Jev. Measured against the
 *  real ~150 skills in ~/.claude/skills (scratchpad script): stripping that tail
 *  and taking whole sentences up to this cap raised the average identifying
 *  content per skill (99 -> 122 chars) while keeping the total for 30 skills
 *  at ~918 tokens, still ~4.5x under the app-list order of magnitude. */
const MAX_DESCRIPTION_CHARS = 200

/** Boilerplate clauses that describe the LOADER's job ("fire on this phrasing"),
 *  not the skill's job. Cut so the budget goes to identifying content instead. */
const TRIGGER_TAIL_RE = /\s*(Triggers?:|Trigger:|Use when:|Examples?:)[\s\S]*$/i
const LEADING_BOILERPLATE_RES = [
  /^Use this (skill|agent) (when|proactively when|to)\s*/i,
  /^This skill (is used|should be used|is for)\s*/i
]

const SKILL_SINK_PREFIX = 'skill:'

export interface SkillSink extends JevSink {
  kind: 'skill'
  /** The bare skill name, which is what gets prefixed with '/' when it runs. */
  skillName: string
}

export function isSkillSinkId(id: string): boolean {
  return id.startsWith(SKILL_SINK_PREFIX)
}

export function skillNameFromSinkId(id: string): string {
  return id.slice(SKILL_SINK_PREFIX.length)
}

/** Strip loader-only boilerplate, then take whole sentences up to the cap.
 *
 * The old version took only the first sentence and hard-cut at 200 chars
 * regardless of word boundaries. Measured: 21 of 149 real skills have a first
 * sentence longer than 200 chars (e.g. "adsinagents-ops-health", "cloudflare",
 * "yap"), so that path handed Jev a mid-word fragment like "...write each
 * lane's standup, and roll up a…" — unreadable, and worse than a plain name.
 * It also stopped at sentence one even when the SECOND sentence was the
 * distinguishing part (e.g. "adsinagents-nudge"'s install-vs-activate table is
 * sentence two onward — the whole reason to route there over its sibling). */
function shortDescription(description: string): string {
  let flat = description.replace(/\s+/g, ' ').trim()
  flat = flat.replace(TRIGGER_TAIL_RE, '').trim()
  for (const re of LEADING_BOILERPLATE_RES) flat = flat.replace(re, '')
  if (flat === '') flat = description.replace(/\s+/g, ' ').trim()

  // A '.'/'!'/'?' only ends a sentence when followed by a space (or the end of
  // the string) — NOT when directly followed by a letter/digit, which is a
  // domain or abbreviation instead ("adsinagents.com)", "e.g."). Measured bug:
  // without this, "AdsInAgents (adsinagents.com) viral..." split mid-URL and
  // handed Jev the fragment "...for AdsInAgents (adsinagents." — worse than
  // the boilerplate it was meant to remove.
  const sentences = flat.match(/.+?[.!?]+(?=\s|$)(?![a-zA-Z0-9])/gs) ?? [flat]
  let out = ''
  for (const sentence of sentences) {
    if ((out + sentence).length > MAX_DESCRIPTION_CHARS) break
    out += sentence
  }
  if (out !== '') return out.trim()

  // Even one sentence overflows the cap: cut at the last whole word rather
  // than mid-word, so the fragment Jev sees is still readable.
  if (flat.length <= MAX_DESCRIPTION_CHARS) return flat
  const cut = flat.slice(0, MAX_DESCRIPTION_CHARS - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`
}

/**
 * Snapshot the skills that could receive this transcript — all of them.
 */
export function collectSkillSinks(): SkillSink[] {
  return SKILLS.list()
    .filter((s) => s.name.trim() !== '')
    .map((skill) => ({
      kind: 'skill' as const,
      id: `${SKILL_SINK_PREFIX}${skill.name}`,
      label: `/${skill.name}`,
      description:
        skill.description === '' ? `The ${skill.name} skill` : shortDescription(skill.description),
      skillName: skill.name
    }))
}
