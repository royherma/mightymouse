#!/usr/bin/env node
// npx mightymouse-code -- the "second door" from design (two doors,
// one implementation). This process holds NO server logic of its own: it is
// a stdio<->HTTP proxy in front of the exact same McpServer that runs inside
// the Electron app (src/main/agent-relay/mcp/build-server.ts), reached over
// loopback. Forking the verb logic here would violate the design's "never fork"
// rule, so every tool call this shim proxies is answered by the real Mac app.

import { execFileSync } from 'child_process'
import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync, watch } from 'fs'
import { connect } from 'net'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import {
  aiTitleFromTranscript,
  claudeTranscriptPath,
  sessionNameDir,
  syncRenameFromTranscript,
  tailFile
} from './session-name.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

// Mirrors CONFIG.AGENT_RELAY.{MCP_PORT,MCP_ROUTE,IDENTITY_HEADER} in
// src/shared/config.ts -- this file ships outside that build so the values are
// copied, not imported. Adding one here means adding it there too.
// Locked by src/main/agent-relay/mcp/__tests__/shim-port-lock.test.ts: drift
// fails that test instead of silently breaking every installed copy.
const MAC_HOST = '127.0.0.1'
const MAC_PORT = 17781
const MAC_ROUTE = '/mcp'
const MAC_PRESENCE_ROUTE = '/presence'
const MAC_SESSIONS_ROUTE = '/sessions'
const MAC_MCP_URL = `http://${MAC_HOST}:${MAC_PORT}${MAC_ROUTE}`
const IDENTITY_HEADER = 'x-mightymouse-from'
const CWD_HEADER = 'x-mightymouse-cwd'
const SESSION_HEADER = 'x-mightymouse-session'
const FACTS_HEADER = 'x-mightymouse-facts'
const ORIGIN_HEADER = 'x-mightymouse-origin'
const ATTEMPTS_HEADER = 'x-mightymouse-attempts'

/**
 * Who is running us. This process is spawned BY the agent, in the agent's cwd,
 * with the agent's env -- which is the only place that context exists: the Mac
 * sees a stateless loopback POST with no session, no cwd and no name.
 *
 * Best-effort by construction. Every part is optional and a failure here must
 * never stop a tool call: an unlabelled card still works, a crashed shim does
 * not.
 */
function deriveIdentity() {
  const { repo, branch } = whereWeAre()
  const where = repo && branch ? `${repo}/${branch}` : repo || ''

  // Several sessions in one checkout share repo/branch exactly, so `where`
  // alone makes them indistinguishable in the Mac's list. A per-session tag
  // fixes that AT CONNECT TIME -- waiting for a tool call to state a name
  // leaves every idle session anonymous, which is most of them.
  // ASCII separator on purpose: Node decodes HTTP headers as latin-1, so a
  // UTF-8 "·" reaches the Mac as "Â·" and renders that way in the list.
  const session = sessionTag()
  return [where, session].filter(Boolean).join(' - ')
}

/** The checkout this session is working in, as its two separate parts: the Mac
 *  wants them individually, and gluing them into one string here means every
 *  consumer has to guess where the repo ends and the branch starts. */
function whereWeAre() {
  let repo = ''
  try {
    repo = basename(process.cwd())
  } catch {
    // cwd can be gone (deleted directory) -- not worth a line of output.
  }

  let branch = ''
  try {
    // stdio: 'pipe' keeps git's stderr off OUR stderr -- the agent reads that
    // stream, and a "not a git repository" line there reads as a shim crash.
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }).trim()
  } catch {
    // Not a repo, no git, or a detached/empty HEAD. Repo alone is still useful.
  }

  return { repo, branch }
}

/**
 * The Mac gets a stateless loopback connection -- no cwd, no name, no pid -- so
 * anything the session list shows must be collected HERE. Env-only on purpose:
 * the model would need a multi-megabyte transcript read on every reconnect.
 */
/**
 * Which model this session is running, as the person would say it: "Opus 5",
 * not "claude-opus-5". Env first (an explicit --model or an override wins),
 * then the user's own settings file, which is where a default like "opus"
 * actually lives.
 *
 * Deliberately NOT the transcript: reading that on every reconnect is the cost
 * `sessionFacts` exists to avoid. A settings read is one small file, once.
 *
 * CLAUDE_CODE_SUBAGENT_MODEL is NOT consulted -- it is the model subagents get,
 * not this session's, and using it labels a card with a model nobody is running.
 */
function sessionModel(agent) {
  const env = process.env
  if (env.MM_AGENT_MODEL && env.MM_AGENT_MODEL.trim()) return modelLabel(env.MM_AGENT_MODEL)
  const ran = agent === 'codex' ? '' : transcriptModel()
  if (ran) return modelLabel(ran)
  const direct = env.ANTHROPIC_MODEL || env.OPENAI_MODEL
  if (direct && direct.trim()) return modelLabel(direct)
  // Each agent's own config, and ONLY its own: reading Claude's settings for a
  // Codex session would label that card "Opus 5" with total confidence and be
  // wrong, which is worse than the blank it replaces.
  const raw = agent === 'codex' ? codexConfigModel() : claudeSettingsModel()
  return raw ? modelLabel(raw) : ''
}

