import type { PhoneRemoteEvent } from '@shared/phone-remote-protocol'

type EventType = PhoneRemoteEvent['type']
type EventOfType<Type extends EventType> = Extract<PhoneRemoteEvent, { type: Type }>
type Handler<Type extends EventType> = (event: EventOfType<Type>) => void

export interface SocketBus {
  dispatch(event: PhoneRemoteEvent): void
  subscribe<Type extends EventType>(type: Type, handler: Handler<Type>): () => void
}

/** A tiny typed fan-out for the single phone socket. Feature hooks subscribe
 * to only the protocol events they own; the connection remains singular. */
export function createSocketBus(): SocketBus {
  const handlers = new Map<EventType, Set<(event: never) => void>>()

  return {
    dispatch(event) {
      handlers.get(event.type)?.forEach((handler) => handler(event as never))
    },
    subscribe(type, handler) {
      const typedHandler = handler as (event: never) => void
      const subscribers = handlers.get(type) ?? new Set<(event: never) => void>()
      subscribers.add(typedHandler)
      handlers.set(type, subscribers)
      return () => {
        subscribers.delete(typedHandler)
        if (subscribers.size === 0) handlers.delete(type)
      }
    }
  }
}
