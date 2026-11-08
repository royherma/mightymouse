// voice-route-window.ts — the card that asks "where should this go?".
//
// It is a SEPARATE window beside the HUD stack rather than a card inside it:
// the HUD stack is keyed by runId and owns dismiss/auto-fade timing for capture
// results, and routing has its own lifetime (it lives until you pick a
// destination).
import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { CHANNELS } from '../shared/ipc'
import type { ActionCardPayload, ActionResultPayload } from '../shared/action-engine'
import type {
  VoiceRoutePayload,
  VoiceRoutePendingPayload,
  VoiceRouteEnhancePayload,
  VoiceRouteResultPayload
} from '../shared/types'
import { hudStackLeftEdge } from './hud-window'
import { PREFS } from './store/prefs'
import { currentForeignFrontmostBundleId } from './platform/macos/frontmost-watch'
import { activateApp } from './platform/macos/activate-app'
import { chrome } from './platform'

// Opening width. 560 was sized for three columns of names side by side, where
// each row got a third of it and truncated to "/adsinagents…". Stacked, a row
// owns the full width, so the same names fit in far less card.
const CARD_W_DEFAULT = 480

/** Hard floor/ceiling on the user's dragged width. The ceiling is the work area
 *  itself, applied at position() time, since a card wider than the screen would
 *  hang off the edge it is anchored to. */
const CARD_W_MIN = 360
// Collapsed: the transcript line + three destination rows. The renderer measures
// its real height and calls back, so this is only the opening size.
const CARD_H = 150
// Must match --hud-overhang in index.css: the window is bigger than the card on
// all four sides so the CSS shadow has somewhere to land.
const CHIP_GUTTER = 13

// Room left of the card for the hover tip. The window is non-resizable while
// open, so it must carry this width whether or not a tip is showing.
// Must match .vroute-shell's padding-left in index.css.
const TIP_GUTTER = 264

// Beside the HUD column and a step down, never under it: a spot that depends on
// the stack's height made the card jump every time a HUD card came or went.
const BESIDE_GAP = 16
const BESIDE_TOP = 58

let dragOffset = { x: 0, y: 0 }

type CardPayload = VoiceRoutePendingPayload | VoiceRoutePayload | ActionCardPayload | ActionResultPayload

interface RouteCard {
  window: BrowserWindow
  runId: string
  height: number
  width: number
  ready: boolean
  /** Payload that arrived before the renderer mounted, flushed on ready. Either
   *  kind: the card now opens on a pending payload and the ranked one lands on
   *  the same window a second or two later, so both can beat the mount. */
  queued: Array<{ channel: string; payload: CardPayload }>
}

let card: RouteCard | null = null

// Built once and reused. Creating it on demand cost 2118ms to ready-to-show
// (measured), which the user saw as a dead click before the skeleton appeared.
let warm: BrowserWindow | null = null
let warmReady = false

