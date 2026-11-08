/**
 * Dev-only replacement for Vite's HMR error overlay.
 *
 * WHY THIS EXISTS: Vite's built-in overlay renders *inside* the window that
 * loaded the broken module. Almost every MightyMouse surface (panel, HUD,
 * cursor, companion, transcript, highlight, cheese) is created with
 * `setAlwaysOnTop(true, 'screen-saver')` — a macOS level ABOVE Mission Control,
 * the Dock, and the app switcher. So a compile error in a shared module paints a
 * full-bleed, always-on-top wall that you cannot Cmd+Tab past, cannot Mission
 * Control past, and (on a frameless transparent window) often cannot click
 * "outside" of, because there is no outside. The machine reads as bricked when
 * the actual fault is one bad import.
 *
 * The fix is two-part:
 *   1. `server.hmr.overlay: false` in electron.vite.config.ts kills Vite's wall.
 *   2. This module subscribes to the same `vite:error` event and renders a small
 *      corner toast instead — and first asks main to drop the window out of
 *      alwaysOnTop, so even the toast can never trap the desktop.
 *
 * The error text is NOT swallowed: it goes to devLog.error (visible in
 * /tmp/mightymouse-dev.log) and the toast shows the message + file, click to
 * dismiss. Losing the error entirely would mean debugging a blank panel blind.
 */
import { CHANNELS } from '../../shared/ipc'
import { IS_DEV, devLog } from '../../shared/env'
import { CONFIG } from '../../shared/config'
const THEME_TOKENS = CONFIG.THEME_TOKENS

const OVERLAY_ID = 'mm-dev-error-toast'

type ViteErrorPayload = {
  err?: { message?: string; id?: string; loc?: { file?: string; line?: number } }
}

function render(err: ViteErrorPayload['err']): void {
  document.getElementById(OVERLAY_ID)?.remove()

  const where = err?.loc?.file ?? err?.id ?? ''
  const line = err?.loc?.line
  const el = document.createElement('div')
  el.id = OVERLAY_ID
  el.setAttribute('role', 'alert')
  el.style.cssText = [
    'position:fixed',
    'right:12px',
    'bottom:12px',
    'z-index:2147483647',
    'max-width:min(520px, calc(100vw - 24px))',
    'max-height:40vh',
    'overflow:auto',
    'padding:10px 12px',
    `border-radius:${THEME_TOKENS.radiusMd}`,
    `background:${THEME_TOKENS.bg}`,
    `border:1px solid ${THEME_TOKENS.red}`,
    'box-shadow:0 8px 28px rgba(0,0,0,.45)',
    `color:${THEME_TOKENS.onSurface}`,
    'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'white-space:pre-wrap',
    // Vite error text carries long unbroken absolute paths. pre-wrap alone will
    // NOT break a run with no spaces, so the path overflows the rounded border
    // and gets clipped — anywhere-break is what actually keeps it inside.
    'overflow-wrap:anywhere',
    'cursor:pointer',
    '-webkit-app-region:no-drag'
  ].join(';')

  const head = document.createElement('div')
  head.style.cssText = `color:${THEME_TOKENS.redLight};font-weight:600;margin-bottom:4px`
  head.textContent = 'Dev build error - click to dismiss'

  const body = document.createElement('div')
  body.textContent = err?.message ?? 'Unknown build error'

  el.append(head, body)
  if (where) {
    const loc = document.createElement('div')
    loc.style.cssText = `margin-top:6px;opacity:.7`
    loc.textContent = line ? `${where}:${line}` : where
    el.appendChild(loc)
  }

  el.addEventListener('click', () => el.remove())
  document.body.appendChild(el)
}

export function installDevErrorOverlay(): void {
  if (!IS_DEV || !import.meta.hot) return

  import.meta.hot.on('vite:error', (payload: ViteErrorPayload) => {
    // Un-pin FIRST: even this small toast must never sit on a screen-saver-level
    // window, or a render bug in the toast itself recreates the trap it fixes.
    window.api?.devUnpinForError?.()
    devLog.error('[vite:error]', payload?.err?.message, payload?.err?.loc?.file ?? payload?.err?.id)
    render(payload?.err)
  })

  // A successful hot update means the error is gone — clear the toast so a stale
  // one never masks a working app.
  import.meta.hot.on('vite:afterUpdate', () => {
    document.getElementById(OVERLAY_ID)?.remove()
  })
}

export const DEV_ERROR_OVERLAY_ID = OVERLAY_ID
export const DEV_UNPIN_CHANNEL = CHANNELS.devUnpinForError
