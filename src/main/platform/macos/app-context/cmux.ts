// cmux.ts — the cmux adapter for Phone Remote's app-aware bar.
//
// cmux ships a real scripting dictionary (Contents/Resources/cmux.sdef), so
// unlike Chrome this needs no filesystem archaeology to NAVIGATE. Its hierarchy,
// confirmed live against the app's own UI:
//
//   window → tab (the LEFT RAIL: "mighty-mouse", "COT", …)
//          → terminal (the TOP STRIP: "jul-26-s-c", "jul-26-s-b", …)
//
// So the bar's two levels map to tab (group) and terminal (item). `window` is
// deliberately unmapped: one window is the normal case and a single-entry
// dropdown is just a control that does nothing.
//
// Every window/tab/terminal carries a STABLE id, which is the thing that makes
// this adapter safer than Chrome's. This directory's CLAUDE.md rule — "send the
// resolved identity, never an index" — is satisfied by the app itself rather
// than by our discipline, so the "what I picked isn't what switched" bug class
// cannot occur here.
//
// The one thing AppleScript does NOT give: terminal names. Every terminal
// reports `name: "Terminal"` with an identical working directory, because that
// property is the shell's title, not cmux's label. The labels live in cmux's
// session file, keyed by the SAME uuid — see titlesFromSession().

import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { devLog } from '../../../../shared/env'
import { resolveBinary } from '../resolve-binary'
import {
  EMPTY_READING,
  type AppContextGroup,
  type AppContextItem,
  type AppContextPane,
  type AppContextReading
} from '../../../../shared/app-context'
import { FIELD_SEP, runOsa, runOsaAsync } from './osa'

/** Separates the groups block from the items block in the one-shot read. */
const BLOCK_SEP = `${FIELD_SEP}${FIELD_SEP}`

/** A local socket query, measured at 9ms — this bound is for a wedged tmux
 *  server, not for a slow answer. */
const TMUX_TIMEOUT_MS = 1000

/** `|` cannot appear in a session name or a pane id, and the title -- the one
 *  field that could contain it -- is read last, so it never needs escaping. */
const PANE_SEP = '|'
const PANE_FORMAT = [
  '#{session_name}',
  '#{pane_id}',
  '#{pane_active}',
  '#{window_zoomed_flag}',
  '#{pane_title}'
].join(PANE_SEP)
/** What a pane reports before its agent renames it — 17 of 55 live panes. */
const PANE_TITLE_DEFAULT = 'Claude Code'
/** Leading status decoration, stripped: it varies live and its meaning is unverified. */
const PANE_GLYPHS = /^[\u2733\u25d0\u25d1\u25d2\u25d3\u25cf\u25cb\s]+/

const SESSION_FILE = join(
  homedir(),
  'Library',
  'Application Support',
  'cmux',
  'session-com.cmuxterm.app.json'
)

/**
 * The front window's tabs, plus the selected tab's terminals, in one round trip.
 *
 * One script rather than two: separate calls could straddle a tab switch and
 * return terminals belonging to a different tab than the groups describe.
 */
