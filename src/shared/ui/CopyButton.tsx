import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Check, Copy, X } from 'lucide-react'
import { Button } from './Button'

export const ICON_SIZE = 15

type CopyResult = boolean | void
type CopyState = 'idle' | 'done' | 'failed'

// Electron's window.api.copy works in unfocused windows (HUD, panel); navigator.clipboard throws there.
function writeClipboard(text: string): Promise<CopyResult> {
  const api = (globalThis as { api?: { copy?: (t: string) => void } }).api
  if (api?.copy) {
    api.copy(text)
    return Promise.resolve(true)
  }
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false
  )
}

export function CopyButton({
  text,
  copy,
  label = 'Copy',
  doneLabel = 'Copied',
  failedLabel = "Couldn't copy",
  showLabel = false,
  disabled,
  className = ''
}: {
  text?: string
  copy?: () => Promise<CopyResult> | CopyResult
  label?: string
  doneLabel?: string
  failedLabel?: string
  showLabel?: boolean
  disabled?: boolean
  className?: string
}): JSX.Element {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const run = async (): Promise<void> => {
    let ok: CopyResult = false
    try {
      ok = copy ? await copy() : text !== undefined ? await writeClipboard(text) : false
    } catch {
      ok = false
    }
    setState(ok === false ? 'failed' : 'done')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1600)
  }

  const shown = state === 'done' ? doneLabel : state === 'failed' ? failedLabel : label
  const tone = state === 'done' ? 'text-green' : state === 'failed' ? 'text-red' : ''
  const Icon = state === 'done' ? Check : state === 'failed' ? X : Copy
  return (
    <Button
      variant="quiet"
      title={shown}
      aria-label={shown}
      disabled={disabled}
      onClick={() => void run()}
      className={`${showLabel ? 'gap-1.5 px-2 text-sm font-semibold' : ''} ${tone} ${className}`.trim()}
    >
      <Icon size={ICON_SIZE} />
      {showLabel && shown}
    </Button>
  )
}
