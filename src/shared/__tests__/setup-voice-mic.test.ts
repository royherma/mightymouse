import { describe, it, expect } from 'vitest'
import { voiceRowState, SETUP_STATUS, SETUP_FIX_KIND } from '../setup-check'

/**
 * The Voice row must describe the whole capability, not just the binaries.
 *
 * neljlee92 (2026-09-06) saw "Voice transcription — Ready" while his mic was
 * blocked, pressed the install button four times in four minutes, and never
 * transcribed a word. Every assertion here is that session.
 */

describe('voiceRowState', () => {
  it('is ok only when the engine AND the mic are both there', () => {
    expect(voiceRowState(true, true).status).toBe(SETUP_STATUS.ok)
  })

  it('does not claim ready when the engine is installed but the mic is off', () => {
    expect(voiceRowState(true, false).status).not.toBe(SETUP_STATUS.ok)
  })

  it('asks for the mic, not another download, when only the mic is missing', () => {
    // An `install` here IS the four-reinstall bug: it re-fetches 148MB that is
    // already on disk and leaves the real blocker untouched.
    expect(voiceRowState(true, false).fixKind).toBe(SETUP_FIX_KIND.grant)
  })

  it('still offers the download when the engine really is missing', () => {
    expect(voiceRowState(false, true).fixKind).toBe(SETUP_FIX_KIND.install)
  })

  it('prefers the download when both are missing — a mic alone would not fix it', () => {
    expect(voiceRowState(false, false).fixKind).toBe(SETUP_FIX_KIND.install)
  })

  it('never blocks setup: voice stays optional however it fails', () => {
    for (const s of [voiceRowState(true, false), voiceRowState(false, false)]) {
      expect(s.status).toBe(SETUP_STATUS.optional)
    }
  })

  it('carries a fix on every failing row — the module invariant', () => {
    for (const s of [voiceRowState(true, false), voiceRowState(false, false)]) {
      expect(s.fixKind).toBeDefined()
    }
  })
})
