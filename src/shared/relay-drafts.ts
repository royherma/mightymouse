/**
 * Persistent reply drafts for the Code surfaces (relay inbox v2, item 4).
 *
 * Both Code surfaces used to hold the half-typed answer in per-card
 * `useState`. That state is scoped to a card that unmounts whenever the list
 * re-renders -- and a `relayPending` snapshot arrives on EVERY mint and every
 * resolve, from any agent. So a second agent asking anything while you were
 * mid-sentence silently wiped what you had typed.
 *
 * Keyed by requestId, not by index: cards reorder under the sort in item 7,
 * and a positional key would hand your answer to a different question.
 *
 * Deliberately synchronous and tiny. A draft is short text a human is actively
 * looking at -- an async write would land after the re-render that loses it,
 * which is the exact bug this replaces.
 */

const STORAGE_KEY = 'mm.relay.drafts.v1'

/** Drafts older than this are dropped on load. A relay request times out at
 *  600s by default, so anything from a previous day belongs to a request that
 *  cannot still be pending -- keeping it would restore text onto a card the
 *  human has no memory of typing. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

interface DraftRow {
  text: string
  /** Epoch ms of the last edit, for the age sweep above. */
  ts: number
}

type DraftMap = Record<string, DraftRow>

/** Storage is optional on purpose: the phone runs inside an installed PWA
 *  whose storage is partitioned (memory `ios-pwa-storage-partition`), and a
 *  private-mode Safari can throw on write. A draft that fails to persist must
 *  still work in-session, so every path falls back to the in-memory map. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

let cache: DraftMap | null = null

function load(): DraftMap {
  if (cache) return cache
  const store = storage()
  if (!store) {
    cache = {}
    return cache
  }
  try {
    const raw = store.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as DraftMap) : {}
    const cutoff = Date.now() - MAX_AGE_MS
    cache = Object.fromEntries(
      Object.entries(parsed).filter(([, row]) => row && typeof row.text === 'string' && row.ts > cutoff)
    )
  } catch {
    // A corrupt blob is not worth a crash on a surface whose whole job is to
    // unblock an agent. Start clean.
    cache = {}
  }
  return cache
}

function persist(): void {
  const store = storage()
  if (!store || !cache) return
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // Quota or private mode. In-memory cache still holds it for this session.
  }
}

export function readDraft(requestId: string): string {
  return load()[requestId]?.text ?? ''
}

/** Empty text deletes the row rather than storing "" -- otherwise clearing a
 *  field leaves a tombstone that counts against the age sweep forever. */
export function writeDraft(requestId: string, text: string): void {
  const map = load()
  if (text === '') delete map[requestId]
  else map[requestId] = { text, ts: Date.now() }
  persist()
}

/** Call on resolve, dismiss, or timeout. Request ids are UUIDs so they are
 *  never reused, but a settled request's draft is dead weight that would
 *  otherwise survive until the age sweep. */
export function clearDraft(requestId: string): void {
  const map = load()
  if (!(requestId in map)) return
  delete map[requestId]
  persist()
}

/** Drop drafts for every request the surface no longer knows about. Called
 *  with the live pending ids on each snapshot: a request answered on ANOTHER
 *  device never reaches this surface's resolve path, so without this its draft
 *  would linger. */
export function pruneDrafts(liveRequestIds: readonly string[]): void {
  const map = load()
  const live = new Set(liveRequestIds)
  let changed = false
  for (const id of Object.keys(map)) {
    if (!live.has(id)) {
      delete map[id]
      changed = true
    }
  }
  if (changed) persist()
}

/** Test-only: drop the memo so a suite's localStorage stub is re-read. */
export function resetDraftCacheForTests(): void {
  cache = null
}
