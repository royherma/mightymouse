import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { extname, join } from 'path'
import { PATHS } from './paths'

const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.svg'])

const DISCOVER_REL = [
  'web/remote/icon-512.png',
  'web/remote/apple-touch-icon.png',
  'web/remote/icon-192.png',
  'web/favicon.png',
  'web/favicon.ico',
  'web/icon.png',
  'web/apple-touch-icon.png',
  'public/icon-512.png',
  'public/apple-touch-icon.png',
  'public/favicon.ico',
  'public/favicon.png',
  'public/favicon.svg',
  'portal/public/favicon.ico',
  'portal/favicon.ico',
  'apps/web/public/favicon.svg',
  'apps/web/public/favicon.png',
  'apps/web/dist/favicon-48.png',
  'apps/web/dist/icon-192.png',
  'apps/web/dist/apple-touch-icon.png',
  'apps/mobile/assets/icon.png',
  'design/brand-pack/assets/favicon-192.png',
  'design/brand-pack/assets/icon.png',
  'design/brand-pack/assets/favicon-48.png',
  'design/brand-pack/assets/favicon.ico',
  'assets/icon.png',
  'logo.png',
  'icon.png',
  'app-icon.png',
  'favicon.png',
  'favicon.ico',
  'src/renderer/src/assets/app-icon.png'
] as const

const WALK_PRIORITY = [
  'favicon-192.png',
  'icon-192.png',
  'favicon-48.png',
  'apple-touch-icon.png',
  'icon-512.png',
  'icon.png',
  'favicon.png',
  'logo.png',
  'favicon.svg',
  'icon.svg'
] as const

const WALK_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'social',
  'coverage',
  '.next',
  'DerivedData',
  'chrome-real.local',
  'chrome-profile.local'
])

function isImageFile(abs: string): boolean {
  return ALLOWED.has(extname(abs).toLowerCase())
}

function walkForImage(dir: string, depth: number): string | null {
  if (depth > 6) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const name of WALK_PRIORITY) {
    const abs = join(dir, name)
    if (existsSync(abs) && statSync(abs).isFile() && isImageFile(abs)) return abs
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name.startsWith('.') || WALK_SKIP.has(ent.name)) continue
    const hit = walkForImage(join(dir, ent.name), depth + 1)
    if (hit) return hit
  }
  return null
}

function slugVariants(name: string): string[] {
  const raw = name.trim()
  if (raw === '') return []
  const lower = raw.toLowerCase()
  const dashed = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const compact = lower.replace(/[^a-z0-9]/g, '')
  const titled = raw
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('-')
  const pascal = raw
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('')
  return [...new Set([raw, lower, dashed, compact, titled, pascal])]
}

export function guessRepoFolder(projectName: string): string | null {
  const home = homedir()
  const roots = [
    join(home, 'Desktop/Development/side-projects'),
    join(home, 'Desktop/Development'),
    join(home, 'Development/side-projects'),
    join(home, 'Development')
  ]
  for (const v of slugVariants(projectName)) {
    for (const root of roots) {
      const p = join(root, v)
      if (existsSync(p) && statSync(p).isDirectory()) return p
    }
  }
  return null
}

export function resolveProjectRepoFolder(project: {
  name: string
  repoFolder?: string
}): string | null {
  if (project.repoFolder && existsSync(project.repoFolder)) return project.repoFolder
  return guessRepoFolder(project.name)
}

/** Repo-relative picks for known monorepos (checked before generic discovery). */
const CURATED_REL: Record<string, string> = {
  showandtell: 'web/remote/icon-512.png',
  acme: 'design/brand-pack/assets/favicon-192.png',
  labelco: 'apps/web/public/favicon.svg',
  jobboard: 'public/favicon.svg',
  creatorhub: 'apps/web/dist/icon-192.png',
  stringlab: 'apps/mobile/assets/icon.png'
}

function projectSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function discoverProjectImage(repoFolder: string, projectName?: string): string | null {
  if (!existsSync(repoFolder)) return null
  if (projectName) {
    const rel = CURATED_REL[projectSlug(projectName)]
    if (rel) {
      const abs = join(repoFolder, rel)
      if (existsSync(abs) && statSync(abs).isFile() && isImageFile(abs)) return abs
    }
  }
  for (const rel of DISCOVER_REL) {
    const abs = join(repoFolder, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) continue
    if (isImageFile(abs)) return abs
  }
  return walkForImage(repoFolder, 0)
}

export function removeProjectImageFiles(projectId: string): void {
  if (!existsSync(PATHS.MIGHTY_PROJECT_IMAGES)) return
  for (const name of readdirSync(PATHS.MIGHTY_PROJECT_IMAGES)) {
    if (name.startsWith(`${projectId}.`)) {
      try {
        unlinkSync(join(PATHS.MIGHTY_PROJECT_IMAGES, name))
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

export function copyProjectImage(projectId: string, sourcePath: string): string | null {
  const ext = extname(sourcePath).toLowerCase()
  if (!ALLOWED.has(ext)) return null
  mkdirSync(PATHS.MIGHTY_PROJECT_IMAGES, { recursive: true })
  removeProjectImageFiles(projectId)
  const dest = join(PATHS.MIGHTY_PROJECT_IMAGES, `${projectId}${ext}`)
  copyFileSync(sourcePath, dest)
  return dest
}
