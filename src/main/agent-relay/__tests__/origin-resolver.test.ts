import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * The contract is "the button either moves the screen to the agent, or admits
 * it couldn't" -- never the third thing, which is what shipped.
 *
 * So tmux is modelled as REAL mutable state, not call counts: `select-pane`
 * below reproduces the behaviour that caused the bug, where targeting a pane in
 * a NON-current session changes nothing and still exits 0. Asserting
 * "select-pane was called" would pass against the broken code.
 *
 * Fixture is the measured live layout -- %13 in aug-14-s-b, %20 in aug-14-s-c.
 */

const SOCKET = '/private/tmp/tmux-502/default'

const PANE_OWNER: Record<string, string> = {
  '%13': 'aug-14-s-b',
  '%20': 'aug-14-s-c'
}

/** Measured live: each cmux TAB is its own tty attached to its own tmux
 *  session, and a surface's `resume_binding.checkpoint_id` names that session. */
const SURFACE_OF: Record<string, string> = {
  'aug-14-s-b': 'E702FB2F-308B-4918-AA99-0B9D2B551506',
  'aug-14-s-c': '690DE857-18BE-4C3C-8C98-131BFE264DEE'
}

let currentSession: string
let activePane: Record<string, string>
let openedBundles: string[]
let cmuxWillFail: boolean
/** The origin names a tmux socket whose server is gone; the default one still
 *  holds the pane. */
let deadSocket: boolean
/** Which cmux tab is actually ON SCREEN -- the thing the user sees, and the
 *  thing no tmux verb can move. */
let focusedSurface: string

function resetMachine(): void {
  currentSession = 'aug-14-s-c'
  // Each session remembers its own active pane, as a real tmux server does.
  activePane = { 'aug-14-s-b': '%12', 'aug-14-s-c': '%20' }
  openedBundles = []
  cmuxWillFail = false
  deadSocket = false
  tmuxInstalled = true
  cmuxInstalled = true
  focusedSurface = SURFACE_OF['aug-14-s-c']
}

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (
      cmd: string,
      args: string[],
      _opts: unknown,
      cb: (e: Error | null, stdout?: string) => void
    ) => {
      if (cmd.endsWith('/cmux')) {
        if (cmuxWillFail) return cb(new Error('no such workspace'))

        // The tab list, keyed the way the real RPC keys it.
        if (args[0] === 'rpc' && args[1] === 'surface.list') {
          const surfaces = Object.entries(SURFACE_OF).map(([session, id]) => ({
            id,
            resume_binding: { kind: 'tmux', checkpoint_id: session }
          }))
          return cb(null, JSON.stringify({ surfaces }))
        }

        // The ONLY thing that moves which tab is on screen.
        if (args[0] === 'rpc' && args[1] === 'surface.focus') {
          const { surface_id } = JSON.parse(args[2]) as { surface_id?: string }
          if (!surface_id) return cb(new Error('Missing or invalid surface_id'))
          focusedSurface = surface_id
          return cb(null, '{}')
        }

        // select-workspace raises the WINDOW only: every agent reports the same
        // workspace id, so it can never discriminate between tabs or panes.
        return cb(null, '')
      }

      if (cmd.endsWith('/tmux') || cmd === 'tmux') {
        const target = args[args.indexOf('-t') + 1]
        // `-S <path>` to a server that died STARTS a fresh empty one rather than
        // erroring, so every pane id is unknown on it -- the shape that froze a
        // row on its pane-id fallback.
        const onDeadSocket = deadSocket && args[args.indexOf('-S') + 1] === SOCKET
        const owner = onDeadSocket ? undefined : PANE_OWNER[target]
        if (!owner) return cb(new Error('can\'t find pane'))

        if (args.includes('display')) return cb(null, `${owner}\n`)

        if (args.includes('select-window')) {
          // Makes the pane's window current in its OWN session -- the step the
          // broken version skipped. Note it does NOT touch focusedSurface.
          currentSession = owner
          activePane[owner] = target
          return cb(null, '')
        }

        // THE BUG, reproduced: only effective within the current session, and
        // exits 0 regardless. Silence here is what the old code read as success.
        if (owner === currentSession) activePane[owner] = target
        return cb(null, '')
      }

      if (cmd === 'open') {
        openedBundles.push(args[args.indexOf('-b') + 1])
        return cb(null, '')
      }
      return cb(new Error(`unexpected command: ${cmd}`))
    }
  )
}))

