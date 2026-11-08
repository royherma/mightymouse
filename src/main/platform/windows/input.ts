import { setTimeout as sleep } from 'node:timers/promises'
import { devLog } from '../../../shared/env'
import type { InputAction } from '../../../shared/input-actions'
import type { InputApi } from '../contract'
import { PlatformNotSupportedError } from '../errors'
import { chordFor, VK, type Chord, type KeyStroke } from './keymap'
import {
  INPUT_KEYBOARD,
  INPUT_MOUSE,
  KEYEVENTF,
  MOUSEEVENTF,
  sendRawInputs,
  setCursorPos,
  vkForChar,
  win32Available,
  type RawInput
} from './win32'

export type PointMapper = (x: number, y: number) => { x: number; y: number }

const WHEEL_UNITS_PER_LINE = 40
const WHEEL_NOTCH = 120
const TYPE_CHUNK_UNITS = 32
const KEY_HOLD_MS = 12
const CLICK_SETTLE_MS = 20
const CLICK_GAP_MS = 25
const DRAG_STEPS = 24

const keyEvent = (vk: number, extended: boolean, up: boolean): RawInput => ({
  type: INPUT_KEYBOARD,
  ki: {
    wVk: vk,
    wScan: 0,
    dwFlags: (extended ? KEYEVENTF.extended : 0) | (up ? KEYEVENTF.keyUp : 0)
  }
})

const unicodeEvent = (unit: number, up: boolean): RawInput => ({
  type: INPUT_KEYBOARD,
  ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF.unicode | (up ? KEYEVENTF.keyUp : 0) }
})

const mouseEvent = (dwFlags: number, mouseData = 0, dx = 0, dy = 0): RawInput => ({
  type: INPUT_MOUSE,
  mi: { dx, dy, mouseData: mouseData >>> 0, dwFlags }
})

function chordEvents(chord: Chord): { down: RawInput[]; up: RawInput[] } {
  const down = [
    ...chord.modifiers.map((vk) => keyEvent(vk, false, false)),
    keyEvent(chord.key.vk, chord.key.extended, false)
  ]
  const up = [
    keyEvent(chord.key.vk, chord.key.extended, true),
    ...[...chord.modifiers].reverse().map((vk) => keyEvent(vk, false, true))
  ]
  return { down, up }
}

