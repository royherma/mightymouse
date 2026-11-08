import { describe, it, expect } from 'vitest'
import { parsePointTag, parseTypeTag } from '../point-tag'

describe('parsePointTag', () => {
  it('returns null when there is no tag', () => {
    expect(parsePointTag('Just a normal answer with no directive.')).toBeNull()
  })

  it('parses raw pixel coords', () => {
    const r = parsePointTag('The export button is here.\n[POINT:1240,860]')
    expect(r?.tag).toEqual({ kind: 'coords', x: 1240, y: 860 })
    expect(r?.stripped).toBe('The export button is here.')
  })

  it('tolerates whitespace around the colon and comma', () => {
    const r = parsePointTag('answer [POINT: 12 , 34 ]')
    expect(r?.tag).toEqual({ kind: 'coords', x: 12, y: 34 })
  })

  it('parses a quoted label', () => {
    const r = parsePointTag('Click Export to save.\n[POINT:"Export"]')
    expect(r?.tag).toEqual({ kind: 'label', label: 'Export' })
    expect(r?.stripped).toBe('Click Export to save.')
  })

  it('keeps multi-word labels with punctuation intact', () => {
    const r = parsePointTag('[POINT:"Export as PNG…"]')
    expect(r?.tag).toEqual({ kind: 'label', label: 'Export as PNG…' })
    expect(r?.stripped).toBe('')
  })

  it('is case-insensitive on the POINT keyword', () => {
    expect(parsePointTag('[point:5,6]')?.tag).toEqual({ kind: 'coords', x: 5, y: 6 })
  })

  it('strips every tag from the visible text', () => {
    const r = parsePointTag('a [POINT:1,2] b [POINT:"X"] c')
    // First tag wins for the resolved point...
    expect(r?.tag).toEqual({ kind: 'coords', x: 1, y: 2 })
    // ...but all tags are removed from what the user sees.
    expect(r?.stripped).toBe('a  b  c')
  })

  it('does not match a malformed tag', () => {
    expect(parsePointTag('[POINT:abc]')).toBeNull()
    expect(parsePointTag('[POINT:12]')).toBeNull()
  })
})

describe('parseTypeTag', () => {
  it('returns null when there is no tag', () => {
    expect(parseTypeTag('Just a normal answer.')).toBeNull()
  })

  it('parses literal text', () => {
    const r = parseTypeTag('Typing it now.\n[TYPE:"hello world"]')
    expect(r?.tag).toEqual({ kind: 'text', text: 'hello world' })
    expect(r?.stripped).toBe('Typing it now.')
  })

  it('parses a key combo', () => {
    const r = parseTypeTag('Submitting.\n[TYPE:key="cmd+a"]')
    expect(r?.tag).toEqual({ kind: 'key', combo: 'cmd+a' })
    expect(r?.stripped).toBe('Submitting.')
  })

  it('parses a bare named key', () => {
    expect(parseTypeTag('[TYPE:key="return"]')?.tag).toEqual({ kind: 'key', combo: 'return' })
  })

  it('keeps text with punctuation and spaces intact', () => {
    const r = parseTypeTag('[TYPE:"hello@example.com, hi!"]')
    expect(r?.tag).toEqual({ kind: 'text', text: 'hello@example.com, hi!' })
  })

  it('is case-insensitive on the TYPE keyword', () => {
    expect(parseTypeTag('[type:"x"]')?.tag).toEqual({ kind: 'text', text: 'x' })
  })

  it('strips every type tag from the visible text', () => {
    const r = parseTypeTag('a [TYPE:"one"] b [TYPE:key="tab"] c')
    expect(r?.tag).toEqual({ kind: 'text', text: 'one' })
    expect(r?.stripped).toBe('a  b  c')
  })

  it('does not match a malformed tag', () => {
    expect(parseTypeTag('[TYPE:abc]')).toBeNull()
    expect(parseTypeTag('[TYPE:]')).toBeNull()
  })
})
