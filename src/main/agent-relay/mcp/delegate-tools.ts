import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { z } from 'zod'
import { devLog } from '../../../shared/env'
import { agentLabel } from '../../../shared/relay-status'
import type { AgentHelper, AgentOrigin } from '../../../shared/types'
import { capturePaneTail } from '../picker-keys'
import { claudeTranscriptPaths, codexTranscriptPath, readSessionTranscript } from '../session-transcript'
import { liveAgentSessions, setAgentSessionTldr, type AgentSession } from './http-listener'
import type { VerbHandler, VerbToolResult } from './verbs'

const HELPERS = ['claude', 'codex', 'ollama', 'opencode', 'cursor'] as const
type Helper = (typeof HELPERS)[number]
const HELPER_NAMES: Record<Helper, string> = { claude: 'Claude Code', codex: 'Codex', ollama: 'Local model', opencode: 'OpenCode', cursor: 'Cursor' }
const HELPER_ICONS: Record<Helper, string> = { claude: 'claude', codex: 'codex', ollama: 'local', opencode: 'opencode', cursor: '' }
// Claude Code and Codex both end an MCP call at ~60s, so a longer wait comes back as an error.
const WAIT_DEFAULT_S = 50
const WAIT_MAX_S = 55
const ANSWER_MAX = 20_000
const TLDR_TASK_WORDS = 8
const POLL_MS = 2_000
// Agents with no finish line of their own are done once their window has sat still this long.
const SCREEN_STILL_MS = 12_000
const SCREEN_LINES = 80
const MODELS_SHOWN = 12

interface HelperTask {
  id: string
  agent: Helper
  task: string
  pane: string
  parentKey: string
  parentName: string
  startedAt: number
  childSessionId?: string
  answer?: string
  doneAt?: number
  screen?: { text: string; since: number }
  waiters: Set<() => void>
}

const tasks = new Map<string, HelperTask>()
let poll: NodeJS.Timeout | null = null

function textResult(text: string, isError = false): VerbToolResult {
  return { content: [{ type: 'text', text }], isError }
}

function sessionFor(id: string | undefined): AgentSession | undefined {
  return id ? liveAgentSessions().find((s) => s.sessionId === id) : undefined
}

function childSession(task: HelperTask): AgentSession | undefined {
  if (task.childSessionId) return sessionFor(task.childSessionId)
  const found = liveAgentSessions().find((s) => s.origin?.tmuxPane === task.pane && s.since >= task.startedAt - 5_000)
  if (found?.sessionId) {
    task.childSessionId = found.sessionId
    setAgentSessionTldr(found.sessionId, `Helping ${task.parentName}: ${task.task.split(/\s+/).slice(0, TLDR_TASK_WORDS).join(' ')}`)
  }
  return found
}

// The session file, not a hook: Codex has no Stop hook, and Claude skips its own when a turn dies on a usage limit.
function finishLine(path: string, marker: string, since: number): { payload?: { last_agent_message?: string } } | undefined {
  if (!path || !existsSync(path)) return undefined
  let found: { payload?: { last_agent_message?: string } } | undefined
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes(marker)) continue
    try {
      const row = JSON.parse(line) as { timestamp?: string; payload?: { last_agent_message?: string } }
      if (Date.parse(row.timestamp ?? '') >= since) found = row
    } catch { /* A half-written last line is the next poll's to read. */ }
  }
  return found
}

function finishedReply(agent: Helper, session: AgentSession, since: number): string | undefined {
  if (!session.sessionId) return undefined
  if (agent === 'codex') {
    const done = finishLine(codexTranscriptPath(homedir(), session.sessionId), '"task_complete"', since)
    return done ? done.payload?.last_agent_message ?? '' : undefined
  }
  const path = session.cwd ? claudeTranscriptPaths(homedir(), session.cwd, session.sessionId).find((p) => existsSync(p)) : undefined
  return path && finishLine(path, '"turn_duration"', since) ? lastAgentReply(session) : undefined
}

function lastAgentReply(session: AgentSession): string {
  const turns = readSessionTranscript(session)
  const reply = [...turns].reverse().find((t) => t.role === 'agent' && t.text.trim() !== '')
  return reply?.text ?? ''
}

function finish(task: HelperTask, answer: string): void {
  if (task.doneAt) return
  task.doneAt = Date.now()
  task.answer = answer.trim().slice(0, ANSWER_MAX)
  for (const wake of task.waiters) wake()
  task.waiters.clear()
  devLog.log(`[delegate] ${task.id} ${task.agent} done in ${Math.round((task.doneAt - task.startedAt) / 1000)}s, ${task.answer.length} chars`)
}

