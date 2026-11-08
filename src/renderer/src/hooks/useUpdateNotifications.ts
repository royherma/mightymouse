import { useEffect, useState } from 'react'
import type { UpdateState, UpdateStatusPayload } from '../../../shared/types'

export interface UpdateUiState {
  /** `idle` until the first event arrives or the cache seed resolves. */
  state: 'idle' | UpdateState
  version: string | null
  percent: number | null
  message: string | null
}

const INITIAL: UpdateUiState = { state: 'idle', version: null, percent: null, message: null }

function toUi(p: UpdateStatusPayload): UpdateUiState {
  return {
    state: p.state,
    version: p.version ?? null,
    percent: typeof p.percent === 'number' ? p.percent : null,
    message: p.message ?? null
  }
}

/** Mirrors main's update state: seeded from the cache on mount, then live events. */
export function useUpdateNotifications(): UpdateUiState {
  const [ui, setUi] = useState<UpdateUiState>(INITIAL)

  useEffect(() => {
    const off = window.api.update.onStatus((p) => setUi(toUi(p)))

    // onStatus only fires on NEW events, so a window opened after 'downloaded'
    // landed would sit at `idle` forever. Defers to a live event that beat it.
    let cancelled = false
    void window.api.update.getState().then((p) => {
      if (!cancelled) setUi((prev) => (prev.state === 'idle' ? toUi(p) : prev))
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  return ui
}
