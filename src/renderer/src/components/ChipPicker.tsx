import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ActionChip } from '../../../shared/action-engine'
import { AppIcon } from './AppIcon'
import { filterOptions } from '../../../shared/rank-options'
import { CONFIG } from '../../../shared/config'
import './ChipPicker.css'
import { Button } from './Button'

const CHIP_ICON_SIZE = 12
const ARROW_SIZE = 10
const FILTER_LIMIT = 50

// Only an app-valued slot resolves to a bundle icon; '#general' is a channel, not an app.
function isAppSlot(slotKey: string): boolean {
  return slotKey === 'app'
}

export interface ChipPickerProps {
  chip: ActionChip
  disabled: boolean
  onChange: (slotKey: string, value: string) => void
}

export function ChipPicker({ chip, disabled, onChange }: ChipPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const isApp = isAppSlot(chip.key)
  const options = useMemo(() => chip.options ?? [], [chip.options])
  const unsure =
    chip.confidence !== undefined && chip.confidence < CONFIG.ACTIONS.CHIP_UNSURE_CONFIDENCE

  const shown = useMemo(() => filterOptions(options, filter, FILTER_LIMIT), [options, filter])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setOpen(false)
        setFilter('')
        setActive(0)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  if (options.length < 2) {
    return (
      <span className="actrow-chip" title={chip.label}>
        <ChipFace chip={chip} />
      </span>
    )
  }

  const close = (): void => {
    setOpen(false)
    setFilter('')
    setActive(0)
  }

  const choose = (value: string): void => {
    close()
    if (value !== chip.value) onChange(chip.key, value)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (shown.length === 0 ? 0 : (i + step + shown.length) % shown.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const pick = shown[active]
      if (pick) choose(pick.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <div className="chippick" ref={boxRef}>
      <Button
        variant="bare"
        className={`actrow-chip chippick-btn${unsure ? ' is-unsure' : ''}`}
        title={chip.label}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <ChipFace chip={chip} />
        <ChevronDown size={ARROW_SIZE} strokeWidth={2.5} />
      </Button>

      {open && (
        <div className="chippick-menu" onKeyDown={onKeyDown}>
          <input
            ref={inputRef}
            className="chippick-filter"
            value={filter}
            placeholder="Type to filter"
            onChange={(e) => {
              setFilter(e.target.value)
              setActive(0)
            }}
          />
          {shown.length === 0 ? (
            <div className="chippick-empty">Nothing matches</div>
          ) : (
            <div className="chippick-list">
              {shown.map((opt, i) => (
                <Button
                  variant="bare"
                  key={opt.value}
                  className={`chippick-item${i === active ? ' is-active' : ''}${
                    opt.value === chip.value ? ' is-current' : ''
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(opt.value)}
                >
                  {isApp && <AppIcon app={opt.value} size={CHIP_ICON_SIZE} />}
                  <span className="chippick-item-label">{opt.label}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ChipFace({ chip }: { chip: ActionChip }): React.JSX.Element {
  return (
    <>
      {isAppSlot(chip.key) && <AppIcon app={chip.value} size={CHIP_ICON_SIZE} />}
      {chip.value}
    </>
  )
}
