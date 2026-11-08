import { spawn, type ChildProcess } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CONFIG } from '../../shared/config'
import { PATHS } from '../store/paths'
import { PREFS } from '../store/prefs'
import { shell } from '../platform'

export interface SpareSpec {
  cmd: string
  cwd?: string
  env: Record<string, string>
}

export interface TakenSpare {
  child: ChildProcess
  stdout: string
  stderr: string
}

interface Spare extends TakenSpare {
  spec: SpareSpec
  detach: () => void
}

const specsFile = (): string => join(PATHS.TMP, 'spare-specs.json')
const spares = new Map<string, Spare>()
let recent: SpareSpec[] | null = null

const keyOf = (spec: SpareSpec): string => JSON.stringify([spec.cmd, spec.cwd ?? '', spec.env])

function recentSpecs(): SpareSpec[] {
  if (recent) return recent
  try {
    recent = (JSON.parse(readFileSync(specsFile(), 'utf-8')) as SpareSpec[]).slice(0, CONFIG.SPARES.MAX)
  } catch {
    recent = []
  }
  return recent
}

function remember(spec: SpareSpec): void {
  const key = keyOf(spec)
  const next = [spec, ...recentSpecs().filter((s) => keyOf(s) !== key)]
  for (const dropped of next.splice(CONFIG.SPARES.MAX)) retire(keyOf(dropped))
  recent = next
  if (PREFS.getIncognito()) return
  try {
    writeFileSync(specsFile(), JSON.stringify(next), 'utf-8')
  } catch { /* Best-effort: the pool still works in memory. */ }
}

function retire(key: string): void {
  const spare = spares.get(key)
  if (!spare) return
  spares.delete(key)
  spare.detach()
  try { process.kill(-spare.child.pid!, 'SIGKILL') } catch { try { spare.child.kill('SIGKILL') } catch { /* already gone */ } }
}

function spawnSpare(spec: SpareSpec): void {
  const key = keyOf(spec)
  if (spares.has(key)) return
  const child = spawn(shell.bin, shell.spawnArgs(spec.cmd), {
    env: { ...shell.env(), ...spec.env, MM_INTERNAL_RUN: 'spare' },
    cwd: spec.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  })
  const onOut = (d: Buffer): void => { spare.stdout += d.toString() }
  const onErr = (d: Buffer): void => { spare.stderr += d.toString() }
  const recycle = setTimeout(() => {
    retire(key)
    spawnSpare(spec)
  }, CONFIG.SPARES.RECYCLE_MS)
  const spare: Spare = {
    spec,
    child,
    stdout: '',
    stderr: '',
    detach: () => {
      clearTimeout(recycle)
      child.stdout?.off('data', onOut)
      child.stderr?.off('data', onErr)
    }
  }
  child.stdout?.on('data', onOut)
  child.stderr?.on('data', onErr)
  child.stdin?.on('error', () => {})
  const forget = (): void => {
    clearTimeout(recycle)
    if (spares.get(key) === spare) spares.delete(key)
  }
  child.on('close', forget)
  child.on('error', forget)
  spares.set(key, spare)
}

export function takeSpare(spec: SpareSpec): TakenSpare | undefined {
  remember(spec)
  const key = keyOf(spec)
  const spare = spares.get(key)
  if (!spare) return undefined
  spares.delete(key)
  spare.detach()
  if (spare.child.exitCode !== null || spare.child.signalCode !== null) return undefined
  return { child: spare.child, stdout: spare.stdout, stderr: spare.stderr }
}

export function keepSpareReady(spec: SpareSpec): void {
  if (recentSpecs().some((s) => keyOf(s) === keyOf(spec))) spawnSpare(spec)
}

export function fillSpares(): void {
  for (const spec of recentSpecs()) spawnSpare(spec)
}

export function hasSpares(): boolean {
  return spares.size > 0
}

export function disposeSpares(): void {
  for (const key of [...spares.keys()]) retire(key)
}

export function stdinPromptLine(prompt: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n'
}