export async function readCmux(): Promise<AppContextReading> {
  // `count of terminals` is wrapped in its own try because it is the youngest
  // thing this script asks for, and cmux moves fast (v0.64 at time of writing).
  // Unwrapped, one renamed property would take down the WHOLE read and leave a
  // bare app chip on an app we can otherwise navigate perfectly. Losing the
  // badge is the right price for a schema change; losing the tab list is not.
  const out = await runOsaAsync(`tell application "cmux"
      if (count of windows) is 0 then return ""
      set w to front window
      set sel to selected tab of w
      set g to ""
      repeat with t in tabs of w
        set c to ""
        try
          set c to (count of terminals of t) as text
        end try
        set g to g & (id of t as text) & "${FIELD_SEP}" & (name of t) & "${FIELD_SEP}" & (selected of t as text) & "${FIELD_SEP}" & c & "${FIELD_SEP}"
      end repeat
      set i to ""
      repeat with x in terminals of sel
        set i to i & (id of x as text) & "${FIELD_SEP}"
      end repeat
      return g & "${BLOCK_SEP}" & i
    end tell`)
  if (!out) return EMPTY_READING

  const [groupBlock, itemBlock] = out.split(BLOCK_SEP)
  if (groupBlock === undefined || itemBlock === undefined) return EMPTY_READING

  const titles = titlesFromSession()
  const dirs = dirsFromSession()

  const groups: AppContextGroup[] = []
  let activeGroupId = ''
  // Quads: id, name, selected, terminal count. Read three fields ahead of `n`,
  // so the bound is `n + 3 <= length` -- NOT `n + 3 < length`. An empty last
  // field (the count, on a cmux too old to report it) leaves nothing after the
  // final separator, and the stricter bound would drop that whole tab.
  const gp = groupBlock.split(FIELD_SEP)
  for (let n = 0; n + 3 <= gp.length; n += 4) {
    const id = gp[n]
    if (!id) continue
    const dir = dirs.get(id) ?? ''
    // A tab the user never renamed falls back to its path as a NAME (cmux
    // abbreviates it as "…/Desktop/Development/foo"), which then duplicates the
    // subtitle and blows out the row. A separator is the tell -- a real custom
    // title is a label like "COT", never a path. Keep the leaf.
    const raw = gp[n + 1] || id
    groups.push({
      id,
      name: raw.includes('/') ? (raw.split('/').filter(Boolean).pop() ?? raw) : raw,
      iconPngBase64: '',
      // A cmux tab's name is often a bare repo name ("COT", "hyperframes");
      // the path is what disambiguates two checkouts of the same project.
      subtitle: shortPath(dir),
      itemCount: Number.parseInt(gp[n + 3] ?? '', 10) || 0,
      // Every cmux tab we can enumerate is open by definition -- unlike Chrome,
      // there is no dormant-profile equivalent to separate them from.
      active: true
    })
    if (gp[n + 2] === 'true') activeGroupId = id
  }

  const ids = itemBlock.split(FIELD_SEP).filter(Boolean)
  // cmux exposes no "which terminal is focused" boolean on the terminal itself,
  // so the selected tab's `focused terminal` is the one authority for it.
  const focused = await runOsaAsync(
    `tell application "cmux" to return id of focused terminal of selected tab of front window`
  )
  const items: AppContextItem[] = ids.map((id, n) => ({
    id,
    // Session titles are DECORATION: a terminal opened since the file was last
    // written has no entry, and a positional label still beats a blank row.
    title: titles.get(id) || `Terminal ${n + 1}`,
    subtitle: '',
    active: id === focused,
    iconPngBase64: ''
  }))

  const tmux = readTmuxPanes(focused)
  return { items, groups, activeGroupId, tmuxZoomed: tmux.zoomed, panes: tmux.panes }
}

/**
 * Everything tmux knows about the panel the phone is looking at: whether its pane
 * is fullscreened, and what the panes inside it are called.
 *
 * The join the parent design declared unknowable, found in the session file rather
 * than in a tty: a panel cmux launched into tmux carries
 * `terminal.resumeBinding.kind === 'tmux'` and a `checkpointId` that IS the tmux
 * session name. Verified live — the one panel whose session read `zoomed=1` was
 * the one tab showing a fullscreened pane, and the other seven read 0.
 *
 * That also settles the OTHER half of what the design gave up on: a panel running a
 * plain shell has no `resumeBinding`, so "is this really tmux" stops being a
 * guess. `null` on that path keeps the zoom button stateless instead of asserting
 * "not zoomed" about a pane that has no such thing, and `panes: undefined` keeps
 * the bar's third chip off a terminal that has no third level.
 *
 * ONE `list-panes -a` call, not one per session: measured at 12ms for 55 panes
 * across 11 sessions — the same cost as asking about a single session — and it
 * carries `window_zoomed_flag` per row, which is why the separate
 * `display-message` read this replaced is gone rather than kept beside it.
 */
