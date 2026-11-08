import { BrowserWindow, screen } from 'electron'
import { chrome } from './platform'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

// Full-screen, transparent, INTERACTIVE overlay that hosts the skill editor
// (the "Your skills" modal). It lives in its OWN window — NOT inside the panel —
// because a CSS `position: fixed` overlay can only ever cover the panel window's
// 520px bounds, so it gets clipped at the panel edges and inherits the panel's
// off-center, cursor-anchored position. Rendering the modal here lets it center
// on the whole display and never clip (see CLAUDE.md "fixed-can't-escape" gotcha).
// Mirrors draw-window.ts: focusable + not click-through, main owns the lifecycle.

let editorWindow: BrowserWindow | null = null

function buildWindow(): BrowserWindow {
  // Cover the display the cursor is on — the panel opened where the user is, so
  // the editor should center on that same screen.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const b = display.bounds

  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    // Interactive: it must take focus to receive clicks + Esc for the editor.
    focusable: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  chrome.showOnAllWorkspaces(win)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=skill-editor`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'skill-editor' }
    })
  }

  win.on('closed', () => {
    editorWindow = null
  })

  return win
}

/** Open the skill editor overlay (idempotent). Builds it centered on the active
 *  display, focused so the user can type immediately. */
export function openSkillEditor(): void {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.focus()
    return
  }
  editorWindow = buildWindow()
  editorWindow.on('ready-to-show', () => {
    if (editorWindow && !editorWindow.isDestroyed()) {
      editorWindow.show()
      editorWindow.focus()
    }
  })
}

/** Tear the overlay down — called on Save-done / Esc / backdrop click so the
 *  full-screen input-catching window is never left up. */
export function closeSkillEditor(): void {
  if (editorWindow && !editorWindow.isDestroyed()) {
    editorWindow.close()
  }
  editorWindow = null
}

export function isSkillEditorOpen(): boolean {
  return editorWindow !== null && !editorWindow.isDestroyed()
}
