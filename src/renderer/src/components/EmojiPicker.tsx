import React, { useEffect, useRef } from 'react'
import { CONFIG } from '../../../shared/config'
import { Button } from './Button'

interface Props {
  /** Currently-selected glyph — highlighted in the grid. */
  value: string
  onPick: (emoji: string) => void
  onClose: () => void
}

// A built-in emoji grid for the shortcut icon field. Deliberately NOT the macOS
// emoji picker: the shortcuts editor is a focused overlay window, and invoking the
// OS picker (or clicking outside to it) steals focus and dismisses the modal. This
// popover lives inside the modal, so picking never loses the window. The glyph set
// is curated in CONFIG.SHORTCUT_ICONS (one home, no magic literals).
export default function EmojiPicker({ value, onPick, onClose }: Props): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside-click (within the modal window) + Esc. Esc is captured here
  // and stopped so it closes the picker without also closing the whole modal.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    // mousedown (not click) so it fires before the field's own handlers.
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div className="emoji-picker" ref={ref} role="listbox" aria-label={CONFIG.UI_LABELS.SHORTCUT_ICON_PICK_HINT}>
      {CONFIG.SHORTCUT_ICONS.map((e) => (
        <Button
          variant="bare"
          key={e}
          role="option"
          aria-selected={e === value}
          className={`emoji-picker-cell ${e === value ? 'selected' : ''}`}
          onClick={() => { onPick(e); onClose() }}
        >
          {e}
        </Button>
      ))}
    </div>
  )
}