vi.mock('../../../shared/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/env')>()),
  devLog: { warn: vi.fn(), log: vi.fn() }
}))

// Homebrew's tmux is NOT on a packaged app's PATH, so the resolver must look it
// up rather than spawn a bare name. `tmuxInstalled = false` models the machine
// that has no tmux at all.
let tmuxInstalled = true
vi.mock('../../platform', () => ({
  resolveBinary: vi.fn((name: string) =>
    name === 'tmux' && tmuxInstalled ? '/opt/homebrew/bin/tmux' : null
  )
}))

// cmux is found by bundle path, not PATH.
let cmuxInstalled = true
vi.mock('fs', () => ({ existsSync: vi.fn(() => cmuxInstalled) }))

const { resolveOrigin, isOriginResolvable, tabNameFor, cachedWhereLabel, clearTabNameCache } =
  await import('../origin-resolver')

/** Where the user's eyes actually end up. */
function focusedPane(): string {
  return activePane[currentSession]
}

describe('resolveOrigin — tmux', () => {
  beforeEach(resetMachine)

  it('lands on a pane owned by a DIFFERENT tmux session', async () => {
    // The whole bug in one assertion: %13 lives in aug-14-s-b while the user is
    // sitting in aug-14-s-c. Pre-fix this left focus on %20 and returned a
    // success anyway.
    const via = await resolveOrigin({ tmuxPane: '%13', tmuxSocket: SOCKET })

    expect(focusedPane()).toBe('%13')
    expect(via).toBe('tmux-pane')
  })

  it('targets the socket the shim captured, not the ambient server', async () => {
    await resolveOrigin({ tmuxPane: '%13', tmuxSocket: SOCKET })
    const { execFile } = await import('child_process')
    const calls = vi.mocked(execFile).mock.calls.filter(([cmd]) => cmd.endsWith('tmux'))
    expect(calls.length).toBeGreaterThan(0)
    for (const [, args] of calls) expect(args as string[]).toEqual(expect.arrayContaining(['-S', SOCKET]))
  })

  it('raises the host terminal, since tmux cannot focus a macOS window', async () => {
    await resolveOrigin({ tmuxPane: '%13', tmuxSocket: SOCKET, hostBundleId: 'com.cmuxterm.app' })
    expect(openedBundles).toContain('com.cmuxterm.app')
  })

  it('raises the cmux TAB holding the pane, not just the pane', async () => {
    // The "sometimes it works" report in one assertion: %13's tab is s-b while
    // the user looks at s-c, and every tmux verb here exits 0 leaving the
    // screen on s-c. "Random" was really "whichever tab was already open".
    await resolveOrigin({ tmuxPane: '%13', tmuxSocket: SOCKET })

    expect(focusedSurface).toBe(SURFACE_OF['aug-14-s-b'])
    expect(focusedPane()).toBe('%13')
  })

  it('leaves the tab alone when the pane is already in the visible one', async () => {
    await resolveOrigin({ tmuxPane: '%20', tmuxSocket: SOCKET })
    expect(focusedSurface).toBe(SURFACE_OF['aug-14-s-c'])
  })

  it('still focuses the pane for someone with no cmux at all', async () => {
    // A Ghostty/Terminal user: the tab step has nothing to do and must not
    // cost them the tmux focus that IS the right answer on their machine.
    cmuxInstalled = false
    const via = await resolveOrigin({ tmuxPane: '%13', tmuxSocket: SOCKET })
    expect(via).toBe('tmux-pane')
    expect(focusedPane()).toBe('%13')
  })

  it('reports failure for a pane that no longer exists', async () => {
    const via = await resolveOrigin({ tmuxPane: '%99', tmuxSocket: SOCKET })
    expect(via).toBe('none')
  })
})

