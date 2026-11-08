import type { AppKind, InfraEnvironment, InfraSurface } from './infra'

export const ENV_ALIASES: Record<string, string> = {
  prod: 'prod',
  production: 'prod',
  live: 'prod',
  staging: 'staging',
  stage: 'staging',
  stg: 'staging',
  preview: 'preview',
  dev: 'dev',
  development: 'dev'
}

export interface SessionDeploy {
  at: number
  command: string
}

export interface SessionTouched {
  edits: Record<string, number>
  reads: Record<string, number>
  deploys: SessionDeploy[]
  asked: Record<string, number>
}

export interface AffectedSurface {
  name: string
  kind?: AppKind
  files: number
  reads: number
  lastAt: number
  stated?: boolean
}

export interface AffectedEnv {
  name: string
  lastAt: number
  stated?: boolean
  asked?: boolean
}

export interface SessionAffects {
  surfaces: AffectedSurface[]
  envs: AffectedEnv[]
}

export const NO_AFFECTS: SessionAffects = { surfaces: [], envs: [] }
export const AFFECTS_MAX = 12
export const EDITS_KEPT = 2000
export const READS_KEPT = 2000
export const DEPLOYS_KEPT = 50
const READS_MIN = 3
const COMMAND_PATHS_MAX = 40
const DEPLOY_COMMAND_MAX = 300

