import { describe, it, expect, vi } from 'vitest'

const bin = vi.hoisted(() => ({ path: '/usr/local/bin/agy' as string | null }))

vi.mock('../../platform', () => ({
  resolveBinary: vi.fn(() => bin.path),
  resolveClaude: vi.fn(() => '/usr/local/bin/claude'),
  resolveCodex: vi.fn(() => '/usr/local/bin/codex'),
  resolveOpencode: vi.fn(() => '/usr/local/bin/opencode'),
  resolveGemini: vi.fn(() => '/usr/local/bin/gemini'),
  clearBinaryCache: vi.fn()
}))
vi.mock('../local-models', () => ({
  isOllamaRunning: vi.fn(),
  listLocalModels: vi.fn(),
  getLocalModelCapabilities: vi.fn(),
  getOllamaContextLength: vi.fn(async () => 0)
}))
vi.mock('../mlx-models', () => ({ isMlxRunning: vi.fn(), listMlxModels: vi.fn(), getMlxModelCapabilities: vi.fn() }))

import { BACKENDS, BinaryNotFoundError } from '../adapters'
import { CONFIG } from '../../../shared/config'

const agy = BACKENDS.antigravity
const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const ctx = (over: object = {}) => ({
  runDir: '/tmp/run',
  promptFile: '/tmp/run/prompt.txt',
  outFile: '/tmp/run/out.txt',
  addDirs: [],
  attachments: [],
  shellQuote: sq,
  shellFileText: (p: string) => `"$(cat ${sq(p)})"`,
  ...over
})

// Real `agy -p ... --output-format stream-json` lines (init trimmed).
const ID = '"conversation_id":"8bc1acc1"'
const REAL = {
  init: `{"event":"init",${ID},"init":{"model":"gemini-3.8-flash-low","cwd":"/tmp/x","tools":["run_command"]}}`,
  user: `{"event":"step_update","step_update":{${ID},"step_index":0,"state":"DONE","step_type":"user_input"}}`,
  toolStart: `{"event":"step_update","step_update":{${ID},"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}`,
  toolDone: `{"event":"step_update","step_update":{${ID},"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.27,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"output":"Command exited with code 0.\\n\\nCommand output:\\nhi\\r\\n"}}}`,
  toolFailed: `{"event":"step_update","step_update":{${ID},"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.25,"tool_info":{"name":"run_command","parameters":{"CommandLine":"ls /definitely-missing-dir"},"output":"Created At: 2026-11-21T09:22:16+07:00\\nCompleted At: 2026-11-21T09:22:16+07:00\\nCommand exited with code 1.\\n\\nCommand output:\\nls: /definitely-missing-dir: No such file or directory\\r\\n"}}}`,
  delta1: `{"event":"step_update","step_update":{${ID},"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"done."}}`,
  delta2: `{"event":"step_update","step_update":{${ID},"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":3.3}}`,
  result: `{"event":"result","result":{${ID},"status":"SUCCESS","response":"done.\\n","duration_seconds":6.5,"num_turns":1}}`
}
const MODELS_OUT = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n'

describe('antigravity buildCommand', () => {
  it('uses the default model, stream-json, and skips permission prompts', () => {
    const cmd = agy.buildCommand!(ctx())
    expect(cmd).toBe(
      `'/usr/local/bin/agy' -p "$(cat '/tmp/run/prompt.txt')" --output-format stream-json --model ${sq(CONFIG.ANTIGRAVITY_MODEL)} --dangerously-skip-permissions --disable-slash-commands`
    )
  })

  it('a picked model beats the fast model, which beats the default', () => {
    expect(agy.buildCommand!(ctx({ fast: true }))).toContain(`--model ${sq(CONFIG.ANTIGRAVITY_FAST_MODEL)}`)
    expect(agy.buildCommand!(ctx({ fast: true, modelOverride: 'claude-sonnet-4-6' }))).toContain("--model 'claude-sonnet-4-6'")
  })

  it('throws a not-installed error when agy is missing', () => {
    bin.path = null
    try {
      expect(() => agy.buildCommand!(ctx())).toThrow(BinaryNotFoundError)
    } finally {
      bin.path = '/usr/local/bin/agy'
    }
  })
})

describe('antigravity parseOutput / explainFailure', () => {
  const run = Object.values(REAL).join('\n')

  it('takes the final response from the result event, not every streamed message', () => {
    const early = `{"event":"step_update","step_update":{${ID},"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Let me run that."}}`
    expect(agy.parseOutput([REAL.init, early, REAL.toolStart, REAL.toolDone, REAL.delta1, REAL.delta2, REAL.result].join('\n'))).toBe('done.')
  })

  it('falls back to the streamed reply when the run ended without a result', () => {
    expect(agy.parseOutput([REAL.init, REAL.delta1, REAL.delta2].join('\n'))).toBe('done.')
  })

  it('returns raw stdout when nothing parses, so the error is still visible', () => {
    expect(agy.parseOutput('agy: not signed in')).toBe('agy: not signed in')
  })

  it('explains a failed result with its error, and says nothing for a successful one', () => {
    expect(agy.explainFailure!(run)).toBeNull()
    const failed = '{"event":"result","result":{"status":"ERROR","error":"quota exhausted"}}'
    expect(agy.explainFailure!([REAL.init, failed].join('\n'))).toBe('quota exhausted')
  })
})

describe('antigravity parsePhase / parseStep', () => {
  it('names each phase from the real events', () => {
    expect(agy.parsePhase(REAL.init)).toEqual({ phase: 'Starting', detail: '' })
    expect(agy.parsePhase(REAL.toolStart)).toEqual({ phase: 'Running command', detail: 'echo hi' })
    expect(agy.parsePhase(REAL.delta1)).toEqual({ phase: 'Writing', detail: '' })
    expect(agy.parsePhase(REAL.user)).toBeNull()
    expect(agy.parsePhase('not json')).toBeNull()
  })

  it('a file read is Reading; any other tool is named', () => {
    const tool = (name: string) => JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: name } })
    expect(agy.parsePhase(tool('view_file'))).toEqual({ phase: 'Reading', detail: '' })
    expect(agy.parsePhase(tool('search_web'))).toEqual({ phase: 'Running search_web', detail: '' })
  })

  it('pairs the ACTIVE and DONE tool steps by step index', () => {
    expect(agy.parseStep!(REAL.toolStart)).toEqual({ id: '2', edge: 'start', kind: 'run_command', cmd: 'echo hi' })
    expect(agy.parseStep!(REAL.toolDone)).toEqual({ id: '2', edge: 'end', kind: 'tool', cmd: '', exit: 0 })
    expect(agy.parseStep!(REAL.delta1)).toBeNull()
  })

  it('a command that exited 1 is a failed step', () => {
    expect(agy.parseStep!(REAL.toolFailed)).toMatchObject({ edge: 'end', exit: 1 })
  })
})

describe('antigravity parseAuth', () => {
  it('signed in when `agy models` lists models', () => {
    expect(agy.parseAuth!(MODELS_OUT, true)).toEqual({ loggedIn: true, detail: 'Logged in' })
  })

  it('signed out when the command failed or listed nothing', () => {
    expect(agy.parseAuth!(MODELS_OUT, false).loggedIn).toBe(false)
    expect(agy.parseAuth!('Fetching available models...\nPlease sign in\n', true).loggedIn).toBe(false)
  })
})
