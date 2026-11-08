import type { ActionContextSnapshot, SelectionKind } from '../../shared/action-engine'
import { CONFIG } from '../../shared/config'
import { onFrontmostAppChange } from '../platform/macos/frontmost-watch'
import { readFrontmostScreen, userFacingFrontmostBundleId } from '../platform/macos/app-context'
import { captureSelection } from '../platform/macos/selection'

const SNAPSHOT_FIELD_TIMEOUT_MS = 120

let running = false
let unsubscribe: (() => void) | null = null
let lastChangeTs = Date.now()
const recentApps: string[] = []
const recentActionIds: string[] = []

function pushRecentApp(bundleId: string): void {
  const i = recentApps.indexOf(bundleId)
  if (i !== -1) recentApps.splice(i, 1)
  recentApps.unshift(bundleId)
  recentApps.length = Math.min(recentApps.length, CONFIG.ACTIONS.CONTEXT_RECENT_APPS)
}

function onAppChange(bundleId: string, spawnEcho: boolean): void {
  if (spawnEcho) return
  pushRecentApp(bundleId)
  lastChangeTs = Date.now()
}

export function startContextWindow(): void {
  if (running) return
  running = true
  unsubscribe = onFrontmostAppChange(onAppChange)
}

export function stopContextWindow(): void {
  if (!running) return
  running = false
  unsubscribe?.()
  unsubscribe = null
}

export function isContextWindowRunning(): boolean {
  return running
}

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(fallback)
    }, SNAPSHOT_FIELD_TIMEOUT_MS)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

function urlHostOf(url: string): string {
  if (!url) return ''
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const CODE_HEURISTIC_RE = /[{};()=]|=>|\bfunction\b|\bconst\b|\bimport\b/

function classifySelection(text: string): SelectionKind {
  if (text === '') return 'none'
  const trimmed = text.trim()
  try {
    new URL(trimmed)
    return 'url'
  } catch {}
  if (/^(~|\/|\.\/|\.\.\/)[^\s]+$/.test(trimmed) || /^[A-Za-z]:\\[^\s]+$/.test(trimmed)) {
    return 'file'
  }
  if (CODE_HEURISTIC_RE.test(trimmed)) return 'code'
  return 'text'
}

export async function snapshotContext(): Promise<ActionContextSnapshot> {
  const started = Date.now()
  let screenMs = 0
  let selectionMs = 0
  const [screen, selection] = await Promise.all([
    withTimeout(readFrontmostScreen(), null).then((r) => ((screenMs = Date.now() - started), r)),
    withTimeout(captureSelection(true), '').then((r) => ((selectionMs = Date.now() - started), r))
  ])
  console.log(`[actions] context screen=${screenMs}ms selection=${selectionMs}ms`)

  const selectionKind = classifySelection(selection)

  return {
    frontApp: screen?.appName ?? '',
    bundleId: screen?.bundleId ?? userFacingFrontmostBundleId(),
    windowTitle: screen?.title ?? '',
    urlHost: urlHostOf(screen?.url ?? ''),
    hasSelection: selection !== '',
    selectionText: selection,
    selectionKind,
    recentApps: [...recentApps],
    recentActionIds: [...recentActionIds]
  }
}

export function noteActionRun(actionId: string): void {
  const i = recentActionIds.indexOf(actionId)
  if (i !== -1) recentActionIds.splice(i, 1)
  recentActionIds.unshift(actionId)
  recentActionIds.length = Math.min(recentActionIds.length, CONFIG.ACTIONS.CONTEXT_RECENT_ACTIONS)
}

export function contextChangedSince(ts: number): boolean {
  return lastChangeTs > ts
}
