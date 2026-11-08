// Presentation-only grid layout for 1-6 panes with drag-to-resize row/col dividers.
// Knows nothing about MightySession/chat — the caller supplies opaque pane ids and a
// render-prop for pane content, and reads resize-ratio changes back out via onLayoutChange
// to persist (this component never writes to disk itself, per the design's split of concerns).
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { PaneLayoutState, PaneViewMode } from '../../../shared/types'
import {
  clampRatios,
  paneCountToPreset,
  resolveLayout,
  shouldUseStackedLayout
} from './pane-layout'
import { paneLifecycleLog, type PaneLayoutMode } from './pane-lifecycle-log'
import { CONFIG } from '../../../shared/config'

export interface PaneGridProps {
  /** Opaque pane ids, in grid slot order (index 0..5 maps to the preset's slot order
   *  for the current count). 1-6 entries — anything outside that range is the caller's
   *  bug (paneCountToPreset throws), not something PaneGrid silently tolerates. */
  paneIds: string[]
  /** Persisted ratios for this tab, or undefined for a fresh tab (falls back to an
   *  even split). PaneGrid treats this as read-only input — see onLayoutChange. */
  layout: PaneLayoutState | undefined
  /** Fired on drag-release (not on every pixel) with the full resolved layout, so the
   *  caller can persist it. PaneGrid holds no persistence concern of its own. */
  onLayoutChange: (next: PaneLayoutState) => void
  /** Render one pane's content by id. Kept as a render-prop rather than importing
   *  ConversationPane directly, so this file stays chat-agnostic and testable with a
   *  placeholder box. */
  renderPane: (paneId: string) => React.ReactNode
  /** 'single' shows only `soloPaneId`, with the rest kept MOUNTED but hidden — never
   *  filter them out of paneIds instead, or a background pane's streaming run dies
   *  with its unmounted session. Defaults to 'grid'. */
  viewMode?: PaneViewMode
  /** Which pane is visible in 'single' mode. Ignored in 'grid'. */
  soloPaneId?: string | null
  /** When false, skip ResizeObserver — background workspace tabs are hidden and
   *  measure 0px, which would flip stacked mode and remount every pane. */
  observeLayout?: boolean
}

