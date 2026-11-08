/**
 * The macOS shell: what we spawn CLIs through and how we quote for it.
 * SINGLE SOURCE OF TRUTH — every spawn site (runner, ipc probes, prewarm) goes
 * through the boundary's `shell` domain so quoting can never drift between them.
 */

export const bin = '/bin/zsh'
export const pathPrefix = '/opt/homebrew/bin:/usr/local/bin'

/**
 * Single-quote a string so it is safe to pass as one shell argument.
 * Wraps in '…' and escapes any embedded single quotes via the '\'' idiom.
 */
export function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Argv that makes zsh run one command string. */
export function spawnArgs(cmd: string): string[] {
  return ['-c', cmd]
}

/** Command fragment expanding to the contents of `path` as one argument. */
export function fileText(path: string): string {
  return `"$(cat ${quote(path)})"`
}

/**
 * The env the LLM/CLI children run with. Prepends the homebrew bin dirs to PATH
 * so the spawned CLIs resolve their own dependencies and OAuth/keychain auth the
 * same way they would in an interactive login shell.
 */
export function env(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${pathPrefix}:${process.env.PATH || ''}` }
}

const AGENT_MARKER_ENV = /^(AI_AGENT|CLAUDECODE|CLAUDE_CODE.*|CODEX_(SANDBOX|CI|THREAD_ID)|CURSOR_(TRACE_ID|AGENT)|GEMINI_CLI|ANTIGRAVITY_AGENT|AUGMENT_AGENT|OPENCODE_CLIENT|REPL_ID|COPILOT_.*)$/

// A signed-out vercel CLI that sees these opens a browser login on every background probe.
export function probeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out = env()
  for (const key of Object.keys(out)) if (AGENT_MARKER_ENV.test(key)) delete out[key]
  return { ...out, ...extra }
}

/** The tool line the act-mode system prompt shows the agent (moved verbatim from config). */
export function agentToolHints(): string {
  return '- Use macOS-native tools when possible: `ffmpeg`, `say`, `sips`, `qlmanage`, `osascript`, `mdls`, `pdftotext`, `pandoc`. Homebrew is at /opt/homebrew/bin.'
}
