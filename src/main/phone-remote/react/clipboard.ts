/**
 * Clipboard write that actually lands on an iPhone.
 *
 * FULLY SYNCHRONOUS. navigator.clipboard is unavailable on a plain-HTTP LAN
 * origin and rejects on Safari whenever the gesture isn't trusted, so the
 * execCommand path is the one that runs here -- and it only works inside the
 * originating gesture's own call stack. Nothing may be awaited before the write.
 *
 * Lives in its own module because two unrelated surfaces need it (the debug
 * report line and long-press-to-copy on a chat bubble) and every trick for
 * hiding the scratch node is also a reason execCommand returns false -- one
 * copy of that hard-won detail, not two.
 */
export function copyText(text: string): boolean {
  if (text === '') return false
  try {
    // A contentEditable div selected via Range, NOT a textarea with .select().
    // iOS Safari refuses to select a textarea that is readOnly, off-screen, or
    // zero-opacity. So the node is REAL and on-screen, just visually inert:
    // 1px, transparent, behind everything, present for one synchronous call.
    const el = document.createElement('div')
    el.contentEditable = 'true'
    el.textContent = text
    el.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;padding:0;border:0;' +
      'opacity:0.01;color:transparent;background:transparent;overflow:hidden;z-index:-1;' +
      // -webkit-user-select must be explicitly re-enabled: the global
      // `user-select: none` on html/body (there to stop text selection during
      // touchpad drags) would otherwise make the range unselectable.
      '-webkit-user-select:text;user-select:text'
    document.body.appendChild(el)

    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)

    const ok = document.execCommand('copy')
    sel?.removeAllRanges()
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}
