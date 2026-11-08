import { existsSync } from 'fs'
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join, relative } from 'path'
import { MIGHTY } from '../store/mighty'
import { getSupabase } from '../supabase'
import { readProxyResult } from '../backend/recall-classifier'
import { CONFIG } from '../../shared/config'
import { briefDraftPrompt, parseBriefDraft, type BriefDraft } from '../../shared/brief'
import { findEnvironments } from './environments'
import { detectSurfaces, mergeSurfaces } from '../../shared/surfaces'
import {
  detectStack,
  MAX_SCAN_FILE_BYTES,
  MAX_SCAN_FILES,
  skippedDir,
  wantsText,
  type RepoText
} from '../../shared/infra-detect'
import {
  INFRA_AGENTS_LINE,
  INFRA_KINDS,
  INFRA_RECORD_PATH,
  cleanBrief,
  cleanTags,
  type AppKind,
  type BusinessType,
  type InfraEntry,
  type InfraRecord,
  type ProjectInfra,
  type TagField
} from '../../shared/infra'

const CF_BEACON = 'static.cloudflareinsights.com/beacon'
const LIVE_PAGE_TIMEOUT_MS = 5000
const BRIEF_DRAFT_TIMEOUT_MS = 15_000
const BRIEF_DRAFT_MAX_TOKENS = 800
const UNSAVED_SCAN_TTL_MS = 10 * 60_000

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    if (out.length >= MAX_SCAN_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skippedDir(entry.name)) continue
        await visit(join(dir, entry.name))
      } else if (entry.isFile()) {
        out.push(relative(root, join(dir, entry.name)))
      }
    }
  }
  await visit(root)
  return out
}

async function readTexts(root: string, files: string[]): Promise<RepoText[]> {
  const out: RepoText[] = []
  for (const path of files) {
    if (!wantsText(path)) continue
    const full = join(root, path)
    const size = await stat(full)
      .then((s) => s.size)
      .catch(() => MAX_SCAN_FILE_BYTES + 1)
    if (size > MAX_SCAN_FILE_BYTES) continue
    const text = await readFile(full, 'utf8').catch(() => null)
    if (text !== null) out.push({ path, text })
  }
  return out
}

async function liveBeacon(hosts: string[]): Promise<string | null> {
  const pages = hosts.map(async (host) => {
    const url = `https://${host}/`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(LIVE_PAGE_TIMEOUT_MS),
      headers: {
        accept: 'text/html',
        'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15'
      }
    })
    if (!res.ok || !(await res.text()).includes(CF_BEACON)) throw new Error('no beacon')
    return url
  })
  const seen = await Promise.allSettled(pages)
  return seen.find((r) => r.status === 'fulfilled')?.value ?? null
}

async function findServices(
  root: string
): Promise<Pick<InfraRecord, 'appKinds' | 'business' | 'services' | 'environments' | 'surfaces' | 'names'>> {
  const files = await walk(root)
  const { routeHosts, ...found } = await detectStack(files, await readTexts(root, files))
  if (!found.services.web_analytics?.length) {
    const page = await liveBeacon(routeHosts)
    if (page) found.services.web_analytics = [{ provider: 'cf_web_analytics', foundIn: page }]
  }
  const environments = await findEnvironments(root, files)
  return { ...found, environments, surfaces: detectSurfaces(files) }
}

function recordFile(repoFolder: string): string {
  return join(repoFolder, INFRA_RECORD_PATH)
}

export async function readRecord(repoFolder: string): Promise<InfraRecord | null> {
  const raw = await readFile(recordFile(repoFolder), 'utf8').catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<InfraRecord>
    return {
      checkedAt: parsed.checkedAt ?? '',
      appKinds: cleanTags('appKinds', parsed.appKinds) as AppKind[],
      business: cleanTags('business', parsed.business) as BusinessType[],
      ...(cleanBrief(parsed.brief) ? { brief: cleanBrief(parsed.brief) } : {}),
      ...(parsed.pinned?.length ? { pinned: parsed.pinned } : {}),
      ...(parsed.kit ? { kit: parsed.kit } : {}),
      ...(parsed.environments?.length ? { environments: parsed.environments } : {}),
      ...(parsed.surfaces?.length ? { surfaces: parsed.surfaces } : {}),
      ...(parsed.names?.length ? { names: parsed.names } : {}),
      services: parsed.services ?? {},
      skip: parsed.skip ?? [],
      ...(parsed.want?.length ? { want: parsed.want } : {}),
      ...(parsed.setups && Object.keys(parsed.setups).length ? { setups: parsed.setups } : {})
    }
  } catch {
    return null
  }
}