function readTmuxPanes(panelId: string | null): {
  zoomed: boolean | null
  panes: AppContextPane[] | undefined
} {
  const none = { zoomed: null, panes: undefined }
  if (!panelId) return none
  const session = tmuxSessionsFromSession().get(panelId)
  if (!session) return none
  const tmux = resolveBinary('tmux')
  if (!tmux) return none
  const r = spawnSync(tmux, ['list-panes', '-a', '-F', PANE_FORMAT], {
    encoding: 'utf8',
    timeout: TMUX_TIMEOUT_MS
  })
  if (r.error || r.status !== 0) {
    devLog.warn('[app-context] tmux pane read failed:', r.stderr?.trim() || r.error?.message)
    return none
  }

  const panes: AppContextPane[] = []
  let zoomed: boolean | null = null
  for (const line of r.stdout.split('\n')) {
    // The title is last on purpose: it is the only field that can contain the
    // separator, so it takes whatever remains rather than being split apart.
    const [name, id, active, zoom, ...rest] = line.split(PANE_SEP)
    if (name !== session || !id) continue
    const isActive = active === '1'
    // Zoom is a per-WINDOW flag repeated on every row of that window, so the
    // active pane's copy is the one that describes what the phone is looking at.
    if (isActive) zoomed = zoom === '1'
    panes.push({
      id,
      title: paneTitle(rest.join(PANE_SEP), panes.length),
      active: isActive,
      zoomed: zoom === '1'
    })
  }
  // Reached tmux but matched no row: the session died between the two reads.
  // Absent panes, and no zoom claim about a pane that is gone.
  if (panes.length === 0) return none
  return { zoomed, panes }
}

/**
 * A pane label worth showing, or a positional one.
 *
 * Measured across 55 live panes: 33 carried a real agent slug, 17 the literal
 * default, 5 nothing at all. So a straight passthrough would fill the sheet with
 * blank rows and a wall of identical entries — `Pane N` at least distinguishes
 * them, the same way `Terminal N` already does for items.
 *
 * The leading status glyph (`✳`, `◐`, `◑`) is stripped as decoration: it changes
 * on its own between reads, and what each one MEANS is unverified — so it is not
 * something to build a label on, let alone behaviour.
 */
function paneTitle(raw: string, index: number): string {
  const cleaned = raw.replace(PANE_GLYPHS, '').trim()
  if (!cleaned || cleaned === PANE_TITLE_DEFAULT) return `Pane ${index + 1}`
  return cleaned
}

/**
 * tmux session name by panel id, from the same session file as the titles.
 *
 * A third walk rather than a branch inside titlesFromSession() because the two
 * answer different questions and one is load-bearing where the other is not: a
 * missing title costs a label, a wrong session name would report another
 * agent's zoom state on this pane.
 */
function tmuxSessionsFromSession(): Map<string, string> {
  const sessions = new Map<string, string>()
  if (!existsSync(SESSION_FILE)) return sessions
  try {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      const rec = node as Record<string, unknown>
      const term = rec.terminal
      if (typeof rec.id === 'string' && term && typeof term === 'object') {
        const binding = (term as Record<string, unknown>).resumeBinding
        if (binding && typeof binding === 'object') {
          const b = binding as Record<string, unknown>
          if (b.kind === 'tmux' && typeof b.checkpointId === 'string' && b.checkpointId) {
            sessions.set(rec.id, b.checkpointId)
          }
        }
      }
      Object.values(rec).forEach(walk)
    }
    walk(JSON.parse(readFileSync(SESSION_FILE, 'utf8')))
  } catch (err) {
    devLog.warn('[app-context] cmux session file unreadable:', err)
  }
  return sessions
}

/**
 * Focus a tmux pane inside the focused terminal.
 *
 * The one action that cannot go through cmux's AppleScript dictionary: `focus`
 * stops at the terminal, and a pane is tmux's concept, not cmux's. The id is
 * shape-checked in `activateAppPane` before it ever reaches this argument.
 */
