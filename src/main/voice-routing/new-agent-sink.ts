// new-agent-sink.ts — "start a new agent on this" as a routing destination.
//
// The existing agent sinks answer "which running agent should get this". This
// answers the case they cannot: the text is a NEW task, and handing it to an
// agent mid-way through something else buries it. So when Jev scores the text
// as a fresh task, the card offers one extra row per project — start a session
// there and send the transcript as its first prompt.
//
// WHERE IT RUNS is the user's pick, not Jev's: the harness is a preference
// about their setup (which app they live in), not a judgement about the text.
// Hence the hover menu on the row rather than a sixth Jev question.
//
// The working directory comes from the agents ALREADY running in that project —
// a project is only offered when something is running there, so there is always
// a real cwd to inherit and nothing has to be configured up front.
import { execFile } from 'child_process'
import { existsSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { resolveBinary } from '../platform'
import { cmuxPath } from '../agent-relay/origin-resolver'
import { devLog } from '../../shared/env'
import { projectIdentityPhrase, type AgentSink } from './agent-sinks'
import type { JevSink } from './jev-client'
import type { AgentHarness, MightyProject } from '../../shared/types'
import { mightyProjectForCwd } from '../../shared/relay-sessions'
import { PLAN_ARGS, reasoningArgs, type ReasoningEffort } from '../../shared/model-sources'
import { codexRelayArgs } from '../agent-relay/mcp-clients'

/** Same bound, and for the same reason, as the origin resolver's: a wedged
 *  tmux/cmux daemon must never freeze the click that triggered the spawn. */
const SPAWN_TIMEOUT_MS = 5000

/** Prefix keeping these ids out of the `agent:` space — an id here names a
 *  session that does not exist yet, so resolving it as an agent would fail. */
const NEW_AGENT_PREFIX = 'new-agent:'

export interface NewAgentSink extends JevSink {
  kind: 'new-agent'
  /** Project to start in — the display name, matching the agent sinks'. */
  project: string
  /** Absolute working directory, inherited from a running agent there. */
  cwd: string
  /** Bundle id of the terminal the sampled session runs in, '' when it reported
   *  none. The fallback host when tmux is absent, and the source of the name
   *  the card shows so a click can say where it lands. */
  hostBundleId: string
}

/** Why a spawn produced no session. `''` used to mean all of these AND a
 *  success whose pane id was not captured, so the card said "Couldn't reach"
 *  for a session that had actually started. */
export type NewAgentFailure = 'no-terminal' | 'cli-missing' | 'spawn-failed'

/** A started session, or the reason there isn't one. `pane` is '' whenever the
 *  host cannot hand back a handle — that is a session we cannot re-focus, never
 *  a failure. */
export type NewAgentResult =
  | { ok: true; pane: string; session: string; host: string; tab: string }
  | { ok: false; reason: NewAgentFailure; detail: string }

export function isNewAgentSinkId(id: string): boolean {
  return id.startsWith(NEW_AGENT_PREFIX)
}

/**
 * One "start a new agent" sink per project: every project with agents running,
 * then every saved project folder, most recently worked in first.
 */
export function collectNewAgentSinks(
  agentSinks: readonly AgentSink[],
  projects: readonly MightyProject[] = []
): NewAgentSink[] {
  const byProject = new Map<string, AgentSink[]>()
  for (const sink of agentSinks) {
    const list = byProject.get(sink.project)
    if (list) list.push(sink)
    else byProject.set(sink.project, [sink])
  }

  const candidates: Array<{ project: string; cwd: string; hostBundleId: string; lastAt: number; agents: number }> = []
  const coveredFolders = new Set<string>()
  for (const [project, sinks] of byProject) {
    const cwd = sinks[0].session.cwd ?? ''
    if (cwd === '') continue
    const owner = mightyProjectForCwd(cwd, [...projects])
    if (owner?.repoFolder) coveredFolders.add(owner.repoFolder)
    candidates.push({
      project,
      cwd,
      hostBundleId: sinks[0].session.origin?.hostBundleId ?? '',
      lastAt: Math.max(...sinks.map((s) => lastActiveAt(s.session))),
      agents: sinks.length
    })
  }
  for (const p of projects) {
    if (p.archived || !p.repoFolder || coveredFolders.has(p.repoFolder)) continue
    if (byProject.has(p.name) || !existsSync(p.repoFolder)) continue
    candidates.push({ project: p.name, cwd: p.repoFolder, hostBundleId: '', lastAt: repoTouchedAt(p.repoFolder), agents: 0 })
  }

  return candidates
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((c) => ({
      kind: 'new-agent' as const,
      id: `${NEW_AGENT_PREFIX}${c.project}`,
      label: `New agent in ${c.project}`,
      hostBundleId: c.hostBundleId,
      description:
        `Start a fresh coding agent in ${c.project}${projectIdentityPhrase(c.project, c.cwd)} and give it this text as its first ` +
        `instruction. For a new task, rather than one the agents already running there ` +
        `are part-way through. ${recencyPhrase(c.lastAt, c.agents)}`,
      project: c.project,
      cwd: c.cwd
    }))
}

function lastActiveAt(session: AgentSink['session']): number {
  return session.lastActivityAt ?? session.busySince ?? session.lastTurnEndedAt ?? session.since
}

/** The git index is rewritten on every add/commit/checkout, so its mtime is a free "last worked here". */
function repoTouchedAt(folder: string): number {
  try {
    return statSync(join(folder, '.git', 'index')).mtimeMs
  } catch {
    return 0
  }
}

function recencyPhrase(lastAt: number, agents: number): string {
  const running = agents === 0 ? 'No agents running there.' : `${agents} agent${agents === 1 ? '' : 's'} there.`
  if (lastAt === 0) return running
  const hours = (Date.now() - lastAt) / 3_600_000
  const ago = hours < 1 ? 'in the last hour' : hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)} days ago`
  return `The user last worked in this project ${ago}. ${running}`
}

function run(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: SPAWN_TIMEOUT_MS }, (err) => {
      if (err) devLog.warn(`[routing] new-agent spawn failed: ${cmd}`, err.message)
      resolve(!err)
    })
  })
}

/** Same spawn, but the stdout is the answer: the new window's pane id, which is
 *  the only handle back to the session 'goto' has to focus. */
function capture(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: SPAWN_TIMEOUT_MS }, (err, stdout) => {
      if (err) devLog.warn(`[routing] new-agent spawn failed: ${cmd}`, err.message)
      resolve(err ? null : stdout)
    })
  })
}

/** The CLI each harness starts with. The transcript is passed as the first
 *  argument, which both CLIs take as the opening prompt.
 *
 * `tmux` is the "just a shell" option and deliberately has NO cli: it used to
 * map to 'claude', so picking "Terminal" silently started Claude instead of a
 * terminal — the thing the label promised was the one thing it did not do. An
 * empty cli means the window opens on the user's shell with the text waiting as
 * a typed line, which is what the row says it does. */
const HARNESS_BINARY: Record<AgentHarness, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor-agent',
  tmux: ''
}

/**
 * The harnesses that can actually start on this Mac.
 *
 * Reuses resolveBinary — the same deterministic lookup the backend runner and
 * ffmpeg detection use, cache and all — rather than a second probe. The check
 * already happened inside startNewAgent, but only AFTER a click, where its one
 * outcome was a devLog nobody sees; hoisting it here is what turns it into a
 * menu that tells the truth.
 *
 * 'tmux' needs no cli of its own, so it is offered whenever tmux itself is
 * present — which every other harness needs too, since they all run in a tmux
 * window.
 */
export function defaultCodeUiHarness(): AgentHarness | undefined {
  for (const h of ['claude', 'codex'] as const) {
    if (availableHarnesses().includes(h)) return h
  }
  return availableHarnesses()[0]
}

export function availableHarnesses(): AgentHarness[] {
  // tmux is no longer a gate, only the preferred host: without it a session
  // opens in the user's own terminal instead. It used to return [] here, which
  // rendered a new-agent row with zero buttons and no way to learn why.
  const hosted = resolveBinary('tmux') !== null || hasTerminalHost()
  if (!hosted) return []
  return (Object.keys(HARNESS_BINARY) as AgentHarness[]).filter((h) => {
    const cli = HARNESS_BINARY[h]
    return cli === '' || resolveBinary(cli) !== null
  })
}

/** Whether a plain terminal is available to open a window in. `open -b` needs a
 *  bundle id, but `open -a Terminal` always exists on macOS, so the shell path
 *  has a floor that cannot be missing. */
function hasTerminalHost(): boolean {
  return process.platform === 'darwin'
}

export async function startNewAgent(
  sink: NewAgentSink,
  text: string,
  harness: AgentHarness,
  opts?: { reveal?: boolean; model?: string; resume?: string; env?: Record<string, string>; think?: boolean; effort?: ReasoningEffort; readDirs?: string[]; plan?: boolean }
): Promise<NewAgentResult> {
  // '' is the plain-shell harness, which needs no cli of its own. Checked
  // before the host: a missing CLI is the same answer whichever window we
  // would have opened, and saying so beats opening an empty terminal.
  const cli = HARNESS_BINARY[harness]
  const binary = cli === '' ? '' : resolveBinary(cli)
  if (binary === null) {
    devLog.warn(`[routing] new-agent spawn: ${cli} is not installed`)
    return { ok: false, reason: 'cli-missing', detail: cli }
  }

  const prompt = text === '' ? [] : harness === 'opencode' ? ['--prompt', text] : [text]
  const resume = resumeArgs(harness, opts?.resume ?? '')
  const envArgs = Object.entries(opts?.env ?? {}).map(([k, v]) => `${k}=${v}`)
  const launcher = envArgs.length > 0 ? ['/usr/bin/env', ...envArgs] : []
  const effort = harness === 'tmux' ? [] : reasoningArgs(harness, opts?.effort, opts?.think)
  const relay = harness === 'codex' ? codexRelayArgs() : []
  const plan = opts?.plan === true && harness !== 'tmux' ? PLAN_ARGS[harness] ?? [] : []
  // The = form: `--add-dir <dir>` takes several values and swallows the prompt after it.
  const readable = harness === 'claude' ? (opts?.readDirs ?? []).map((dir) => `--add-dir=${dir}`) : []
  const command = binary === '' ? [] : [...launcher, binary, ...relay, ...resume, ...readable, ...modelArgs(harness, opts?.model ?? ''), ...effort, ...plan, ...prompt]

  const tmux = resolveBinary('tmux')
  if (!tmux) return startInTerminal(sink, command, opts)

  // Its OWN session: a bare `new-window` lands in whichever session tmux used last, on top of another agent.
  const session = `mm-${sink.project.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`
  // The text goes as one argv entry — never interpolated into a shell string,
  // which would let a dictated quote or backtick run as a command.
  const spawnArgs = ['new-session', '-d', '-s', session, '-c', sink.cwd, '-P', '-F', '#{pane_id}']
  const pane = await capture(tmux, [...spawnArgs, ...command], sink.cwd)
  if (pane === null) return { ok: false, reason: 'spawn-failed', detail: 'tmux' }

  const paneId = pane.trim()

  // A plain shell got no argv to carry the text, so it is typed into the pane
  // instead — with `-l` (literal) and NO Enter, because this window is a shell
  // prompt: submitting would run the dictation as a command. The words sit
  // there as an editable line, which is the point of choosing Terminal.
  if (binary === '' && paneId !== '') {
    await run(tmux, ['send-keys', '-t', paneId, '-l', text], sink.cwd)
  }

  if (opts?.reveal === false) {
    return { ok: true, pane: paneId, session, host: '', tab: '' }
  }
  const shown = await showSession(tmux, session, sink.cwd)
  return { ok: true, pane: paneId, session, ...shown }
}

export async function showHiddenSession(pane: string, socket: string | undefined, cwd: string): Promise<boolean> {
  const tmux = resolveBinary('tmux')
  if (!tmux) return false
  const sock = socket ? ['-S', socket] : []
  const session = (await capture(tmux, [...sock, 'display', '-p', '-t', pane, '#{session_name}'], cwd))?.trim()
  if (!session) return false
  await run(tmux, [...sock, 'set-option', '-w', '-u', '-t', pane, 'window-size'], cwd)
  return (await showSession(tmux, session, cwd, socket)).host !== ''
}

async function showSession(
  tmux: string,
  session: string,
  cwd: string,
  socket?: string
): Promise<{ host: string; tab: string }> {
  const sock = socket ? ` -S ${shellQuote(socket)}` : ''
  const attach = `${shellQuote(tmux)}${sock} attach -t ${shellQuote(session)}`
  const cli = cmuxPath()
  if (cli) {
    const out = await capture(
      cli,
      ['new-workspace', '--name', session, '--cwd', cwd, '--command', attach, '--focus', 'true'],
      cwd
    )
    const tab = out?.match(/workspace:\d+/)?.[0] ?? ''
    if (tab !== '') {
      await run('open', ['-a', 'cmux'], cwd)
      return { host: 'cmux', tab }
    }
  }
  if (await openInDefaultTerminal(attach, cwd)) return { host: 'Terminal', tab: '' }
  return { host: '', tab: '' }
}

/**
 * The no-tmux rung: open a window in the terminal the user actually runs and
 * start the CLI there.
 *
 * The host comes from the sampled session's own origin — the shim already
 * reports `__CFBundleIdentifier` for every session, so the terminal the user
 * lives in is known without asking or detecting. `open -b` is the same verb
 * `tryHostApp` uses to RAISE a session (origin-resolver.ts), applied to
 * starting one.
 *
 * No pane comes back: a terminal app hands out no handle, so the result
 * carries `pane: ''`. That is a session we cannot re-focus later, which is why
 * the window is opened in front rather than detached — you see it start, and
 * the card knows not to offer a "Go to it" it could not honour.
 */
async function startInTerminal(
  sink: NewAgentSink,
  command: string[],
  opts?: { reveal?: boolean }
): Promise<NewAgentResult> {
  // A shell needs no command; a CLI is started with the transcript as argv so a
  // dictated quote or backtick can never be re-parsed by the shell.
  const script =
    command.length === 0
      ? `cd ${shellQuote(sink.cwd)}`
      : `cd ${shellQuote(sink.cwd)} && ${command.map(shellQuote).join(' ')}`

  // -b targets the user's own terminal; Terminal.app is the floor every Mac
  // has. Both open the window in front, which is the whole point of this rung.
  const opened =
    sink.hostBundleId !== '' &&
    (await run('open', ['-b', sink.hostBundleId, '--args', script], sink.cwd))
  if (opts?.reveal === false) {
    return { ok: true, pane: '', session: '', host: '', tab: '' }
  }
  if (!opened && !(await openInDefaultTerminal(script, sink.cwd))) {
    return { ok: false, reason: 'no-terminal', detail: sink.hostBundleId }
  }
  return { ok: true, pane: '', session: '', host: opened ? '' : 'Terminal', tab: '' }
}

/** Terminal.app via osascript: the one host that reliably accepts a command to
 *  run, where `open -b --args` is ignored by most terminals. */
async function openInDefaultTerminal(script: string, cwd: string): Promise<boolean> {
  const osa = `tell application "Terminal" to do script ${JSON.stringify(script)}
tell application "Terminal" to activate`
  return run('osascript', ['-e', osa], cwd)
}

function resumeArgs(harness: AgentHarness, sessionId: string): string[] {
  if (sessionId === '') return []
  if (harness === 'claude') return ['--resume', sessionId]
  if (harness === 'codex') return ['resume', sessionId]
  if (harness === 'cursor') return ['--resume', sessionId]
  return []
}

function modelArgs(harness: AgentHarness, model: string): string[] {
  if (model === '') return []
  if (harness === 'claude' || harness === 'cursor') return ['--model', model]
  if (harness === 'codex' || harness === 'opencode') return ['-m', model]
  return []
}

export async function projectRootFor(cwd: string): Promise<string> {
  const out = await capture(resolveBinary('git') ?? 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  const common = out?.trim() ?? ''
  if (!common.endsWith('/.git')) return cwd
  const root = dirname(common)
  return existsSync(root) ? root : cwd
}

/** Single-quote for a shell command line, the POSIX way: close, escape, reopen. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
