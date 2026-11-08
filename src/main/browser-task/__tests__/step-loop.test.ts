import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageControl, PageRead } from '../../../shared/types'

const h = vi.hoisted(() => ({
  answers: [] as string[],
  prompts: [] as string[],
  tabs: [] as Array<{ id: string; wc: unknown }>,
  pages: new Map<unknown, PageRead>(),
  pressed: [] as string[],
  filled: [] as Array<Record<string, string>>,
  loaded: [] as string[]
}))

vi.mock('electron', () => ({ screen: {}, shell: {} }))
vi.mock('../../capture/uiohook-manager', () => ({ acquire: () => () => {}, on: () => () => {} }))
vi.mock('../../platform', () => ({ context: {}, input: {}, captureSelection: async () => '', pasteText: async () => {} }))
vi.mock('../../actions/computer-use/agent-cursor', () => ({ showAgentCursor: () => {}, hideAgentCursor: () => {} }))
vi.mock('../../intent-router', () => ({ VERBS: {} }))
vi.mock('../../store/prefs', () => ({ PREFS: { getIncognito: () => false, getBrowserTaskModel: () => '', getBackend: () => 'mightymouse' } }))
vi.mock('../../auth', () => ({ isCurrentUserAdmin: () => false }))
vi.mock('../../store/paths', async (orig) => ({ PATHS: { ...(await orig<typeof import('../../store/paths')>()).PATHS, COMPUTER_USE_LOG: '/dev/null' } }))
vi.mock('../../side-browser', () => ({ siblingTabs: () => h.tabs }))
vi.mock('../form-fill', () => ({ fillFromDocuments: vi.fn() }))
vi.mock('../../backend/runner', () => ({ EXIT_TIMEOUT: -3, runBackend: vi.fn() }))
vi.mock('../../backend/adapters', () => ({ BACKENDS: { claude: { binPath: '' } } }))
vi.mock('../../voice-routing/agent-models', () => ({ listAgentModels: async () => [] }))

vi.mock('../../actions/computer-use/writer', () => ({
  callLlmProxy: async (req: { userPrompt: string }) => {
    h.prompts.push(req.userPrompt)
    const text = h.answers.shift() ?? '{"do":"done","answer":"out of script"}'
    return { ok: true, text, ms: 1, trail: { costUsdMicros: 0 } }
  }
}))

vi.mock('../page-driver', () => ({
  readPage: async (wc: unknown) => h.pages.get(wc),
  controlLine: (c: PageControl) => `[${c.ref}] ${c.label}`,
  pressControl: async (_wc: unknown, ref: string) => {
    h.pressed.push(ref)
    return true
  },
  fillFields: async (_wc: unknown, values: Record<string, string>) => {
    h.filled.push(values)
    return Object.keys(values).map((ref) => ({ ref, ok: true }))
  }
}))

vi.mock('../../../shared/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/config')>()
  return {
    ...actual,
    CONFIG: {
      ...actual.CONFIG,
      BROWSER_TASK: { ...actual.CONFIG.BROWSER_TASK, PRESS_SETTLE_MS: 0, NEW_TAB_WAIT_MS: 0 }
    }
  }
})

import { StepControl, runSteps } from '../step-loop'

function fakeTab(id: string, controls: PageControl[]): { id: string; wc: unknown } {
  const wc = {
    isLoading: () => false,
    isDestroyed: () => false,
    getURL: () => `https://shop.test/${id}`,
    getTitle: () => id,
    setBackgroundThrottling: () => {},
    loadURL: async (url: string) => {
      h.loaded.push(url)
    },
    executeJavaScript: async () => {},
    navigationHistory: { canGoBack: () => false, goBack: () => {} }
  }
  h.pages.set(wc, { url: wc.getURL(), title: id, controls, text: 'page text', ms: 0 })
  return { id, wc }
}

const control = (ref: string, label: string, extra: Partial<PageControl> = {}): PageControl =>
  ({ ref, kind: 'button', label, ...extra }) as PageControl

const req = { instruction: 'finish checkout', files: [] as string[] }

async function run(answers: object[], onPause?: (c: StepControl, why: string) => void) {
  h.answers = answers.map((a) => JSON.stringify(a))
  const c = new StepControl()
  const said: Array<{ line: string; paused?: string }> = []
  const result = await runSteps('t1', req, c, (p) => {
    said.push(p)
    if (p.paused) (onPause ?? ((ctl) => ctl.command('stop')))(c, p.paused)
  })
  return { result, said, pauses: said.filter((s) => s.paused).map((s) => s.paused) }
}

