import { useCallback, useEffect, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'
import type { ChatStep } from '../chat-steps'
import { appendStep, RUNNING_FALLBACK } from '../chat-steps'
import type { SocketBus } from '../socket-bus'
import type { UseConnectionResult } from './use-connection'

interface UseActProgressArgs {
  bus: SocketBus
  send: UseConnectionResult['send']
  showToast: (
    text: string,
    historyId?: string | null,
    persist?: boolean,
    failed?: boolean,
    offline?: boolean
  ) => void
}

/** Owns the Act progress sheet, run id, and step list. */
export function useActProgress({ bus, send, showToast }: UseActProgressArgs) {
  const [actProgressOpen, setActProgressOpen] = useState(false)
  const [actRunId, setActRunId] = useState<string | null>(null)
  const actRunIdRef = useRef<string | null>(null)
  actRunIdRef.current = actRunId
  const [actInstruction, setActInstruction] = useState('')
  const actInstructionRef = useRef('')
  const [actSteps, setActSteps] = useState<ChatStep[]>([])

  useEffect(() => {
    return bus.subscribe('actProgress', (msg) => {
      if (actRunIdRef.current === null) {
        actRunIdRef.current = msg.runId
        setActRunId(msg.runId)
        actInstructionRef.current = msg.detail ?? ''
        setActInstruction(msg.detail ?? '')
        return
      }
      if (msg.runId !== actRunIdRef.current) return
      setActSteps((prev) =>
        appendStep(prev, msg.phase, msg.detail ?? '', CONFIG.PHONE_REMOTE.CHAT_STEP_LIMIT)
      )
    })
  }, [bus])

  const onRunDone = useCallback(() => {
    actRunIdRef.current = null
    setActRunId(null)
    setActProgressOpen(false)
  }, [])

  const onActDictation = useCallback(
    (id: string) => {
      setActRunId(null)
      setActInstruction('')
      setActSteps([])
      send({ type: 'actDictation', id })
      showToast(RUNNING_FALLBACK, null, true)
    },
    [send, showToast]
  )

  /** Put the card away without touching the run. The toast is what brings it
   *  back, which is why nothing here clears the run id or the steps. */
  const onHideActProgress = useCallback(() => {
    setActProgressOpen(false)
  }, [])

  const onStopActProgress = useCallback(() => {
    const runId = actRunIdRef.current
    if (!runId) return
    send({ type: 'stopRun', runId })
    setActProgressOpen(false)
    showToast('Stopping…', null, true)
  }, [send, showToast])

  return {
    actProgressOpen,
    setActProgressOpen,
    actRunId,
    actInstruction,
    actSteps,
    onRunDone,
    onActDictation,
    onHideActProgress,
    onStopActProgress
  }
}
