import { KEY_PROVIDERS } from './key-providers'
import type { ProjectInfra } from './infra'
import { detectProvider, type KeyProvider, type KeyRecord, type ProjectKeyMap } from './keys'
import type { MightyProject } from './types'

export interface KeyOwner {
  id: string
  prefixes: string[]
}

export interface KeyBook {
  keys: KeyRecord[]
  owners: KeyOwner[]
}

export interface KeyMatch {
  key: KeyRecord
  why: string
}

const TOO_GENERIC = new Set([
  'APP',
  'WEB',
  'API',
  'SERVER',
  'CLIENT',
  'SITE',
  'MAIN',
  'CORE',
  'TEST',
  'DEMO'
])
const KIND_WORD = /_(API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|KEY|TOKEN|SECRET)$/

function toPrefix(name: string): string {
  return name
    .replace(/^@[^/]+\//, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function ownerPrefixes(names: (string | undefined)[], providers: KeyProvider[]): string[] {
  const stems = new Set(providers.flatMap((p) => [toPrefix(p.id), ...(p.stems ?? [])]))
  const out = new Set<string>()
  for (const name of names) {
    if (!name) continue
    const full = toPrefix(name)
    for (const p of [full, full.replace(/_/g, '')]) {
      if (p.length >= 3 && !TOO_GENERIC.has(p) && !stems.has(p)) out.add(p)
    }
  }
  return [...out]
}

function longestPrefix(name: string, owners: KeyOwner[]): string | null {
  let best: string | null = null
  for (const o of owners) {
    for (const p of o.prefixes) {
      if (name.startsWith(p + '_') && (!best || p.length > best.length)) best = p
    }
  }
  return best
}

export function whyKeyCounts(
  key: KeyRecord,
  projectId: string,
  owners: KeyOwner[],
  entryKey?: string
): string | null {
  if (key.scope === projectId) return 'saved for this project'
  if (key.scope !== 'global') return null
  if (key.projects?.length) {
    return key.projects.includes(projectId) ? 'linked to this project in Keys' : null
  }
  if (entryKey && key.name === entryKey) return 'the name the code reads'
  const prefix = longestPrefix(key.name, owners)
  if (!prefix) return 'no project in its name, so every project shares it'
  const mine = owners.some((o) => o.id === projectId && o.prefixes.includes(prefix))
  return mine ? `name starts with ${prefix}_` : null
}

export function keysFor(
  providerId: string | undefined,
  entryKey: string | undefined,
  projectId: string,
  keys: KeyRecord[],
  owners: KeyOwner[]
): KeyMatch[] {
  const hits = keys.flatMap((key) => {
    if (key.hidden) return []
    if (key.provider !== providerId && !(entryKey && key.name === entryKey)) return []
    const why = whyKeyCounts(key, projectId, owners, entryKey)
    return why ? [{ key, why }] : []
  })
  const named = hits.filter((m) => m.key.name === entryKey)
  return named.length ? named : hits
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]
}

export function looksLikeSameKey(a: string, b: string): boolean {
  if (a === b) return false
  if (a.replace(KIND_WORD, '') === b.replace(KIND_WORD, '')) return true
  return Math.min(a.length, b.length) >= 8 && editDistance(a, b) <= 2
}

export function duplicateKeys(keys: KeyRecord[]): [KeyRecord, KeyRecord][] {
  const seen = new Map<string, KeyRecord>()
  for (const k of keys)
    if (!k.hidden && k.provider !== 'unknown') seen.set(`${k.scope}:${k.name}`, k)
  const list = [...seen.values()]
  const pairs: [KeyRecord, KeyRecord][] = []
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]]
      if (a.scope === b.scope && a.provider === b.provider && looksLikeSameKey(a.name, b.name)) {
        pairs.push([a, b])
      }
    }
  }
  return pairs
}

const SECRET_END = /(KEY|TOKEN|SECRET|DSN|PAT|PASSWORD)$/

export function keyNameFromCode(
  provider: KeyProvider,
  namesInProject: string[],
  foundInText: string,
  providers: KeyProvider[]
): { key: string; guessed?: true } | undefined {
  const exact =
    provider.envNames.find((n) => foundInText.includes(n)) ??
    provider.envNames.find((n) => namesInProject.includes(n))
  if (exact) return { key: exact }
  const read = namesInProject.filter(
    (n) => SECRET_END.test(n) && detectProvider(providers, n)?.id === provider.id
  )
  const pick = read.find((n) => foundInText.includes(n)) ?? read[0]
  if (pick) return { key: pick }
  return provider.envNames[0] ? { key: provider.envNames[0], guessed: true } : undefined
}

export function keyBook(
  maps: ProjectKeyMap[],
  projects: MightyProject[],
  all: ProjectInfra[]
): KeyBook {
  return {
    keys: maps.flatMap((m) => m.keys),
    owners: projects.map((p) => ({
      id: p.id,
      prefixes: ownerPrefixes(
        [
          p.name,
          p.repoFolder?.split('/').pop(),
          ...(all.find((i) => i.projectId === p.id)?.record?.names ?? [])
        ],
        KEY_PROVIDERS
      )
    }))
  }
}
