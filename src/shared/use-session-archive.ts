import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentRelaySessionInfo, SessionMark, SessionMarks } from './types'
import { LEGACY_ARCHIVE_STORAGE_KEY, sessionArchiveKey } from './session-archive'

export type SessionArchiveSink = {
  mark: (session: AgentRelaySessionInfo, change: SessionMark) => void
  importLegacy: (entries: unknown) => void
}

function handOverLegacyArchive(sink: SessionArchiveSink): void {
  try {
    const raw = localStorage.getItem(LEGACY_ARCHIVE_STORAGE_KEY)
    if (!raw) return
    sink.importLegacy(JSON.parse(raw))
    localStorage.removeItem(LEGACY_ARCHIVE_STORAGE_KEY)
  } catch {
    // Storage blocked or unparseable: nothing to hand over.
  }
}

export function useSessionArchive(
  sessions: AgentRelaySessionInfo[],
  marks: SessionMarks | undefined,
  sink: SessionArchiveSink
): {
  all: AgentRelaySessionInfo[]
  sessions: AgentRelaySessionInfo[]
  count: number
  showArchived: boolean
  setShowArchived: (value: boolean) => void
  isArchived: (session: AgentRelaySessionInfo) => boolean
  setArchived: (session: AgentRelaySessionInfo, archived: boolean) => boolean
  isPinned: (session: AgentRelaySessionInfo) => boolean
  setPinned: (session: AgentRelaySessionInfo, pinned: boolean) => boolean
  error: string
  clearError: () => void
} {
  const [showArchived, setShowArchived] = useState(false)
  const [pending, setPending] = useState<SessionMarks>({})

  useEffect(() => handOverLegacyArchive(sink), [])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPending({}), [marks])

  const markOf = useCallback(
    (session: AgentRelaySessionInfo): SessionMark => {
      const key = sessionArchiveKey(session)
      return { ...marks?.[key], ...pending[key] }
    },
    [marks, pending]
  )
  const isArchived = useCallback((s: AgentRelaySessionInfo) => markOf(s).archived === true, [markOf])
  const isPinned = useCallback((s: AgentRelaySessionInfo) => markOf(s).pinned === true, [markOf])

  const write = (session: AgentRelaySessionInfo, change: SessionMark): boolean => {
    const key = sessionArchiveKey(session)
    setPending((p) => ({ ...p, [key]: { ...p[key], ...change } }))
    sink.mark(session, change)
    return true
  }

  const visible = useMemo(
    () => sessions.filter((session) => isArchived(session) === showArchived),
    [sessions, isArchived, showArchived]
  )
  const count = useMemo(() => sessions.filter(isArchived).length, [sessions, isArchived])
  return {
    all: sessions,
    sessions: visible,
    count,
    showArchived,
    setShowArchived,
    isArchived,
    setArchived: (session, archived) => write(session, { archived }),
    isPinned,
    setPinned: (session, pinned) => write(session, { pinned }),
    error: '',
    clearError: () => {}
  }
}
