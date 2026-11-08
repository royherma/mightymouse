import { randomUUID } from 'crypto'
import { appendFileSync, readFileSync } from 'fs'
import { screen as electronScreen, shell } from 'electron'
import { CONFIG } from '../../../shared/config'
import { IS_DEV, devLog } from '../../../shared/env'
import {
  COMPUTER_USE_ACTION_ID,
  type ActionContextSnapshot,
  type ActionDefinition,
  type ActionRunInput,
  type ActionRunResult,
  type ActionStepPayload,
  type Capability
} from '../../../shared/action-engine'
import * as uiohook from '../../capture/uiohook-manager'
import { VERBS } from '../../intent-router'
import { captureSelection, context, input, pasteText } from '../../platform'
import { PATHS } from '../../store/paths'
import { PREFS } from '../../store/prefs'
import { isCurrentUserAdmin } from '../../auth'
import type { AgentCursorKind, ComputerUseStatus } from '../../../shared/types'
import { driveAgentCursor, hideAgentCursor, showAgentCursor } from './agent-cursor'
import { isSecretField, observeScreen, type Observation } from './observe'
import { decideStep, type StepDecision, type StepKind } from './step-decide'
import { writeText, type WriterResult, type WriterTrail } from './writer'

export interface ComputerUseRequest {
  runId: string
  goal: string
  bundleId: string
  recentApps: readonly string[]
  selection: string
}

type StopReason =
  | 'done'
  | 'yours'
  | 'stuck'
  | 'stopped'
  | 'unsure'
  | 'unchanged'
  | 'circles'
  | 'step-cap'
  | 'time-cap'
  | 'secret'
  | 'handover'
  | 'decide-failed'
  | 'act-failed'

interface ActOutcome {
  ok: boolean
  line: string
  writerMs: number
  writer?: WriterTrail
  actMs: number
  secret?: boolean
}

const VC_ESCAPE = 1
const PRESS_TIMEOUT_MS = 4_000
const SCROLL_DY = 8
const SCROLL_REPEAT = 6
const SCROLL_GAP_MS = 16
const CORNER_POLL_MS = 100
const PAGE_LOAD_SETTLE_FACTOR = 3
const PRESSES: readonly StepKind[] = ['click', 'press_offscreen']
const CHANGES_SCREEN: readonly StepKind[] = [...PRESSES, 'enter']
const CAPABILITY_ID = 'computer'
const RUN_TIMEOUT_MARGIN_MS = 10_000
const NO_CHANGE_NOTE = ' (the screen did not change)'
const REPEAT_NOTE = ' (done before, it did not help)'
const MAY_REPEAT: readonly StepKind[] = ['scroll_down', 'scroll_up', 'wait']
const SCROLLS: readonly StepKind[] = ['scroll_down', 'scroll_up']
const LEAVES: readonly StepKind[] = ['app', 'site']
const HOST_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/

async function openUrl(url: string, bundleId: string): Promise<void> {
  const browsers: readonly string[] = CONFIG.COMPUTER_USE.BROWSER_BUNDLE_IDS
  if (browsers.includes(bundleId)) {
    const { spawnSync } = await import('child_process')
    if (spawnSync('open', ['-b', bundleId, url], { timeout: 5000 }).status === 0) return
  }
  await shell.openExternal(url)
}
const MICROS_PER_USD = 1_000_000
const MAX_REPLACE_CHARS = 2_000
const PASTE_OVER_CHARS = 120
const SHOWN_TEXT_CHARS = 60
const OPENS_SOMETHING: readonly StepKind[] = ['search', 'site', 'app']
const PAUSE_POLL_MS = 100
const PAUSED_LINE = 'Paused'
const CURSOR_KINDS: Partial<Record<StepKind, AgentCursorKind>> = {
  click: 'click',
  press_offscreen: 'click',
  type: 'type'
}

