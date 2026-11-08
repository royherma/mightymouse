// phone-mic-device.ts — feeds the phone's microphone into the MightyMouse HAL
// audio device, so other apps (ChatGPT voice mode) can select it as their mic.
//
// The plugin cannot reach the network and its IO callbacks run on a realtime
// thread, so the handoff is a lock-free shared-memory ring
// (native/mm-audiodev/mm_audio_ring.h). This module owns the small native
// process that writes into it; PCM arrives here from the WebRTC mirror and is
// piped straight to its stdin.
//
// Spawn/resolve shape mirrors system-audio.ts.

import { ChildProcess, spawn } from 'child_process'
import { cpSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { dialog } from 'electron'
import { devLog } from '../../shared/env'
import { helpers } from '../platform'
import { CONFIG } from '../../shared/config'

const WRITER_BIN = 'mm-ring-writer'
const DEFAULT_INPUT_BIN = 'mm-default-input'
const WRITER_DIR = 'native/mm-audiodev'

/** Our virtual device's Core Audio UID. Must match `kDevice_UID` in
 *  native/mm-audiodev/mm_audiodev.h. A UID, not the display name: names are
 *  localised and can collide, UIDs cannot. */
const PHONE_MIC_UID = 'com.mightymouse.audiodev.phone-mic'

/** The installed plugin. Its absence is the difference between "the device
 *  isn't installed" and "the device is installed but silent" — two very
 *  different things to tell the user. */
const HAL_DIR = '/Library/Audio/Plug-Ins/HAL'
const DRIVER_BUNDLE = 'mm-audiodev.driver'
const HAL_PLUGIN_PATH = `${HAL_DIR}/${DRIVER_BUNDLE}`

/** Home of the writer↔plugin ring, created 0777 by the install because the two
 *  ends run as different users and neither can create it here. Must match
 *  MM_RING_DIR in native/mm-audiodev/mm_audio_ring.h. */
const RING_DIR = '/Library/Application Support/MightyMouse'

function resolveNativePath(bin: typeof WRITER_BIN | typeof DEFAULT_INPUT_BIN | typeof DRIVER_BUNDLE): string {
  // null only where the OS ships no helper; '' then fails the existsSync guard like a missing binary.
  return helpers.resolve(bin) ?? ''
}

/** True once the HAL plugin is installed. Without it the writer would publish
 *  audio nothing reads.
 *
 *  Checks the executable, not the bundle folder: a `cp` that fails partway
 *  leaves an empty .driver directory behind, and treating that as installed
 *  makes the failure permanent -- every later attempt skips as already done. */
export function isPhoneMicDeviceInstalled(): boolean {
  return existsSync(join(HAL_PLUGIN_PATH, 'Contents', 'MacOS', 'mm-audiodev'))
}

function resolveBundlePath(): string {
  return resolveNativePath(DRIVER_BUNDLE)
}

/** Run the Core Audio helper. Resolves to its exit code and trimmed stdout —
 *  exit 2 means "no such input device", which every caller here treats as a
 *  reason to leave the current input alone rather than an error. */
function runDefaultInput(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(resolveNativePath(DEFAULT_INPUT_BIN), args)
    let out = ''
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    proc.on('error', (err) => {
      devLog.warn(`[phone-mic] default-input helper failed: ${err.message}`)
      resolve({ code: 1, out: '' })
    })
    proc.on('close', (code) => resolve({ code: code ?? 1, out: out.trim() }))
  })
}

/** The input device that was selected before we took over, so mic-off can hand
 *  it back. Null whenever we have not switched. */
let previousInputUid: string | null = null

/** Point the Mac at the phone mic. Nobody selects an input device by hand
 *  mid-call, so doing it here is what makes the feature work in apps like
 *  ChatGPT that have no microphone picker of their own. */
async function claimDefaultInput(): Promise<void> {
  const current = await runDefaultInput('get')
  // Already ours means a previous session never restored; keeping the older
  // saved UID is what avoids recording MightyMouse as its own "previous".
  if (current.code !== 0 || current.out === PHONE_MIC_UID) return

  const set = await runDefaultInput('set', PHONE_MIC_UID)
  if (set.code !== 0) {
    // Exit 2 here is the plugin not installed yet -- the install prompt is
    // already on its way, and the next mic toggle will find the device.
    devLog.log(`[phone-mic] could not select the phone mic as input (${set.code})`)
    return
  }
  previousInputUid = current.out
  devLog.log(`[phone-mic] default input -> phone mic (was ${current.out})`)
}