export async function recordAbove(folder: string): Promise<{ root: string; record: InfraRecord } | null> {
  for (let dir = folder; ; dir = dirname(dir)) {
    const record = await readRecord(dir)
    if (record) return { root: dir, record }
    if (dirname(dir) === dir) return null
  }
}

type AffectsRecord = Pick<InfraRecord, 'surfaces' | 'environments'>
const unsaved = new Map<string, { at: number; found: Promise<AffectsRecord> }>()

function repoAbove(folder: string): string | null {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return null
  }
}

async function scanAffects(root: string): Promise<AffectsRecord> {
  const files = await walk(root)
  return { surfaces: detectSurfaces(files), environments: await findEnvironments(root, files) }
}

export async function affectsRecordAbove(
  folder: string
): Promise<{ root: string; record: AffectsRecord } | null> {
  const saved = await recordAbove(folder)
  if (saved?.record.surfaces && saved.record.environments) return saved
  const root = saved?.root ?? repoAbove(folder)
  if (!root) return null
  let scan = unsaved.get(root)
  if (!scan || Date.now() - scan.at > UNSAVED_SCAN_TTL_MS) {
    scan = { at: Date.now(), found: scanAffects(root) }
    unsaved.set(root, scan)
  }
  const found = await scan.found
  return {
    root,
    record: {
      surfaces: saved?.record.surfaces ?? found.surfaces,
      environments: saved?.record.environments ?? found.environments
    }
  }
}

function settleSetups(record: InfraRecord): InfraRecord {
  if (!record.setups) return record
  const open = Object.entries(record.setups).filter(
    ([kindId, setup]) =>
      !(record.services[kindId] ?? []).some((e) => !(setup.had ?? []).includes(e.provider))
  )
  const rest = { ...record }
  delete rest.setups
  return open.length ? { ...rest, setups: Object.fromEntries(open) } : rest
}

async function writeRecord(
  repoFolder: string,
  record: InfraRecord,
  previous: InfraRecord | null
): Promise<void> {
  const sameBody = (r: InfraRecord | null): string => JSON.stringify(r && { ...r, checkedAt: '' })
  if (previous && sameBody(previous) === sameBody(record)) return
  const file = recordFile(repoFolder)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(record, null, 2) + '\n')
  await pointAgentsAtRecord(repoFolder)
}

async function pointAgentsAtRecord(repoFolder: string): Promise<void> {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = join(repoFolder, name)
    if (!existsSync(file)) continue
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null || text.includes(INFRA_RECORD_PATH)) continue
    await appendFile(file, `${text.endsWith('\n') ? '' : '\n'}\n${INFRA_AGENTS_LINE}\n`)
  }
}

function projectFolder(projectId: string): string | undefined {
  return MIGHTY.getProject(projectId)?.repoFolder || undefined
}

export async function listInfra(): Promise<ProjectInfra[]> {
  const projects = MIGHTY.listProjects().filter((p) => !p.archived)
  return Promise.all(
    projects.map(async (p) => ({
      projectId: p.id,
      repoFolder: p.repoFolder || undefined,
      record: p.repoFolder ? await readRecord(p.repoFolder) : null
    }))
  )
}

