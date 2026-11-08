import type { RefObject } from 'react'
import { Laptop, Mic, MonitorX, Settings } from 'lucide-react'
import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'
import {
  MAC_FRAME,
  type HostDevice,
  type PhoneRemoteKeyName,
  type PhoneRemoteModifier
} from '@shared/phone-remote-keys'
import { Button } from '@shared/ui/Button'
import KeyGrid from './KeyGrid'
import { TrackpadSurface } from './ai/ScreenView'
import { handsFreeMicClass, type HandsFreeDisplay } from './hands-free-rules'
import { MicWaveform } from './MicWaveform'
import type { KeyboardLayoutId } from './keyboard-layouts'
import './mac-look.css'

const FALLBACK_DEVICE: HostDevice = { frame: MAC_FRAME.pro, name: 'MacBook Pro', notch: true }

export function macLookLabel(device: HostDevice | undefined): string {
  return `Like my ${(device ?? FALLBACK_DEVICE).name}`
}

export interface MacLookMic {
  recording: boolean
  micLatched: boolean
  handsFree: HandsFreeDisplay
  handsFreeSpeaking: boolean
  micStreamRef: RefObject<MediaStream | null>
  handsFreeStreamRef: RefObject<MediaStream | null>
  micSidePress: (kind: 'cancel' | 'stop') => void
  disarmHandsFree: () => void
}

function RecordingHud({ mic }: { mic: MacLookMic }): React.JSX.Element | null {
  if (mic.recording) {
    return (
      <div className="mlRecHud">
        {mic.micLatched && (
          <Button
            variant="bare"
            className="micSideBtn micCancel"
            onPointerDown={(e) => {
              e.preventDefault()
              mic.micSidePress('cancel')
            }}
            aria-label="Cancel recording"
          >
            Cancel
          </Button>
        )}
        <MicWaveform streamRef={mic.micStreamRef} />
        {mic.micLatched && (
          <Button
            variant="bare"
            className="micSideBtn micStop"
            onPointerDown={(e) => {
              e.preventDefault()
              mic.micSidePress('stop')
            }}
            aria-label="Stop and send recording"
          >
            Stop
          </Button>
        )}
      </div>
    )
  }
  if (mic.handsFreeSpeaking) {
    return (
      <div className="mlRecHud">
        <MicWaveform streamRef={mic.handsFreeStreamRef} />
        <Button
          variant="bare"
          className="micSideBtn micStop"
          onClick={mic.disarmHandsFree}
          aria-label="Stop hands-free dictation"
        >
          Stop
        </Button>
      </div>
    )
  }
  return null
}

export default function MacLookView(props: {
  pane: React.ReactNode
  device: HostDevice | undefined
  macName: string | null
  isLandscape: boolean
  mic: MacLookMic
  layoutId: KeyboardLayoutId
  send: (msg: PhoneRemoteMessage) => void
  onStop: () => void
  onOpenSettings: () => void
  onChar: (text: string) => void
  onBackspace: () => void
  onSpecialKey: (key: PhoneRemoteKeyName) => void
  onCombo: (modifiers: PhoneRemoteModifier[], key: PhoneRemoteKeyName) => void
}): React.JSX.Element {
  const device = props.device ?? FALLBACK_DEVICE
  const desktop = device.frame === MAC_FRAME.desktop

  const keys = (
    <div className="mlKeys">
      <KeyGrid
        open
        layoutId={props.layoutId}
        onChar={props.onChar}
        onBackspace={props.onBackspace}
        onSpecialKey={props.onSpecialKey}
        onCombo={props.onCombo}
      />
    </div>
  )

  const pad = (
    <div className="mlPadRow">
      <div className="mlPad">
        <TrackpadSurface send={props.send} hint="" />
      </div>
      <RecordingHud mic={props.mic} />
      <Button
        variant="bare"
        type="button"
        className={`proMicBtn mlMic${props.mic.recording ? ' recording' : ''}${handsFreeMicClass(
          props.mic.handsFree,
          props.mic.handsFreeSpeaking
        )}`}
        aria-label={props.mic.handsFree === 'listening' ? 'Listening, tap to stop' : 'Hold or tap to talk'}
      >
        <Mic size={20} strokeWidth={2.25} />
      </Button>
    </div>
  )

  return (
    <div
      className="macLook"
      data-frame={device.frame}
      data-notch={device.notch ? '' : undefined}
      data-orient={props.isLandscape ? 'landscape' : 'portrait'}
    >
      <div className="mlTop">
        <Button
          variant="bare"
          type="button"
          className="aiScreenBack"
          aria-label="Stop showing the Mac screen"
          onClick={props.onStop}
        >
          <MonitorX size={17} />
          Stop viewing
        </Button>
        <div className="mlTopRight">
          {props.macName && (
            <div className="mlName">
              <Laptop size={13} />
              {props.macName}
            </div>
          )}
          <Button
            variant="bare"
            type="button"
            className="mlSettings"
            aria-label="Settings"
            onClick={props.onOpenSettings}
          >
            <Settings size={17} />
          </Button>
        </div>
      </div>

      <div className="mlDevice">
        <div className="mlLid">
          <div className="mlBezel">
            {device.notch ? (
              <div className="mlNotch" aria-hidden="true">
                <span className="mlCam" />
              </div>
            ) : (
              <span className="mlCam mlCamTop" aria-hidden="true" />
            )}
            <div className="mlScreen">{props.pane}</div>
            {!desktop && <div className="mlChin">{device.name}</div>}
          </div>
        </div>
        {desktop ? (
          <div className="mlStand" aria-hidden="true" />
        ) : (
          <div className="mlHinge" aria-hidden="true" />
        )}
        <div className="mlBase">
          {keys}
          {pad}
        </div>
      </div>
    </div>
  )
}
