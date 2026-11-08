/**
 * Phone Remote -- the admin Environment switcher (staging/prod). Persists the
 * override to disk, tells the phone before the process dies, then relaunches
 * (dev: respawns `npm run dev` detached so Vite survives; prod: app.relaunch()).
 */
import { app } from 'electron'
import { spawn } from 'child_process'
import { CONFIG } from '../../shared/config'
import { shell } from '../platform'
import { IS_DEV } from '../../shared/env'
import { isRealAdmin } from '../auth'
import { readEnvOverride, writeEnvOverride } from '../env-override'
import { sendToPhone } from '../phone-remote/server'

// Long enough for the 'envSwitching' frame to reach the phone before the process
// exits, short enough that the switch still feels immediate.
const ENV_SWITCH_RELAUNCH_DELAY_MS = 250

function buildDefaultEnv(): 'staging' | 'prod' {
  return IS_DEV ? 'staging' : 'prod'
}

export async function sendEnvToPhone(): Promise<void> {
  sendToPhone({
    type: 'env',
    isAdmin: await isRealAdmin(),
    current: CONFIG.ENV_NAME,
    buildDefault: buildDefaultEnv()
  })
}

export async function applyEnvSwitch(value: 'staging' | 'prod'): Promise<void> {
  if (!(await isRealAdmin())) {
    console.warn('[phone-remote] setEnv from a non-admin session — ignored.')
    return
  }
  if (value !== 'staging' && value !== 'prod') return
  writeEnvOverride(value)
  // Read the file straight back. A write that silently didn't land looks
  // identical on screen to a relaunch that ignored it, and separating those two
  // by re-testing on-device cost several rounds. One syscall settles it here.
  const persisted = readEnvOverride()
  if (persisted !== value) {
    console.error(
      `[phone-remote] env override did NOT persist: wanted "${value}", file says "${persisted}". ` +
        'Not relaunching — a restart now would come back in the old env.'
    )
    void sendEnvToPhone()
    return
  }
  // Tell the phone before we die, so it shows "restarting" and not the generic
  // disconnect banner. The socket goes down with the process moments later.
  sendToPhone({ type: 'envSwitching', to: value })
  console.log(`[phone-remote] env → ${value} (pid ${process.pid}); persisted, relaunching.`)
  // One tick so the frame actually reaches the phone before the process exits.
  setTimeout(() => {
    relaunchForEnvSwitch()
    app.exit(0)
  }, ENV_SWITCH_RELAUNCH_DELAY_MS)
}

function relaunchForEnvSwitch(): void {
  if (!IS_DEV) {
    app.relaunch()
    return
  }
  try {
    const wait = `for i in $(seq 1 200); do kill -0 ${process.pid} 2>/dev/null || break; sleep 0.1; done`
    const log = '/tmp/mightymouse-dev.log'
    // Single-quoted so `date` runs in the CHILD shell. A double-quoted template
    // here would have to escape the $ past both JS and zsh, and the version that
    // tried logged the literal text `$(date +%T)` instead of a time.
    const say = `echo "[env-switch] old pid ${process.pid} gone at $(date +%T); starting npm run dev" >> ${log}`
    const childEnv = { ...process.env }
    delete childEnv.MM_ENV_OVERRIDE
    const child = spawn(shell.bin, ['-lc', `${wait}; ${say}; npm run dev >> ${log} 2>&1`], {
      cwd: app.getAppPath(),
      detached: true,
      stdio: 'ignore',
      env: childEnv
    })
    console.log(`[phone-remote] respawn shell pid ${child.pid}; waiting on pid ${process.pid}.`)
    child.on('error', (err) => console.error('[phone-remote] could not respawn `npm run dev` — run `make restart`:', err))
    child.unref()
  } catch (err) {
    // Falling back to app.relaunch() would produce the blank-window state this
    // function exists to avoid, so say what happened instead: `make restart`
    // is a keystroke away for whoever is at the keyboard in dev.
    console.error('[phone-remote] could not respawn `npm run dev` — run `make restart`:', err)
  }
}
