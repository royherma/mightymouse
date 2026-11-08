import { describe, expect, it, vi } from 'vitest'

const sendToPhone = vi.fn()
let finishRead: (() => void) | null = null
const readAppContext = vi.fn(
  () => new Promise((resolve) => (finishRead = () => resolve({ adapterId: null })))
)

vi.mock('electron', () => ({ clipboard: { availableFormats: () => [] } }))
vi.mock('../../platform', () => ({ PERMISSIONS: {}, context: { readAppContext: () => readAppContext() } }))
vi.mock('../../platform/geometry', () => ({ isWindowLayoutKind: () => false }))
vi.mock('../../phone-remote/server', () => ({ isPhoneConnected: () => true, sendToPhone: (m: unknown) => sendToPhone(m) }))
vi.mock('../../capture/screen-stream', () => ({ noteScreenStreamInput: vi.fn() }))

import { sendAppContext } from '../phone-remote-context'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('sendAppContext during a burst of Mac app switches', () => {
  it('runs one read at a time and one follow-up read for everything that arrived meanwhile', async () => {
    sendAppContext()
    for (let i = 0; i < 5; i++) sendAppContext()
    expect(readAppContext).toHaveBeenCalledTimes(1)

    finishRead?.()
    await settle()
    expect(readAppContext).toHaveBeenCalledTimes(2)

    finishRead?.()
    await settle()
    expect(readAppContext).toHaveBeenCalledTimes(2)
    expect(sendToPhone).toHaveBeenCalledTimes(2)
  })
})