export function activateCmuxPane(paneId: string): boolean {
  const tmux = resolveBinary('tmux')
  if (!tmux) return false
  const r = spawnSync(tmux, ['select-pane', '-t', paneId], {
    encoding: 'utf8',
    timeout: TMUX_TIMEOUT_MS
  })
  if (r.error || r.status !== 0) {
    // A pane that died between the read and the tap lands here. Harmless: the
    // next context push corrects the list.
    devLog.warn('[app-context] tmux select-pane failed:', r.stderr?.trim() || r.error?.message)
    return false
  }
  return true
}

/** Switch the front window to one of its tabs (the left rail). */
export function activateCmuxTab(groupId: string): boolean {
  return (
    runOsa(`tell application "cmux"
      if (count of windows) is 0 then return "0"
      select tab (first tab of front window whose id is ${quote(groupId)})
      activate
      return "1"
    end tell`) === '1'
  )
}

/** Focus one terminal of the selected tab (the top strip). */
export function activateCmuxTerminal(itemId: string): boolean {
  return (
    runOsa(`tell application "cmux"
      if (count of windows) is 0 then return "0"
      focus (first terminal of selected tab of front window whose id is ${quote(itemId)})
      return "1"
    end tell`) === '1'
  )
}

/**
 * Terminal labels by panel id, read from cmux's session file.
 *
 * AppleScript cannot supply these (see the header), but the session file's
 * `panels[].id` is the same uuid AppleScript hands out — verified by joining
 * both sources live: 11/11 matched, in tab-strip order. Measured 35s fresh
 * while cmux was running, unlike the Chrome `Sessions/` path the parent design
 * rejected at 10 minutes stale.
 *
 * Read per call rather than cached: a rename or a new split must show up, and
 * this is a single ~32KB parse behind a user-initiated keyboard open.
 *
 * NEVER load-bearing. Any failure yields an empty map, which costs display
 * names and leaves navigation (driven entirely by AppleScript ids) intact.
 */
function titlesFromSession(): Map<string, string> {
  const titles = new Map<string, string>()
  if (!existsSync(SESSION_FILE)) return titles
  try {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      const rec = node as Record<string, unknown>
      if (rec.type === 'terminal' && typeof rec.id === 'string' && typeof rec.title === 'string') {
        titles.set(rec.id, rec.title)
      }
      Object.values(rec).forEach(walk)
    }
    walk(JSON.parse(readFileSync(SESSION_FILE, 'utf8')))
  } catch (err) {
    devLog.warn('[app-context] cmux session file unreadable:', err)
  }
  return titles
}

/**
 * Working directories by tab id, read from the same session file.
 *
 * A separate walk from titlesFromSession() because a tab and a terminal are
 * different shapes: terminals are `{type:'terminal', id, title}`, tabs are
 * `{workspaceId, currentDirectory}` — no `type`, and their id lives under a
 * different key. Verified live: all 8 AppleScript tab ids matched a
 * `workspaceId`.
 *
 * Decoration only, exactly like the titles — a miss costs a subtitle line.
 */
function dirsFromSession(): Map<string, string> {
  const dirs = new Map<string, string>()
  if (!existsSync(SESSION_FILE)) return dirs
  try {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      const rec = node as Record<string, unknown>
      if (typeof rec.workspaceId === 'string' && typeof rec.currentDirectory === 'string') {
        dirs.set(rec.workspaceId, rec.currentDirectory)
      }
      Object.values(rec).forEach(walk)
    }
    walk(JSON.parse(readFileSync(SESSION_FILE, 'utf8')))
  } catch (err) {
    devLog.warn('[app-context] cmux session file unreadable:', err)
  }
  return dirs
}

/**
 * Shorten a path for a subtitle line on a phone.
 *
 * `~` for home, then the last two segments — every checkout here sits under the
 * same `~/Desktop/Development` prefix, so the leading segments are the part
 * carrying no information.
 */
function shortPath(path: string): string {
  if (!path) return ''
  const home = homedir()
  const rel = path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
  const parts = rel.split('/').filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join('/') : rel
}

/**
 * Wrap an id as an AppleScript string literal.
 *
 * The IPC layer already refuses any id the adapter did not just report, so a
 * hostile value cannot reach here — this is the second lock, not the first.
 * Backslashes must be escaped before quotes or the escape itself gets escaped.
 */
function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
