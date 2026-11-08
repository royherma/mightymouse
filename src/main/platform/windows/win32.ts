import koffi from 'koffi'

export const INPUT_MOUSE = 0
export const INPUT_KEYBOARD = 1

export const MOUSEEVENTF = {
  move: 0x0001,
  leftDown: 0x0002,
  leftUp: 0x0004,
  rightDown: 0x0008,
  rightUp: 0x0010,
  wheel: 0x0800,
  hwheel: 0x1000
} as const

export const KEYEVENTF = { extended: 0x0001, keyUp: 0x0002, unicode: 0x0004 } as const

export type RawInput =
  | { type: typeof INPUT_MOUSE; mi: { dx: number; dy: number; mouseData: number; dwFlags: number } }
  | { type: typeof INPUT_KEYBOARD; ki: { wVk: number; wScan: number; dwFlags: number } }

interface Bindings {
  sendInput(inputs: unknown[]): number
  setCursorPos(x: number, y: number): number
  getCursorPos(out: { x: number; y: number }): number
  vkKeyScan(ch: number): number
}

let bindings: Bindings | null | undefined

function load(): Bindings | null {
  if (bindings !== undefined) return bindings
  if (process.platform !== 'win32') return (bindings = null)
  try {
    const user32 = koffi.load('user32.dll')
    const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
      dx: 'int32',
      dy: 'int32',
      mouseData: 'uint32',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t'
    })
    const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t'
    })
    const INPUT = koffi.struct('INPUT', {
      type: 'uint32',
      u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT })
    })
    koffi.struct('POINT', { x: 'int32', y: 'int32' })
    const SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)')
    const SetCursorPos = user32.func('int __stdcall SetCursorPos(int x, int y)')
    const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT *p)')
    const VkKeyScanW = user32.func('int16 __stdcall VkKeyScanW(uint16 ch)')
    const inputSize = koffi.sizeof(INPUT)
    bindings = {
      sendInput: (inputs) => SendInput(inputs.length, inputs, inputSize),
      setCursorPos: (x, y) => SetCursorPos(x, y),
      getCursorPos: (out) => GetCursorPos(out),
      vkKeyScan: (ch) => VkKeyScanW(ch)
    }
  } catch {
    bindings = null
  }
  return bindings
}

export function win32Available(): boolean {
  return load() !== null
}

function need(): Bindings {
  const b = load()
  if (!b) throw new Error('user32 is not available')
  return b
}

export function sendRawInputs(inputs: RawInput[]): number {
  if (inputs.length === 0) return 0
  const wire = inputs.map((i) =>
    i.type === INPUT_MOUSE
      ? { type: i.type, u: { mi: { ...i.mi, time: 0, dwExtraInfo: 0 } } }
      : { type: i.type, u: { ki: { ...i.ki, time: 0, dwExtraInfo: 0 } } }
  )
  return need().sendInput(wire)
}

export function setCursorPos(x: number, y: number): boolean {
  return need().setCursorPos(Math.round(x), Math.round(y)) !== 0
}

export function getCursorPos(): { x: number; y: number } {
  const p = { x: 0, y: 0 }
  need().getCursorPos(p)
  return p
}

export function vkForChar(ch: string): number | null {
  const r = need().vkKeyScan(ch.charCodeAt(0))
  return r === -1 ? null : r & 0xff
}
