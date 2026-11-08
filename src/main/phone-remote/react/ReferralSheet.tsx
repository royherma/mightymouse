import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Gift, Check, Copy, Send, X } from 'lucide-react'
import { hapticTick } from './haptics'
import { useFreeViewport, FREE_VIEWPORT_MARGIN_PX } from './useFreeViewport'
import { isValidInviteEmail, normalizeInviteEmail } from '@shared/invite-email'
import { Button } from '@shared/ui/Button'

const REFERRAL_LOAD_TIMEOUT_MS = 8000

/**
 * Referral share sheet, opened from the brand mark in the top-left.
 *
 * Phone Remote is the surface people point a camera at -- it's the most
 * "show this off in a video" screen in the app -- so the share affordance
 * lives here rather than behind a Settings menu on the Mac.
 *
 * Two ways out, one sheet: the QR for someone standing next to you, and an
 * email field for someone who isn't. The email path is deliberately NOT its own
 * surface -- DESIGN.md caps pairing-adjacent flows at their current step count,
 * and "share" is one idea whichever transport it uses.
 *
 * The QR is rendered ON THE PHONE from the link string. The Mac could send a
 * pre-rendered data URL instead, but generating here keeps the payload a short
 * string over the tunnel and lets the code re-render crisply at any size.
 * `qrcode` resolves from the repo root node_modules -- this bundle has no
 * package.json of its own (see vite.config.ts).
 *
 * Everything below `link` is optional because the Mac may answer with an error
 * (signed out, fetch failed). Signed-out is a normal state, not a bug, so it
 * gets a plain sentence rather than an error style.
 */

/**
 * Wire slug -> what the sender reads. Every branch says what to do next, and
 * none of them names the recipient's status: 'already a member' and
 * 'unsubscribed' never reach here, because the server answers those as success
 * on purpose (a membership oracle is the alternative). Voice per
 * docs/brand-voice.md -- plain, short, hyphens not em dashes.
 */
const INVITE_ERROR_COPY: Record<string, string> = {
  invalid_email: "That address doesn't look right.",
  disposable_email: 'That looks like a temporary inbox. Try their real one.',
  self_invite: "That's your own address.",
  rate_limited: "You've sent a few invites already. Try again tomorrow.",
  signed_out: 'Sign in on your Mac to send invites.',
  email_unavailable: "Invites aren't available right now. Try again later.",
  send_failed: "Couldn't send that invite. Try again in a moment."
}

