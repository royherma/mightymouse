// Registration is wired by index.ts, not here.
import { ipcMain, shell, type IpcMainEvent } from 'electron'
import { CHANNELS } from '../../shared/ipc'
import type { ActionsConfigPatch } from '../../shared/action-engine'
import type { ComputerUseCommand } from '../../shared/types'
import { PATHS } from '../store/paths'
import { ACTION_PREFS } from '../store/action-prefs'
import { getSession } from '../auth'
import { describeCapabilities } from '../actions/registry'
import { runProposal, dismissProposal, setProposalSlot } from '../actions/engine'
import type { ActionsConfig } from '../../shared/action-engine'
import { markRouteDelivered } from './voice-routing'
import { sendActionResultToCard } from '../voice-route-window'
import {
  onComputerUseStatus,
  onComputerUseStep,
  closeKilledComputerUseRun,
  pauseComputerUse,
  stopComputerUse
} from '../actions/computer-use/loop'
import { hideStatusBox, markRunOutcome, showStatusBox } from '../actions/computer-use/status-box'
import { isComputerUseRunning } from '../actions/computer-use/loop'

async function readConfig(): Promise<ActionsConfig> {
  const [session, capabilities] = await Promise.all([getSession(), describeCapabilities()])
  return {
    enabled: ACTION_PREFS.getEnabled(),
    idleEnabled: ACTION_PREFS.getIdleEnabled(),
    signedIn: session !== null,
    pluginsDir: PATHS.ACTION_PLUGINS_DIR,
    capabilities
  }
}

let lastRun: { runId: string; proposalId: string } | null = null

export function runAndTrack(payload: { runId: string; proposalId: string }, event?: IpcMainEvent): void {
  lastRun = payload
  const offStep = onComputerUseStep((step) => {
    if (step.runId === payload.runId && event && !event.sender.isDestroyed()) {
      event.sender.send(CHANNELS.actionStep, step)
    }
  })
  void runProposal(payload.runId, payload.proposalId).then((result) => {
    offStep()
    markRunOutcome(result.ok)
    if (result.ok) markRouteDelivered(payload.runId)
    if (event && !event.sender.isDestroyed()) event.sender.send(CHANNELS.actionResult, result)
    // No event = the ⌘⌥⇧1/2/3 chord or the computer-use retry started this, so
    // there is no clicking renderer to answer; the card still has to stop
    // saying "Doing it…".
    else sendActionResultToCard(result)
  })
}

export function registerActionsIpc(): void {
  ipcMain.on(CHANNELS.actionRun, (event, payload: { runId: string; proposalId: string }) => {
    runAndTrack(payload, event)
  })

  ipcMain.on(
    CHANNELS.actionSetSlot,
    (_, payload: { runId: string; proposalId: string; slotKey: string; value: string }) => {
      setProposalSlot(payload.runId, payload.proposalId, payload.slotKey, payload.value)
    }
  )

  ipcMain.on(CHANNELS.actionStop, () => stopComputerUse())

  closeKilledComputerUseRun()
  onComputerUseStatus(showStatusBox)
  ipcMain.on(CHANNELS.computerUseControl, (_, command: ComputerUseCommand) => {
    if (command === 'pause' || command === 'resume') pauseComputerUse(command === 'pause')
    else if (command === 'retry') {
      if (lastRun && !isComputerUseRunning()) runAndTrack(lastRun)
      return
    } else stopComputerUse()
    if (command === 'close') hideStatusBox()
  })

  ipcMain.on(CHANNELS.actionDismiss, (_, payload: { runId: string; proposalId: string }) => {
    dismissProposal(payload.runId, payload.proposalId)
  })

  ipcMain.handle(CHANNELS.actionsConfigGet, () => readConfig())

  ipcMain.handle(CHANNELS.actionsConfigSet, async (_, patch: ActionsConfigPatch) => {
    if (patch.enabled !== undefined) ACTION_PREFS.setEnabled(patch.enabled)
    if (patch.idleEnabled !== undefined) ACTION_PREFS.setIdleEnabled(patch.idleEnabled)
    if (patch.capability)
      ACTION_PREFS.setCapabilityEnabled(patch.capability.id, patch.capability.enabled)
    return readConfig()
  })

  ipcMain.handle(CHANNELS.actionsOpenPluginsFolder, async () => {
    await shell.openPath(PATHS.ACTION_PLUGINS_DIR)
  })
}
