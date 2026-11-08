import { WebSocket } from 'ws'
import { screen } from 'electron'
import { CONFIG } from '../../shared/config'
import type { PhoneRemoteEvent } from '../../shared/phone-remote-protocol'
import {
  getActiveSocket,
  getViewerSocket,
  getMirrorPeerSocket,
  getMirrorMediaLive
} from './server-runtime'

/**
 * Pass a zoom scale from the controller to the watching device.
 *
 * Validated here rather than in the React app, per this directory's rule:
 * everything off the wire is attacker-controllable once the tunnel is on, and
 * a client-side rule is one the client can simply not follow. A non-finite
 * scale would poison the glasses' CSS transform into `matrix(NaN)` -- a blank
 * panel with no error anywhere, which on a device with no console is
 * indistinguishable from the mirror dying.
 *
 * Only the controller may send it. A viewer scrubbing its own zoom over the
 * wire would be a second writer for a value it already owns locally.
 */
export function relayViewerZoom(from: WebSocket, scale: unknown): void {
  const activeSocket = getActiveSocket()
  const viewerSocket = getViewerSocket()
  if (from !== activeSocket) return
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return
  if (!viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return
  const clamped = Math.min(
    CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MAX,
    Math.max(CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MIN, scale)
  )
  viewerSocket.send(
    JSON.stringify({ type: 'mirrorViewerZoom', scale: clamped } satisfies PhoneRemoteEvent)
  )
}

/**
 * Pass the controller's attach question to the watching device.
 *
 * Nothing to validate: the message carries no payload, which is the point of
 * asking rather than pushing a scale.
 */
export function relayViewerZoomRequest(from: WebSocket): void {
  const activeSocket = getActiveSocket()
  const viewerSocket = getViewerSocket()
  if (from !== activeSocket) return
  if (!viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return
  viewerSocket.send(
    JSON.stringify({ type: 'mirrorViewerZoomRequest' } satisfies PhoneRemoteEvent)
  )
}

/**
 * Pass the watching device's own zoom back to the controller.
 *
 * A separate function from `relayViewerZoom`, not a direction flag on it: the
 * sender guard is the opposite one, and folding both into a single body lets a
 * later edit satisfy the wrong one. Same clamp -- a NaN reaching the ring knob
 * poisons the track's CSS.
 */
export function relayViewerZoomChanged(from: WebSocket, scale: unknown): void {
  const activeSocket = getActiveSocket()
  const viewerSocket = getViewerSocket()
  if (!viewerSocket || from !== viewerSocket) return
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return
  const clamped = Math.min(
    CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MAX,
    Math.max(CONFIG.PHONE_REMOTE.MIRROR_ZOOM_MIN, scale)
  )
  activeSocket.send(
    JSON.stringify({ type: 'mirrorViewerZoomChanged', scale: clamped } satisfies PhoneRemoteEvent)
  )
}

/**
 * Pass an aim point from the controller's minimap to the watching device.
 *
 * Same validation stance as `relayViewerZoom` above -- a non-finite coordinate
 * reaches `coverPanForCursor` and poisons the transform into `matrix(NaN)`,
 * which on the glasses is a blank panel with no console to read it in.
 *
 * Clamped to 0..1 rather than dropped when out of range: the value is a point
 * on the desktop, so "past the edge" has an obvious correct meaning, and a
 * dropped frame mid-drag would stall the picture under a moving thumb.
 */
export function relayViewerPan(from: WebSocket, x: unknown, y: unknown): void {
  const activeSocket = getActiveSocket()
  const viewerSocket = getViewerSocket()
  if (from !== activeSocket) return
  if (typeof x !== 'number' || !Number.isFinite(x)) return
  if (typeof y !== 'number' || !Number.isFinite(y)) return
  if (!viewerSocket || viewerSocket.readyState !== WebSocket.OPEN) return
  viewerSocket.send(
    JSON.stringify({
      type: 'mirrorViewerPan',
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y))
    } satisfies PhoneRemoteEvent)
  )
}

/**
 * Tell the CONTROLLER whether a watching device is attached and has a picture.
 *
 * Called from every site that moves `viewerSocket` or `mirrorPeerSocket`, and
 * deliberately not from the call sites' own bodies -- six places each
 * remembering to emit is how the two state machines in `connection-state.ts`
 * drifted apart, and the ring's zoom track would be the thing left stranded:
 * a track for glasses that are gone takes touches the pad should have had.
 *
 * Sent only to the controller. The viewer knows its own state, and the
 * controller is the only device that cannot infer this from `role`.
 */
export function publishViewerState(): void {
  const activeSocket = getActiveSocket()
  const viewerSocket = getViewerSocket()
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return
  const attached = !!viewerSocket && viewerSocket.readyState === WebSocket.OPEN
  // Keyed on the MEDIA, not on which socket signalled it. A viewer that
  // reconnects gets a new socket while its WebRTC peer keeps painting, so
  // `mirrorPeerSocket === viewerSocket` read false for a mirror that was
  // plainly running. `mirrorPeerSocket === null` is that reconnect window.
  const mirrorPeerSocket = getMirrorPeerSocket()
  const peerIsViewer = mirrorPeerSocket === viewerSocket || mirrorPeerSocket === null
  const receiving = attached && getMirrorMediaLive() && peerIsViewer
  // Read under the cursor, matching startCursorStream's normalization -- both
  // describe the same display (screen-stream captures the one the cursor is
  // on), so a minimap drawn from these bounds and an aim point in cursorPos
  // space are guaranteed to be the same coordinate system.
  const bounds = receiving ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds : null
  const event: PhoneRemoteEvent =
    receiving && bounds && bounds.width > 0 && bounds.height > 0
      ? { type: 'viewer', viewer: 'receiving', screenW: bounds.width, screenH: bounds.height }
      : attached
        ? { type: 'viewer', viewer: 'connected' }
        : { type: 'viewer', viewer: 'none' }
  activeSocket.send(JSON.stringify(event))
}
