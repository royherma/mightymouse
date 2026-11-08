import { describe, expect, it, vi } from 'vitest'

const SEP = '\u0001\u0002'
const runOsaAsync = vi.fn<(script: string) => Promise<string | null>>()
vi.mock('./osa', () => ({
  runOsa: () => {
    throw new Error('blocking osascript on the app-context read path')
  },
  runOsaAsync: (s: string) => runOsaAsync(s),
  FIELD_SEP: '\u0001\u0002',
  OSASCRIPT_TIMEOUT_MS: 3000
}))

describe('app-context reads run no blocking osascript', () => {
  it('Chrome/Safari', async () => {
    runOsaAsync.mockResolvedValue(`2${SEP}Inbox${SEP}Docs${SEP}${SEP}https://mail.example${SEP}https://docs.example`)
    const { readChrome } = await import('./chrome')
    const { APP_ADAPTER } = await import('../../../../shared/app-context')

    const reading = await readChrome(APP_ADAPTER.safari)

    expect(reading.items.map((i) => [i.title, i.active])).toEqual([
      ['Inbox', false],
      ['Docs', true]
    ])
  })

  it('cmux', async () => {
    runOsaAsync.mockResolvedValue('')
    const { readCmux } = await import('./cmux')
    expect((await readCmux()).groups).toEqual([])
  })

  it('Cursor', async () => {
    runOsaAsync.mockResolvedValue('')
    const { readCursor } = await import('./cursor')
    expect((await readCursor()).groups).toEqual([])
  })
})
