import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import {
  COORDINATION,
  coordinationSchemas,
  registrationSchema,
  COORDINATION_TOOL_DESCRIPTIONS,
  type CoordinationMessage,
  type CoordinationOp,
  type CoordinationSnapshot
} from '../../../shared/coordination'
import { CoordinationStore, CoordinationError } from './store'
import { relayRequestStore } from '../store'

const HTTP_STATUS = {
  invalid: 400,
  unauthorized: 401,
  conflict: 409,
  not_found: 404,
  backpressure: 429
} as const
const envelope = z.object({ op: z.string(), args: z.unknown().default({}) }).strict()
const MAX_REQUEST_MS = 5_000
const OPERATOR_OPS = new Set(['health', 'enable', 'overview', 'register'])

export type HandoffDelivery = 'woken' | 'after-turn' | 'next-turn' | 'closed'
type DeliverHandoff = (
  store: CoordinationStore,
  message: CoordinationMessage
) => { delivery: HandoffDelivery; message: CoordinationMessage }

export class CoordinationService {
  private store: CoordinationStore | null = null
  private deliver: DeliverHandoff | null = null
  private secret: string
  private enabledPath: string
  constructor(private root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const keyPath = join(root, COORDINATION.keyFile)
    try {
      writeFileSync(keyPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    chmodSync(keyPath, 0o600)
    this.secret = readFileSync(keyPath, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(this.secret))
      throw new Error('The local coordination key is invalid.')
    this.enabledPath = join(root, COORDINATION.enabledFile)
  }
  private db(): CoordinationStore {
    return (this.store ??= new CoordinationStore(join(this.root, COORDINATION.database)))
  }
  isEnabled(): boolean {
    return existsSync(this.enabledPath) && readFileSync(this.enabledPath, 'utf8').trim() === '1'
  }
  setEnabled(enabled: boolean): CoordinationSnapshot {
    writeFileSync(this.enabledPath, enabled ? '1' : '0', { mode: 0o600 })
    return this.snapshot()
  }
  snapshot(): CoordinationSnapshot {
    return { ...this.db().snapshot(), enabled: this.isEnabled() }
  }
  setDelivery(fn: DeliverHandoff): void {
    this.deliver = fn
  }
  unreadFor(harnessSession: string): CoordinationMessage[] {
    return this.isEnabled() ? this.db().unreadFor(harnessSession) : []
  }
  close(): void {
    this.store?.close()
    this.store = null
  }
  renameProject(id: string, name: string): CoordinationSnapshot {
    this.db().operatorProject(id, { name })
    return this.snapshot()
  }
  archiveProject(id: string, archived: boolean): CoordinationSnapshot {
    this.db().operatorProject(id, { archived })
    return this.snapshot()
  }
  private isOperator(token: string): boolean {
    return (
      /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(this.secret))
    )
  }
  execute(op: string, args: unknown, token: string): unknown {
    if (this.isOperator(token)) {
      if (op === 'health')
        return { version: COORDINATION.version, enabled: this.isEnabled(), status: 'reachable' }
      if (op === 'enable')
        return this.setEnabled(z.object({ enabled: z.boolean() }).strict().parse(args).enabled)
      if (op === 'overview') return this.snapshot()
      if (op === 'register' && this.isEnabled()) {
        const registration = registrationSchema.parse(args)
        const sessionToken = createHmac('sha256', this.secret)
          .update(
            JSON.stringify([registration.project, registration.harness, registration.session])
          )
          .digest('hex')
        return {
          participant: this.db().register(registration, sessionToken),
          token: sessionToken,
          version: COORDINATION.version
        }
      }
    } else if (OPERATOR_OPS.has(op) || (!this.isEnabled() && !this.db().knows(token))) {
      throw new CoordinationError(
        'unauthorized',
        'This agent is linked to a different MightyMouse build. In MightyMouse, open Code, then Work, and press Set up.'
      )
    }
    if (!this.isEnabled())
      throw new CoordinationError('conflict', 'Turn on shared work in MightyMouse before joining.')
    if (!Object.hasOwn(coordinationSchemas, op))
      throw new CoordinationError('invalid', 'Unknown coordination operation.')
    if (op === 'project_delete') this.requireApproval(args)
    const result = this.db().call(op as CoordinationOp, args, token)
    if (op !== 'send' || !this.deliver) return result
    const delivered = this.deliver(this.db(), result as CoordinationMessage)
    return { ...delivered.message, delivery: delivered.delivery }
  }
  /** Removing a project destroys every handoff and every piece of evidence it holds, so an
   *  agent cannot do it alone: it must carry the id of an `approve` request the operator
   *  actually answered yes to, naming this same project. The id is minted by the relay and
   *  resolved from the phone, so it cannot be invented by the caller. */
  private requireApproval(args: unknown): void {
    const parsed = coordinationSchemas.project_delete.safeParse(args)
    if (!parsed.success) throw new CoordinationError('invalid', 'Send a project and an approval.')
    const request = relayRequestStore.get(parsed.data.approval)
    if (!request || request.verb !== 'approve' || request.status !== 'resolved')
      throw new CoordinationError('unauthorized', 'Ask the operator to approve this removal first.')
    if (request.response?.approved !== true)
      throw new CoordinationError('unauthorized', 'The operator did not approve this removal.')
    if (!JSON.stringify(request.params).includes(parsed.data.project))
      throw new CoordinationError('unauthorized', 'That approval was given for something else.')
  }
  mcp(token: string): McpServer {
    const server = new McpServer({
      name: 'mightymouse-coordination',
      version: String(COORDINATION.version)
    })
    for (const [op, description] of Object.entries(COORDINATION_TOOL_DESCRIPTIONS)) {
      const operation = op as Exclude<CoordinationOp, 'heartbeat'>
      server.registerTool(
        `coord_${op}`,
        { description, inputSchema: coordinationSchemas[operation].shape },
        async (args: Record<string, unknown>) => {
          try {
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(this.execute(op, args, token)) }
              ]
            }
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: error instanceof Error ? error.message : 'Coordination failed.'
                }
              ]
            }
          }
        }
      )
    }
    return server
  }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, body: unknown): void => {
      if (!res.headersSent)
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      // The native UI uses IPC. Browser pages have no reason to call this control surface.
      if (
        req.headers.origin ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
      ) {
        json(403, { error: 'Only local agent clients may use this endpoint.' })
        return
      }
      if (req.method !== 'POST') {
        json(405, { error: 'Use POST.' })
        return
      }
      const auth = req.headers.authorization ?? ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      if (!token)
        throw new CoordinationError('unauthorized', 'A local client credential is required.')
      if (!req.headers['content-type']?.startsWith('application/json'))
        throw new CoordinationError('invalid', 'Send a JSON request.')
      req.setTimeout(MAX_REQUEST_MS, () => req.destroy())
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > COORDINATION.maxBodyBytes) {
          json(413, { error: 'The handoff is too large. Send references instead.' })
          return
        }
        chunks.push(buffer)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (req.url === COORDINATION.mcpRoute) {
        // Validate identity before exposing tools; discovery is not an authorization bypass.
        this.execute('status', {}, token)
        const server = this.mcp(token)
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        res.on('close', () => {
          void transport.close()
          void server.close()
        })
        await server.connect(transport)
        await transport.handleRequest(req, res, body)
        return
      }
      const input = envelope.parse(body)
      json(200, { ok: true, result: this.execute(input.op, input.args, token) })
    } catch (error) {
      const status =
        error instanceof CoordinationError
          ? HTTP_STATUS[error.code]
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 500
      json(status, {
        ok: false,
        error: error instanceof Error ? error.message : 'Coordination failed.'
      })
    }
  }
}