const STOP_LINES: Record<StopReason, string> = {
  done: 'Done',
  yours: 'Over to you - the next part needs your hands',
  stuck: 'Got stuck',
  stopped: 'Stopped',
  unsure: 'Stopped - not sure what to press next',
  unchanged: 'Stopped - the screen stopped changing',
  circles: 'Stopped - it kept repeating the same step',
  'step-cap': 'Stopped - too many steps',
  'time-cap': 'Stopped - took too long',
  secret: 'Over to you - this needs your password',
  handover: 'Over to you - the last press is yours',
  'decide-failed': 'Stopped - could not decide the next step',
  'act-failed': 'Stopped - a step did not work'
}

const NEXT_MOVES: Partial<Record<StopReason, string>> = {
  yours:
    'Drags, right-clicks, double-clicks and sign-ins stay with you. Do that part, then ask for the rest',
  stuck: 'Open the page or app it should work in, then ask again',
  unsure: 'Ask again and name the button or page',
  unchanged: 'Press it yourself, then ask for the rest',
  circles: 'Do that step yourself, then ask for the rest',
  'step-cap': 'Ask for one part at a time',
  'time-cap': 'Ask for one part at a time',
  'decide-failed': 'Check your connection, then ask again',
  'act-failed': 'Do that step yourself, then ask for the rest'
}

const listeners = new Set<(payload: ActionStepPayload) => void>()
const statusListeners = new Set<(status: ComputerUseStatus) => void>()
let activeRunId = ''
let activeStep = 0
let stopRequested = false
let paused = false

export function onComputerUseStatus(cb: (status: ComputerUseStatus) => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
}

function tell(status: ComputerUseStatus): void {
  statusListeners.forEach((cb) => cb(status))
}

export function pauseComputerUse(next: boolean): void {
  if (activeRunId === '' || paused === next) return
  paused = next
  tell({
    state: next ? 'paused' : 'running',
    step: activeStep,
    line: next ? PAUSED_LINE : 'Carrying on'
  })
}

export function logComputerUseQuit(): void {
  if (activeRunId === '') return
  appendLog({
    event: 'run',
    runId: activeRunId,
    outcome: 'stopped',
    stopReason: 'app-quit',
    steps: activeStep
  })
}

// make restart is kill -9, which skips will-quit -- so the missing end row is written on the next launch
export function closeKilledComputerUseRun(): void {
  try {
    const last = readFileSync(PATHS.COMPUTER_USE_LOG, 'utf-8').trimEnd().split('\n').pop() ?? ''
    const row = JSON.parse(last) as { event?: string; runId?: string; step?: number }
    if (row.event !== 'step') return
    appendLog({
      event: 'run',
      runId: row.runId,
      outcome: 'stopped',
      stopReason: 'app-killed',
      steps: row.step
    })
  } catch {
    return
  }
}

function pointAt(decision: StepDecision): void {
  const kind = CURSOR_KINDS[decision.kind]
  const frame = decision.item?.frame
  if (!kind || !frame) return
  const point = { x: Math.round(frame.x + frame.w / 2), y: Math.round(frame.y + frame.h / 2) }
  const onADisplay = electronScreen.getAllDisplays().some(({ bounds: b }) => {
    return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
  })
  if (!onADisplay) return
  driveAgentCursor({ pause: pauseComputerUse, stop: stopComputerUse })
  showAgentCursor({ ...point, kind, label: workingLine(decision) })
}

