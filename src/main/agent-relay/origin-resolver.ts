/**
 * "Go to session" — resolves an AgentOrigin (§5.3 of the take-me-to-the-session
 * PRD) into a focused window on THIS Mac. Runs once, on a click, never on a
 * render or a poll: with 60 open panes across 4+ cmux workspaces measured on
 * Roy's machine, this only has to be fast enough for a single button press.
 *
 * Ordered fallback, first hit wins — mirrors the table in the PRD exactly, so
 * a missing/stale cmux id degrades to tmux, then to just raising the host app,
 * rather than failing outright. A third-party CLI (cmux) can change its verbs
 * or reject an id that closed between mint and click; nothing here throws past
 * its own step, it just falls through.
 */

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { devLog } from '../../shared/env'
import { resolveBinary } from '../platform'
import type { AgentOrigin } from './mcp/http-listener'

/** A shell-out is a process spawn plus IPC to the target app — bound so a
 *  hung cmux/tmux daemon can never freeze the click that triggered this. */
const RESOLVE_TIMEOUT_MS = 3000

/** Homebrew's bin is NOT on a GUI-launched app's PATH, so a bare
 *  `execFile('tmux')` throws ENOENT in a packaged build while working fine from
 *  a dev terminal — a bug that only reproduces on someone else's machine. */
function tmuxPath(): string | null {
  return resolveBinary('tmux')
}

/** cmux ships its CLI inside the app bundle, so there is nothing on PATH — but
 *  the bundle can live anywhere, and a missing one must degrade to the
 *  tmux/host-app steps rather than spawn-erroring. */
const CMUX_CLI_PATHS = [
  '/Applications/cmux.app/Contents/Resources/bin/cmux',
  `${process.env.HOME || ''}/Applications/cmux.app/Contents/Resources/bin/cmux`
]

export function cmuxPath(): string | null {
  return CMUX_CLI_PATHS.find((p) => existsSync(p)) ?? resolveBinary('cmux')
}

export type OriginResolution = 'cmux-pane' | 'cmux-workspace' | 'tmux-pane' | 'host-app' | 'none'

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: RESOLVE_TIMEOUT_MS }, (err) => {
      if (err) devLog.warn(`[agent-relay] origin resolver step failed: ${cmd}`, err.message)
      resolve(!err)
    })
  })
}

/** Same spawn, but the output is the answer rather than the exit code -- the
 *  cmux tab join reads two lists before it can act. */
function capture(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: RESOLVE_TIMEOUT_MS }, (err, stdout) => {
      if (err) devLog.warn(`[agent-relay] origin resolver read failed: ${cmd}`, err.message)
      resolve(err ? null : stdout)
    })
  })
}

/** The tmux session a pane belongs to. A pane id is server-wide but focus is
 *  per-session, so this is the first half of "which tab is it behind". */
async function tmuxSessionOf(tmux: string, socket: string[], pane: string): Promise<string | null> {
  const out = await capture(tmux, [...socket, 'display', '-p', '-t', pane, '#{session_name}'])
  return out?.trim() || null
}

/** cmux tabs are SEPARATE ttys with their own attached tmux session, so no tmux
 *  verb reaches across them: `select-pane` in a tab you are not looking at exits
 *  0 and moves nothing. `resume_binding.checkpoint_id` IS the session name.
 *
 *  `surface.list '{}'` returns ONLY the current workspace's surfaces, so the
 *  lookup MUST be scoped — see docs/gotchas.md "go lands on the wrong agent". */
export async function focusCmuxSurfaceFor(
  cli: string,
  tmuxSession: string,
  workspaceId?: string
): Promise<boolean> {
  const params = workspaceId ? JSON.stringify({ workspace_id: workspaceId }) : '{}'
  let surfaceId = await findCmuxSurface(cli, params, tmuxSession)

  // A tab MOVED between workspaces leaves the origin's workspace id stale, and
  // the unscoped list only holds the current workspace, so sweep them all.
  if (!surfaceId) surfaceId = await findCmuxSurfaceAnywhere(cli, tmuxSession)
  if (!surfaceId) return false

  // snake_case: the RPC rejects surfaceId outright.
  return run(cli, ['rpc', 'surface.focus', JSON.stringify({ surface_id: surfaceId })])
}

