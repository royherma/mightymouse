import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { CONFIG } from '@shared/config'
import { isCursorless } from '../cursorless-host'

interface UseMirrorPaneArgs {
  videoRef: MutableRefObject<HTMLVideoElement | null>
  mirrorPaneRef: MutableRefObject<HTMLDivElement | null>
  remoteLogRef: MutableRefObject<(message: string) => void>
  zoomFollowLockedRef: MutableRefObject<boolean>
  zoomToScaleRef: MutableRefObject<((scale: number) => void) | null>
  userZoomRef: MutableRefObject<number>
}

export function useMirrorPane({
  videoRef,
  mirrorPaneRef,
  remoteLogRef,
  zoomFollowLockedRef,
  zoomToScaleRef,
  userZoomRef
}: UseMirrorPaneArgs) {
  const [mirrorPaneHeight, setMirrorPaneHeight] = useState<number | null>(null)
  const [isLandscape, setIsLandscape] = useState(
    () => typeof window !== 'undefined' && window.innerWidth > window.innerHeight
  )
  const sizeMirrorPane = useCallback(() => {
    const video = videoRef.current
    const pane = mirrorPaneRef.current
    if (!video || !pane || !video.videoWidth || !video.videoHeight) {
      remoteLogRef.current(
        `mirror sizePane bail v=${!!video} pane=${!!pane} dims=${video?.videoWidth ?? 0}x${video?.videoHeight ?? 0}`
      )
      return
    }
    if (isCursorless() && zoomFollowLockedRef.current) {
      zoomToScaleRef.current?.(userZoomRef.current)
    }
    const rect = pane.getBoundingClientRect()
    if (window.innerWidth > window.innerHeight) {
      const ideal = rect.height * (video.videoWidth / video.videoHeight)
      const outerGap =
        rect.left <= window.innerWidth - rect.right ? rect.left : window.innerWidth - rect.right
      const available =
        window.innerWidth -
        outerGap * 2 -
        CONFIG.PHONE_REMOTE.PRO_LANDSCAPE_GUTTER -
        CONFIG.PHONE_REMOTE.PRO_LANDSCAPE_PAD_MIN_WIDTH
      pane.ownerDocument.documentElement.style.setProperty(
        '--pro-mirror-w',
        `${Math.max(0, Math.min(ideal, available))}px`
      )
      setMirrorPaneHeight(null)
      return
    }
    pane.ownerDocument.documentElement.style.removeProperty('--pro-mirror-w')
    const paneHeight = Math.ceil(rect.width * (video.videoHeight / video.videoWidth))
    remoteLogRef.current(
      `mirror sizePane portrait h=${paneHeight} from ${video.videoWidth}x${video.videoHeight}` +
        ` win=${window.innerWidth}x${window.innerHeight}` +
        ` pane=${Math.round(rect.width)}x${Math.round(rect.height)}` +
        ` vid=${Math.round(video.getBoundingClientRect().width)}x${Math.round(video.getBoundingClientRect().height)}`
    )
    setMirrorPaneHeight(paneHeight)
    const root = pane.ownerDocument.documentElement
    const padWidth = pane.ownerDocument.querySelector('.proTouchpad')?.getBoundingClientRect().width
    if (padWidth) {
      root.style.setProperty('--mm-glass-w', `${Math.round(padWidth)}px`)
      root.style.setProperty(
        '--mm-glass-h',
        `${Math.ceil(padWidth * (video.videoHeight / video.videoWidth))}px`
      )
    }
  }, [mirrorPaneRef, remoteLogRef, userZoomRef, videoRef, zoomFollowLockedRef, zoomToScaleRef])

  const sizeMirrorPaneRef = useRef(sizeMirrorPane)
  sizeMirrorPaneRef.current = sizeMirrorPane
  useEffect(() => {
    const onOrientation = (): void => {
      setIsLandscape(window.innerWidth > window.innerHeight)
      requestAnimationFrame(sizeMirrorPane)
    }
    window.addEventListener('resize', onOrientation)
    window.addEventListener('orientationchange', onOrientation)
    return () => {
      window.removeEventListener('resize', onOrientation)
      window.removeEventListener('orientationchange', onOrientation)
    }
  }, [sizeMirrorPane])

  return {
    mirrorPaneHeight,
    setMirrorPaneHeight,
    isLandscape,
    sizeMirrorPaneRef,
    onMirrorLoadedMetadata: sizeMirrorPane
  }
}
