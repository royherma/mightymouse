import {
  AppWindow,
  Bot,
  Calendar,
  Camera,
  Clipboard,
  FileText,
  Globe,
  Link,
  Mail,
  MessageSquare,
  Mic,
  MicOff,
  Moon,
  Music,
  Play,
  Plug,
  Search,
  Send,
  Sparkles,
  Terminal,
  Volume2,
  Workflow,
  Zap
} from 'lucide-react'
import { useState } from 'react'
import type { ActionIconName, ActionProposal } from '../../../shared/action-engine'
import { COMPUTER_USE_ACTION_ID } from '../../../shared/action-engine'
import { AppIcon } from './AppIcon'
import { ChipPicker } from './ChipPicker'
import './ActionRows.css'
import { Button } from './Button'

const ACTION_ICONS: Record<ActionIconName, typeof Zap> = {
  zap: Zap,
  'app-window': AppWindow,
  'volume-2': Volume2,
  moon: Moon,
  camera: Camera,
  mic: Mic,
  'mic-off': MicOff,
  play: Play,
  terminal: Terminal,
  link: Link,
  workflow: Workflow,
  send: Send,
  sparkles: Sparkles,
  clipboard: Clipboard,
  globe: Globe,
  music: Music,
  mail: Mail,
  calendar: Calendar,
  'message-square': MessageSquare,
  'file-text': FileText,
  search: Search,
  bot: Bot,
  plug: Plug
}

const ICON_SIZE = 15

/** Runner-up rows beyond this stay folded — enough to show the pick was ranked
 *  rather than guessed, short of turning a confirmation into a menu. */
const COLLAPSED_ROWS = 3

// The row wears the icon of the app it acts on, taken from its own app chip.
function rowApp(p: ActionProposal): string {
  return p.chips.find((c) => c.key === 'app')?.value ?? ''
}

export interface ActionRowsProps {
  proposals: ActionProposal[]
  selectedId: string
  busyId: string
  doneId: string
  doneOk: boolean
  stopping?: boolean
  /** Cmd is down: label each row with the full chord that runs it. */
  showNumbers?: boolean
  onSelect: (proposalId: string) => void
  onConfirm: (proposalId: string) => void
  onChipChange?: (proposalId: string, slotKey: string, value: string) => void
  onClose?: () => void
  onStop?: () => void
}

export function ActionIcon({ name }: { name: ActionIconName }): React.JSX.Element {
  const Glyph = ACTION_ICONS[name]
  return <Glyph size={ICON_SIZE} strokeWidth={2} />
}

export function ActionRows({
  proposals,
  selectedId,
  busyId,
  doneId,
  doneOk,
  stopping,
  showNumbers,
  onSelect,
  onConfirm,
  onChipChange,
  onClose,
  onStop
}: ActionRowsProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  if (proposals.length === 0) return null

  const hidden = proposals.length - COLLAPSED_ROWS
  const shown = expanded ? proposals : proposals.slice(0, COLLAPSED_ROWS)

  return (
    <div className="actrow-list">
      {shown.map((p, i) => {
        const selected = p.proposalId === selectedId
        const busy = p.proposalId === busyId
        const done = p.proposalId === doneId
        const locked = busyId !== '' || doneId !== ''
        const canClose = done && doneOk && onClose !== undefined
        const canRetry = done && !doneOk
        const isComputerUseBusy = busy && p.actionId === COMPUTER_USE_ACTION_ID
        return (
          <div
            key={p.proposalId}
            className={`actrow${selected ? ' is-selected' : ''}${busy ? ' is-busy' : ''}${done ? ' is-done' : ''}`}
          >
            <Button
              variant="bare"
              className="actrow-main"
              disabled={locked}
              onClick={() => (selected ? onConfirm(p.proposalId) : onSelect(p.proposalId))}
            >
              {showNumbers === true && <span className="actrow-num">⌘⌥⇧{i + 1}</span>}
              {rowApp(p) !== '' ? (
                <span className="actrow-appicon">
                  <AppIcon app={rowApp(p)} size={ICON_SIZE} />
                </span>
              ) : (
                <span className="actrow-glyph">
                  <ActionIcon name={p.icon} />
                </span>
              )}
              <span className="actrow-title">{p.title}</span>
            </Button>

            {p.chips.length > 0 && (
              <span className="actrow-chips">
                {p.chips.map((chip) => (
                  <ChipPicker
                    key={chip.key}
                    chip={chip}
                    disabled={locked}
                    onChange={(slotKey, value) => onChipChange?.(p.proposalId, slotKey, value)}
                  />
                ))}
              </span>
            )}

            <span className="actrow-pct">{p.percent}%</span>

            {/* Only the selected row carries the button: the whole point is one
                obvious thing to press, and a button per row is the menu this
                surface exists to avoid. */}
            {selected && (
              <Button
                variant="bare"
                className="actrow-confirm"
                disabled={isComputerUseBusy ? stopping === true : locked && !canClose && !canRetry}
                onClick={() =>
                  canClose ? onClose() : isComputerUseBusy ? onStop?.() : onConfirm(p.proposalId)
                }
              >
                {canClose
                  ? 'Close'
                  : canRetry
                    ? 'Retry'
                    : done
                      ? 'Done'
                      : isComputerUseBusy
                        ? stopping
                          ? 'Stopping…'
                          : 'Stop (Esc)'
                        : busy
                          ? 'Doing it…'
                          : p.safety === 'confirm'
                            ? 'Yes, do it'
                            : 'Do it'}
              </Button>
            )}
          </div>
        )
      })}

      {hidden > 0 && (
        <Button variant="bare" className="actrow-more" onClick={() => setExpanded((open) => !open)}>
          {expanded ? 'Show less' : `${hidden} more`}
        </Button>
      )}
    </div>
  )
}