async function screenSettled(task: HelperTask, origin: AgentOrigin): Promise<string | undefined> {
  const text = (await capturePaneTail(origin, SCREEN_LINES, ANSWER_MAX))?.trim() ?? ''
  const now = Date.now()
  if (!text || text !== task.screen?.text) {
    task.screen = { text, since: now }
    return undefined
  }
  return now - task.screen.since >= SCREEN_STILL_MS ? text : undefined
}

async function check(task: HelperTask): Promise<void> {
  if (task.doneAt || !task.pane) return
  const session = childSession(task)
  if (task.agent === 'opencode' || task.agent === 'cursor') {
    const reply = await screenSettled(task, session?.origin ?? { tmuxPane: task.pane })
    if (reply !== undefined) finish(task, reply)
    return
  }
  if (!session) return
  const reply = finishedReply(task.agent, session, task.startedAt)
  if (reply !== undefined) finish(task, reply)
}

function watch(): void {
  poll ??= setInterval(() => {
    const open = [...tasks.values()].filter((t) => !t.doneAt)
    for (const task of open) void check(task)
    if (open.every((t) => t.doneAt) && poll) {
      clearInterval(poll)
      poll = null
    }
  }, POLL_MS)
}

type Caller = { sessionId?: string; origin?: AgentOrigin }

// Codex connects with no session id (it gets one only after it starts), so its terminal pane is what names it.
function callerSession(caller: Caller): AgentSession | undefined {
  const pane = caller.origin?.tmuxPane
  return (
    sessionFor(caller.sessionId) ??
    (pane ? liveAgentSessions().find((s) => s.origin?.tmuxPane === pane && s.origin?.tmuxSocket === caller.origin?.tmuxSocket) : undefined)
  )
}

function callerKey(caller: Caller): string {
  const pane = caller.origin?.tmuxPane
  return pane ? `pane:${caller.origin?.tmuxSocket ?? ''}:${pane}` : caller.sessionId ?? ''
}

function helperOf(caller: Caller): HelperTask | undefined {
  const pane = caller.origin?.tmuxPane ?? sessionFor(caller.sessionId)?.origin?.tmuxPane
  return pane ? [...tasks.values()].find((t) => t.pane === pane) : undefined
}

function report(task: HelperTask): string {
  const name = HELPER_NAMES[task.agent]
  const seconds = Math.round(((task.doneAt ?? Date.now()) - task.startedAt) / 1000)
  if (!task.doneAt) {
    if (!task.pane) return `${name} is still starting for task ${task.id}. Call \`task\` with this id to check again.`
    return `${name} is still working on task ${task.id} (${seconds}s so far). Its pane is open beside yours. Call \`task\` with this id to check again.`
  }
  if (!task.answer) return `${name} finished task ${task.id} in ${seconds}s, but its reply could not be read. Ask the user to look at its pane.`
  const what = task.agent === 'opencode' || task.agent === 'cursor' ? 'The end of its window' : 'Its reply'
  return `${name} finished task ${task.id} in ${seconds}s. ${what}:\n\n${task.answer}`
}

function waitFor(task: HelperTask, seconds: number): Promise<void> {
  if (task.doneAt) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      task.waiters.delete(wake)
      resolve()
    }, seconds * 1000)
    const wake = (): void => {
      clearTimeout(timer)
      resolve()
    }
    task.waiters.add(wake)
  })
}

const agentsHandler: VerbHandler<Record<string, never>> = {
  description:
    'List the AI coding agents on this computer that `delegate` can hand a task to, and the models ' +
    'each can run. Each runs on whatever the user set up for it (their own plan, key or local model).',
  inputSchema: {},
  async run() {
    const { listAgentModels } = await import('../../voice-routing/agent-models')
    const byAgent = new Map<Helper, string[]>()
    for (const option of await listAgentModels()) {
      if (!(HELPERS as readonly string[]).includes(option.harness)) continue
      const list = byAgent.get(option.harness as Helper) ?? []
      if (option.model) list.push(option.model)
      byAgent.set(option.harness as Helper, list)
    }
    if (byAgent.size === 0) return textResult('No coding agents are set up here.', true)
    const line = (h: Helper, models: string[]): string =>
      `- ${h} (${HELPER_NAMES[h]}): ${models.length ? `models ${models.slice(0, MODELS_SHOWN).join(', ')}${models.length > MODELS_SHOWN ? ` and ${models.length - MODELS_SHOWN} more` : ''}` : 'its default model'}`
    return textResult([...byAgent].map(([h, models]) => line(h, models)).join('\n'))
  }
}

