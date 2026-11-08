import { describe, it, expect } from 'vitest'
import {
  relayStatusLine,
  sessionRow,
  shortPath,
  splitIdentity,
  isGeneratedTag,
  sessionHaystack,
  matchesSession,
  sessionMatchesFrom,
  agentLabel,
  agentVendor,
  sessionCanReply,
  nameFromMessage,
  withSeenIdle
} from '../relay-status'
import type { McpClientState } from '../types'

const client = (label: string, configured: boolean): McpClientState => ({
  id: 'claude-code',
  label,
  path: `/tmp/${label}`,
  configured
})

const SEEN = { lastAgentAt: 1_786_600_000_000, lastAgentFrom: 'mighty-mouse/dev' }
const LIVE = { agentCount: 1, agentNames: ['mighty-mouse/dev'] }

describe('relayStatusLine', () => {
  it('reports off before anything else', () => {
    const line = relayStatusLine({ enabled: false, running: false }, [client('Claude Code', true)])
    expect(line.health).toBe('off')
    expect(line.hint).toContain('Settings')
  })

  it('reports starting when enabled but the listener is not up', () => {
    expect(relayStatusLine({ enabled: true, running: false }, []).health).toBe('starting')
  })

  it('waits for a first agent when nothing has ever called', () => {
    const line = relayStatusLine({ enabled: true, running: true }, [client('Cursor', false)])
    expect(line.health).toBe('no-agent')
    expect(line.hint).toContain('Cursor')
  })

  it('is connected while a session is open, even with no config file found', () => {
    const line = relayStatusLine({ enabled: true, running: true, ...SEEN, ...LIVE }, [])
    expect(line.health).toBe('mac-only')
    expect(line.count).toBe(1)
  })

  it('never claims no-agent just because the config check came back empty', () => {
    const line = relayStatusLine({ enabled: true, running: true, ...SEEN, ...LIVE }, [
      client('Claude Code', false)
    ])
    expect(line.health).not.toBe('no-agent')
  })

  it('is ready once a phone can be pushed to as well', () => {
    const line = relayStatusLine(
      { enabled: true, running: true, deviceLabel: "Pat's iPhone", ...SEEN, ...LIVE },
      []
    )
    expect(line.health).toBe('ready')
    expect(line.text).toContain("Pat's iPhone")
    expect(line.hint).toBeUndefined()
  })

  it('counts each open session, singular and plural', () => {
    const one = relayStatusLine({ enabled: true, running: true, ...SEEN, ...LIVE }, [])
    expect(one.text).toContain('1 agent can')

    const three = relayStatusLine(
      {
        enabled: true,
        running: true,
        ...SEEN,
        agentCount: 3,
        agentNames: ['a', 'b', 'c']
      },
      []
    )
    expect(three.count).toBe(3)
    expect(three.text).toContain('3 agents')
  })

  // The whole point of the session model: an agent that called earlier but has
  // since been closed must read as zero, never as still connected.
  it('drops to none-open once every session has closed', () => {
    const line = relayStatusLine(
      { enabled: true, running: true, ...SEEN, agentCount: 0, agentNames: [] },
      []
    )
    expect(line.count).toBe(0)
    expect(line.health).toBe('no-agent')
    expect(line.text).toContain('Ready.')
    // Distinct from a never-configured machine: nothing to set up, so no hint at all.
    expect(line.hint).toBeUndefined()
  })

  it('still asks for setup when nothing has ever called', () => {
    const line = relayStatusLine({ enabled: true, running: true, agentCount: 0 }, [
      client('Claude Code', false)
    ])
    expect(line.health).toBe('no-agent')
    expect(line.hint).toContain('Claude Code')
  })

  it('treats a status with no count field as nothing open', () => {
    const line = relayStatusLine({ enabled: true, running: true }, [])
    expect(line.count).toBe(0)
  })
})