const SEGMENT = /\n|&&|\|\||[;|]/
const DEPLOY_WORD = /deploy/i
const NOT_A_DEPLOY = new Set(
  'git grep rg cat sed awk echo printf ls head tail wc find less open curl wget jq diff stat test rm cp mv mkdir chmod touch #'.split(
    ' '
  )
)
const LEAD = /^(?:[({!]\s*|(?:if|then|do|time|sudo)\s+|\w+=\S*\s*)+/
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g

export function deploySegments(command: string): string[] {
  return command
    .replace(HEREDOC, '')
    .replace(QUOTED, (quoted) => (/\s/.test(quoted) ? '' : quoted))
    .split(SEGMENT)
    .map((segment) => segment.trim().replace(LEAD, ''))
    .filter((segment) => DEPLOY_WORD.test(segment) && !segment.includes('--dry-run'))
    .filter((segment) => !NOT_A_DEPLOY.has(segment.split(/\s+/)[0]))
    .map((segment) => segment.slice(0, DEPLOY_COMMAND_MAX))
}

const SHIP_WORD = /\b(?:deploy|ship|release|publish|push|roll out)\b/i
const NEGATED = /\b(?:not|never|without|no|(?:do|does|did|wo|ca|should)n'?t)\b/i
const ASKED_ENV = /\b(?:staging|stg|prod|production)\b/gi
const ASK_MAX = 1500

export function askedEnvs(said: string): string[] {
  if (said.length > ASK_MAX || said.startsWith('<')) return []
  const found = new Set<string>()
  for (const sentence of said.split(/[.!?]\s+|\n+/)) {
    if (!SHIP_WORD.test(sentence) || NEGATED.test(sentence)) continue
    for (const word of sentence.match(ASKED_ENV) ?? []) found.add(ENV_ALIASES[word.toLowerCase()])
  }
  return [...found]
}

const PATH_TOKEN = /^(?:~|\.{1,2})?\/?[\w@.-]+\/[\w@./-]*$/

export function commandPaths(command: string): string[] {
  return command
    .split(/[\s'"`=;|&()<>,]+/)
    .filter((token) => token.length < 300 && PATH_TOKEN.test(token))
    .slice(0, COMMAND_PATHS_MAX)
}

function aliasOf(token: string): string | undefined {
  const bare = token
    .replace(/^['"]|['"]$/g, '')
    .replace(/^--?(?:env(?:ironment)?=)?/, '')
    .toLowerCase()
  return ENV_ALIASES[bare]
}

export function deployEnvs(segment: string, environments: InfraEnvironment[]): string[] {
  const found = new Set<string>()
  const words = segment.split(/\s+/)
  const at = words.findIndex((word) => DEPLOY_WORD.test(word))
  if (at < 0) return []
  const tail = words[at].slice(words[at].search(DEPLOY_WORD)).split(/[^a-z]+/i)
  for (const word of [...tail, ...words.slice(at + 1)]) {
    const env = aliasOf(word)
    if (env) found.add(env)
  }
  for (const env of environments) {
    const hosts = env.urls.map((url) => url.replace(/^https?:\/\//, ''))
    const marks = [...env.accounts.map((a) => a.id), ...hosts]
    if (marks.some((mark) => mark && segment.includes(mark))) found.add(env.name)
  }
  return [...found]
}

function title(dir: string): string {
  const base = dir.split('/').filter(Boolean).pop() ?? ''
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/[-_]/g, ' ')
}

const APP_DIR = String.raw`(?!(?:scripts?|bin|tools|public|static|docs?|build|tests?|examples?)\/)[^/]+\/`
const webName = (dir: string): string => title(dir) || 'Web app'

const SURFACE_RULES: { match: RegExp; name: (dir: string) => string; kind?: AppKind }[] = [
  { match: /^((?:[^/]+\/)*)[^/]+\.xcodeproj\//, name: () => 'iPhone app', kind: 'mobile' },
  {
    match: /^((?:(?:[^/]+\/)*android\/)?)(?:build|settings)\.gradle/,
    name: () => 'Android app',
    kind: 'mobile'
  },
  {
    match: /^(supabase\/(?=functions\/)|functions\/(?=package\.json$))/,
    name: () => 'Cloud backend',
    kind: 'worker'
  },
  {
    match: new RegExp(`^((?:${APP_DIR}){0,2}(?:server|backend|api)\\/)(?:package\\.json$|src\\/)`),
    name: () => 'Backend',
    kind: 'worker'
  },
  { match: new RegExp(`^(${APP_DIR})deploy\\.sh$`), name: title, kind: 'web' },
  {
    match: new RegExp(
      `^((?:${APP_DIR}){0,3}(?=public\\/index\\.html$)|(?:${APP_DIR})?(?=index\\.html$))`
    ),
    name: webName,
    kind: 'web'
  },
  {
    match: new RegExp(`^((?:${APP_DIR}){0,3})(?:vite|next|astro|nuxt|svelte)\\.config\\.\\w+$`),
    name: webName,
    kind: 'web'
  },
  {
    match: /^((?:[^/]+\/)*)wrangler\.(?:toml|jsonc?)$/,
    name: (dir) => (title(dir) ? `${title(dir)} worker` : 'Worker'),
    kind: 'worker'
  },
  { match: /^(src\/)(?:main|preload)\/index\.\w+$/, name: () => 'Desktop app', kind: 'desktop' },
  { match: /^(apps\/[^/]+\/)/, name: title }
]

export function detectSurfaces(files: string[]): InfraSurface[] {
  const byName = new Map<string, InfraSurface>()
  const taken = new Set<string>()
  const monorepo = files.some((file) => file.startsWith('apps/'))
  for (const rule of SURFACE_RULES) {
    for (const file of files) {
      const dir = rule.match.exec(file)?.[1]
      if (dir === undefined || taken.has(dir) || (monorepo && dir === '')) continue
      taken.add(dir)
      const name = rule.name(dir)
      const surface = byName.get(name) ?? { name, paths: [], kind: rule.kind }
      surface.paths.push(dir)
      byName.set(name, surface)
    }
  }
  return [...byName.values()]
}

function overlaps(a: InfraSurface, b: InfraSurface): boolean {
  return a.paths.some((p) => b.paths.some((q) => p.startsWith(q) || q.startsWith(p)))
}

export function mergeSurfaces(
  scanned: InfraSurface[],
  previous: InfraSurface[] = []
): InfraSurface[] {
  const manual = previous.filter((s) => s.manual)
  return [...manual, ...scanned.filter((s) => !manual.some((m) => overlaps(m, s)))]
}

function surfaceFor(path: string, surfaces: InfraSurface[]): InfraSurface | undefined {
  let best: InfraSurface | undefined
  let length = -1
  for (const surface of surfaces) {
    for (const prefix of surface.paths) {
      if (path.startsWith(prefix) && prefix.length > length) {
        best = surface
        length = prefix.length
      }
    }
  }
  return best
}

export function affectNames(record: {
  surfaces?: InfraSurface[]
  environments?: InfraEnvironment[]
}): string[] {
  return [
    ...(record.surfaces ?? []).map((s) => s.name),
    ...(record.environments ?? []).map((e) => e.name)
  ]
}

export function unknownAffects(stated: string[], names: string[]): string[] {
  const known = new Set(names.map((n) => n.toLowerCase()))
  return stated.filter((name) => {
    const key = name.trim().toLowerCase()
    return !known.has(key) && !known.has(ENV_ALIASES[key] ?? '')
  })
}

export function sessionAffects(
  touched: SessionTouched,
  where: { root: string; cwd: string },
  record: { surfaces?: InfraSurface[]; environments?: InfraEnvironment[] },
  stated: string[] = []
): SessionAffects {
  const surfaces = record.surfaces ?? []
  const environments = record.environments ?? []
  const prefix = where.root.endsWith('/') ? where.root : `${where.root}/`
  const bySurface = new Map<string, AffectedSurface>()
  const byEnv = new Map<string, AffectedEnv>()
  const surfaceRow = (s: InfraSurface): AffectedSurface =>
    bySurface.get(s.name) ?? { name: s.name, kind: s.kind, files: 0, reads: 0, lastAt: 0 }
  const envRow = (name: string): AffectedEnv => byEnv.get(name) ?? { name, lastAt: 0 }

  const surfaceOf = (path: string): InfraSurface | undefined => {
    const full = path.startsWith('/') ? path : `${where.cwd}/${path.replace(/^\.\//, '')}`
    return full.startsWith(prefix) ? surfaceFor(full.slice(prefix.length), surfaces) : undefined
  }

  for (const [path, at] of Object.entries(touched.edits)) {
    const surface = surfaceOf(path)
    if (!surface) continue
    const row = surfaceRow(surface)
    bySurface.set(surface.name, { ...row, files: row.files + 1, lastAt: Math.max(row.lastAt, at) })
  }
  const looked = new Map<InfraSurface, { reads: number; lastAt: number }>()
  for (const [path, at] of bySurface.size ? [] : Object.entries(touched.reads)) {
    const surface = surfaceOf(path)
    if (!surface) continue
    const seen = looked.get(surface) ?? { reads: 0, lastAt: 0 }
    looked.set(surface, { reads: seen.reads + 1, lastAt: Math.max(seen.lastAt, at) })
  }
  const most = Math.max(0, ...[...looked.values()].map((seen) => seen.reads))
  for (const [surface, seen] of looked) {
    if (seen.reads >= Math.max(READS_MIN, most / 3))
      bySurface.set(surface.name, { ...surfaceRow(surface), ...seen })
  }
  for (const deploy of touched.deploys) {
    for (const name of deployEnvs(deploy.command, environments)) {
      byEnv.set(name, { ...envRow(name), lastAt: Math.max(envRow(name).lastAt, deploy.at) })
    }
  }
  for (const name of stated) {
    const key = name.trim().toLowerCase()
    const surface = surfaces.find((s) => s.name.toLowerCase() === key)
    if (surface) bySurface.set(surface.name, { ...surfaceRow(surface), stated: true })
    const env = environments.find((e) => e.name === (ENV_ALIASES[key] ?? key))
    if (env) byEnv.set(env.name, { ...envRow(env.name), stated: true })
  }
  for (const [name, at] of Object.entries(touched.asked)) {
    if (!byEnv.has(name) && environments.some((env) => env.name === name))
      byEnv.set(name, { name, lastAt: at, asked: true })
  }
  const recent = (a: { lastAt: number }, b: { lastAt: number }): number => b.lastAt - a.lastAt
  return { surfaces: [...bySurface.values()].sort(recent), envs: [...byEnv.values()].sort(recent) }
}
