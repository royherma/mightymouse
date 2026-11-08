/**
 * How shared work reads as a list of agents rather than a list of tables.
 *
 * The snapshot arrives as five parallel arrays (sessions, work, messages,
 * events, projects) because that is how it is stored. Nobody scans it that
 * way: the question is always "which agent wants something from me", so the
 * agent is the row and everything else hangs off the one that owns it.
 *
 * Pure and side-effect free, in `shared/` for the same reason `relay-sessions.ts`
 * is -- what a row claims and what the list sorted by have to come from one
 * place.
 *
 * On freshness: `state` is what a session last SAID it was, `stale` is whether
 * anyone has heard from it since. Measured on a real machine, 274 rows claimed
 * `active` while being hours cold, so `stale` wins every time the two disagree.
 */

import { COORDINATION } from './coordination'
import type {
  CoordinationEvent,
  CoordinationMessage,
  CoordinationSession,
  CoordinationSnapshot,
  CoordinationWork
} from './coordination'

/** What the row says about itself, strongest claim first. A row is only ever
 *  one of these, and the order here is the order they sort in. */
export type RosterState = 'blocked' | 'waiting' | 'working' | 'idle' | 'gone'

export const ROSTER_STATE_LABELS: Record<RosterState, string> = {
  blocked: 'Stuck',
  waiting: 'Waiting on you',
  working: 'Working',
  idle: 'Waiting for next turn',
  gone: 'No recent check-in'
}

const STATE_ORDER: Record<RosterState, number> = {
  blocked: 0,
  waiting: 1,
  working: 2,
  idle: 3,
  gone: 4
}

export interface RosterMessage {
  message: CoordinationMessage
  /** True when this agent sent it, false when it is addressed to them. */
  outgoing: boolean
  /** The other end, already resolved to a label rather than an id. */
  otherLabel: string
}

export interface RosterAgent {
  session: CoordinationSession
  state: RosterState
  /** Work this agent owns. Expired leases included -- an expired claim is the
   *  single most useful thing the list can surface, so it is never dropped. */
  work: CoordinationWork[]
  messages: RosterMessage[]
  /** What this agent last did, for the one activity line on the row. */
  lastEvent?: CoordinationEvent
  /** Milliseconds since this session was last heard from. */
  quietFor: number
}

export interface RosterProject {
  id: string
  name: string
  archived: boolean
  agents: RosterAgent[]
  /** Fresh agents in this project that want something. Drives the header badge
   *  so a collapsed project still says something is waiting inside it. */
  wanting: number
}

export interface Roster {
  projects: RosterProject[]
  /** Sessions filtered out as cold, counted rather than rendered. */
  hidden: number
  /** Every project in the snapshot, for the project picker, even the ones with
   *  no agent left after filtering. */
  projectNames: [string, string][]
  /** Work and handoffs whose session is not in this snapshot -- the sessions
   *  list is paged, and a claim outlives the pane that made it. Measured on a
   *  real machine the ONE blocked item was orphaned this way, so hanging
   *  everything off an agent row and dropping the rest loses exactly the row
   *  that matters most. Expired ones are left out: an owner that stopped
   *  renewing is gone, and no verb lets anyone else finish or clear its claim. */
  orphanWork: CoordinationWork[]
  orphanMessages: CoordinationMessage[]
}

/** A session the app spawned for ITSELF -- the title namer, a recap -- rather
 *  than a pane someone is sitting at. `mm-coord` now refuses to enrol these,
 *  but ~700 registered before it did and they are still in the store, so the
 *  list has to drop them on the way in or `.namer-scratch` keeps showing up as
 *  one of the user's projects. Matches the shim's `isUtilitySession`. */
export function isUtilitySessionCwd(cwd: string): boolean {
  const scratch = /(^|\/)\.claude(\/\.namer-scratch)?$/
  return scratch.test(cwd.replace(/\/+$/, '')) || /\/T\/tmp\./.test(cwd)
}

function labelFor(sessions: Map<string, CoordinationSession>, id: string): string {
  return sessions.get(id)?.label ?? 'Someone who has left'
}

/**
 * Which of the five words this agent gets.
 *
 * Owning blocked work outranks being cold: an agent that went away holding a
 * blocked claim is the worst row in the list, and saying only "no recent
 * check-in" would hide the reason it matters.
 */
function stateFor(
  session: CoordinationSession,
  work: CoordinationWork[],
  messages: RosterMessage[]
): RosterState {
  if (work.some((w) => w.state === 'blocked' || w.expired)) return 'blocked'
  if (messages.some((m) => !m.outgoing && m.message.state === 'pending')) return 'waiting'

  if (session.stale) return 'gone'
  if (session.state === 'awaiting_input') return 'waiting'
  return session.state === 'active' ? 'working' : 'idle'
}

/**
 * Turn a snapshot into projects of agents.
 *
 * `showCold` is the reveal: with it off, sessions nobody has heard from are
 * counted into `hidden` instead of rendered. On a real machine that is 498 rows
 * of 500, and leaving them in buries the two agents that are actually running.
 * An agent holding work or a message is never cold, however quiet -- something
 * is still pinned to it.
 */