/** Hand the input back. Only when it is still ours: if the user picked another
 *  mic while the phone was live, that choice outranks whatever we saved.
 *
 *  Exported for app teardown: quitting with the mic open would otherwise leave
 *  the Mac pointed at a device whose writer is about to die. */
export async function releaseDefaultInput(): Promise<void> {
  const uid = previousInputUid
  previousInputUid = null
  if (uid === null) return

  const current = await runDefaultInput('get')
  if (current.code !== 0 || current.out !== PHONE_MIC_UID) return

  // Exit 2 = the old device is unplugged. Leaving the input on a silent phone
  // mic is worse than nothing, so fall back to whatever macOS picks next.
  const restored = await runDefaultInput('set', uid)
  devLog.log(
    restored.code === 0 ? `[phone-mic] default input -> ${uid}` : `[phone-mic] ${uid} is gone`
  )
}

/** Remove a leftover .driver husk. Folded into the next install's own `rm -rf`
 *  when possible; this is the standalone path for when the install itself is
 *  what left the mess, so the user is never stuck with a permanently broken
 *  directory they would have to find in Finder to clear. */
async function clearBrokenInstall(): Promise<void> {
  await new Promise<void>((resolve) => {
    const script = `do shell script "rm -rf '${HAL_PLUGIN_PATH}'" with administrator privileges`
    const proc = spawn('osascript', ['-e', script])
    proc.on('error', () => resolve())
    proc.on('close', () => resolve())
  })
}

/** Install the HAL plugin, asking for the admin password via the standard macOS
 *  sheet. Never a Terminal command: this is a normal user turning on a feature.
 *
 *  Two things here are macOS's rules, not choices. /Library/Audio/Plug-Ins/HAL
 *  is root-owned with no per-user equivalent, so it needs admin. And coreaudiod
 *  only scans that directory at launch — SIP blocks `launchctl kickstart` since
 *  Sonoma 14.4, leaving `killall`, which blips audio in every running app for
 *  about a second. Warn before calling, don't call this silently. */
export async function installPhoneMicDevice(): Promise<{ ok: boolean; cancelled?: boolean }> {
  if (isPhoneMicDeviceInstalled()) return { ok: true }

  const bundle = resolveBundlePath()
  if (!existsSync(bundle)) {
    devLog.warn(`[phone-mic] driver bundle missing at ${bundle}`)
    return { ok: false }
  }

  // Stage outside the app folder before escalating. The privileged shell is a
  // fresh process with no TCC grants of its own, so if the bundle sits under
  // Desktop/Documents/Downloads its `cp` fails with "Operation not permitted"
  // while ours succeeds. Copying here first uses OUR grant, and root then reads
  // from a location TCC does not police.
  const staged = join(tmpdir(), DRIVER_BUNDLE)
  try {
    rmSync(staged, { recursive: true, force: true })
    cpSync(bundle, staged, { recursive: true })
  } catch (err) {
    devLog.warn(`[phone-mic] staging failed: ${(err as Error).message}`)
    return { ok: false }
  }

  // Single osascript so the user sees ONE password sheet, not four. Quoting is
  // safe here: every path is a build-time constant, never user input.
  const script = [
    `do shell script "`,
    `mkdir -p '${HAL_DIR}' && `,
    `rm -rf '${HAL_PLUGIN_PATH}' && `,
    `cp -R '${staged}' '${HAL_PLUGIN_PATH}' && `,
    `chown -R root:wheel '${HAL_PLUGIN_PATH}' && `,
    `mkdir -p '${RING_DIR}' && `,
    `chmod 0777 '${RING_DIR}' && `,
    `killall coreaudiod`,
    `" with administrator privileges`
  ].join('')

  const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const proc = spawn('osascript', ['-e', script])
    let stderr = ''
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
    proc.on('error', (err) => resolve({ code: 1, stderr: err.message }))
    proc.on('close', (code) => resolve({ code: code ?? 1, stderr }))
  })

  if (result.code !== 0) {
    // -128 is the user clicking Cancel, which is a choice, not a failure.
    devLog.warn(`[phone-mic] install failed: ${result.stderr.trim()}`)
    return { ok: false, cancelled: result.stderr.includes('-128') }
  }

  // coreaudiod needs a moment to rescan; reporting success before the device
  // exists sends the user to a Sound pane that hasn't caught up.
  await new Promise((r) => setTimeout(r, 1500))

  // Exit code 0 is not proof. A partial copy leaves an empty .driver behind
  // that reads as installed forever, so confirm the executable actually landed
  // and clear the husk if it did not -- otherwise the next attempt skips.
  if (!isPhoneMicDeviceInstalled()) {
    devLog.warn('[phone-mic] install reported success but the plugin is not there')
    await clearBrokenInstall()
    return { ok: false }
  }
  devLog.log('[phone-mic] HAL plugin installed')
  return { ok: true }
}