describe('resolveOrigin — cmux + tmux together', () => {
  beforeEach(resetMachine)

  it('claims cmux-pane only when the pane step actually landed', async () => {
    const via = await resolveOrigin({
      cmuxWorkspaceId: 'F1442A99',
      tmuxPane: '%13',
      tmuxSocket: SOCKET
    })
    expect(via).toBe('cmux-pane')
    expect(focusedPane()).toBe('%13')
  })

  it('degrades to cmux-workspace when the pane is gone, rather than overclaiming', async () => {
    // The window is up but we never reached the agent: 18 agents share this
    // workspace id, so saying 'cmux-pane' here would mean "we got you there".
    const via = await resolveOrigin({
      cmuxWorkspaceId: 'F1442A99',
      tmuxPane: '%99',
      tmuxSocket: SOCKET
    })
    expect(via).toBe('cmux-workspace')
  })

  it('falls through to tmux when cmux itself fails', async () => {
    cmuxWillFail = true
    const via = await resolveOrigin({
      cmuxWorkspaceId: 'F1442A99',
      tmuxPane: '%13',
      tmuxSocket: SOCKET
    })
    expect(via).toBe('tmux-pane')
    expect(focusedPane()).toBe('%13')
  })

  it('falls back to raising the app when only a bundle id is known', async () => {
    const via = await resolveOrigin({ hostBundleId: 'com.cmuxterm.app' })
    expect(via).toBe('host-app')
  })
})

describe('other people\'s machines', () => {
  beforeEach(resetMachine)

  it('never spawns a bare binary name, since a packaged app has a narrow PATH', async () => {
    await resolveOrigin({ tmuxPane: '%13', tmuxSocket: SOCKET })
    const { execFile } = await import('child_process')
    for (const [cmd] of vi.mocked(execFile).mock.calls) {
      // `open` is in /usr/bin, on every Mac's PATH; everything else must be
      // absolute or it throws ENOENT outside a dev shell.
      if (cmd !== 'open') expect(cmd.startsWith('/')).toBe(true)
    }
  })

  it('degrades instead of throwing when tmux is not installed at all', async () => {
    tmuxInstalled = false
    const via = await resolveOrigin({
      tmuxPane: '%13',
      tmuxSocket: SOCKET,
      hostBundleId: 'com.apple.Terminal'
    })
    // Still raises their terminal -- the best available answer, not a crash.
    expect(via).toBe('host-app')
    expect(openedBundles).toContain('com.apple.Terminal')
  })

  it('works for a plain Terminal.app user with no cmux and no tmux', async () => {
    tmuxInstalled = false
    cmuxInstalled = false
    const via = await resolveOrigin({ hostBundleId: 'com.apple.Terminal' })
    expect(via).toBe('host-app')
  })

  it('falls back to tmux when cmux is not installed', async () => {
    cmuxInstalled = false
    const via = await resolveOrigin({
      cmuxWorkspaceId: 'F1442A99',
      tmuxPane: '%13',
      tmuxSocket: SOCKET
    })
    expect(via).toBe('tmux-pane')
    expect(focusedPane()).toBe('%13')
  })
})

describe('isOriginResolvable', () => {
  it('is false for the sessions that report no origin at all', () => {
    // 6 of 18 live sessions. These must not render a jump button.
    expect(isOriginResolvable(undefined)).toBe(false)
    expect(isOriginResolvable({})).toBe(false)
  })

  it('is true whenever resolveOrigin has any step it could take', () => {
    expect(isOriginResolvable({ tmuxPane: '%13' })).toBe(true)
    expect(isOriginResolvable({ cmuxWorkspaceId: 'F1442A99' })).toBe(true)
    expect(isOriginResolvable({ hostBundleId: 'com.cmuxterm.app' })).toBe(true)
  })

  it('agrees with resolveOrigin, so a rendered button never dead-ends', async () => {
    // The two disagreeing is the failure this pair exists to prevent.
    const origin = { termProgram: 'tmux' }
    expect(isOriginResolvable(origin)).toBe(false)
    expect(await resolveOrigin(origin)).toBe('none')
  })
})

