import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join } from 'path'
import { z } from 'zod'
import { CONFIG } from '../shared/config'
import {
  SITE_RECORD_PATH,
  type PublishedSite,
  type SiteProgress,
  type SiteState
} from '../shared/infra'
import { getSupabase } from './supabase'
import { MIGHTY } from './store/mighty'
import type { VerbHandler } from './agent-relay/mcp/verbs'

const SITES = CONFIG.BILLING.SITES
const SKIP_DIRS = new Set(['node_modules'])
const CALL_TIMEOUT_MS = 30_000
const FILE_TIMEOUT_MS = 120_000
const DROPPED = 'The connection dropped or took too long. Nothing is broken - try again.'

interface SiteFile {
  path: string
  full: string
  bytes: number
}

class PublishError extends Error {
  constructor(
    message: string,
    readonly planRequired = false
  ) {
    super(message)
  }
}

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return s.length >= 3 ? s : ''
}

function siteFolder(repoFolder: string): string | null {
  for (const sub of SITES.FOLDERS) {
    const dir = sub ? join(repoFolder, sub) : repoFolder
    if (existsSync(join(dir, 'index.html'))) return dir
  }
  return null
}

async function collect(root: string): Promise<SiteFile[]> {
  const files: SiteFile[] = []
  let total = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(full, path)
        continue
      }
      if (!entry.isFile()) continue
      const { size } = await stat(full)
      if (size > SITES.MAX_FILE_BYTES)
        throw new PublishError(
          `${path} is over 10 MB. Make it smaller or remove it, then try again.`
        )
      total += size
      files.push({ path, full, bytes: size })
      if (files.length > SITES.MAX_FILES)
        throw new PublishError(
          'This site has more than 2,000 files, which is too many to put online.'
        )
      if (total > SITES.MAX_BYTES)
        throw new PublishError('This site is over 100 MB, which is too big to put online.')
    }
  }
  await walk(root, '')
  return files
}

async function call(body: Record<string, unknown>): Promise<Record<string, string>> {
  const { data } = await getSupabase().auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) throw new PublishError('Sign in to put your site online.')
  const resp = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/${SITES.FN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  })
  const json = await resp.json().catch(() => ({}))
  if (!resp.ok)
    throw new PublishError(
      json?.message ?? "We couldn't reach MightyMouse. Check your connection and try again.",
      json?.error === 'plan_required'
    )
  return json
}

async function upload(
  uploadUrl: string,
  token: string,
  files: SiteFile[],
  onSent: (sent: number) => void
): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` }
  let sent = 0
  const cleared = await fetch(uploadUrl, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
  })
  if (!cleared.ok) throw new PublishError("The upload didn't start. Try again.")
  const queue = [...files]
  const worker = async (): Promise<void> => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const path = file.path.split('/').map(encodeURIComponent).join('/')
      const resp = await fetch(`${uploadUrl}/${path}`, {
        method: 'PUT',
        headers,
        body: await readFile(file.full),
        signal: AbortSignal.timeout(FILE_TIMEOUT_MS)
      })
      if (!resp.ok) throw new PublishError(`${file.path} didn't upload. Try again.`)
      onSent(++sent)
    }
  }
  await Promise.all(Array.from({ length: SITES.UPLOADS_AT_ONCE }, worker))
}

async function readSite(repoFolder: string): Promise<PublishedSite | null> {
  try {
    return JSON.parse(await readFile(join(repoFolder, SITE_RECORD_PATH), 'utf8'))
  } catch {
    return null
  }
}

function project(projectId: string): { name: string; repoFolder: string } {
  const p = MIGHTY.getProject(projectId)
  if (!p?.repoFolder || !existsSync(p.repoFolder))
    throw new PublishError('This project has no folder on this Mac.')
  return { name: p.name, repoFolder: p.repoFolder }
}

async function state(projectId: string, failure?: unknown): Promise<SiteState> {
  const p = MIGHTY.getProject(projectId)
  const site = p?.repoFolder ? await readSite(p.repoFolder) : null
  const folder = p?.repoFolder ? siteFolder(p.repoFolder) : null
  const base: SiteState = {
    site,
    suggested: site?.name ?? slug(p?.name ?? ''),
    pageFolder: folder && p?.repoFolder ? folder.slice(p.repoFolder.length + 1) : null
  }
  if (!failure) return base
  return {
    ...base,
    error: failure instanceof PublishError ? failure.message : DROPPED,
    planRequired: failure instanceof PublishError && failure.planRequired
  }
}

