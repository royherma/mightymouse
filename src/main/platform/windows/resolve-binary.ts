/**
 * Resolve a CLI binary to an absolute path at runtime on Windows.
 *
 * Same shape and same reasoning as the macOS resolver: a fixed PRIORITY ORDER of
 * concrete directories first, the PATH search only as a last resort. A machine
 * can carry two installs of the same CLI (the standalone installer's in
 * `~\.local\bin`, an older `npm i -g` one in `%APPDATA%\npm`), and PATH order
 * decides which `where.exe` reports — which is how detection ends up reading a
 * logged-out binary and telling the user they aren't signed in.
 *
 * WINDOWS-SPECIFIC, and the part a straight port would get wrong: a "binary"
 * here is usually NOT an .exe. `npm i -g @anthropic-ai/claude-code` writes
 * `claude.cmd` (plus an extensionless shell script for Git Bash, which Windows
 * cannot execute). So every directory probe tries the PATHEXT-ish suffixes in
 * preference order, and an extensionless hit is deliberately never accepted:
 * spawning it produces "%1 is not a valid Win32 application".
 */
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, accessSync, constants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { CONFIG } from '../../../shared/config'

const cache = new Map<string, string | null>()

/**
 * Suffixes to try in a directory, best first.
 *
 * .exe before .cmd: a real executable spawns directly, while a .cmd needs
 * cmd.exe wrapped around it and swallows the child's exit code on a kill.
 * .ps1 last, and no bare name at all — see the file header.
 */
const EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.ps1']

/** `cmd.exe`, from the env when the machine relocated it. */
function comSpec(): string {
  return process.env.ComSpec || 'cmd.exe'
}

/**
 * Node version managers install npm outside every standard dir, and each one
 * lays its versions out differently:
 *   nvm-windows  %APPDATA%\nvm\v20.19.5\        (npm.cmd sits at the root)
 *   fnm          %APPDATA%\fnm\node-versions\<v>\installation\
 *   volta        %LOCALAPPDATA%\Volta\bin\      (one shim dir, not per-version)
 *
 * Newest first (reverse lexical is right for nvm's `v20.19.5` naming, and close
 * enough elsewhere that a wrong pick still yields a working npm).
 */
function versionManagerBins(): string[] {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const out: string[] = [join(localAppData, 'Volta', 'bin')]

  const versioned = [
    { root: join(appData, 'nvm'), nested: [] as string[] },
    { root: join(appData, 'fnm', 'node-versions'), nested: ['installation'] },
    { root: join(localAppData, 'fnm', 'node-versions'), nested: ['installation'] }
  ]
  for (const { root, nested } of versioned) {
    try {
      for (const v of readdirSync(root).sort().reverse()) {
        out.push(join(root, v, ...nested))
      }
    } catch {
      // Root absent — that manager isn't installed. Not an error.
    }
  }
  return out
}

/** Priority-ordered directories to probe directly, ahead of `where.exe`. */
function priorityDirs(): string[] {
  const home = homedir()
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  return [
    // The standalone installers' target — the same `~/.local/bin` they use on
    // macOS, and the one that tracks the newest version.
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    // npm's global prefix. This is where `npm i -g` lands by default and where
    // our own one-click CLI install writes.
    join(appData, 'npm'),
    join(localAppData, 'Programs'),
    // Last: a version-manager binary is a fallback, never preferred over one
    // that's already installed globally.
    ...versionManagerBins()
  ]
}

/** How a resolution was reached — for the UI + the detection diagnostic. */
export type ResolveSource = 'override' | 'priority-dir' | 'path-search' | 'not-found'
export interface ResolveResult {
  path: string | null
  source: ResolveSource
}

/** First existing `<dir>\<name><suffix>`, or null. */
function probeDir(dir: string, name: string): string | null {
  for (const suffix of EXECUTABLE_SUFFIXES) {
    const candidate = join(dir, `${name}${suffix}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * `where.exe` — the PATH search, and the only step that can find an install in
 * a directory we've never heard of.
 *
 * It prints EVERY match, one per line, and it will happily print the
 * extensionless shell script npm drops next to the .cmd. Filter to a suffix we
 * can actually spawn rather than taking line one.
 */
function whichViaPath(name: string): string | null {
  try {
    const out = execFileSync('where.exe', [name], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    })
    const runnable = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .find(
        (line) =>
          EXECUTABLE_SUFFIXES.some((s) => line.toLowerCase().endsWith(s)) && existsSync(line)
      )
    return runnable ?? null
  } catch {
    // where.exe exits 1 when nothing matched — the ordinary "not installed" case.
    return null
  }
}

/**
 * Resolve with provenance — same priority order as resolveBinary, but returns
 * HOW it resolved so the UI/diagnostic can show which binary answered. Not
 * cached (cheap; the cached fast path is resolveBinary).
 */
export function resolveBinaryVerbose(name: string, override?: string): ResolveResult {
  if (override && override.trim() !== '' && existsSync(override)) {
    return { path: override, source: 'override' }
  }
  for (const dir of priorityDirs()) {
    const hit = probeDir(dir, name)
    if (hit) return { path: hit, source: 'priority-dir' }
  }
  const viaPath = whichViaPath(name)
  if (viaPath) return { path: viaPath, source: 'path-search' }

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

/** Resolved npm binary, or null. Covers nvm-windows/fnm/volta via versionManagerBins(). */
export function resolveNpm(): string | null {
  return resolveBinary('npm')
}

/** Always null: Homebrew does not exist here. Settings shows a winget hint
 *  instead — see `installHint` in ./index.ts. */
export function resolveBrewBin(): string | null {
  return null
}

/**
 * Can we `npm install -g` without an elevation prompt?
 *
 * Usually yes — npm's default prefix on Windows is `%APPDATA%\npm`, inside the
 * user's own profile. The case this catches is a machine-wide Node installed to
 * `C:\Program Files\nodejs`, whose prefix needs an admin UAC prompt we refuse to
 * raise from a rewrite tool (it is shape-identical to malware).
 *
 * npm lays globals out flat here — `<prefix>\node_modules`, not
 * `<prefix>\lib\node_modules` as on POSIX — so the probe walks that shape.
 */
export function npmPrefixWritable(npmPath: string): boolean {
  try {
    // Through cmd.exe because npm on Windows is usually `npm.cmd`, and Node
    // refuses to execFile a .cmd directly. Passed as separate argv entries, so
    // nothing is interpolated into a command string.
    const prefix = execFileSync(comSpec(), ['/d', '/s', '/c', npmPath, 'prefix', '-g'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true
    }).trim()
    if (!prefix) return false
    // node_modules is created on demand, so probe the deepest dir that already
    // exists — writing there is what actually matters.
    for (const dir of [join(prefix, 'node_modules'), prefix]) {
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

/** Drop cached lookups so the next resolve re-runs the search. */
export function clearBinaryCache(): void {
  cache.clear()
}
