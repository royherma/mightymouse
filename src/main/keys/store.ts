import { existsSync, readFileSync, appendFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'fs'
import { execFile } from 'child_process'
import { PATHS } from '../store/paths'
import {
  KEYCHAIN_SERVICE,
  KEY_NAME_RE,
  keyId,
  shapeOf,
  expiryStatus,
  detectProvider,
  KeyRecord,
  KeySetPayload,
  KeyPatch,
  ProjectKeyMap
} from '../../shared/keys'
import { KEY_PROVIDERS, keyProvider } from '../../shared/key-providers'

const SECURITY_TIMEOUT_MS = 8000

function decodeLine<T>(line: string): T | null {
  const t = line.trim()
  if (t === '') return null
  try {
    return JSON.parse(t) as T
  } catch {
    return null
  }
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      const rec = decodeLine<T>(line)
      if (rec) out.push(rec)
    }
  } catch (err) {
    console.error(`Failed to read ${path}:`, err)
  }
  return out
}

function latestById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const r of rows) map.set(r.id, r)
  return map
}

function appendLine(path: string, record: unknown): void {
  mkdirSync(PATHS.KEYS_DIR, { recursive: true })
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf-8')
}

function rewriteFile(path: string, records: unknown[]): void {
  mkdirSync(PATHS.KEYS_DIR, { recursive: true })
  const lines = records.map((r) => JSON.stringify(r))
  const tmp = path + '.tmp'
  writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf-8')
  renameSync(tmp, path)
}

function kcSet(name: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'security',
      [
        'add-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        name,
        '-w',
        value,
        '-j',
        `stored by mightymouse on ${new Date().toISOString()}`,
        '-U'
      ],
      { timeout: SECURITY_TIMEOUT_MS },
      (err) => resolve(!err)
    )
  })
}

function kcGet(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'],
      { timeout: SECURITY_TIMEOUT_MS },
      (err, stdout) => resolve(err ? null : stdout.replace(/\n$/, ''))
    )
  })
}

function kcDelete(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name],
      { timeout: SECURITY_TIMEOUT_MS },
      (err) => resolve(!err)
    )
  })
}

function listKeychainNames(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('security', ['dump-keychain'], { timeout: SECURITY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      const names = new Set<string>()
      let svc: string | null = null
      let acct: string | null = null
      for (const line of stdout.split('\n')) {
        const svcMatch = line.match(/"svce"<blob>="([^"]*)"/)
        if (svcMatch) svc = svcMatch[1]
        const acctMatch = line.match(/"acct"<blob>="([^"]*)"/)
        if (acctMatch) acct = acctMatch[1]
        if (line.startsWith('keychain:')) {
          if (svc === KEYCHAIN_SERVICE && acct) names.add(acct)
          svc = null
          acct = null
        }
      }
      if (svc === KEYCHAIN_SERVICE && acct) names.add(acct)
      resolve([...names].sort())
    })
  })
}

const COMPACT_WHEN_LINES_PER_KEY = 3
let loaded: { mtimeMs: number; size: number; byId: Map<string, KeyRecord> } | null = null

function recordsById(): Map<string, KeyRecord> {
  const stamp = (): { mtimeMs: number; size: number } | undefined =>
    statSync(PATHS.KEYS_RECORDS, { throwIfNoEntry: false })
  let at = stamp()
  if (!at) return new Map()
  if (loaded && loaded.mtimeMs === at.mtimeMs && loaded.size === at.size) return loaded.byId
  const rows = readLines<KeyRecord>(PATHS.KEYS_RECORDS)
  const byId = latestById(rows)
  if (rows.length > byId.size * COMPACT_WHEN_LINES_PER_KEY) {
    rewriteFile(PATHS.KEYS_RECORDS, [...byId.values()])
    at = stamp() ?? at
  }
  loaded = { mtimeMs: at.mtimeMs, size: at.size, byId }
  return byId
}

function allRecords(): KeyRecord[] {
  return [...recordsById().values()]
}

