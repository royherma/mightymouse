import { execFile } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import { writeContextFile } from './capture-utils'
import { CaptureResult } from '../../shared/types'

function stampFolder(kind: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(PATHS.CAPTURES, `${kind}-${stamp}`)
}

/** Run the screencapture binary, resolving the PNG path or rejecting on failure. */
function runScreencapture(pngPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(CONFIG.SCREENCAPTURE_PATH, ['-x', '-t', 'png', pngPath], (err) => {
      if (err) {
        console.error('screencapture failed:', err)
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

export async function fireScreenshot(): Promise<CaptureResult> {
  const folder = stampFolder('shot')
  mkdirSync(folder, { recursive: true })
  await writeContextFile(folder, 'screenshot', 'context.txt')

  const pngPath = join(folder, 'screenshot.png')
  await runScreencapture(pngPath)

  try {
    writeFileSync(PATHS.LATEST_CAPTURE, folder, 'utf-8')
  } catch (err) {
    console.error('Failed to write latest-capture marker:', err)
  }
  return { kind: 'screenshot', folder, screenshotPath: pngPath }
}
