import { describe, it, expect, afterEach, vi } from 'vitest'

async function loadConfig(instance: string | undefined): Promise<typeof import('../config')['CONFIG']> {
  vi.resetModules()
  if (instance === undefined) vi.stubEnv('MM_INSTANCE', '')
  else vi.stubEnv('MM_INSTANCE', instance)
  return (await import('../config')).CONFIG
}

describe('MM_INSTANCE=devtest', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('shifts every listening port by 200 so a second copy never collides with the real app', async () => {
    const normal = await loadConfig(undefined)
    const devtest = await loadConfig('devtest')
    expect(devtest.PHONE_REMOTE.PORT).toBe(normal.PHONE_REMOTE.PORT + 200)
    expect(devtest.PHONE_REMOTE.ICON_PORT).toBe(normal.PHONE_REMOTE.ICON_PORT + 200)
    expect(devtest.AGENT_RELAY.MCP_PORT).toBe(normal.AGENT_RELAY.MCP_PORT + 200)
    expect(devtest.PARAKEET_SERVER_PORT).toBe(normal.PARAKEET_SERVER_PORT + 200)
  })

  it('shifted ports do not land on any port the real app uses', async () => {
    const normal = await loadConfig(undefined)
    const devtest = await loadConfig('devtest')
    const ports = (c: typeof normal): number[] => [
      c.PHONE_REMOTE.PORT,
      c.PHONE_REMOTE.ICON_PORT,
      c.AGENT_RELAY.MCP_PORT,
      c.PARAKEET_SERVER_PORT
    ]
    const real = new Set(ports(normal))
    for (const p of ports(devtest)) expect(real.has(p)).toBe(false)
  })

  it('gets its own name and URL scheme so deep links reach the right copy', async () => {
    const normal = await loadConfig(undefined)
    const devtest = await loadConfig('devtest')
    expect(devtest.APP_NAME).toMatch(/Dev Test$/)
    expect(devtest.APP_NAME).not.toBe(normal.APP_NAME)
    expect(devtest.PROTOCOL_SCHEME).toMatch(/-devtest$/)
    expect(devtest.PROTOCOL_SCHEME).not.toBe(normal.PROTOCOL_SCHEME)
  })

  it('any other MM_INSTANCE value leaves ports alone', async () => {
    const normal = await loadConfig(undefined)
    const other = await loadConfig('staging')
    expect(other.PHONE_REMOTE.PORT).toBe(normal.PHONE_REMOTE.PORT)
    expect(other.APP_NAME).toBe(normal.APP_NAME)
  })
})