describe('sessionRow', () => {
  const NOW = 1_786_600_000_000

  it('stays silent when a session is merely connected', () => {
    const row = sessionRow({ label: 'a', waiting: 0 }, NOW)
    expect(row.state).toBe('connected')
    // The green dot already says this; six rows repeating it say nothing.
    expect(row.label).toBeUndefined()
  })

  it('treats a missing waiting count as at rest, never as waiting', () => {
    expect(sessionRow({ label: 'a' }, NOW).state).toBe('connected')
    expect(sessionRow({ label: 'a' }, NOW).label).toBeUndefined()
  })

  it('says waiting on you the moment one card is pending', () => {
    const row = sessionRow({ label: 'a', waiting: 1 }, NOW)
    expect(row.state).toBe('waiting')
    expect(row.label).toBe('Waiting on you')
  })

  it('counts the cards only when there is more than one', () => {
    expect(sessionRow({ label: 'a', waiting: 3 }, NOW).label).toBe('Waiting on you · 3')
  })

  it('says your turn when the newest card is the idle ping', () => {
    const row = sessionRow({ label: 'a', idleSince: NOW - 60_000 }, NOW)
    expect(row.health).toBe('your-turn')
    expect(row.state_text).toBe('Handed back')
    // state stays the narrow two-value type: nothing here is a pending card.
    expect(row.state).toBe('connected')
  })

  it('lets a waiting card outrank your turn — one has a button', () => {
    const row = sessionRow({ label: 'a', waiting: 1, idleSince: NOW - 60_000 }, NOW)
    expect(row.health).toBe('waiting')
    expect(row.state_text).toBe('Waiting on you')
  })

  it('carries exactly two times: how long you have not replied, and when it started', () => {
    const row = sessionRow(
      { label: 'a', since: NOW - 2 * 3_600_000, waiting: 1, handedBackAt: NOW - 14 * 60_000 },
      NOW
    )
    expect(row.waitAge).toBe('14m')
    expect(row.started).toMatch(/\(2h ago\)$/)
  })

  it('shows a wait age in SECONDS, where a minute-granular one would go blank', () => {
    // The whole point of the top-right number: a session that just handed back is
    // the one being scanned for, so rounding it to "0m" would hide it.
    const row = sessionRow({ label: 'a', since: NOW - 20_000, handedBackAt: NOW - 20_000 }, NOW)
    expect(row.waitAge).toBe('20s')
    expect(row.started).toMatch(/\(just now\)$/)
  })

  it('keeps the wait age after the row has been SEEN — glancing is not answering', () => {
    const raw = { label: 'a', idleSince: NOW - 9 * 60_000, handedBackAt: NOW - 9 * 60_000 }
    const seen = withSeenIdle(raw, NOW)
    // The unread dot is spent...
    expect(seen.idleSince).toBeUndefined()
    expect(sessionRow(seen, NOW).health).toBe('connected')
    // ...but the duration it has been sitting on the user is not.
    expect(sessionRow(seen, NOW).waitAge).toBe('9m')
  })

  it('shows no wait age for a session that is mid-turn — that silence is the agent’s', () => {
    expect(sessionRow({ label: 'a', busySince: NOW - 5_000 }, NOW).waitAge).toBeUndefined()
  })

  it('lets ended outrank your turn — a dropped socket is not waiting', () => {
    const row = sessionRow({ label: 'a', stale: true, idleSince: NOW - 60_000 }, NOW)
    expect(row.health).toBe('ended')
  })

  it('says Responding while the turn is live', () => {
    const row = sessionRow({ label: 'a', busySince: NOW - 5_000 }, NOW)
    expect(row.health).toBe('working')
    expect(row.state_text).toBe('Responding…')
  })

  it('lets your turn outrank responding — a stale start edge cannot bury a finished turn', () => {
    const row = sessionRow({ label: 'a', busySince: NOW - 5_000, idleSince: NOW - 1_000 }, NOW)
    expect(row.health).toBe('your-turn')
  })

  // The bug the user hit: nothing clears idleSince, so a session that went back to
  // work kept reading "Handed back" with a ticking age while it wrote files.
  it('lets a LIVE turn spend an older handoff — an agent back at work is not handed back', () => {
    const row = sessionRow({ label: 'a', idleSince: NOW - 60_000, busySince: NOW - 5_000 }, NOW)
    expect(row.health).toBe('working')
    expect(row.state_text).toBe('Responding…')
    // The ticking caption is half the lie: it read as neglect while nobody was owed anything.
    expect(row.waitAge).toBeUndefined()
  })

  // The other direction has to keep working, or a crashed agent buries the row
  // that most needs answering.
  it('does NOT let an EXPIRED turn spend the handoff — a dead agent cannot hide it', () => {
    const row = sessionRow({ label: 'a', idleSince: NOW - 60_000, busySince: NOW - 11 * 60_000 }, NOW)
    expect(row.health).toBe('your-turn')
  })

  it('stays responding through a long autonomous run while activity is fresh', () => {
    // busySince is an hour old -- the old 10-minute cap alone called this idle.
    const row = sessionRow(
      { label: 'a', busySince: NOW - 60 * 60_000, lastActivityAt: NOW - 5_000 },
      NOW
    )
    expect(row.health).toBe('working')
  })

  it('decays once activity goes quiet, even with a fresh-looking turn stamp', () => {
    const row = sessionRow(
      { label: 'a', busySince: NOW - 60_000, lastActivityAt: NOW - 3 * 60_000 },
      NOW
    )
    expect(row.health).toBe('connected')
  })

  // An older shim sends no activity pings at all; it must behave exactly as it
  // did before the field existed rather than decaying in seconds.
  it('falls back to the long turn cap when a session reports no activity', () => {
    expect(sessionRow({ label: 'a', busySince: NOW - 9 * 60_000 }, NOW).health).toBe('working')
    expect(sessionRow({ label: 'a', busySince: NOW - 11 * 60_000 }, NOW).health).toBe('connected')
  })

  it('lets a waiting card outrank responding — someone blocked beats something progressing', () => {
    const row = sessionRow({ label: 'a', busySince: NOW - 5_000, waiting: 1 }, NOW)
    expect(row.health).toBe('waiting')
  })

  // A SIGKILLed agent never fires Stop, so the stamp has to expire on its own or
  // the row claims "Responding…" forever -- a lying state, worse than Connected.
  it('decays to connected once the turn stamp outlives the cap', () => {
    expect(sessionRow({ label: 'a', busySince: NOW - 9 * 60_000 }, NOW).health).toBe('working')
    expect(sessionRow({ label: 'a', busySince: NOW - 11 * 60_000 }, NOW).health).toBe('connected')
  })

  it('spends the marker once seen, and only for pings up to the seen stamp', () => {
    const session = { label: 'a', idleSince: NOW - 60_000 }
    expect(withSeenIdle(session, NOW - 60_000).idleSince).toBeUndefined()
    expect(withSeenIdle(session, NOW - 120_000).idleSince).toBe(NOW - 60_000)
    expect(withSeenIdle(session, undefined)).toBe(session)
    expect(withSeenIdle({ label: 'a' }, NOW)).toEqual({ label: 'a' })
  })

  it('states when a session started, absolute first and relative in parens', () => {
    const started = (ms: number): string | undefined =>
      sessionRow({ label: 'a', since: NOW - ms }, NOW).started
    // A session opened today needs no date -- the clock time is unambiguous.
    expect(started(30_000)).toMatch(/^\d{1,2}:\d{2}\s?[AP]M \(just now\)$/i)
    expect(started(4 * 60_000)).toMatch(/\(4m ago\)$/)
    expect(started(3 * 3_600_000)).toMatch(/\(3h ago\)$/)
    // Past midnight the clock time alone stops locating it, so the date returns.
    const old = started(2 * 86_400_000)
    expect(old).toMatch(/\(2d ago\)$/)
    expect(old).toMatch(/^[A-Z][a-z]{2} \d{1,2},/)
  })

  it('keeps only the distinguishing tail of the path', () => {
    expect(shortPath('/Users/roy/Desktop/Development/ShowAndTell')).toBe('Development/ShowAndTell')
    expect(shortPath('/Users/roy/Desktop/Development/ShowAndTell/')).toBe('Development/ShowAndTell')
    expect(shortPath('/one')).toBe('one')
    expect(shortPath('/')).toBe('/')
    expect(shortPath(undefined)).toBeUndefined()
  })

  it('has no start line at all when the session never reported one', () => {
    expect(sessionRow({ label: 'a' }, NOW).started).toBeUndefined()
  })

  it('drops the path when the name already said it', () => {
    // The screenshot case: six rows in one repo, every path line identical.
    const row = sessionRow(
      { label: 'ShowAndTell/dev - 8bf9ff45', cwd: '/Users/roy/Desktop/Development/ShowAndTell' },
      NOW
    )
    expect(row.where).toBeUndefined()
  })

  it('keeps the path when it names a folder the label does not', () => {
    const row = sessionRow(
      { label: 'ShowAndTell/dev - 8bf9ff45', cwd: '/Users/roy/Desktop/worktrees/wt-mirror' },
      NOW
    )
    expect(row.where).toBe('worktrees/wt-mirror')
  })

  it('ignores the shared parent folder when judging the repeat', () => {
    // `Development/` is identical for every checkout on this Mac, so it cannot
    // be what keeps the line alive — only the working folder counts.
    expect(
      sessionRow({ label: 'ShowAndTell', cwd: '/Users/roy/Development/ShowAndTell' }, NOW).where
    ).toBeUndefined()
  })

  it('keeps the path when the folder differs from the label by more than case', () => {
    expect(
      sessionRow({ label: 'ShowAndTell/dev', cwd: '/Users/roy/Development/mm-scratch' }, NOW).where
    ).toBe('Development/mm-scratch')
  })

  it('splits the identity into repo, branch and per-pane detail', () => {
    const row = sessionRow(
      { label: 'ShowAndTell/dev - 8bf9ff45', cwd: '/Users/roy/Desktop/Development/ShowAndTell' },
      NOW
    )
    // No name of its own, so the checkout keeps line 1 and the id head is all
    // that distinguishes this pane from its neighbours.
    expect(row.name).toBeUndefined()
    expect(row.repo).toBe('ShowAndTell')
    expect(row.branch).toBe('dev')
    expect(row.detail).toBe('8bf9')
  })

  it('gives six panes in one checkout six different details', () => {
    // The regression: stripping the id left eight rows reading identically.
    const details = ['8bf9ff45', '08e3d94e', '3fc9b195'].map(
      (id) => sessionRow({ label: `ShowAndTell/dev - ${id}` }, NOW).detail
    )
    expect(new Set(details).size).toBe(3)
  })

  it('names line 1 and leaves the recap for line 2', () => {
    // The name identifies the row; the recap is a sentence about what it is
    // doing. Both on line 1 printed the same text twice.
    const withRecap = sessionRow(
      {
        label: 'ShowAndTell/dev - 8bf9ff45',
        stated: 'iphone-model-naming-discrepancy',
        tldr: 'Debug iPhone model detection mismatch'
      },
      NOW
    )
    expect(withRecap.name).toBe('iPhone model naming discrepancy')
    expect(withRecap.tldr).toBe('Debug iPhone model detection mismatch')

    // Nothing named it, so the recap is the only thing that can identify it.
    const recapOnly = sessionRow(
      { label: 'ShowAndTell/dev - 8bf9ff45', tldr: 'Debug iPhone model detection mismatch' },
      NOW
    )
    expect(recapOnly.name).toBe('Debug iPhone model detection mismatch')

    // A tag a person types stays typeable -- "Mm dev 719" is not searchable.
    expect(sessionRow({ label: 'ShowAndTell/dev - mm-dev-719' }, NOW).name).toBe('mm-dev-719')

    // The shim often sends the name ONLY in the label. That path skipped the
    // prettifier entirely, so every row in the list rendered as a raw slug.
    expect(sessionRow({ label: 'ShowAndTell/dev - iphone-model-naming-discrepancy' }, NOW).name).toBe(
      'iPhone model naming discrepancy'
    )
  })

  it('puts the pid on an unnamed row, which beats a truncated id', () => {
    const row = sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45', pid: 21338 }, NOW)
    expect(row.detail).toBe('pid 21338')
    // Still a machine handle, so it keeps the dimmed monospaced treatment.
    expect(isGeneratedTag(row.detail)).toBe(true)
  })

  it('gives a named session line 1 and moves the checkout down to line 2', () => {
    const row = sessionRow(
      { label: 'ShowAndTell/dev - 8bf9ff45', stated: 'mm-look-last-commits-repo' },
      NOW
    )
    // Rendered as prose: the slug is a filename, line 1 is for reading.
    expect(row.name).toBe('Mm look last commits repo')
    expect(row.place).toBe('ShowAndTell/dev')
    // The id has done its job -- the name identifies the pane now, so the row
    // stops showing a handle nobody chose.
    expect(row.detail).toBeUndefined()
  })

  it('does not repeat the checkout on both lines of an unnamed row', () => {
    const row = sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45' }, NOW)
    expect(row.place).toBeUndefined()
  })

  it('treats a name carried in the label itself as a name, not a handle', () => {
    // A shim started by an already-named session packs the name into the label
    // and never sets `stated`. Reading only `stated` rendered "mm-dev-719" as a
    // dim monospaced handle on line 2 -- the exact treatment a chosen name
    // must not get, and it hit six of eleven live rows.
    const row = sessionRow({ label: 'ShowAndTell/dev - mm-dev-719' }, NOW)
    expect(row.name).toBe('mm-dev-719')
    expect(row.place).toBe('ShowAndTell/dev')
    expect(row.detail).toBeUndefined()
  })

  it('still shows the pid when the label carries no name to use', () => {
    // The pid must not displace a real name, so this pairs with the test above:
    // same shape, but the tag IS a generated id, so the handle is right here.
    const row = sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45', pid: 4005 }, NOW)
    expect(row.name).toBeUndefined()
    expect(row.detail).toBe('pid 4005')
  })
})

