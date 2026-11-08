import { useEffect, useRef, useState, type RefObject } from 'react'
import { ChevronDown, Check } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import type { ModelCatalogEntry } from '../../../shared/types'
import { ProviderIcon, providerIconFor, type ProviderIconId } from './ProviderIcon'
import { Button } from './Button'

/**
 * Per-conversation model picker for the paid `mightymouse` backend.
 *
 * Renders ONLY when that backend is active (the caller gates on `backend ===
 * 'mightymouse'`) — the free BYO backends run a fixed model and have no picker.
 * The options come from useModelCatalog (server-served, cached; the
 * server's allowed_models is the real gate). An empty value means "let the server
 * route by feature" — surfaced as the first "Auto" option so the default is a real,
 * selectable choice, not a blank.
 *
 * A custom compact dropdown, NOT a native <select>: the closed control now hugs
 * its content (provider icon + short label) instead of stretching full-width. The
 * open menu is an absolutely-positioned panel INSIDE this component (same recipe
 * as EmojiPicker.tsx / the history-filter popup), anchored `right: 0` so it drops
 * down-and-left from the pill.
 *
 * The menu is `position: absolute` — out of layout flow — so it does NOT add to
 * PanelApp's measured content height, and the panel BrowserWindow is short
 * (PANEL_MIN_H ~240px). Left alone the menu would clip against the window's real
 * pixel bounds (see the fixed-overlay gotcha in CLAUDE.md: nothing escapes the
 * BrowserWindow, position:absolute included). PanelApp.tsx solves this the same
 * way it already solves it for the history-filter popup (`filterPopRef`): it holds
 * a ref to this menu (`menuRef` prop) and grows its resize request to cover the
 * menu's bottom edge whenever `onOpenChange` reports the menu open. The
 * `max-height` + `overflow-y: auto` below is the second line of defense — even if
 * the window can't grow far enough (rare: right near the bottom of a display), the
 * menu scrolls internally instead of spilling off-window.
 */

// Tier → the color family the quiet tier hint borrows. Kept as a muted signal,
// not a shout (see .model-picker-tier — low weight, small, desaturated via the
// -border-subtle/-bg-subtle tokens rather than the loud saturated base color).
const TIER_COLOR: Record<'cheap' | 'mid' | 'premium', string> = {
  cheap: 'green',
  mid: 'blue',
  premium: 'amber'
}

export function useModelCatalog(): ModelCatalogEntry[] {
  const [models, setModels] = useState<ModelCatalogEntry[]>(CONFIG.MODEL_CATALOG)
  useEffect(() => {
    let alive = true
    void window.api.getModelCatalog().then((m) => alive && setModels(m))
    const off = window.api.onModelCatalogChanged(setModels)
    return () => {
      alive = false
      off()
    }
  }, [])
  return models
}

export function ModelPicker({
  value,
  onChange,
  menuRef,
  onOpenChange
}: {
  /** Currently-selected OpenRouter slug, or '' for the server default (Auto). */
  value: string
  /** Called with the new slug ('' = Auto). The caller persists via IPC + state. */
  onChange: (model: string) => void
  /** Forwarded to the open menu's root div so PanelApp can measure its bottom
   *  edge (mirrors filterPopRef) and grow the window to fit it — see file header. */
  menuRef?: RefObject<HTMLDivElement | null>
  /** Fired whenever the menu opens/closes so PanelApp can re-run its window
   *  auto-fit (mirrors the `filterOpen` dependency on the history popup). */
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const models = useModelCatalog()

  const selected = models.find((m) => m.id === value)
  const currentIcon: ProviderIconId = selected ? providerIconFor(selected.id) : 'auto'
  const currentLabel = selected ? selected.label : 'Auto'

  function setOpenAndNotify(next: boolean): void {
    setOpen(next)
    onOpenChange?.(next)
  }

  // Close on outside-click + Esc — same recipe as EmojiPicker.tsx. mousedown (not
  // click) so it fires before other handlers; capture phase so it beats bubbling.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenAndNotify(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpenAndNotify(false)
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function pick(id: string): void {
    onChange(id)
    setOpenAndNotify(false)
  }

  return (
    <div className="model-picker" ref={ref}>
      <Button
        variant="bare"
        className="model-picker-trigger"
        title="Pick the model for this conversation"
        aria-haspopup="listbox"
        aria-expanded={open}
        // Don't let a click bubble to parent handlers (the footer row has its
        // own click targets like the backend chip).
        onClick={(e) => {
          e.stopPropagation()
          setOpenAndNotify(!open)
        }}
      >
        <ProviderIcon id={currentIcon} size={13} />
        <span className="model-picker-label">{currentLabel}</span>
        <ChevronDown size={11} strokeWidth={2.5} className="model-picker-chevron" />
      </Button>

      {open && (
        <div className="model-picker-menu" role="listbox" aria-label="Model" ref={menuRef}>
          <Button
            variant="bare"
            role="option"
            aria-selected={value === ''}
            className={`model-picker-row ${value === '' ? 'selected' : ''}`}
            onClick={() => pick('')}
          >
            <ProviderIcon id="auto" size={14} />
            <span className="model-picker-row-label">Auto</span>
            {value === '' && <Check size={13} strokeWidth={2.5} className="model-picker-check" />}
          </Button>
          {models.map((m) => (
            <Button
              variant="bare"
              key={m.id}
              role="option"
              aria-selected={m.id === value}
              className={`model-picker-row ${m.id === value ? 'selected' : ''}`}
              onClick={() => pick(m.id)}
            >
              <ProviderIcon id={providerIconFor(m.id)} size={14} />
              <span className="model-picker-row-label">{m.label}</span>
              <span
                className="model-picker-tier"
                style={{
                  color: `var(--${TIER_COLOR[m.tier]})`,
                  background: `var(--${TIER_COLOR[m.tier]}-bg-subtle)`
                }}
              >
                {CONFIG.MODEL_TIER_LABEL[m.tier]}
              </span>
              {m.id === value && <Check size={13} strokeWidth={2.5} className="model-picker-check" />}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