export function PaneGrid({
  paneIds,
  layout,
  onLayoutChange,
  renderPane,
  viewMode = 'grid',
  soloPaneId,
  observeLayout = true
}: PaneGridProps): React.ReactElement {
  const count = paneIds.length
  if (count === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center text-sm text-muted">
        {CONFIG.UI_LABELS.CHAT_PANE_EMPTY_BODY}
      </div>
    )
  }
  const preset = paneCountToPreset(count)
  const resolved = resolveLayout(count, layout)

  const containerRef = useRef<HTMLDivElement>(null)
  const [stacked, setStacked] = useState(false)
  const stackedRef = useRef(stacked)
  stackedRef.current = stacked

  const applyStacked = useCallback(
    (width: number) => {
      const next = shouldUseStackedLayout(width)
      if (next === stackedRef.current) return
      const from: PaneLayoutMode = stackedRef.current ? 'stacked' : 'grid'
      const to: PaneLayoutMode = next ? 'stacked' : 'grid'
      paneLifecycleLog.layout(paneIds.length, from, to, width)
      setStacked(next)
    },
    [paneIds.length]
  )

  useEffect(() => {
    if (!observeLayout) return
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      applyStacked(width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [observeLayout, applyStacked])

  const [colRatios, setColRatios] = useState(resolved.colRatios)
  const [rowRatios, setRowRatios] = useState(resolved.rowRatios)
  // Re-sync local drag state whenever the caller hands us a different persisted layout
  // (tab switch, pane add/remove changing the preset) — but not on every render, or a
  // drag-in-progress would keep snapping back to the last-saved value.
  const layoutKey = `${count}:${layout?.colRatios?.join(',') ?? ''}:${layout?.rowRatios?.join(',') ?? ''}`
  const lastLayoutKey = useRef(layoutKey)
  if (lastLayoutKey.current !== layoutKey) {
    lastLayoutKey.current = layoutKey
    setColRatios(resolved.colRatios)
    setRowRatios(resolved.rowRatios)
  }

  const [draggingAxis, setDraggingAxis] = useState<'col' | 'row' | null>(null)

  // Shared drag machinery for both column and row dividers. `getFraction` converts a
  // mouse event to this axis's 0-1 position within the container so the same handler
  // serves col-drag (x/width) and row-drag (y/height) without duplicating the logic.
  const startDrag = useCallback(
    (axis: 'col' | 'row', dividerIndex: number, ratios: number[], setRatios: (r: number[]) => void) =>
      (e: React.MouseEvent) => {
        e.preventDefault()
        const el = containerRef.current
        if (!el) return
        setDraggingAxis(axis)
        const rect = el.getBoundingClientRect()
        const total = ratios.reduce((a, b) => a + b, 0)
        const startRatios = [...ratios]

        const fractionAt = (clientPos: number): number => {
          const size = axis === 'col' ? rect.width : rect.height
          const pos = axis === 'col' ? clientPos - rect.left : clientPos - rect.top
          return Math.min(Math.max(pos / size, 0), 1)
        }

        // Convert the divider's new absolute fraction into an updated pair of
        // neighboring ratios, leaving every other row/col untouched — a per-cell
        // arbitrary resize is out of scope.
        const applyAt = (clientPos: number): number[] => {
          const before = startRatios.slice(0, dividerIndex).reduce((a, b) => a + b, 0)
          const pairSum = startRatios[dividerIndex] + startRatios[dividerIndex + 1]
          const targetFraction = fractionAt(clientPos) * total
          const leftSize = Math.min(Math.max(targetFraction - before, 0), pairSum)
          const next = [...startRatios]
          next[dividerIndex] = leftSize
          next[dividerIndex + 1] = pairSum - leftSize
          return clampRatios(next, next.length)
        }

        const onMove = (ev: MouseEvent): void => {
          setRatios(applyAt(axis === 'col' ? ev.clientX : ev.clientY))
        }
        const onUp = (ev: MouseEvent): void => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          setDraggingAxis(null)
          const finalRatios = applyAt(axis === 'col' ? ev.clientX : ev.clientY)
          setRatios(finalRatios)
          onLayoutChange(
            axis === 'col' ? { colRatios: finalRatios, rowRatios } : { colRatios, rowRatios: finalRatios }
          )
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      },
    [colRatios, rowRatios, onLayoutChange]
  )

  // One pane fills the area, the others stay mounted behind `hidden` so their runs
  // keep streaming. Takes precedence over `stacked`: the user asked for one-at-a-time
  // explicitly, which is already the narrow-width answer stacking was reaching for.
  if (viewMode === 'single') {
    const solo = paneIds.includes(soloPaneId ?? '') ? soloPaneId : paneIds[0]
    return (
      <div ref={containerRef} className="h-full w-full min-w-0 min-h-0">
        {paneIds.map((id) => (
          <div
            key={id}
            className={`group relative h-full w-full overflow-hidden ${
              id === solo ? '' : 'hidden'
            }`}
          >
            {renderPane(id)}
          </div>
        ))}
      </div>
    )
  }

  if (stacked) {
    return (
      <div ref={containerRef} className="flex flex-col h-full w-full overflow-y-auto" style={{ gap: THEME_SPACE }}>
        {paneIds.map((id) => (
          <div
            key={id}
            className="group relative flex-shrink-0 min-h-[320px] rounded-xl border border-surface3 overflow-hidden"
          >
            {renderPane(id)}
          </div>
        ))}
      </div>
    )
  }

  // Row-major slot order matches paneCountToPreset's intent: 2x2/2x3 fill left-to-right
  // then top-to-bottom, so paneIds[0] is always top-left regardless of preset.
  const rows: string[][] = []
  if (preset === '2x2' || preset === '2x3') {
    const perRow = preset === '2x2' ? 2 : 3
    for (let r = 0; r < rowRatios.length; r++) {
      rows.push(paneIds.slice(r * perRow, r * perRow + perRow))
    }
  } else {
    rows.push(paneIds)
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full w-full min-w-0 min-h-0">
      {rows.map((rowPaneIds, rowIndex) => (
        <Fragment key={rowIndex}>
          <div className="flex min-w-0" style={{ flex: rowRatios[rowIndex], minHeight: 0 }}>
            {rowPaneIds.map((id, colIndex) => (
              <PaneCell
                key={id}
                // A short last row (5 panes in a 2x3) has fewer cells than there are
                // column ratios, so the per-column ratios don't describe it — reusing
                // them would leave the row's final slot as dead space. Such a row
                // splits its full width evenly instead.
                width={
                  rowPaneIds.length === colRatios.length ? colRatios[colIndex] : 1 / rowPaneIds.length
                }
                isLastCol={colIndex === rowPaneIds.length - 1}
                framed={paneIds.length > 1}
                onDividerDown={
                  rowPaneIds.length === colRatios.length && colIndex < rowPaneIds.length - 1
                    ? startDrag('col', colIndex, colRatios, setColRatios)
                    : undefined
                }
              >
                {renderPane(id)}
              </PaneCell>
            ))}
          </div>
          {rowIndex < rows.length - 1 && (
            <RowDivider
              rowIndex={rowIndex}
              active={draggingAxis === 'row'}
              onDown={startDrag('row', rowIndex, rowRatios, setRowRatios)}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
}

/** Injected inline because PaneGrid's gap needs a raw px number for flex math
 *  elsewhere in this file — kept as one constant rather than a Tailwind class so the
 *  stacked and grid layouts agree on the exact same spacing value. */
const THEME_SPACE = 'var(--space2)'

function PaneCell({
  width,
  isLastCol,
  framed,
  onDividerDown,
  children
}: {
  width: number
  isLastCol: boolean
  framed: boolean
  onDividerDown?: (e: React.MouseEvent) => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="relative flex min-w-0" style={{ flex: width }}>
      <div
        className={`group relative flex-1 min-w-0 overflow-hidden ${framed ? 'rounded-xl border border-surface3' : ''}`}
      >
        {children}
      </div>
      {!isLastCol && onDividerDown && (
        <div
          onMouseDown={onDividerDown}
          title="Drag to resize"
          className="relative flex-shrink-0 w-2 -mx-1 cursor-col-resize z-10 group"
        >
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-surface3 group-hover:bg-accent/50 group-hover:w-0.5 transition-colors" />
        </div>
      )}
    </div>
  )
}


function RowDivider({
  rowIndex,
  active,
  onDown
}: {
  rowIndex: number
  active: boolean
  onDown: (e: React.MouseEvent) => void
}): React.ReactElement {
  return (
    <div
      key={rowIndex}
      onMouseDown={onDown}
      title="Drag to resize"
      className="relative flex-shrink-0 h-2 -my-1 cursor-row-resize z-10 group"
    >
      <div
        className={`absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-surface3 group-hover:bg-accent/50 group-hover:h-0.5 transition-colors ${
          active ? 'bg-accent/50 h-0.5' : ''
        }`}
      />
    </div>
  )
}