export function getSite(projectId: string): Promise<SiteState> {
  return state(projectId)
}

async function putOnline(
  repoFolder: string,
  projectName: string,
  wanted: string,
  report: (sent: number, total: number, step: SiteProgress['step']) => void
): Promise<PublishedSite> {
  const name = slug(wanted)
  if (!name) throw new PublishError('Use 3 to 40 letters, numbers or dashes for the address.')
  const folder = siteFolder(repoFolder)
  if (!folder) throw new PublishError('This project has no web page to put online yet.')
  const files = await collect(folder)
  const bytes = files.reduce((sum, f) => sum + f.bytes, 0)
  const total = files.length
  report(0, total, 'checking')
  const previous = await readSite(repoFolder)
  if (previous && previous.name !== name) await call({ action: 'unpublish', name: previous.name })
  const grant = await call({ action: 'publish', name, projectName, fileCount: files.length, bytes })
  report(0, total, 'sending')
  await upload(grant.uploadUrl, grant.token, files, (sent) => report(sent, total, 'sending'))
  report(total, total, 'finishing')
  const site: PublishedSite = {
    name,
    url: grant.url,
    publishedAt: new Date().toISOString(),
    files: files.length,
    folder: folder === repoFolder ? '' : folder.slice(repoFolder.length + 1)
  }
  const recordPath = join(repoFolder, SITE_RECORD_PATH)
  await mkdir(dirname(recordPath), { recursive: true })
  await writeFile(recordPath, JSON.stringify(site, null, 2) + '\n')
  return site
}

export async function publishSite(
  projectId: string,
  wanted: string,
  report: (progress: SiteProgress) => void
): Promise<SiteState> {
  try {
    const { name, repoFolder } = project(projectId)
    await putOnline(repoFolder, name, wanted, (sent, total, step) => report({ projectId, step, sent, total }))
    return state(projectId)
  } catch (err) {
    return state(projectId, err)
  }
}

const publishSiteHandler: VerbHandler<{ folder: z.ZodString; name: z.ZodOptional<z.ZodString> }> = {
  description:
    'Put a web project online at its own MightyMouse address (https://<name>.mightymouse.app) and get the link back. ' +
    'Use when the user asks to deploy, publish, host or share a site "on MightyMouse". ' +
    `Uploads the first of ${SITES.FOLDERS.filter(Boolean).join('/')} or the folder itself that holds an index.html, so run the build first. ` +
    'Publishing again replaces the files at the same address. Needs the user signed in to MightyMouse on a paid plan.',
  inputSchema: {
    folder: z.string().describe('Absolute path of the project folder, usually your working directory.'),
    name: z
      .string()
      .optional()
      .describe('The address before .mightymouse.app, 3-40 letters, numbers or dashes. Defaults to the last one used, else the folder name.')
  },
  run: async ({ folder, name }) => {
    const text = (t: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
      content: [{ type: 'text', text: t }],
      ...(isError ? { isError } : {})
    })
    if (!isAbsolute(folder) || !existsSync(folder)) return text(`No folder at ${folder}.`, true)
    try {
      const wanted = name || (await readSite(folder))?.name || basename(folder)
      const site = await putOnline(folder, basename(folder), wanted, () => {})
      return text(`Online at ${site.url} (${site.files} ${site.files === 1 ? 'file' : 'files'}). Give the user this link.`)
    } catch (err) {
      if (err instanceof PublishError)
        return text(err.planRequired ? `${err.message} Plans: https://getmightymouse.com/pricing/` : err.message, true)
      return text(DROPPED, true)
    }
  }
}

export const PUBLISH_HANDLERS: Record<string, VerbHandler<z.ZodRawShape>> = {
  publish_site: publishSiteHandler as unknown as VerbHandler<z.ZodRawShape>
}

export async function unpublishSite(projectId: string): Promise<SiteState> {
  try {
    const { repoFolder } = project(projectId)
    const site = await readSite(repoFolder)
    if (site) {
      await call({ action: 'unpublish', name: site.name })
      await rm(join(repoFolder, SITE_RECORD_PATH), { force: true })
    }
    return state(projectId)
  } catch (err) {
    return state(projectId, err)
  }
}
