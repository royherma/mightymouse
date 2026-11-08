import { describe, it, expect, vi } from 'vitest'
import type { WebSocket } from 'ws'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp', getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const { handleSocketMessage, createPendingFrame } = await import('../socket-messages')

function send(type: string, isController: boolean): ReturnType<typeof vi.fn> {
  const onMessage = vi.fn()
  handleSocketMessage(JSON.stringify({ type }), false, {
    ws: {} as WebSocket,
    callbacks: { onMessage },
    pending: createPendingFrame(),
    isControllerInput: () => isController,
    markInput: () => undefined,
    mirrorHolder: () => null,
    claimMirror: () => undefined,
    releaseMirror: () => undefined,
    requestControlSwap: () => undefined,
    labelForSocket: () => 'phone',
    isIdleMessage: () => false
  })
  return onMessage
}

describe('unpairSelf is honoured only from the controller', () => {
  it('the controller can unpair itself', () => {
    expect(send('unpairSelf', true)).toHaveBeenCalledTimes(1)
  })

  it('a viewer cannot revoke the controller by sending unpairSelf', () => {
    expect(send('unpairSelf', false)).not.toHaveBeenCalled()
  })

  it('other viewer messages still pass through', () => {
    expect(send('getSensitivity', false)).toHaveBeenCalledTimes(1)
  })
})
