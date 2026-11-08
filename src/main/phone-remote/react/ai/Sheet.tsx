import type { ReactNode } from 'react'
import { Sheet as KitSheet } from '@shared/ui/Sheet'
import { Button } from '@shared/ui/Button'
import { hapticTick } from '../haptics'

export function Sheet(props: { label: string; onClose: () => void; children: ReactNode }): React.JSX.Element {
  return (
    <KitSheet
      {...props}
      className="aiSheet"
      scrimClassName="aiSheetScrim"
      gripClassName="aiSheetGrip"
      onSwipeClose={hapticTick}
    >
      <Button variant="bare" type="button" className="aiSheetDone" onClick={props.onClose}>
        Done
      </Button>
      {props.children}
    </KitSheet>
  )
}
