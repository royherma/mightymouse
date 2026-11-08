import { useEffect } from 'react'
import { subscribeNativeIntent, setIntentDropReporter, nativeBridge } from '../native-bridge'
import { mirrorStatsOverlayEnabled } from '../mirror-stats-flag'
import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'
import type { MirrorRigStatus } from '../MirrorStatsOverlay'

type Args = {
  send: (message: PhoneRemoteMessage) => void
  remoteLog: (message: string) => void
  remoteLogRef: React.MutableRefObject<(message: string) => void>
  activateApp: (bundleId: string) => void
  stopMirror: (cause: string) => void
  setRigStatus: React.Dispatch<React.SetStateAction<MirrorRigStatus | null>>
  setStatus: (text: string) => void
  setCodeOpen: (open: boolean) => void
  setMirrorOn: (on: boolean) => void
  mirrorPcRef: React.MutableRefObject<RTCPeerConnection | null>
  nativeChatHandlerRef: React.MutableRefObject<((text: string) => void) | null>
  nativeOpenChatRef: React.MutableRefObject<(() => void) | null>
  nativeOpenRelayRef: React.MutableRefObject<((requestId: string) => void) | null>
}

/**
 * App Intents enter through the same callbacks as taps. Native code never gets its own
 * websocket implementation, so Siri and the visible remote stay behaviorally identical.
 */
export function useNativeIntents({
  send,
  remoteLog,
  remoteLogRef,
  activateApp,
  stopMirror,
  setRigStatus,
  setStatus,
  setCodeOpen,
  setMirrorOn,
  mirrorPcRef,
  nativeChatHandlerRef,
  nativeOpenChatRef,
  nativeOpenRelayRef
}: Args): void {
  useEffect(() => {
    return subscribeNativeIntent((event) => {
      if (event.type === 'nativeLog') remoteLogRef.current(event.text)
      // Debug column only, so the whole branch is behind the build flag rather
      // than the state setter -- a viewer should not re-render for a corner
      // their build never paints.
      if (event.type === 'glassesStatus' && mirrorStatsOverlayEnabled()) {
        const { link, thermal, name, batteryCritical } = event
        setRigStatus((prev) => ({
          macBatteryPct: prev?.macBatteryPct ?? null,
          macCharging: prev?.macCharging ?? false,
          rttMs: prev?.rttMs ?? -1,
          jitterMs: prev?.jitterMs ?? -1,
          route: prev?.route ?? '?',
          glassesLink: link,
          glassesThermal: thermal,
          glassesName: name || null,
          glassesBatteryCritical: batteryCritical
        }))
      }
      // The square is a STOP, not a pause. Relaying `playing:false` on its own
      // stopped the Mac's encoder but left the window open on a dead stream --
      // black, badged LIVE, still holding the audio session with nothing
      // playing (PRD 2026-08-17-*-ios-2-5-4 §7c). `stopMirror` clears
      // `mirrorActive`, whose effect cleanup is the only sender of `pipEnded`.
      if (event.type === 'pipSetPlaying') {
        if (event.playing) send({ type: 'pipStreamSetPlaying', playing: true })
        else stopMirror('pipSetPlaying')
      }
      if (event.type === 'typeText') send({ type: 'typeText', text: event.text })
      if (event.type === 'appSwitchActivate') activateApp(event.bundleId)
      if (event.type === 'chatSend') nativeChatHandlerRef.current?.(event.text)
      if (event.type === 'openChat') nativeOpenChatRef.current?.()
      // A relay notification tap. The card itself may not have arrived over
      // the WS yet (this can fire before `relayPending`'s first snapshot on a
      // cold launch) -- CodeSheet resolves the id against whatever list it
      // has whenever that settles, rather than requiring it to be there now.
      if (event.type === 'openRelayRequest') {
        setCodeOpen(true)
        nativeOpenRelayRef.current?.(event.requestId)
      }
      // A lock-screen answer that never reached the Mac. Deliberately NOT a
      // connection-state write: the socket discovers a dead credential on its
      // own next connect and `credential-revoked` already owns that screen --
      // forcing it from here would be a second writer of the one state
      // (phone-remote/CLAUDE.md: "one connection state, one place"). What is
      // missing without this is only the telling: the answer is already gone,
      // so say it did not land and open the card so the choice can be retapped.
      if (event.type === 'relayAnswerFailed') {
        setStatus(
          event.reason === 'unauthorized'
            ? 'Answer not sent - reconnect this phone to your Mac'
            : 'Answer not sent - your Mac was unreachable'
        )
        setCodeOpen(true)
        nativeOpenRelayRef.current?.(event.requestId)
      }
      // The Live Activity's Stop, pressed from the Lock Screen. Send what's
      // been recorded rather than dropping it: the user asked to stop, not to
      // throw away.
      if (event.type === 'nativeStopRequested') {
        remoteLog(`STOP nativeStopRequested stopMirror=${event.stopMirror ?? false}`)
        // The Lock Screen's Stop means "stop everything I can hear". Without
        // this the mirror keeps streaming and the mirrorActive && shareAudio
        // effect immediately re-takes the hold Swift just released.
        if (event.stopMirror) {
          setMirrorOn(false)
          // Both halves, in the order every other call site uses: `stopMirror`
          // is local teardown only, so without the send the Mac's capture
          // helper keeps running and only the phone goes quiet.
          //
          // Synchronously, not in an effect keyed on mirrorOn: this tears the
          // peer connection down now, so the ack below is a statement about
          // what already happened rather than what React will render next.
          if (mirrorPcRef.current) send({ type: 'mirrorStop', cause: 'user' })
          stopMirror('nativeStop')
        }
        // Swift releases its holds and ends the Live Activity on THIS, so it
        // must be sent whether or not a mirror was running -- a Stop pressed
        // over a mic-only session still needs the activity to come down.
        remoteLog('STOP sending stopAcknowledged')
        nativeBridge.stopAcknowledged()
      }
    }, ['openChat', 'openRelayRequest', 'relayAnswerFailed'])
  }, [activateApp, remoteLog, send, stopMirror])

  // A tap that aged out of the pre-mount buffer. Journaled rather than shown:
  // the user has long since moved on, but a lost tap that leaves NO row at all
  // is indistinguishable from no tap ever happening, which is what made this
  // class of bug unprovable from the Mac.
  useEffect(() => {
    setIntentDropReporter((event) => {
      if (event.type === 'openRelayRequest' || event.type === 'relayAnswerFailed') {
        send({ type: 'relayTapTrace', requestId: event.requestId, outcome: 'dropped' })
      }
    })
  }, [send])
}
