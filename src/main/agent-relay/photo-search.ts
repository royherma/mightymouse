/**
 * The Mac half of `photos_search`. Every other Mac->phone event is
 * fire-and-forget or single-flight; this one needs a real answer back, so it
 * owns the correlation ids and the timeouts nothing else here needed.
 *
 * Deliberately NOT routed through the relay card store: a search mints no card
 * and asks the user for nothing. Only the FETCH half can involve a human, and
 * only when the phone has no permission yet.
 */

import { randomUUID } from 'crypto'
import { getActiveSocket } from '../phone-remote/server-runtime'
import type { PhoneMatchQuery, PhotoMatchWire } from '../../shared/phone-remote-protocol'

/** The phone answers from a local library read, so this is a "the phone is
 *  gone" timeout, not a slow-query one. Short on purpose: an agent waiting on
 *  a dead socket should be told to ask the user, not stall its turn. */
const PHOTO_SEARCH_TIMEOUT_MS = 15_000

/** iCloud can have to pull the original down over the network, which is the
 *  one genuinely slow step in the whole feature. */
const PHOTO_FETCH_TIMEOUT_MS = 90_000

export type PhotoScope = 'none' | 'limited' | 'full'

export interface PhotoSearchAnswer {
  scope: PhotoScope
  matched: number
  photos: PhotoMatchWire[]
}

type Pending =
  | { kind: 'search'; resolve: (value: PhotoSearchAnswer | null) => void; timer: NodeJS.Timeout }
  | { kind: 'access'; resolve: (value: PhotoScope | null) => void; timer: NodeJS.Timeout }
  | { kind: 'fetch'; resolve: (value: string | null) => void; timer: NodeJS.Timeout }

/** Keyed by requestId. An entry exists only while someone is awaiting it, so a
 *  late answer after a timeout finds nothing and is dropped -- which is the
 *  correct outcome, since the agent has already been told it timed out. */
const pending = new Map<string, Pending>()

/** Sends one event and parks a resolver for its answer. Returns null when the
 *  phone is unreachable or never replies; every caller turns that into words
 *  for the agent rather than a throw. */
function ask<T>(
  event: Record<string, unknown>,
  kind: Pending['kind'],
  timeoutMs: number
): Promise<T | null> {
  const socket = getActiveSocket()
  // No socket is the ordinary case, not a fault: the phone is asleep, out of
  // range, or was never connected. Answered immediately so the agent gets a
  // sentence back instead of waiting out the full timeout for a known answer.
  if (!socket || socket.readyState !== socket.OPEN) return Promise.resolve(null)

  const requestId = randomUUID()
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve(null)
    }, timeoutMs)
    // Unref'd so a forgotten timer can never hold the app open at quit.
    timer.unref?.()
    pending.set(requestId, { kind, resolve, timer } as Pending)
    socket.send(JSON.stringify({ ...event, requestId }))
  })
}

/** Called by the socket message handler for every photos* answer the phone
 *  sends. Unknown ids are dropped silently -- see `pending`. */
export function resolvePhotoAnswer(
  requestId: string,
  answer: PhotoSearchAnswer | PhotoScope | string | null,
  kind: Pending['kind']
): boolean {
  const entry = pending.get(requestId)
  // The kind check stops a malformed or spoofed frame resolving a waiter of a
  // different shape, which would hand the caller a value it cannot read.
  if (!entry || entry.kind !== kind) return false
  clearTimeout(entry.timer)
  pending.delete(requestId)
  ;(entry.resolve as (value: unknown) => void)(answer)
  return true
}

export function searchPhotos(query: PhoneMatchQuery): Promise<PhotoSearchAnswer | null> {
  return ask<PhotoSearchAnswer>(
    {
      type: 'photosSearch',
      after: query.after,
      before: query.before,
      isScreenshot: query.isScreenshot,
      limit: query.limit
    },
    'search',
    PHOTO_SEARCH_TIMEOUT_MS
  )
}

/** Raises the iOS prompt. Only ever called after a search returned 'none'. */
export function requestPhotoAccess(): Promise<PhotoScope | null> {
  return ask<PhotoScope>({ type: 'photosRequestAccess' }, 'access', PHOTO_SEARCH_TIMEOUT_MS)
}

/** Resolves to the saved file path. The bytes arrive over the existing
 *  imageMeta+binary path, so what lands here is only the path that path wrote. */
export function fetchPhoto(id: string): Promise<string | null> {
  return ask<string>({ type: 'photosFetch', id }, 'fetch', PHOTO_FETCH_TIMEOUT_MS)
}

/** Every waiter gives up at once when the phone goes away. Without this a
 *  disconnect mid-search leaves the agent waiting the full timeout for an
 *  answer that provably cannot arrive. */
export function abortPhotoRequests(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    ;(entry.resolve as (value: unknown) => void)(null)
  }
  pending.clear()
}
