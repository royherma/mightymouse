import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveBinary } from '../platform'
import type { GithubJobEvent } from '../../shared/types'

const exec = promisify(execFile)
const GH_TIMEOUT_MS = 30_000
const LIST_LIMIT = 30
const SEEN_CAP = 300

export interface GithubItem {
  id: string
  title: string
  url: string
}

interface RawItem {
  number: number
  title: string
  url: string
  headRefOid?: string
  statusCheckRollup?: { conclusion?: string; state?: string }[]
}

const EVENT_TEXT: Record<GithubJobEvent, string> = {
  'pr-opened': 'A new pull request was opened',
  'issue-opened': 'A new issue was opened',
  'checks-failed': 'Checks failed on a pull request'
}

export function describeGithubItem(event: GithubJobEvent, item: GithubItem, instructions: string): string {
  return `${EVENT_TEXT[event]}: ${item.title} ${item.url}. ${instructions}`.trim()
}

function hasFailedCheck(raw: RawItem): boolean {
  return (raw.statusCheckRollup ?? []).some((c) => c.conclusion === 'FAILURE' || c.state === 'FAILURE' || c.state === 'ERROR')
}

export function toGithubItems(event: GithubJobEvent, raw: RawItem[]): GithubItem[] {
  const rows = event === 'checks-failed' ? raw.filter(hasFailedCheck) : raw
  return rows.map((r) => ({
    id: event === 'checks-failed' ? `${r.number}@${r.headRefOid ?? ''}` : String(r.number),
    title: r.title,
    url: r.url
  }))
}

// First poll (seen undefined) only records what already exists, so old items never fire.
export function splitNewItems(items: GithubItem[], seen: string[] | undefined): { fresh: GithubItem[]; seen: string[] } {
  const known = new Set(seen ?? [])
  const fresh = seen ? items.filter((i) => !known.has(i.id)) : []
  const merged = [...known, ...items.map((i) => i.id).filter((id) => !known.has(id))]
  return { fresh, seen: merged.slice(-SEEN_CAP) }
}

const GH_ARGS: Record<GithubJobEvent, string[]> = {
  'pr-opened': ['pr', 'list', '--state', 'all', '--json', 'number,title,url'],
  'issue-opened': ['issue', 'list', '--state', 'all', '--json', 'number,title,url'],
  'checks-failed': ['pr', 'list', '--state', 'open', '--json', 'number,title,url,headRefOid,statusCheckRollup']
}

export async function fetchGithubItems(repoCwd: string, event: GithubJobEvent): Promise<GithubItem[]> {
  const bin = resolveBinary('gh')
  if (!bin) throw new Error('The GitHub CLI (gh) is not on this Mac.')
  const { stdout } = await exec(bin, [...GH_ARGS[event], '--limit', String(LIST_LIMIT)], {
    cwd: repoCwd,
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 8 << 20
  })
  return toGithubItems(event, JSON.parse(stdout) as RawItem[])
}
