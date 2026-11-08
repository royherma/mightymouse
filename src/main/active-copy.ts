import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { MenuItemConstructorOptions } from 'electron'
import { CONFIG } from '../shared/config'

// Shared by every installed copy (prod app, staging build, dev), so it can't live in either data root.
const DIR = join(homedir(), '.mightymouse', 'copies')
const ACTIVE_FILE = join(DIR, 'active.txt')
const SEEN_SUFFIX = '.seen'
const HEARTBEAT_MS = 3_000
// Longer than a `make restart`, so the picked copy keeps its shortcuts across a dev reload.
const STALE_MS = 20_000
const CLAIM_TRIES = 5
const ME = CONFIG.APP_NAME

interface Owned {
  onChange: () => void
  claim: () => Promise<boolean>
  release: () => void
}

let active = true
let activeName = ME
let others: string[] = []
let timer: NodeJS.Timeout | null = null
let owned: Owned | null = null

const seenFile = (name: string): string => join(DIR, `${name}${SEEN_SUFFIX}`)

function readSeenAt(name: string): number {
  try {
    return Number(readFileSync(seenFile(name), 'utf8')) || 0
  } catch {
    return 0
  }
}

function liveCopies(): string[] {
  const now = Date.now()
  return readdirSync(DIR)
    .filter((f) => f.endsWith(SEEN_SUFFIX))
    .map((f) => f.slice(0, -SEEN_SUFFIX.length))
    .filter((name) => now - readSeenAt(name) < STALE_MS)
}

function readChosen(): string {
  return existsSync(ACTIVE_FILE) ? readFileSync(ACTIVE_FILE, 'utf8').trim() : ''
}

function tick(): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(seenFile(ME), String(Date.now()))
    const live = liveCopies()
    let chosen = readChosen()
    if (!chosen) {
      writeFileSync(ACTIVE_FILE, ME)
      chosen = ME
    }
    const nextActive = chosen === ME || !live.includes(chosen)
    const nextName = nextActive ? ME : chosen
    const nextOthers = live.filter((n) => n !== ME).sort()
    const flipped = nextActive !== active
    const changed = flipped || nextName !== activeName || nextOthers.join('|') !== others.join('|')
    active = nextActive
    activeName = nextName
    others = nextOthers
    if (changed) {
      console.log('[active-copy]', { me: ME, active, activeName, others })
      if (flipped) syncOwned()
      owned?.onChange()
    }
  } catch (err) {
    console.error('[active-copy] heartbeat failed, keeping last state:', err)
  }
}

export function isActiveCopy(): boolean {
  return active
}

// The copy losing the pick frees its ports on its next heartbeat, so the claim retries until then.
async function claimWithRetry(triesLeft: number): Promise<void> {
  if (!owned || !active) return
  if (await owned.claim()) return
  if (triesLeft > 0) setTimeout(() => void claimWithRetry(triesLeft - 1), HEARTBEAT_MS)
}

function syncOwned(): void {
  if (!owned) return
  if (active) void claimWithRetry(CLAIM_TRIES)
  else owned.release()
}

export function startActiveCopy(o: Owned): void {
  if (timer) return
  owned = o
  tick()
  syncOwned()
  timer = setInterval(tick, HEARTBEAT_MS)
}

// Dropping our heartbeat hands the shortcuts to the other copy now instead of after STALE_MS.
export function stopActiveCopy(): void {
  if (timer) clearInterval(timer)
  timer = null
  owned = null
  rmSync(seenFile(ME), { force: true })
}

function choose(name: string): void {
  try {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(ACTIVE_FILE, name)
  } catch (err) {
    console.error('[active-copy] could not save the pick:', err)
  }
  tick()
}

export function activeCopyMenuItems(): MenuItemConstructorOptions[] {
  if (others.length === 0) return []
  return [
    {
      label: CONFIG.UI_LABELS.ACTIVE_COPY_SUBMENU,
      submenu: [ME, ...others].map((name) => ({
        label: name === ME ? `${name} ${CONFIG.UI_LABELS.ACTIVE_COPY_THIS_ONE}` : name,
        type: 'radio' as const,
        checked: name === activeName,
        click: () => choose(name)
      }))
    },
    { type: 'separator' as const }
  ]
}
