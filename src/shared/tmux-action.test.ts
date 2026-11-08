/**
 * Locks the tmux prefix vocabulary — the half of the feature a typecheck cannot
 * see.
 *
 * Every TMUX_ACTION value and the prefix key itself become argv for a spawned
 * mm-input, whose keyCodes table is keyed by these exact literals. A value that
 * is not a PhoneRemoteKeyName typechecks fine as a string and exits 2 at the
 * binary, on the device, with no error surfaced to the phone. Same class as the
 * wire-union duplication this directory keeps getting bitten by: two places
 * have to agree and nothing else enforces it.
 */
import { describe, it, expect } from 'vitest'
import {
  TMUX_ACTION,
  TMUX_PREFIX_KEY,
  TMUX_PREFIX_MODIFIER,
  isTmuxAction,
  isPhoneRemoteKeyName,
  isPhoneRemoteModifier
} from './phone-remote-keys'

describe('TMUX_ACTION', () => {
  it('maps every action to a real key mm-input can press', () => {
    for (const [action, key] of Object.entries(TMUX_ACTION)) {
      expect(isPhoneRemoteKeyName(key), `${action} -> ${key}`).toBe(true)
    }
  })

  it('sends a prefix mm-input can actually press', () => {
    expect(isPhoneRemoteKeyName(TMUX_PREFIX_KEY)).toBe(true)
    expect(isPhoneRemoteModifier(TMUX_PREFIX_MODIFIER)).toBe(true)
  })

  it('zooms with the key tmux binds to resize-pane -Z', () => {
    // ctrl+b then z. The whole point of the button; a rename here would ship a
    // button that silently does something else in tmux.
    expect(TMUX_ACTION.zoom).toBe('z')
  })

  it('moves panes with the arrow keys, not characters', () => {
    expect(TMUX_ACTION.paneLeft).toBe('left')
    expect(TMUX_ACTION.paneRight).toBe('right')
    expect(TMUX_ACTION.paneUp).toBe('up')
    expect(TMUX_ACTION.paneDown).toBe('down')
  })
})

describe('isTmuxAction', () => {
  it('accepts every declared action', () => {
    for (const action of Object.keys(TMUX_ACTION)) expect(isTmuxAction(action)).toBe(true)
  })

  // The guard is the ONLY thing between a hand-crafted WS message and the key
  // that reaches a spawned process — the wire layer casts without validating.
  it('rejects anything off the wire that is not one', () => {
    for (const bad of ['z', 'zoom ', 'ZOOM', '', 'paneleft', null, undefined, 7, {}, ['zoom']]) {
      expect(isTmuxAction(bad), String(bad)).toBe(false)
    }
  })
})
