import { describe, it, expect } from 'vitest'
import { classifyAttachment, toAttachment, summarizeAttachments } from '../attachments'
import type { MediaAttachment } from '../types'

describe('classifyAttachment', () => {
  it('classifies images by extension', () => {
    expect(classifyAttachment('/x/a.png')).toBe('image')
    expect(classifyAttachment('/x/a.JPG')).toBe('image')
  })
  it('classifies known audio formats', () => {
    expect(classifyAttachment('/x/clip.m4a')).toBe('audio')
    expect(classifyAttachment('/x/clip.wav')).toBe('audio')
  })
  it('treats anything else as a generic file', () => {
    expect(classifyAttachment('/x/doc.pdf')).toBe('file')
    expect(classifyAttachment('/x/noext')).toBe('file')
  })
})

describe('toAttachment', () => {
  it('infers kind and basename', () => {
    expect(toAttachment('/Users/me/shot.png')).toEqual({
      path: '/Users/me/shot.png',
      kind: 'image',
      name: 'shot.png'
    })
  })
})

describe('summarizeAttachments', () => {
  it('returns all-zeros for undefined / empty', () => {
    const zero = { count: 0, images: 0, audio: 0, files: 0 }
    expect(summarizeAttachments(undefined)).toEqual(zero)
    expect(summarizeAttachments([])).toEqual(zero)
  })

  it('counts each kind and the total', () => {
    const list: MediaAttachment[] = [
      { path: '/a.png', kind: 'image' },
      { path: '/b.jpg', kind: 'image' },
      { path: '/c.m4a', kind: 'audio' },
      { path: '/d.pdf', kind: 'file' }
    ]
    expect(summarizeAttachments(list)).toEqual({ count: 4, images: 2, audio: 1, files: 1 })
  })
})
