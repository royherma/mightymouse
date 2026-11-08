// agent-sinks.ts — the coding agents you have running, as routing destinations.
//
// The second source of sinks, alongside the open Mac apps in sinks.ts. An agent
// is a better destination than the terminal window it happens to live in: the
// text goes into that agent's prompt, not into whichever pane is frontmost.
//
// Delivery is sendPaneText, NOT a paste. It writes straight to the tmux pane or
// the shim's pty and presses Enter itself, so it never touches the frontmost
// window and cannot land in the wrong app — the failure mode that the desktop
// paste path needs waitForFrontmost to guard against.
import { liveAgentSessions, type AgentSession } from '../agent-relay/mcp/http-listener'
import type { JevSink } from './jev-client'
import { repoRootOf } from './page-owner'
import { rowName } from '../ipc/agent-relay'
import { readableName } from '../../shared/relay-status'
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, join } from 'path'

const MAX_PROJECT_SUMMARY = 160

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

function packageName(root: string): string {
  try {
    const name = JSON.parse(readText(join(root, 'package.json'))).name
    return typeof name === 'string' ? name.replace(/^@[^/]+\//, '') : ''
  } catch {
    return ''
  }
}

function originRepoName(root: string): string {
  const gitPath = join(root, '.git')
  const configPath = existsSync(gitPath) && statSync(gitPath).isDirectory() ? join(gitPath, 'config') : ''
  const url = configPath === '' ? '' : (/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(readText(configPath))?.[1] ?? '')
  return url === '' ? '' : basename(url).replace(/\.git$/, '')
}

function readmeHeadAndSummary(root: string): { heading: string; summary: string } {
  const text = readText(join(root, 'README.md')) || readText(join(root, 'CLAUDE.md'))
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? ''
  const paragraph = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length >= 30 && !p.startsWith('#') && !p.startsWith('>') && !p.startsWith('<'))
  const flat = (paragraph ?? '').replace(/[*`]/g, '').replace(/\s+/g, ' ')
  return { heading, summary: flat.length > MAX_PROJECT_SUMMARY ? `${flat.slice(0, MAX_PROJECT_SUMMARY - 1)}…` : flat }
}

const identityCache = new Map<string, string>()

/** " (also called Nimbus; Mobile web ...)" for a folder whose product name differs from the folder name. */
export function projectIdentityPhrase(project: string, cwd: string): string {
  if (cwd === '') return ''
  const root = repoRootOf(cwd)
  const cached = identityCache.get(`${project}\0${root}`)
  if (cached !== undefined) return cached
  const { heading, summary } = readmeHeadAndSummary(root)
  const seen = new Set([project.toLowerCase(), basename(root).toLowerCase()])
  const aliases: string[] = []
  for (const name of [heading, packageName(root), originRepoName(root)]) {
    if (name === '' || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    aliases.push(name)
  }
  const parts = [aliases.length > 0 ? `also called ${aliases.join(', ')}` : '', summary].filter((p) => p !== '')
  const phrase = parts.length > 0 ? ` (${parts.join('; ')})` : ''
  identityCache.set(`${project}\0${root}`, phrase)
  return phrase
}

/** Pathological-case ceiling only. Measured cost is ~177 chars/agent (~44
 *  tokens): even 300 agents is ~13k tokens, still well inside a single Jev
 *  call's budget, and the fan-out below asks per-project questions in
 *  parallel rather than one giant flat list, so the real cost per branch stays
 *  small. This is not a "how many to rank" knob any more — see
 *  groupAgentSinksByProject — it only stops an unbounded relay from ever
 *  turning into an unbounded request body. */
const MAX_AGENT_SINKS = 300

/** When cutting for MAX_AGENT_SINKS, keep the most likely to be relevant: a
 *  session working right now, then one active in the last few minutes, then
 *  idle ones by how recently they last did anything. Mirrors the tiers
 *  activityPhrase already renders as text, so "who's cut" matches "what the
 *  card would have said about them". */
function recencyRank(session: AgentSession): number {
  if (session.busySince !== undefined) return 2
  const idleMs = Date.now() - recencyTimestamp(session)
  if (idleMs < 5 * 60_000) return 1
  return 0
}

function recencyTimestamp(session: AgentSession): number {
  return session.lastActivityAt ?? session.busySince ?? session.lastTurnEndedAt ?? session.since
}

/** Past this, an agent stops being offered at all and the card falls through to
 *  "start a new agent" for that project. A session idle this long has almost
 *  certainly moved on from whatever it was doing, so routing new dictated text
 *  into it buries the text in a dead thread — the case a fresh session handles
 *  better. Measured on a 37-session relay: without a cutoff, 36 of them ranked
 *  identically on terminal-open time and crowded out the one actually working. */
const MAX_IDLE_MS = 2 * 60 * 60_000

/** A session that never reported a turn is not provably stale — an older shim
 *  and a plain terminal both look like this — so age alone never cuts it. Only a
 *  session that HAS a turn history, and whose last turn is past the cutoff, goes. */
function isStale(session: AgentSession): boolean {
  if (session.busySince !== undefined) return false
  const last = session.lastActivityAt ?? session.lastTurnEndedAt
  if (last === undefined) return false
  return Date.now() - last > MAX_IDLE_MS
}

/** Prefix that keeps agent ids from colliding with an app's bundle id in the
 *  single id space the card and Jev share. */
const AGENT_SINK_PREFIX = 'agent:'

export interface AgentSink extends JevSink {
  kind: 'agent'
  session: AgentSession
  /** repo name (or derived/cwd fallback) this agent belongs to — the grouping
   *  key for the project fan-out in jev-client.ts. Never empty. */
  project: string
  /** The facts the card shows as separate chips on hover: branch and whether it
   *  is mid-turn. Kept apart from `description`, which is the prose sentence
   *  Jev ranks on and reads badly as a scannable line. */
  branch: string
  activity: string
}

/** One project's agents, ready to become a `agents_in_<slug>` fan-out question.
 *  `slug` is the sanitized, code-safe question key; `label` is the human name
 *  kept for the project Choice's own criteria text. */
export interface ProjectAgentGroup {
  project: string
  slug: string
  description: string
  sinks: AgentSink[]
}

/** Turn a project name into a safe Jev question key. Question keys are picked
 *  up by exact string match after the response comes back, so this only needs
 *  to be stable and collision-free for the names actually seen, not reversible. */
function projectSlug(project: string): string {
  const cleaned = project.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned !== '' ? cleaned.toLowerCase() : 'unknown'
}

/** Group agent sinks by project for the Speculative Fan-Out: one Choice
 *  question naming the projects, then one Choice question per project ranking
 *  only the agents inside it — all asked in the same request (see jev-client's
 *  buildAgentFanOut), so Jev answers every branch in parallel and the code
 *  discards every branch except the one it picked. Description is short: agent
 *  count plus what's actually happening, matching what a description budget of
 *  ~129 tokens for 7 projects bought in the real relay snapshot. */
export function groupAgentSinksByProject(sinks: readonly AgentSink[]): ProjectAgentGroup[] {
  const byProject = new Map<string, AgentSink[]>()
  for (const sink of sinks) {
    const list = byProject.get(sink.project)
    if (list) list.push(sink)
    else byProject.set(sink.project, [sink])
  }

  const groups: ProjectAgentGroup[] = []
  for (const [project, projectSinks] of byProject) {
    const working = projectSinks.filter((s) => s.session.busySince !== undefined).length
    const subjects = projectSinks
      .map((s) => s.session.tldr)
      .filter((t): t is string => t !== undefined && t !== '')
      .slice(0, 3)
    const countPhrase = `${projectSinks.length} agent${projectSinks.length === 1 ? '' : 's'}`
    const workingPhrase = working > 0 ? `, ${working} working right now` : ''
    const subjectsPhrase = subjects.length > 0 ? `: ${subjects.join('; ')}` : ''
    groups.push({
      project,
      slug: projectSlug(project),
      description: `${project}${projectIdentityPhrase(project, projectSinks[0].session.cwd ?? '')} — ${countPhrase}${workingPhrase}${subjectsPhrase}`,
      sinks: projectSinks
    })
  }
  return groups
}

export function isAgentSinkId(id: string): boolean {
  return id.startsWith(AGENT_SINK_PREFIX)
}

/** Stable per session: the sessionId survives a rename, and the label is the
 *  fallback for a shim that never sent one. */
function agentSinkId(session: AgentSession): string {
  return `${AGENT_SINK_PREFIX}${session.sessionId ?? session.label}`
}

/** A session mid-turn (busySince set) is actively producing output right now,
 *  which matters for ranking: "keep going on the auth bug" belongs on the agent
 *  already working, not one that finished and is sitting idle. lastActivityAt
 *  is the fallback liveness signal for a session between turns. Phrased as
 *  plain state, not a raw timestamp — Jev ranks on text, not epoch math. */
function activityPhrase(session: AgentSession): string {
  if (session.staleSince !== undefined) return 'disconnected'
  if (session.busySince !== undefined) return 'working right now'
  const last = session.lastActivityAt ?? session.lastTurnEndedAt
  if (last === undefined) return 'idle'
  const idleMin = Math.round((Date.now() - last) / 60_000)
  if (idleMin < 5) return 'active just now'
  if (idleMin < 60) return `idle for ${idleMin}m`
  return `idle for ${Math.round(idleMin / 60)}h`
}

/** repo/branch from the shim's own facts is more precise than the derived
 *  display string (e.g. "ShowAndTell" vs "ShowAndTell on feature/x"), so build
 *  the location from facts first and only fall back to derived/cwd when the
 *  shim didn't send facts (older shim, plain terminal). */
function locationPhrase(session: AgentSession): string {
  const repo = session.facts?.repo
  const branch = session.facts?.branch
  if (repo !== undefined) return branch !== undefined ? `${repo} on ${branch}` : repo
  return session.derived ?? session.cwd ?? ''
}

/**
 * Snapshot the agents that could receive this transcript.
 *
 * Only sessions we can actually deliver to are returned: without an origin
 * (a tmux pane) and without a pid, sendPaneText can only return 'skipped', and
 * a destination that silently swallows the text is worse than not offering it.
 */
export function collectAgentSinks(options: { includeStale?: boolean } = {}): AgentSink[] {
  return liveAgentSessions()
    .filter((s) => s.origin?.tmuxPane !== undefined || s.facts?.pid !== undefined)
    .filter((s) => options.includeStale === true || !isStale(s))
    .sort((a, b) => recencyRank(b) - recencyRank(a) || recencyTimestamp(b) - recencyTimestamp(a))
    .slice(0, MAX_AGENT_SINKS)
    .map((session) => {
      // `tldr` is the agent's own line about what it is working on, which is the
      // only field that tells six panes on one checkout apart by subject — and
      // so the strongest thing Jev can rank on.
      const subject = session.tldr ?? ''
      const where = locationPhrase(session)
      const activity = activityPhrase(session)
      const base = `A coding agent${where === '' ? '' : ` in ${where}`} (${activity})`
      return {
        kind: 'agent' as const,
        id: agentSinkId(session),
        label: displayLabel(session),
        description: subject !== '' ? `${base}, currently working on: ${subject}` : base,
        session,
        project: session.facts?.repo ?? session.derived ?? session.cwd ?? 'unknown',
        branch: session.facts?.branch ?? '',
        activity
      }
    })
}

function displayLabel(session: AgentSession): string {
  const name = readableName(rowName(session)) || session.tldr?.trim()
  if (!name) return session.label
  const dash = session.label.indexOf(' - ')
  return `${dash > 0 ? session.label.slice(0, dash) : session.label} - ${name}`
}
