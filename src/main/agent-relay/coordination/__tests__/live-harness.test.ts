import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { CoordinationService } from '../service'

// Opt in: these checks use the installed, signed-in harnesses and model quota.
// No live user session is messaged; all work and credentials are disposable.
it.skipIf(process.env.MM_COORD_LIVE_TEST !== '1')(
  'Claude startup hook and Codex exchange a fixture result through the real mailbox',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-coord-models-'))
    const service = new CoordinationService(root)
    service.setEnabled(true)
    const server = createServer((req, res) => {
      void service.handle(req, res)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as { port: number }).port
    const cli = resolve('bin/mm-coord')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MM_COORD_ROOT: root,
      MM_COORD_ENDPOINT: `http://127.0.0.1:${port}/coord/v1`
    }
    delete env.ELECTRON_RUN_AS_NODE
    const quote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'"
    const command = `MM_COORD_ROOT=${quote(root)} MM_COORD_ENDPOINT=${quote(env.MM_COORD_ENDPOINT!)} node ${quote(cli)}`
    const logs: Record<string, string> = {}
    const run = (program: string, args: string[], name: string): Promise<string> =>
      new Promise<string>((done, reject) => {
        const child = spawn(program, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let err = ''
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`${name} exceeded 120 seconds`))
        }, 120_000)
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
          logs[name] = out + '\n' + err
          code === 0 ? done(out) : reject(new Error(`${name} exited ${code}: ${err.slice(-2000)}`))
        })
      })
    const session = randomUUID()
    const nonce = randomUUID()
    writeFileSync(join(root, 'fixture.txt'), nonce)
    try {
      await run('node', [cli, 'install', '--harness', 'claude'], 'install')
      const common = [
        '-p',
        '--setting-sources',
        'project',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--allowedTools',
        'Bash',
        'Read',
        '--output-format',
        'json'
      ]
      await run(
        'claude',
        [
          ...common,
          '--session-id',
          session,
          'This is a bounded MightyMouse integration check. Do not modify any files or contact external services. Use the shared work startup instructions to claim work "fixture-check", title "Verify fixture", acceptance "Return the exact text of fixture.txt to the requesting peer". Leave it working and finish with your participant ID.'
        ],
        'claude-start'
      )
      const participant = service
        .snapshot()
        .sessions.find((s) => s.session === session && s.harness === 'claude')
      expect(participant, 'Claude must actually execute its startup hook').toBeDefined()
      expect(service.snapshot().work[0]?.id).toBe('fixture-check')
      await run(
        'codex',
        [
          'exec',
          '--ignore-user-config',
          '--ephemeral',
          '--skip-git-repo-check',
          '--json',
          '-s',
          'danger-full-access',
          `This is a bounded local integration check. Only execute the supplied mm-coord CLI; do not edit files or contact other services. Use your actual CODEX_THREAD_ID environment variable as --session, never invent one. First run ${command} join --harness codex --session "$CODEX_THREAD_ID". Then run the same CLI send '{"to":"${participant!.id}","key":"fixture-request","subject":"Verify fixture","body":"Read fixture.txt and complete this receipt with its exact text."}' --harness codex --session "$CODEX_THREAD_ID". Finish with your participant ID.`
        ],
        'codex-send'
      )
      const message = service.snapshot().messages.find((m) => m.recipient === participant!.id)
      expect(message, 'Codex must actually send the handoff').toBeDefined()
      expect(service.snapshot().sessions.find((s) => s.id === message!.sender)?.harness).toBe(
        'codex'
      )
      await run(
        'claude',
        [
          ...common,
          '--resume',
          session,
          'Continue the integration check. Read your shared inbox using the startup instructions, accept the fixture request, read fixture.txt, then complete the receipt with its exact text as the note. Complete your claimed work with fixture.txt as evidence and that text in the note. Do not modify files.'
        ],
        'claude-receive'
      )
      const result = service.snapshot()
      expect(result.messages.find((m) => m.id === message!.id)?.state).toBe('completed')
      expect(result.messages.find((m) => m.id === message!.id)?.note).toBe(nonce)
      expect(result.work[0].state).toBe('complete')
      logs.result = JSON.stringify(
        { pass: true, claudeHook: true, codexCli: true, snapshot: result },
        null,
        2
      )
    } finally {
      if (process.env.MM_COORD_EVIDENCE)
        writeFileSync(process.env.MM_COORD_EVIDENCE, JSON.stringify(logs, null, 2))
      server.closeAllConnections()
      server.close()
      service.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
  360_000
)
