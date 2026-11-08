// WindowLayoutSheet.tsx — arrange your Mac's windows from the phone.
//
// Opened by holding the Settings button for a second. Its own component for
// the reason AppSwitchGrid gives: two layouts have held byte-identical copies
// of a control before, and a fix to one missed the other.

import { useState } from 'react'
import AppSwitchGrid, { type AppSwitchGridItem } from './AppSwitchGrid'
import type { WindowLayoutKind } from '@shared/phone-remote-protocol'
import { Button } from '@shared/ui/Button'

/**
 * `glyph` is a CSS hook rather than a pane list -- two panes side by side and
 * two panes stacked are the same COUNT, so the preview has to name the
 * arrangement or "Side by side" and "Stacked" draw an identical picture.
 */
interface LayoutChoice {
  kind: WindowLayoutKind
  label: string
  glyph: WindowLayoutKind
}

const TWO_APP_CHOICES: LayoutChoice[] = [
  { kind: 'leftRight', label: 'Side by side', glyph: 'leftRight' },
  { kind: 'topBottom', label: 'Stacked', glyph: 'topBottom' },
  { kind: 'quarters', label: 'Both up top', glyph: 'quarters' }
]

const ONE_APP_CHOICES: LayoutChoice[] = [
  { kind: 'left', label: 'Left half', glyph: 'left' },
  { kind: 'right', label: 'Right half', glyph: 'right' },
  { kind: 'full', label: 'Whole screen', glyph: 'full' }
]

