/**
 * The one control on a `photos_get` card: pick a photo, send it to the Mac.
 *
 * A file input rather than anything custom -- iOS draws its own photo sheet for
 * `accept="image/*"`, which is the sheet the user already knows and the only
 * one available without the library permission Stage B asks for.
 *
 * Request-SCOPED by construction: it takes the id of the card it sits on and
 * stamps it on the outgoing `imageMeta`, which is what routes the bytes to the
 * waiting agent instead of the Mac's cursor. The free-standing version of this
 * button was cut on 2026-08-13 for having no such owner.
 */

import { useRef, useState } from 'react'
import { ImageUp, Loader2 } from 'lucide-react'
import { CONFIG } from '@shared/config'
import { hapticTick } from './haptics'
import { Button } from '@shared/ui/Button'

/** What the Mac will actually decode (PHONE_IMAGE_MIMES). Stated on the input
 *  rather than left as `image/*` because an iPhone shoots HEIC by default, and
 *  the sheet transcodes to JPEG only when the accept list rules HEIC out --
 *  without this the common case is a photo the far end cannot read. */
const ACCEPT = 'image/jpeg,image/png'

export function PhotoPickButton({
  requestId,
  onSend
}: {
  requestId: string
  /** Meta-then-binary, same pairing-by-arrival-order the audio path uses.
   *  Returns false when the socket is not open, so the button can say so
   *  rather than leaving the agent waiting on bytes that never left. */
  onSend: (requestId: string, file: File) => Promise<boolean>
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pick = async (file: File): Promise<void> => {
    // Checked here as well as on the Mac: this is the side that can still tell
    // the user something useful, and pushing 12MB up a cellular link to be
    // rejected at the far end costs them the upload for nothing.
    if (file.size > CONFIG.PHONE_REMOTE.MAX_IMAGE_BYTES) {
      setError('That photo is too big to send')
      return
    }
    setError(null)
    setSending(true)
    const ok = await onSend(requestId, file)
    // Left spinning on success: the card is answered and about to disappear, so
    // returning the button to its resting state would flash a control the user
    // could press again against a request that no longer exists.
    if (!ok) {
      setSending(false)
      setError("Can't reach your Mac")
    }
  }

  return (
    <div className="codeActions">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // Cleared so picking the SAME photo twice still fires onChange -- the
          // second pick is a real retry after a failed send.
          e.target.value = ''
          if (file) void pick(file)
        }}
      />
      <Button
        variant="primary" size="lg"
        className="codeBtnApprove"
        data-spinning={sending ? '' : undefined}
        disabled={sending}
        onClick={() => {
          hapticTick()
          inputRef.current?.click()
        }}
      >
        {sending ? <Loader2 size={16} /> : <ImageUp size={16} />}
        {sending ? 'Sending' : 'Pick a photo'}
      </Button>
      {error && <div className="codeCardBody">{error}</div>}
    </div>
  )
}