export default function ReferralSheet(props: {
  open: boolean
  link: string | null
  code: string | null
  referredCount: number
  error: string | null
  /** null while idle, 'sending' in flight, 'sent' on success, else an error slug. */
  inviteState: string | null
  onSendInvite: (email: string) => void
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  const { open, link, code, referredCount, error, inviteState, onSendInvite, onRetry, onClose } = props
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [email, setEmail] = useState('')
  const [loadTry, setLoadTry] = useState(0)
  const [loadSlow, setLoadSlow] = useState(false)
  const loading = open && !link && !error
  useEffect(() => {
    setLoadSlow(false)
    if (!loading) return
    const t = setTimeout(() => setLoadSlow(true), REFERRAL_LOAD_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [loading, loadTry])

  // This sheet grew a text input, which makes it one of the few surfaces that
  // can be open WITH A KEYBOARD -- and its CSS max-height is a share of the
  // LAYOUT viewport, which a native keyboard does not shrink. Left alone, the
  // Send button would sit behind the keys the moment the field is focused, the
  // same way the chat composer did. Top edge stays in CSS (a keyboard never
  // moves it); only the bottom needs measuring.
  const freeViewport = useFreeViewport(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)

  // Where CSS actually put the top edge. Measured, not re-derived from
  // safe-area + offset: a second copy of that anchor would drift the first time
  // the CSS rule changes.
  const [sheetTop, setSheetTop] = useState(0)
  useEffect(() => {
    if (!open) return
    const el = sheetRef.current
    if (el) setSheetTop(el.getBoundingClientRect().top)
  }, [open, freeViewport.top, freeViewport.height])

  const sheetMaxHeight = Math.max(
    0,
    freeViewport.top + freeViewport.height - sheetTop - FREE_VIEWPORT_MARGIN_PX
  )

  // Re-render the QR whenever the link changes. Errors are swallowed to null so
  // a QR failure degrades to "link + copy button" rather than breaking the sheet.
  useEffect(() => {
    if (!link) {
      setQrDataUrl(null)
      return
    }
    let alive = true
    QRCode.toDataURL(link, {
      width: 520,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' }
    })
      .then((url) => {
        if (alive) setQrDataUrl(url)
      })
      .catch(() => {
        if (alive) setQrDataUrl(null)
      })
    return () => {
      alive = false
    }
  }, [link])

  // Reset the copied confirmation when the sheet closes, so reopening it doesn't
  // show a stale "Copied!" from last time.
  useEffect(() => {
    if (!open) setCopied(false)
  }, [open])

  // Clear the field once a send lands, so the next invite starts empty rather
  // than the sender having to select-all on a phone keyboard. The confirmation
  // itself is driven by inviteState and cleared by the parent on a timer.
  useEffect(() => {
    if (inviteState === 'sent') setEmail('')
  }, [inviteState])

  async function copyLink(): Promise<void> {
    if (!link) return
    hapticTick()
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked (insecure context, permission). The link is
      // shown in full above, so it stays selectable by hand.
    }
  }

  const trimmed = normalizeInviteEmail(email)
  const emailLooksValid = isValidInviteEmail(email)
  const sending = inviteState === 'sending'

  /**
   * Fires on POINTERDOWN, never click. A click needs the touch to END, which
   * lands ~300ms later and routinely outside iOS's user-activation window;
   * worse, ending a touch outside the focused input blurs it and starts
   * collapsing the keyboard out from under the finger before the handler runs.
   * Every control in this bundle that coexists with a keyboard does this.
   *
   * preventDefault keeps the input focused through the tap, so a rejected send
   * leaves the sender in the field they need to fix.
   */
  function onSend(e: React.PointerEvent): void {
    e.preventDefault()
    if (!emailLooksValid || sending) return
    hapticTick()
    // The Mac re-validates this and so does the Edge function. The check above
    // is an affordance -- it greys the button -- not a guard.
    onSendInvite(trimmed)
  }

  const inviteError = inviteState && inviteState !== 'sending' && inviteState !== 'sent'
    ? (INVITE_ERROR_COPY[inviteState] ?? INVITE_ERROR_COPY.send_failed)
    : null

  return (
    <>
      {open && <div className="historyScrim" onClick={onClose} />}
      <div
        ref={sheetRef}
        data-sheet
        className={`referralSheet${open ? ' open' : ''}`}
        style={{ maxHeight: sheetMaxHeight > 0 ? `${sheetMaxHeight}px` : undefined }}
        role="dialog"
        aria-label="Give a friend MightyMouse"
      >
        <div className="historyHeader">
          <Gift size={17} strokeWidth={2.25} />
          <span className="historyTitle">Give a friend MightyMouse</span>
          <Button
            variant="bare"
            type="button"
            className="historyCloseBtn"
            aria-label="Close"
            onClick={() => {
              hapticTick()
              onClose()
            }}
          >
            <X size={18} strokeWidth={2.25} />
          </Button>
        </div>

        {/* A link WINS over an error, because the two can now coexist: the link
            may be a remembered one (referral-cache.ts) while a background
            refresh just failed. The link is the thing the user came for and a
            referral code doesn't rot, so showing it beats replacing it with an
            apology. The error branch is reached only when there's nothing to
            draw -- a first-ever open with no cache, or a sign-out, which clears
            the cached link precisely so this branch takes over. */}
        {!link && (error || loadSlow) ? (
          <div className="historyEmpty">
            {error === 'signed_out'
              ? 'Sign in on your Mac to get your invite link.'
              : "Couldn't load your invite link. Try again in a moment."}
            {error !== 'signed_out' && (
              <Button
                variant="primary"
                size="lg"
                className="referralCopy"
                onClick={() => {
                  setLoadTry((n) => n + 1)
                  onRetry()
                }}
              >
                Try again
              </Button>
            )}
          </div>
        ) : !link ? (
          <div className="historyEmpty">Loading your invite link…</div>
        ) : (
          <>
            <p className="referralPitch">
              You both get free extra use when they join. Scan or share this.
            </p>

            {qrDataUrl && (
              <div className="referralQrWrap">
                <img className="referralQr" src={qrDataUrl} alt={`QR code for ${link}`} />
              </div>
            )}

            {code && <div className="referralCode">{code}</div>}

            <Button variant="primary" size="lg" className="referralCopy" onClick={() => void copyLink()}>
              {copied ? <Check size={15} strokeWidth={2.5} /> : <Copy size={15} strokeWidth={2.25} />}
              {copied ? 'Copied' : 'Copy link'}
            </Button>

            <div className="referralDivider">
              <span>or invite by email</span>
            </div>

            <input
              className="referralEmailInput"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@email.com"
              // An iOS keyboard that autocapitalises or autocorrects an address
              // is a broken form -- it silently turns a valid one into junk.
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="email"
              spellCheck={false}
              inputMode="email"
              enterKeyHint="send"
              disabled={sending}
              aria-label="Email address to invite"
            />

            <Button
              variant="primary" size="lg"
              className="referralSend"
              onPointerDown={onSend}
              disabled={!emailLooksValid || sending}
              aria-label="Send invite"
            >
              <Send size={15} strokeWidth={2.25} />
              {sending ? 'Sending…' : 'Send invite'}
            </Button>

            {/* Success and failure share a slot: they're mutually exclusive and
                a stacked pair would push the sheet taller mid-interaction. */}
            {inviteState === 'sent' && <div className="referralInviteNote">Invite sent</div>}
            {inviteError && <div className="referralInviteNote">{inviteError}</div>}

            {referredCount > 0 && (
              <div className="referralCount">
                {referredCount} {referredCount === 1 ? 'person has' : 'people have'} joined through you
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
