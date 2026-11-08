/**
 * Shared, mutable panel-run state — extracted from the old monolithic `ipc.ts` so
 * the domain handler modules (submit, cursor/hud, event toggles, history) can share
 * it without a cross-module `let`. It is deliberately module-private: callers go
 * through the accessors, never a direct export of the binding, so there is exactly
 * one owner of the mutation.
 *
 * Two pieces of state:
 *  - `panelState` — the panel's current run context (selection, ctx, mode override,
 *    active quick-action, history). Seeded by `buildPanelInitData` on panel mount;
 *    mutated by the mode/ctx/action toggles; read by submit + event logging.
 *  - `activePanelRunId` — the `cardRunId` of the panel's in-flight run. Lets the
 *    Stop button abort exactly this run, not every live run in the app. Set right
 *    before the run starts; cleared when it can no longer be stopped.
 */
import type { PanelState } from '../../shared/types'

let panelState: PanelState | null = null

/** URLs that carry no useful context — treat as "no URL". */
function isJunkURL(url: string): boolean {
  return /^(about:|chrome:|chrome-extension:|data:|view-source:)/.test(url) || url.trim() === ''
}

/**
 * Human-readable context label shown in the panel.
 * Precedence: app · host (real URL) → app · window title → app → "no context".
 * The title fallback means context works for every app (Notion, VS Code, Slack),
 * not just browsers, and survives the URL coming back junk/empty.
 *
 * Lives here (not ipc/panel.ts) so the panel-window's live-context poll can build
 * the same label without importing panel.ts and creating a cycle (panel.ts already
 * imports sendToPanelRenderer/isPanelVisible from panel-window.ts).
 */
export function buildCtxLabel(ctx: {
  frontApp?: string | null
  browserURL?: string | null
  windowTitle?: string | null
}): string {
  if (!ctx || !ctx.frontApp) return 'no context'
  if (ctx.browserURL && !isJunkURL(ctx.browserURL)) {
    const host = ctx.browserURL.match(/^https?:\/\/([^/]+)/)?.[1] || ctx.browserURL
    return `${ctx.frontApp} · ${host}`
  }
  if (ctx.windowTitle && ctx.windowTitle.trim()) {
    const title = ctx.windowTitle.length > 48 ? ctx.windowTitle.slice(0, 48) + '…' : ctx.windowTitle
    return `${ctx.frontApp} · ${title}`
  }
  return ctx.frontApp
}

/**
 * The unflattened identity behind `buildCtxLabel` — front app name + real page
 * URL — for the panel context row's app icon and favicon badge. Applies the SAME
 * junk-URL filter as the label so the badge and the text never disagree (a
 * `chrome://` page shows neither a host nor a favicon).
 *
 * Returns empty strings rather than null so the payload fields stay plain
 * `string` and the renderer can truth-test them without a null dance.
 */
export function buildCtxIdentity(ctx: {
  frontApp?: string | null
  browserURL?: string | null
}): { ctxApp: string; ctxURL: string } {
  const ctxApp = ctx?.frontApp || ''
  const url = ctx?.browserURL
  const ctxURL = url && !isJunkURL(url) ? url : ''
  return { ctxApp, ctxURL }
}

/** A quick action is visible when it has no host requirement, or the current URL matches it. */
export function actionVisible(a: { require_url_host?: string }, browserURL?: string | null): boolean {
  if (!a.require_url_host) return true
  if (!browserURL) return false
  const host = browserURL.match(/^https?:\/\/([^/]+)/)?.[1] || ''
  return host.includes(a.require_url_host)
}

// The runId of the panel's currently in-flight run (the `cardRunId` passed to
// runHudRun). Lets the Stop button kill exactly this run, not every live run in the
// app. Set right before runHudRun; cleared when the panel's run can no longer be
// stopped (answer/error land, panel closes). null = nothing stoppable in the panel.
let activePanelRunId: string | null = null

export function getPanelState(): PanelState | null {
  return panelState
}

export function setPanelState(next: PanelState | null): void {
  panelState = next
}

export function getActivePanelRunId(): string | null {
  return activePanelRunId
}

export function setActivePanelRunId(next: string | null): void {
  activePanelRunId = next
}
