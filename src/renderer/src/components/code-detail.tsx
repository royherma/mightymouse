/**
 * One relay request on its own, with paging to its neighbours -- the Mac's half
 * of the phone's CodeDetail.
 *
 * Split out of CodePanel.tsx for the same reason the phone split its own: the
 * list and the single-card view stay separately readable, and they share only
 * the card, which is imported rather than reimplemented. The state (which id is
 * open, and the list that id indexes into) lives in CodePanel, because the list
 * is what re-sorts and re-filters under this view; this file owns the chrome.
 *
 * Input is where the two surfaces part company: the phone pages by swipe, this
 * pages by ←/→ and two buttons. A pointer-drag on a desktop is a text selection,
 * not a gesture.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { RelayCard, type SenderProject } from './relay-card'
import type { RelayRequestWire, RelayResponseWire } from '../../../shared/phone-remote-protocol'
import { Button } from './Button'

export function CodeDetail(props: {
  request: RelayRequestWire
  /** Position within the visible list, both for the counter and for the ends. */
  index: number
  total: number
  onPage: (delta: 1 | -1) => void
  onBack: () => void
  onRespond: (requestId: string, response: RelayResponseWire) => void
  project?: SenderProject
}): React.JSX.Element {
  const { request, index, total, onPage, onBack, onRespond, project } = props

  return (
    <div className="code-detail">
      <div className="code-detail-bar">
        <Button variant="bare" className="code-detail-back" onClick={onBack}>
          <ChevronLeft size={13} strokeWidth={2.5} />
          All cards
        </Button>
        {/* Position, not a page-dot row: a queue of blocked agents can be 20
            long, and "3 of 12" stays readable where dots do not. */}
        <span className="code-detail-pos">
          {index + 1} of {total}
        </span>
      </div>

      <div className="code-detail-scroll">
        {/* The SAME card component as the list. A second full-size
            implementation of four verbs is how the two would start disagreeing
            about what an approve looks like. No `onExpand` here: the card must
            not offer to open itself. */}
        <RelayCard
          key={request.id}
          request={request}
          showSender
          onRespond={onRespond}
          project={project}
        />
      </div>

      {/* Buttons as well as the arrow keys: a key binding is undiscoverable, and
          the keys are dead while a draft field has focus. Disabled rather than
          hidden at the ends -- a vanishing button moves its neighbour under the
          cursor mid-click. */}
      <div className="code-detail-nav">
        <Button
          variant="bare"
          className="code-detail-nav-btn"
          disabled={index <= 0}
          onClick={() => onPage(-1)}
        >
          <ChevronLeft size={13} strokeWidth={2.5} />
          Back
        </Button>
        <Button
          variant="bare"
          className="code-detail-nav-btn"
          disabled={index >= total - 1}
          onClick={() => onPage(1)}
        >
          Next
          <ChevronRight size={13} strokeWidth={2.5} />
        </Button>
      </div>
    </div>
  )
}
