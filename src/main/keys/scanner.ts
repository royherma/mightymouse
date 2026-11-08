import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, relative } from 'path'
import { webContents } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import { CONFIG } from '../../shared/config'
import { MIGHTY } from '../store/mighty'
import { resolveBinary } from '../platform/macos/resolve-binary'
import { probeEnv } from '../platform/macos/shell'
import { detectMcpClients } from '../agent-relay/mcp-clients'
import {
  KeyScope,
  KeyRecord,
  KeyNeed,
  KeyCloudBucket,
  ProjectKeyMap,
  detectProvider,
  shapeOf,
  keyId,
  KEYCHAIN_SERVICE
} from '../../shared/keys'
import { KEY_PROVIDERS, keyProvider } from '../../shared/key-providers'
import { KEYS } from './store'
import { isGenericName, walkFilesAsync, findEnvFiles, parseEnvFile, scanRepoNeeds, isCommittedToGit, EXEC_TIMEOUT_MS, WRANGLER_CONFIG_RE, CodeNeed } from './scan-pure'

function nowIso(): string {
  return new Date().toISOString()
}

async function scanEnvFiles(scope: KeyScope, repoFolder: string): Promise<{ records: KeyRecord[]; errors: string[] }> {
  const records: KeyRecord[] = []
  const errors: string[] = []
  for (const file of await findEnvFiles(repoFolder)) {
    let contents: string
    try {
      contents = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const { name, value } of parseEnvFile(contents)) {
      if (isGenericName(name) || !value.trim()) continue
      const provider = detectProvider(KEY_PROVIDERS, name, value)
      const { shape, length } = shapeOf(value)
      records.push({
        id: keyId(scope, name),
        name,
        provider: provider?.id ?? 'unknown',
        routes: ['api'],
        scope,
        source: 'env-file',
        sourcePath: file,
        shape,
        length,
        status: 'unverified',
        addedBy: 'scan',
        updated: nowIso()
      })
    }
    const committed = await isCommittedToGit(repoFolder, file)
    if (committed) errors.push(`${relative(repoFolder, file)} is committed to git`)
  }
  return { records, errors }
}

function scanMcpNeeds(): KeyNeed[] {
  const out: KeyNeed[] = []
  try {
    for (const client of detectMcpClients()) {
      if (!client.configured || !existsSync(client.path)) continue
      let raw: string
      try {
        raw = readFileSync(client.path, 'utf-8')
      } catch {
        continue
      }
      const envMatches = raw.matchAll(/"([A-Z][A-Z0-9_]+)"\s*:\s*"[^"]*"/g)
      for (const m of envMatches) {
        if (isGenericName(m[1])) continue
        out.push({
          name: m[1],
          provider: detectProvider(KEY_PROVIDERS, m[1])?.id ?? 'unknown',
          routes: ['mcp'],
          evidence: [client.path]
        })
      }
    }
  } catch {
  }
  return out
}

const isReadableLine = (l: string): boolean => /[a-z]{3}/i.test(l) && !/^\s*[[{]/.test(l) && !l.includes(' | ')

function probeCli(bin: string, args: string[], extraEnv?: Record<string, string>): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: EXEC_TIMEOUT_MS, env: probeEnv(extraEnv) },
      (err, stdout, stderr) => {
        const detail = ((stdout || stderr || '').split('\n').find(isReadableLine) || '').trim().slice(0, 120)
        resolve({ ok: !err, detail })
      }
    )
  })
}

async function scanCliLogins(scope: KeyScope): Promise<KeyRecord[]> {
  const withCli = KEY_PROVIDERS.filter((p) => p.cli)
  const results = await Promise.allSettled(
    withCli.map(async (p) => {
      const bin = resolveBinary(p.cli!.bin)
      if (!bin) return null
      const { ok, detail } = await probeCli(bin, p.cli!.probe)
      const record: KeyRecord = {
        id: `${scope}:${p.id.toUpperCase()}_CLI`,
        name: `${p.id.toUpperCase()}_CLI`,
        provider: p.id,
        routes: ['cli'],
        scope,
        source: 'cli-login',
        sourcePath: bin,
        shape: '',
        length: 0,
        status: ok ? 'ready' : 'broken',
        lastChecked: nowIso(),
        lastDetail: detail,
        addedBy: 'scan',
        updated: nowIso()
      }
      return record
    })
  )
  return results
    .filter((r): r is PromiseFulfilledResult<KeyRecord | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((r): r is KeyRecord => r !== null)
}

const L = CONFIG.UI_LABELS

function cliFailure(stderr: string, err: Error): string {
  const plain = stderr.replace(/\x1b\[[0-9;]*m/g, '').replace(/[✘✗]\s*\[ERROR\]\s*/g, '')
  if (/\b403\b|necessary privileges|forbidden/i.test(plain)) return L.CODE_KEYS_CLOUD_NO_ACCESS
  if (/\b401\b|not logged in|unauthori[sz]ed|login/i.test(plain)) return L.CODE_KEYS_CLOUD_SIGNED_OUT
  return plain.trim().split('\n').find((l) => l.trim())?.slice(0, 160) || err.message
}

function supabaseProjectName(
  bin: string,
  cwd: string,
  ref: string
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(bin, ['projects', 'list', '-o', 'json'], { cwd, timeout: EXEC_TIMEOUT_MS, env: probeEnv() }, (err, stdout) => {
      if (err) return resolve(undefined)
      // The CLI prints one JSON array per org, concatenated - JSON.parse sees only the first.
      const rows: { id?: string; ref?: string; name?: string }[] = []
      for (const chunk of stdout.split(/\]\s*\[/)) {
        const body = chunk.replace(/^\s*\[?/, '').replace(/\]?\s*$/, '')
        try {
          const parsed = JSON.parse(`[${body}]`)
          if (Array.isArray(parsed)) rows.push(...parsed)
        } catch {
        }
      }
      resolve(rows.find((r) => r.id === ref || r.ref === ref)?.name)
    })
  })
}