beforeEach(() => {
  h.prompts = []
  h.pressed = []
  h.filled = []
  h.loaded = []
  h.pages.clear()
  h.tabs = [
    fakeTab('t1', [
      control('1', 'Pay now'),
      control('2', 'Send'),
      control('3', 'Next page'),
      control('4', 'Card number', { kind: 'text', secret: true } as Partial<PageControl>),
      control('5', 'Message', { kind: 'text' } as Partial<PageControl>)
    ])
  ]
})

describe('runSteps hands money and posting buttons back to the user', () => {
  it('never presses a Pay button, pauses with its name instead', async () => {
    const { result, pauses } = await run([{ do: 'press', ref: '1', say: 'Paying' }])
    expect(h.pressed).toEqual([])
    expect(pauses).toEqual(['Your turn: press "Pay now", then Continue'])
    expect(result).toMatchObject({ ok: true, answer: 'Stopped.' })
  })

  it('presses Send when nothing was typed, but hands it over once a field was filled', async () => {
    await run([{ do: 'press', ref: '2' }, { do: 'done', answer: 'ok' }])
    expect(h.pressed).toEqual(['2'])

    h.pressed = []
    const { pauses } = await run([{ do: 'fill', values: { '5': 'hi there' } }, { do: 'press', ref: '2' }])
    expect(h.pressed).toEqual([])
    expect(pauses).toEqual(['Your turn: press "Send", then Continue'])
  })

  it('presses an ordinary button', async () => {
    await run([{ do: 'press', ref: '3' }, { do: 'done', answer: 'ok' }])
    expect(h.pressed).toEqual(['3'])
  })
})

describe('runSteps never types into secret fields', () => {
  it('drops a card-number value and fills the rest', async () => {
    await run([{ do: 'fill', values: { '4': '4242424242424242', '5': 'hello' } }, { do: 'done', answer: 'ok' }])
    expect(h.filled).toEqual([{ '5': 'hello' }])
  })
})

describe('runSteps only opens web pages', () => {
  it('refuses file:// and adds https:// to a bare host', async () => {
    await run([
      { do: 'open', url: 'file:///etc/passwd', say: 'x' },
      { do: 'open', url: 'example.com/a', say: 'y' },
      { do: 'done', answer: 'ok' }
    ])
    expect(h.loaded).toEqual(['https://example.com/a'])
    expect(h.prompts[2]).toContain('Refused to open file:///etc/passwd')
  })

  it('an unparseable address without a "say" line is a failed step, not a crash', async () => {
    const { result } = await run([{ do: 'open', url: 'javascript:alert(1)' }, { do: 'done', answer: 'ok' }])
    expect(result).toMatchObject({ ok: true, answer: 'ok' })
  })
})

describe('runSteps control flow', () => {
  it('returns the model answer on done', async () => {
    const { result } = await run([{ do: 'done', answer: 'Checked out.' }])
    expect(result).toMatchObject({ ok: true, kind: 'steps', answer: 'Checked out.', steps: 0 })
  })

  it('fails with a reason when the model reply is not JSON', async () => {
    h.answers = ['I think you should press pay']
    const result = await runSteps('t1', req, new StepControl(), () => {})
    expect(result).toMatchObject({ ok: false, reason: 'Could not decide the next step (unreadable answer)' })
  })

  it('fails when every work tab is gone', async () => {
    h.tabs = []
    const result = await runSteps('t1', req, new StepControl(), () => {})
    expect(result).toMatchObject({ ok: false, reason: 'The browser tab closed' })
  })

  it('pauses after the same action three times in a row', async () => {
    const scroll = { do: 'scroll', dir: 'down' }
    const { pauses } = await run([scroll, scroll, scroll])
    expect(pauses).toEqual(["I'm going in circles. Tell me what to do, then Continue"])
  })

  it('asks the user, then feeds their Continue note into the next prompt', async () => {
    const { result, pauses } = await run(
      [{ do: 'ask', question: 'Which size?' }, { do: 'done', answer: 'Picked M.' }],
      (c) => c.command('resume', 'size M')
    )
    expect(pauses).toEqual(['Which size?'])
    expect(h.prompts[1]).toContain('The user said: size M')
    expect(result).toMatchObject({ ok: true, answer: 'Picked M.' })
  })

  it('stops before the next step when Stop is pressed mid-run', async () => {
    h.answers = [JSON.stringify({ do: 'press', ref: '3' })]
    const c = new StepControl()
    const result = await runSteps('t1', req, c, (p) => {
      if (p.step) c.command('stop')
    })
    expect(result).toMatchObject({ ok: true, answer: 'Stopped.', steps: 1 })
    expect(h.prompts).toHaveLength(1)
  })
})
