/**
 * detectMode — classify a free-text instruction into an AppMode.
 *
 * Precedence (highest to lowest):
 *   1. Prefix shortcuts: '?' → ask, '!' → act
 *   2. Leading ACT_VERBS  (e.g. "convert ", "make ", "remove background") → act
 *   3. Leading ASK_VERBS  (e.g. "what ", "tell me", "summarize")         → ask
 *   4. Default → rewrite
 *
 * Both verb lists are case-insensitive matches against the trimmed instruction.
 */
import { AppMode, RunKind } from './types'
import { CONFIG } from './config'

// Runtime SSOT for the AppMode union — the one place to validate a string is a
// real mode (store decoders, prefs guards). Adding a mode to the union is a
// compile error until this array lists it, so no guard can silently drift.
export const APP_MODES = ['rewrite', 'ask', 'act', 'write'] as const satisfies readonly AppMode[]

export function isAppMode(v: unknown): v is AppMode {
  return typeof v === 'string' && (APP_MODES as readonly string[]).includes(v)
}

/**
 * Which THEME_TOKENS hue each kind wears — the SSOT for "what color is this
 * mode", in `shared` so both the Electron renderer and the phone-remote bundle
 * read one declaration. The phone cannot import renderer/mode-colors.ts (that
 * module resolves through the Electron window and the standalone Vite bundle is
 * barred from src/renderer), so the mapping lived there AND was hand-copied into
 * the phone's history-kinds.ts — two copies of one fact, the exact drift shape
 * `phone-remote-protocol.ts` exists to prevent.
 *
 * Values are token NAMES, not colors: each resolves to `--<hue>` plus the
 * matching `*BgSubtle`/`*BorderSubtle` on both surfaces, so a palette tweak in
 * CONFIG.THEME_TOKENS still moves every surface at once.
 *
 * rewrite (most-used) gets its own rose rather than the brand accent orange, so
 * the mode reads as an identity and not "the default"; act is violet because red
 * read like an error.
 */
export const KIND_HUES = {
  rewrite: 'rose',
  ask: 'cyan',
  act: 'violet',
  write: 'blue',
  listen: 'green',
  recording: 'red',
  screenshot: 'amber'
} as const satisfies Record<RunKind, string>

export type KindHue = (typeof KIND_HUES)[keyof typeof KIND_HUES]

export function isRunKind(v: unknown): v is RunKind {
  return typeof v === 'string' && v in KIND_HUES
}

/** The hue for a kind, or null for an unknown string off the wire. */
export function kindHue(kind: string): KindHue | null {
  return isRunKind(kind) ? KIND_HUES[kind] : null
}

/**
 * Strip a leading `?`/`!` mode-routing prefix (and any space after it) from an
 * instruction. The prefix is a UI shortcut to pick the mode — it must NOT reach
 * the model as part of the instruction. `detectMode` reads the prefix; this removes
 * it before send. Only the FIRST char is a prefix, so `!!urgent` → `!urgent`.
 */
export function stripModePrefix(instr: string): string {
  const t = instr.trimStart()
  if (t.startsWith('?') || t.startsWith('!')) {
    return t.slice(1).trimStart()
  }
  return instr
}

export function detectMode(instr: string): AppMode {
  const t = instr.trim()
  if (t.startsWith('?')) return 'ask'
  if (t.startsWith('!')) return 'act'
  const lower = t.toLowerCase()
  for (const v of CONFIG.ACT_VERBS) {
    if (lower.startsWith(v.toLowerCase())) return 'act'
  }
  for (const p of CONFIG.ASK_VERBS) {
    if (lower.startsWith(p.toLowerCase())) return 'ask'
  }
  return 'rewrite'
}
