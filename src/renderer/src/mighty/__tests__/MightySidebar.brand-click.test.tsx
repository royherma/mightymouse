// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { writeFileSync, mkdirSync } from 'node:fs'
import { MightySidebar, SidebarRow } from '../MightySidebar'
import { CONFIG } from '../../../../shared/config'

vi.mock('../../components/UpdateNudge', () => ({ usePostUpdateNotice: () => undefined }))

const ARTIFACTS = process.env.MM_ARTIFACTS_DIR

function stubApi(): unknown {
  const fn: () => unknown = () => node
  const node: unknown = new Proxy(fn, {
    get: (_t, key) =>
      key === 'then' ? (res: (v: undefined) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(undefined).then(res, rej) : node,
    apply: () => node
  })
  return node
}

type Session = { id: string; messages: string[] }

function Harness({ onNewSession, onState }: { onNewSession: () => void; onState: (s: Session) => void }): JSX.Element {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)
  const [session, setSession] = useState<Session>({ id: 'sess-existing-1', messages: ['fix the login bug'] })
  onState(session)
  const startNewSession = (): void => {
    onNewSession()
    setSession({ id: `sess-new-${Math.random().toString(36).slice(2, 10)}`, messages: [] })
  }
  return (
    <>
      <MightySidebar
        tab="code"
        mode="code"
        codeAvailable
        codePending={0}
        codeView="sessions"
        openSessions={1}
        onSelect={() => {}}
        onCodeView={() => {}}
        onActionsSlot={setSlot}
        onListSlot={() => {}}
        onAll={() => {}}
        onAgentsSlot={() => {}}
      />
      {slot && createPortal(<SidebarRow card label="New session" onClick={startNewSession} />, slot)}
      <main data-session-id={session.id}>{session.messages.length} messages</main>
    </>
  )
}

let root: Root
let host: HTMLDivElement
const snap = (name: string): void => {
  if (!ARTIFACTS) return
  mkdirSync(ARTIFACTS, { recursive: true })
  writeFileSync(`${ARTIFACTS}/${name}.html`, document.body.innerHTML)
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('api', stubApi())
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('MightySidebar brand click', () => {
  it('icon and name each start a new empty session through the New session handler', async () => {
    const newSession = vi.fn()
    let state: Session = { id: '', messages: [] }
    await act(async () => {
      root.render(<Harness onNewSession={newSession} onState={(s) => (state = s)} />)
    })

    const brand = document.querySelector<HTMLImageElement>('aside img')!
    const brandButton = brand.closest('button')!
    const name = [...brandButton.querySelectorAll('span')].find((s) => s.textContent === CONFIG.BRAND_NAME)!
    expect(brandButton.title).toBe('New session')
    const start = state
    expect(start.messages.length).toBeGreaterThan(0)
    snap('brand-click-before')

    await act(async () => brand.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(newSession).toHaveBeenCalledTimes(1)
    const afterIcon = state
    expect(afterIcon.id).not.toBe(start.id)
    expect(afterIcon.messages).toEqual([])

    await act(async () => name.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(newSession).toHaveBeenCalledTimes(2)
    const afterName = state
    expect(afterName.id).not.toBe(afterIcon.id)
    expect(afterName.id).not.toBe(start.id)
    expect(afterName.messages).toEqual([])
    snap('brand-click-after')

    const topButton = [...document.querySelectorAll('aside button')].find((b) => b.textContent?.includes('New session'))!
    await act(async () => topButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(newSession).toHaveBeenCalledTimes(3)
  })
})
