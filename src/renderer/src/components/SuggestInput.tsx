import { useId, useMemo, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { Button } from './Button'
import { useEscape } from '../hooks/useEscape'

export function SuggestInput({
  label,
  value,
  ideas,
  placeholder,
  onChange
}: {
  label: string
  value: string
  ideas: readonly string[]
  placeholder?: string
  onChange: (value: string) => void
}): JSX.Element {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const shown = useMemo(() => {
    const typed = value.trim().toLowerCase()
    const picked = ideas.some((idea) => idea.toLowerCase() === typed)
    return typed && !picked ? ideas.filter((idea) => idea.toLowerCase().includes(typed)) : ideas
  }, [ideas, value])
  const showing = open && shown.length > 0

  useEscape(() => setOpen(false), showing)

  const pick = (idea: string): void => {
    onChange(idea)
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!showing) return setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + shown.length) % shown.length)
    } else if (e.key === 'Enter' && showing && shown[active]) {
      e.preventDefault()
      pick(shown[active])
    }
  }

  return (
    <label className="relative flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <input
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
        className="rounded-lg bg-surface2 border border-surface3 px-3 py-2 text-sm outline-none focus:border-accent focus:shadow-focus"
      />
      {showing && (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-44 overflow-y-auto rounded-lg border border-surface3 bg-[var(--surface-solid)] p-1 shadow-popover"
        >
          {shown.map((idea, i) => (
            <Button
              key={idea}
              variant="bare"
              type="button"
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(idea)}
              className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-sm ${
                i === active ? 'bg-surface3 text-on-surface' : 'text-on-surface'
              }`}
            >
              {idea}
            </Button>
          ))}
        </div>
      )}
    </label>
  )
}
