import type { MouseEvent } from 'react'
import { isOriginResolvable } from '../../../shared/relay-status'
import type { AgentRelaySessionInfo, NativeMenuItem } from '../../../shared/types'

const SEPARATOR = 'separator' as const

type MenuEntry<C> =
  | {
      label: string | ((ctx: C) => string)
      when?: (ctx: C) => boolean
      run: (ctx: C) => void | Promise<void>
    }
  | typeof SEPARATOR

export type SessionMenuContext = {
  session: AgentRelaySessionInfo
  cwd?: string
  ended: boolean
  archived: boolean
  pinned: boolean
  open: () => void
  pin?: () => void
  archive?: () => void
}

export type ProjectMenuContext = {
  cwd?: string
  collapsed: boolean
  toggleCollapsed: () => void
  openAll: () => void
  startAgent?: () => void
  edit?: () => void
}

const sessionRef = (s: AgentRelaySessionInfo): string => s.sessionId ?? s.stated ?? s.label

const folderEntries = <C extends { cwd?: string }>(): MenuEntry<C>[] => [
  { label: 'Show in Finder', when: (c) => Boolean(c.cwd), run: (c) => window.api.openPath(c.cwd ?? '') },
  { label: 'Copy path', when: (c) => Boolean(c.cwd), run: (c) => navigator.clipboard.writeText(c.cwd ?? '') }
]

export const SESSION_MENU: MenuEntry<SessionMenuContext>[] = [
  { label: 'Open', run: (c) => c.open() },
  { label: (c) => (c.pinned ? 'Unpin' : 'Pin to top'), when: (c) => Boolean(c.pin) && !c.archived, run: (c) => c.pin?.() },
  SEPARATOR,
  {
    label: 'Open terminal',
    when: (c) => !c.ended && isOriginResolvable(c.session.origin),
    run: async (c) => void (await window.api.agentRelayRevealSession(sessionRef(c.session)))
  },
  ...folderEntries<SessionMenuContext>(),
  SEPARATOR,
  { label: (c) => (c.archived ? 'Restore' : 'Archive'), when: (c) => Boolean(c.archive), run: (c) => c.archive?.() }
]

export const PROJECT_MENU: MenuEntry<ProjectMenuContext>[] = [
  { label: 'Start a new agent here', when: (c) => Boolean(c.cwd && c.startAgent), run: (c) => c.startAgent?.() },
  { label: 'All agents', run: (c) => c.openAll() },
  { label: (c) => (c.collapsed ? 'Expand' : 'Collapse'), run: (c) => c.toggleCollapsed() },
  { label: 'Edit project', when: (c) => Boolean(c.edit), run: (c) => c.edit?.() },
  SEPARATOR,
  ...folderEntries<ProjectMenuContext>()
]

function visible<C>(entries: MenuEntry<C>[], ctx: C): MenuEntry<C>[] {
  const out: MenuEntry<C>[] = []
  for (const e of entries) {
    if (e === SEPARATOR) {
      if (out.length > 0 && out[out.length - 1] !== SEPARATOR) out.push(e)
    } else if (e.when?.(ctx) ?? true) out.push(e)
  }
  if (out[out.length - 1] === SEPARATOR) out.pop()
  return out
}

export async function showMenu<C>(event: MouseEvent, entries: MenuEntry<C>[], ctx: C): Promise<void> {
  event.preventDefault()
  event.stopPropagation()
  const shown = visible(entries, ctx)
  const items: NativeMenuItem[] = shown.map((e, i) =>
    e === SEPARATOR
      ? { type: SEPARATOR }
      : { id: String(i), label: typeof e.label === 'function' ? e.label(ctx) : e.label }
  )
  const picked = await window.api.nativeMenu(items)
  const entry = picked === null ? undefined : shown[Number(picked)]
  if (entry && entry !== SEPARATOR) await entry.run(ctx)
}
