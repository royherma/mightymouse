import { clipboard, nativeImage, shell } from 'electron'
import { execFile } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { CONFIG } from '../../shared/config'
import { devLog } from '../../shared/env'
import { parseInkOp, type InkSendTarget } from '../../shared/ink'
import type { PhoneRemoteMessage } from '../../shared/phone-remote-protocol'
import { PATHS } from '../store/paths'
import { EVENTS } from '../store/events'
import { sendToPhone } from '../phone-remote/server'
import platform from '../platform'
import { closeInkOverlay, inkDisplay, pushInkOp, withInkHidden } from '../ink-window'

type InkMessage = Extract<PhoneRemoteMessage, { type: 'ink' }>

function screencaptureMain(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(CONFIG.SCREENCAPTURE_PATH, ['-x', '-m', '-t', 'jpg', path], (err) => {
      if (err) devLog.error('Phone Remote: ink snapshot failed', err)
      resolve(!err)
    })
  })
}

let snapshotInFlight = false

async function sendSnapshot(): Promise<void> {
  if (snapshotInFlight) return
  snapshotInFlight = true
  const { width, height } = inkDisplay().bounds
  const path = join(PATHS.TMP, `ink-snapshot-${randomUUID().slice(0, 8)}.jpg`)
  let image: string | null = null
  try {
    if (await platform.input.captureScreenWithoutUs(path, CONFIG.PHONE_REMOTE.INK_SNAPSHOT_MAX_W)) {
      image = `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`
    } else if (await withInkHidden(() => screencaptureMain(path))) {
      const shot = nativeImage.createFromPath(path)
      if (!shot.isEmpty()) {
        const sized = shot.resize({
          width: Math.min(shot.getSize().width, CONFIG.PHONE_REMOTE.INK_SNAPSHOT_MAX_W)
        })
        image = `data:image/jpeg;base64,${sized.toJPEG(CONFIG.PHONE_REMOTE.INK_SNAPSHOT_JPEG_QUALITY).toString('base64')}`
      }
    }
  } finally {
    rmSync(path, { force: true })
    snapshotInFlight = false
  }
  sendToPhone({ type: 'inkBackdrop', image, width, height })
}

export function handleInk(msg: InkMessage): void {
  const op = parseInkOp(msg.ink)
  if (!op) return
  if (op.op === 'snapshot') {
    void sendSnapshot()
    return
  }
  pushInkOp(op)
}

export async function handleInkImage(data: Buffer, target: InkSendTarget): Promise<void> {
  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) {
    sendToPhone({ type: 'inkSent', ok: false })
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const folder = join(PATHS.CAPTURES, `drawing-${stamp}`)
  const path = join(folder, 'drawing.jpg')
  try {
    mkdirSync(folder, { recursive: true })
    writeFileSync(path, data)
  } catch (err) {
    devLog.error('Phone Remote: saving the drawing failed', err)
    sendToPhone({ type: 'inkSent', ok: false })
    return
  }
  clipboard.writeImage(image)
  const opened = target === 'open' ? (await shell.openPath(path)) === '' : true
  sendToPhone({ type: 'inkSent', ok: opened })
  EVENTS.append({
    run_id: `phone-ink:${randomUUID().slice(0, 8)}`,
    event: 'phone_drawing_sent',
    folder,
    bytes: data.length,
    target
  })
}

export { closeInkOverlay }
