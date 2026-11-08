import { useEffect } from 'react'

import { CONFIG } from '@shared/config'

import { hapticDragEngage, hapticDragRelease, hapticTick, resetDragDetent } from '../haptics'
import { isMirrorPaneControlTouch } from '../mirror-pane-touch-target'
import {
  DOUBLE_TAP_MAX_MOVE_PX,
  DOUBLE_TAP_MAX_MS,
  DRAG_HOLD_MS,
  MOVE_THROTTLE_MS,
  TAP_MAX_MOVE_PX,
  TAP_MAX_MS
} from './use-trackpad'

import type { TouchModeEvent } from '../touch-mode'
import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'
import type { Dispatch, RefObject, SetStateAction } from 'react'

export type MirrorZoomState = { scale: number; x: number; y: number }

/** The live pan gesture's two levers, published by whichever handler owns it. */
export type MirrorPanHandoff = {
  suppress: () => void
  release: (clientX: number, clientY: number) => void
} | null

export type UseMirrorGesturesArgs = {
  mirrorOn: boolean
  paneNode: HTMLDivElement | null
  mirrorPaneRef: RefObject<HTMLDivElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  mirrorPanHandoffRef: RefObject<MirrorPanHandoff>
  touchModeActiveRef: RefObject<boolean>
  touchModeLockedRef: RefObject<boolean>
  touchModeRestTimerRef: RefObject<number | null>
  dispatchTouchMode: (event: TouchModeEvent) => void
  setMirrorZoom: Dispatch<SetStateAction<MirrorZoomState>>
  send: (msg: PhoneRemoteMessage) => void
}

/**
 * Every touch listener on the mirror pane: the two-finger pinch/pan and the
 * one-finger tap/hold/drag that drives the remote cursor. Both are raw
 * `addEventListener` effects keyed only on `mirrorOn` -- everything else they
 * read flows through refs, which is what lets them sit outside `use-mirror`.
 */
