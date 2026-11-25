// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useKeyboard } from '../hooks/use-keyboard'

const S = '​'

type Sent = { type: string; text?: string; count?: number }

let host: HTMLDivElement
let root: Root
let sent: Sent[]
let input: HTMLInputElement
let hook: ReturnType<typeof useKeyboard>

function Harness(): JSX.Element {
  hook = useKeyboard({
    bus: { subscribe: () => () => {} } as never,
    send: ((msg: Sent) => sent.push(msg)) as never,
    connState: 'open' as never,
    hostKeyboard: 'mac' as never,
    setQuickAnchor: () => {},
    quickAnchorRef: { current: null },
    quickStepsRef: { current: 0 },
    appRingRef: { current: false },
    applyRingRefreshWhenIdleRef: { current: null }
  })
  return <input ref={hook.keyboardInputRef} defaultValue={S} />
}

function type(raw: string): Sent[] {
  sent = []
  input.value = raw
  act(() => hook.onKeyboardTextChange(raw))
  return sent
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  sent = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<Harness />))
  input = host.querySelector('input')!
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('hidden keyboard field to computer keystrokes', () => {
  it('types each new letter once and keeps the invisible floor in front', () => {
    expect(type(`${S}h`)).toEqual([{ type: 'typeText', text: 'h' }])
    expect(type(`${S}hi`)).toEqual([{ type: 'typeText', text: 'i' }])
    expect(input.value).toBe(`${S}hi`)
  })

  it('backspace over our own text deletes exactly that many characters', () => {
    type(`${S}hey`)
    expect(type(`${S}he`)).toEqual([{ type: 'deleteText', count: 1 }])
    expect(type(`${S}`)).toEqual([{ type: 'deleteText', count: 2 }])
  })

  it('a backspace past the floor sends one delete and puts the floor back', () => {
    expect(type('')).toEqual([{ type: 'deleteText', count: 1 }])
    expect(input.value).toBe(S)
    expect(type('')).toEqual([{ type: 'deleteText', count: 1 }])
  })

  it('an autocorrect swap deletes the changed tail and retypes it', () => {
    type(`${S}teh`)
    expect(type(`${S}the`)).toEqual([
      { type: 'deleteText', count: 2 },
      { type: 'typeText', text: 'he' }
    ])
  })

  it('a letter typed after the floor went missing is typed, not turned into a delete', () => {
    expect(type('h')).toEqual([{ type: 'typeText', text: 'h' }])
    expect(input.value).toBe(`${S}h`)
  })

  it('losing the floor while text is intact sends nothing, so the computer does not lose that text', () => {
    type(`${S}hello`)
    expect(type('hello')).toEqual([])
    expect(input.value).toBe(`${S}hello`)
  })

  it('Return sends one key press and starts a fresh line with nothing left to delete', () => {
    type(`${S}ok`)
    sent = []
    act(() => hook.onKeyboardEnter())
    expect(sent).toEqual([{ type: 'pressKey', key: 'return' }])
    expect(input.value).toBe(S)
    expect(type(`${S}x`)).toEqual([{ type: 'typeText', text: 'x' }])
  })
})
