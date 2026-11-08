import { useEffect, useState } from 'react'
import type React from 'react'
import { KeyRound, Radar, RadioTower, Smartphone, Timer, UserRound } from 'lucide-react'
import { CONFIG } from '@shared/config'
import TouchpadLayout from './TouchpadLayout'
import ReconnectBanner from './ReconnectBanner'
import AccountMismatchBanner from './AccountMismatchBanner'
import { accountsDiffer } from './account-mismatch'
import { nativeBridge } from './native-bridge'
import PermissionBanner from './PermissionBanner'
import HandsFreePill from './HandsFreePill'
import { CursorlessMirrorPrompt } from './CursorlessMirrorPrompt'
import { ApprovalPrompt, ApprovalWaiting } from './ApprovalPrompt'
import { capabilities } from './host-capabilities'
import CameraPip from './CameraPip'
import { currentDeviceCredential, safariEscapeUrl } from './useHostDiscovery'
import { showBootGate } from './boot-gate'
import { PairDeviceForm } from './PairDeviceForm'
import { TerminalBack, TerminalState, UnpairButton } from './TerminalState'
import { useMirror, PREVIEW_MODE, type AppProps } from './hooks/use-mirror'
import { Button } from '@shared/ui/Button'

/** Phone remote composition root. useMirror owns all state/effects and hands
 * back exactly what this JSX needs; this file owns only the render tree. */