// Claude Code on a local model needs a name: left empty it falls back to Claude's own default.
// Not awaited by the caller: checking a named model can eat most of the 60s an MCP call gets.
async function launch(task: HelperTask, cwd: string, parent: AgentSession | undefined, asked: string | undefined): Promise<void> {
  const { startCodeSession } = await import('../../ipc/agent-relay')
  const model = asked ?? (task.agent === 'ollama' ? await firstLocalModel() : undefined)
  const started = await startCodeSession({
    project: parent?.facts?.repo ?? parent?.label ?? basename(cwd),
    cwd,
    harness: task.agent,
    model,
    message: task.task,
    inApp: true
  })
  if (!started.ok) {
    finish(task, `Could not start ${HELPER_NAMES[task.agent]}: ${started.reason}`)
    return
  }
  task.pane = started.pane
  task.startedAt = Date.now()
  watch()
  devLog.log(`[delegate] ${task.id} ${parent?.facts?.agent ?? task.parentKey} -> ${task.agent} pane=${started.pane}`)
}

async function firstLocalModel(): Promise<string | undefined> {
  const { listAgentModels } = await import('../../voice-routing/agent-models')
  return (await listAgentModels()).find((o) => o.harness === 'ollama' && o.model)?.model
}

const delegateHandler: VerbHandler<{
  task: z.ZodString
  agent: z.ZodEnum<{ [K in Helper]: K }>
  model: z.ZodOptional<z.ZodString>
  wait: z.ZodOptional<z.ZodNumber>
}> = {
  description:
    'Hand a task to another AI coding agent (Claude Code, Codex, a local model, OpenCode or Cursor; ' +
    '`agents` lists what is set up), which opens in its own pane ' +
    'beside yours in this project and works on it. Use it for a second opinion, a review, ' +
    'research, or work that suits another model. The helper sees ONLY the `task` text, never this ' +
    'conversation, so write it to stand alone: the goal, the files, what to send back. Prefer ' +
    'read-only jobs (review, research, tests to suggest): you both work in one checkout, so two ' +
    'agents editing the same files will collide. `wait` is how many seconds to wait for the reply ' +
    `(default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}); if it is not done by then you get a task id, ` +
    'and `task` reads the reply later.',
  inputSchema: {
    task: z.string().min(1).max(20_000),
    agent: z.enum(HELPERS),
    model: z.string().max(120).optional().describe("A model name from `agents`. Leave out for that agent's default."),
    wait: z.number().int().min(0).max(WAIT_MAX_S).optional()
  },
  async run(args) {
    const calledAt = Date.now()
    const parent = callerSession(args)
    const cwd = parent?.cwd ?? args.cwd
    if (!cwd) return textResult('This session is not known to MightyMouse yet, so there is no folder to start a helper in.', true)
    if (helperOf(args)) return textResult('A helper cannot hand its task on to another agent. Do the work yourself.', true)
    const task: HelperTask = {
      id: randomUUID().slice(0, 8),
      agent: args.agent,
      task: args.task,
      pane: '',
      parentKey: callerKey(args),
      parentName: agentLabel(parent?.facts?.agent?.split('_')[0]) ?? 'another agent',
      startedAt: Date.now(),
      waiters: new Set()
    }
    tasks.set(task.id, task)
    void launch(task, cwd, parent, args.model)
    await waitFor(task, Math.max(0, (args.wait ?? WAIT_DEFAULT_S) - (Date.now() - calledAt) / 1000))
    return textResult(report(task))
  }
}

const taskHandler: VerbHandler<{ id: z.ZodString; wait: z.ZodOptional<z.ZodNumber> }> = {
  description:
    'Read a task you handed off with `delegate`: still working, or done with the helper\'s reply. ' +
    `\`wait\` seconds to wait for it to finish first (default 0, max ${WAIT_MAX_S}).`,
  inputSchema: { id: z.string().min(1).max(40), wait: z.number().int().min(0).max(WAIT_MAX_S).optional() },
  async run(args) {
    const task = tasks.get(args.id.trim())
    if (!task || task.parentKey !== callerKey(args)) return textResult(`No task "${args.id}" from this session.`, true)
    await check(task)
    await waitFor(task, args.wait ?? 0)
    return textResult(report(task))
  }
}

export function runningDelegates(parent: Caller): AgentHelper[] {
  const key = callerKey(parent)
  if (!key) return []
  return [...tasks.values()]
    .filter((t) => !t.doneAt && t.parentKey === key)
    .map((t) => ({ task: HELPER_NAMES[t.agent], doing: t.task.split('\n')[0], since: t.startedAt, agent: HELPER_ICONS[t.agent] }))
}

export const DELEGATE_HANDLERS: Record<string, VerbHandler<z.ZodRawShape>> = {
  agents: agentsHandler as unknown as VerbHandler<z.ZodRawShape>,
  delegate: delegateHandler as unknown as VerbHandler<z.ZodRawShape>,
  task: taskHandler as unknown as VerbHandler<z.ZodRawShape>
}
