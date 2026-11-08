import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { CONFIG } from '../../../shared/config'

export type Direction = 'left' | 'right' | 'up' | 'down'

export type PrefixCommand =
  | { kind: 'numbers' }
  | { kind: 'jump'; index: number }
  | { kind: 'zoom' }
  | { kind: 'move'; dir: Direction }
  | { kind: 'next-pane' }
  | { kind: 'split' }
  | { kind: 'close' }
  | { kind: 'new-tab' }
  | { kind: 'tab'; step: 1 | -1 }
  | { kind: 'help' }

export const PREFIX_HELP: ReadonlyArray<readonly [string, string]> = [
  ['q', 'Show pane numbers, then press one'],
  ['1-6', 'Jump to that pane'],
  ['z', 'Zoom this pane in or out'],
  ['← ↑ → ↓', 'Move to the pane that way'],
  ['o', 'Next pane'],
  ['% or "', 'New chat beside this one'],
  ['x', 'Close this pane'],
  ['c', 'New tab'],
  ['n / p', 'Next / previous tab'],
  ['Ctrl-B', 'Send Ctrl-B to the agent'],
  ['?', 'This list']
]

const ARROWS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'])

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

export function isPrefixKey(e: KeyLike): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b'
}

export function prefixCommand(e: KeyLike): PrefixCommand | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  if (ARROWS[e.key]) return { kind: 'move', dir: ARROWS[e.key] }
  if (/^[1-9]$/.test(e.key)) return { kind: 'jump', index: Number(e.key) - 1 }
  switch (e.key) {
    case 'q':
      return { kind: 'numbers' }
    case 'z':
      return { kind: 'zoom' }
    case 'o':
      return { kind: 'next-pane' }
    case '%':
    case '"':
      return { kind: 'split' }
    case 'x':
      return { kind: 'close' }
    case 'c':
      return { kind: 'new-tab' }
    case 'n':
      return { kind: 'tab', step: 1 }
    case 'p':
      return { kind: 'tab', step: -1 }
    case '?':
      return { kind: 'help' }
  }
  return null
}

type Box = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>

export function paneInDirection(boxes: ReadonlyArray<{ id: string; box: Box }>, fromId: string, dir: Direction): string | null {
  const from = boxes.find((b) => b.id === fromId)?.box
  if (!from) return null
  const horizontal = dir === 'left' || dir === 'right'
  const mid = (b: Box): number => (horizontal ? (b.top + b.bottom) / 2 : (b.left + b.right) / 2)
  const gap = (b: Box): number =>
    dir === 'right' ? b.left - from.right : dir === 'left' ? from.left - b.right : dir === 'down' ? b.top - from.bottom : from.top - b.bottom
  let best: { id: string; score: number } | null = null
  for (const { id, box } of boxes) {
    if (id === fromId) continue
    const g = gap(box)
    if (g < -1) continue
    const score = g + Math.abs(mid(box) - mid(from)) * 2
    if (!best || score < best.score) best = { id, score }
  }
  return best?.id ?? null
}

type Phase = 'idle' | 'armed' | 'numbers' | 'help'

export function usePanePrefixKeys(
  rootRef: RefObject<HTMLElement | null>,
  run: (cmd: PrefixCommand) => void
): { phase: Phase; dismiss: () => void } {
  const [phase, setPhaseState] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const runRef = useRef(run)
  runRef.current = run
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  useEffect(() => {
    const ms = phase === 'armed' ? CONFIG.MIGHTY.PANE_PREFIX.ARMED_MS : phase === 'numbers' ? CONFIG.MIGHTY.PANE_PREFIX.NUMBERS_MS : 0
    if (ms === 0) return
    const timer = setTimeout(() => setPhase('idle'), ms)
    return () => clearTimeout(timer)
  }, [phase, setPhase])

  useEffect(() => {
    const swallow = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || MODIFIER_KEYS.has(e.key)) return
      if (!rootRef.current?.offsetParent) return
      const current = phaseRef.current
      if (current === 'idle') {
        if (!isPrefixKey(e)) return
        swallow(e)
        return setPhase('armed')
      }
      setPhase('idle')
      if (current === 'help') return swallow(e)
      const cmd = prefixCommand(e)
      if (current === 'numbers') {
        if (cmd?.kind !== 'jump' && e.key !== 'Escape') return
        swallow(e)
        if (cmd) runRef.current(cmd)
        return
      }
      if (isPrefixKey(e)) return
      swallow(e)
      if (!cmd) return
      if (cmd.kind === 'numbers' || cmd.kind === 'help') return setPhase(cmd.kind)
      runRef.current(cmd)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [rootRef, setPhase])

  return { phase, dismiss: () => setPhase('idle') }
}
