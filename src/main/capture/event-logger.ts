import { createWriteStream, WriteStream } from 'fs'
import { join } from 'path'
import { acquire, isAvailable, on, AnyEvent } from './uiohook-manager'
import { PREFS } from '../store/prefs'

// Logs key/mouse/scroll into a capture folder during recording. Shares the one
// global hook via uiohook-manager so it never clobbers the capture hotkey.
let keyStream: WriteStream | null = null
let mouseStream: WriteStream | null = null
let scrollStream: WriteStream | null = null
let release: (() => void) | null = null
const unsubs: Array<() => void> = []
let running = false

function ms(): number {
  return Date.now()
}

export function isEventLoggingAvailable(): boolean {
  return isAvailable()
}

/** Start key/mouse/scroll logging into the given capture folder. */
export function startEventLogging(folder: string): boolean {
  // Incognito: never record keystrokes/mouse/scroll, even during an explicit
  // recording — the recording's own A/V is the artifact, this is pure side-tracking.
  if (PREFS.getIncognito()) return false
  if (!isAvailable() || running) return false

  keyStream = createWriteStream(join(folder, 'keys.log'), { flags: 'a' })
  mouseStream = createWriteStream(join(folder, 'mouse.log'), { flags: 'a' })
  scrollStream = createWriteStream(join(folder, 'scroll.log'), { flags: 'a' })
  for (const stream of [keyStream, mouseStream, scrollStream]) {
    stream.on('error', (err) => console.error('[event-logger] write failed:', err.message))
  }

  keyStream.write('# Keystrokes during recording\n# format: <epoch_ms> <type> <keycode>\n')
  mouseStream.write(
    '# Mouse events during recording\n# format: <epoch_ms> <type> <x> <y> [button]\n'
  )
  scrollStream.write('# Scroll events\n# format: <epoch_ms> <rotation> <direction> <x> <y>\n')

  unsubs.push(on('keydown', (e: AnyEvent) => keyStream?.write(`${ms()} keydown ${e.keycode}\n`)))
  unsubs.push(on('keyup', (e: AnyEvent) => keyStream?.write(`${ms()} keyup ${e.keycode}\n`)))
  unsubs.push(
    on('mousedown', (e: AnyEvent) => mouseStream?.write(`${ms()} down ${e.x} ${e.y} ${e.button}\n`))
  )
  unsubs.push(
    on('mouseup', (e: AnyEvent) => mouseStream?.write(`${ms()} up ${e.x} ${e.y} ${e.button}\n`))
  )
  unsubs.push(on('mousemove', (e: AnyEvent) => mouseStream?.write(`${ms()} move ${e.x} ${e.y}\n`)))
  unsubs.push(
    on('wheel', (e: AnyEvent) =>
      scrollStream?.write(`${ms()} ${e.rotation} ${e.direction} ${e.x} ${e.y}\n`)
    )
  )

  release = acquire()
  running = true
  return true
}

export function stopEventLogging(): void {
  unsubs.forEach((u) => u())
  unsubs.length = 0
  if (release) release()
  release = null
  running = false
  keyStream?.end()
  mouseStream?.end()
  scrollStream?.end()
  keyStream = null
  mouseStream = null
  scrollStream = null
}