export default function WindowLayoutSheet(props: {
  apps: AppSwitchGridItem[] | null
  /** Frontmost app right now, used to pre-fill the first slot. */
  frontBundleId: string | null
  canRestore: boolean
  onApply: (kind: WindowLayoutKind, bundleIds: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const { apps, frontBundleId, canRestore, onApply, onClose } = props

  // `undefined` is untouched (use the pre-fill); `null` is cleared with the X.
  // One null for both would re-fill a cleared slot from the default.
  const [slotA, setSlotA] = useState<string | null | undefined>(undefined)
  const [slotB, setSlotB] = useState<string | null | undefined>(undefined)
  /** Which slot the app picker is currently choosing for, or null when closed. */
  const [picking, setPicking] = useState<'a' | 'b' | null>(null)

  const list = apps ?? []
  const defaultA = frontBundleId ?? list[0]?.bundleId ?? null
  const defaultB = list.find((a) => a.bundleId !== defaultA)?.bundleId ?? null
  const appA = slotA === undefined ? defaultA : slotA
  const appB = slotB === undefined ? defaultB : slotB
  const filled = [appA, appB].filter((id): id is string => id !== null).length

  const appOf = (bundleId: string | null): AppSwitchGridItem | undefined =>
    list.find((a) => a.bundleId === bundleId)

  // Whichever slot is filled -- clearing the FIRST leaves a one-app layout too.
  const onlyApp = appOf(appA) ?? appOf(appB)
  const caption =
    filled === 0
      ? 'Pick an app to arrange'
      : filled === 2
        ? 'Where to put both'
        : `Where to put ${onlyApp?.name ?? 'it'}`

  const apply = (kind: WindowLayoutKind): void => {
    // Slot order IS the wire order, and the Mac uses only as many as the layout
    // has frames -- so a one-app layout acts on slot 1 without a re-pick.
    const ids = [appA, appB].filter((id): id is string => id !== null)
    if (ids.length === 0) return
    // Stays open on purpose: trying arrangements is the point, and closing made
    // every second try a fresh long-press.
    onApply(kind, ids)
  }

  if (picking !== null) {
    return (
      <div className="windowLayoutSheet">
        <div className="windowLayoutHead">
          <span>{picking === 'a' ? 'First app' : 'Second app'}</span>
          <Button variant="bare" className="windowLayoutClose" onClick={() => setPicking(null)}>
            Back
          </Button>
        </div>
        <AppSwitchGrid
          apps={apps}
          frontBundleId={frontBundleId}
          // The apps in the layout, not what is in front: this picks a slot.
          selectedBundleIds={[appA, appB].filter((id): id is string => id !== null)}
          onPick={(bundleId) => {
            // Picking the OTHER slot's app swaps them, rather than tiling one
            // app against itself.
            if (picking === 'a') {
              if (bundleId === appB) setSlotB(appA)
              setSlotA(bundleId)
            } else {
              if (bundleId === appA) setSlotA(appB)
              setSlotB(bundleId)
            }
            setPicking(null)
          }}
        />
      </div>
    )
  }

  return (
    <div className="windowLayoutSheet">
      <div className="windowLayoutHead">
        <span>Arrange windows</span>
        <Button variant="bare" className="windowLayoutClose" onClick={onClose}>
          Done
        </Button>
      </div>

      <div className="windowLayoutSlots">
        <SlotButton
          app={appOf(appA)}
          onClick={() => setPicking('a')}
          onClear={() => setSlotA(null)}
        />
        <SlotButton
          app={appOf(appB)}
          onClick={() => setPicking('b')}
          onClear={() => setSlotB(null)}
        />
      </div>

      {/* Both rows draw the same shapes, so the swap is easy to miss. */}
      <p className="windowLayoutCaption">{caption}</p>

      {/* Absent, not dimmed: a greyed "Side by side" beside a live "Whole
          screen" reads as broken rather than as not-applicable. */}
      <div className="windowLayoutGroup">
        {(filled === 2 ? TWO_APP_CHOICES : ONE_APP_CHOICES).map((choice) => (
          <Button
            variant="bare"
            key={choice.kind}
            className="windowLayoutChoice"
            disabled={filled === 0}
            onClick={() => apply(choice.kind)}
          >
            <LayoutGlyph glyph={choice.glyph} />
            <span>{choice.label}</span>
          </Button>
        ))}
      </div>

      {/* Hidden, not disabled: an always-visible Restore reads as a promise to
          put ANY window back, and the stash holds only the last arrangement. */}
      {canRestore && (
        <Button variant="secondary" onClick={() => apply('restore')}>
          Put them back
        </Button>
      )}
    </div>
  )
}

/** The X is a real <button>, never a hit-test on the parent's tap coords. */
function SlotButton(props: {
  app: AppSwitchGridItem | undefined
  onClick: () => void
  onClear: () => void
}): React.JSX.Element {
  const { app, onClick, onClear } = props
  if (!app) {
    return (
      <Button
        variant="bare"
        className="windowLayoutSlot windowLayoutSlotEmpty"
        onClick={onClick}
        aria-label="Add an app"
      >
        +
      </Button>
    )
  }
  return (
    <div className="windowLayoutSlot">
      <Button variant="bare" className="windowLayoutSlotPick" onClick={onClick}>
        {app.iconPngBase64 ? (
          <img src={`data:image/png;base64,${app.iconPngBase64}`} alt="" />
        ) : (
          <span className="appRowIconPlaceholder" />
        )}
        <span>{app.name}</span>
      </Button>
      <Button variant="bare" className="windowLayoutSlotClear" onClick={onClear} aria-label={`Remove ${app.name}`}>
        ✕
      </Button>
    </div>
  )
}

/**
 * The little preview inside a layout button.
 *
 * One filled pane per window the layout moves, on a screen-shaped frame. The
 * arrangement is entirely CSS off `data-glyph` -- see `.windowLayoutGlyph` in
 * theme.css.
 */
function LayoutGlyph(props: { glyph: WindowLayoutKind }): React.JSX.Element {
  return (
    <span className="windowLayoutGlyph" data-glyph={props.glyph} aria-hidden="true">
      <span className="windowLayoutPane" />
      <span className="windowLayoutPane" />
    </span>
  )
}