function buildWindow(): BrowserWindow {
  const startWidth = Math.max(CARD_W_MIN, PREFS.getVoiceRoutingCardWidth() || CARD_W_DEFAULT)
  const win = new BrowserWindow({
    ...chrome.windowOptions('panel'),
    roundedCorners: false,
    width: startWidth + CHIP_GUTTER * 2 + TIP_GUTTER,
    height: CARD_H + CHIP_GUTTER * 2,
    frame: false,
    // Sizes below mean the WEB VIEWPORT, not the outer frame. Without this a
    // 502px setBounds gave the renderer only 458px, so the last 44px of the
    // card - measured and asked for - was clipped by body{overflow:hidden}.
    useContentSize: true,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    // Non-focusable for the same reason every HUD card is: appearing must not
    // pull focus off the app you are dictating into, or the paste loses its
    // target. It gets NO keydown, so Esc is handled globally in capture-hotkey.ts.
    focusable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('blur', () => {
    if (!win.isFocusable()) return
    win.setFocusable(false)
    focusedFrom = ''
  })

  // No runId in the query: the renderer takes it from every payload, so one
  // window serves every run and never needs reloading.
  const query = { window: 'voice-route' }
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${new URLSearchParams(query)}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
  return win
}

/** Build the card's window at startup so the first tap has nothing to wait for. */
export function prewarmVoiceRouteWindow(): void {
  if (warm && !warm.isDestroyed()) return
  warmReady = false
  const win = buildWindow()
  warm = win
  win.once('ready-to-show', () => {
    if (warm !== win) return
    warmReady = true
    if (card && card.window === win && !card.ready) flushQueue()
  })
}

function flushQueue(): void {
  if (!card || card.window.isDestroyed()) return
  card.ready = true
  card.window.showInactive()
  for (const held of card.queued) card.window.webContents.send(held.channel, held.payload)
  card.queued = []
}

/** Called with the runId of any card that goes away without the user picking a
 *  destination, so the transcript it was holding still reaches the user. Set by
 *  the IPC module; a direct import would be a cycle. */
let abandonListener: ((runId: string) => void) | null = null

export function setVoiceRouteAbandonListener(cb: ((runId: string) => void) | null): void {
  abandonListener = cb
}

function position(): void {
  if (!card || card.window.isDestroyed()) return
  const area = screen.getPrimaryDisplay().workArea
  const maxW = area.width - CHIP_GUTTER * 2 - TIP_GUTTER
  const width = Math.min(card.width, maxW)
  const homeX = hudStackLeftEdge() - BESIDE_GAP - width
  const homeY = area.y + BESIDE_TOP
  const cardX = clamp(homeX + dragOffset.x, area.x, area.x + area.width - width)
  const cardY = clamp(homeY + dragOffset.y, area.y, area.y + area.height - card.height)
  dragOffset = { x: cardX - homeX, y: cardY - homeY }
  // setContentBounds, not setBounds: useContentSize only governs the
  // constructor, so a later setBounds would go back to sizing the outer frame
  // and re-crop the bottom of the card.
  card.window.setContentBounds({
    x: Math.floor(cardX) - CHIP_GUTTER - TIP_GUTTER,
    y: Math.floor(cardY) - CHIP_GUTTER,
    width: width + CHIP_GUTTER * 2 + TIP_GUTTER,
    height: card.height + CHIP_GUTTER * 2
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function moveVoiceRouteCard(runId: string, dx: number, dy: number): void {
  if (!card || card.runId !== runId) return
  dragOffset = { x: dragOffset.x + dx, y: dragOffset.y + dy }
  position()
}

/** Widen/narrow to the width the user dragged to. Persisted so the next card
 *  opens at the size they chose rather than snapping back to the default. */
export function setVoiceRouteWidth(runId: string, width: number): void {
  if (!card || card.runId !== runId) return
  const next = Math.max(CARD_W_MIN, Math.round(width))
  if (next === card.width) return
  card.width = next
  PREFS.setVoiceRoutingCardWidth(next)
  position()
}

/** Grow/shrink to the renderer's measured height (it expands on hover). Capped
 *  to the work area: a card taller than the screen was drawn past the bottom
 *  edge and its last rows were simply gone. At the cap the renderer scrolls its
 *  own rows instead, so the bottom of the card is always on screen. */
export function setVoiceRouteHeight(runId: string, height: number): void {
  if (!card || card.runId !== runId) return
  const area = screen.getPrimaryDisplay().workArea
  const maxH = area.height - BESIDE_TOP - CHIP_GUTTER * 2
  const next = Math.min(Math.round(height) - CHIP_GUTTER * 2, maxH)
  if (next <= 0 || Math.abs(next - card.height) < 1) return
  card.height = next
  position()
}

/** Push to the renderer, or hold it until the renderer mounts. */
function sendOrQueue(channel: string, payload: CardPayload): void {
  if (!card || card.window.isDestroyed()) return
  if (card.ready) card.window.webContents.send(channel, payload)
  else card.queued.push({ channel, payload })
}

/**
 * The ranked destinations, into the card that is already on screen. Opens one
 * first if there isn't (routing that never went through openVoiceRouteCard).
 */
export function showVoiceRouteCard(payload: VoiceRoutePayload): void {
  if (card && card.runId === payload.runId) {
    sendOrQueue(CHANNELS.voiceRouteInit, payload)
    return
  }
  openVoiceRouteCard({ runId: payload.runId, preview: payload.preview, bands: [] })
  sendOrQueue(CHANNELS.voiceRouteInit, payload)
}

/**
 * Put the card up NOW, holding only the words being routed. Ranking takes 1-3s
 * and used to be spent with nothing on screen at all, which read as the click
 * doing nothing; the card opens on a skeleton instead and fills in when
 * showVoiceRouteCard lands the real rows.
 */
export function openVoiceRouteCard(payload: VoiceRoutePendingPayload): void {
  // A second recording replaces the first card. The transcript that card was
  // holding is still undelivered, so it falls back to the plain paste rather
  // than disappearing with the window.
  const replaced = card?.runId ?? ''
  closeVoiceRouteCard()
  if (replaced !== '' && replaced !== payload.runId) abandonListener?.(replaced)

  prewarmVoiceRouteWindow()
  const win = warm as BrowserWindow
  const startWidth = Math.max(CARD_W_MIN, PREFS.getVoiceRoutingCardWidth() || CARD_W_DEFAULT)

  card = {
    window: win,
    runId: payload.runId,
    height: CARD_H,
    width: startWidth,
    ready: false,
    queued: [{ channel: CHANNELS.voiceRoutePending, payload }]
  }

  position()
  // showInactive, never show(): show() would activate our app and steal the
  // focus the paste depends on.
  if (warmReady) flushQueue()
}

export function sendActionCard(payload: ActionCardPayload): void {
  if (!card || card.runId !== payload.runId) {
    console.log(
      `[actions] ${payload.runId} drop at window: card=${card ? card.runId : 'closed'}`
    )
    return
  }
  sendOrQueue(CHANNELS.actionCardShow, payload)
}

/** ⌘⌥⇧ went down or up: the card numbers its rows while they are held, which is
 *  the only way the chord keys are discoverable on a window that gets no keys. */
export function sendActionChordMods(held: boolean): void {
  if (!card || card.window.isDestroyed() || !card.ready) return
  card.window.webContents.send(CHANNELS.actionChordMods, held)
}

// A run started by the ⌘⌥⇧1/2/3 chord has no clicking renderer to reply to, so
// its outcome reaches the card through the window instead of event.sender.
export function sendActionResultToCard(payload: ActionResultPayload): void {
  if (!card || card.runId !== payload.runId) return
  sendOrQueue(CHANNELS.actionResult, payload)
}

export function sendVoiceRouteResult(payload: VoiceRouteResultPayload): void {
  if (!card || card.runId !== payload.runId || card.window.isDestroyed()) return
  card.window.webContents.send(CHANNELS.voiceRouteResult, payload)
}

export function sendVoiceRouteEnhanced(payload: VoiceRouteEnhancePayload): void {
  if (!card || card.runId !== payload.runId || card.window.isDestroyed()) return
  card.window.webContents.send(CHANNELS.voiceRouteEnhanced, payload)
}

let focusedFrom = ''

export function openVoiceRouteSearch(): boolean {
  if (!card || !card.ready || card.window.isDestroyed()) return false
  card.window.webContents.send(CHANNELS.voiceRouteSearchOpen)
  return true
}

/** The card is non-focusable so it never steals a paste target; typing a search is the one time it must take keys. */
export function setVoiceRouteSearchFocus(runId: string, on: boolean): void {
  if (!card || card.runId !== runId || card.window.isDestroyed()) return
  const win = card.window
  if (on) {
    if (win.isFocused()) return
    focusedFrom = currentForeignFrontmostBundleId()
    win.setFocusable(true)
    app.focus({ steal: true })
    win.focus()
    return
  }
  releaseFocus(win)
}

function releaseFocus(win: BrowserWindow): void {
  if (!win.isFocusable()) return
  win.setFocusable(false)
  const back = focusedFrom
  focusedFrom = ''
  if (back !== '') activateApp(back)
}

export function voiceRouteSearchActive(): boolean {
  return card !== null && !card.window.isDestroyed() && card.window.isFocused()
}

export function closeVoiceRouteCard(): void {
  if (!card) return
  if (!card.window.isDestroyed()) releaseFocus(card.window)
  closedAt = Date.now()
  const win = card.window
  card = null
  if (win.isDestroyed()) return
  win.hide()
  // Hidden, not destroyed, so the next tap has a warm window. The renderer keeps
  // its state across runs, so it has to be told to clear or the next open flashes
  // the previous card.
  win.webContents.send(CHANNELS.voiceRouteReset)
}

export function voiceRouteRunId(): string {
  return card?.runId ?? ''
}

let closedAt = 0
// 600ms — did-become-active fires BEFORE the close and its guard runs 150ms
// later, so a window shorter than that settle sees the card already gone.
const CLOSE_ECHO_MS = 600

/** The routing card is up, or just went away under the click that closed it:
 *  either way the user is mid-flow and did not ask for the panel. */
export function voiceRouteCardOpen(): boolean {
  if (Date.now() - closedAt < CLOSE_ECHO_MS) return true
  return card !== null && !card.window.isDestroyed() && card.window.isVisible()
}