export function createWindowsInput(toPhysical: PointMapper): InputApi {
  let onSynthesized: (() => void) | null = null
  let dragHeld = false
  let wheelRemainderY = 0
  let wheelRemainderX = 0

  const noteSynthetic = (): void => onSynthesized?.()
  const physical = (x: number, y: number): { x: number; y: number } => toPhysical(x, y)

  const moveTo = (x: number, y: number): void => {
    noteSynthetic()
    const p = physical(x, y)
    setCursorPos(p.x, p.y)
  }

  const dragMoveTo = moveTo

  const releaseHeldDrag = (): void => {
    if (!dragHeld) return
    dragHeld = false
    sendRawInputs([mouseEvent(MOUSEEVENTF.leftUp)])
  }

  const wheel = (lines: number, linesX: number): void => {
    noteSynthetic()
    wheelRemainderY -= lines * WHEEL_UNITS_PER_LINE
    wheelRemainderX -= linesX * WHEEL_UNITS_PER_LINE
    const dy = Math.trunc(wheelRemainderY)
    const dx = Math.trunc(wheelRemainderX)
    wheelRemainderY -= dy
    wheelRemainderX -= dx
    const events: RawInput[] = []
    if (dy !== 0) events.push(mouseEvent(MOUSEEVENTF.wheel, dy))
    if (dx !== 0) events.push(mouseEvent(MOUSEEVENTF.hwheel, dx))
    sendRawInputs(events)
  }

  async function click(
    x: number,
    y: number,
    button: 'left' | 'right',
    count: number
  ): Promise<boolean> {
    noteSynthetic()
    const p = physical(x, y)
    setCursorPos(p.x, p.y)
    await sleep(CLICK_SETTLE_MS)
    const down = button === 'left' ? MOUSEEVENTF.leftDown : MOUSEEVENTF.rightDown
    const up = button === 'left' ? MOUSEEVENTF.leftUp : MOUSEEVENTF.rightUp
    for (let i = 0; i < count; i++) {
      sendRawInputs([mouseEvent(down)])
      await sleep(KEY_HOLD_MS)
      sendRawInputs([mouseEvent(up)])
      if (i < count - 1) await sleep(CLICK_GAP_MS)
    }
    return true
  }

  async function pressChord(chord: Chord): Promise<void> {
    const { down, up } = chordEvents(chord)
    try {
      sendRawInputs(down)
      await sleep(KEY_HOLD_MS)
    } finally {
      sendRawInputs(up)
    }
  }

  async function pressCombos(combos: readonly string[]): Promise<boolean> {
    noteSynthetic()
    const chords = combos.map((c) => chordFor(c, vkForChar))
    if (chords.some((c) => c === null)) return false
    for (const chord of chords as Chord[]) {
      await pressChord(chord)
      await sleep(CLICK_GAP_MS)
    }
    return true
  }

  async function typeLiteral(text: string): Promise<boolean> {
    noteSynthetic()
    const units = [...text].flatMap((ch) => {
      if (ch === '\n' || ch === '\r') return [-VK.enter]
      if (ch === '\t') return [-VK.tab]
      return Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i))
    })
    for (let i = 0; i < units.length; i += TYPE_CHUNK_UNITS) {
      const events: RawInput[] = []
      for (const u of units.slice(i, i + TYPE_CHUNK_UNITS)) {
        if (u < 0) {
          events.push(keyEvent(-u, false, false), keyEvent(-u, false, true))
        } else {
          events.push(unicodeEvent(u, false), unicodeEvent(u, true))
        }
      }
      sendRawInputs(events)
      if (i + TYPE_CHUNK_UNITS < units.length) await sleep(4)
    }
    return true
  }

  async function zoom(steps: number): Promise<boolean> {
    noteSynthetic()
    if (steps === 0) return true
    const sign = steps > 0 ? 1 : -1
    sendRawInputs([keyEvent(VK.ctrl, false, false)])
    try {
      for (let i = 0; i < Math.abs(steps); i++) {
        sendRawInputs([mouseEvent(MOUSEEVENTF.wheel, sign * WHEEL_NOTCH)])
        await sleep(KEY_HOLD_MS)
      }
    } finally {
      sendRawInputs([keyEvent(VK.ctrl, false, true)])
    }
    return true
  }

  async function appTab(steps: number): Promise<boolean> {
    noteSynthetic()
    const count = Math.max(1, Math.abs(steps))
    const backwards = steps < 0
    sendRawInputs([keyEvent(VK.alt, false, false)])
    try {
      if (backwards) sendRawInputs([keyEvent(VK.shift, false, false)])
      for (let i = 0; i < count; i++) {
        sendRawInputs([keyEvent(VK.tab, false, false), keyEvent(VK.tab, false, true)])
        await sleep(40)
      }
      if (backwards) sendRawInputs([keyEvent(VK.shift, false, true)])
    } finally {
      sendRawInputs([keyEvent(VK.alt, false, true)])
    }
    return true
  }

  async function drag(x1: number, y1: number, x2: number, y2: number): Promise<boolean> {
    noteSynthetic()
    const a = physical(x1, y1)
    const b = physical(x2, y2)
    setCursorPos(a.x, a.y)
    await sleep(CLICK_SETTLE_MS)
    sendRawInputs([mouseEvent(MOUSEEVENTF.leftDown)])
    try {
      await sleep(CLICK_SETTLE_MS)
      for (let i = 1; i <= DRAG_STEPS; i++) {
        const t = i / DRAG_STEPS
        setCursorPos(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
        await sleep(8)
      }
    } finally {
      sendRawInputs([mouseEvent(MOUSEEVENTF.leftUp)])
    }
    return true
  }

  async function keyHold(key: string, up: boolean): Promise<boolean> {
    noteSynthetic()
    const chord = chordFor(key, vkForChar)
    if (!chord) return false
    const stroke: KeyStroke = chord.key
    sendRawInputs([keyEvent(stroke.vk, stroke.extended, up)])
    return true
  }

  async function runAction(action: InputAction): Promise<boolean> {
    switch (action.verb) {
      case 'move':
        moveTo(action.x, action.y)
        return true
      case 'click':
        return click(action.x, action.y, 'left', 1)
      case 'rightclick':
        return click(action.x, action.y, 'right', 1)
      case 'doubleclick':
        return click(action.x, action.y, 'left', 2)
      case 'tripleclick':
        return click(action.x, action.y, 'left', 3)
      case 'drag':
        return drag(action.x1, action.y1, action.x2, action.y2)
      case 'scroll': {
        const lines = action.amount
        if (action.direction === 'up') wheel(-lines, 0)
        else if (action.direction === 'down') wheel(lines, 0)
        else if (action.direction === 'left') wheel(0, lines)
        else wheel(0, -lines)
        return true
      }
      case 'type':
        return typeLiteral(action.text)
      case 'key':
        return pressCombos(typeof action.combo === 'string' ? [action.combo] : action.combo)
      case 'keydown':
        return keyHold(action.key, false)
      case 'keyup':
        return keyHold(action.key, true)
      case 'apptab':
        return appTab(action.steps)
      case 'zoom':
        return zoom(action.steps)
      case 'smartzoom':
        return pressCombos(['ctrl+0'])
    }
  }

  const runInput: InputApi['runInput'] = async (action) => {
    if (!win32Available()) return false
    try {
      return await runAction(action)
    } catch (err) {
      devLog.error('windows input failed', action.verb, err)
      return false
    }
  }

  const quiet =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A): void => {
      if (!win32Available()) return
      try {
        fn(...args)
      } catch (err) {
        devLog.error('windows input failed', err)
      }
    }

  const unsupported = (name: string) => (): never => {
    throw new PlatformNotSupportedError('win32', `input.${name}`)
  }

  return {
    setSyntheticInputListener: (cb) => {
      onSynthesized = cb
    },
    runInput,
    inputBinPath: unsupported('inputBinPath'),
    shotCommand: unsupported('shotCommand'),
    captureScreenWithoutUs: () => Promise.resolve(false),
    uiBinPath: unsupported('uiBinPath'),
    detectHostKeyboardType: () => Promise.resolve('ansi'),
    moveCursorFast: quiet((x: number, y: number) => {
      if (dragHeld) dragMoveTo(x, y)
      else moveTo(x, y)
    }),
    dragDownFast: quiet((x: number, y: number) => {
      moveTo(x, y)
      dragHeld = true
      sendRawInputs([mouseEvent(MOUSEEVENTF.leftDown)])
    }),
    dragMoveFast: quiet(dragMoveTo),
    dragUpFast: quiet((x: number, y: number) => {
      dragMoveTo(x, y)
      releaseHeldDrag()
    }),
    scrollFast: quiet(wheel),
    stopMoveLoop: quiet(releaseHeldDrag),
    clickAt: (x, y) => runInput({ verb: 'click', x, y }),
    rightClickAt: (x, y) => runInput({ verb: 'rightclick', x, y }),
    doubleClickAt: (x, y) => runInput({ verb: 'doubleclick', x, y }),
    typeText: (value, mode = 'text') =>
      mode === 'key'
        ? runInput({ verb: 'key', combo: value })
        : runInput({ verb: 'type', text: value }),
    pressKeys: (combos) => runInput({ verb: 'key', combo: combos }),
    zoomMac: (steps) => runInput({ verb: 'zoom', steps }),
    smartZoomMac: () => runInput({ verb: 'smartzoom' }),
    openAppOverview: () => void runInput({ verb: 'key', combo: 'win+tab' }),
    hideSystemCursor: unsupported('hideSystemCursor'),
    showSystemCursor: unsupported('showSystemCursor'),
    getCursorAppearance: () => ({ size: 1, fill: '#ffffff', outline: '#000000' }),
    setCursorSize: () => false,
    onFnEdge: unsupported('onFnEdge'),
    stopFnWatch: unsupported('stopFnWatch')
  }
}
