import { BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { PATHS } from './store/paths'
import { CONFIG } from '../shared/config'
import { CHANNELS } from '../shared/ipc'
import { devLog } from '../shared/env'
import type { ModelCatalogEntry } from '../shared/types'

const FETCH_TIMEOUT_MS = 8000
const TIERS = new Set(['cheap', 'mid', 'premium'])

let current: ModelCatalogEntry[] | null = null
let timer: NodeJS.Timeout | null = null

function parseCatalog(raw: unknown): ModelCatalogEntry[] | null {
  if (!Array.isArray(raw)) return null
  const models = raw.filter(
    (m): m is ModelCatalogEntry =>
      !!m &&
      typeof m.id === 'string' &&
      m.id !== '' &&
      typeof m.label === 'string' &&
      m.label !== '' &&
      TIERS.has(m.tier) &&
      (m.kind === undefined || m.kind === 'text')
  )
  return models.length > 0 ? models.map(({ id, label, tier }) => ({ id, label, tier })) : null
}

function readSaved(): ModelCatalogEntry[] | null {
  if (!existsSync(PATHS.MODEL_CATALOG_FILE)) return null
  try {
    return parseCatalog(JSON.parse(readFileSync(PATHS.MODEL_CATALOG_FILE, 'utf-8')))
  } catch {
    return null
  }
}

export function getModelCatalog(): ModelCatalogEntry[] {
  current ??= readSaved() ?? CONFIG.MODEL_CATALOG
  return current
}

export function isCatalogModel(id: string): boolean {
  return getModelCatalog().some((m) => m.id === id)
}

async function fetchCatalog(): Promise<ModelCatalogEntry[] | null> {
  const controller = new AbortController()
  const abort = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${CONFIG.BILLING.EDGE_FUNCTION_URL}/${CONFIG.MODEL_CATALOG_FN}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) {
      devLog.warn('[model-catalog] HTTP', res.status)
      return null
    }
    const body = (await res.json()) as { models?: unknown }
    return parseCatalog(body?.models)
  } catch (err) {
    devLog.warn('[model-catalog] fetch failed:', err)
    return null
  } finally {
    clearTimeout(abort)
  }
}

export async function refreshModelCatalog(): Promise<void> {
  const fetched = await fetchCatalog()
  if (!fetched) return
  if (JSON.stringify(fetched) === JSON.stringify(getModelCatalog())) return
  current = fetched
  try {
    writeFileSync(PATHS.MODEL_CATALOG_FILE, JSON.stringify(fetched), 'utf-8')
  } catch (err) {
    devLog.warn('[model-catalog] save failed:', err)
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANNELS.modelCatalogChanged, fetched)
  }
}

export function startModelCatalogRefresh(): void {
  if (timer) return
  void refreshModelCatalog()
  timer = setInterval(() => void refreshModelCatalog(), CONFIG.MODEL_CATALOG_REFRESH_MS)
  timer.unref()
}