/** Only reached when the scoped lookup missed, so the cost (one list per
 *  workspace) is paid on a rare click, never on the common path. */
async function findCmuxSurfaceAnywhere(
  cli: string,
  tmuxSession: string
): Promise<string | undefined> {
  const out = await capture(cli, ['rpc', 'workspace.list', '{}'])
  if (!out) return undefined

  let ids: string[] = []
  try {
    const parsed = JSON.parse(out) as { workspaces?: { id?: string }[] }
    ids = (parsed.workspaces ?? []).map((w) => w.id).filter((id): id is string => id !== undefined)
  } catch {
    return undefined
  }

  for (const id of ids) {
    const hit = await findCmuxSurface(cli, JSON.stringify({ workspace_id: id }), tmuxSession)
    if (hit) return hit
  }
  return undefined
}

async function findCmuxSurface(
  cli: string,
  params: string,
  tmuxSession: string
): Promise<string | undefined> {
  const out = await capture(cli, ['rpc', 'surface.list', params])
  if (!out) return undefined
  try {
    const parsed = JSON.parse(out) as {
      surfaces?: {
        id?: string
        title?: string
        resume_binding?: { kind?: string; checkpoint_id?: string }
      }[]
    }
    const surfaces = parsed.surfaces ?? []
    const bound = surfaces.find(
      (s) => s.resume_binding?.kind === 'tmux' && s.resume_binding.checkpoint_id === tmuxSession
    )
    return (bound ?? surfaces.find((s) => s.title?.trim() === tmuxSession))?.id
  } catch {
    return undefined
  }
}

/** cmux's own ids, NOT the AppleScript tab/terminal ids `app-context/cmux.ts`
 *  uses — a different id space. Raises the window; cannot pick a tab, since
 *  every agent here reports the same workspace id. */
async function tryCmux(origin: AgentOrigin): Promise<boolean> {
  if (!origin.cmuxWorkspaceId) return false
  const cli = cmuxPath()
  if (!cli) return false
  return run(cli, ['select-workspace', '--workspace', origin.cmuxWorkspaceId])
}

/** `select-pane` ALONE moves focus only WITHIN the pane's own window: elsewhere
 *  it changes nothing AND STILL EXITS 0, which is what made the button claim
 *  success while the screen never moved. `select-window` first decides it. */
async function tryTmux(origin: AgentOrigin, needTabMove = false): Promise<boolean> {
  if (!origin.tmuxPane) return false
  const tmux = tmuxPath()
  if (!tmux) return false
  // A shim can name a socket whose server is gone, which errors rather than
  // finding the pane — the same staleness `readTabName` retries around, and the
  // pane is usually still alive on the default socket.
  let socket = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
  // A pane id targets its window unambiguously, so one id drives both verbs.
  let focusedWindow = await run(tmux, [...socket, 'select-window', '-t', origin.tmuxPane])
  if (!focusedWindow && origin.tmuxSocket) {
    socket = []
    focusedWindow = await run(tmux, ['select-window', '-t', origin.tmuxPane])
  }
  if (!focusedWindow) return false
  await run(tmux, [...socket, 'select-pane', '-t', origin.tmuxPane])

  // Raise the TAB holding this pane's tmux session. Best-effort on purpose: a
  // plain-terminal or Ghostty user has no cmux, and the tmux focus above is
  // still the right answer for them.
  let tabMoved = true
  const cli = cmuxPath()
  if (cli) {
    const session = await tmuxSessionOf(tmux, socket, origin.tmuxPane)
    tabMoved = session ? await focusCmuxSurfaceFor(cli, session, origin.cmuxWorkspaceId) : false
  }

  await tryHostApp(origin)
  // Only the cmux path cares: there, a tab that never moved means the pane got
  // focus behind a tab nobody is looking at, and calling that 'cmux-pane' is
  // what let a wrong-session landing read as success. On the standalone tmux
  // path there is no working cmux to move, so tmux focus IS the answer.
  return needTabMove ? tabMoved : true
}

