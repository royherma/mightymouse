import { useEffect, useState } from 'react'
import { Check, LayoutGrid, Square, SquareTerminal, type LucideIcon } from 'lucide-react'
import { Button } from './Button'
import { useHoverIntent } from '../hooks/useHoverIntent'

export const SHOW_STEPS_KEY = 'mm.code.showSteps'
export const CHAT_SHOW_STEPS_KEY = 'mm.chat.showSteps'
const TERMINAL_VIEW_KEY = 'mm.code.terminalView'

export function useSharedFlag(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const read = (): boolean => {
    try {
      const stored = localStorage.getItem(key)
      return stored === null ? fallback : stored === 'true'
    } catch {
      return fallback
    }
  }
  const [on, setOn] = useState(read)
  useEffect(() => {
    const sync = (): void => setOn(read())
    window.addEventListener(key, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(key, sync)
      window.removeEventListener('storage', sync)
    }
  }, [key])
  const set = (next: boolean): void => {
    setOn(next)
    try {
      localStorage.setItem(key, String(next))
    } catch {
      // localStorage unavailable - the choice just doesn't outlive the window.
    }
    window.dispatchEvent(new Event(key))
  }
  return [on, set]
}

export function useTerminalView(): [boolean, (next: boolean) => void] {
  return useSharedFlag(TERMINAL_VIEW_KEY, false)
}

type ViewMode = 'one' | 'grid' | 'terminal'

const MODES: ReadonlyArray<{ id: ViewMode; label: string; hint?: string; icon: LucideIcon }> = [
  { id: 'one', label: 'One at a time', icon: Square },
  { id: 'grid', label: 'Side by side', hint: '⌘⇧G', icon: LayoutGrid },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal }
]

export function ViewModeMenu(props: {
  nerdMode: boolean
  setNerdMode: (on: boolean) => void
  withTerminal: boolean
}): React.JSX.Element {
  const { nerdMode, setNerdMode, withTerminal } = props
  const [terminalView, setTerminalView] = useTerminalView()
  const [open, setOpen] = useState(false)
  const { cancelClose, scheduleClose } = useHoverIntent(() => setOpen(false))

  useEffect(() => {
    if (nerdMode && terminalView) setTerminalView(false)
  }, [nerdMode])

  const current: ViewMode = nerdMode ? 'grid' : withTerminal && terminalView ? 'terminal' : 'one'
  const modes = withTerminal ? MODES : MODES.filter((m) => m.id !== 'terminal')
  const Icon = MODES.find((m) => m.id === current)!.icon

  const choose = (mode: ViewMode): void => {
    if (mode === 'terminal') setTerminalView(true)
    else if (withTerminal) setTerminalView(false)
    setNerdMode(mode === 'grid')
    setOpen(false)
  }

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <Button
        variant="icon"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="View"
        className={`w-7 h-7 ${current !== 'one' ? 'text-accent-text bg-accent-wash' : ''}`}
      >
        <Icon size={15} />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[190px] rounded-lg border border-surface3 bg-bg p-1 shadow-[var(--shadow-popover)]"
        >
          {modes.map((mode) => (
            <Button
              key={mode.id}
              variant="bare"
              role="menuitemradio"
              aria-checked={current === mode.id}
              onClick={() => choose(mode.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-on-surface hover:bg-surface2"
            >
              <mode.icon size={14} className="text-muted" />
              <span className="flex-1">{mode.label}</span>
              {mode.hint && <kbd className="text-[11px] text-muted">{mode.hint}</kbd>}
              <Check size={13} className={current === mode.id ? 'text-accent-text' : 'invisible'} />
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
