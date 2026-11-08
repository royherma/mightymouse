import { useEffect, useRef, useState, type JSX } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { Button } from './Button'

export interface MultiSelectOption {
  value: string
  label: string
}

/**
 * A compact multi-select checklist behind a single button — for cases where N
 * separate Switches would clutter the card (e.g. "applies to" toggles). Closes
 * on outside-click or Esc, mirrors EmojiPicker's popover pattern. No Radix
 * dropdown/checkbox package is installed, so this is hand-rolled from Switch's
 * existing button + Radix Select's popover styling conventions.
 */
export function MultiSelectDropdown({
  options,
  selected,
  onChange,
  summary
}: {
  options: MultiSelectOption[]
  selected: Set<string>
  onChange: (value: string) => void
  /** Label shown on the closed button, e.g. "All" or "2 selected". */
  summary: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className="relative inline-block" ref={ref}>
      <Button
        variant="secondary" size="lg"
        onClick={() => setOpen((v) => !v)}
      >
        {summary}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </Button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-10 mt-1 min-w-[9rem] bg-surface2 rounded-lg shadow-focus py-1 border border-white/10"
        >
          {options.map((opt) => {
            const isOn = selected.has(opt.value)
            return (
              <Button
                variant="bare"
                key={opt.value}
                role="option"
                aria-selected={isOn}
                onClick={() => onChange(opt.value)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-surface3 transition-colors"
              >
                <span
                  className={`flex items-center justify-center w-4 h-4 rounded shrink-0 ${isOn ? 'bg-accent' : 'bg-surface3'}`}
                >
                  {isOn && <Check size={12} className="text-white" strokeWidth={3} />}
                </span>
                {opt.label}
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )
}