export const KEYS = {
  list(): KeyRecord[] {
    return allRecords()
  },

  get(id: string): KeyRecord | null {
    return recordsById().get(id) ?? null
  },

  async set(payload: KeySetPayload): Promise<KeyRecord | null> {
    const name = payload.name.trim().toUpperCase()
    if (!KEY_NAME_RE.test(name)) return null
    const value = payload.value
    if (!value) return null

    const ok = await kcSet(name, value)
    if (!ok) return null

    const provider =
      payload.provider ?? detectProvider(KEY_PROVIDERS, name, value)?.id ?? 'unknown'
    const providerDef = keyProvider(provider)
    const { shape, length } = shapeOf(value)
    const record: KeyRecord = {
      id: keyId(payload.scope, name),
      name,
      provider,
      routes: payload.routes ?? (providerDef?.cli ? ['api', 'cli'] : ['api']),
      scope: payload.scope,
      source: 'keychain',
      sourcePath: `keychain:${KEYCHAIN_SERVICE}`,
      shape,
      length,
      status: expiryStatus(payload.expiresAt) ?? 'ready',
      expiresAt: payload.expiresAt,
      note: payload.note,
      addedBy: payload.addedBy,
      updated: new Date().toISOString()
    }
    appendLine(PATHS.KEYS_RECORDS, record)
    return record
  },

  update(id: string, patch: KeyPatch): KeyRecord | null {
    const existing = KEYS.get(id)
    if (!existing) return null
    const updated: KeyRecord = { ...existing, ...patch, updated: new Date().toISOString() }
    if ('expiresAt' in patch && existing.status !== 'broken') updated.status = expiryStatus(updated.expiresAt) ?? 'ready'
    appendLine(PATHS.KEYS_RECORDS, updated)
    return updated
  },

  persistScanRow(row: KeyRecord): void {
    const existing = KEYS.get(row.id)
    if (existing && existing.addedBy !== 'scan') return
    const same = existing && existing.shape === row.shape && existing.length === row.length
    const checked = same ? { status: existing.status, lastDetail: existing.lastDetail, lastChecked: existing.lastChecked } : {}
    const next = { ...row, ...checked }
    const body = (r: KeyRecord): string => JSON.stringify({ ...r, updated: '' })
    if (existing && body(existing) === body({ ...existing, ...next })) return
    appendLine(PATHS.KEYS_RECORDS, next)
  },

  applyProbeResult(id: string, status: KeyRecord['status'], detail: string, checkedAt: string): KeyRecord | null {
    const existing = KEYS.get(id)
    if (!existing) return null
    const updated: KeyRecord = { ...existing, status, lastDetail: detail, lastChecked: checkedAt, updated: checkedAt }
    appendLine(PATHS.KEYS_RECORDS, updated)
    return updated
  },

  async remove(id: string, deleteValue: boolean): Promise<boolean> {
    const existing = KEYS.get(id)
    if (!existing) return false
    const rest = allRecords().filter((r) => r.id !== id)
    rewriteFile(PATHS.KEYS_RECORDS, rest)
    if (deleteValue) await kcDelete(existing.name)
    return true
  },

  async getValue(name: string): Promise<string | null> {
    return kcGet(name.trim().toUpperCase())
  },

  async hasValue(name: string): Promise<boolean> {
    return (await kcGet(name.trim().toUpperCase())) !== null
  },

  listKeychainNames,

  readMaps(): ProjectKeyMap[] {
    if (!existsSync(PATHS.KEYS_MAPS)) return []
    try {
      const parsed = JSON.parse(readFileSync(PATHS.KEYS_MAPS, 'utf-8'))
      return Array.isArray(parsed) ? (parsed as ProjectKeyMap[]) : []
    } catch {
      return []
    }
  },

  syncMaps(): ProjectKeyMap[] {
    const byId = recordsById()
    const maps = KEYS.readMaps().map((m) => {
      const keys: KeyRecord[] = m.keys
        .filter((k) => byId.has(k.id))
        .map((k) => ({ ...k, ...byId.get(k.id)!, sourcePath: k.sourcePath }))
      const seen = new Set(keys.map((k) => k.id))
      for (const r of byId.values()) if (r.scope === m.projectId && !seen.has(r.id)) keys.push(r)
      return { ...m, keys }
    })
    KEYS.writeMaps(maps)
    return maps
  },

  writeMaps(maps: ProjectKeyMap[]): void {
    mkdirSync(PATHS.KEYS_DIR, { recursive: true })
    writeFileSync(PATHS.KEYS_MAPS, JSON.stringify(maps, null, 2), 'utf-8')
  },

  upsertMap(map: ProjectKeyMap): ProjectKeyMap[] {
    const rest = KEYS.readMaps().filter((m) => m.projectId !== map.projectId)
    const next = [...rest, map]
    KEYS.writeMaps(next)
    return next
  }
}
