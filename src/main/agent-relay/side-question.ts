import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BACKENDS } from '../backend/adapters'
import { shell } from '../platform'
import { agentVendor } from '../../shared/relay-status'
import type { AgentSession } from './mcp/http-listener'
import { sessionAccountHome } from './session-transcript'

const TIMEOUT_MS = 120_000
const MAX_QUESTION_CHARS = 4000

export type SideAnswer = { ok: true; answer: string } | { ok: false; reason: string }

const framed = (question: string): string =>
  [
    'Side question from the user while you keep working. Answer it briefly from what you already know in this conversation.',
    'Do not continue the task, do not plan next steps, and do not use tools.',
    '',
    question
  ].join('\n')

// A forked, tool-less, unsaved copy of the session answers, so the live agent is never typed into or interrupted.
export function askSideQuestion(session: AgentSession, question: string): Promise<SideAnswer> {
  const asked = question.trim().slice(0, MAX_QUESTION_CHARS)
  const bin = BACKENDS.claude.binPath ?? ''
  const account = sessionAccountHome(session)
  if (!asked) return Promise.resolve({ ok: false, reason: 'Type a question after /btw.' })
  const vendor = agentVendor(session.facts?.agent)
  if (vendor && vendor !== 'claude') {
    return Promise.resolve({ ok: false, reason: 'Side questions work with Claude sessions only.' })
  }
  if (!bin || !session.sessionId || account?.backend !== 'claude') {
    return Promise.resolve({ ok: false, reason: 'This conversation is not saved yet. Try again in a moment.' })
  }
  const env: NodeJS.ProcessEnv = { ...shell.env() }
  if (account.dir === join(homedir(), '.claude')) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = account.dir
  const cwd = session.cwd && existsSync(session.cwd) ? session.cwd : homedir()
  const args = [
    '-p', framed(asked),
    '--resume', session.sessionId,
    '--fork-session',
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    '--output-format', 'text'
  ]
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, reason: 'Could not start Claude to answer.' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const answer = out.trim()
      if (code === 0 && answer) resolve({ ok: true, answer })
      else resolve({ ok: false, reason: err.trim().split('\n').pop() || 'No answer came back. Try again.' })
    })
  })
}
