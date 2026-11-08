export type KeyRoute = 'api' | 'cli' | 'mcp'

export type KeyStatus = 'ready' | 'missing' | 'expiring' | 'expired' | 'unverified' | 'broken'

export type KeySource = 'keychain' | 'env-file' | 'cli-login' | 'mcp-config' | 'cloud' | 'manual'

export type KeyCloudHost = 'supabase' | 'github' | 'cloudflare' | 'vercel'

export type KeyCategory =
  | 'ai'
  | 'infra'
  | 'payments'
  | 'data'
  | 'commerce'
  | 'analytics'
  | 'ads'
  | 'messaging'
  | 'social'
  | 'email'
  | 'devtools'
  | 'apple'
  | 'other'

export const KEY_CATEGORY_LABELS: Record<KeyCategory, string> = {
  ai: 'AI models',
  infra: 'Hosting and infra',
  payments: 'Payments',
  data: 'Databases',
  commerce: 'Commerce',
  analytics: 'Analytics',
  ads: 'Ads',
  messaging: 'Messaging',
  social: 'Social',
  email: 'Email',
  devtools: 'Dev tools',
  apple: 'Apple',
  other: 'Other'
}

export interface KeyShape {
  prefix: string
  label: string
}

export interface KeyProvider {
  id: string
  label: string
  category: KeyCategory
  envNames: string[]
  shapes: KeyShape[]
  cli?: { bin: string; probe: string[]; loginHint: string }
  api?: { url: string; alsoValid?: string }
  mcp?: string[]
  mcpUrl?: string
  cloud?: KeyCloudHost
  stems?: string[]
  detect?: string[]
  docsUrl: string
  expiresDays?: number
}

export type KeyScope = 'global' | string

export interface KeyRecord {
  id: string
  name: string
  provider: string
  routes: KeyRoute[]
  scope: KeyScope
  source: KeySource
  sourcePath?: string
  shape: string
  length: number
  status: KeyStatus
  expiresAt?: string
  lastChecked?: string
  lastDetail?: string
  note?: string
  hidden?: boolean
  projects?: string[]
  addedBy: 'user' | 'agent' | 'scan'
  updated: string
}

export interface KeyNeed {
  name: string
  provider: string
  routes: KeyRoute[]
  evidence: string[]
  optional?: boolean
  fallback?: string
  satisfiedByCli?: boolean
}

export interface KeyCloudBucket {
  host: KeyCloudHost
  target: string
  label?: string
  names: string[]
}

export interface ProjectKeyMap {
  projectId: KeyScope
  repoFolder?: string
  scannedAt: string
  keys: KeyRecord[]
  needs: KeyNeed[]
  missing: KeyNeed[]
  cloud: KeyCloudBucket[]
  errors: string[]
}

export interface KeySetPayload {
  name: string
  value: string
  scope: KeyScope
  provider?: string
  routes?: KeyRoute[]
  expiresAt?: string
  note?: string
  addedBy: 'user' | 'agent'
}

export type KeyPatch = Partial<
  Pick<KeyRecord, 'provider' | 'routes' | 'expiresAt' | 'note' | 'hidden' | 'scope' | 'projects'>
>

export interface KeyProbeResult {
  id: string
  status: KeyStatus
  detail: string
  checkedAt: string
}

export const KEYCHAIN_SERVICE = 'claude-key'

export const KEY_EXPIRY_WARN_DAYS = 14

export const KEY_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/

export function keyId(scope: KeyScope, name: string): string {
  return `${scope}:${name}`
}

export function shapeOf(value: string): { shape: string; length: number } {
  const v = value.trim()
  const head = v.length > 24 ? v.slice(0, Math.min(8, Math.floor(v.length / 4))) : v.slice(0, v.length > 12 ? 3 : 2)
  return { shape: `${head}…`, length: v.length }
}

export function expiryStatus(expiresAt: string | undefined, now = Date.now()): KeyStatus | null {
  if (!expiresAt) return null
  const t = Date.parse(expiresAt)
  if (Number.isNaN(t)) return null
  if (t <= now) return 'expired'
  if (t - now <= KEY_EXPIRY_WARN_DAYS * 86_400_000) return 'expiring'
  return null
}

export function detectProvider(
  providers: KeyProvider[],
  name: string,
  value?: string
): KeyProvider | null {
  const upper = name.toUpperCase()
  for (const p of providers) if (p.envNames.includes(upper)) return p
  if (value) {
    const v = value.trim()
    let best: { p: KeyProvider; len: number } | null = null
    for (const p of providers) {
      for (const s of p.shapes) {
        if (v.startsWith(s.prefix) && (!best || s.prefix.length > best.len)) best = { p, len: s.prefix.length }
      }
    }
    if (best) return best.p
  }
  for (const p of providers) {
    const stems = [p.id.toUpperCase().replace(/-/g, '_'), ...(p.stems ?? [])]
    for (const stem of stems) {
      if (upper.startsWith(stem + '_') || upper.includes('_' + stem + '_')) return p
    }
  }
  return null
}

export function daysUntil(iso: string | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.ceil((t - now) / 86_400_000)
}