describe('splitIdentity', () => {
  it('reads repo, branch and tag out of the shim string', () => {
    expect(splitIdentity('ShowAndTell/dev - 8bf9ff45')).toEqual({
      repo: 'ShowAndTell',
      branch: 'dev',
      tag: '8bf9ff45'
    })
  })

  it('handles a repo with no branch and a branch with slashes', () => {
    expect(splitIdentity('ShowAndTell')).toEqual({ repo: 'ShowAndTell', tag: undefined })
    // Only the FIRST slash splits, so "feature/x" survives intact.
    expect(splitIdentity('ShowAndTell/feature/x - ab12cd34').branch).toBe('feature/x')
  })

  it('splits on the LAST separator so a hyphenated repo survives', () => {
    expect(splitIdentity('my - repo/dev - ab12cd34')).toEqual({
      repo: 'my - repo',
      branch: 'dev',
      tag: 'ab12cd34'
    })
  })

  it('marks only an 8-char hex tag as generated', () => {
    expect(isGeneratedTag('8bf9ff45')).toBe(true)
    expect(isGeneratedTag('mm-dev-399')).toBe(false)
    expect(isGeneratedTag(undefined)).toBe(false)
  })
})

describe('session search', () => {
  const hay = (session: Parameters<typeof sessionRow>[0]): string =>
    sessionHaystack(session, sessionRow(session, 0))

  const named = {
    label: 'ShowAndTell/dev - mm-dev-735',
    cwd: '/Users/roy/Development/ShowAndTell',
    pid: 63185
  }
  const unnamed = {
    label: 'ShowAndTell/feature/mirror - 3fc9b195',
    cwd: '/Users/roy/Development/.worktrees/wt-mirror'
  }

  it('finds a session by name, repo, or branch', () => {
    const h = hay(named)
    expect(matchesSession(h, 'mm-dev-735')).toBe(true)
    expect(matchesSession(h, 'showandtell')).toBe(true)
    expect(matchesSession(h, 'dev')).toBe(true)
    expect(matchesSession(h, 'mirror')).toBe(false)
  })

  it('finds an unnamed session by its id head or its worktree path', () => {
    const h = hay(unnamed)
    expect(matchesSession(h, '3fc9')).toBe(true)
    expect(matchesSession(h, 'wt-mirror')).toBe(true)
    expect(matchesSession(h, 'feature/mirror')).toBe(true)
  })

  // A NAMED session's id appears nowhere in its label, so before the id joined
  // the haystack the one string the relay CLI prints matched nothing at all.
  it('finds a named session by the id the CLI and the hooks print', () => {
    const h = hay({ ...named, sessionId: '9a5c9662-1c4d-4f0e-9a01-6b2f8e3d7a45' })
    expect(matchesSession(h, '9a5c9662')).toBe(true)
    expect(matchesSession(h, '9A5C9662')).toBe(true)
  })

  it('finds a session by its host app or tab name', () => {
    const h = hay({ ...named, hostAppName: 'cmux', whereLabel: 'billing fixes' })
    expect(matchesSession(h, 'cmux')).toBe(true)
    expect(matchesSession(h, 'billing')).toBe(true)
  })

  it('finds a named session by its pid, which the card also shows', () => {
    // The pid is searchable even though a NAMED row renders no pid chip: it is
    // still how someone hunting a specific process would type.
    expect(matchesSession(hay(named), '63185')).toBe(true)
  })

  it('is case-insensitive and ANDs its terms', () => {
    const h = hay(named)
    expect(matchesSession(h, 'SHOWANDTELL')).toBe(true)
    expect(matchesSession(h, 'dev 735')).toBe(true)
    // Both terms must land: "dev" hits, "mirror" does not.
    expect(matchesSession(h, 'dev mirror')).toBe(false)
  })

  it('matches everything on an empty or whitespace query', () => {
    expect(matchesSession(hay(named), '')).toBe(true)
    expect(matchesSession(hay(named), '   ')).toBe(true)
  })
})