/**
 * The tab name is the row a person reads to find the pane on screen, and it is
 * NOT in the shim's environment (`CMUX_TAB_NAME` is empty in a live pane), so
 * it is read back from tmux here. A pane's tmux session name IS its cmux tab
 * name -- the same join `focusCmuxSurfaceFor` navigates by.
 */
describe('tabNameFor', () => {
  beforeEach(() => {
    resetMachine()
    clearTabNameCache()
  })

  it('names the tab a pane sits in, not the one on screen', async () => {
    // %13 lives in aug-14-s-b while aug-14-s-c is focused: reading the CURRENT
    // session instead of the pane's own would label every row identically.
    expect(await tabNameFor({ tmuxPane: '%13', tmuxSocket: SOCKET })).toBe('aug-14-s-b')
    expect(await tabNameFor({ tmuxPane: '%20', tmuxSocket: SOCKET })).toBe('aug-14-s-c')
  })

  it('is undefined with no pane and on a machine without tmux', async () => {
    expect(await tabNameFor({ cmuxWorkspaceId: 'F1442A99' })).toBeUndefined()
    expect(await tabNameFor(undefined)).toBeUndefined()
    tmuxInstalled = false
    expect(await tabNameFor({ tmuxPane: '%13', tmuxSocket: SOCKET })).toBeUndefined()
  })

  it('caches per pane, so a re-render never re-spawns tmux', async () => {
    // The status build runs on every relay change; an uncached lookup would put
    // a process spawn per session behind each one.
    const { execFile } = await import('child_process')
    const spawns = (): number => vi.mocked(execFile).mock.calls.length

    const before = spawns()
    await tabNameFor({ tmuxPane: '%13', tmuxSocket: SOCKET })
    const afterFirst = spawns()
    expect(afterFirst).toBeGreaterThan(before)

    await tabNameFor({ tmuxPane: '%13', tmuxSocket: SOCKET })
    expect(spawns()).toBe(afterFirst)
  })
})

describe('cachedWhereLabel', () => {
  beforeEach(() => {
    resetMachine()
    clearTabNameCache()
  })

  it('falls back to a tagged pane id before the name has been read', () => {
    // The status build is synchronous, so the first pass legitimately has no
    // name yet. The id still tells two sessions apart; blank does not, and the
    // tag stops a bare `%13` reading as a mangled tab name.
    expect(cachedWhereLabel({ tmuxPane: '%13' })).toBe('pane %13')
  })

  it('prefers the tab name once the warm has landed', async () => {
    await tabNameFor({ tmuxPane: '%13', tmuxSocket: SOCKET })
    expect(cachedWhereLabel({ tmuxPane: '%13', tmuxSocket: SOCKET })).toBe('aug-14-s-b')
  })

  it('is undefined for a session with no pane at all', () => {
    expect(cachedWhereLabel(undefined)).toBeUndefined()
    expect(cachedWhereLabel({ cmuxWorkspaceId: 'F1442A99' })).toBeUndefined()
  })

  it('reads the name off the default socket when the origin names a dead one', async () => {
    deadSocket = true
    expect(await tabNameFor({ tmuxPane: '%13', tmuxSocket: SOCKET })).toBe('aug-14-s-b')
    expect(cachedWhereLabel({ tmuxPane: '%13', tmuxSocket: SOCKET })).toBe('aug-14-s-b')
  })

  it('retries after a failed read instead of sticking on the pane id', async () => {
    // A null must NOT be cached: `warmTabName` skips anything already in the
    // map, so caching the miss froze the row on `%13` until the app restarted.
    tmuxInstalled = false
    expect(await tabNameFor({ tmuxPane: '%13', tmuxSocket: SOCKET })).toBeUndefined()
    expect(cachedWhereLabel({ tmuxPane: '%13' })).toBe('pane %13')

    tmuxInstalled = true
    expect(await tabNameFor({ tmuxPane: '%13', tmuxSocket: SOCKET })).toBe('aug-14-s-b')
    expect(cachedWhereLabel({ tmuxPane: '%13' })).toBe('aug-14-s-b')
  })
})