/**
 * Zoom this agent's pane on the Mac, by pane id.
 *
 * `resize-pane -Z` is a TOGGLE, so `want` is applied by reading
 * `#{window_zoomed_flag}` first and issuing nothing when it already matches —
 * otherwise two phones (or a double-tap) race the toggle back to where it was.
 *
 * Pane-addressed on purpose: the phone's existing `tmuxAction` types `C-b z`
 * into whatever is FRONTMOST, which zooms the wrong agent whenever the sheet
 * is open on a background one.
 */
export async function setTmuxZoom(
  origin: AgentOrigin | undefined,
  want: boolean
): Promise<boolean> {
  if (!origin?.tmuxPane) return false
  const tmux = tmuxPath()
  if (!tmux) return false
  const socket = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
  const is = await tmuxZoomState(tmux, socket, origin.tmuxPane)
  if (is === null) return false
  if (is === want) return true
  return run(tmux, [...socket, 'resize-pane', '-Z', '-t', origin.tmuxPane])
}

/** null when the pane is gone or tmux is wedged -- distinct from "not zoomed",
 *  which would make a dead pane report a togglable state. */
async function tmuxZoomState(
  tmux: string,
  socket: string[],
  pane: string
): Promise<boolean | null> {
  const out = await capture(tmux, [
    ...socket,
    'display-message',
    '-p',
    '-t',
    pane,
    '#{window_zoomed_flag}'
  ])
  return out === null ? null : out.trim() === '1'
}

/** By pane id, process-lifetime: a spawn per session on a list that re-renders
 *  constantly. A renamed tab going stale until restart is the accepted price. */
const tabNameCache = new Map<string, string>()

/** In-flight too, for the reason spelled out in `host-app-icon.ts`: the result
 *  cache is still empty when the next `broadcastStatus()` lands, so guarding on
 *  it alone spawned a `tmux` per broadcast (833 measured) until they failed. */
const tabNameInFlight = new Map<string, Promise<string | undefined>>()

/**
 * The tab name a pane sits in — "aug-15-s-f", the string on cmux's tab strip.
 *
 * NOT in the environment: `CMUX_TAB_NAME` is empty in a live pane, so the shim
 * cannot capture it. A tmux-backed surface's `checkpoint_id` IS its tmux
 * session name (the join `focusCmuxSurfaceFor` navigates by), so the pane's own
 * session name is the tab name, with no cmux call needed.
 */
export function tabNameFor(origin: AgentOrigin | undefined): Promise<string | undefined> {
  const pane = origin?.tmuxPane
  if (!pane) return Promise.resolve(undefined)

  const cached = tabNameCache.get(pane)
  if (cached !== undefined) return Promise.resolve(cached ?? undefined)

  const pending = tabNameInFlight.get(pane)
  if (pending) return pending

  const lookup = readTabName(pane, origin?.tmuxSocket).finally(() =>
    tabNameInFlight.delete(pane)
  )
  tabNameInFlight.set(pane, lookup)
  return lookup
}

/** A shim can mint an origin whose `tmuxSocket` no longer exists (the server it
 *  named was restarted), and `-S <dead>` makes tmux start an EMPTY server that
 *  knows no panes rather than erroring loudly. The default socket still holds
 *  the pane, so a socket-scoped miss retries without one before giving up. */