let writer: ChildProcess | null = null

/** Start publishing to the ring. Idempotent — a mirror restart racing the
 *  phone's mic toggle must not spawn a second writer, since two writers on one
 *  ring interleave garbage. */
export function startPhoneMicDevice(): boolean {
  if (writer !== null) return true

  const bin = resolveNativePath(WRITER_BIN)
  if (!existsSync(bin)) {
    devLog.warn(`[phone-mic] writer not found at ${bin} — run: cd ${WRITER_DIR} && bash build.sh`)
    return false
  }

  const proc = spawn(bin, { stdio: ['pipe', 'ignore', 'pipe'] })
  proc.on('error', (err) => {
    devLog.warn(`[phone-mic] writer spawn error: ${err.message}`)
    writer = null
  })
  proc.on('exit', (code) => {
    if (writer === proc) writer = null
    devLog.log(`[phone-mic] writer exited (${code})`)
  })
  // An EPIPE here is the writer having died; the exit handler owns recovery.
  proc.stdin?.on('error', () => {})
  proc.stderr?.on('data', (chunk: Buffer) => {
    devLog.log(`[phone-mic] ${chunk.toString().trim()}`)
  })

  writer = proc
  // Audio is already flowing; without the plugin no app can select it. Asking
  // here rather than at app launch means the password sheet arrives when the
  // user has just turned the mic on and the reason for it is obvious.
  if (!isPhoneMicDeviceInstalled()) {
    inputClaim = promptToInstall()
    void inputClaim
  } else {
    inputClaim = claimDefaultInput()
    void inputClaim
  }
  return true
}

/** Resolves once the Mac has actually been pointed at the phone mic (or the
 *  attempt has given up). Only ChatGPT voice needs this: it reads its input
 *  device when the session opens, so pressing its button while the claim is
 *  still in flight opens the call on the built-in mic. */
let inputClaim: Promise<void> = Promise.resolve()

export function whenInputClaimed(): Promise<void> {
  return inputClaim
}

let promptedThisSession = false

/** Offer the install once per session. Re-asking every time the mic opens would
 *  turn a declined prompt into nagging. */
async function promptToInstall(): Promise<void> {
  if (promptedThisSession) return
  promptedThisSession = true

  const L = CONFIG.UI_LABELS
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: L.PHONE_MIC_INSTALL,
    detail: L.PHONE_MIC_INSTALL_DETAIL,
    buttons: [L.PHONE_MIC_INSTALL_CONFIRM, L.PHONE_MIC_INSTALL_CANCEL],
    defaultId: 0,
    cancelId: 1
  })
  // "Not Now" is an answer, not a dead end: it holds for this session and the
  // offer comes back next time, so nobody has to hunt for a way to say yes
  // later. Everything below leaves the same door open.
  if (response !== 0) return

  const result = await installPhoneMicDevice()
  if (result.ok) {
    // The device only exists as of a moment ago, so the mic-on that triggered
    // this prompt could not select it. Do it now, while audio is still flowing.
    if (writer !== null) await claimDefaultInput()
    await dialog.showMessageBox({
      type: 'info',
      message: L.PHONE_MIC_READY,
      detail: L.PHONE_MIC_READY_DETAIL,
      buttons: ['Done']
    })
    return
  }

  // Any failed attempt gets another shot the next time the mic opens.
  // Cancelling the password sheet is the common one, and it is deliberate, so
  // it gets no scary warning -- just a note that the phone still works.
  promptedThisSession = false
  await dialog.showMessageBox({
    type: 'info',
    message: result.cancelled ? L.PHONE_MIC_SKIPPED : L.PHONE_MIC_INSTALL_FAILED,
    detail: L.PHONE_MIC_INSTALL_FAILED_DETAIL,
    buttons: ['OK']
  })
}

/** Stop publishing. The writer clears the ring's `active` flag on exit, so the
 *  device goes silent rather than looping its last buffer. */
export function stopPhoneMicDevice(): void {
  if (writer === null) return
  const proc = writer
  writer = null
  proc.stdin?.end()
  proc.kill('SIGTERM')
  void releaseDefaultInput()
}

/** Forward one chunk of float32 PCM. Dropped when no writer is running, which
 *  is the normal state while the phone's mic is off. */
export function writePhoneMicPcm(chunk: Buffer): void {
  writer?.stdin?.write(chunk)
}
