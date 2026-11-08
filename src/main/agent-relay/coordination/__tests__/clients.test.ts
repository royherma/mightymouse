import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { CoordinationService } from '../service'
import { COORDINATION_TOOL_DESCRIPTIONS } from '../../../../shared/coordination'
import type {
  CoordinationSession,
  CoordinationMessage,
  CoordinationSnapshot
} from '../../../../shared/coordination'
type Replies = {
  join: { participant: CoordinationSession }
  send: CoordinationMessage
  inbox: CoordinationMessage[]
  ack: CoordinationMessage
  status: CoordinationSnapshot
}
type Call = <K extends keyof Replies>(
  harness: string,
  session: string,
  op: K,
  args?: object
) => Promise<Replies[K]>

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
const script = resolve('bin/mm-coord')

async function fixture(): Promise<{
  root: string
  service: CoordinationService
  run: (args: string[], input?: string) => Promise<string>
  call: Call
}> {
  const root = mkdtempSync(join(tmpdir(), 'mm-coord-clients-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const service = new CoordinationService(root)
  service.setEnabled(true)
  cleanup.push(() => service.close())
  const server = createServer((req, res) => {
    void service.handle(req, res)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanup.push(() => {
    server.closeAllConnections()
    server.close()
  })
  const port = (server.address() as { port: number }).port
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    MM_COORD_ROOT: root,
    MM_COORD_ENDPOINT: `http://127.0.0.1:${port}/coord/v1`
  }
  const run = (args: string[], input = ''): Promise<string> =>
    new Promise<string>((done, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.stderr.on('data', (chunk) => {
        err += chunk
      })
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? done(out) : reject(new Error(err || out))))
      child.stdin.end(input)
    })
  const call: Call = async <K extends keyof Replies>(
    harness: string,
    session: string,
    op: K,
    args: object = {}
  ): Promise<Replies[K]> =>
    JSON.parse(await run([op, JSON.stringify(args), '--harness', harness, '--session', session]))
  return { root, service, run, call }
}

it('delivers all twelve directed harness pairs through real CLI processes without consuming reads', async () => {
  const { call } = await fixture()
  const harnesses = ['claude', 'codex', 'gemini', 'opencode']
  const agents = await Promise.all(
    harnesses.map(async (h) => ({ h, ...(await call(h, h, 'join')).participant }))
  )
  for (const sender of agents)
    for (const recipient of agents) {
      if (sender.id === recipient.id) continue
      const message = await call(sender.h, sender.h, 'send', {
        to: recipient.id,
        key: `${sender.h}-${recipient.h}`,
        subject: 'Fixture check',
        body: 'Unicode handoff: ไทย ✓'
      })
      const inbox = await call(recipient.h, recipient.h, 'inbox')
      expect(inbox.find((m: CoordinationMessage) => m.id === message.id)?.body).toBe(
        'Unicode handoff: ไทย ✓'
      )
      expect(
        (await call(recipient.h, recipient.h, 'inbox')).some(
          (m: CoordinationMessage) => m.id === message.id
        )
      ).toBe(true)
      await call(recipient.h, recipient.h, 'ack', {
        message: message.id,
        state: 'completed',
        note: 'Fixture received'
      })
    }
  expect((await call('claude', 'claude', 'status')).messages).toHaveLength(12)
}, 30_000)

it('preserves unrelated configuration, installs idempotently, and uses each timeout unit', async () => {
  const { root, run } = await fixture()
  for (const harness of ['claude', 'codex', 'gemini']) {
    const path = join(root, `.${harness}`, harness === 'codex' ? 'hooks.json' : 'settings.json')
    mkdirSync(join(root, `.${harness}`), { recursive: true })
    const original = {
      custom: 'keep',
      hooks: {
        SessionStart: [
          { matcher: 'existing', hooks: [{ type: 'command', command: 'echo existing' }] }
        ]
      }
    }
    writeFileSync(path, JSON.stringify(original))
    await run(['install', '--harness', harness])
    const first = readFileSync(path, 'utf8')
    await run(['install', '--harness', harness])
    expect(readFileSync(path, 'utf8')).toBe(first)
    const config = JSON.parse(first)
    expect(config.custom).toBe('keep')
    expect(config.hooks.SessionStart[0]).toEqual(original.hooks.SessionStart[0])
    expect(config.hooks.SessionStart[1].hooks[0].timeout).toBe(harness === 'gemini' ? 5000 : 5)
    await run(['install', '--harness', harness, '--check'])
    await run(['install', '--harness', harness, '--uninstall'])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(original)
  }
  await run(['install', '--harness', 'opencode'])
  await run(['install', '--harness', 'opencode', '--check'])
  await run(['install', '--harness', 'opencode', '--uninstall'])
}, 20_000)

it('executes startup, tool-boundary and idle hooks and proxies every MCP tool', async () => {
  const { root, call, run, service } = await fixture()
  const payload = (event: string): string =>
    JSON.stringify({ session_id: 'hooked', cwd: root, hook_event_name: event })
  const startup = JSON.parse(await run(['hook', '--harness', 'claude'], payload('SessionStart')))
  expect(startup.hookSpecificOutput.additionalContext).toContain('Your participant ID')
  const recipient = service.snapshot().sessions[0]
  await call('codex', 'sender', 'join')
  await call('codex', 'sender', 'send', {
    to: recipient.id,
    key: 'hook',
    subject: 'Check',
    body: 'hook-nonce'
  })
  const prompt = JSON.parse(await run(['hook', '--harness', 'claude'], payload('UserPromptSubmit')))
  expect(prompt.hookSpecificOutput.additionalContext).toContain('hook-nonce')
  expect(service.snapshot().messages[0].state).toBe('pending')
  expect(JSON.parse(await run(['hook', '--harness', 'claude'], payload('PostToolUse')))).toEqual({})
  await run(['hook', '--harness', 'claude'], payload('Stop'))
  expect(service.snapshot().sessions.find((s) => s.id === recipient.id)?.state).toBe('idle')
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' }
      }
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'coord_inbox', arguments: {} } }
  ]
  const output = await run(
    ['mcp', '--harness', 'claude', '--session', 'hooked'],
    requests.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )
  const replies = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(replies.find((r) => r.id === 2)?.result?.tools).toHaveLength(
    Object.keys(COORDINATION_TOOL_DESCRIPTIONS).length
  )
  expect(replies.find((r) => r.id === 3)?.result?.content[0].text).toContain('hook-nonce')
}, 15_000)
