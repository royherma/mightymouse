import { CONFIG } from '../../shared/config'
import { ACTION_PREFS } from '../store/action-prefs'
import { acquire, on } from '../capture/uiohook-manager'
import { appendActionDecision } from './action-log'
import { contextChangedSince } from './context-window'

const CHECK_INTERVAL_MS = 500

type OnFire = () => Promise<boolean>

let running = false
let release: (() => void) | null = null
let unsubMove: (() => void) | null = null
let unsubKey: (() => void) | null = null
let timer: NodeJS.Timeout | null = null
let onFire: OnFire | null = null

let lastMouseAt = Date.now()
let lastKeyAt = Date.now()
let lastFireOrStartAt = Date.now()
let lastFireAt = 0
let firing = false
let armed = true
let skippedThisStillPeriod = false

function logSkip(reason: string): void {
  if (skippedThisStillPeriod) return
  skippedThisStillPeriod = true
  appendActionDecision({
    runId: '',
    trigger: 'idle',
    transcript: '',
    context: {
      frontApp: '',
      bundleId: '',
      windowTitle: '',
      urlHost: '',
      hasSelection: false,
      selectionText: '',
      selectionKind: 'none',
      recentApps: [],
      recentActionIds: []
    },
    offered: [],
    topActionId: '',
    slots: {},
    isCommand: false,
    latencyMs: 0,
    via: 'direct',
    inputTokens: 0,
    skipped: reason
  })
}

async function tick(): Promise<void> {
  if (!armed || firing) return

  const now = Date.now()
  const mouseIdleMs = now - lastMouseAt
  const keyIdleMs = now - lastKeyAt

  if (mouseIdleMs < CONFIG.ACTIONS.IDLE_MOUSE_MS) return
  if (keyIdleMs < CONFIG.ACTIONS.IDLE_KEYBOARD_MS) return

  if (!ACTION_PREFS.getEnabled()) {
    logSkip('actions-disabled')
    return
  }
  if (!ACTION_PREFS.getIdleEnabled()) {
    logSkip('idle-disabled')
    return
  }
  if (!contextChangedSince(lastFireOrStartAt)) {
    logSkip('no-context-change')
    return
  }
  if (now - lastFireAt < CONFIG.ACTIONS.IDLE_COOLDOWN_MS) {
    logSkip('cooldown')
    return
  }

  skippedThisStillPeriod = false
  armed = false
  firing = true
  try {
    const shown = onFire ? await onFire() : false
    if (shown) {
      lastFireAt = Date.now()
      lastFireOrStartAt = lastFireAt
    }
  } finally {
    firing = false
  }
}

export function startIdleTrigger(fire: OnFire): void {
  if (running) return
  running = true
  onFire = fire
  lastMouseAt = Date.now()
  lastKeyAt = Date.now()
  lastFireOrStartAt = lastMouseAt
  armed = true
  skippedThisStillPeriod = false

  unsubMove = on('mousemove', () => {
    lastMouseAt = Date.now()
    armed = true
    skippedThisStillPeriod = false
  })
  unsubKey = on('keydown', () => {
    lastKeyAt = Date.now()
    armed = true
    skippedThisStillPeriod = false
  })
  release = acquire()
  timer = setInterval(() => {
    void tick()
  }, CHECK_INTERVAL_MS)
}

export function stopIdleTrigger(): void {
  if (!running) return
  running = false
  onFire = null
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  unsubMove?.()
  unsubMove = null
  unsubKey?.()
  unsubKey = null
  release?.()
  release = null
}

export function isIdleTriggerRunning(): boolean {
  return running
}
