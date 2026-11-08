import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { bin as shellBin, pathPrefix } from './shell'
import { IS_DEV, devLog } from '../../../shared/env'

/**
 * Make the packaged app's PATH match the user's real interactive terminal.
 *
 * WHY: a GUI `.app` launched from Finder/Dock inherits a minimal `launchd` PATH —
 * it does NOT load the user's `.zshrc`/`.zprofile`, so user-local install dirs
 * (`~/.local/bin`, nvm, asdf, pyenv…) are invisible. In `npm run dev` the app
 * inherits the terminal's full PATH, so this never bites in dev — only in the
 * installed build. Symptom: `codex` at `~/.local/bin/codex` reads as "not found",
 * and `claude auth status` can't see the CLI's own auth because the child spawns
 * with the wrong environment. Both trace back to PATH.
 *
 * FIX: once, at startup, ask the user's login shell for its real PATH and merge it
 * into `process.env.PATH`. Every downstream spawn (resolve-binary, the auth probe,
 * runner.ts, prewarm) reads `process.env.PATH` via `shellEnv()`, so fixing it here
 * fixes all of them with no signature changes.
 *
 * Additive + idempotent: we only ever APPEND dirs the current PATH lacks, never
 * replace it, and running twice is a no-op. Safe to call unconditionally.
 */

let applied = false

/** Dirs we always want on PATH even if the login-shell probe fails (best-effort floor). */
function guaranteedUserDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    ...pathPrefix.split(':').filter(Boolean)
  ]
}

/** Ask the login shell for its PATH. Empty array on any failure (never throws). */
function loginShellPathDirs(): string[] {
  try {
    // `zsh -lc 'echo $PATH'` loads the login profile so PATH matches a real terminal.
    // -l (login) picks up .zprofile; interactive-guarded .zshrc lines may be skipped,
    // which is exactly why guaranteedUserDirs() backstops ~/.local/bin below.
    const out = execFileSync(shellBin, ['-lc', 'echo -n "$PATH"'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: process.env
    })
    return out.trim().split(':').filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Merge the user's real login-shell PATH + guaranteed user bin dirs into
 * process.env.PATH. Idempotent; call once early in bootCore, before any spawn.
 */
export function applyLoginShellPath(): void {
  if (applied) return
  applied = true

  const current = (process.env.PATH || '').split(':').filter(Boolean)
  const seen = new Set(current)
  const additions: string[] = []

  // Login-shell PATH first (the user's real ordering), then the guaranteed floor.
  for (const dir of [...loginShellPathDirs(), ...guaranteedUserDirs()]) {
    if (!seen.has(dir) && existsSync(dir)) {
      seen.add(dir)
      additions.push(dir)
    }
  }

  if (additions.length > 0) {
    process.env.PATH = [...current, ...additions].join(':')
    if (IS_DEV) devLog.log('[login-path] appended to PATH:', additions.join(', '))
  }
}
