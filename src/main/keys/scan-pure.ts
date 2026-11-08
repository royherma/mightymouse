import { execFile } from 'child_process'
import { existsSync, readdirSync, Dirent } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { join, relative, extname } from 'path'

export const EXEC_TIMEOUT_MS = 8000

export const WRANGLER_CONFIG_RE = /^wrangler(\.[A-Za-z0-9_-]+)?\.(toml|jsonc|json)$/
const MAX_DEPTH = 3
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  'worktrees',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.output',
  '.cache',
  'coverage',
  'vendor'
])

const GENERIC_NAMES = new Set([
  'NODE_ENV',
  'PATH',
  'HOME',
  'CI',
  'PORT',
  'TZ',
  'LANG',
  'SHELL',
  'USER',
  'TMPDIR',
  'DEBUG'
])
const SECRET_HINT_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|DSN|WEBHOOK|SIGNING|PRIVATE|ACCESS|CLIENT_ID|ISSUER|ACCOUNT_ID|PROJECT_REF)/

export function isGenericName(name: string): boolean {
  if (name.startsWith('VITE_')) return false
  return GENERIC_NAMES.has(name)
}

export function looksLikeSecretName(name: string): boolean {
  return SECRET_HINT_RE.test(name)
}

export function walkFiles(root: string, matcher: (name: string) => boolean, maxDepth = MAX_DEPTH): string[] {
  const out: string[] = []
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name), depth + 1)
      } else if (matcher(entry.name)) {
        out.push(join(dir, entry.name))
      }
    }
  }
  walk(root, 0)
  return out
}

export async function walkFilesAsync(
  root: string,
  matcher: (name: string) => boolean,
  maxDepth = MAX_DEPTH
): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: Promise<void>[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) subdirs.push(walk(join(dir, entry.name), depth + 1))
      } else if (matcher(entry.name)) {
        out.push(join(dir, entry.name))
      }
    }
    await Promise.all(subdirs)
  }
  await walk(root, 0)
  return out.sort()
}

const ENV_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/,
  /^\.dev\.vars(\..+)?$/,
  /^Local\.xcconfig$/
]

const EXAMPLE_SUFFIX_RE = /\.(example|sample|template)$/

export async function findEnvFiles(repoFolder: string): Promise<string[]> {
  const direct = await walkFilesAsync(
    repoFolder,
    (name) => ENV_FILE_PATTERNS.some((re) => re.test(name)) && !EXAMPLE_SUFFIX_RE.test(name)
  )
  const extra = [
    join(repoFolder, 'supabase', '.env'),
    join(repoFolder, 'supabase', 'functions', '.env'),
    join(repoFolder, 'web', '.env'),
    join(repoFolder, 'portal', '.env')
  ].filter((p) => existsSync(p))
  const scratch = join(repoFolder, '.scratch-local')
  const scratchEnv = existsSync(scratch)
    ? await walkFilesAsync(scratch, (name) => name.endsWith('.env'), 1)
    : []
  return [...new Set([...direct, ...extra, ...scratchEnv])]
}

export interface ParsedEnvLine {
  name: string
  value: string
  line: number
}

export function parseEnvFile(contents: string): ParsedEnvLine[] {
  const out: ParsedEnvLine[] = []
  const lines = contents.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#')) continue
    const match = raw.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out.push({ name: match[1], value, line: i + 1 })
  }
  return out
}

const NEED_PATTERNS: RegExp[] = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /Deno\.env\.get\(['"]([A-Z][A-Z0-9_]+)['"]\)/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]+)/g
]

const WRANGLER_VAR_RE = /\$\{?([A-Z][A-Z0-9_]{3,})\}?/g
const WORKFLOW_SECRET_RE = /secrets\.([A-Z][A-Z0-9_]+)/g

export interface CodeNeed {
  name: string
  file: string
  line: number
  optional?: boolean
  isTest?: boolean
}

const TEST_FILE_RE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/
const DEV_SCRIPT_RE = /(^|\/)(scripts|bin)\//
const CLIENT_BUNDLE_RE = /^(VITE_|EXPO_PUBLIC_|NEXT_PUBLIC_)/

export function isTestPath(relPath: string): boolean {
  return TEST_FILE_RE.test(relPath)
}

const NULLISH_DEFAULT_RE = /\?\?|\|\|/
const GUARD_RE = /if\s*\(\s*!\s*[A-Za-z_$][\w$]*\s*\)|===\s*undefined|==\s*null|\?\./

export function hasFallbackNear(lines: string[], idx: number): boolean {
  const window = lines.slice(idx, idx + 3).join('\n')
  return NULLISH_DEFAULT_RE.test(window) || GUARD_RE.test(window)
}

const PASS_THROUGH_RE =
  /^\s*(?:[A-Za-z_$][\w$]*|['"][^'"]+['"])\s*:\s*(?:process\.env\.[A-Z][A-Z0-9_]*|Deno\.env\.get\(['"][A-Z][A-Z0-9_]*['"]\)|import\.meta\.env\.[A-Z][A-Z0-9_]*)\s*,?\s*$/

export function isPassThroughAssignment(line: string): boolean {
  return PASS_THROUGH_RE.test(line)
}

export function extractNeedsFromSource(relPath: string, contents: string): CodeNeed[] {
  const out: CodeNeed[] = []
  const lines = contents.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const re of NEED_PATTERNS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        if (!isGenericName(m[1]) && looksLikeSecretName(m[1])) {
          out.push({
            name: m[1],
            file: relPath,
            line: i + 1,
            optional: DEV_SCRIPT_RE.test(relPath) || CLIENT_BUNDLE_RE.test(m[1]) || hasFallbackNear(lines, i) || isPassThroughAssignment(line),
            isTest: isTestPath(relPath)
          })
        }
      }
    }
    if (/wrangler\.(toml|jsonc)$/.test(relPath)) {
      WRANGLER_VAR_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WRANGLER_VAR_RE.exec(line))) {
        if (!isGenericName(m[1])) out.push({ name: m[1], file: relPath, line: i + 1 })
      }
    }
    if (/\.github\/workflows\/.*\.ya?ml$/.test(relPath)) {
      WORKFLOW_SECRET_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WORKFLOW_SECRET_RE.exec(line))) {
        if (!isGenericName(m[1])) out.push({ name: m[1], file: relPath, line: i + 1 })
      }
    }
  }
  return out
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.toml', '.jsonc', '.yml', '.yaml'])

const READ_BATCH = 64

export async function scanRepoNeeds(repoFolder: string): Promise<CodeNeed[]> {
  const files = await walkFilesAsync(
    repoFolder,
    (name) => SOURCE_EXT.has(extname(name)) || name === 'wrangler.toml' || name === 'wrangler.jsonc',
    5
  )
  const out: CodeNeed[] = []
  for (let i = 0; i < files.length && out.length <= 5000; i += READ_BATCH) {
    const batch = files.slice(i, i + READ_BATCH)
    const contents = await Promise.all(batch.map((f) => readFile(f, 'utf-8').catch(() => null)))
    batch.forEach((file, j) => {
      const text = contents[j]
      if (text !== null) out.push(...extractNeedsFromSource(relative(repoFolder, file), text))
    })
    await new Promise((r) => setImmediate(r))
  }
  return out
}

export function isCommittedToGit(repoFolder: string, absPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--error-unmatch', relative(repoFolder, absPath)],
      { cwd: repoFolder, timeout: EXEC_TIMEOUT_MS },
      (err) => resolve(!err)
    )
  })
}
