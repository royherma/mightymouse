// deliver-helper.ts — put the transcript into a running agent.
//
// The second column's delivery, kept apart from deliver.ts because neither
// destination is an app and neither path pastes: a skill SPAWNS a run, an agent
// gets the text written into its pane. Only deliver.ts needs the clipboard, the
// activation dance and the waitForFrontmost guard.
import { showAgentInCodeTab } from '../mighty/mighty-window'
import { devLog } from '../../shared/env'
import { sendToSession } from '../ipc/phone-remote-chat'
import type { AgentSink } from './agent-sinks'
import type { DeliverResult } from './deliver'
import type { VoiceRouteMode } from '../../shared/types'

/**
 * Write the transcript into a running agent's pane and press Enter there.
 *
 * sendPaneText talks to the tmux pane or the shim's pty directly, so this never
 * touches the frontmost window — the wrong-app hazard deliver.ts guards against
 * cannot happen here. 'skipped' means the pane went away between the ranking
 * and the click.
 *
 * mode 'goto' additionally opens that session in the Code window.
 */
export async function deliverToAgent(
  context: string,
  said: string,
  sink: AgentSink,
  mode: VoiceRouteMode,
  screenshotPath: string
): Promise<DeliverResult> {
  if (said === '') return { ok: false, submitted: false }
  try {
    const files = screenshotPath === '' ? [] : [screenshotPath]
    const how = await sendToSession(sink.session, said, files, { context })
    if (mode === 'goto') void goToAgent(sink)
    return { ok: how !== 'skipped', submitted: how !== 'skipped' }
  } catch (err) {
    devLog.warn(`[routing] delivery to agent ${sink.label} failed:`, err)
    return { ok: false, submitted: false }
  }
}

export async function goToAgent(sink: AgentSink): Promise<void> {
  showAgentInCodeTab({ ref: sink.session.sessionId ?? sink.session.label })
}
