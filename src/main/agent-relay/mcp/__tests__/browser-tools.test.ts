import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  queued: [] as string[],
  pressed: [] as string[],
  controls: [] as { ref: string; label: string }[],
  wc: {
    isLoading: () => false,
    getURL: () => 'https://shop.example/cart',
    getTitle: () => 'Cart',
    executeJavaScript: async () => 'page text'
  }
}))

vi.mock('electron', () => ({ screen: {}, shell: {}, app: { getPath: () => '/tmp', isPackaged: false } }))
vi.mock('../../../side-browser', () => ({
  queueAgentUrl: (u: string) => h.queued.push(u),
  agentUrlQueuedAt: () => 0,
  tabOpenedSince: () => null,
  currentTab: () => h.wc,
  agentStep: async () => true
}))
vi.mock('../../../mighty/mighty-window', () => ({ getMightyWindow: () => null, showMightyWindow: () => {} }))
vi.mock('../../../browser-task/page-driver', () => ({
  readPage: async () => ({ controls: h.controls }),
  pressControl: async (_wc: unknown, ref: string) => (h.pressed.push(ref), true),
  controlLine: (c: { ref: string; label: string }) => `${c.ref}. ${c.label}`
}))

const { BROWSER_HANDLERS } = await import('../browser-tools')

const run = (name: string, args: Record<string, unknown>) =>
  BROWSER_HANDLERS[name].run(args as never, {} as never)

beforeEach(() => {
  h.queued.length = 0
  h.pressed.length = 0
  h.controls = []
})

describe('browser_open', () => {
  it('adds https to a bare host and queues it', async () => {
    const r = await run('browser_open', { url: 'example.com/docs' })
    expect(r.isError).toBe(false)
    expect(h.queued).toEqual(['https://example.com/docs'])
  })

  it('refuses anything that is not http or https', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x.example/']) {
      const r = await run('browser_open', { url })
      expect(r.isError, url).toBe(true)
    }
    expect(h.queued).toEqual([])
  })
})

describe('browser_press', () => {
  it('clicks an ordinary control by its number', async () => {
    h.controls = [{ ref: '3', label: 'Next page' }]
    const r = await run('browser_press', { ref: '3' })
    expect(r.isError).toBe(false)
    expect(h.pressed).toEqual(['3'])
  }, 10_000)

  it('refuses pay, delete and submit buttons and leaves them to the user', async () => {
    h.controls = [
      { ref: '1', label: 'Pay $40' },
      { ref: '2', label: 'Delete account' },
      { ref: '3', label: 'Submit' },
      { ref: '4', label: 'Send' }
    ]
    for (const ref of ['1', '2', '3', '4']) {
      const r = await run('browser_press', { ref })
      expect(r.isError, ref).toBe(true)
    }
    expect(h.pressed).toEqual([])
  })

  it('presses Comment and Send when the user asked, never Pay or Delete', async () => {
    h.controls = [
      { ref: '1', label: 'Pay $40' },
      { ref: '2', label: 'Delete account' },
      { ref: '3', label: 'Comment' },
      { ref: '4', label: 'Send' }
    ]
    for (const ref of ['1', '2', '3', '4']) await run('browser_press', { ref, user_asked: true })
    expect(h.pressed).toEqual(['3', '4'])
  }, 20_000)

  it('refuses a pay button whose label does not start with the pay word', async () => {
    h.controls = [{ ref: '1', label: 'Complete purchase' }]
    await run('browser_press', { ref: '1' })
    expect(h.pressed).toEqual([])
  }, 10_000)

  it('says so when the number is not on the page', async () => {
    const r = await run('browser_press', { ref: '99' })
    expect(r.isError).toBe(true)
    expect(h.pressed).toEqual([])
  })
})
