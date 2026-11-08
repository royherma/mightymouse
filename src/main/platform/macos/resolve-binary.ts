import { execFileSync } from 'child_process'
import { existsSync, readdirSync, accessSync, constants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { CONFIG } from '../../../shared/config'
import { bin as shellBin, pathPrefix } from './shell'

/**
 * Resolve a CLI binary to an absolute path at runtime — DETERMINISTICALLY.
 *
 * The login-shell `which` was the fragile part: a machine can have TWO installs of
 * the same CLI (e.g. `~/.local/bin/claude` @2.1.207 logged-in vs an older
 * `/opt/homebrew/bin/claude` @2.0.30 that's logged-out), and `which` — subject to
 * PATH ordering, aliases, and shell wrappers — can pick the wrong one, so detection
 * reads a logged-out/older binary and reports a false "Not logged in."
 *
 * Fix: a fixed PRIORITY ORDER of concrete directories, `which` only as a last
 * resort. Highest priority wins:
 *   1. User override (Settings) — always wins if it exists on disk.
 *   2. ~/.local/bin, ~/bin — where the official installers put the newest CLI.
 *   3. Homebrew (shell.pathPrefix: /opt/homebrew/bin, /usr/local/bin).
 *   4. `which <name>` via the login shell — LAST resort for exotic installs
 *      (nvm/asdf shims, custom dirs). Its result is still existsSync-validated.
 *   5. null — caller surfaces "not installed".
 *
 * Rationale for ~/.local before brew: the standalone installer (`~/.local`) tracks
 * the newest version; a stale Homebrew Cask lingers behind. Newer + user-scoped is
 * the one the user actually logged into. The Settings override is the escape hatch
 * for anyone who wants a different one.
 *
 * Results are cached per name (call `clearBinaryCache()` to force re-resolution,
 * e.g. after the user edits the override or installs the binary). The chosen path
 * is inspectable via `resolveBinaryVerbose()` so the UI can show WHICH binary
 * answered — a wrong-binary situation is then diagnosable, never hidden.
 */
const cache = new Map<string, string | null>()

/**
 * Node version managers install npm OUTSIDE every standard dir, and under nvm
 * `npm` isn't even an executable — it's a lazy-loading shell function, so
 * `command -v npm` prints the bare word "npm" and the existsSync guard in
 * whichViaLoginShell correctly rejects it. Net effect before this existed: a
 * developer with nvm was told "not found" for a tool that plainly works in
 * their terminal — and nvm users are exactly our early-tester population.
 *
 * So probe the version managers' own bin dirs directly. Newest version first
 * (reverse lexical is right for nvm's `v20.19.5` naming, and close enough for
 * the others that a wrong pick still yields a working npm).
 */
function versionManagerBins(): string[] {
  const home = homedir()
  const roots = [
    join(home, '.nvm', 'versions', 'node'),
    join(home, '.local', 'share', 'fnm', 'node-versions'),
    join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
    join(home, '.volta', 'tools', 'image', 'node')
  ]
  const out: string[] = []
  for (const root of roots) {
    try {
      const versions = readdirSync(root).sort().reverse()
      // fnm nests one level deeper (<version>/installation/bin).
      for (const v of versions) out.push(join(root, v, 'bin'), join(root, v, 'installation', 'bin'))
    } catch {
      // Root absent — that manager isn't installed. Not an error.
    }
  }
  return out
}

/** Priority-ordered directories to probe directly, ahead of shelling out to `which`. */
function priorityDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    // Binaries we downloaded ourselves (ffmpeg, cloudflared). Deliberately BELOW
    // the user's own dirs — if they already have ffmpeg installed, theirs wins —
    // and ABOVE Homebrew, so a managed copy answers on a Mac with no brew at all.
    join(home, CONFIG.APP_NAME, 'bin'),
    ...pathPrefix.split(':').filter(Boolean),
    // Last: a version-manager npm is a fallback, never preferred over a
    // Homebrew/system one that's already on PATH.
    ...versionManagerBins()
  ]
}

/** How a resolution was reached — for the UI + the detection diagnostic. */
export type ResolveSource = 'override' | 'priority-dir' | 'login-shell' | 'not-found'
export interface ResolveResult {
  path: string | null
  source: ResolveSource
}

