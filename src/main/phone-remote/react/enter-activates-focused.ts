/**
 * Activates the focused control when a cursorless host sends its "select" key.
 *
 * The TV/remote model generally, not glasses-specific, so it installs on every
 * host rather than behind a device check. On Meta Ray-Ban Display a thumb-index
 * pinch arrives as a synthetic `Enter` and the browser dispatches no click for
 * it, so a focused button highlighted and then did nothing when pinched.
 *
 * Arrows are NOT handled here -- this file once claimed the browser traverses
 * focus on them, which is why the deck shipped with a highlight no swipe could
 * move. Traversal lives in `arrow-focus-nav.ts`.
 */

import { isTextEntry } from './arrow-focus-nav'
import { noteKeySeen } from './last-key-seen'

/** Enter ONLY. Space was here on a guess that a wearable "select" might arrive
 *  as either -- never observed, and preventDefault()ing Space on every host to
 *  serve a guess breaks the phone to maybe help the glasses. */
const ACTIVATION_KEYS = new Set(['Enter'])

/** The focused element, reduced to only what the decision needs -- so the rule
 *  below is testable without a DOM, which this repo's vitest does not provide. */
export interface FocusedTarget {
  tagName: string
  /** `<input>` only; null elsewhere. A bare <input> is a text field. */
  type?: string | null
  /** True when the element is inside a <form> that Enter would already submit. */
  inForm: boolean
  hasHref: boolean
  disabled: boolean
}

/** False for anything the browser already activates on Enter -- firing twice
 *  would POST the pairing code twice, burning a single-use code. A checkbox is
 *  NOT refused: the browser activates it on Space, not Enter. */
export function shouldSynthesizeClick(el: FocusedTarget): boolean {
  if (el.disabled) return false
  const tag = el.tagName
  if (isTextEntry(el)) return false
  if (tag === 'INPUT' && (el.type ?? '').toLowerCase() === 'range') return false
  if (tag === 'A' && el.hasHref) return false
  if (tag === 'BUTTON' && el.inForm) return false
  return true
}

function readTarget(el: Element): FocusedTarget {
  return {
    tagName: el.tagName,
    type: el.tagName === 'INPUT' ? (el as HTMLInputElement).type : null,
    inForm: el.tagName === 'BUTTON' && (el as HTMLButtonElement).form !== null,
    hasHref: el.hasAttribute('href'),
    disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
  }
}

/** Fires a real click on the focused element when the band pinches. Returns a
 *  disposer. Safe on every host: a phone sends Enter only with a keyboard up,
 *  and then the focused node is the text input, which the rule above refuses. */
export function installEnterActivatesFocused(target: Document = document): () => void {
  function onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return
    // Recorded for EVERY key, not just the ones we act on: the first question on
    // a cursorless host is whether the pinch reaches JS at all, and a handler
    // that only logs its own hits cannot answer that.
    if (!ACTIVATION_KEYS.has(e.key)) return noteKeySeen(e.key, 'ignored')
    // A modifier means this is a real keyboard shortcut, not a tap -- EXCEPT on
    // a cursorless host, which has no real keyboard and sets modifier flags on
    // its own gestures. Same trap as the arrow guard in arrow-focus-nav.ts: left
    // in place it declines the only activation the host can produce, silently.
    if (e.altKey || e.ctrlKey || e.metaKey) {
      const mods = [e.altKey && 'alt', e.ctrlKey && 'ctrl', e.metaKey && 'meta']
        .filter(Boolean)
        .join('+')
      if (document.documentElement.dataset.cursorless !== 'on') {
        return noteKeySeen(e.key, `modifier:${mods}`)
      }
      noteKeySeen(e.key, `modifier-ignored:${mods}`)
    }
    const el = target.activeElement
    if (!el || el === target.body) return noteKeySeen(e.key, 'nofocus')
    if (!shouldSynthesizeClick(readTarget(el))) {
      return noteKeySeen(e.key, `declined:${el.tagName.toLowerCase()}`)
    }
    if (typeof (el as HTMLElement).click !== 'function') return noteKeySeen(e.key, 'noclick')
    e.preventDefault()
    ;(el as HTMLElement).click()
    noteKeySeen(e.key, `clicked:${el.tagName.toLowerCase()}`)
  }

  target.addEventListener('keydown', onKeyDown)
  return () => target.removeEventListener('keydown', onKeyDown)
}
