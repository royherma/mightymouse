import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ ps: '', fail: false, calls: 0, sessions: [] as unknown[] }))
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string }) => void) => {
    h.calls++
    if (h.fail) cb(new Error('ps died'))
    else cb(null, { stdout: h.ps })
  }
}))
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), cpus: () => [{}, {}, {}, {}] }))
vi.mock('../mcp/http-listener', () => ({ liveAgentSessions: () => h.sessions }))

const { sessionLoads } = await import('../session-load')

const row = (pid: number, ppid: number, cpu: number, rssKb: number, name: string): string => `  ${pid}  ${ppid}  ${cpu.toFixed(1)}  ${rssKb} ${name}`
let clock = 1_800_000_000_000

beforeEach(() => {
  clock += 10_000
  vi.useFakeTimers({ now: clock, toFake: ['Date'] })
  h.fail = false
  h.calls = 0
})
afterEach(() => vi.useRealTimers())

describe('sessionLoads', () => {
  it('adds up the agent and everything under it, and nothing beside it', () => {
    h.ps = [
      row(1, 0, 0, 1000, 'launchd'),
      row(500, 1, 3, 2048, 'zsh'),
      row(600, 500, 40, 409600, 'claude'),
      row(601, 600, 2, 10240, 'node'),
      row(602, 600, 120, 512000, '/usr/local/bin/node'),
      row(603, 602, 20, 102400, 'esbuild'),
      row(604, 600, 8, 51200, 'git'),
      row(605, 600, 1, 1024, 'rg'),
      row(700, 500, 99, 999999, 'claude')
    ].join('\n')
    h.sessions = [{ sessionId: 's1', facts: { agentPid: 600 } }]
    return sessionLoads().then((loads) => {
      expect(loads).toEqual({
        s1: {
          cpuPct: 47.8,
          memMb: 1061,
          agentCpuPct: 10,
          started: 5,
          top: [
            { name: 'node', count: 2, cpuPct: 30.5, memMb: 510 },
            { name: 'esbuild', count: 1, cpuPct: 5, memMb: 100 },
            { name: 'git', count: 1, cpuPct: 2, memMb: 50 }
          ]
        }
      })
    })
  })

  it("without the agent's pid, the shim's parent is the agent", async () => {
    h.ps = [row(800, 1, 12, 20480, 'gemini'), row(801, 800, 0, 4096, 'node'), row(802, 800, 4, 8192, 'python3')].join('\n')
    h.sessions = [{ sessionId: 's2', facts: { pid: 801 } }]
    const loads = await sessionLoads()
    expect(loads.s2.agentCpuPct).toBe(3)
    expect(loads.s2.started).toBe(2)
    expect(loads.s2.cpuPct).toBe(4)
  })

  it('skips sessions with no id, no process, or launchd as the root', async () => {
    h.ps = [row(900, 1, 1, 1024, 'x')].join('\n')
    h.sessions = [{ facts: { agentPid: 900 } }, { sessionId: 'gone', facts: { pid: 4242 } }, { sessionId: 'orphan', facts: { pid: 900 } }]
    expect(await sessionLoads()).toEqual({})
  })

  it('a failing ps yields no numbers instead of throwing', async () => {
    h.fail = true
    h.sessions = [{ sessionId: 's3', facts: { agentPid: 600 } }]
    expect(await sessionLoads()).toEqual({})
  })

  it('reuses one ps run for calls within 1.5 s', async () => {
    h.ps = row(950, 1, 4, 1024, 'claude')
    h.sessions = [{ sessionId: 's4', facts: { agentPid: 950 } }]
    await sessionLoads()
    vi.setSystemTime(clock + 1_000)
    await sessionLoads()
    expect(h.calls).toBe(1)
    vi.setSystemTime(clock + 1_600)
    await sessionLoads()
    expect(h.calls).toBe(2)
  })
})
