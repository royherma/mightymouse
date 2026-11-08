// cursor.ts — the Cursor adapter for Phone Remote's app-aware bar.
//
// Cursor ships no scripting dictionary, so this reads System Events' AX tree and
// reports GROUPS ONLY (group = window/project). Editor tabs are unreachable and
// cannot be made so — see "Cursor's editor tabs are unreachable" in
// Safari is the mirror shape, so the bar drops an empty menu.

import { devLog } from '../../../../shared/env'
import {
  EMPTY_READING,
  type AppContextGroup,
  type AppContextReading
} from '../../../../shared/app-context'
import { FIELD_SEP, runOsa, runOsaAsync } from './osa'

/** AppleScript's `name of window`, split from its AXMain flag. */
const WINDOW_FIELDS = 2

/** A bare "Cursor" title is a window with nothing open — a real state. */
const NO_PROJECT_LABEL = 'No folder'

/** Project from a "<file> — <project>" title. The LAST segment: splitting on
 *  the first labels each window with the focused file, so the dropdown appears
 *  to rename itself as you type. */
export function projectFromTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed || trimmed === 'Cursor') return NO_PROJECT_LABEL
  const segments = trimmed.split('—')
  return segments[segments.length - 1]?.trim() || NO_PROJECT_LABEL
}

/** Windows as groups, one round trip. Each row has its own `try` so a window
 *  closing mid-enumeration costs that row, never the whole read. */
export async function readCursor(): Promise<AppContextReading> {
  const out = await runOsaAsync(`tell application "System Events"
      if not (exists process "Cursor") then return ""
      tell process "Cursor"
        set o to ""
        repeat with i from 1 to (count of windows)
          try
            set w to window i
            set o to o & (i as text) & "${FIELD_SEP}" & (name of w) & "${FIELD_SEP}" & (value of attribute "AXMain" of w as text) & "${FIELD_SEP}"
          end try
        end repeat
        return o
      end tell
    end tell`)
  if (out === null) {
    // null is a FAILED read, not "no windows" — nearly always a missing
    // Accessibility grant, which is invisible on screen.
    devLog.warn('[app-context] cursor read failed — check Accessibility permission')
    return EMPTY_READING
  }
  return {
    items: [],
    groups: parseWindows(out),
    activeGroupId: activeWindowId(out),
    tmuxZoomed: null
  }
}

function parseWindows(raw: string): AppContextGroup[] {
  const f = raw.split(FIELD_SEP)
  const groups: AppContextGroup[] = []
  // A trailing separator leaves an empty final slot; the off-by-one here
  // silently drops the last window (the bug cmux.ts documents).
  for (let n = 0; n + WINDOW_FIELDS - 1 < f.length; n += WINDOW_FIELDS + 1) {
    const id = f[n]?.trim() ?? ''
    if (!id) continue
    groups.push({
      id,
      name: projectFromTitle(f[n + 1] ?? ''),
      iconPngBase64: '',
      subtitle: '',
      itemCount: 0,
      active: (f[n + 2] ?? '').trim() === 'true'
    })
  }
  return groups
}

function activeWindowId(raw: string): string {
  return parseWindows(raw).find((g) => g.active)?.id ?? ''
}

/** Raise a window by the index the read handed out. AX exposes no stable window
 *  id, so this carries the same index risk chrome.ts does for tab indices —
 *  */
export function activateCursorWindow(id: string): boolean {
  const index = Number.parseInt(id, 10)
  // Rejected before interpolation: `id` arrives off the wire.
  if (!Number.isInteger(index) || index < 1) return false
  const out = runOsa(`tell application "System Events"
      if not (exists process "Cursor") then return "no"
      tell process "Cursor"
        if (count of windows) < ${index} then return "no"
        perform action "AXRaise" of window ${index}
        set frontmost to true
        return "ok"
      end tell
    end tell`)
  return out === 'ok'
}