export async function checkInfra(projectId: string): Promise<ProjectInfra> {
  const repoFolder = projectFolder(projectId)
  if (!repoFolder || !existsSync(repoFolder)) {
    return { projectId, repoFolder, record: null, error: 'This project has no folder on this Mac.' }
  }
  const found = await findServices(repoFolder)
  const previous = await readRecord(repoFolder)
  const services: Record<string, InfraEntry[]> = {}
  for (const kind of INFRA_KINDS) {
    const scanned = found.services[kind.id] ?? []
    const kept = (previous?.services[kind.id] ?? []).filter(
      (e) => e.manual && !scanned.some((s) => s.provider === e.provider)
    )
    services[kind.id] = [...scanned, ...kept]
  }
  const pinned = previous?.pinned ?? []
  const surfaces = mergeSurfaces(found.surfaces ?? [], previous?.surfaces)
  const record = settleSetups({
    checkedAt: new Date().toISOString(),
    appKinds: pinned.includes('appKinds') ? previous!.appKinds : found.appKinds,
    business: pinned.includes('business') ? previous!.business : found.business,
    ...(previous?.brief ? { brief: previous.brief } : {}),
    ...(pinned.length ? { pinned } : {}),
    ...(previous?.kit ? { kit: previous.kit } : {}),
    ...(found.environments?.length ? { environments: found.environments } : {}),
    ...(surfaces.length ? { surfaces } : {}),
    ...(found.names?.length ? { names: found.names } : {}),
    services,
    skip: previous?.skip ?? [],
    ...(previous?.want?.length ? { want: previous.want } : {}),
    setups: previous?.setups
  })
  await writeRecord(repoFolder, record, previous)
  return { projectId, repoFolder, record }
}

export async function setInfraTags(
  projectId: string,
  field: TagField,
  values: unknown
): Promise<ProjectInfra> {
  if (values === null) {
    const unpinned = await changeInfra(projectId, (record) => {
      const pinned = (record.pinned ?? []).filter((f) => f !== field)
      const rest = { ...record }
      delete rest.pinned
      return pinned.length ? { ...rest, pinned } : rest
    })
    return unpinned.record ? checkInfra(projectId) : unpinned
  }
  return changeInfra(projectId, (record) => ({
    ...record,
    [field]: cleanTags(field, values),
    pinned: [...new Set([...(record.pinned ?? []), field])]
  }))
}

export async function setInfraBrief(projectId: string, value: unknown): Promise<ProjectInfra> {
  return changeInfra(projectId, (record) => {
    const brief = cleanBrief(value)
    const rest = { ...record }
    delete rest.brief
    return brief ? { ...rest, brief } : rest
  })
}

export async function draftInfraBrief(projectId: string): Promise<BriefDraft> {
  const repoFolder = projectFolder(projectId)
  const readme = repoFolder
    ? await readFile(join(repoFolder, 'README.md'), 'utf8').catch(() => '')
    : ''
  if (!readme.trim()) return { fail: 'nothing' }
  const jwt = await getSupabase()
    .auth.getSession()
    .then(({ data }) => data.session?.access_token ?? '')
    .catch(() => '')
  if (!jwt) return { fail: 'signed_out' }
  const types = (repoFolder && (await readRecord(repoFolder))?.business) || []
  try {
    const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/llm-proxy`, {
      method: 'POST',
      signal: AbortSignal.timeout(BRIEF_DRAFT_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        feature: 'setup',
        json: true,
        max_tokens: BRIEF_DRAFT_MAX_TOKENS,
        userPrompt: briefDraftPrompt({ readme }, types)
      })
    })
    if (resp.status === 401) return { fail: 'signed_out' }
    const brief = parseBriefDraft(await readProxyResult(resp))
    return brief ? { brief } : { fail: 'failed' }
  } catch {
    return { fail: 'failed' }
  }
}

export async function changeInfra(
  projectId: string,
  change: (record: InfraRecord) => InfraRecord
): Promise<ProjectInfra> {
  const repoFolder = projectFolder(projectId)
  if (!repoFolder)
    return { projectId, record: null, error: 'This project has no folder on this Mac.' }
  const previous = await readRecord(repoFolder)
  const base = previous ?? (await checkInfra(projectId)).record
  if (!base) return { projectId, repoFolder, record: null }
  const record = settleSetups(change(structuredClone(base)))
  await writeRecord(repoFolder, record, previous)
  return { projectId, repoFolder, record }
}
