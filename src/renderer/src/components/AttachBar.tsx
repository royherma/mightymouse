import { useEffect, useState, type JSX } from 'react'
import { Plus, Image as ImageIcon, FileAudio, FileText, X } from 'lucide-react'
import type { AttachmentKind, MediaAttachment } from '../../../shared/types'
import { basename } from '../../../shared/attachments'
import { Button } from './Button'

// One icon per kind — from the single lucide family. Audio is transcribed before it
// reaches a backend, but in the composer it's still shown as an audio card.
const KIND_ICON: Record<AttachmentKind, typeof Plus> = {
  image: ImageIcon,
  audio: FileAudio,
  file: FileText
}

/** Small round button that opens the native attachment picker. `Plus` reads as
 *  "add something" (Slack/Linear style) and stays legible at this size. */
export function AttachButton({
  onClick,
  disabled
}: {
  onClick: () => void
  disabled?: boolean
}): JSX.Element {
  return (
    <Button
      variant="bare"
      onClick={onClick}
      disabled={disabled}
      title="Attach images, audio, or files"
      aria-label="Attach files"
      className="shrink-0 grid place-items-center h-8 w-8 rounded-lg text-muted hover:text-on hover:bg-surface2 disabled:opacity-40 transition"
    >
      <Plus size={18} />
    </Button>
  )
}

// A single attachment thumbnail card. Images lazy-load a downscaled JPEG preview
// (via main); audio/files show a kind icon. Hover reveals the × remove button.
function AttachCard({
  attachment,
  onRemove
}: {
  attachment: MediaAttachment
  /** Absent on a turn already sent: there is nothing left to take back. */
  onRemove?: (path: string) => void
}): JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null)
  const label = attachment.name || basename(attachment.path)
  const Icon = KIND_ICON[attachment.kind]

  useEffect(() => {
    if (attachment.kind !== 'image') return
    let alive = true
    window.api
      .attachmentThumb(attachment.path)
      .then((url) => {
        if (alive) setThumb(url)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [attachment.path, attachment.kind])

  return (
    <div
      className="group relative h-16 w-16 shrink-0 rounded-md overflow-hidden border border-surface3 bg-surface2"
      title={attachment.path}
    >
      {thumb ? (
        <img src={thumb} alt={label} className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full flex flex-col items-center justify-center gap-1 px-1 text-muted">
          <Icon size={18} />
          <span className="text-xlg leading-none truncate max-w-full">{label}</span>
        </div>
      )}
      {onRemove && (
        <Button
          variant="bare"
          onClick={() => onRemove(attachment.path)}
          aria-label={`Remove ${label}`}
          className="absolute top-1 right-1 grid place-items-center h-5 w-5 rounded-full bg-black/70 text-white ring-1 ring-white/80 shadow-sm hover:bg-black transition"
        >
          <X size={12} strokeWidth={2.5} />
        </Button>
      )}
    </div>
  )
}

/** Horizontal row of attachment thumbnail cards. Renders nothing when empty, so
 *  callers can mount it unconditionally. */
export function AttachBar({
  attachments,
  onRemove
}: {
  attachments: MediaAttachment[]
  onRemove?: (path: string) => void
}): JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => (
        <AttachCard key={a.path} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  )
}
