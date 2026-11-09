// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CONFIG } from '../../../../shared/config'
import { SidebarNotices, usePostNotice } from '../SidebarNotices'
import { ConductorImport } from '../ConductorImport'
import { usePostUpdateNotice } from '../UpdateNudge'

vi.mock('../../hooks/useUpdateNotifications', () => ({
  useUpdateNotifications: () => ({ state: 'downloaded', version: '9.9.9' })
}))

const L = CONFIG.UI_LABELS
const workspace = (id: string): unknown => ({ id, title: `ws ${id}`, repo: 'repo', branch: 'main', updatedAt: Date.now() })

let host: HTMLDivElement
let root: Root

async function mount(node: JSX.Element): Promise<void> {
  await act(async () => {
    root.render(node)
    await Promise.resolve()
  })
}

function cards(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.rounded-\\[9px\\]')]
}

function OtherNotice(): null {
  usePostNotice(useMemo(() => ({ id: 'other', title: 'Other notice' }), []))
  return null
}

function UpdateReady(): null {
  usePostUpdateNotice()
  return null
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function stubConductor(ids: string[]): void {
  ;(window as unknown as { api: unknown }).api = {
    codeConductorWorkspaces: () => Promise.resolve(ids.map(workspace)),
    codeContinueConductor: () => Promise.resolve({ ok: false, reason: 'x' }),
    update: { install: () => {} }
  }
}

describe('sidebar notices', () => {
  it('keeps a Conductor hide saved under the old key hidden', async () => {
    localStorage.setItem('conductor-import-dismissed', JSON.stringify(['b', 'a']))
    stubConductor(['a', 'b'])
    await mount(
      <>
        <ConductorImport onStarted={() => {}} />
        <SidebarNotices />
      </>
    )
    expect(host.textContent).not.toContain(L.CODE_CONDUCTOR_TITLE)
    expect(localStorage.getItem('conductor-import-dismissed')).toBeNull()
    expect(JSON.parse(localStorage.getItem('sidebar-notices-dismissed') ?? '{}')).toEqual({ 'conductor-import': 'a,b' })
  })

  it('brings the Conductor row back when a new workspace shows up', async () => {
    localStorage.setItem('conductor-import-dismissed', JSON.stringify(['a', 'b']))
    stubConductor(['a', 'b', 'c'])
    await mount(
      <>
        <ConductorImport onStarted={() => {}} />
        <SidebarNotices />
      </>
    )
    expect(host.textContent).toContain(`${L.CODE_CONDUCTOR_TITLE} (3)`)
  })

  it('sorts Update ready first and gives it no X', async () => {
    stubConductor([])
    await mount(
      <>
        <OtherNotice />
        <UpdateReady />
        <SidebarNotices />
      </>
    )
    const showAll = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(L.NOTICE_MORE_ONE))
    expect(showAll).toBeTruthy()
    await act(async () => showAll?.click())
    const [first, second] = cards()
    expect(first.textContent).toContain('Update ready')
    expect(first.querySelector(`[aria-label="${L.NOTICE_DISMISS}"]`)).toBeNull()
    expect(second.textContent).toContain('Other notice')
    expect(second.querySelector(`[aria-label="${L.NOTICE_DISMISS}"]`)).not.toBeNull()
  })
})
