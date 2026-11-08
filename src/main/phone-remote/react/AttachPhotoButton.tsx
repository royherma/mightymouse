/**
 * The composer's paperclip: pick a photo to send along with a reply.
 *
 * Distinct from `PhotoPickButton`, which answers a `photos_get` card and is
 * scoped to that request's id. This one is scoped to a SESSION LABEL and rides a
 * message still being written, so the Mac holds the bytes until the reply
 * arrives rather than resolving anything. One component for both composers --
 * SessionDetail and SessionFullScreen would otherwise each copy the accept list
 * and the size check.
 */

import { useRef } from 'react'
import { ImageUp, Loader2, X } from 'lucide-react'
import { CONFIG } from '@shared/config'
import { hapticTick } from './haptics'
import { Button } from '@shared/ui/Button'

/** PHONE_IMAGE_MIMES, spelled out rather than `image/*`: the iOS sheet
 *  transcodes its default HEIC to JPEG only when the accept list rules HEIC out. */
const ACCEPT = 'image/jpeg,image/png'

/** Owned by the composer: its send handler has to know one is waiting. */
export interface AttachState {
  name: string
  sending: boolean
  error?: string
}

export function AttachPhotoButton({
  label,
  state,
  onState,
  onSend,
  disabled
}: {
  /** Stamped on the outgoing `imageMeta` as `replyToLabel`, which parks the
   *  bytes against the reply instead of pasting them at the Mac's cursor. */
  label: string
  state: AttachState | null
  onState: (next: AttachState | null) => void
  /** False when the socket is not open, so the user hears about it here rather
   *  than sending a message whose picture never left. */
  onSend: (label: string, file: File) => Promise<boolean>
  disabled?: boolean
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const pick = async (file: File): Promise<void> => {
    // Checked here as well as on the Mac: pushing 12MB up a cellular link to be
    // refused at the far end costs the upload for nothing.
    if (file.size > CONFIG.PHONE_REMOTE.MAX_IMAGE_BYTES) {
      onState({ name: file.name, sending: false, error: 'That photo is too big to send' })
      return
    }
    onState({ name: file.name, sending: true })
    const ok = await onSend(label, file)
    onState({ name: file.name, sending: false, error: ok ? undefined : "Can't reach your Mac" })
  }

  if (state) {
    return (
      <Button
        variant="bare"
        type="button"
        className="chatAttachChip"
        data-error={state.error ? '' : undefined}
        aria-label={state.error ?? `Remove ${state.name}`}
        onClick={() => {
          hapticTick()
          onState(null)
        }}
      >
        {state.sending ? <Loader2 size={15} strokeWidth={2.5} /> : <X size={15} strokeWidth={2.5} />}
        <span className="chatAttachName">{state.error ?? state.name}</span>
      </Button>
    )
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so picking the SAME photo twice still fires onChange.
          e.target.value = ''
          if (file) void pick(file)
        }}
      />
      <Button
        variant="bare"
        type="button"
        className="chatAttachBtn"
        disabled={disabled}
        aria-label="Attach a photo"
        onClick={() => {
          hapticTick()
          inputRef.current?.click()
        }}
      >
        <ImageUp size={17} strokeWidth={2.5} />
      </Button>
    </>
  )
}