describe('sessionMatchesFrom', () => {
  const session = { label: 'ShowAndTell - student-round-last-days' }

  it('joins a hook from onto the shim label', () => {
    expect(sessionMatchesFrom(session, 'ShowAndTell · student-round-last-days')).toBe(true)
  })

  it('still matches an exact label or stated name', () => {
    expect(sessionMatchesFrom(session, session.label)).toBe(true)
    expect(
      sessionMatchesFrom(
        { label: 'raw', stated: 'ShowAndTell · student-round-last-days' },
        'ShowAndTell · student-round-last-days'
      )
    ).toBe(true)
  })

  it('does not match a different agent', () => {
    expect(sessionMatchesFrom(session, 'ShowAndTell · wee-dev-main')).toBe(false)
    expect(sessionMatchesFrom(session, undefined)).toBe(false)
  })
})

// The shim sends AI_AGENT verbatim, and the cmux wrapper appends a build suffix
// ("claude-code_2-1-232_agent"). An exact-key lookup misses that -- which is
// what put the raw string on every card as its own chip.
describe('agent identity', () => {
  it('reads through the build suffix the wrapper appends', () => {
    expect(agentLabel('claude-code_2-1-232_agent')).toBe('Claude Code')
    expect(agentVendor('claude-code_2-1-232_agent')).toBe('claude')
    expect(agentLabel('codex_1-2-3_agent')).toBe('Codex')
  })

  it('prefers the longest match, so claude-code never reads as claude', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code')
    expect(agentVendor('claude')).toBe('claude')
    expect(agentVendor('codex')).toBe('codex')
  })

  // An editor fronts several vendors, so drawing one vendor's logo would be a
  // claim we cannot make -- the surface falls back to a neutral glyph instead.
  it('gives no vendor to an editor or an unknown agent', () => {
    expect(agentVendor('cursor')).toBeUndefined()
    expect(agentVendor('vscode')).toBeUndefined()
    expect(agentVendor('totally-new-thing')).toBeUndefined()
    expect(agentVendor(undefined)).toBeUndefined()
  })
})

