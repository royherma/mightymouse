/**
 * The phone's half of `photos_search`. Pure relay: a socket event from the Mac
 * becomes a native bridge call, and the intent that answers it becomes a socket
 * message back. No state, no UI -- the library read happens in Swift and the
 * bytes go out over the existing image path.
 *
 * Off the native shell every handler still answers, with `scope: 'none'` or an
 * `unsupported` failure. Silence would cost the agent the full Mac-side timeout
 * for something knowable immediately: web Safari has no photo library API.
 */

import { useEffect } from 'react'
import { nativeBridge, subscribeNativeIntent } from '../native-bridge'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

export function usePhotos(
  bus: SocketBus,
  send: UseConnectionResult['send'],
  sendBinary: UseConnectionResult['sendBinary']
): void {
  useEffect(() => {
    // Every native answer is routed by the requestId Swift echoed back, so no
    // correlation state is needed on this side at all.
    const offIntent = subscribeNativeIntent((event) => {
      if (event.type === 'photosSearchResult') {
        send({
          type: 'photosSearchResult',
          requestId: event.requestId,
          scope: event.scope,
          matched: event.matched,
          photos: event.photos
        })
        return
      }
      if (event.type === 'photosAccessResult') {
        send({ type: 'photosAccessResult', requestId: event.requestId, scope: event.scope })
        return
      }
      if (event.type === 'photosGetResult') {
        // Only the FAILURE half goes back as JSON. A success is bytes, and they
        // travel the imageMeta+binary path so one photo has one transport.
        if (event.error || !event.b64) {
          send({
            type: 'photosFetchFailed',
            requestId: event.requestId,
            reason: event.error ?? 'failed'
          })
          return
        }
        void sendPhotoBytes(event.requestId, event.b64, send, sendBinary)
      }
    }, [])

    const unsubscribers = [
      bus.subscribe('photosSearch', (msg) => {
        if (!nativeBridge.available) {
          send({
            type: 'photosSearchResult',
            requestId: msg.requestId,
            scope: 'none',
            matched: 0,
            photos: []
          })
          return
        }
        nativeBridge.photosSearch({
          requestId: msg.requestId,
          after: msg.after,
          before: msg.before,
          isScreenshot: msg.isScreenshot,
          limit: msg.limit
        })
      }),
      bus.subscribe('photosRequestAccess', (msg) => {
        if (!nativeBridge.available) {
          send({ type: 'photosAccessResult', requestId: msg.requestId, scope: 'none' })
          return
        }
        nativeBridge.photosRequestAccess(msg.requestId)
      }),
      bus.subscribe('photosFetch', (msg) => {
        if (!nativeBridge.available) {
          send({ type: 'photosFetchFailed', requestId: msg.requestId, reason: 'unsupported' })
          return
        }
        nativeBridge.photosGet(msg.requestId, msg.id)
      })
    ]

    return () => {
      offIntent()
      unsubscribers.forEach((off) => off())
    }
  }, [bus, send, sendBinary])
}

/** base64 -> bytes -> the same meta+binary pair a picked photo uses. Swift hands
 *  base64 because WKScriptMessage carries no raw bytes; the socket does, so the
 *  string is decoded here rather than shipped as JSON at 4/3 the size. */
async function sendPhotoBytes(
  requestId: string,
  b64: string,
  send: UseConnectionResult['send'],
  sendBinary: UseConnectionResult['sendBinary']
): Promise<void> {
  try {
    // fetch() on a data: URL is the decoder every browser already has, and it
    // handles the padding cases a hand-rolled atob loop gets wrong.
    const response = await fetch(`data:image/jpeg;base64,${b64}`)
    const buf = await response.arrayBuffer()
    send({
      type: 'imageMeta',
      mime: 'image/jpeg',
      byteLength: buf.byteLength,
      name: `photo-${requestId.slice(0, 8)}.jpg`,
      requestId
    })
    sendBinary(buf)
  } catch {
    send({ type: 'photosFetchFailed', requestId, reason: 'failed' })
  }
}
