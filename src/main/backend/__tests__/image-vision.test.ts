import { describe, it, expect, vi, beforeEach } from 'vitest'

// nativeImage is Electron-only — mock it so the loader is testable in node. Each
// test configures the fake image's size/jpeg via the controls below.
const fakeImage = {
  isEmpty: vi.fn(() => false),
  getSize: vi.fn(() => ({ width: 100, height: 100 })),
  resize: vi.fn(function (this: unknown) {
    return fakeImage
  }),
  toJPEG: vi.fn(() => Buffer.from([0xff, 0xd8, 0xff]))
}
vi.mock('electron', () => ({
  nativeImage: { createFromPath: vi.fn(() => fakeImage) }
}))
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }))

import { isImagePath, loadImageAsDataUrl, loadImagesForVision } from '../image-vision'
import { existsSync } from 'fs'

beforeEach(() => {
  vi.clearAllMocks()
  fakeImage.isEmpty.mockReturnValue(false)
  fakeImage.getSize.mockReturnValue({ width: 100, height: 100 })
  fakeImage.resize.mockReturnValue(fakeImage)
  fakeImage.toJPEG.mockReturnValue(Buffer.from([0xff, 0xd8, 0xff]))
  vi.mocked(existsSync).mockReturnValue(true)
})

describe('isImagePath', () => {
  it('accepts known image extensions, case-insensitive', () => {
    expect(isImagePath('/x/shot.png')).toBe(true)
    expect(isImagePath('/x/shot.JPG')).toBe(true)
    expect(isImagePath('/x/a.webp')).toBe(true)
  })
  it('rejects non-images and extension-less folders', () => {
    expect(isImagePath('/x/transcript.txt')).toBe(false)
    expect(isImagePath('/x/capture-folder')).toBe(false) // a run folder, no ext
    expect(isImagePath('/x/video.mp4')).toBe(false)
  })
})

describe('loadImageAsDataUrl', () => {
  it('returns a jpeg data url for an existing image', () => {
    const url = loadImageAsDataUrl('/x/shot.png')
    expect(url).toMatch(/^data:image\/jpeg;base64,/)
  })
  it('returns null for a non-image path (never touches disk)', () => {
    expect(loadImageAsDataUrl('/x/notes.txt')).toBeNull()
  })
  it('returns null when the file is missing', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    expect(loadImageAsDataUrl('/x/gone.png')).toBeNull()
  })
  it('returns null for an undecodable image', () => {
    fakeImage.isEmpty.mockReturnValue(true)
    expect(loadImageAsDataUrl('/x/broken.png')).toBeNull()
  })
  it('downscales only when over the ceiling, preserving the smaller side', () => {
    fakeImage.getSize.mockReturnValue({ width: 4000, height: 1000 }) // wide → width-bound
    loadImageAsDataUrl('/x/wide.png')
    expect(fakeImage.resize).toHaveBeenCalledWith({ width: 1920 })
  })
  it('does not upscale a small image', () => {
    fakeImage.getSize.mockReturnValue({ width: 200, height: 150 })
    loadImageAsDataUrl('/x/small.png')
    expect(fakeImage.resize).not.toHaveBeenCalled()
  })
})

describe('loadImagesForVision', () => {
  it('keeps images, drops folders and non-images', () => {
    const out = loadImagesForVision(['/x/shot.png', '/x/capture-folder', '/x/t.txt'])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^data:image\/jpeg;base64,/)
  })
})