export function buildRoster(
  snapshot: Pick<CoordinationSnapshot, 'projects' | 'sessions' | 'work' | 'messages' | 'events'>,
  showCold = false
): Roster {
  const byId = new Map(snapshot.sessions.map((s) => [s.id, s]))
  // A session carries the project name it joined with, which a rename does not reach. The
  // projects table is the live one, so it wins wherever both have an answer.
  const projectRows = new Map(snapshot.projects.map((p) => [p.id, p]))

  const workFor = new Map<string, CoordinationWork[]>()
  const orphanWork: CoordinationWork[] = []
  for (const item of snapshot.work) {
    if (!byId.has(item.owner)) {
      if (!item.expired) orphanWork.push(item)
      continue
    }
    const list = workFor.get(item.owner)
    if (list) list.push(item)
    else workFor.set(item.owner, [item])
  }

  const messagesFor = new Map<string, RosterMessage[]>()
  const attach = (id: string, entry: RosterMessage): void => {
    const list = messagesFor.get(id)
    if (list) list.push(entry)
    else messagesFor.set(id, [entry])
  }
  const orphanMessages: CoordinationMessage[] = []
  for (const message of snapshot.messages) {
    const hasSender = byId.has(message.sender)
    const hasRecipient = byId.has(message.recipient)
    if (!hasSender && !hasRecipient) {
      orphanMessages.push(message)
      continue
    }
    // One handoff is one row, on whoever has to act on it: the recipient while
    // it is unanswered, the sender once it is settled. Attaching it to both
    // ends printed the same handoff twice, saying opposite things.
    const pending = message.state === 'pending'
    if (pending && hasRecipient)
      attach(message.recipient, { message, outgoing: false, otherLabel: labelFor(byId, message.sender) })
    else if (!pending && hasSender)
      attach(message.sender, { message, outgoing: true, otherLabel: labelFor(byId, message.recipient) })
    else if (hasRecipient)
      attach(message.recipient, { message, outgoing: false, otherLabel: labelFor(byId, message.sender) })
    else
      attach(message.sender, { message, outgoing: true, otherLabel: labelFor(byId, message.recipient) })
  }

  // Newest event per actor. The array is ascending by seq, so a plain overwrite
  // leaves the latest.
  const lastEvent = new Map<string, CoordinationEvent>()
  for (const event of snapshot.events) lastEvent.set(event.actor, event)

  // Wall clock, not `generatedAt`: the snapshot is polled every few seconds and
  // a row's "quiet for" should keep counting between two of them.
  const now = Date.now()

  const projects = new Map<string, RosterProject>()
  const projectNames = new Map<string, string>()
  let hidden = 0

  for (const session of snapshot.sessions) {
    if (isUtilitySessionCwd(session.cwd)) continue
    projectNames.set(
      session.project,
      projectRows.get(session.project)?.name ?? session.projectName
    )

    const work = workFor.get(session.id) ?? []
    const messages = messagesFor.get(session.id) ?? []
    const state = stateFor(session, work, messages)
    const pinned =
      work.some((w) => w.state === 'working' || w.state === 'blocked') ||
      messages.some((m) => m.message.state === 'pending' || m.message.state === 'accepted')

    if (state === 'gone' && !pinned && !showCold) {
      hidden += 1
      continue
    }

    const agent: RosterAgent = {
      session,
      state,
      work,
      messages,
      lastEvent: lastEvent.get(session.id),
      quietFor: Math.max(0, now - session.lastSeen)
    }

    const project = projects.get(session.project)
    if (project) project.agents.push(agent)
    else
      projects.set(session.project, {
        id: session.project,
        name: projectNames.get(session.project) ?? session.projectName,
        archived: projectRows.get(session.project)?.state === 'archived',
        agents: [agent],
        wanting: 0
      })
  }

  const views = [...projects.values()].map((project) => ({
    ...project,
    agents: project.agents.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        a.quietFor - b.quietFor ||
        a.session.label.localeCompare(b.session.label)
    ),
    wanting: project.agents.filter((a) => a.state === 'blocked' || a.state === 'waiting').length
  }))

  // A project with something stuck in it comes first however quiet it is;
  // beyond that the busiest checkout leads.
  views.sort((a, b) => b.wanting - a.wanting || b.agents.length - a.agents.length)

  return {
    projects: views,
    hidden,
    projectNames: [...projectNames.entries()],
    orphanWork,
    orphanMessages
  }
}

/** "9h" / "12m" / "8s" -- one unit, because a roster row has space for one. */
export function quietLabel(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

/** Whether a session counts as heard-from, by the same threshold the store
 *  stamps `stale` with. Kept here so a caller can re-check without the store. */
export function isFresh(session: CoordinationSession, now = Date.now()): boolean {
  return now - session.lastSeen <= COORDINATION.staleMs
}