export function onComputerUseStep(cb: (payload: ActionStepPayload) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function stopComputerUse(): void {
  if (activeRunId !== '') stopRequested = true
}

export function isComputerUseRunning(): boolean {
  return activeRunId !== ''
}

export function needsOwner(label: string, typedThisRun: boolean): boolean {
  const text = label.trim().toLowerCase()
  const hasWord = (words: readonly string[]): boolean =>
    words.some((w) => new RegExp(`(^|[^a-z])${w.replace(/ /g, '\\s+')}`).test(text))
  if (hasWord(CONFIG.COMPUTER_USE.ALWAYS_HAND_OVER)) return true
  return typedThisRun && hasWord(CONFIG.COMPUTER_USE.HAND_OVER_AFTER_TYPING)
}

function workingLine(decision: StepDecision): string {
  const label = decision.item?.label ?? ''
  switch (decision.kind) {
    case 'click':
    case 'press_offscreen':
      return `Pressing ${label}`
    case 'type':
      return `Typing into ${label}`
    case 'enter':
      return 'Pressing Return'
    case 'search':
      return 'Searching the web'
    case 'site':
      return `Opening ${decision.site?.label ?? 'the site'}`
    case 'app':
      return 'Opening the app'
    case 'key':
      return `Pressing ${decision.key?.label ?? 'a shortcut'}`
    case 'selection':
      return 'Rewriting what you selected'
    case 'scroll_down':
      return 'Scrolling down'
    case 'scroll_up':
      return 'Scrolling up'
    case 'wait':
      return 'Waiting for the page'
    default:
      return ''
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function appendLog(row: Record<string, unknown>): void {
  if (PREFS.getIncognito()) return
  try {
    appendFileSync(
      PATHS.COMPUTER_USE_LOG,
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n',
      'utf-8'
    )
  } catch (err) {
    console.error('Failed to append computer-use log row:', err)
  }
}

function appendRecording(row: Record<string, unknown>): void {
  if (!IS_DEV || PREFS.getIncognito()) return
  try {
    appendFileSync(
      PATHS.COMPUTER_USE_RECORDING,
      JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n',
      'utf-8'
    )
  } catch (err) {
    console.error('Failed to append computer-use recording row:', err)
  }
}

function watchForStop(): () => void {
  const releaseHook = uiohook.acquire()
  const offKey = uiohook.on('keydown', (e) => {
    if (e.keycode === VC_ESCAPE) stopRequested = true
  })
  const corner = CONFIG.COMPUTER_USE.STOP_CORNER_PX
  const timer = setInterval(() => {
    const point = electronScreen.getCursorScreenPoint()
    if (point.x <= corner && point.y <= corner) stopRequested = true
  }, CORNER_POLL_MS)
  return () => {
    clearInterval(timer)
    offKey()
    releaseHook()
  }
}

async function scroll(dy: number): Promise<void> {
  for (let i = 0; i < SCROLL_REPEAT; i++) {
    input.scrollFast(dy, 0)
    if (i < SCROLL_REPEAT - 1) await wait(SCROLL_GAP_MS)
  }
}

function shown(text: string): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > SHOWN_TEXT_CHARS ? `${flat.slice(0, SHOWN_TEXT_CHARS)}...` : flat
}

async function putText(text: string): Promise<boolean> {
  if (text.length <= PASTE_OVER_CHARS && !text.includes('\n')) return input.typeText(text)
  await pasteText(text)
  return true
}

async function act(
  decision: StepDecision,
  seen: Observation,
  goal: string,
  history: readonly string[],
  selection: string
): Promise<ActOutcome> {
  const started = Date.now()
  const finish = (
    ok: boolean,
    line: string,
    written?: WriterResult,
    secret = false
  ): ActOutcome => ({
    ok,
    line,
    writerMs: written?.ms ?? 0,
    writer: written?.trail,
    actMs: Date.now() - started - (written?.ms ?? 0),
    secret
  })
  const writerRequest = {
    goal,
    appName: seen.appName,
    windowTitle: seen.windowTitle,
    history
  }

  const needsFront = decision.kind !== 'click' && !OPENS_SOMETHING.includes(decision.kind)
  if (needsFront && !seen.frontIsTarget && seen.bundleId !== '') {
    context.activateApp(seen.bundleId)
    await wait(CONFIG.COMPUTER_USE.SETTLE_MS)
  }

  switch (decision.kind) {
    case 'click':
    case 'press_offscreen': {
      const label = decision.item?.label ?? ''
      const pressed = await context.axPress({
        bundleId: seen.bundleId,
        press: [label],
        timeoutMs: PRESS_TIMEOUT_MS
      })
      const ok =
        pressed.status === 'ok' || pressed.status === 'already' || pressed.status === 'unverified'
      return finish(ok, ok ? `Pressed ${label}` : `Could not press ${label}`)
    }
    case 'type': {
      const field = decision.item
      if (!field) return finish(false, 'No field to type into')
      if (isSecretField(field)) return finish(false, `${field.label} needs you`, undefined, true)

      const focused = await context.axPress({
        bundleId: seen.bundleId,
        press: [field.label],
        timeoutMs: PRESS_TIMEOUT_MS
      })
      if (focused.status === 'not-found' || focused.status === 'not-running') {
        return finish(false, `Could not find ${field.label}`)
      }
      await input.pressKeys(['cmd+a'])
      const there = await captureSelection()
      const replaces = there !== '' && there.length <= MAX_REPLACE_CHARS
      if (there !== '' && !replaces) await input.pressKeys(['right'])
      const written = await writeText({
        ...writerRequest,
        purpose: 'field',
        fieldLabel: field.label,
        existing: replaces ? there : ''
      })
      if (!written.ok) return finish(false, `Nothing to type into ${field.label}`, written)
      const typed = await putText(written.text)
      const verb = replaces ? 'Changed the text to' : 'Typed'
      return finish(typed, typed ? `${verb} "${shown(written.text)}"` : 'Could not type', written)
    }
    case 'selection': {
      const written = await writeText({
        ...writerRequest,
        purpose: 'field',
        fieldLabel: '',
        existing: selection
      })
      if (!written.ok) return finish(false, 'Could not rewrite the selected text', written)
      await pasteText(written.text)
      return finish(true, `Rewrote it as "${shown(written.text)}"`, written)
    }
    case 'key': {
      if (!decision.key) return finish(false, 'No shortcut chosen')
      const ok = await input.pressKeys([decision.key.combo])
      return finish(
        ok,
        ok ? `Pressed ${decision.key.label}` : `Could not press ${decision.key.label}`
      )
    }
    case 'app': {
      const written = await writeText({ ...writerRequest, purpose: 'app', fieldLabel: '' })
      if (!written.ok) return finish(false, 'Could not work out which app', written)
      if (written.text.toLowerCase() === seen.appName.toLowerCase())
        return finish(false, `${seen.appName} is already in front`, written)
      const opened = await VERBS.openApp.run(written.text)
      return finish(
        opened.ok,
        opened.ok ? `Opened ${written.text}` : `Could not find an app called ${written.text}`,
        written
      )
    }
    case 'enter': {
      const ok = await input.pressKeys(['return'])
      return finish(ok, ok ? 'Pressed Return' : 'Could not press Return')
    }
    case 'search': {
      const written = await writeText({ ...writerRequest, purpose: 'search', fieldLabel: '' })
      if (!written.ok) return finish(false, 'Could not write a search', written)
      await openUrl(
        CONFIG.COMPUTER_USE.SEARCH_URL + encodeURIComponent(written.text),
        seen.bundleId
      )
      return finish(true, `Searched "${written.text}"`, written)
    }
    case 'site': {
      if (!decision.site) return finish(false, 'No site chosen')
      if (decision.site.url !== '') {
        await openUrl(decision.site.url, seen.bundleId)
        return finish(true, `Opened ${decision.site.label}`)
      }
      const written = await writeText({ ...writerRequest, purpose: 'site', fieldLabel: '' })
      const host = written.ok ? written.text.toLowerCase().replace(/^https?:\/\//, '') : ''
      if (!HOST_RE.test(host)) return finish(false, 'Could not work out the web address', written)
      await openUrl(`https://${host}`, seen.bundleId)
      return finish(true, `Opened ${host}`, written)
    }
    case 'scroll_down':
      await scroll(-SCROLL_DY)
      return finish(true, 'Scrolled down')
    case 'scroll_up':
      await scroll(SCROLL_DY)
      return finish(true, 'Scrolled up')
    case 'wait':
      await wait(CONFIG.COMPUTER_USE.WAIT_STEP_MS)
      return finish(true, 'Waited for the page')
    default:
      return finish(true, '')
  }
}

export async function runComputerUse(req: ComputerUseRequest): Promise<ActionRunResult> {
  if (activeRunId !== '') return { ok: false, line: 'Already doing something - stop that first.' }

  const cuRunId = randomUUID()
  activeRunId = cuRunId
  activeStep = 0
  stopRequested = false
  paused = false
  const unwatch = watchForStop()

  const cfg = CONFIG.COMPUTER_USE
  const started = Date.now()
  const history: string[] = []
  let bundleId = req.bundleId
  let steps = 0
  let jevCalls = 0
  let writerCalls = 0
  let inputTokens = 0
  let writerChargedCents = 0
  let writerCostMicros = 0
  let scrollsUsed = 0
  let selection = req.selection.slice(0, MAX_REPLACE_CHARS)
  let unchanged = 0
  let failedActs = 0
  let failedLine = ''
  let lastKind: StepKind | null = null
  let lastKindRun = 0
  let lastFingerprint = ''
  const timesDone = new Map<string, number>()
  let handoverLabel = ''
  let reason: StopReason = 'step-cap'

  const outOfTime = (): boolean => Date.now() - started > cfg.MAX_RUN_MS
  // A pause does not stretch the run: the caller's timeout keeps counting, and a run that outlives it keeps pressing after the panel said it timed out.
  const holdWhilePaused = async (): Promise<void> => {
    while (paused && !stopRequested && !outOfTime()) await wait(PAUSE_POLL_MS)
  }

  try {
    for (let step = 1; step <= cfg.MAX_STEPS; step++) {
      activeStep = step
      await holdWhilePaused()
      if (stopRequested) {
        reason = 'stopped'
        break
      }
      if (outOfTime()) {
        reason = 'time-cap'
        break
      }

      const stepStarted = Date.now()
      const emit = (line: string, pending: boolean, ms?: number): void => {
        const payload: ActionStepPayload = { runId: req.runId, step, line, pending, ms }
        listeners.forEach((cb) => cb(payload))
        tell({ state: paused ? 'paused' : 'running', step, line: paused ? PAUSED_LINE : line })
      }
      emit('Reading the screen', true)
      const seen = await observeScreen(req.goal, [bundleId, req.bundleId, ...req.recentApps])
      if (seen.bundleId !== '') bundleId = seen.bundleId
      const observeMs = Date.now() - stepStarted

      if (lastKind !== null && CHANGES_SCREEN.includes(lastKind)) {
        unchanged = seen.fingerprint === lastFingerprint ? unchanged + 1 : 0
        if (seen.fingerprint === lastFingerprint && history.length > 0) {
          if (!history[history.length - 1].endsWith(NO_CHANGE_NOTE))
            history[history.length - 1] += NO_CHANGE_NOTE
        }
        if (unchanged >= cfg.MAX_UNCHANGED_STEPS) {
          reason = 'unchanged'
          break
        }
      }
      lastFingerprint = seen.fingerprint

      const progress = { step, lastKind, lastKindRun, scrollsUsed, hasSelection: selection !== '' }
      let decided = await decideStep(req.goal, seen, history, progress)
      jevCalls++
      if ('failure' in decided && !stopRequested) {
        decided = await decideStep(req.goal, seen, history, progress)
        jevCalls++
      }
      if ('failure' in decided) {
        devLog.log('[computer-use]', cuRunId, 'decide failed:', decided.failure)
        appendLog({
          event: 'step',
          runId: cuRunId,
          step,
          kind: 'decide-failed',
          failure: decided.failure,
          observeMs
        })
        reason = 'decide-failed'
        break
      }
      const decision = decided
      inputTokens += decision.inputTokens

      await holdWhilePaused()
      if (stopRequested) {
        reason = 'stopped'
        break
      }
      if (paused && outOfTime()) {
        reason = 'time-cap'
        break
      }
      if (decision.kind === 'done' || decision.kind === 'yours' || decision.kind === 'stuck') {
        reason = decision.kind
      } else if (
        decision.confidence < cfg.MIN_CONFIDENCE_OVER_CHANCE / decision.kindCount ||
        (LEAVES.includes(decision.kind) && decision.confidence < cfg.MIN_CONFIDENCE_TO_LEAVE)
      ) {
        reason = 'unsure'
      } else if (
        PRESSES.includes(decision.kind) &&
        needsOwner(decision.item?.label ?? '', writerCalls > 0)
      ) {
        reason = 'handover'
        handoverLabel = decision.item?.label ?? ''
      }

      const terminal =
        reason === 'done' ||
        reason === 'yours' ||
        reason === 'stuck' ||
        reason === 'unsure' ||
        reason === 'handover'
      if (!terminal) {
        emit(workingLine(decision), true)
        pointAt(decision)
      }
      const outcome = terminal
        ? { ok: true, line: '', writerMs: 0, actMs: 0 }
        : await act(decision, seen, req.goal, history, selection)
      if (decision.kind === 'selection') selection = ''
      if (outcome.writerMs > 0) writerCalls++
      writerChargedCents += outcome.writer?.chargedCents ?? 0
      writerCostMicros += outcome.writer?.costUsdMicros ?? 0
      if (SCROLLS.includes(decision.kind)) scrollsUsed++

      appendLog({
        event: 'step',
        runId: cuRunId,
        step,
        kind: decision.kind,
        role: decision.item?.role ?? '',
        confidence: decision.confidence,
        itemConfidence: decision.itemConfidence,
        ok: outcome.ok,
        observeMs,
        frontMs: seen.frontMs,
        axMs: seen.axMs,
        decideMs: decision.latencyMs,
        decideServerMs: decision.serverMs,
        decideJevMs: decision.jevMs,
        writerMs: outcome.writerMs,
        writerHeadersMs: outcome.writer?.headersMs ?? 0,
        writerFirstTextMs: outcome.writer?.firstTextMs ?? 0,
        writerServerPreMs: outcome.writer?.serverPreMs ?? 0,
        writerChargedCents: outcome.writer?.chargedCents ?? 0,
        actMs: outcome.actMs,
        totalMs: Date.now() - stepStarted,
        inputTokens: decision.inputTokens,
        pressables: seen.pressables.length,
        offscreen: seen.offscreen.length,
        fields: seen.fields.length,
        app: seen.bundleId
      })
      appendRecording({
        event: 'recording',
        runId: cuRunId,
        step,
        goal: req.goal,
        history: [...history],
        seen,
        decision,
        ok: outcome.ok,
        line: outcome.line
      })
      devLog.log(
        '[computer-use]',
        cuRunId,
        step,
        decision.kind,
        decision.confidence.toFixed(2),
        outcome.line
      )

      if (terminal) break

      const stepKey =
        decision.kind === 'type'
          ? `type:${decision.item?.label ?? ''}`
          : `${decision.item?.role ?? ''}:${outcome.line}`
      const count = MAY_REPEAT.includes(decision.kind) ? 1 : (timesDone.get(stepKey) ?? 0) + 1
      timesDone.set(stepKey, count)

      steps = step
      history.push(`${step}. ${outcome.line}${count > 1 ? REPEAT_NOTE : ''}`)
      emit(outcome.line, false, Date.now() - stepStarted)

      // A live page (X, a feed) never hashes the same twice, so the fingerprint check alone let one button be pressed 4x in a row.
      if (count >= cfg.MAX_SAME_STEP) {
        reason = 'circles'
        break
      }

      if (outcome.secret) {
        reason = 'secret'
        break
      }
      failedActs = outcome.ok ? 0 : failedActs + 1
      if (!outcome.ok) failedLine = outcome.line
      if (failedActs >= cfg.MAX_UNCHANGED_STEPS) {
        reason = 'act-failed'
        break
      }

      lastKindRun = decision.kind === lastKind ? lastKindRun + 1 : 1
      lastKind = decision.kind
      const opensPage = OPENS_SOMETHING.includes(decision.kind)
      await wait(opensPage ? cfg.SETTLE_MS * PAGE_LOAD_SETTLE_FACTOR : cfg.SETTLE_MS)
    }
  } finally {
    unwatch()
    hideAgentCursor()
    activeRunId = ''
    stopRequested = false
    paused = false
  }

  const seconds = (Date.now() - started) / 1000
  const jevCostUsd = (inputTokens / MICROS_PER_USD) * cfg.JEV_USD_PER_M_INPUT_TOKENS
  const costUsd = jevCostUsd + writerCostMicros / MICROS_PER_USD
  const front = await context.readFrontmostScreen().catch(() => null)
  appendLog({
    event: 'run',
    runId: cuRunId,
    outcome: reason === 'done' ? 'done' : 'stopped',
    stopReason: reason,
    steps,
    seconds: Number(seconds.toFixed(2)),
    jevCalls,
    writerCalls,
    inputTokens,
    writerChargedCents,
    writerCostMicros,
    jevCostUsd: Number(jevCostUsd.toFixed(6)),
    costUsd: Number(costUsd.toFixed(6)),
    goalChars: req.goal.length
  })

  const stepWord = steps === 1 ? 'step' : 'steps'
  const stopLine =
    reason === 'handover'
      ? `Over to you - press ${handoverLabel} yourself`
      : reason === 'act-failed' && failedLine !== ''
        ? `Stopped - ${failedLine}`
        : STOP_LINES[reason]
  const line = `${stopLine} - ${steps} ${stepWord}, ${seconds.toFixed(1)} s`
  tell({ state: 'ended', step: steps, line, detail: NEXT_MOVES[reason] })
  return {
    ok: reason === 'done' || reason === 'handover' || reason === 'yours',
    line,
    detail: [
      NEXT_MOVES[reason] ?? '',
      front?.title ? `Now open: ${front.title}` : '',
      `${inputTokens.toLocaleString('en-US')} tokens`,
      `$${costUsd.toFixed(5)}`
    ]
      .filter((part) => part !== '')
      .join(' - ')
  }
}

function computerUseAction(ctx: ActionContextSnapshot): ActionDefinition {
  return {
    id: COMPUTER_USE_ACTION_ID,
    capabilityId: CAPABILITY_ID,
    title: 'Do it for me',
    when:
      'The user asks for a task that takes SEVERAL steps on the computer to finish - finding and downloading something, ' +
      'searching and then opening a result, filling in a form, going somewhere and then doing something there, ' +
      'opening an app or a site AND THEN doing something in it ("open Notes and write a list"), changing text that is already written. ' +
      'NOT for a single command with nothing after it, such as only opening one app or one site, pressing one button, scrolling or typing, ' +
      'and NOT when the user is dictating text or asking a question.',
    icon: 'bot',
    runKind: 'builtin',
    safety: 'confirm',
    triggers: ['voice', 'phone'],
    slots: [{ kind: 'transcript', key: 'goal', label: 'Task' }],
    timeoutMs: CONFIG.COMPUTER_USE.MAX_RUN_MS + RUN_TIMEOUT_MARGIN_MS,
    run(runInput: ActionRunInput): Promise<ActionRunResult> {
      return runComputerUse({
        runId: runInput.runId ?? '',
        goal: runInput.transcript,
        bundleId: ctx.bundleId,
        recentApps: ctx.recentApps,
        selection: runInput.selection
      })
    }
  }
}

export const computerUseCapability: Capability = {
  id: CAPABILITY_ID,
  title: 'Do it for me',
  blurb: 'Say a whole task - find it, open it, download it - and watch it get done step by step.',
  icon: 'bot',
  source: 'builtin',
  async listActions(ctx: ActionContextSnapshot): Promise<ActionDefinition[]> {
    if (!(await isCurrentUserAdmin())) return []
    return [computerUseAction(ctx)]
  }
}
