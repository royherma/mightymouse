import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { CoordinationService } from '../service'
import type { CoordinationSession } from '../../../../shared/coordination'

// A real model must see a nonce delivered by its own hook, not by the prompt.
it.skipIf(process.env.MM_COORD_ADAPTER_TEST !== '1').each(['gemini', 'opencode'])(
  '%s receives an addressed handoff in its real startup context',
  async (harness) => {
    const root = mkdtempSync(join(tmpdir(), 'mm-coord-adapter-'))
    const service = new CoordinationService(root)
    service.setEnabled(true)
    const operator = readFileSync(join(root, 'coordination-key.txt'), 'utf8')
    const nonce = randomUUID()
    const execute = service.execute.bind(service)
    service.execute = (op, args, token): unknown => {
      const result = execute(op, args, token)
      if (op === 'register' && (args as { session: string }).session !== 'fixture-sender') {
        const recipient = (result as { participant: CoordinationSession }).participant
        const sender = execute(
          'register',
          {
            project: recipient.project,
            projectName: recipient.projectName,
            session: 'fixture-sender',
            harness: 'cli',
            label: 'Fixture sender',
            cwd: root
          },
          operator
        ) as { token: string }
        execute(
          'send',
          { to: recipient.id, key: recipient.id, subject: 'Connection verification', body: nonce },
          sender.token
        )
      }
      return result
    }
    const server = createServer((req, res) => {
      void service.handle(req, res)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PWD: root,
      MM_COORD_ROOT: root,
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      MM_COORD_ENDPOINT: `http://127.0.0.1:${port}/coord/v1`
    }
    delete env.ELECTRON_RUN_AS_NODE
    const logs: Record<string, unknown> = {}
    const run = (program: string, args: string[]): Promise<string> =>
      new Promise((done, reject) => {
        const child = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('Harness timed out after 90 seconds.'))
        }, 90_000)
        child.stdout.on('data', (chunk) => {
          out += chunk
        })
        child.stderr.on('data', (chunk) => {
          err += chunk
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          logs[program] = { code, stdout: out, stderr: err }
          code === 0 ? done(out) : reject(new Error(`${program}: ${err.slice(-1200)}`))
        })
      })
    try {
      await run('node', [resolve('bin/mm-coord'), 'install', '--harness', harness])
      const prompt =
        'This is a bounded integration check. Do not use tools, edit files, or contact other services. In your shared work startup context, find the peer handoff titled Connection verification. Reply with its exact body and your participant ID. If that context is absent, say CONTEXT_MISSING. Do not invent either value.'
      const args =
        harness === 'gemini'
          ? ['-p', prompt, '--output-format', 'json']
          : [
              'run',
              '--dir',
              root,
              '--format',
              'json',
              ...(process.env.MM_COORD_OPENCODE_MODEL
                ? ['--model', process.env.MM_COORD_OPENCODE_MODEL]
                : []),
              prompt
            ]
      const output = await run(harness, args)
      const snapshot = service.snapshot()
      const participant = snapshot.sessions.find((s) => s.harness === harness)
      expect(participant, 'The real harness must execute its startup adapter').toBeDefined()
      expect(output).toContain(nonce)
      expect(output).toContain(participant!.id)
      expect(
        snapshot.messages.find((m) => m.recipient === participant!.id)?.offeredAt
      ).not.toBeNull()
      logs.result = { pass: true, harness, snapshot }
    } finally {
      if (process.env.MM_COORD_EVIDENCE)
        writeFileSync(
          process.env.MM_COORD_EVIDENCE + '-' + harness + '.json',
          JSON.stringify(logs, null, 2)
        )
      server.closeAllConnections()
      server.close()
      service.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  100_000
)
