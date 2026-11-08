// parakeet-server.ts — resident `nemo-speech serve` so transcription isn't
// re-loading the model on every press.
//
// Why: the CLI path spawns a process per clip, which re-pays process start, 11
// dylibs via @loader_path, and a 680 MB GGUF load EVERY time — not just the
// first. Measured 2026-09-21 on the same 4.36 s clip, interleaved A/B under
// identical load: CLI 2512 ms median vs server 1229 ms, server faster in 6/6
// pairs. `nemo-speech --version`, which loads no model at all, still costs
// ~1130 ms, which is why a one-shot warmup at boot fixes nothing.
//
// Mirrors native-mic.ts: one resident helper, respawn guard, silent fallback.
// Nothing here is required — when the server is down, transcribeWithParakeet
// spawns the CLI exactly as before.

import { ChildProcess, spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../store/paths'
import { CONFIG } from '../../shared/config'
import { whisperModelPathFor } from './binaries'

let server: ChildProcess | null = null
let spawnedAt = 0
let ready = false
let readyProbe: Promise<boolean> | null = null

const RESPAWN_MIN_UPTIME_MS = 5000

export const parakeetServerUrl = `http://${CONFIG.PARAKEET_SERVER_HOST}:${CONFIG.PARAKEET_SERVER_PORT}`

export function isParakeetServerReady(): boolean {
  return ready && server !== null
}

function paths(): { bin: string; model: string } | null {
  const bin = join(PATHS.BIN, CONFIG.PARAKEET_BIN_SUBPATH)
  const model = whisperModelPathFor(CONFIG.PARAKEET_MODEL_NAME)
  if (!existsSync(bin) || !existsSync(model)) return null
  return { bin, model }
}

async function pollUntilReady(): Promise<boolean> {
  const deadline = Date.now() + CONFIG.PARAKEET_SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!server) return false
    try {
      const res = await fetch(`${parakeetServerUrl}/v1/models`, {
        signal: AbortSignal.timeout(1000)
      })
      if (res.ok) {
        ready = true
        console.log(`[parakeet-server] ready on port ${CONFIG.PARAKEET_SERVER_PORT}`)
        return true
      }
    } catch {
      // Not listening yet — the model load is the long pole, keep waiting.
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error('[parakeet-server] never became ready — transcription stays on the CLI path')
  return false
}

/**
 * Spawn the server if it isn't running. Safe to call repeatedly. Returns false
 * when the engine or model isn't installed, which is the normal state for a
 * user who never enabled parakeet.
 */
// A SIGKILLed app never runs dispose; its server is reparented to launchd (ppid 1) and keeps ~750 MB.
function reapOrphanedServers(bin: string): void {
  const pattern = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  spawnSync('pkill', ['-P', '1', '-f', pattern])
}

export function ensureParakeetServer(): boolean {
  if (server) return true
  const p = paths()
  if (!p) return false

  const args = [
    'serve',
    '--asr-model',
    p.model,
    '--host',
    CONFIG.PARAKEET_SERVER_HOST,
    '--port',
    String(CONFIG.PARAKEET_SERVER_PORT),
    '--no-ui'
  ]
  // Metal only exists on Apple Silicon; the x86_64 build rejects the flag.
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    args.push('--device', 'metal')
  }

  reapOrphanedServers(p.bin)
  const proc = spawn(p.bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  server = proc
  spawnedAt = Date.now()
  ready = false

  proc.on('error', (err) => console.error('[parakeet-server] spawn error:', err.message))
  proc.stderr?.on('data', (chunk: Buffer) => {
    console.error('[parakeet-server]', chunk.toString().trim())
  })
  proc.once('close', (code) => {
    const uptime = Date.now() - spawnedAt
    server = null
    ready = false
    readyProbe = null
    if (uptime < RESPAWN_MIN_UPTIME_MS) {
      console.error(`[parakeet-server] exited after ${uptime} ms — not respawning`)
      return
    }
    console.warn(`[parakeet-server] exited (code ${code}) — respawning`)
    setTimeout(() => ensureParakeetServer(), 1000)
  })

  readyProbe = pollUntilReady()
  return true
}

/** Resolves once the model is loaded, or false if it never came up. */
export async function parakeetServerReady(): Promise<boolean> {
  if (ready) return true
  if (!readyProbe) return false
  return readyProbe
}

export function disposeParakeetServer(): void {
  if (!server) return
  const proc = server
  server = null
  ready = false
  readyProbe = null
  proc.removeAllListeners('close')
  proc.kill()
}
