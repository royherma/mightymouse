/**
 * version.ts — the typed binding for the agent charter.
 *
 * The charter prose lives in markdown (mission.md, principles.md) so it is
 * diffable and editable without a recompile. THIS file is the typed contract:
 * the version number you bump on every meaningful charter change, and the exact
 * list of files that compose into the prepended block, in order.
 *
 * Why typed: a bad filename here is a compile error, not a silent empty prompt.
 * The CHARTER_FILES tuple is `as const` so callers get the literal list, and the
 * no-magic-strings rule is honored (one definition, imported, never duplicated).
 *
 * Bump CHARTER_VERSION whenever mission.md or principles.md changes in a way you
 * want to eval or roll back. The eval report tags every run with this number so
 * "v3 scored 90, v4 scored 93" is a real, recorded comparison.
 */

/** Monotonic charter version. Bump on any meaningful mission/principles edit. */
export const CHARTER_VERSION = 1 as const

/**
 * The markdown files composed into the charter block, in prepend order.
 * Paths are relative to the agent-charter/ directory (resolved in charter.ts).
 * Order matters: mission (who/why) before principles (how).
 */
export const CHARTER_FILES = ['mission.md', 'principles.md'] as const

export type CharterFile = (typeof CHARTER_FILES)[number]
