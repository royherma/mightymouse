import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolveBinary, shell } from '../platform'
import { devLog } from '../../shared/env'
import type { ActionRunResult } from '../../shared/action-engine'

interface McpTextContent {
  type: 'text'
  text: string
}

interface McpCallToolResult {
  content?: Array<McpTextContent | { type: string }>
  isError?: boolean
}

const MCP_LINE_MAX_CHARS = 200

export interface McpToolCall {
  command: string
  args?: string[]
  tool: string
  arguments?: Record<string, string>
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}

async function withMcpClient<T>(
  server: { command: string; args?: string[] },
  timeoutMs: number,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const binPath = resolveBinary(server.command) ?? server.command
  const client = new Client({ name: 'mightymouse-mcp', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({
    command: binPath,
    args: server.args ?? [],
    env: shell.env() as Record<string, string>
  })
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('mcp-timeout')), timeoutMs)
  })
  try {
    await Promise.race([client.connect(transport), timeout])
    return await Promise.race([fn(client), timeout])
  } finally {
    try {
      await transport.close()
    } catch {
      /* already closed */
    }
  }
}

export async function listMcpTools(
  server: { command: string; args?: string[] },
  timeoutMs: number
): Promise<McpToolInfo[]> {
  try {
    const result = await withMcpClient(server, timeoutMs, (client) => client.listTools())
    return result.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  } catch (err) {
    devLog.warn('[mcp-runner] listMcpTools failed:', (err as Error).message)
    return []
  }
}

export async function callMcpTool(call: McpToolCall, timeoutMs: number): Promise<ActionRunResult> {
  try {
    const result = (await withMcpClient({ command: call.command, args: call.args }, timeoutMs, (client) =>
      client.callTool({ name: call.tool, arguments: call.arguments ?? {} })
    )) as McpCallToolResult
    const first = (result.content ?? []).find((c): c is McpTextContent => c.type === 'text')
    const line = first ? first.text.slice(0, MCP_LINE_MAX_CHARS) : 'Done.'
    return { ok: result.isError !== true, line }
  } catch (err) {
    devLog.warn('[mcp-runner] callMcpTool failed:', (err as Error).message)
    return { ok: false, line: 'MCP tool failed.' }
  }
}

export interface McpToolCallResult {
  ok: boolean
  text: string
}

export async function callMcpToolFull(
  server: { command: string; args?: string[] },
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<McpToolCallResult> {
  try {
    const result = (await withMcpClient(server, timeoutMs, (client) =>
      client.callTool({ name: tool, arguments: args })
    )) as McpCallToolResult
    const text = (result.content ?? [])
      .filter((c): c is McpTextContent => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
    return { ok: result.isError !== true, text: text || 'Done.' }
  } catch (err) {
    const message = (err as Error).message
    devLog.warn('[mcp-runner] callMcpToolFull failed:', message)
    return { ok: false, text: `MCP tool failed: ${message}` }
  }
}
