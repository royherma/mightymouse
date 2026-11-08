import './index.css'
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CoordinationPanel } from './components/CoordinationPanel'
import { SessionDetail } from './components/session-detail'
import type { AgentRelaySessionInfo } from '../../shared/types'
import type { RosterAgent } from '../../shared/coordination-roster'
import { injectTheme } from './theme'

/**
 * Visual harness for the shared-work roster — the Work sub-tab of the Code
 * panel, which no existing harness covers and which only fills up when real
 * agents happen to be running.
 *
 * The fixture in coord-stub.local.js carries every state the list can show at
 * once: stuck, waiting on you, working, idle, cold behind the reveal, and work
 * whose owner is not in the page.
 *
 * `LIVE` matches a3 and b1 by sessionId, exactly as CodePanel joins the two
 * lists -- without it every row falls to the not-connected path and the click
 * that opens a session never renders. a4 (codex) is deliberately absent, which
 * is the real shape: measured on the live machine, 0 of 15 opencode sessions
 * join a relay session.
 */

const LIVE: AgentRelaySessionInfo[] = [
  { label: 'claude 4b9b09ab', sessionId: 'a3', cwd: '/Users/roy/Development/ShowAndTell', agent: 'claude' },
  { label: 'claude 77c1d902', sessionId: 'b1', cwd: '/Users/roy/Development/hyperframes' }
]

function Harness(): React.JSX.Element {
  const [open, setOpen] = useState<{
    label: string
    shared: Pick<RosterAgent, 'work' | 'messages'>
  } | null>(null)
  const session = LIVE.find((s) => s.label === open?.label)
  if (open && session)
    return (
      <SessionDetail
        session={session}
        history={[]}
        onRespond={() => {}}
        shared={open.shared}
        backLabel="Shared work"
        withRail
        onBack={() => setOpen(null)}
      />
    )
  return (
    <CoordinationPanel
      sessions={LIVE}
      onOpenSession={(label, shared) => setOpen({ label, shared })}
    />
  )
}

injectTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>
)
