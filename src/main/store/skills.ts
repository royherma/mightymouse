import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { PATHS } from './paths'
import { SkillInfo } from '../../shared/types'

// Discover the user's Claude Code skills by scanning ~/.claude/skills/. The dir IS
// the source of truth the backend agent loads from, so reading it live keeps the
// chip-body autocomplete always in sync — no copy, no persisted snapshot to drift.
//
// A skill = any entry (real dir OR symlink-to-dir, both common in that folder) that
// contains a SKILL.md. statSync follows symlinks, so linked skills are included.
// `_lib` and stray loose files have no SKILL.md and fall out naturally.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/
// Read at most this many bytes of a SKILL.md — we only need the frontmatter block
// at the top, never the whole body. Bounds the scan when a skill file is large.
const HEAD_BYTES = 4096

function parseField(frontmatter: string, field: string): string {
  // Matches `field: value` (optionally quoted), one line, frontmatter only.
  const re = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm')
  const m = frontmatter.match(re)
  if (!m) return ''
  return m[1].replace(/^['"]|['"]$/g, '').trim()
}

function readHead(filePath: string): string {
  try {
    // SKILL.md files are small; read fully and slice the head. We only need the
    // frontmatter block at the top, so cap the string we hand to the regex.
    return readFileSync(filePath, 'utf-8').slice(0, HEAD_BYTES)
  } catch {
    return ''
  }
}

export const SKILLS = {
  // Returns every available skill, sorted by name. Cheap enough to call on each
  // editor open; if it ever isn't, add a short-TTL cache here (not a persisted one).
  list(): SkillInfo[] {
    const root = PATHS.CLAUDE_SKILLS
    if (!existsSync(root)) return []
    const out: SkillInfo[] = []
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      return []
    }
    for (const entry of entries) {
      const dir = join(root, entry)
      let isDir = false
      try {
        // statSync follows symlinks → linked skill dirs count as dirs.
        isDir = statSync(dir).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      const skillMd = join(dir, 'SKILL.md')
      if (!existsSync(skillMd)) continue
      const head = readHead(skillMd)
      const fm = head.match(FRONTMATTER_RE)?.[1] ?? ''
      // Prefer the frontmatter `name`, fall back to the folder name.
      const name = parseField(fm, 'name') || entry
      const description = parseField(fm, 'description')
      out.push({ name, description })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }
}
