import { JSX } from 'react'
import { Button } from './Button'
import { Modal } from './Modal'

/**
 * The app's one confirmation gate for destructive actions (delete a capture,
 * drop a session, …). Before this existed, the Media Library deleted on a single
 * click with no undo — a misclick trashed a recording outright.
 *
 * Deliberately dumb: the caller owns the "what am I confirming" state and the
 * action itself. Escape and a backdrop click both cancel, so the safe way out is
 * always the easy one; the confirm button is the only path that destroys.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  onConfirm,
  onCancel
}: {
  title: string
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button. Off for a neutral "are you sure" with no data loss. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <Modal
      label={title}
      onClose={onCancel}
      backdropClassName="fixed inset-0 z-50 flex items-center justify-center p-6"
      backdropStyle={{ background: 'rgba(0,0,0,0.45)' }}
      className="w-full max-w-[340px] rounded-lg p-4 flex flex-col gap-3"
      style={{
        background: 'var(--surface1)',
        border: '1px solid var(--surface3)',
        boxShadow: 'var(--shadow-panel)'
      }}
    >
      <div className="text-md font-semibold text-on-surface">{title}</div>
      {body && <div className="text-sm text-muted leading-snug">{body}</div>}
      <div className="flex items-center justify-end gap-2 mt-1">
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          autoFocus
          variant="primary"
          onClick={onConfirm}
          className={danger ? 'border-0' : ''}
          style={danger ? { background: 'var(--red)', color: 'var(--surface1)' } : undefined}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}