function whichViaLoginShell(name: string): string | null {
  try {
    // `zsh -lc` loads the login profile so PATH matches an interactive terminal.
    // execFileSync (not exec) — no shell-string interpolation of `name`.
    const out = execFileSync(shellBin, ['-lc', `command -v ${name}`], {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PATH: `${pathPrefix}:${process.env.PATH || ''}` }
    })
    const resolved = out.trim().split('\n')[0]?.trim()
    return resolved && existsSync(resolved) ? resolved : null
  } catch {
    return null
  }
}

/**
 * Resolve with provenance — same priority order as resolveBinary, but returns HOW
 * it resolved so the UI/diagnostic can show which binary answered. Not cached
 * (cheap; the cached fast path is resolveBinary).
 */
export function resolveBinaryVerbose(name: string, override?: string): ResolveResult {
  if (override && override.trim() !== '' && existsSync(override)) {
    return { path: override, source: 'override' }
  }
  const inDir = priorityDirs()
    .map((dir) => join(dir, name))
    .find((p) => existsSync(p))
  if (inDir) return { path: inDir, source: 'priority-dir' }

  const viaShell = whichViaLoginShell(name)
  if (viaShell) return { path: viaShell, source: 'login-shell' }

  return { path: null, source: 'not-found' }
}

/**
 * @param name     bare binary name to look up (e.g. 'claude', 'codex', 'ffmpeg')
 * @param override optional absolute path from CONFIG/Settings; used only if it exists
 */
export function resolveBinary(name: string, override?: string): string | null {
  if (cache.has(name)) return cache.get(name) ?? null
  const resolved = resolveBinaryVerbose(name, override).path
  cache.set(name, resolved)
  return resolved
}

/** Resolved claude binary, or null if not installed. */
export function resolveClaude(): string | null {
  return resolveBinary('claude', CONFIG.CLAUDE_PATH)
}

/** Resolved codex binary, or null if not installed. */
export function resolveCodex(): string | null {
  return resolveBinary('codex', CONFIG.CODEX_PATH)
}

/** Resolved opencode binary, or null if not installed. */
export function resolveOpencode(): string | null {
  return resolveBinary('opencode', CONFIG.OPENCODE_PATH)
}

/** Resolved gemini binary, or null if not installed. */
export function resolveGemini(): string | null {
  return resolveBinary('gemini', CONFIG.GEMINI_PATH)
}

/** Resolved npm binary, or null. Covers nvm/fnm/volta via versionManagerBins(). */
export function resolveNpm(): string | null {
  return resolveBinary('npm')
}

/** Resolved Homebrew binary, or null if brew isn't installed. */
export function resolveBrewBin(): string | null {
  const { appleSilicon, intel } = CONFIG.BREW_PATH
  return [appleSilicon, intel].find((p) => existsSync(p)) ?? null
}

/**
 * Can we `npm install -g` WITHOUT sudo?
 *
 * Presence of npm is not the question — writability of its global prefix is.
 * A Node from the nodejs.org .pkg puts the prefix at /usr/local, which needs
 * sudo, and we refuse to raise a password prompt from a rewrite tool (it is
 * shape-identical to malware; see the ffmpeg PRD). A Homebrew or
 * version-manager Node keeps the prefix under the user's own tree.
 *
 * So: ask npm where it would write, then test that we may write there. If not,
 * the caller installs a Node we CAN write to rather than failing.
 */
export function npmPrefixWritable(npmPath: string): boolean {
  try {
    const prefix = execFileSync(npmPath, ['prefix', '-g'], {
      encoding: 'utf-8',
      timeout: 5000
    }).trim()
    if (!prefix) return false
    // npm creates lib/node_modules on demand, so probe the deepest dir that
    // already exists — writing there is what actually matters.
    for (const dir of [join(prefix, 'lib', 'node_modules'), join(prefix, 'lib'), prefix]) {
      if (existsSync(dir)) {
        accessSync(dir, constants.W_OK)
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

/** Drop cached lookups so the next resolve re-runs `which`. */
export function clearBinaryCache(): void {
  cache.clear()
}
