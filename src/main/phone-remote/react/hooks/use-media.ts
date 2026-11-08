import { useCallback, useEffect, useState } from 'react'
import { CONFIG } from '@shared/config'
import { getCameraOpenPref, setCameraOpenPref } from '../CameraPip'
import type { PhoneRemoteEvent, PhoneRemoteMessage } from '@shared/phone-remote-protocol'

// Dump the live mirror benchmark. The periodic BENCH line answers "how is
// this run going"; this answers "how did it go" at the moment you ask,
// which is what comparing two builds actually needs. Safari devtools on a
// tethered phone, or the glasses' own console.
declare global {
  interface Window {
    mmBench?: () => string
  }
}

/** Share-computer-audio pref. Defaults OFF: audio should never start playing
 *  out of a phone in someone's pocket without them asking for it. */
export function getShareAudioPref(): boolean {
  try {
    return localStorage.getItem(CONFIG.PHONE_REMOTE.SHARE_AUDIO_KEY) === '1'
  } catch {
    // Private-mode Safari throws on localStorage access -- an unreadable pref
    // must degrade to the default, never break the remote.
    return false
  }
}

export function setShareAudioPref(value: boolean): void {
  try {
    localStorage.setItem(CONFIG.PHONE_REMOTE.SHARE_AUDIO_KEY, value ? '1' : '0')
  } catch {
    // Ignore: the toggle still works for this session, it just won't persist.
  }
}

interface UseMediaArgs {
  onMessage: (handler: (msg: PhoneRemoteEvent) => void) => () => void
  send: (msg: PhoneRemoteMessage) => void
  /** Reads the live mirror benchmark for window.mmBench. Owned by use-mirror's
   *  bench refs -- passed in rather than duplicated, since the stats loop that
   *  feeds them is core mirror-negotiation logic, not a media pref. */
  formatMmBench: () => string
}

/** Media prefs and readouts orthogonal to the mirror session itself: the
 *  self-camera PiP toggle (phone-local, never touches the WS), the Mac's
 *  reported system volume, and the mmBench console hook. */
export function useMedia({ onMessage, send, formatMmBench }: UseMediaArgs) {
  const [shareAudio, setShareAudio] = useState(getShareAudioPref)
  const onShareAudioChange = useCallback((value: boolean) => {
    setShareAudio(value)
    setShareAudioPref(value)
  }, [])
  const [micOn, setMicOn] = useState(false)
  // Self-camera PiP for framing a reaction shot -- phone-local only (never
  // touches the WS/Mac), so it's a plain localStorage pref like haptics, not
  // a Mac-synced one.
  const [cameraOn, setCameraOn] = useState(getCameraOpenPref)
  const onCameraChange = useCallback((value: boolean) => {
    setCameraOn(value)
    setCameraOpenPref(value)
  }, [])

  // Null until the Mac answers a getSystemVolume, and again whenever the output
  // device can't report one -- NOT phone-local state, so it isn't a pref.
  const [systemVolume, setSystemVolume] = useState<number | null>(null)
  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === 'systemVolume') setSystemVolume(msg.volume)
      }),
    [onMessage]
  )
  const onSystemVolumeChange = useCallback(
    (volume: number) => {
      setSystemVolume(volume)
      send({ type: 'setSystemVolume', volume })
    },
    [send]
  )
  const onRequestSystemVolume = useCallback(() => {
    send({ type: 'getSystemVolume' })
  }, [send])

  // Exposed for the whole session, not just while mirroring: reading it after
  // the mirror stops is the normal case, since the summary is what you compare
  // between two builds.
  useEffect(() => {
    window.mmBench = formatMmBench
    return () => {
      delete window.mmBench
    }
  }, [formatMmBench])

  return {
    cameraOn,
    onCameraChange,
    shareAudio,
    onShareAudioChange,
    micOn,
    setMicOn,
    systemVolume,
    onSystemVolumeChange,
    onRequestSystemVolume
  }
}