export default function App(props: AppProps = {}): React.JSX.Element {
  const {
    connState,
    handoffLabel,
    reconnectAttempt,
    searching,
    tunnelReach,
    send,
    retryNow,
    forceRediscover,
    takeControl,
    role,
    cursorless,
    everConnected,
    backToPairing,
    disconnectAndLeave,
    reconnectSlow,
    envSwitchingTo,
    macControlBlocked,
    macAccountId,
    handsFreeState,
    askMirror,
    answerMirror,
    approvalRequest,
    answerApproval,
    macLocked,
    awayNotice,
    sharedLayoutProps,
    cameraOn,
    onCameraChange,
    envState,
    remoteLog
  } = useMirror(props)

  if (connState.kind === 'blocked' && !PREVIEW_MODE) {
    switch (connState.reason) {
      case 'mac-busy':
        // A cursorless host's takeover is refused on arrival, so the button could only fail.
        return (
          <TerminalState
            icon={UserRound}
            tier="blocked"
            title={`${handoffLabel ?? 'Another device'} is using your Mac`}
            body="Take control to use it here. The other device will stop."
            action={cursorless ? undefined : { label: 'Take control', onClick: takeControl }}
          />
        )

      // The credential is gone either way, so both carry the code form and
      // neither offers a retry -- reconnecting with nothing can only fail.
      // They differ only in whether the user did this to themselves.
      case 'no-credential':
      case 'credential-revoked':
        return (
          <TerminalState
            icon={KeyRound}
            title="Let’s connect your Mac"
            body={
              connState.reason === 'credential-revoked'
                ? 'This phone was disconnected in MightyMouse settings.'
                : undefined
            }
            onBack={backToPairing}
          >
            <PairDeviceForm onPaired={retryNow} />
          </TerminalState>
        )

      case 'mac-unreachable':
        if (nativeBridge.canExitNotFound()) return <NativeNotFound />
        // The credential here is still LIVE, so a plain back would leave the
        // phone paired and return to this same screen on the next reconnect.
        // "Try again" reopens discovery in place rather than reloading: a
        // reload re-fetches the page from its CURRENT origin, which on the
        // native shell is the same dead cached host that landed here.
        return (
          <CantFindMac
            onRetry={forceRediscover}
            onBack={disconnectAndLeave}
            backConfirm="Unpair this phone"
            macPageUrl={capabilities.canRecoverCertificateWarning ? safariEscapeUrl() : undefined}
          >
            <PairDeviceForm onPaired={retryNow} />
          </CantFindMac>
        )

      case 'rate-limited':
        // The retry stays disabled until the cooldown ends: a tap would spend another attempt.
        return (
          <RateLimitedState onRetry={retryNow} onBack={backToPairing} />
        )
    }
  }

  // Above the boot gate on purpose: this device has never connected, so the gate
  // below would otherwise cover the one screen that explains the wait with an
  // anonymous spinner. No action -- the answer is being tapped on the phone, and
  // any button here would only race it.
  if (connState.kind === 'awaitingApproval' && !PREVIEW_MODE) {
    return (
      <TerminalState
        icon={Smartphone}
        title="Waiting for approval"
        body="Open MightyMouse on your connected phone and tap Allow."
      >
        <ApprovalWaiting expiresAt={connState.expiresAt} />
      </TerminalState>
    )
  }

  // PREVIEW_MODE opts out: a preview load never connects by design, and this
  // screen would hide the very deck it exists to show.
  //
  // `everConnected` suppresses this on the phone because ReconnectBanner over a
  // still-readable deck beats a takeover for a 200ms blip. The glasses invert
  // that: their deck is a mirror of a screen that is no longer arriving, so a
  // drop leaves a frozen picture with a banner the user cannot act on. Sending
  // them back here means the reconnect also re-runs `askMirror`, which is the
  // only mirror control this host can reach.
  // `!everConnected` is the FIRST connect -- exactly when the native shell is
  // still holding its own LaunchView over this page, so painting here stacks a
  // second connect screen behind the first and the user sees both in sequence.
  // A later drop (`cursorless`) is past the cover and still needs this.
  const returning = currentDeviceCredential() !== null
  const nativeCoverHoldsThisWait = capabilities.nativeLaunchCover && !everConnected
  if (
    showBootGate({
      connected: connState.kind === 'connected',
      everConnected,
      returning,
      cursorless,
      nativeCoverHoldsThisWait
    }) &&
    !PREVIEW_MODE
  ) {
    if (reconnectAttempt > 1) return <CantFindMac onRetry={retryNow} />
    return (
      <div className="bootGate">
        <TerminalBack />
        <div className="bootGateMark">{CONFIG.PRODUCT_NAME}</div>
        <div className="bootGateIcon" aria-hidden="true">
          <Radar size={26} strokeWidth={1.75} />
        </div>
        <div className="bootGateBody" role="status" aria-live="polite">
          Connecting to your Mac…
        </div>
      </div>
    )
  }

  return (
    <>
      {/* envSwitchingTo also mounts the banner: the Mac sends `envSwitching`
          ~250ms BEFORE it quits, and without this the user taps "Switch &
          restart" and gets nothing at all until the socket finally dies. */}
      {/* `|| returning` for the same reason the gate above takes it: a returning
          load reaches this deck with everConnected still false, and without it
          the one surface explaining the wait is the banner that is gated off. */}
      {(reconnectSlow || envSwitchingTo !== null) &&
        (everConnected || returning) &&
        !PREVIEW_MODE && (
          <ReconnectBanner
            attempt={reconnectAttempt}
            searching={searching}
            onRetryNow={forceRediscover}
            switchingTo={envSwitchingTo}
            tunnelReach={tunnelReach}
          />
        )}
      {/* A banner, NOT a takeover: Accessibility gates the pad/keys on the Mac
          and nothing else, so dictation still works and must stay reachable. */}
      {disconnectAndLeave && accountsDiffer(nativeBridge.phoneAccountId(), macAccountId) && !PREVIEW_MODE && (
        <AccountMismatchBanner onDisconnect={disconnectAndLeave} />
      )}
      {macControlBlocked && !PREVIEW_MODE && (
        <PermissionBanner onOpenSettings={() => send({ type: 'openAccessibilitySettings' })} />
      )}
      {/* At App level like the banner, so one instance covers both layouts and
          neither can drift. Renders nothing when the mode is off. */}
      {!PREVIEW_MODE && <HandsFreePill state={handsFreeState} />}
      {askMirror && !PREVIEW_MODE && <CursorlessMirrorPrompt onAnswer={answerMirror} />}
      {approvalRequest && !PREVIEW_MODE && (
        <ApprovalPrompt
          label={approvalRequest.label}
          expiresAt={approvalRequest.expiresAt}
          onAnswer={answerApproval}
        />
      )}
      {/* The persistent locked banner outranks the transient notices: while the
          Mac sits on its real login window, "it locked itself" is the whole story. */}
      {macLocked && !PREVIEW_MODE ? (
        <div className="awayPill" data-kind="locked" role="status" aria-live="polite">
          <span className="awayPillText">
            Your Mac is locked. Type your password on the Mac to keep going here.
          </span>
        </div>
      ) : (
        awayNotice !== null &&
        !PREVIEW_MODE && (
          <div className="awayPill" data-kind={awayNotice} role="status" aria-live="polite">
            <span className="awayPillText">
              {awayNotice === 'covered'
                ? "Your Mac's screen is black now. Only you can see it here."
                : 'Someone touched your Mac, so it locked itself.'}
            </span>
          </div>
        )
      )}
      {/* Only a watching device gets this, and only while another device is
          actually driving. pointerDown, not click: click needs the touch to
          END, which on this deck can blur the hidden input and collapse the
          surface out from under the finger before the handler runs.

          Never on the glasses: that host is screen-only, so "your other device
          is in charge" describes the normal state there rather than a problem,
          and its "use this one instead" offer is for a device that cannot take
          control anyway. Not rendered rather than hidden in CSS -- a hidden
          pill still measures, and --top-banner-h would push the whole deck down
          for a banner nobody can see. */}
      {role === 'viewer' && !PREVIEW_MODE && !cursorless && (
        <div className="awayPill" data-kind="viewer" role="status" aria-live="polite">
          <span className="awayPillText">Your other device is in charge right now.</span>
          <Button
            variant="bare"
            type="button"
            className="awayPillAction"
            onPointerDown={(e) => {
              e.preventDefault()
              send({ type: 'requestControl' })
            }}
          >
            Use this one instead
          </Button>
        </div>
      )}
      <TouchpadLayout {...sharedLayoutProps} />
      <CameraPip
        open={cameraOn}
        onOpenChange={onCameraChange}
        showSourcePicker={envState?.isAdmin === true}
        log={remoteLog}
      />
    </>
  )
}

