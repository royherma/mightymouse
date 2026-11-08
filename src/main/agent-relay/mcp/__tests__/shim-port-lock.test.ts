/**
 * The npx shim ships outside this build, so it cannot import CONFIG -- it hard
 * codes the loopback address and the identity header. Changing either value in
 * config.ts without republishing the package breaks `npx mightymouse-code` for
 * everyone who already installed it, silently and with no other test failing.
 *
 * This asserts the copies match. A failure here means: update the shim, bump its
 * version, publish it, THEN land the config change.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { runInNewContext } from 'vm'
import { CONFIG } from '../../../../shared/config'

const SHIM = join(__dirname, '../../../../../npm-shim/mightymouse-code/bin/mightymouse-code.js')

describe('Codex CLI session identity', () => {
  const source = readFileSync(SHIM, 'utf8')
  const identity = source.slice(source.indexOf('function sessionId()'), source.indexOf('function hostSessionPath()'))
  const id = '01a10122-4730-7432-8196-ff1b822c9a9c'

  it('uses the current Codex thread environment variable', () => {
    const execFileSync = vi.fn()
    expect(runInNewContext(identity + '\nsessionId()', {
      process: { env: { CODEX_THREAD_ID: id }, ppid: 123 },
      claudeSessionId: () => '', execFileSync
    })).toBe(id)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('recovers a terminal thread from the parent process open transcript', () => {
    const execFileSync = vi.fn<(...args: unknown[]) => string>().mockReturnValue(`p123\nn/Users/me/.codex/sessions/2026/10/03/rollout-2026-10-03T16-39-46-${id}.jsonl\n`)
    expect(runInNewContext(identity + '\nsessionId()', {
      process: { env: { TMUX_PANE: '%97' }, ppid: 123 },
      claudeSessionId: () => '', execFileSync
    })).toBe(id)
    expect(execFileSync.mock.calls[0][1]).toContain('123')
  })

  it('leaves a shared desktop process without a terminal address alone', () => {
    const execFileSync = vi.fn()
    expect(runInNewContext(identity + '\nsessionId()', {
      process: { env: {}, ppid: 123 }, claudeSessionId: () => '', execFileSync
    })).toBe('')
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('does not guess when the process has multiple transcripts open', () => {
    const open = `n/tmp/rollout-${id}.jsonl\nn/tmp/rollout-01a10122-4730-7432-8196-ff1b822c9a9d.jsonl\n`
    expect(runInNewContext(identity + '\nsessionId()', {
      process: { env: { TMUX_PANE: '%97' }, ppid: 123 },
      claudeSessionId: () => '', execFileSync: () => open
    })).toBe('')
  })
})

describe('npm shim stays in sync with CONFIG.AGENT_RELAY', () => {
  const source = readFileSync(SHIM, 'utf8')

  const literal = (name: string): string => {
    const match = source.match(new RegExp(`const ${name} = '([^']*)'`))
    if (!match) throw new Error(`${name} not found in the shim -- was it renamed?`)
    return match[1]
  }

  it('points at the port the relay listens on', () => {
    const port = source.match(/const MAC_PORT = (\d+)/)
    expect(port, 'MAC_PORT not found in the shim').not.toBeNull()
    expect(Number(port![1])).toBe(CONFIG.AGENT_RELAY.MCP_PORT)
  })

  it('posts to the route the relay serves', () => {
    expect(literal('MAC_ROUTE')).toBe(CONFIG.AGENT_RELAY.MCP_ROUTE)
  })

  it('holds presence on the route the relay counts sessions on', () => {
    expect(literal('MAC_PRESENCE_ROUTE')).toBe(CONFIG.AGENT_RELAY.PRESENCE_ROUTE)
  })

  it('probes the route that proves MightyMouse is what holds the port', () => {
    // The shim tells "port taken by someone else" from "app not running" by
    // whether this route answers 200. Drift makes every foreign-process case
    // report as a closed app, which is the wrong fix to hand someone.
    expect(literal('MAC_SESSIONS_ROUTE')).toBe(CONFIG.AGENT_RELAY.SESSIONS_ROUTE)
  })

  it('sends the identity header the Mac reads', () => {
    expect(literal('IDENTITY_HEADER')).toBe(CONFIG.AGENT_RELAY.IDENTITY_HEADER)
  })

  it('sends the session header the Mac rejoins a reconnect on', () => {
    // Drift here costs nothing visible and breaks reclaim silently: a renamed
    // session comes back as a second row instead of relabelling the first.
    expect(literal('SESSION_HEADER')).toBe(CONFIG.AGENT_RELAY.SESSION_HEADER)
  })

  it('sends the facts header the Mac fills the session list from', () => {
    expect(literal('FACTS_HEADER')).toBe(CONFIG.AGENT_RELAY.FACTS_HEADER)
  })

  it('sends the origin header the "go to session" resolver reads', () => {
    expect(literal('ORIGIN_HEADER')).toBe(CONFIG.AGENT_RELAY.ORIGIN_HEADER)
  })

  it('rides the session header on the MCP calls themselves, not just presence', () => {
    // recap/busy read the POST's own headers (http-listener.ts:490); without
    // this every agent's recap refuses with "No session id on this connection".
    const requestInit = source.slice(source.indexOf('requestInit:'))
    const headersBlock = requestInit.slice(0, requestInit.indexOf('}\n'))
    expect(headersBlock).toContain('[SESSION_HEADER]')
  })

  it('stays on loopback', () => {
    expect(literal('MAC_HOST')).toBe('127.0.0.1')
  })
})
