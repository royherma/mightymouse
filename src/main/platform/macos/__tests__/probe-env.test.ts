import { afterEach, describe, expect, it, vi } from 'vitest'
import { pathPrefix, probeEnv } from '../shell'

describe('probeEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('drops the env vars that tell a CLI it is running inside an AI agent', () => {
    for (const key of ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'GEMINI_CLI', 'COPILOT_AGENT', 'REPL_ID']) {
      vi.stubEnv(key, '1')
    }
    const env = probeEnv()
    for (const key of ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'GEMINI_CLI', 'COPILOT_AGENT', 'REPL_ID']) {
      expect(env[key], key).toBeUndefined()
    }
  })

  it('keeps account and config vars that only look similar', () => {
    vi.stubEnv('CODEX_HOME', '/u/.codex-work')
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/u/.claude-work')
    vi.stubEnv('VERCEL_TOKEN', 'v')
    vi.stubEnv('NOT_AI_AGENT', 'x')
    vi.stubEnv('CLAUDECODE_HOME', 'y')
    const env = probeEnv()
    expect(env.CODEX_HOME).toBe('/u/.codex-work')
    expect(env.CLAUDE_CONFIG_DIR).toBe('/u/.claude-work')
    expect(env.VERCEL_TOKEN).toBe('v')
    expect(env.NOT_AI_AGENT).toBe('x')
    expect(env.CLAUDECODE_HOME).toBe('y')
    expect(env.PATH?.startsWith(`${pathPrefix}:`)).toBe(true)
  })

  it('an explicit extra var survives, even one the filter would drop', () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'inherited')
    vi.stubEnv('VERCEL_TOKEN', 'inherited')
    const env = probeEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'stored-key', VERCEL_TOKEN: 'stored-key' })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stored-key')
    expect(env.VERCEL_TOKEN).toBe('stored-key')
  })

  it('never mutates the app process env', () => {
    vi.stubEnv('CLAUDECODE', '1')
    probeEnv()
    expect(process.env.CLAUDECODE).toBe('1')
  })
})
