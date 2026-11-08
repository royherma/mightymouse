import { CONFIG } from '../../shared/config'
import { RUN_EVENT, type RunEvent } from '../../shared/types'
import { listMcpServers, type McpServerConfig } from '../actions/plugin-loader'
import { listMcpTools, callMcpToolFull } from '../actions/mcp-runner'

const MCP_TIMEOUT_MS = CONFIG.ACTIONS.RUN_TIMEOUT_MS
export const OLLAMA_TOOL_ROUNDS_MAX = 8

export interface OllamaTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
  }
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  tool_name?: string
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>
}

interface ToolBinding {
  server: McpServerConfig
  tool: string
}

let toolCache: { tools: OllamaTool[]; bindings: Map<string, ToolBinding> } | null = null
let toolCacheAt = 0
const TOOL_CACHE_MS = 30_000

function toolKey(tool: string, taken: Map<string, ToolBinding>): string {
  const base = tool.replace(/[^a-zA-Z0-9_-]/g, '_')
  let key = base
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`
  return key
}

async function buildTools(): Promise<{ tools: OllamaTool[]; bindings: Map<string, ToolBinding> }> {
  const servers = listMcpServers()
  const tools: OllamaTool[] = []
  const bindings = new Map<string, ToolBinding>()
  for (const server of servers) {
    const infos = await listMcpTools(server, MCP_TIMEOUT_MS)
    for (const info of infos) {
      const key = toolKey(info.name, bindings)
      bindings.set(key, { server, tool: info.name })
      tools.push({
        type: 'function',
        function: {
          name: key,
          description: info.description ?? info.name,
          parameters: info.inputSchema
        }
      })
    }
  }
  return { tools, bindings }
}

export async function getOllamaTools(): Promise<{ tools: OllamaTool[]; bindings: Map<string, ToolBinding> }> {
  if (toolCache && Date.now() - toolCacheAt < TOOL_CACHE_MS) return toolCache
  toolCache = await buildTools()
  toolCacheAt = Date.now()
  return toolCache
}

export async function hasConfiguredMcpServers(): Promise<boolean> {
  return listMcpServers().length > 0
}

interface OllamaChatResponse {
  message?: { role: string; content: string; tool_calls?: OllamaChatMessage['tool_calls'] }
  done?: boolean
}

async function callOllamaChat(
  model: string,
  messages: OllamaChatMessage[],
  tools: OllamaTool[],
  think: boolean,
  numCtx: number,
  keepAlive: string,
  signal: AbortSignal,
  onPhase: (phase: string, detail: string) => void,
  onEvent?: (event: RunEvent) => void
): Promise<{ content: string; toolCalls: OllamaChatMessage['tool_calls'] }> {
  const resp = await fetch(`${CONFIG.OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      think,
      keep_alive: keepAlive,
      options: { num_ctx: numCtx },
      messages,
      tools
    })
  })
  if (!resp.ok || !resp.body) {
    const errText = resp.body ? '' : 'Ollama request failed'
    throw new Error(errText || (await resp.text().catch(() => 'Ollama request failed')))
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let lineBuf = ''
  let content = ''
  let toolCalls: OllamaChatMessage['tool_calls']

  const consumeLine = (raw: string): void => {
    const line = raw.trim()
    if (!line) return
    let e: OllamaChatResponse & { eval_count?: number; eval_duration?: number; prompt_eval_count?: number }
    try {
      e = JSON.parse(line)
    } catch {
      return
    }
    if (typeof e.message?.content === 'string' && e.message.content !== '') {
      content += e.message.content
      onPhase('Writing', '')
    }
    if (e.message?.tool_calls && e.message.tool_calls.length > 0) toolCalls = e.message.tool_calls
    if (e.done && typeof e.eval_count === 'number') {
      onEvent?.({
        kind: RUN_EVENT.usage,
        inputTokens: e.prompt_eval_count ?? 0,
        outputTokens: e.eval_count,
        durationMs: typeof e.eval_duration === 'number' ? e.eval_duration / 1e6 : undefined
      })
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    lineBuf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      consumeLine(lineBuf.slice(0, nl))
      lineBuf = lineBuf.slice(nl + 1)
    }
  }
  if (lineBuf.trim()) consumeLine(lineBuf)

  return { content, toolCalls }
}

export async function runOllamaToolLoop(opts: {
  model: string
  messages: OllamaChatMessage[]
  think: boolean
  numCtx: number
  keepAlive: string
  signal: AbortSignal
  onPhase: (phase: string, detail: string) => void
  onEvent?: (event: RunEvent) => void
}): Promise<string> {
  const { model, messages, think, numCtx, keepAlive, signal, onPhase, onEvent } = opts
  const { tools, bindings } = await getOllamaTools()
  const working = [...messages]
  let lastContent = ''

  for (let round = 0; round < OLLAMA_TOOL_ROUNDS_MAX; round++) {
    const { content, toolCalls } = await callOllamaChat(
      model,
      working,
      tools,
      think,
      numCtx,
      keepAlive,
      signal,
      onPhase,
      onEvent
    )
    lastContent = content
    if (!toolCalls || toolCalls.length === 0) break

    working.push({ role: 'assistant', content, tool_calls: toolCalls })

    for (const call of toolCalls) {
      const binding = bindings.get(call.function.name)
      const toolId = `ollama-tool-${round}-${working.length}`
      onEvent?.({ kind: RUN_EVENT.tool_start, id: toolId, name: binding?.tool ?? call.function.name, input: call.function.arguments })

      if (!binding) {
        const line = `Unknown tool: ${call.function.name}`
        onEvent?.({ kind: RUN_EVENT.tool_end, id: toolId, output: line, isError: true })
        working.push({ role: 'tool', tool_name: call.function.name, content: line })
        continue
      }

      const result = await callMcpToolFull(binding.server, binding.tool, call.function.arguments, MCP_TIMEOUT_MS)
      onEvent?.({ kind: RUN_EVENT.tool_end, id: toolId, output: result.text, isError: !result.ok })
      working.push({ role: 'tool', tool_name: call.function.name, content: result.text })
    }
  }

  return lastContent
}