describe('sessionCanReply', () => {
  it('is true for a tmux pane or a shim pid, not for a bare origin', () => {
    expect(sessionCanReply({ origin: { tmuxPane: '%79' } })).toBe(true)
    expect(sessionCanReply({ pid: 4242, origin: { termProgram: 'vscode' } })).toBe(true)
    expect(sessionCanReply({ origin: { termProgram: 'vscode' } })).toBe(false)
    expect(sessionCanReply({})).toBe(false)
  })
})

describe('sessionRow unnamed', () => {
  const NOW = 1_786_600_000_000
  const WAIT = 60_000

  it('shows a skeleton while the <branch>-HHMM stand-in is live', () => {
    expect(sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45', stated: 'dev-0905', since: NOW - 1_000 }, NOW).unnamed).toBe(true)
  })

  it('shows the stand-in instead of a skeleton once the naming window has passed', () => {
    const row = sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45', stated: 'dev-0905', since: NOW - WAIT - 1 }, NOW)
    expect(row.unnamed).toBe(false)
    expect(row.name).toBe('dev-0905')
  })

  it('shows a skeleton for a fresh session with no name yet', () => {
    expect(sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45', since: NOW - 1_000 }, NOW).unnamed).toBe(true)
  })

  it('stops waiting once the naming window has passed', () => {
    expect(sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45', since: NOW - WAIT - 1 }, NOW).unnamed).toBe(false)
  })

  it('never shows a skeleton on an ended session', () => {
    const row = sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45', stated: 'dev-0905', stale: true }, NOW)
    expect(row.unnamed).toBe(false)
  })

  it('a real name is never a skeleton', () => {
    const row = sessionRow({ label: 'ShowAndTell/dev - 8bf9ff45', stated: 'fix-login', since: NOW }, NOW)
    expect(row.unnamed).toBe(false)
  })
})

describe('nameFromMessage', () => {
  it('skips an attached file path on the line above the words', () => {
    const sent =
      "/Users/roy/.cache/clipaste/shot-sha256-c7293312d2eff56358f76118cb6fa9b2c4cc637ed230b949081a904f1be29e40.png\nSo yesterday you're supposed to have every 10am running something"
    expect(nameFromMessage(sent)).toBe("So yesterday you're supposed to have every 10am")
  })

  it('skips pasted-picture markers', () => {
    expect(nameFromMessage(' [Image #1] [Image #2]  Yeah, see what happened here.')).toBe(
      'Yeah, see what happened here.'
    )
  })

  it('keeps a path the message is actually about, and a lone path', () => {
    expect(nameFromMessage('/etc/hosts.conf is wrong, fix it')).toBe('/etc/hosts.conf is wrong, fix it')
    expect(nameFromMessage('/Users/roy/a/shot.png')).toBe('/Users/roy/a/shot.png')
  })

  it('names nothing when the message is only a picture', () => {
    expect(nameFromMessage('[Image #1]')).toBeUndefined()
  })

  it('names a session in a folder with no git branch a stand-in, not a name', () => {
    const at = 1_786_600_000_000
    const row = sessionRow({ label: 'side-projects - side-projects-1034', since: at }, at)
    expect(row.unnamed).toBe(true)
  })
})
