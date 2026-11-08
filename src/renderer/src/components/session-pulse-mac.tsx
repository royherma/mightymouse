import { useCallback, useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { Switch } from './Switch'
import { Button } from './Button'
import { SettingRow } from './settings/sections'
import { pulseDot, type PulseRow, type PulseState } from '../../../shared/session-pulse'
import { PulsePanel } from './session-pulse'

const OPEN_KEY = 'pulse-island-open'

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    return
  }
}

export function PulseSetting(): React.JSX.Element {
  const [on, setOn] = useState(false)
  useEffect(() => {
    void window.api.pulseState('').then((s) => setOn(s.enabled))
  }, [])
  const toggle = (next: boolean): void => {
    setOn(next)
    void window.api.pulseSetEnabled(next)
  }
  return (
    <SettingRow
      title={<div className="font-semibold text-lg">Score every agent reply</div>}
      control={<Switch on={on} onChange={toggle} />}
    >
      <div className="text-muted text-sm">
        After each reply in Code, check if the agent is on goal, making progress, showing proof,
        stuck, or doing something risky. Shows at the top of the session.
      </div>
    </SettingRow>
  )
}

export function SessionPulse(props: {
  sessionRef: string
  onAnswer?: () => void
  onAxisSend?: (prompt: string) => Promise<boolean>
}): React.JSX.Element | null {
  const { sessionRef, onAnswer, onAxisSend } = props
  const [state, setState] = useState<PulseState | null>(null)
  const [open, setOpenState] = useState(readOpen)
  const setOpen = (next: boolean): void => {
    setOpenState(next)
    writeOpen(next)
  }

  const refresh = useCallback(() => {
    void window.api.pulseState(sessionRef).then(setState)
  }, [sessionRef])

  useEffect(() => {
    refresh()
    return window.api.onPulseChanged(() => refresh())
  }, [refresh])

  const enabled = state?.enabled === true
  useEffect(() => {
    if (enabled) void window.api.pulseScoreNow(sessionRef)
  }, [enabled, sessionRef])

  if (!state) return null
  const dot = pulseDot(state.rows[state.rows.length - 1])

  return (
    <div className="session-pulse-anchor">
      {!open && (
        <Button
          variant="bare"
          className="session-pulse-toggle"
          title="Show Pulse"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <Activity size={15} strokeWidth={2.25} />
          <span className="session-pulse-toggle-dot" style={{ background: dot }} />
        </Button>
      )}
      {open && (
        <div className="session-pulse-island flex flex-col gap-3.5 border border-surface3 p-5">
          <PulsePanel
            sessionRef={sessionRef}
            state={state}
            onScore={(force) => void window.api.pulseScoreNow(sessionRef, force)}
            onScope={(scope) => void window.api.pulseSetScope(sessionRef, scope)}
            onChip={(prompt) => window.api.agentRelaySessionReply(sessionRef, prompt)}
            onAxisSend={onAxisSend}
            onAnswer={onAnswer}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  )
}

export function usePulseFresh(sessionIds: readonly string[], on: boolean): Record<string, PulseRow> {
  const [rows, setRows] = useState<Record<string, PulseRow>>({})
  const key = on ? sessionIds.join('|') : ''
  useEffect(() => {
    if (!key) return
    const ids = key.split('|')
    let alive = true
    const refresh = (): void => {
      void window.api.pulseFresh(ids).then((next) => {
        if (alive) setRows(next)
      })
    }
    refresh()
    const off = window.api.onPulseChanged(refresh)
    return () => {
      alive = false
      off()
    }
  }, [key])
  return rows
}
