/**
 * The one full-screen "you are not driving your Mac" box.
 *
 * Every terminal state must be LEAVABLE, which is not the same as actionable.
 * Requiring `action` made that mistake: it forced a "Try again" onto screens
 * whose retry cannot work (no credential), stacking a fake exit above the form
 * that is the real way out. `onBack` is the honest escape; `action` is optional.
 */

import { useState, type ComponentType, type ReactNode } from 'react'
import { CONFIG } from '@shared/config'
import { nativeBridge } from './native-bridge'
import { Button } from '@shared/ui/Button'

/** What kind of stuck this is, which is the ONLY thing colour encodes here.
 *  'act'     -- you can fix this yourself, right now, on this screen.
 *  'blocked' -- something outside this phone holds the Mac. */
export type TerminalTier = 'act' | 'blocked'

/** A button. `href` renders an anchor instead -- the cert escape leaves the app. */
export interface TerminalAction {
  label: string
  onClick?: () => void
  href?: string
  disabled?: boolean
}

interface Props {
  title: string
  /** A lucide glyph above the title. Fifteen of these screens exist and they
   *  were typographically identical, so the shape is what tells them apart at
   *  a glance -- read before the words are. */
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>
  tier?: TerminalTier
  /** Omitted when a form below already explains the situation. */
  body?: string
  /** The dominant action, when one can actually change the outcome. */
  action?: TerminalAction
  /** The alternative, when one exists that isn't just dismissing the screen. */
  secondary?: TerminalAction
  /** Top-left exit. Supply it whenever the screen isn't the app's own root. */
  onBack?: () => void
  /** Arms `onBack` behind a confirm, for the screens where leaving also
   *  unpairs. Silent navigation there reads as "go back" and costs the
   *  credential -- the one thing the user can't restore without the Mac. */
  backConfirm?: string
  /** A pairing form, rendered between the body and the actions. */
  children?: ReactNode
}

function ActionButton({
  action,
  className
}: {
  action: TerminalAction
  className: string
}): React.JSX.Element {
  if (action.href) {
    return (
      <a className={className} href={action.href} target="_blank" rel="noreferrer">
        {action.label}
      </a>
    )
  }
  return (
    <Button variant="bare" className={className} onClick={action.onClick} disabled={action.disabled}>
      {action.label}
    </Button>
  )
}

export function UnpairButton({ label, onUnpair }: { label: string; onUnpair: () => void }): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  return (
    <Button variant="bare" className="bootGateBtn" onClick={() => (armed ? onUnpair() : setArmed(true))}>
      {armed ? 'Tap again to unpair' : label}
    </Button>
  )
}

export function TerminalBack({
  onBack,
  backConfirm
}: Pick<Props, 'onBack' | 'backConfirm'>): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const arrow = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M15 5l-7 7 7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
  if (!onBack && nativeBridge.isSimpleApp()) return <></>
  if (!onBack && !nativeBridge.canHideDeck()) {
    return (
      <a className="terminalBack" href={CONFIG.WEB_CHAT_URL} aria-label="Back to chat">
        {arrow}
      </a>
    )
  }

  return (
    <Button
      variant="bare"
      className={`terminalBack${armed ? ' armed' : ''}`}
      onClick={() => {
        if (!onBack) return nativeBridge.hideDeck()
        if (backConfirm && !armed) {
          setArmed(true)
          return
        }
        onBack()
      }}
      aria-label={armed ? backConfirm : onBack ? 'Back' : 'Back to chat'}
    >
      {arrow}
      {armed && <span className="terminalBackConfirm">{backConfirm}</span>}
    </Button>
  )
}

export function TerminalState({
  title,
  icon: Icon,
  tier = 'act',
  body,
  action,
  secondary,
  onBack,
  backConfirm,
  children
}: Props): React.JSX.Element {
  return (
    <div className="strandedGuard">
      <TerminalBack onBack={onBack} backConfirm={backConfirm} />
      {Icon && (
        <div className="strandedGuardIcon" data-tier={tier} aria-hidden="true">
          <Icon size={22} strokeWidth={2} />
        </div>
      )}
      <div className="strandedGuardTitle">{title}</div>
      {body && <div className="strandedGuardBody">{body}</div>}
      {children}
      {action && <ActionButton action={action} className="strandedGuardBtn" />}
      {secondary && <ActionButton action={secondary} className="bootGateBtn" />}
    </div>
  )
}