async function scanCloudBuckets(repoFolder: string): Promise<{ buckets: KeyCloudBucket[]; errors: string[] }> {
  const buckets: KeyCloudBucket[] = []
  const errors: string[] = []

  await new Promise<void>((resolve) => {
    execFile(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: repoFolder, timeout: EXEC_TIMEOUT_MS, env: probeEnv() },
      (err, stdout) => {
        if (err || !/github\.com/.test(stdout)) return resolve()
        const m = stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+)/)
        if (!m) return resolve()
        const gh = resolveBinary('gh')
        if (!gh) return resolve()
        execFile(
          gh,
          ['secret', 'list', '-R', m[1], '--json', 'name', '-q', '.[].name'],
          { cwd: repoFolder, timeout: EXEC_TIMEOUT_MS, env: probeEnv() },
          (secErr, secOut, secStderr) => {
            if (secErr) {
              errors.push(`GitHub: ${cliFailure(secStderr, secErr)}`)
            } else {
              const names = secOut.split('\n').map((l) => l.trim()).filter(Boolean)
              buckets.push({ host: 'github', target: m[1], names })
            }
            resolve()
          }
        )
      }
    )
  })

  const supabaseRef = join(repoFolder, 'supabase', '.temp', 'project-ref')
  if (existsSync(supabaseRef)) {
    const ref = readFileSync(supabaseRef, 'utf-8').trim()
    const supa = resolveBinary('supabase')
    if (supa && ref) {
      await new Promise<void>((resolve) => {
        execFile(
          supa,
          ['secrets', 'list', '--project-ref', ref, '-o', 'json'],
          { cwd: repoFolder, timeout: EXEC_TIMEOUT_MS, env: probeEnv() },
          async (err, stdout, stderr) => {
            if (err) {
              errors.push(`Supabase: ${cliFailure(stderr, err)}`)
              return resolve()
            }
            try {
              const parsed = JSON.parse(stdout) as { name: string }[]
              buckets.push({
                host: 'supabase',
                target: ref,
                label: await supabaseProjectName(supa, repoFolder, ref),
                names: parsed.map((s) => s.name)
              })
            } catch {
            }
            resolve()
          }
        )
      })
    }
  }

  const wranglerConfigs = await walkFilesAsync(repoFolder, (name) => WRANGLER_CONFIG_RE.test(name))
  const wrangler = resolveBinary('wrangler')
  for (const config of wranglerConfigs) {
    if (!wrangler) break
    const dir = join(config, '..')
    let target = ''
    let pages = false
    let localOnly = false
    try {
      const raw = readFileSync(config, 'utf-8')
      const m = raw.match(/name\s*=\s*"([^"]+)"/) || raw.match(/"name"\s*:\s*"([^"]+)"/)
      target = m?.[1] ?? ''
      pages = /pages_build_output_dir/.test(raw)
      localOnly = /["']?ENVIRONMENT["']?\s*[:=]\s*["']local["']/.test(raw)
    } catch {
    }
    if (pages && !target) continue
    if (localOnly) continue
    await new Promise<void>((resolve) => {
      execFile(
        wrangler,
        pages
          ? ['pages', 'secret', 'list', '--project-name', target]
          : ['secret', 'list', '--config', config],
        { cwd: dir, timeout: EXEC_TIMEOUT_MS, env: probeEnv() },
        (err, stdout, stderr) => {
          if (err) {
            if (!/not found/i.test(stderr))
              errors.push(`Cloudflare (${target || dir}): ${cliFailure(stderr, err)}`)
            return resolve()
          }
          try {
            const names = pages
              ? [...stdout.matchAll(/^\s+-\s+([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1])
              : (JSON.parse(stdout) as { name: string }[]).map((s) => s.name)
            buckets.push({ host: 'cloudflare', target, names })
          } catch {
          }
          resolve()
        }
      )
    })
  }

  const vercelProject = join(repoFolder, '.vercel', 'project.json')
  if (existsSync(vercelProject)) {
    const vercel = resolveBinary('vercel')
    let projectName = ''
    try {
      const parsed = JSON.parse(readFileSync(vercelProject, 'utf-8'))
      projectName = parsed.projectId ?? ''
    } catch {
    }
    if (vercel) {
      await new Promise<void>((resolve) => {
        execFile(
          vercel,
          ['env', 'ls', '--json'],
          { cwd: repoFolder, timeout: EXEC_TIMEOUT_MS, env: probeEnv() },
          (err, stdout, stderr) => {
            if (err) {
              errors.push(`Vercel: ${cliFailure(stderr, err)}`)
              return resolve()
            }
            try {
              const parsed = JSON.parse(stdout) as { key?: string; name?: string }[]
              const names = parsed.map((e) => e.key ?? e.name ?? '').filter(Boolean)
              buckets.push({ host: 'vercel', target: projectName || 'vercel', names })
            } catch {
              const names = stdout
                .split('\n')
                .map((l) => l.trim().split(/\s+/)[0])
                .filter((n) => n && /^[A-Z][A-Z0-9_]+$/.test(n))
              if (names.length) buckets.push({ host: 'vercel', target: projectName || 'vercel', names })
            }
            resolve()
          }
        )
      })
    }
  }

  return { buckets, errors }
}

function mergeRecords(scanRows: KeyRecord[], userRows: KeyRecord[]): KeyRecord[] {
  const byName = new Map<string, KeyRecord>()
  for (const row of scanRows) byName.set(row.name, row)
  for (const row of userRows) {
    const existing = byName.get(row.name)
    if (existing && existing.source !== row.source) {
      byName.set(row.name, {
        ...row,
        sourcePath: [existing.sourcePath, row.sourcePath].filter(Boolean).join(' + ')
      })
    } else {
      byName.set(row.name, row)
    }
  }
  return [...byName.values()]
}

async function scanGlobalScope(): Promise<ProjectKeyMap> {
  const errors: string[] = []
  const scanRows: KeyRecord[] = []

  const keychainNames = await KEYS.listKeychainNames()
  for (const name of keychainNames) {
    scanRows.push({
      id: `global:${name}`,
      name,
      provider: detectProvider(KEY_PROVIDERS, name)?.id ?? 'unknown',
      routes: ['api'],
      scope: 'global',
      source: 'keychain',
      sourcePath: `keychain:${KEYCHAIN_SERVICE}`,
      shape: '',
      length: 0,
      status: 'unverified',
      addedBy: 'scan',
      updated: nowIso()
    })
  }

  const secretsPath = join(homedir(), '.config', 'mm', 'secrets.env')
  if (existsSync(secretsPath)) {
    try {
      const contents = readFileSync(secretsPath, 'utf-8')
      for (const { name, value } of parseEnvFile(contents)) {
        if (isGenericName(name) || !value.trim()) continue
        const provider = detectProvider(KEY_PROVIDERS, name, value)
        const { shape, length } = shapeOf(value)
        scanRows.push({
          id: `global:${name}`,
          name,
          provider: provider?.id ?? 'unknown',
          routes: ['api'],
          scope: 'global',
          source: 'env-file',
          sourcePath: secretsPath,
          shape,
          length,
          status: 'unverified',
          addedBy: 'scan',
          updated: nowIso()
        })
      }
    } catch (err) {
      errors.push(`Could not read ${secretsPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    for (const client of detectMcpClients()) {
      if (!existsSync(client.path)) continue
      let raw: string
      try {
        raw = readFileSync(client.path, 'utf-8')
      } catch {
        continue
      }
      for (const m of raw.matchAll(/"([A-Z][A-Z0-9_]+)"\s*:\s*"[^"]*"/g)) {
        if (isGenericName(m[1])) continue
        scanRows.push({
          id: `global:${m[1]}`,
          name: m[1],
          provider: detectProvider(KEY_PROVIDERS, m[1])?.id ?? 'unknown',
          routes: ['mcp'],
          scope: 'global',
          source: 'mcp-config',
          sourcePath: client.path,
          shape: '',
          length: 0,
          status: 'unverified',
          addedBy: 'scan',
          updated: nowIso()
        })
      }
    }
  } catch {
  }

  const cliRows = await scanCliLogins('global')
  scanRows.push(...cliRows)

  const userRows = KEYS.list().filter((r) => r.scope === 'global')
  const merged = mergeRecords(scanRows, userRows)
  for (const row of merged) {
    if (row.addedBy === 'scan') KEYS.persistScanRow(row)
  }

  const map: ProjectKeyMap = {
    projectId: 'global',
    scannedAt: nowIso(),
    keys: merged,
    needs: [],
    missing: [],
    cloud: [],
    errors
  }
  KEYS.upsertMap(map)
  return map
}

async function scanProjectScope(projectId: string): Promise<ProjectKeyMap> {
  const project = MIGHTY.getProject(projectId)
  if (!project?.repoFolder) {
    const map: ProjectKeyMap = {
      projectId,
      scannedAt: nowIso(),
      keys: [],
      needs: [],
      missing: [],
      cloud: [],
      errors: ['This project has no folder yet.']
    }
    KEYS.upsertMap(map)
    return map
  }

  const repoFolder = project.repoFolder
  const [envResult, cliRows, cloudResult] = await Promise.all([
    scanEnvFiles(projectId, repoFolder),
    scanCliLogins(projectId),
    scanCloudBuckets(repoFolder)
  ])

  const scanRows = [...envResult.records, ...cliRows]
  const errors = [...envResult.errors, ...cloudResult.errors]

  const codeNeeds = await scanRepoNeeds(repoFolder)
  const needByName = new Map<string, KeyNeed>()
  const realNeeds = codeNeeds.filter((n) => !n.isTest)
  const byNameSites = new Map<string, CodeNeed[]>()
  for (const need of realNeeds) {
    const sites = byNameSites.get(need.name)
    if (sites) sites.push(need)
    else byNameSites.set(need.name, [need])
  }

  for (const [name, sites] of byNameSites) {
    const provider = detectProvider(KEY_PROVIDERS, name)?.id ?? 'unknown'
    needByName.set(name, {
      name,
      provider,
      routes: ['api'],
      evidence: sites.slice(0, 3).map((s) => `${s.file}:${s.line}`),
      optional: sites.every((s) => s.optional)
    })
  }

  for (const example of ['.env.example', '.env.sample', '.env.template']) {
    const examplePath = join(repoFolder, example)
    if (!existsSync(examplePath)) continue
    try {
      const contents = readFileSync(examplePath, 'utf-8')
      for (const { name } of parseEnvFile(contents)) {
        if (isGenericName(name)) continue
        if (!needByName.has(name)) {
          needByName.set(name, {
            name,
            provider: detectProvider(KEY_PROVIDERS, name)?.id ?? 'unknown',
            routes: ['api'],
            evidence: [`file:${example}`],
            optional: true
          })
        }
      }
    } catch {
    }
  }

  needByName.forEach((need) => (need.provider = detectProvider(KEY_PROVIDERS, need.name)?.id ?? need.provider))
  scanMcpNeeds().forEach((need) => {
    if (!needByName.has(need.name)) needByName.set(need.name, need)
  })

  const needs = [...needByName.values()]

  const globalMap = KEYS.readMaps().find((m) => m.projectId === 'global') ?? (await scanGlobalScope())
  const projectNameSet = new Set(scanRows.map((r) => r.name))
  const globalNameSet = new Set(globalMap.keys.map((r) => r.name))
  const cloudNameSet = new Set(cloudResult.buckets.flatMap((b) => b.names))

  const haveNames = new Set([...projectNameSet, ...globalNameSet, ...cloudNameSet])
  const readyCliProviders = new Set(
    [...scanRows, ...globalMap.keys]
      .filter((r) => r.source === 'cli-login' && r.status === 'ready')
      .map((r) => r.provider)
  )

  for (const need of needs) {
    if (readyCliProviders.has(need.provider)) need.satisfiedByCli = true
  }

  const missing = needs.filter((n) => {
    if (haveNames.has(n.name)) return false
    const aliases = keyProvider(n.provider)?.envNames ?? []
    if (aliases.some((a) => haveNames.has(a))) return false
    return !n.optional && !n.satisfiedByCli
  })

  const userRows = KEYS.list().filter((r) => r.scope === projectId)
  const merged = mergeRecords(scanRows, userRows)
  for (const row of merged) {
    if (row.addedBy === 'scan') KEYS.persistScanRow(row)
  }

  const map: ProjectKeyMap = {
    projectId,
    repoFolder,
    scannedAt: nowIso(),
    keys: merged,
    needs,
    missing,
    cloud: cloudResult.buckets,
    errors
  }
  KEYS.upsertMap(map)
  return map
}

export async function scanScope(scope: KeyScope): Promise<ProjectKeyMap> {
  const map = scope === 'global' ? await scanGlobalScope() : await scanProjectScope(scope)
  const maps = KEYS.readMaps()
  webContents.getAllWebContents().forEach((wc) => wc.send(CHANNELS.keysChanged, maps))
  return map
}