export function useMirrorGestures({
  mirrorOn,
  paneNode,
  mirrorPaneRef,
  videoRef,
  mirrorPanHandoffRef,
  touchModeActiveRef,
  touchModeLockedRef,
  touchModeRestTimerRef,
  dispatchTouchMode,
  setMirrorZoom,
  send
}: UseMirrorGesturesArgs): void {
  useEffect(() => {
    const el = mirrorPaneRef.current
    if (!el || !mirrorOn) return undefined

    // Shared with the Pro zoom bar (zoomToScale) via CONFIG so the two paths
    // can never drift to different ceilings.
    const MIN_SCALE = CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MIN
    const MAX_SCALE = CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MAX
    let pinchStartDist = 0
    let pinchStartScale = 1
    let panStartX = 0
    let panStartY = 0
    let panStartScale = 1
    let zoomStartX = 0
    let zoomStartY = 0
    let mode: 'none' | 'pinch' | 'pan' | 'held' = 'none'
    let lastTapAt = 0
    mirrorPanHandoffRef.current = {
      suppress: () => {
        if (mode === 'held') mode = 'none'
      },
      release: (clientX, clientY) => {
        if (mode !== 'held') return
        mode = 'pan'
        panStartX = clientX
        panStartY = clientY
        const { x, y } = clampPan(panStartScale, zoomStartX, zoomStartY)
        setMirrorZoom({ scale: panStartScale, x, y })
      }
    }

    function clampPan(scale: number, x: number, y: number): { x: number; y: number } {
      if (scale <= MIN_SCALE) return { x: 0, y: 0 }
      const rect = el!.getBoundingClientRect()
      const maxX = (rect.width * (scale - 1)) / 2
      const maxY = (rect.height * (scale - 1)) / 2
      return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) }
    }

    function distance(t0: Touch, t1: Touch): number {
      return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
    }

    function onTouchStart(e: TouchEvent): void {
      if (isMirrorPaneControlTouch(e.target)) return
      if (e.touches.length === 2) {
        mode = 'pinch'
        pinchStartDist = distance(e.touches[0], e.touches[1])
        setMirrorZoom((z) => {
          pinchStartScale = z.scale
          zoomStartX = z.x
          zoomStartY = z.y
          return z
        })
        panStartX = (e.touches[0].clientX + e.touches[1].clientX) / 2
        panStartY = (e.touches[0].clientY + e.touches[1].clientY) / 2
      } else if (e.touches.length === 1) {
        const now = Date.now()
        const isDoubleTap = now - lastTapAt < DOUBLE_TAP_MAX_MS
        lastTapAt = now
        if (isDoubleTap) {
          setMirrorZoom({ scale: 1, x: 0, y: 0 })
          mode = 'none'
          return
        }
        setMirrorZoom((z) => {
          if (z.scale > MIN_SCALE) {
            mode = 'held'
            panStartScale = z.scale
            zoomStartX = z.x
            zoomStartY = z.y
          }
          return z
        })
        panStartX = e.touches[0].clientX
        panStartY = e.touches[0].clientY
      }
    }

    function onTouchMove(e: TouchEvent): void {
      if (mode === 'pinch' && e.touches.length === 2) {
        const dist = distance(e.touches[0], e.touches[1])
        const scale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, pinchStartScale * (dist / pinchStartDist))
        )
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2
        const { x, y } = clampPan(
          scale,
          zoomStartX + (midX - panStartX),
          zoomStartY + (midY - panStartY)
        )
        setMirrorZoom({ scale, x, y })
      } else if (mode === 'pan' && e.touches.length === 1) {
        setMirrorZoom((z) => {
          const { x, y } = clampPan(
            z.scale,
            zoomStartX + (e.touches[0].clientX - panStartX),
            zoomStartY + (e.touches[0].clientY - panStartY)
          )
          return { scale: z.scale, x, y }
        })
      }
      // mode === 'held': deliberately a no-op here. The touch-mode effect's
      // own onTouchMove is the ONLY place that judges whether this finger
      // moved enough to cancel the hold -- see mirrorPanHandoffRef.release.
    }

    function onTouchEnd(e: TouchEvent): void {
      if (e.touches.length === 0) mode = 'none'
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      mirrorPanHandoffRef.current = null
    }
  }, [mirrorOn, paneNode])

  useEffect(() => {
    const el = mirrorPaneRef.current
    const video = videoRef.current
    if (!el || !video || !mirrorOn) return undefined

    let active = false
    let holdTimer: number | null = null
    let holdStartPoint: { nx: number; ny: number } | null = null

    let touchStartClientX = 0
    let touchStartClientY = 0
    let touchStartAt = 0
    let maxMoveDuringTouch = 0
    let touchCountAtStart = 0
    let lastScrollX = 0
    let lastScrollY = 0
    let lastWarpSentAt = 0
    let dragging = false
    let scrolling = false
    let dragHoldTimer: number | null = null
    let lastTapAt = 0
    let lastTapX = 0
    let lastTapY = 0
    let pendingTapTimer: number | null = null
    let activatedByThisTouch = false

    function clearDragHoldTimer(): void {
      if (dragHoldTimer !== null) {
        window.clearTimeout(dragHoldTimer)
        dragHoldTimer = null
      }
    }

    function clearHoldTimer(): void {
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer)
        holdTimer = null
      }
      holdStartPoint = null
    }

    // Shared entry path for both the hold-timer firing and an already-active
    // session's next touchdown -- keeps 'begin controlling the cursor at
    // this point' in one place instead of duplicated in onTouchStart.
    function beginControl(p: { nx: number; ny: number }): void {
      active = true
      // Touch mode won: tell the pan effect to stand down so this same
      // touch doesn't also start panning the mirror out from under the warp.
      mirrorPanHandoffRef.current?.suppress()
      if (touchModeRestTimerRef.current !== null) {
        window.clearTimeout(touchModeRestTimerRef.current)
        touchModeRestTimerRef.current = null
      }
      dispatchTouchMode({ type: 'gestureBegin' })
      // snap: this is the touchdown that places the cursor under the finger --
      // it must land exactly, never eased (see the warp smoothing on the Mac
      // side). Only the streaming warps during a slide get filtered.
      send({ type: 'mirrorWarp', nx: p.nx, ny: p.ny, snap: true })
    }

    function pointToNormalized(
      clientX: number,
      clientY: number
    ): { nx: number; ny: number } | null {
      const rect = video!.getBoundingClientRect()
      const vw = video!.videoWidth
      const vh = video!.videoHeight
      if (!vw || !vh || rect.width === 0 || rect.height === 0) return null
      const boxAspect = rect.width / rect.height
      const videoAspect = vw / vh
      let contentW = rect.width
      let contentH = rect.height
      let offsetX = 0
      let offsetY = 0
      if (videoAspect > boxAspect) {
        // Video is relatively wider than its box -- letterboxed top/bottom.
        contentH = rect.width / videoAspect
        offsetY = (rect.height - contentH) / 2
      } else {
        // Letterboxed left/right.
        contentW = rect.height * videoAspect
        offsetX = (rect.width - contentW) / 2
      }
      const localX = clientX - rect.left - offsetX
      const localY = clientY - rect.top - offsetY
      if (localX < 0 || localY < 0 || localX > contentW || localY > contentH) return null
      return {
        nx: Math.min(1, Math.max(0, localX / contentW)),
        ny: Math.min(1, Math.max(0, localY / contentH))
      }
    }

    function armRestTimer(): void {
      if (touchModeLockedRef.current) return
      if (touchModeRestTimerRef.current !== null) window.clearTimeout(touchModeRestTimerRef.current)
      touchModeRestTimerRef.current = window.setTimeout(() => {
        touchModeRestTimerRef.current = null
        dispatchTouchMode({ type: 'rest' })
      }, CONFIG.PHONE_REMOTE.MIRROR_TOUCH_SNACKBAR_REST_MS)
    }

    // Records the per-touch gesture state the trackpad machine below reads.
    // Split out because a touch can begin EITHER at touchstart (touch mode
    // already active) or later, the moment the long-press timer fires.
    function armGesture(e: TouchEvent): void {
      const t = e.touches[0]
      touchCountAtStart = e.touches.length
      touchStartClientX = lastScrollX = t.clientX
      touchStartClientY = lastScrollY = t.clientY
      touchStartAt = Date.now()
      maxMoveDuringTouch = 0
      dragging = false
      scrolling = false
      // Let the first movement frame of this touch through immediately rather
      // than waiting out a throttle window left over from the last gesture.
      lastWarpSentAt = 0
      clearDragHoldTimer()
      if (touchCountAtStart !== 1) return
      // Hold-to-drag, same as the rail: a finger that stays put past
      // DRAG_HOLD_MS arms a real click-and-drag (select text, move a file).
      dragHoldTimer = window.setTimeout(() => {
        dragHoldTimer = null
        if (maxMoveDuringTouch > TAP_MAX_MOVE_PX) return
        dragging = true
        // Same as the pad: engage ticks natively, stays silent on Safari.
        // Detents aren't wired here -- this path drags in normalized mirror
        // coords, not px deltas. The pad is the surface to test them on.
        resetDragDetent()
        hapticDragEngage()
        send({ type: 'dragStart' })
      }, DRAG_HOLD_MS)
    }

    function onTouchStart(e: TouchEvent): void {
      // The audio badge/slider sit inside the pane -- their touches are not
      // mirror gestures, and must not warp the cursor or paint a touch dot.
      if (isMirrorPaneControlTouch(e.target)) return
      // Two fingers on an un-zoomed mirror while touch mode is live is a
      // scroll/right-click gesture -- claim it so the pinch effect doesn't.
      if (active && e.touches.length >= 2) {
        armGesture(e)
        return
      }
      if (e.touches.length !== 1) return
      activatedByThisTouch = false
      const p = pointToNormalized(e.touches[0].clientX, e.touches[0].clientY)
      if (!p) return
      if (touchModeActiveRef.current) {
        // Touch mode is already up (snackbar not yet rested) -- no hold
        // needed. Warp to the touched point, then let the gesture machine
        // decide what this touch turns out to be.
        beginControl(p)
        armGesture(e)
        return
      }
      holdStartPoint = p
      holdTimer = window.setTimeout(() => {
        holdTimer = null
        if (!holdStartPoint) return
        beginControl(holdStartPoint)
        // This touch just SPENT itself activating touch mode -- lifting it
        // now must not also register as a tap-click (see
        // activatedByThisTouch above).
        activatedByThisTouch = true
        // Start the gesture from the activating touch itself, so the finger
        // that turned touch mode on can slide straight into controlling the
        // cursor without lifting.
        armGesture(e)
      }, CONFIG.PHONE_REMOTE.MIRROR_TOUCH_LONG_PRESS_MS)
    }

    function onTouchMove(e: TouchEvent): void {
      const t = e.touches[0]
      if (!t) return
      if (!active) {
        const p = pointToNormalized(t.clientX, t.clientY)
        if (
          p &&
          holdStartPoint &&
          (Math.abs(p.nx - holdStartPoint.nx) >
            CONFIG.PHONE_REMOTE.MIRROR_TOUCH_HOLD_CANCEL_THRESHOLD_NORM ||
            Math.abs(p.ny - holdStartPoint.ny) >
              CONFIG.PHONE_REMOTE.MIRROR_TOUCH_HOLD_CANCEL_THRESHOLD_NORM)
        ) {
          clearHoldTimer()
          mirrorPanHandoffRef.current?.release(t.clientX, t.clientY)
        }
        return
      }

      // Distance tracking is in SCREEN PIXELS, identical to the rail -- this
      // is what makes tap-vs-move behave the same on both surfaces.
      const moved =
        Math.abs(t.clientX - touchStartClientX) + Math.abs(t.clientY - touchStartClientY)
      if (moved > maxMoveDuringTouch) maxMoveDuringTouch = moved

      if (e.touches.length >= 2) {
        // Two fingers -> scroll, by relative delta exactly like the rail
        // (scrolling has no meaningful absolute position).
        clearDragHoldTimer()
        dragging = false
        if (moved > TAP_MAX_MOVE_PX) scrolling = true
        if (!scrolling) return
        const dx = t.clientX - lastScrollX
        const dy = t.clientY - lastScrollY
        lastScrollX = t.clientX
        lastScrollY = t.clientY
        const now = Date.now()
        if (now - lastWarpSentAt >= MOVE_THROTTLE_MS) {
          lastWarpSentAt = now
          send({ type: 'scroll', dx, dy })
        }
        return
      }

      if (touchCountAtStart >= 2) return // was 2-finger, lifted to 1 -- ignore the tail
      if (!dragging && moved > TAP_MAX_MOVE_PX) clearDragHoldTimer()

      // THE one behavioural difference from the rail: absolute warp instead
      // of a relative delta. While dragging, the Mac keeps the button down
      // and turns this into a real drag to the warped point.
      const p = pointToNormalized(t.clientX, t.clientY)
      if (!p) return
      const now = Date.now()
      if (now - lastWarpSentAt >= MOVE_THROTTLE_MS) {
        lastWarpSentAt = now
        send({ type: 'mirrorWarp', nx: p.nx, ny: p.ny })
      }
    }

    function onTouchEnd(e: TouchEvent): void {
      if (e.touches.length > 0) return
      clearHoldTimer()
      if (!active) return
      active = false
      clearDragHoldTimer()
      armRestTimer()

      if (dragging) {
        dragging = false
        hapticDragRelease()
        send({ type: 'dragEnd' })
        return
      }
      if (scrolling) {
        scrolling = false
        return
      }

      if (activatedByThisTouch) {
        activatedByThisTouch = false
        return
      }

      const duration = Date.now() - touchStartAt
      const isTap = maxMoveDuringTouch <= TAP_MAX_MOVE_PX && duration <= TAP_MAX_MS
      if (!isTap) return // moved too far / held too long -- a reposition, not a click

      if (touchCountAtStart >= 2) {
        hapticTick()
        send({ type: 'twoFingerTap' })
        return
      }

      // 1-finger tap: same double-tap disambiguation as the rail -- a single
      // tap is only sent once DOUBLE_TAP_MAX_MS passes with no follow-up, so
      // a real double-tap never also fires a spurious single click.
      const now = Date.now()
      const sincePrevTap = now - lastTapAt
      const nearPrevTap =
        Math.abs(touchStartClientX - lastTapX) <= DOUBLE_TAP_MAX_MOVE_PX &&
        Math.abs(touchStartClientY - lastTapY) <= DOUBLE_TAP_MAX_MOVE_PX
      if (pendingTapTimer !== null && sincePrevTap <= DOUBLE_TAP_MAX_MS && nearPrevTap) {
        window.clearTimeout(pendingTapTimer)
        pendingTapTimer = null
        lastTapAt = 0
        hapticTick()
        send({ type: 'doubleTap' })
        return
      }
      lastTapAt = now
      lastTapX = touchStartClientX
      lastTapY = touchStartClientY
      pendingTapTimer = window.setTimeout(() => {
        pendingTapTimer = null
        hapticTick()
        send({ type: 'tap' })
      }, DOUBLE_TAP_MAX_MS)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      clearHoldTimer()
      clearDragHoldTimer()
      if (pendingTapTimer !== null) window.clearTimeout(pendingTapTimer)
    }
  }, [mirrorOn, paneNode, send])
}
