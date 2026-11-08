import React from 'react'
import { Terminal } from 'lucide-react'
import { ProviderIcon, type ProviderIconId } from './ProviderIcon'

/**
 * The logo of whoever makes the agent running in a session — Anthropic's mark
 * for Claude Code, OpenAI's for Codex — so a list of agents is told apart by
 * sight before it is read.
 *
 * The fallback is the point of this file existing rather than calling
 * `ProviderIcon` directly: `vendor` is absent for every editor that fronts
 * several models (Cursor, VS Code) and for any shim too old to report an agent,
 * and those must render a neutral terminal glyph. Drawing some vendor's logo
 * there would be a claim we cannot make.
 */
export function AgentMark({
  vendor,
  size = 11
}: {
  /** A `ProviderIconId` from `sessionRow`, or undefined when the agent's vendor
   *  is unknown or genuinely ambiguous. */
  vendor?: string
  size?: number
}): React.ReactElement {
  if (!vendor || !isProviderIconId(vendor)) {
    return <Terminal size={size} strokeWidth={2} aria-hidden />
  }
  return <ProviderIcon id={vendor} size={size} />
}

// A narrowing guard, not a cast: `vendor` crosses the IPC boundary as a plain
// string, so an id this build does not know about must fall through to the
// neutral glyph rather than reaching ProviderIcon's switch and rendering
// whatever its default branch happens to be.
const PROVIDER_ICON_IDS = new Set<string>([
  'mightymouse',
  'claude',
  'codex',
  'opencode',
  'gemini',
  'glm',
  'deepseek',
  'kimi',
  'qwen',
  'grok',
  'auto',
  'local',
  'mlx',
  'openrouter'
])

function isProviderIconId(v: string): v is ProviderIconId {
  return PROVIDER_ICON_IDS.has(v)
}
