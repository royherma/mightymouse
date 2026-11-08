// Dev-only guard against the "Vite died, Electron lived" split-brain.
//
// `electron-vite dev` is ONE process that both serves the renderer on :5273 AND
// spawns Electron as a child. If the Vite half stops serving (crash, hang, HMR
// blowup, the long-session NODE_OPTIONS temp-file rot) while the already-spawned
// Electron keeps running, the backend still works — mic records, hotkeys fire —
// but every window that tries to loadURL('http://localhost:5273/?window=…') gets
// ERR_CONNECTION_REFUSED and renders BLANK.
//
// That blank popup is silent and easy to misread as a conflict with another dev
// app (we burned time blaming OpenScreen's HUD that happened to be onscreen).
// This guard makes the failure LOUD: any did-fail-load against the dev renderer
// origin pops a native dialog naming the real cause + the one-line fix, so a dead
// renderer can never masquerade as a cross-app conflict again.
//
// Dev-only by construction: in a packaged build windows loadFile() from disk,
// there's no :5273, and ERR_CONNECTION_REFUSED can't happen — so we no-op unless
// ELECTRON_RENDERER_URL is set (electron-vite dev only).
import { app, dialog } from 'electron'
import { IS_DEV, IS_DEVTEST, envVar, devLog } from '../shared/env'
import { CONFIG } from '../shared/config'

// Electron's ERR_CONNECTION_REFUSED. Other codes (-3 ABORTED on a normal
// navigation, etc.) are NOT a dead server — only flag a refused connection.
const ERR_CONNECTION_REFUSED = -102

// One dialog at a time. Without this, N windows all failing to load (HUD, panel,
// island…) would stack N identical modal dialogs on a single Vite death.
let dialogOpen = false

/**
 * Install the dev-server health guard. Call once during app boot (before windows
 * are created). No-op in any build where the dev renderer URL isn't set.
 */
export function installDevServerGuard(): void {
  if (!IS_DEV) return
  const rendererUrl = envVar('ELECTRON_RENDERER_URL')
  if (!rendererUrl) return

  // Fires for EVERY window's webContents — present and future — so all ~12
  // windows are covered by this one listener with zero per-window wiring.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-fail-load', (_e, errorCode, _errorDescription, validatedURL) => {
      // Only care about a refused connection to the dev renderer origin. Ignore
      // unrelated sub-resource failures and normal aborted navigations.
      if (errorCode !== ERR_CONNECTION_REFUSED) return
      if (!validatedURL.startsWith(rendererUrl)) return

      devLog.error(
        `[dev-server-guard] renderer load REFUSED at ${validatedURL} — Vite (${rendererUrl}) is down`
      )
      if (dialogOpen) return
      dialogOpen = true
      dialog
        .showMessageBox({
          type: 'error',
          title: 'Dev server (Vite) is down',
          message: `${CONFIG.BRAND_NAME} UI failed to load - the Vite dev server stopped.`,
          detail:
            `The Electron process is still alive but the renderer on ${rendererUrl} ` +
            `is not responding, so windows render blank. This is NOT a conflict with ` +
            `another app.\n\nFix: run "${IS_DEVTEST ? 'make devtest' : 'make restart'}" in the ShowAndTell repo.`,
          buttons: ['OK'],
          noLink: true
        })
        .finally(() => {
          dialogOpen = false
        })
    })
  })
}