function RateLimitedState({
  onRetry,
  onBack
}: {
  onRetry: () => void
  onBack?: () => void
}): React.JSX.Element {
  const [left, setLeft] = useState(Math.ceil(CONFIG.PHONE_REMOTE.RATE_LIMIT_COOLDOWN_MS / 1000))
  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [left])
  return (
    <TerminalState
      icon={Timer}
      tier="blocked"
      title="Too many tries to connect"
      body="Give it a moment, then try again."
      action={{
        label: left > 0 ? `Try again in ${left}s` : 'Try again',
        onClick: onRetry,
        disabled: left > 0
      }}
      onBack={onBack}
    />
  )
}

function NativeNotFound(): null {
  useEffect(() => nativeBridge.exitToPairing('notFound'), [])
  return null
}

function CantFindMac({
  onRetry,
  onBack,
  backConfirm,
  macPageUrl,
  children
}: {
  onRetry: () => void
  onBack?: () => void
  backConfirm?: string
  macPageUrl?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <TerminalState
      icon={RadioTower}
      title="Can’t find your Mac"
      body="Make sure MightyMouse is open on your Mac and you’re on the same Wi-Fi."
      onBack={onBack}
      backConfirm={backConfirm}
    >
      <Button variant="bare" className="strandedGuardBtn" onClick={onRetry}>
        Try again
      </Button>
      {onBack && backConfirm && <UnpairButton label={backConfirm} onUnpair={onBack} />}
      {children && <div className="pairOrDivider">or pair again</div>}
      {children}
      {macPageUrl && (
        <div className="strandedGuardBody">
          Still stuck?{' '}
          <a className="strandedGuardLink" href={macPageUrl} target="_blank" rel="noreferrer">
            Open your Mac’s page
          </a>
          . If Safari shows a warning, tap Show Details, then “visit this website”.
        </div>
      )}
    </TerminalState>
  )
}
