import { app } from 'electron'
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { transcribe } from './whisper'
import { logCapture } from './capture-actions'
import { CHANNELS } from '../../shared/ipc'
import type { RecoveredRecording, RecoveredRecordingsState } from '../../shared/types'
import { getMightyWindow } from '../mighty/mighty-window'

const MARKER = 'recording.json'
const ORPHAN_EXIT_WAIT_MS = 5000
const WAV_HEADER_SCAN_BYTES = 4096
const WAV_BYTES_PER_SECOND = 16000 * 2

interface RecordingMarker {
  kind: 'listen' | 'recording'
  audioTmp: string
  videoTmp?: string
  startedAt: number
}

export function markRecording(folder: string, marker: RecordingMarker): void {
  try {
    writeFileSync(join(folder, MARKER), JSON.stringify(marker), 'utf-8')
  } catch (err) {
    console.error('[recovery] could not write recording marker:', err)
  }
}

export function clearRecordingMark(folder: string): void {
  try {
    rmSync(join(folder, MARKER), { force: true })
  } catch (err) {
    console.error('[recovery] could not clear recording marker:', err)
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pids: number[]): Promise<void> {
  const deadline = Date.now() + ORPHAN_EXIT_WAIT_MS
  while (pids.some(isAlive) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  for (const pid of pids.filter(isAlive)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // exited between the check and the kill
    }
  }
}

// A writer killed mid-recording leaves placeholder sizes in the RIFF + data chunk headers.
function repairWavHeader(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    const size = fstatSync(fd).size
    const head = Buffer.alloc(Math.min(size, WAV_HEADER_SCAN_BYTES))
    readSync(fd, head, 0, head.length, 0)
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return
    let off = 12
    while (off + 8 <= head.length) {
      const id = head.toString('ascii', off, off + 4)
      if (id === 'data') {
        const sizes = Buffer.alloc(4)
        sizes.writeUInt32LE(Math.min(size - off - 8, 0xffffffff))
        writeSync(fd, sizes, 0, 4, off + 4)
        sizes.writeUInt32LE(Math.min(size - 8, 0xffffffff))
        writeSync(fd, sizes, 0, 4, 4)
        return
      }
      off += 8 + head.readUInt32LE(off + 4)
    }
  } finally {
    closeSync(fd)
  }
}

function adopt(tmp: string | undefined, dest: string): string | undefined {
  if (tmp && existsSync(tmp)) {
    try {
      renameSync(tmp, dest)
    } catch (err) {
      console.error('[recovery] move failed:', tmp, err)
      return undefined
    }
  }
  return existsSync(dest) ? dest : undefined
}

interface Recovered {
  folder: string
  durationS: number
  words: number
  transcript: string
}

function summarize(r: Recovered): string {
  const length = r.durationS >= 60 ? `${Math.round(r.durationS / 60)} min` : `${Math.round(r.durationS)} sec`
  return r.words > 0 ? `${length}, ${r.words} words` : length
}

let state: RecoveredRecordingsState = { working: false, items: [] }

function publish(next: RecoveredRecordingsState): void {
  state = next
  getMightyWindow()?.webContents.send(CHANNELS.recoveredRecordingsChanged, state)
}

export function getRecoveredRecordings(): RecoveredRecordingsState {
  return state
}

export function dismissRecoveredRecordings(): void {
  publish({ working: false, items: [] })
}

async function recoverOne(folder: string): Promise<Recovered | null> {
  const marker = JSON.parse(readFileSync(join(folder, MARKER), 'utf-8')) as RecordingMarker
  clearRecordingMark(folder)

  const audioPath = adopt(marker.audioTmp, join(folder, 'audio.wav'))
  const videoPath = adopt(marker.videoTmp, join(folder, 'screen.mp4'))
  if (!audioPath && !videoPath) {
    rmSync(folder, { recursive: true, force: true })
    return null
  }

  let transcript = ''
  let words = 0
  if (audioPath) {
    try {
      repairWavHeader(audioPath)
    } catch (err) {
      console.error('[recovery] wav header repair failed:', err)
    }
    const tr = await transcribe(audioPath, join(folder, 'transcript'))
    if (tr.ok) {
      transcript = (tr.text || '').trim()
      words = tr.wordCount ?? 0
    } else {
      console.error('[recovery] transcription failed:', tr.error)
    }
  }

  const durationS = audioPath
    ? Math.max(0, statSync(audioPath).size - 44) / WAV_BYTES_PER_SECOND
    : 0
  const logged = logCapture({
    runId: `r:${(Date.now() % 0xffff).toString(16).padStart(4, '0')}`,
    kind: marker.kind,
    folder,
    transcript,
    videoPath,
    durationS
  })
  console.log(
    `[recovery] recovered ${marker.kind} (${Math.round(durationS)}s, ${words} words) → ${logged.folder}`
  )
  return { folder: logged.folder, durationS, words, transcript }
}

// Must run after killOrphanedCaptureChildren (pass its pids) and before any new recording starts.
export async function recoverInterruptedRecordings(
  orphanPids: number[],
  showHome: () => void
): Promise<void> {
  if (!existsSync(PATHS.CAPTURES)) return
  const folders = readdirSync(PATHS.CAPTURES)
    .map((name) => join(PATHS.CAPTURES, name))
    .filter((dir) => existsSync(join(dir, MARKER)))
  if (folders.length === 0) return

  if (process.platform === 'darwin' && app.dock) await app.dock.show()
  publish({ working: true, items: [] })
  showHome()
  await waitForExit(orphanPids)
  const recovered: RecoveredRecording[] = []
  for (const folder of folders) {
    try {
      const r = await recoverOne(folder)
      if (r) recovered.push({ folder: r.folder, summary: summarize(r), transcript: r.transcript })
    } catch (err) {
      console.error('[recovery] failed for', folder, err)
    }
  }
  publish({ working: false, items: state.working ? recovered : [] })
}
