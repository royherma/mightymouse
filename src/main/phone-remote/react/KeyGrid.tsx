import { useEffect, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { hapticKeyPress } from './haptics'
import {
  isPhoneRemoteKeyName,
  type PhoneRemoteKeyName,
  type PhoneRemoteModifier
} from '@shared/phone-remote-keys'
import { KEYBOARD_LAYOUTS, type KeyboardLayoutId, type KeyDef } from './keyboard-layouts'
import { latchAction } from './modifier-latch'
import { Button } from '@shared/ui/Button'


/**
 * WHY PLAIN LETTERS DON'T USE 'key' COMBOS: unmodified characters go through
 * the 'typeText' message (verb 'type'), which posts literal Unicode -- any
 * printable character, zero keycode-table maintenance. The 'key' combo path
 * exists for everything typeText can't say: named keys (return, arrows,
 * F-row) and any key ridden by a modifier (⌘C must be a real Cmd-flagged
 * C-keycode event, not the text "c"). mm-input's keyCodes table carries the
 * full US-ANSI base set for exactly this split.
 *
 * MODIFIERS ARE HELD BY DEFAULT, LATCHED ON DOUBLE-TAP (all client-side).
 * The first cut latched every modifier as a sticky one-shot and Roy read an
 * armed ⌘ as "stuck on": "you should be able to multi-press like you would on
 * a regular keyboard and not keep items up unless it's caps lock." So a
 * single press HOLDS, like the physical board: hold ⌘/⌥/⌃/fn/⇧ with one
 * finger, tap keys with another (⌘ held + C, V = copy then paste), release
 * and it's gone.
 *
 * Double-tapping the same modifier inside DOUBLE_TAP_MS latches it, for
 * combos a thumb can't span (⌘⇧4) and for one-handed use. What makes this
 * different from the rejected version is that the latch is ASKED FOR, is
 * drawn differently from a held key (.vkKey.latched -- a ring, not just a
 * fill), and un-latches on a third tap of the same key.
 *
 * A latch STAYS ARMED across keypresses. It shipped as a one-shot first
 * (macOS Sticky Keys' behavior) and that was wrong here: Roy latched ⌃ to
 * walk tabs with ⌃1, ⌃2, ⌃3 and it disarmed on the first one -- the moment
 * you know more are coming is exactly when you latched. So only three things
 * clear it: tapping the key again, closing the keyboard, or never having
 * double-tapped. Caps Lock is unchanged (letters only -- never 1 into !).
 *
 * That's why keys fire on POINTER events, not click: a click needs press and
 * release from the same interaction, so a second finger's tap while the first
 * holds a modifier would never resolve -- pointerdown fires per-finger.
 * preventDefault() on every pointerdown kills the synthetic click that would
 * otherwise double-fire.
 *
 * RELEASE IS TRACKED AT THE WINDOW, BY POINTER ID -- not with onPointerUp on
 * the key itself. First cut trusted the button's own pointerup and iOS Safari
 * dropped it under multi-touch, leaving ⌘ held after the finger lifted (Roy:
 * "next time I press another key it auto has like the cmd key down"). A
 * window-level pointerup/pointercancel ALWAYS fires for every lifted touch,
 * wherever it lands; each hold records its pointerId on the way down, so the
 * matching lift -- and only that lift, not the combo finger's -- releases it.
 */

/** How long a tapped key stays lit. Roy's call after trying it on-device: 140ms
 *  read as "too fast" -- the flash was gone before the eye caught it. Long
 *  enough here that the confirmation is unmissable; the restart-on-retap in
 *  flash() is what keeps fast typing from strobing at this duration. */
const KEY_FLASH_MS = 500

export default function KeyGrid(props: {
  open: boolean
  layoutId: KeyboardLayoutId
  onChar: (text: string) => void
  onBackspace: () => void
  onSpecialKey: (key: PhoneRemoteKeyName) => void
  onCombo: (modifiers: PhoneRemoteModifier[], key: PhoneRemoteKeyName) => void
}): React.JSX.Element {
  const { open, layoutId, onChar, onBackspace, onSpecialKey, onCombo } = props
  const [shiftHeld, setShiftHeld] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  // Double-tapped modifiers, latched until used or tapped off (see the
  // DOUBLE-TAP LATCHES note in the header). Separate from heldMods because
  // the two are cleared by completely different events -- a finger lifting
  // vs. a combo firing -- and merging them made a lift clear a latch.
  const [latchedMods, setLatchedMods] = useState<readonly PhoneRemoteModifier[]>([])
  const [shiftLatched, setShiftLatched] = useState(false)
  // When each hold key was last pressed, for the double-tap window. Keyed by
  // the key's display so ⌘-left and ⌘-right latch independently of each other
  // only if they're distinct keys -- which is what a real keyboard does.
  const lastTapAt = useRef<Map<string, number>>(new Map())
  const [heldMods, setHeldMods] = useState<readonly PhoneRemoteModifier[]>([])
  // Which finger is holding which key -- the source of truth for release.
  // A ref, not state: the window listener below must see live entries without
  // re-subscribing, and nothing renders from it (heldMods/shiftHeld do that).
  const heldPointers = useRef<Map<number, KeyDef>>(new Map())
  // Which key just fired, for the press flash. Driven from the pointerdown that
  // actually sent the keystroke rather than left to CSS :active, which iOS drops
  // on fast taps -- the press then lands on the Mac with nothing on screen
  // saying so, which reads as a missed key. Row/col, not the glyph: ⌘ and ⇧
  // appear twice each and must flash independently.
  // A SET, not one key: at 500ms a flash outlives the next keystroke, so
  // typing normally has several keys lit at once. A single-slot version darkened
  // the previous key the instant you hit the next one, which at this duration
  // means you never see one finish.
  const [flashKeys, setFlashKeys] = useState<ReadonlySet<string>>(() => new Set())
  const flashTimers = useRef<Map<string, number>>(new Map())

  /** Light a key up. Each key gets its own timer so it always shows the full
   *  window; re-tapping the same key restarts its timer rather than stacking a
   *  second one, so a repeated key stays lit instead of strobing. */
  function flash(id: string): void {
    const existing = flashTimers.current.get(id)
    if (existing !== undefined) window.clearTimeout(existing)
    setFlashKeys((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    flashTimers.current.set(
      id,
      window.setTimeout(() => {
        flashTimers.current.delete(id)
        setFlashKeys((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, KEY_FLASH_MS)
    )
  }

  // Pending flashes outlive the keyboard closing otherwise, and fire setState on
  // an unmounted component.
  useEffect(() => {
    const timers = flashTimers.current
    return () => {
      for (const id of timers.values()) window.clearTimeout(id)
      timers.clear()
    }
  }, [])


  const layout = KEYBOARD_LAYOUTS[layoutId]


  /** The modifier set a combo carries: everything held OR latched, plus shift
   *  from either source (⌘⇧Z needs shift on the COMBO, not the character
   *  face). Deduped -- a modifier can be held and latched at once. */
  function comboModifiers(): PhoneRemoteModifier[] {
    const mods = new Set<PhoneRemoteModifier>([...heldMods, ...latchedMods])
    if (shiftHeld || shiftLatched) mods.add('shift')
    return [...mods]
  }

  /** Drops every latch. NOT called after a keypress -- a latch persists until
   *  the user taps it off, because the reason to latch at all is firing a
   *  RUN of combos (⌃1, ⌃2, ⌃3 through tabs). One-shot latches shipped first
   *  and were wrong: they disarmed on the very first combo, which is the one
   *  moment you know more are coming. Only closing the keyboard clears. */
  function clearLatches(): void {
    setLatchedMods([])
    setShiftLatched(false)
  }

  function holdStart(pointerId: number, k: KeyDef): void {
    hapticKeyPress()
    heldPointers.current.set(pointerId, k)

    // Elapsed since this same key's last press -- Infinity on a first press,
    // so latchAction never sees a bogus age. Rules live in modifier-latch.ts.
    const now = performance.now()
    const prev = lastTapAt.current.get(k.display)
    const since = prev === undefined ? Infinity : now - prev
    lastTapAt.current.set(k.display, now)

    if (k.action === 'shift') {
      setShiftHeld(true)
      const act = latchAction(since, shiftLatched)
      if (act !== 'none') setShiftLatched(act === 'latch')
    } else if (k.modifier) {
      const mod = k.modifier
      setHeldMods((p) => (p.includes(mod) ? p : [...p, mod]))
      const act = latchAction(since, latchedMods.includes(mod))
      if (act === 'latch') setLatchedMods((p) => (p.includes(mod) ? p : [...p, mod]))
      else if (act === 'unlatch') setLatchedMods((p) => p.filter((m) => m !== mod))
    }
  }

  // See the header: releases come from the WINDOW, keyed by pointerId --
  // iOS Safari drops element-level pointerup under multi-touch, which left
  // modifiers stuck on. Functional setState only, so the once-mounted
  // listener never closes over stale state.
  useEffect(() => {
    const release = (e: PointerEvent): void => {
      const k = heldPointers.current.get(e.pointerId)
      if (!k) return
      heldPointers.current.delete(e.pointerId)
      if (k.action === 'shift') setShiftHeld(false)
      else if (k.modifier) {
        const mod = k.modifier
        setHeldMods((prev) => prev.filter((m) => m !== mod))
      }
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [])

  // Closing the keyboard drops any latch: coming back to a board that is
  // silently armed with ⌘ is the "stuck on" failure this feature is one
  // double-tap away from. Caps Lock persists -- same as a real keyboard.
  useEffect(() => {
    if (!open) clearLatches()
  }, [open])

  function fireKey(k: KeyDef): void {
    hapticKeyPress()
    // Held and latched are equivalent from here down -- how a modifier got
    // armed is the user's business, not this switch's.
    const modsArmed = heldMods.length > 0 || latchedMods.length > 0
    const shiftArmed = shiftHeld || shiftLatched
    switch (k.action) {
      case 'capslock':
        setCapsLock((v) => !v)
        return
      case 'backspace':
        // Armed modifiers ride delete too -- ⌥⌫ (delete word) and ⌘⌫ (delete
        // line) are real Mac muscle memory.
        if (modsArmed) onCombo(comboModifiers(), 'delete')
        else onBackspace()
        return
      case 'special':
        if (!k.specialKey) return
        if (modsArmed || shiftArmed) onCombo(comboModifiers(), k.specialKey)
        else onSpecialKey(k.specialKey)
        return
      case 'char': {
        if (modsArmed) {
          // A modifier is armed: this must be a real keycode event, not text.
          // comboKey covers the one char whose literal isn't its key name
          // (space); anything else unmappable (shouldn't exist) types plainly.
          const comboKey = k.comboKey ?? (isPhoneRemoteKeyName(k.lower) ? k.lower : null)
          if (comboKey) {
            onCombo(comboModifiers(), comboKey)
            return
          }
        }
        const shifted = shiftArmed || (capsLock && k.letter === true)
        onChar(shifted ? k.upper : k.lower)
        return
      }
      // 'shift' and 'modifier' never reach here -- they're hold keys, wired
      // to holdStart/holdEnd below.
      case 'shift':
      case 'modifier':
        return
    }
  }


  return (
  <div className="vkRows">
    {layout.rows.map((row, i) => (
      <div className="vkRow" key={i}>
        {row.map((k, j) => {
          const isHoldKey = k.action === 'shift' || k.action === 'modifier'
          const active =
            (k.action === 'shift' && shiftHeld) ||
            (k.action === 'capslock' && capsLock) ||
            (k.action === 'modifier' && k.modifier !== undefined && heldMods.includes(k.modifier))
          // Latched reads DIFFERENTLY from held on purpose: an armed
          // modifier that nobody is touching is exactly the "stuck on"
          // state that got sticky keys rejected the first time, so it
          // gets its own outline rather than looking merely pressed.
          const latched =
            (k.action === 'shift' && shiftLatched) ||
            (k.action === 'modifier' &&
              k.modifier !== undefined &&
              latchedMods.includes(k.modifier))
          const keyId = `${i}:${j}`
          return (
            <Button
              variant="bare"
              key={j}
              className={`vkKey${active ? ' active' : ''}${latched ? ' latched' : ''}${
                flashKeys.has(keyId) ? ' flash' : ''
              }${k.action !== 'char' ? ' vkKeySpecial' : ''}`}
              style={{ flexGrow: k.width }}
              onPointerDown={(e) => {
                e.preventDefault()
                if (isHoldKey) holdStart(e.pointerId, k)
                else {
                  // Hold keys are excluded: they already show a persistent
                  // .active fill for as long as the finger is down, and a
                  // flash on top would just fight it.
                  flash(keyId)
                  fireKey(k)
                }
              }}
              aria-label={k.action === 'shift' ? 'Shift' : k.display}
            >
              {k.action === 'shift' ? (
                <ArrowUp size={15} strokeWidth={2.5} />
              ) : k.action === 'char' &&
                (shiftHeld || shiftLatched || (capsLock && k.letter === true)) ? (
                k.upper
              ) : (
                k.display
              )}
            </Button>
          )
        })}
      </div>
    ))}
  </div>
  )
}