async function readTabName(pane: string, tmuxSocket?: string): Promise<string | undefined> {
  const tmux = tmuxPath()
  if (!tmux) return undefined

  let name = await tmuxSessionOf(tmux, tmuxSocket ? ['-S', tmuxSocket] : [], pane)
  if (!name && tmuxSocket) name = await tmuxSessionOf(tmux, [], pane)

  // Only a real answer is cached: a null would stick for the process lifetime
  // (`warmTabName` skips anything already in the map), freezing the row on the
  // pane-id fallback until restart even once tmux recovers.
  if (name) tabNameCache.set(pane, name)
  return name ?? undefined
}

/** Cached answer only — `currentStatus()` is synchronous. Falls back to the pane
 *  id, tagged so a bare `%13` reads as an id rather than a broken name. */
export function cachedWhereLabel(origin: AgentOrigin | undefined): string | undefined {
  if (!origin?.tmuxPane) return undefined
  const name = tabNameCache.get(origin.tmuxPane)
  return name ?? `pane ${origin.tmuxPane}`
}

export function warmTabName(origin: AgentOrigin | undefined, onResolved?: () => void): void {
  const pane = origin?.tmuxPane
  if (!pane || tabNameCache.has(pane) || tabNameInFlight.has(pane)) return
  void tabNameFor(origin).then((name) => {
    if (name && onResolved) onResolved()
  })
}

export function clearTabNameCache(): void {
  tabNameCache.clear()
  tabNameInFlight.clear()
}

async function tryHostApp(origin: AgentOrigin): Promise<boolean> {
  const bundleId = origin.cmuxBundleId || origin.hostBundleId
  if (!bundleId) return false
  return run('open', ['-b', bundleId])
}

export async function livesInApp(origin: AgentOrigin | undefined): Promise<boolean> {
  const tmux = tmuxPath()
  if (!origin?.tmuxPane || !tmux) return false
  // An ignore-size client (the terminal view's own stream) never sizes the pane, so it is not the user's.
  const read = (socket: string[]): Promise<string | null> =>
    capture(tmux, [...socket, 'list-clients', '-t', origin.tmuxPane!, '-F', '#{client_flags}'])
  const out = (origin.tmuxSocket ? await read(['-S', origin.tmuxSocket]) : null) ?? (await read([]))
  return out !== null && out.split('\n').every((flags) => !flags.trim() || flags.includes('ignore-size'))
}

export async function fitHiddenPane(origin: AgentOrigin | undefined, cols: number, rows: number): Promise<boolean> {
  const tmux = tmuxPath()
  const pane = origin?.tmuxPane
  if (!pane || !tmux) return false
  const socket = origin.tmuxSocket ? ['-S', origin.tmuxSocket] : []
  const w = Math.max(40, Math.min(400, Math.floor(cols)))
  const h = Math.max(10, Math.min(200, Math.floor(rows)))
  if (!(await livesInApp(origin))) return false
  return run(tmux, [...socket, 'resize-window', '-t', pane, '-x', String(w), '-y', String(h)])
}

/** Attempt the ordered table. Returns which step actually worked (or 'none'),
 *  so a caller can log/report without re-deriving the fallback logic. */
export async function resolveOrigin(origin: AgentOrigin | undefined): Promise<OriginResolution> {
  if (!origin) return 'none'

  if (origin.cmuxWorkspaceId && origin.tmuxPane) {
    if (await tryCmux(origin)) {
      // Agents in one workspace share its id, so this raised the WINDOW only;
      // the pane, and the tab its tmux session sits in, are what tell them
      // apart. Claim 'cmux-pane' only if that step actually landed.
      return (await tryTmux(origin, true)) ? 'cmux-pane' : 'cmux-workspace'
    }
  }
  if (origin.cmuxWorkspaceId && (await tryCmux(origin))) return 'cmux-workspace'
  if (origin.tmuxPane && (await tryTmux(origin))) return 'tmux-pane'
  if (await tryHostApp(origin)) return 'host-app'
  return 'none'
}

/** Moved to `shared/` now that the renderer gates its button on the same
 *  answer; re-exported so main-side importers keep their existing path. */
export { isOriginResolvable } from '../../shared/relay-status'
