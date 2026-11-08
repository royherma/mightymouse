import { useCallback, useEffect, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'
import type { AgentRelaySessionInfo, TurnUndoState } from '@shared/types'
import type { ModelScope, PhoneRemoteEvent, RelayProjectWire, SessionGitOp } from '@shared/phone-remote-protocol'
import type { ProjectIdea } from '@shared/project-ideas'
import { foldSteps } from '@shared/session-steps'
import type { PulseScope, PulseState } from '@shared/session-pulse'
import type { OpenChatThread } from '../chat-steps'
import type { SocketBus } from '../socket-bus'
import { currentDeviceCredential } from '../useHostDiscovery'
import { nativeBridge, subscribeNativeIntent } from '../native-bridge'
import type { UseConnectionResult } from '../hooks/use-connection'

export type MediaRef = { key: string; src: string; name: string; video?: boolean }

export type ThreadItem =
  | { kind: 'you'; key: string; at: number; text: string; media: MediaRef[]; undo?: TurnUndoState }
  | { kind: 'agent'; key: string; at: number; text: string; recap?: string; failed?: boolean; media: MediaRef[] }
  | { kind: 'steps'; key: string; at: number; texts: string[] }

export type TranscriptTurn = Extract<PhoneRemoteEvent, { type: 'relayTranscript' }>['turns'][number]
export type SessionInfoWire = Omit<Extract<PhoneRemoteEvent, { type: 'relayInfo' }>, 'type'>
export type SessionGitWire = Omit<Extract<PhoneRemoteEvent, { type: 'relaySessionGitState' }>, 'type'>
export type GitNote = { text: string; failed: boolean }
export type Models = Omit<Extract<PhoneRemoteEvent, { type: 'models' }>, 'type' | 'scope'>
export type IdeasState = { ideas: ProjectIdea[]; at?: number; stale?: boolean; loading: boolean }
export type StartState = {
  requestId: string
  projectId: string
  projectName: string
  text: string
  startedAt?: number
  error?: string
}

const CHAT_PROJECT_KEY = 'mm-remote-ai-chat-project'
const TRANSCRIPT_POLL_MS = 4000
const START_MATCH_SLACK_MS = 5000
const GIT_ANSWER_MAX_MS = 150_000

function readProject(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function cred(): string {
  return encodeURIComponent(currentDeviceCredential() ?? '')
}

export function chatMediaUrl(sessionId: string, turn: number, item: number): string {
  return `${CONFIG.PHONE_REMOTE.CHAT_MEDIA_PATH}?sessionId=${encodeURIComponent(sessionId)}&turn=${turn}&item=${item}&credential=${cred()}`
}

export function codeMediaUrl(label: string, at: number, item: number): string {
  return `${CONFIG.PHONE_REMOTE.CHAT_MEDIA_PATH}?label=${encodeURIComponent(label)}&at=${at}&item=${item}&credential=${cred()}`
}

export function chatThreadItems(thread: OpenChatThread, showSteps: boolean): ThreadItem[] {
  const items: ThreadItem[] = []
  thread.turns.forEach((t, i) => {
    const at = Date.parse(t.ts) || i
    const media = (mine: boolean): MediaRef[] =>
      (t.media ?? [])
        .filter((m) => m.mine === mine)
        .map((m) => ({
          key: `${m.turn}:${m.item}`,
          src: chatMediaUrl(thread.id, m.turn, m.item),
          name: m.name,
          video: m.kind === 'video' || undefined
        }))
    if (t.q || media(true).length) items.push({ kind: 'you', key: `q${i}`, at, text: t.q, media: media(true) })
    if (showSteps && t.steps?.length) {
      items.push({ kind: 'steps', key: `s${i}`, at, texts: t.steps.map((s) => `${s.phase} ${s.detail}`.trim()) })
    }
    if (t.a || media(false).length) {
      items.push({ kind: 'agent', key: `a${i}`, at, text: t.a, failed: !t.ok || undefined, media: media(false) })
    }
  })
  return items
}

export function codeThreadItems(label: string, turns: TranscriptTurn[], showSteps: boolean): ThreadItem[] {
  const said = turns.map((t) => ({ ...t, kind: 'said' as const }))
  return foldSteps(said, showSteps).map((row, i): ThreadItem => {
    if ('texts' in row) return { kind: 'steps', key: `s${row.at}:${i}`, at: row.at, texts: row.texts }
    const media = Array.from({ length: row.media ?? 0 }, (_, n) => ({
      key: `${row.at}:${n}`,
      src: codeMediaUrl(label, row.at, n),
      name: row.videos?.includes(n) ? `video ${n + 1}` : `image ${n + 1}`,
      video: row.videos?.includes(n) || undefined
    }))
    return row.role === 'you'
      ? { kind: 'you', key: `y${row.at}:${i}`, at: row.at, text: row.text, media, undo: row.undo }
      : { kind: 'agent', key: `a${row.at}:${i}`, at: row.at, text: row.text, recap: row.recap, media }
  })
}

export function matchStartedSession(
  start: StartState | null,
  sessions: AgentRelaySessionInfo[]
): AgentRelaySessionInfo | undefined {
  if (!start?.startedAt) return undefined
  const since = start.startedAt - START_MATCH_SLACK_MS
  return sessions
    .filter((s) => (start.projectId === '' ? !s.project : s.project?.name === start.projectName) && (s.since ?? 0) >= since && !s.stale)
    .sort((a, b) => (a.since ?? 0) - (b.since ?? 0))[0]
}

interface UseAiSessionArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  sendBinary: UseConnectionResult['sendBinary']
}

export function useAiSession({ bus, send, sendBinary }: UseAiSessionArgs) {
  const [projects, setProjects] = useState<RelayProjectWire[] | null>(null)
  const [ideas, setIdeas] = useState<Record<string, IdeasState>>({})
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptTurn[]>>({})
  const [info, setInfo] = useState<Record<string, SessionInfoWire>>({})
  const [git, setGit] = useState<Record<string, SessionGitWire>>({})
  const [gitBusy, setGitBusy] = useState<Record<string, SessionGitOp>>({})
  const [gitNote, setGitNote] = useState<Record<string, GitNote | undefined>>({})
  const [pulse, setPulse] = useState<Record<string, PulseState>>({})
  const [start, setStart] = useState<StartState | null>(null)
  const [lastProjectId, setLastProjectId] = useState<string | null>(null)
  const [chatProjectId, setChatProjectId] = useState<string | null>(() => readProject(CHAT_PROJECT_KEY))
  const [models, setModels] = useState<Partial<Record<ModelScope, Models>>>({})
  const [undoError, setUndoError] = useState<{ label: string; at: number; error: string } | null>(null)
  const gitBusyRef = useRef(gitBusy)
  gitBusyRef.current = gitBusy
  const startRef = useRef(start)
  startRef.current = start

  useEffect(() => {
    const offs = [
      bus.subscribe('relayProjectList', (msg) => setProjects(msg.projects)),
      bus.subscribe('models', (msg) =>
        setModels((prev) => ({ ...prev, [msg.scope]: { current: msg.current, options: msg.options } }))
      ),
      bus.subscribe('relayIdeas', (msg) =>
        setIdeas((prev) => ({
          ...prev,
          [msg.projectId]: { ideas: msg.ideas, at: msg.at, stale: msg.stale, loading: false }
        }))
      ),
      bus.subscribe('relayTranscript', (msg) => setTranscripts((prev) => ({ ...prev, [msg.label]: msg.turns }))),
      bus.subscribe('relayInfo', (msg) => setInfo((prev) => ({ ...prev, [msg.label]: msg }))),
      bus.subscribe('relaySessionGitState', (msg) => {
        setGit((prev) => ({ ...prev, [msg.label]: msg }))
        setGitBusy(({ [msg.label]: _done, ...rest }) => rest)
        if (msg.op === 'status') return
        const base = msg.pull?.base
        const note: GitNote = msg.error
          ? { text: msg.error, failed: true }
          : msg.op === 'open'
            ? { text: `Opened #${msg.pull?.number} into ${base}`, failed: false }
            : { text: `Merged #${msg.pull?.number} into ${base}`, failed: false }
        setGitNote((prev) => ({ ...prev, [msg.label]: note }))
      }),
      bus.subscribe('relaySessionUndone', (msg) =>
        setUndoError(msg.result.ok ? null : { label: msg.label, at: msg.at, error: msg.result.error })
      ),
      bus.subscribe('pulseState', (msg) => setPulse((prev) => ({ ...prev, [msg.label]: msg.state }))),
      bus.subscribe('relaySessionStarted', (msg) => {
        if (startRef.current?.requestId !== msg.requestId) return
        setStart((prev) =>
          prev && prev.requestId === msg.requestId
            ? { ...prev, startedAt: msg.ok ? (msg.startedAt ?? Date.now()) : undefined, error: msg.ok ? undefined : (msg.reason ?? 'It did not start.') }
            : prev
        )
      })
    ]
    return () => offs.forEach((off) => off())
  }, [bus])

  const requestProjects = useCallback(() => send({ type: 'relayProjects' }), [send])
  const requestModels = useCallback((scope: ModelScope) => send({ type: 'modelsGet', scope }), [send])
  const chooseModel = useCallback(
    (scope: ModelScope, id: string) => {
      setModels((prev) => {
        const cur = prev[scope]
        return cur ? { ...prev, [scope]: { ...cur, current: id } } : prev
      })
      send({ type: 'modelsSet', scope, id })
    },
    [send]
  )

  const requestIdeas = useCallback(
    (projectId: string, mode: 'cached' | 'generate' | 'refresh' = 'cached') => {
      setIdeas((prev) => ({ ...prev, [projectId]: { ideas: prev[projectId]?.ideas ?? [], loading: true } }))
      send({ type: 'relayProjectIdeas', projectId, mode })
    },
    [send]
  )

  const requestInfo = useCallback((label: string) => send({ type: 'relaySessionInfo', label }), [send])
  const requestGit = useCallback(
    (label: string, op: SessionGitOp) => {
      if (op !== 'status') {
        setGitBusy((prev) => ({ ...prev, [label]: op }))
        setGitNote((prev) => ({ ...prev, [label]: undefined }))
        window.setTimeout(() => {
          if (gitBusyRef.current[label] !== op) return
          setGitBusy(({ [label]: _late, ...rest }) => rest)
          setGitNote((prev) => ({ ...prev, [label]: { text: 'Your Mac did not answer.', failed: true } }))
        }, GIT_ANSWER_MAX_MS)
      }
      if (!send({ type: 'relaySessionGit', label, op }) && op !== 'status') {
        setGitBusy(({ [label]: _unsent, ...rest }) => rest)
        setGitNote((prev) => ({ ...prev, [label]: { text: "Not sent - your Mac isn't connected", failed: true } }))
      }
    },
    [send]
  )
  const clearGitNote = useCallback((label: string) => setGitNote((prev) => ({ ...prev, [label]: undefined })), [])
  const requestPulse = useCallback((label: string) => send({ type: 'pulseGet', label }), [send])
  const scorePulse = useCallback(
    (label: string, force: boolean) => send({ type: 'pulseScore', label, force }),
    [send]
  )
  const setPulseScope = useCallback(
    (label: string, scope: PulseScope) => send({ type: 'pulseSetScope', label, scope }),
    [send]
  )

  const undoTurn = useCallback((label: string, at: number) => send({ type: 'relaySessionUndo', label, at }), [send])

  const watchTranscript = useCallback(
    (label: string) => {
      const ask = (): void => {
        if (document.visibilityState === 'visible') send({ type: 'relaySessionTranscript', label })
      }
      ask()
      const timer = window.setInterval(ask, TRANSCRIPT_POLL_MS)
      return () => window.clearInterval(timer)
    },
    [send]
  )

  const chooseProject = useCallback((projectId: string | null) => setLastProjectId(projectId), [])

  const chooseChatProject = useCallback((projectId: string | null) => {
    setChatProjectId(projectId)
    try {
      if (projectId) localStorage.setItem(CHAT_PROJECT_KEY, projectId)
      else localStorage.removeItem(CHAT_PROJECT_KEY)
    } catch {
      /* private mode */
    }
  }, [])

  const startSession = useCallback(
    async (input: { project: RelayProjectWire | null; text: string; harness?: 'claude' | 'codex'; file?: File }) => {
      const requestId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const attachLabel = input.file ? `new:${requestId}` : undefined
      const projectId = input.project?.id ?? ''
      setStart({ requestId, projectId, projectName: input.project?.name ?? '', text: input.text })
      chooseProject(input.project?.id ?? null)
      if (input.file && attachLabel) {
        const buf = await input.file.arrayBuffer()
        send({ type: 'imageMeta', mime: input.file.type, byteLength: buf.byteLength, name: input.file.name, replyToLabel: attachLabel })
        if (!sendBinary(buf)) {
          setStart((prev) => (prev?.requestId === requestId ? { ...prev, error: 'The photo did not send.' } : prev))
          return
        }
      }
      const started = send({
        type: 'relayStartSession',
        requestId,
        projectId,
        text: input.text,
        harness: input.harness,
        attachLabel
      })
      if (!started) setStart((prev) => (prev?.requestId === requestId ? { ...prev, error: "Not sent - your Mac isn't connected" } : prev))
    },
    [send, sendBinary, chooseProject]
  )

  const clearStart = useCallback(() => setStart(null), [])

  return {
    projects,
    ideas,
    transcripts,
    undoError,
    undoTurn,
    info,
    git,
    gitBusy,
    gitNote,
    requestGit,
    clearGitNote,
    pulse,
    requestPulse,
    scorePulse,
    setPulseScope,
    start,
    lastProjectId,
    chatProjectId,
    chooseChatProject,
    models,
    requestModels,
    chooseModel,
    requestProjects,
    requestIdeas,
    requestInfo,
    watchTranscript,
    chooseProject,
    startSession,
    clearStart
  }
}

export type AiSession = ReturnType<typeof useAiSession>

export type PushStatus = 'authorized' | 'denied' | 'notDetermined' | null

// Re-queried on every foreground: the grant is revocable from iOS Settings while backgrounded.
export function usePushStatus(open: boolean): PushStatus {
  const [status, setStatus] = useState<PushStatus>(null)

  useEffect(() => {
    if (!nativeBridge.available) return
    const unsubscribe = subscribeNativeIntent((intent) => {
      if (intent.type === 'pushStatus') setStatus(intent.status)
    }, [])
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!nativeBridge.available || !open) return
    nativeBridge.pushStatusQuery()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') nativeBridge.pushStatusQuery()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [open])

  return status
}
