import { describe, it, expect, vi } from 'vitest'

vi.mock('../../store/settings', () => ({ SETTINGS: { get: () => ({ ffmpegPath: '/nonexistent/ffmpeg' }) } }))

import { resolveDeviceIndex } from '../devices'
import { CONFIG } from '../../../shared/config'

const mics = [
  { index: '0', name: 'MacBook Pro Microphone' },
  { index: '1', name: 'AirPods Pro' }
]

describe('resolveDeviceIndex', () => {
  it('resolves a plugged-in mic by name to its current index', () => {
    expect(resolveDeviceIndex('AirPods Pro', mics, CONFIG.AUDIO_DEVICE)).toBe('1')
  })

  it("falls back to the computer's chosen mic when the picked one is unplugged", () => {
    expect(resolveDeviceIndex('Studio USB Mic', mics, CONFIG.AUDIO_DEVICE)).toBe('default')
  })

  it('passes the system-default mic through untouched', () => {
    expect(resolveDeviceIndex(CONFIG.AUDIO_DEVICE, mics, CONFIG.AUDIO_DEVICE)).toBe('default')
  })

  it('keeps an unknown name unchanged when there is no fallback (video)', () => {
    expect(resolveDeviceIndex('Capture screen 1', [{ index: '3', name: 'Capture screen 0' }])).toBe('Capture screen 1')
  })

  it('keeps a bare index as stored', () => {
    expect(resolveDeviceIndex('2', mics, CONFIG.AUDIO_DEVICE)).toBe('2')
  })
})
