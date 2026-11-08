import { useCallback, useEffect, useEffectEvent, useReducer } from 'react'
import type { LinkTarget } from '../../../shared/types'
import { CONFIG } from '../../../shared/config'

export type RailMode = 'details' | 'browser'

export const RAIL_BROWSER_EVENT = 'mm:rail-browser'
export const CLOSE_PANEL_EVENT = 'mm:close-panel'
const RAIL_URL_EVENT = 'mm:rail-url'
export const RAIL_PANEL = 'rail'
export const UNSAVED_PREFIX = 'unsaved:'

const draftKeys = new Map<string, string>()

export function draftBrowserKey(scope: string): string {
  let key = draftKeys.get(scope)
  if (!key) draftKeys.set(scope, (key = UNSAVED_PREFIX + crypto.randomUUID()))
  return key
}

export function releaseDraftBrowserKey(scope: string): void {
  draftKeys.delete(scope)
}
const CLOSES = '[data-closes]'
const TOUCH_EVENTS = ['pointerover', 'pointerdown', 'focusin', 'keydown'] as const

let railHosts = 0
let pendingUrl: string | null = null
let pendingNewTab = false

const MODE_PREFIX = 'mm.sideBrowserMode.'
const modes = new Map<string, RailMode>()

function savedMode(conversationKey: string): RailMode {
  try {
    return localStorage.getItem(MODE_PREFIX + conversationKey) === 'browser' ? 'browser' : 'details'
  } catch {
    return 'details'
  }
}

export function useRailMode(conversationKey: string): [RailMode, (mode: RailMode) => void] {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const mode = modes.get(conversationKey) ?? savedMode(conversationKey)
  const setMode = useCallback(
    (next: RailMode) => {
      modes.set(conversationKey, next)
      try {
        localStorage.setItem(MODE_PREFIX + conversationKey, next)
      } catch {
        // Storage blocked: the choice still holds until the app restarts.
      }
      rerender()
    },
    [conversationKey]
  )
  return [mode, setMode]
}

// ⌘T asks the visible rail to show the browser without replacing the panel.
export function useRailBrowserShortcut(active: boolean, open: () => void): void {
  useEffect(() => {
    if (!active) return
    const onOpen = (): void => open()
    if (pendingUrl) onOpen()
    window.addEventListener(RAIL_BROWSER_EVENT, onOpen)
    return () => window.removeEventListener(RAIL_BROWSER_EVENT, onOpen)
  }, [active, open])
}

export function useRailHost(showBrowser: () => void): void {
  useEffect(() => {
    railHosts++
    window.addEventListener(RAIL_URL_EVENT, showBrowser)
    const takeAgentUrl = (): void =>
      void window.api.sideBrowser.takeUrl().then((url) => url && openInRail(url))
    takeAgentUrl()
    const offOpenUrl = window.api.sideBrowser.onOpenUrl(takeAgentUrl)
    return () => {
      railHosts--
      window.removeEventListener(RAIL_URL_EVENT, showBrowser)
      offOpenUrl()
    }
  }, [showBrowser])
}

export function useCloseKey(closeRail: () => void): void {
  const onCloseRail = useEffectEvent(closeRail)
  useEffect(() => {
    let touched: Element | null = null
    const track = (e: Event): void => {
      if (e.type === 'keydown' && (e as KeyboardEvent).metaKey) return
      touched = (e.target as Element).closest?.(CLOSES) ?? touched
    }
    const showing = (el: Element): boolean => el.getClientRects().length > 0
    const off = window.api.sideBrowser.onShortcut(({ viewId, shortcut }) => {
      if (viewId || shortcut !== 'closeTab') return
      const target =
        touched && showing(touched)
          ? touched
          : [...document.querySelectorAll(`${CLOSES}[data-focused="true"]`)].find(showing)
      if (!target) return
      const taken = !target.dispatchEvent(new Event(CLOSE_PANEL_EVENT, { bubbles: true, cancelable: true }))
      if (!taken && (target as HTMLElement).dataset.closes === RAIL_PANEL) onCloseRail()
    })
    for (const type of TOUCH_EVENTS) window.addEventListener(type, track, true)
    return () => {
      off()
      for (const type of TOUCH_EVENTS) window.removeEventListener(type, track, true)
    }
  }, [])
}

export function openInRail(url: string): boolean {
  if (!railHosts) return false
  pendingUrl = url
  window.dispatchEvent(new Event(RAIL_URL_EVENT))
  return true
}

export function fileUrl(path: string): string {
  return 'file://' + encodeURI(path)
}

export function openFileInRail(path: string): boolean {
  return openInRail(fileUrl(path))
}

export function requestRailTab(): void {
  pendingNewTab = true
}

export function takeRailTabRequest(): boolean {
  const asked = pendingNewTab
  pendingNewTab = false
  return asked
}

export function takeRailUrl(): string | null {
  const url = pendingUrl
  pendingUrl = null
  return url
}

export function hasRail(): boolean {
  return railHosts > 0
}

let linkTarget: LinkTarget = CONFIG.MIGHTY.DEFAULT_LINK_TARGET

async function refreshLinkTarget(): Promise<LinkTarget> {
  linkTarget = (await window.api.mighty.getSettings()).linksOpenIn
  return linkTarget
}
refreshLinkTarget().catch(() => undefined)

export async function openWeb(url: string, flip: boolean): Promise<void> {
  const inApp = ((await refreshLinkTarget()) === 'app') !== flip
  if (!inApp || !openInRail(url)) void window.api.openExternal(url)
}

export async function linkMenu(e: { preventDefault: () => void }, url: string): Promise<void> {
  e.preventDefault()
  if ((await window.api.linkMenu(url, hasRail())) === 'app') openInRail(url)
}

export function currentLinkTarget(): LinkTarget {
  return linkTarget
}