// Kept across reads: a tail filled by one huge tool result has no assistant line.
let lastTranscriptModel = ''

function transcriptModel() {
  const id = claudeSessionId()
  if (!id) return ''
  const tp = claudeTranscriptPath(process.env.HOME || homedir(), agentCwd(), id, claudeConfigDir())
  const lines = tp ? tailFile(tp).split('\n') : []
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"model":"')) continue
    try {
      const rec = JSON.parse(lines[i])
      const model = rec.message?.model
      if (rec.type !== 'assistant' || rec.isSidechain || typeof model !== 'string') continue
      if (model.startsWith('<')) continue
      lastTranscriptModel = model
      break
    } catch {
      continue
    }
  }
  return lastTranscriptModel
}

/** `~/.claude/settings.json` -> `"model": "opus"`. Best-effort by construction:
 *  no file, bad JSON, or no key all mean "no model reported", never a crash. */
function claudeSettingsModel() {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    return typeof raw?.model === 'string' ? raw.model.trim() : ''
  } catch {
    return ''
  }
}

/** Codex's `model_reasoning_effort`, the same fact `CLAUDE_EFFORT` carries. */
function codexEffort(agent) {
  if (agent !== 'codex') return ''
  try {
    const text = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    return text.match(/^\s*model_reasoning_effort\s*=\s*["']([^"']+)["']/m)?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/** `~/.codex/config.toml` -> `model = "gpt-5.6-terra"`. Matched with a regex
 *  rather than parsed: one scalar off the top level of a TOML file does not
 *  justify a dependency in a shim that must stay installable anywhere, and
 *  `^model` anchored per line will not match `model_reasoning_effort`. */
function codexConfigModel() {
  try {
    const text = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8')
    return text.match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * The model as a person writes it. Aliases ("opus") and full ids
 * ("claude-opus-5-20260114") both arrive here and must land on the same words,
 * because a card showing "opus" beside one showing the full id reads as two
 * different models.
 *
 * Unknown strings pass through trimmed rather than being forced into a family:
 * a model we have never heard of should read as itself, never as "Unknown".
 */
function modelLabel(raw) {
  const s = String(raw).trim()
  const k = s.toLowerCase()
  // Ordered: the first family whose name appears wins, and the version is read
  // off the same string so a new point release needs no change here.
  const families = [
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['haiku', 'Haiku'],
    ['fable', 'Fable'],
    ['gpt', 'GPT'],
    ['o3', 'o3'],
    ['gemini', 'Gemini'],
    ['grok', 'Grok']
  ]
  for (const [needle, name] of families) {
    if (!k.includes(needle)) continue
    // The version is whatever follows the family name: "opus-5" -> 5,
    // "gpt-5.6" -> 5.6, "gpt-4o" -> 4o. Anthropic writes a minor with a DASH
    // ("haiku-4-5" is 4.5), so a second number is joined with a dot -- but only
    // when it is not a date, which is how "opus-5-20260114" would read as 5.20.
    const after = k.slice(k.indexOf(needle) + needle.length)
    const version = after.match(/^[-_]?(\d+(?:\.\d+)?[a-z]?)(?:-(\d{1,2})(?![\d]))?/)
    if (!version) return name
    const number = version[2] ? `${version[1]}.${version[2]}` : version[1]
    // A trailing WORD is a codename the vendor uses in its own UI ("gpt-5.6-terra",
    // "gpt-5-codex"), so keeping it makes the card say what the agent's own status
    // bar says. A trailing date is not a codename and is dropped by the \d guard.
    const code = after.slice(version[0].length).match(/^-([a-z]{3,})$/)
    const label = code ? `${number} ${code[1][0].toUpperCase()}${code[1].slice(1)}` : number
    return `${name} ${label}`
  }
  return s
}

/**
 * Which agent spawned us, when it did not say so itself.
 *
 * `AI_AGENT` is a cmux convention, so it is set for Claude Code under cmux and
 * for nothing else -- Codex exports no agent variable at all, which is why its
 * sessions arrived with no harness, no logo and no model while looking, from
 * the relay's side, exactly like a session from a shim too old to report one.
 *
 * The process tree is the answer instead: an agent SPAWNS this shim, so it is
 * always an ancestor. Cheap and bounded -- four `ps` reads, each on one pid,
 * only when the env said nothing.
 */
function detectAgent() {
  // Ordered by specificity: Cursor embeds its own copy of Codex, so a match on
  // "codex" must win over the editor that is hosting it -- the model is the
  // fact worth having, and "Cursor" alone would name the window, not the agent.
  const AGENTS = [
    ['@openai/codex', 'codex'],
    ['/codex', 'codex'],
    ['claude', 'claude-code'],
    ['gemini', 'gemini'],
    ['opencode', 'opencode']
  ]
  for (const line of ancestorCommands()) {
    for (const [needle, agent] of AGENTS) {
      if (line.includes(needle)) return agent
    }
  }
  return ''
}

/** Our ancestors' command lines, nearest first. Best-effort: a failed `ps`
 *  means one unlabelled session, never a crash. */
function ancestorCommands() {
  const lines = []
  let pid = process.ppid
  for (let depth = 0; depth < 4 && pid > 1; depth += 1) {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000
      }).trim()
      if (!out) break
      lines.push(out)
      pid = Number.parseInt(out, 10)
      if (!Number.isFinite(pid)) break
    } catch {
      break
    }
  }
  return lines
}

function sessionFacts() {
  const env = process.env
  const { repo, branch } = whereWeAre()
  // Resolved once: the model lookup needs to know which agent this is, and
  // detecting twice means two walks of the process tree per connect.
  const agent = env.AI_AGENT || detectAgent()
  const facts = {
    repo,
    branch,
    pid: process.pid,
    // The AGENT, not this proxy: the Mac kills a session by signalling this,
    // and `pid` above is the shim, whose death would leave `claude` running
    // headless. The shim is spawned directly by the agent, the same assumption
    // detectAgent() already walks.
    agentPid: process.ppid,
    // Set by the cmux wrapper rather than by Claude Code itself, so a plain
    // `claude` in a terminal simply has none of these three.
    agent,
    effort: env.CLAUDE_EFFORT || codexEffort(agent),
    entrypoint: env.CLAUDE_CODE_ENTRYPOINT || '',
    model: sessionModel(agent),
    // Carried back so a subject the agent declared before the Mac app was last
    // relaunched is still on its row -- the agent has no way to know the app
    // restarted, so nothing would ever say it again.
    tldr: publishedTldr(sessionId())
  }
  // Empty values would render as blank columns that look like a bug rather than
  // an absent field, so they never leave here.
  for (const [k, v] of Object.entries(facts)) {
    if (v === '' || v === undefined) delete facts[k]
  }
  return facts
}

/**
 * A name if the host set one, else a short session id. Claude Code exports the
 * id on every session; the 8-char head is enough to tell two panes apart and
 * keeps the label readable on a phone.
 */
// Last-known, because the title line can sit outside the transcript tail a later read sees.
const aiTitle = { id: '', title: '' }

function sessionTag() {
  const env = process.env
  const named = env.CLAUDE_SESSION_NAME || env.MM_AGENT_NAME || env.CMUX_TAB_NAME
  if (named && named.trim()) return named.trim().slice(0, 40)

  const id = sessionId()

  // A session name set by a naming hook. Claude Code's `sessionTitle` output
  // reaches its own UI only -- no hook can export a variable into the session's
  // environment -- so a hook that wants its name to survive into child processes
  // publishes it here. Without this every pane in one checkout reads as raw hex.
  const published = publishedName(id)
  if (published) return published
  if (aiTitle.id === id && aiTitle.title) return aiTitle.title.slice(0, 40)

  return id ? id.slice(0, 8) : ''
}

/**
 * This session's id, as the host exported it. Sent to the Mac in its own header
 * because it is the one thing about a session that NEVER changes: the displayed
 * name does (a naming hook publishes the real one seconds after this process
 * booted), so the Mac cannot use the name to recognise a reconnecting session.
 */
function sessionId() {
  return claudeSessionId() || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || codexPaneSessionId()
}

let codexPaneId = ''
let codexPaneCheckedAt = 0

function codexPaneSessionId() {
  if (!process.env.TMUX_PANE || Date.now() - codexPaneCheckedAt < 5000) return codexPaneId
  codexPaneCheckedAt = Date.now()
  try {
    const open = execFileSync('lsof', ['-nP', '-a', '-p', String(process.ppid), '-Fn', '-d', '^mem'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000
    })
    const ids = [...new Set(open.split('\n').flatMap((line) => {
      const id = line.match(/^n.*\/rollout-[^\n]*-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i)?.[1]
      return id ? [id] : []
    }))]
    codexPaneId = ids.length === 1 ? ids[0] : ''
  } catch {}
  return codexPaneId
}

function claudeConfigDir() {
  const home = process.env.HOME || homedir()
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim()
  return dir ? resolve(home, dir.replace(/^~(?=\/|$)/, home)) : join(home, '.claude')
}

// The Mac app reads transcripts itself and cannot see this env, so a non-default account dir is recorded for it.
function recordConfigDir() {
  const home = process.env.HOME || homedir()
  const dir = claudeConfigDir()
  if (dir === join(home, '.claude')) return
  const list = join(home, '.claude', '.mm-config-dirs')
  try {
    const known = readFileSync(list, 'utf8').split('\n')
    if (known.includes(dir)) return
  } catch {}
  try {
    mkdirSync(dirname(list), { recursive: true })
    appendFileSync(list, `${dir}\n`)
  } catch {}
}

function hostSessionPath() {
  return join(claudeConfigDir(), 'sessions', `${process.ppid}.json`)
}

let paneSessionId = process.env.CLAUDE_CODE_SESSION_ID || ''

// /clear and /resume move the pane to a new id; the env keeps the one this process booted with.
function claudeSessionId() {
  if (!paneSessionId) return ''
  try {
    const id = JSON.parse(readFileSync(hostSessionPath(), 'utf8')).sessionId
    if (typeof id === 'string' && id) paneSessionId = id
  } catch {
    // Missing or half-written session file. The last id read stands.
  }
  return paneSessionId
}

/** Where a naming hook publishes session names. Watched, not just read: the
 *  name usually lands AFTER this process started (a hook needs the first
 *  prompt), so reading once pins the session to its raw id for its whole life. */
function nameDir() {
  return sessionNameDir(process.env.HOME || homedir())
}

/** Optional by design: no file just means no naming hook is installed. */
function publishedName(id) {
  if (!id) return ''
  try {
    return readFileSync(join(nameDir(), id), 'utf8').trim().slice(0, 40)
  } catch {
    // No hook, no file, unreadable -- all mean "fall back to the id".
    return ''
  }
}

/** The subject this session last declared, written by the Mac app's `recap`
 *  verb one directory along from the names. Read, not watched: unlike a name it
 *  only ever changes because THIS session called the verb, and the Mac already
 *  holds it live from that call. */
function publishedTldr(id) {
  if (!id) return ''
  try {
    const dir = join(process.env.HOME || homedir(), '.claude', '.session-tldr')
    return readFileSync(join(dir, id), 'utf8').trim().slice(0, 120)
  } catch {
    return ''
  }
}

/** Where presence failures are recorded. Next to `.session-names/` because the
 *  shim already depends on that dir existing, and it is the one path that is the
 *  same on every machine an agent runs on. */
function presenceLogPath() {
  return join(process.env.HOME || homedir(), '.claude', '.mm-presence.log')
}

// Trimmed to the last 200 lines whenever it crosses this. A presence log that
// grows without a bound outlives the question it was written to answer.
const PRESENCE_LOG_MAX_BYTES = 128 * 1024

/**
 * The one thing presence never had: a trace. A shim that fails to register is
 * otherwise indistinguishable from one that was never started -- no exit code,
 * no stderr (the agent reads that), and nothing on the Mac, which by definition
 * only learns about agents that DID dial in.
 *
 * Best-effort exactly like presence itself: every failure here is swallowed, so
 * a full disk or a read-only home can never take down the agent's tool path.
 */
function presenceLog(event, detail) {
  try {
    const path = presenceLogPath()
    // Trim BEFORE appending so a single oversized run cannot leave the file
    // permanently above the cap.
    try {
      if (statSync(path).size > PRESENCE_LOG_MAX_BYTES) {
        const kept = readFileSync(path, 'utf8').split('\n').slice(-200).join('\n')
        truncateSync(path, 0)
        appendFileSync(path, kept)
      }
    } catch {
      // No file yet, or it vanished under us. Either way the append below is
      // still the right next move.
    }
    const row = {
      t: new Date().toISOString(),
      pid: process.pid,
      session: sessionId() || null,
      event,
      ...detail
    }
    appendFileSync(path, JSON.stringify(row) + '\n')
  } catch {
    // Presence is best-effort and so is its log. Never throw into the caller.
  }
}

/** The working directory, so a card says WHERE the agent is running. */
function agentCwd() {
  try {
    return process.cwd()
  } catch {
    return ''
  }
}

/**
 * A `claude -p` the tooling spawned for itself -- session naming, recaps -- not
 * a pane a human is sitting at. These live 8-10s and used to claim a real row
 * for that whole life, so the phone showed agents the user never started.
 *
 * Same list as the relay hooks (~/.claude/hooks/mm-relay-{active,busy,stop}.sh),
 * which already skip these; the shim was the one path missing the guard.
 */
function isUtilitySession(cwd) {
  if (process.env.MM_INTERNAL_RUN) return true
  const home = process.env.HOME || homedir()
  if (cwd === home + '/.claude/.namer-scratch' || cwd === home + '/.claude') return true
  return /\/T\/tmp\./.test(cwd)
}

/**
 * Where to CLICK to see this agent again -- the "take me to the session"
 * address, captured here because only this process (spawned by the agent,
 * in its env) can see it. The Mac gets a stateless loopback connection with
 * none of this.
 *
 * Same contract as sessionFacts(): every field optional, a failure here never
 * blocks a tool call, and an env var this host doesn't set is a normal
 * missing field, not an error.
 */
function deriveOrigin() {
  const env = process.env
  const origin = {
    cmuxWorkspaceId: env.CMUX_WORKSPACE_ID || '',
    cmuxTabId: env.CMUX_TAB_ID || '',
    cmuxBundleId: env.CMUX_BUNDLE_ID || '',
    tmuxPane: env.TMUX_PANE || '',
    // The server socket path, e.g. "/private/tmp/tmux-502/default,3005,4" --
    // targets the right tmux SERVER, not just the right pane id within it.
    tmuxSocket: env.TMUX ? env.TMUX.split(',')[0] : '',
    termProgram: env.TERM_PROGRAM || '',
    hostBundleId: env.__CFBundleIdentifier || ''
  }
  for (const [k, v] of Object.entries(origin)) {
    if (v === '') delete origin[k]
  }
  return Object.keys(origin).length > 0 ? origin : undefined
}

// Turning the relay off closes its listener, so "app closed" and "switch off"
// are the same silence on the wire and one message has to cover both -- naming
// the switch first, because an app someone just tried to use is usually open.
const MESSAGES = {
  appClosed:
    'MightyMouse is not taking calls from your agents.\n' +
    'Open MightyMouse on your Mac and turn on "Code agent relay" in Settings, then try again.',
  // The relay answered, so the switch is on and the app is up -- whatever broke
  // is inside this call, and repeating either instruction would be a wrong lead.
  relayUnresponsive:
    'MightyMouse is running and the relay is on, but this call did not go through.\n' +
    'Try again. If it keeps happening, restart MightyMouse.',
  // Something that is not MightyMouse holds the port. Telling this person to
  // flip a switch would waste their time -- the switch is already on and is
  // failing to bind. The port is not negotiable (the shim dials it blind), so
  // the only fix is freeing it, which means naming it.
  portBusy:
    `Another program on your Mac is using port ${MAC_PORT}, which MightyMouse needs.\n` +
    `Quit that program and try again. To find it, run:  lsof -nP -iTCP:${MAC_PORT} -sTCP:LISTEN`,
  unreachable: (detail) => `Could not reach MightyMouse on your Mac.\n${detail}`
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

// Which of THREE situations we are in. The SDK retries a failed POST as an SSE
// GET and the wrapped error loses the original status, so the error text cannot
// tell them apart.
//
// A bare socket probe cannot either, and the way it failed was backwards. It
// assumed an accepted connection meant "app up, switch off" -- but turning the
// switch off CLOSES the listener (stopAgentRelayMcp), so a relay-off Mac accepts
// nothing at all and looks exactly like a closed app. The one thing that DOES
// accept a connection while the relay refuses calls is a foreign process holding
// the port, which is precisely the case that got told to flip an already-on
// switch. Asking for a route only the relay serves separates them:
//   'closed'  nothing listening        -> app closed, or the switch is off
//   'live'    our /sessions answers    -> relay is up; this call failed for another reason
//   'foreign' something else answers   -> the port is taken and the relay cannot bind
function probeRelay() {
  return new Promise((resolve) => {
    const socket = connect({ host: MAC_HOST, port: MAC_PORT })
    let body = ''
    // Whether the port ever accepted us. Once it has, silence is no longer
    // evidence of an empty port -- a listener that speaks something other than
    // HTTP accepts and then says nothing, and calling that 'closed' would send
    // someone to reopen an app while the real squatter keeps the port.
    let connected = false
    const done = (answer) => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(500)
    socket.once('timeout', () => done(connected ? 'foreign' : 'closed'))
    socket.once('error', () => done(connected ? 'foreign' : 'closed'))
    socket.once('connect', () => {
      connected = true
      socket.write(
        `GET ${MAC_SESSIONS_ROUTE} HTTP/1.1\r\nHost: ${MAC_HOST}:${MAC_PORT}\r\nConnection: close\r\n\r\n`
      )
    })
    socket.on('data', (chunk) => {
      body += chunk
      // The status line is all this needs and it arrives in the first packet,
      // so there is no reason to wait for a body that may never close.
      if (!body.includes('\r\n')) return
      const status = /^HTTP\/1\.\d (\d{3})/.exec(body)
      if (!status) return done('foreign')
      // Only our listener serves this route, so a 200 is the one reply that
      // proves MightyMouse is on the other end. Anything else answering here
      // is some other server that happens to hold the port.
      done(status[1] === '200' ? 'live' : 'foreign')
    })
    // Hung up without a parseable status line. Resolving after a real answer is
    // a no-op (the promise is already settled), so this only speaks for the case
    // where nothing usable arrived.
    socket.once('close', () => done(connected ? 'foreign' : 'closed'))
  })
}

// No raw transport text on this path: the probe already established which of the
// situations it is, and "fetch failed" only muddies a clear answer.
async function describeConnectFailure() {
  const state = await probeRelay()
  if (state === 'foreign') return MESSAGES.portBusy
  if (state === 'live') return MESSAGES.relayUnresponsive
  return MESSAGES.appClosed
}

/** Holds a socket for this process's whole life, which is exactly the agent
 *  session's life. Hand-written rather than fetch() so it can unref and never
 *  reject into the tool path -- a failure here must not break a tool call. */
function holdPresence(cwd, onRegistered = () => {}) {
  let socket = null
  let stopped = false
  // What the Mac currently believes we are called. A reopen is only worth the
  // churn when this actually changed.
  let sent = ''
  let sentId = ''
  let sentModel = ''
  // Consecutive opens that never reached the write. Sent on the next successful
  // header so the Mac can tell "connected first try" from "connected after 40
  // retries" -- a high count is the fingerprint of a flaky path, and it is
  // invisible from the Mac side otherwise.
  let failedAttempts = 0
  // Set the moment a socket writes its headers, cleared on close. Without it an
  // error arriving after a successful register would count as a failed attempt.
  let registered = false

  const open = () => {
    if (stopped) return
    // A throw here (not a socket error -- connect() validates its arguments)
    // would take out presence for the process's whole life with no trace, which
    // is candidate (c) in the design's list.
    try {
      openSocket()
    } catch (err) {
      failedAttempts += 1
      presenceLog('open-threw', { attempt: failedAttempts, message: String(err?.message || err) })
      const timer = setTimeout(open, 3000)
      timer.unref()
    }
  }

  const openSocket = () => {
    socket = connect({ host: MAC_HOST, port: MAC_PORT }, () => {
      // Re-derived per socket, not captured once: a naming hook needs the first
      // prompt, so it can publish this session's name AFTER the shim booted.
      // Deriving once pinned a long-running session to the raw id it had at
      // launch, and this socket -- not the MCP call -- is what fills the list.
      const identity = deriveIdentity()
      sent = identity
      const headers = [
        `GET ${MAC_PRESENCE_ROUTE} HTTP/1.1`,
        `Host: ${MAC_HOST}:${MAC_PORT}`,
        'Connection: keep-alive'
      ]
      if (identity) headers.push(`${IDENTITY_HEADER}: ${identity}`)
      if (cwd) headers.push(`${CWD_HEADER}: ${cwd}`)
      // Sent separately from the identity above, which contains this id but
      // stops containing it the moment a hook publishes a name. The Mac joins a
      // reconnect to its old row on THIS value, so it has to travel on its own.
      const id = sessionId()
      sentId = id
      if (id) headers.push(`${SESSION_HEADER}: ${id}`)
      // One header rather than one per fact: these are display details that
      // change shape over time, and adding a field should not mean touching the
      // Mac's header parsing. JSON.stringify cannot emit a CR or LF unescaped,
      // so this can never inject a header line of its own.
      const facts = sessionFacts()
      sentModel = facts.model || ''
      headers.push(`${FACTS_HEADER}: ${JSON.stringify(facts)}`)
      // Same shape as FACTS_HEADER above: one JSON header carrying an optional
      // "where do I click" address rather than one header per field.
      const origin = deriveOrigin()
      if (origin) headers.push(`${ORIGIN_HEADER}: ${JSON.stringify(origin)}`)
      // How many opens it took to get here. Zero on the common path; anything
      // else is the only evidence the Mac ever gets that this session had a
      // hard time arriving.
      if (failedAttempts > 0) headers.push(`${ATTEMPTS_HEADER}: ${failedAttempts}`)
      socket.write(headers.join('\r\n') + '\r\n\r\n')
      if (failedAttempts > 0) {
        presenceLog('registered', { afterAttempts: failedAttempts, identity })
      }
      failedAttempts = 0
      registered = true
      onRegistered()
    })
    // Never keep the process alive for presence alone: when the agent closes
    // stdio this process must still exit, and an active socket would block that.
    socket.unref()
    // Drain the app's "ok" response. Unread bytes in the readable buffer block
    // node's 'end'/'close' events entirely, so without this the socket dies
    // silently on an app restart and the reconnect below never runs.
    socket.on('data', () => {})
    // Still swallowed for the process -- presence must never crash the agent --
    // but no longer invisible. ECONNREFUSED here every 3s is what "the app is
    // closed" looks like; anything else is a real finding.
    socket.on('error', (err) => {
      if (stopped || renaming) return
      presenceLog('socket-error', {
        code: err?.code || null,
        message: String(err?.message || err),
        target: `${MAC_HOST}:${MAC_PORT}`,
        attempt: failedAttempts + 1,
        registered
      })
    })
    // The app quitting drops this socket. Reconnect so that reopening the app
    // restores the count without the user restarting their agent.
    socket.on('close', () => {
      const wasRenaming = renaming
      // A close before the headers went out is a failed attempt; one after is
      // the app going away, which the retry below already handles.
      if (!registered && !wasRenaming) failedAttempts += 1
      else if (registered && !wasRenaming) presenceLog('dropped', { identity: sent })
      registered = false
      renaming = false
      socket = null
      if (stopped) return
      // A rename reopens NOW, not after the backoff: the Mac only rejoins a
      // reconnect to its existing row inside a 30s grace window, and a visible
      // 3s gap is the difference between a row relabelling and a row vanishing.
      const timer = setTimeout(open, wasRenaming ? 0 : 3000)
      timer.unref()
    })
  }

  // True only between our own destroy() and the close it causes, so the handler
  // above can tell "we are renaming ourselves" from "the app went away".
  let renaming = false

  /** Reopen if -- and only if -- our name actually changed. deriveIdentity()
   *  shells out to git, so this is debounced rather than run per fs event. */
  let pending = null
  const recheck = () => {
    pending = null
    if (stopped) return
    const id = sessionId()
    if (id !== followed) followTranscript(id)
    if (!socket) return
    const ran = process.env.MM_AGENT_MODEL ? '' : transcriptModel()
    const modelChanged = ran !== '' && modelLabel(ran) !== sentModel
    if (deriveIdentity() === sent && id === sentId && !modelChanged) return
    renaming = true
    socket.destroy()
  }
  const codexPoll = process.env.TMUX_PANE && !process.env.CLAUDE_CODE_SESSION_ID ? setInterval(recheck, 5000) : null
  codexPoll?.unref()

  // The directory, not the file: at this point our name file usually does not
  // exist yet, and watching a missing path throws. A create arrives as
  // 'rename', not 'change', so the event type is deliberately ignored.
  // mkdir so a machine with no naming hook still gets /rename from the
  // transcript watcher -- that is the path that ships to every install.
  let watcher = null
  try {
    mkdirSync(nameDir(), { recursive: true })
    watcher = watch(nameDir(), () => {
      if (pending) return
      pending = setTimeout(recheck, 250)
      pending.unref()
    })
    watcher.on('error', (err) => {
      presenceLog('watcher-error', { message: String(err?.message || err), dir: nameDir() })
    })
    watcher.unref()
  } catch (err) {
    presenceLog('no-name-watch', { message: String(err?.message || err), dir: nameDir() })
  }

  let transcriptWatcher = null
  let dirWatcher = null
  let followed = ''
  const followTranscript = (id) => {
    followed = id
    transcriptWatcher?.close()
    dirWatcher?.close()
    transcriptWatcher = null
    dirWatcher = null
    if (!id) return
    const home = process.env.HOME || homedir()
    const tp = claudeTranscriptPath(home, cwd, id, claudeConfigDir())
    const pull = (full) => {
      try {
        syncRenameFromTranscript({ home, sessionId: id, transcriptPath: tp, full })
      } catch {
        // Missing transcript = no /rename yet, not a reason to drop presence.
      }
      const title = aiTitleFromTranscript(full ? tailFile(tp, 8 * 1024 * 1024) : tailFile(tp))
      if (title) Object.assign(aiTitle, { id, title })
      recheck()
    }
    pull(true)
    const attachTranscript = () => {
      if (transcriptWatcher || !tp) return
      try {
        transcriptWatcher = watch(tp, () => {
          if (pending) return
          pending = setTimeout(() => pull(false), 250)
          pending.unref()
        })
        transcriptWatcher.on('error', () => {
          transcriptWatcher = null
        })
        transcriptWatcher.unref()
      } catch {
        presenceLog('no-transcript-watch', { path: tp })
      }
    }
    attachTranscript()
    if (!transcriptWatcher && tp) {
      try {
        dirWatcher = watch(dirname(tp), (_event, filename) => {
          if (filename === basename(tp)) attachTranscript()
        })
        dirWatcher.unref()
      } catch {
        // No Claude Code projects dir yet. Identity stands.
      }
    }
  }
  recordConfigDir()
  followTranscript(sessionId())

  let hostWatcher = null
  try {
    hostWatcher = watch(dirname(hostSessionPath()), (_event, filename) => {
      if (filename !== basename(hostSessionPath()) || pending || sessionId() === followed) return
      pending = setTimeout(recheck, 250)
      pending.unref()
    })
    hostWatcher.on('error', () => {
      hostWatcher = null
    })
    hostWatcher.unref()
  } catch {
    // No session files on this host. The id it booted with stands.
  }

  open()
  return () => {
    stopped = true
    if (codexPoll) clearInterval(codexPoll)
    watcher?.close()
    hostWatcher?.close()
    transcriptWatcher?.close()
    dirWatcher?.close()
    socket?.destroy()
  }
}

async function main() {
  const cwd = agentCwd()

  /** One connected Client, or null while the app is away. The agent session
   *  outlives any number of app restarts, so this is a slot to refill -- not a
   *  resource whose loss ends the process. */
  let upstream = null
  let upstreamSessionId = ''

  const connectUpstream = async () => {
    // Derived per connection, not once at startup: a naming hook can publish the
    // session's name AFTER the shim booted (it needs the first prompt), and this
    // process outlives app restarts. Deriving once pinned every long-running
    // session to the raw id it had at launch. Cost is one small file read.
    const identity = deriveIdentity()
    const id = sessionId()
    const client = new Client({ name: 'mightymouse-code-shim', version: '0.2.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(MAC_MCP_URL), {
      // A header, not a tool arg: the arg belongs to the agent, and overwriting a
      // stated `from` with a derived one would lose the better value. The Mac
      // uses this only when the agent named nothing.
      requestInit: {
        headers: {
          ...(identity ? { [IDENTITY_HEADER]: identity } : {}),
          ...(cwd ? { [CWD_HEADER]: cwd } : {}),
          // recap/busy address a session row and refuse without this; presence
          // sending it is not enough -- verbs read the POST's own headers.
          ...(id ? { [SESSION_HEADER]: id } : {}),
          // Rides every verb call, not just presence: origin.mint() runs off this
          // request's headers (see http-listener.ts), so a notify/ask/approve/show
          // that never opened a presence socket still gets its "go to" address.
          ...(deriveOrigin() ? { [ORIGIN_HEADER]: JSON.stringify(deriveOrigin()) } : {})
        }
      }
    })
    // Dropping the slot rather than exiting is the whole point: the next call
    // reconnects, so quitting the app is a pause, never the end of the session.
    client.onclose = () => {
      if (upstream === client) upstream = null
    }
    await client.connect(transport)
    upstream = client
    upstreamSessionId = id
    return client
  }

  // A relay that is off/starting at BOOT used to exit(1) here, which is
  // terminal: MCP servers only spawn at session start, so every agent alive at
  // that moment stayed off the roster until the user restarted it. The relay
  // being down is a pause, exactly as it is mid-session -- `relay` below already
  // reconnects on the next call, and holdPresence retries on its own timer.
  try {
    await connectUpstream()
  } catch {
    // Not fail(): stderr here would surface a scary boot error for a condition
    // that heals itself the moment the app comes up.
    presenceLog('upstream-unavailable-at-boot', {})
  }

  // Runs even when the connect above failed, so the session claims its row as
  // soon as the app returns rather than staying invisible for its whole life.
  // Utility sessions still proxy tool calls -- they just never claim a row.
  let listedTools = null
  const toolNames = (result) => result.tools.map((t) => t.name).sort().join(',')
  // The agent only lists tools at session start; an app update adding a tool stays invisible without this.
  const announceNewTools = async () => {
    if (listedTools === null) return
    try {
      const names = toolNames(await relay((c) => c.listTools()))
      if (names === listedTools) return
      listedTools = names
      await proxy.sendToolListChanged()
    } catch {}
  }

  const releasePresence = isUtilitySession(cwd) ? () => {} : holdPresence(cwd, () => void announceNewTools())

  const proxy = new Server({ name: 'mightymouse-code', version: '0.2.0' }, { capabilities: { tools: { listChanged: true } } })

  // Without this the upstream connection outlives the client that spawned us.
  const shutdown = async () => {
    const client = upstream
    upstream = null
    releasePresence()
    try {
      if (client) {
        client.onclose = undefined
        await client.close()
      }
    } catch {
      // Already gone. Nothing to clean up and nobody to tell.
    }
    process.exit(0)
  }
  // Signals only. Exiting on a stdin 'end' event kills replies that are still in
  // flight (piped input hits EOF immediately), and the stdio transport already
  // tears down when its stream closes.
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  /** A dropped app shows up as a rejected fetch, not as onclose, so both paths
   *  land here. Either way it means the same thing: the socket we had is stale,
   *  and the app may well be back by now. */
  const isLostApp = (err) => {
    const code = err?.code ?? err?.cause?.code
    return code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed|socket hang up|not connected/i.test(String(err?.message ?? err))
  }

  // Reconnect-and-retry once, so an app restart mid-session costs the agent a
  // few hundred ms instead of every later tool call in that session. Only after
  // the SECOND failure is the app genuinely unreachable and worth reporting.
  const relay = async (call) => {
    try {
      if (upstream && upstreamSessionId !== sessionId()) {
        const previous = upstream
        upstream = null
        previous.onclose = undefined
        await previous.close()
      }
      if (!upstream) await connectUpstream()
      return await call(upstream)
    } catch (err) {
      if (!isLostApp(err)) throw err
      upstream = null
      try {
        await connectUpstream()
      } catch {
        return { content: [{ type: 'text', text: await describeConnectFailure() }], isError: true }
      }
      return await call(upstream)
    }
  }

  proxy.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await relay((c) => c.listTools())
    listedTools = toolNames(result)
    return result
  })
  proxy.setRequestHandler(CallToolRequestSchema, async (req) => relay((c) => c.callTool(req.params)))

  await proxy.connect(new StdioServerTransport())
}

main().catch((err) => {
  fail(MESSAGES.unreachable(err instanceof Error ? err.message : String(err)))
})
