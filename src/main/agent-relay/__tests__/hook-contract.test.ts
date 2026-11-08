/**
 * The Claude Code hooks call bin/mm-relay from OUTSIDE this repo, in bash, so
 * nothing else here can catch them drifting from a schema change: typecheck
 * does not see them and no test imported them.
 *
 * That gap shipped a real bug. `notify`'s state enum was narrowed to
 * done|progress (a notify is delivered and closed on send, so it can never say
 * someone is needed -- see STATE_HINT in mcp/verbs.ts), every in-repo caller was
 * updated, and gate went green. The hook kept sending --state waiting|blocked,
 * so the relay rejected EVERY idle notification with -32602. It was silent for
 * hours because the hook redirects the CLI's output to /dev/null.
 *
 * These tests read the installed hook and assert it against the live enum.
 * Skipped when the hook is absent, so CI and other machines stay green.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { RELAY_NOTIFY_STATES } from '../store'

/** BOTH hooks that shell out to mm-relay, not just the notify one. Guarding
 *  only the first is why the identical -32602 bug shipped a SECOND time: the
 *  Stop hook kept sending --state waiting for a day after the enum narrowed,
 *  and every turn-end ping died silently (2026-08-15). */
const HOOKS = ['mm-relay-notify.sh', 'mm-relay-stop.sh'].map((name) => ({
  name,
  path: join(homedir(), '.claude', 'hooks', name)
}))
const installed = HOOKS.some((h) => existsSync(h.path))

/** The notify hook alone -- the idle-ping assertions below are about the
 *  Notification path specifically, not about every hook that calls mm-relay. */
const NOTIFY_HOOK = HOOKS[0].path
const hook = existsSync(NOTIFY_HOOK) ? readFileSync(NOTIFY_HOOK, 'utf8') : ''

/** Every `--state <value>` the hook can pass, including via a shell variable
 *  it assigns literally (STATE="waiting" then `--state "$STATE"`). */
function statesPassedByHook(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/--state\s+"?([a-z$][\w"{}]*)"?/g)) {
    const raw = m[1]
    if (!raw.startsWith('$')) {
      found.add(raw)
      continue
    }
    // `--state "$STATE"` -- collect every literal that variable is assigned.
    const name = raw.replace(/[^A-Za-z_]/g, '')
    for (const a of text.matchAll(new RegExp(`\\b${name}=["']?([a-z_]+)["']?`, 'g'))) {
      found.add(a[1])
    }
  }
  return [...found]
}

/** Every filesystem path to bin/mm-relay the hook actually runs. Skips comment
 *  lines, and stops at the `="` of an assignment -- a `\S*` prefix would swallow
 *  `MM_RELAY="` into the path and make an existsSync check unfalsifiable. */
function mmRelayPathsIn(text: string): string[] {
  const found = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    for (const m of line.matchAll(/([^\s"'=]*bin\/mm-relay)\b/g)) found.add(m[1])
  }
  return [...found]
}

describe.skipIf(!installed)('the relay hooks honor the live relay contract', () => {
  for (const { name, path } of HOOKS) {
    describe.skipIf(!existsSync(path))(name, () => {
      const hook = existsSync(path) ? readFileSync(path, 'utf8') : ''

      it('never passes a notify state the schema would reject', () => {
        const passed = statesPassedByHook(hook)
        const invalid = passed.filter((s) => !RELAY_NOTIFY_STATES.includes(s as never))
        expect(
          invalid,
          `${name} sends --state ${invalid.join('/')}, schema allows only ${RELAY_NOTIFY_STATES.join('|')}`
        ).toEqual([])
      })

      it('calls a bin/mm-relay that exists', () => {
        expect(mmRelayPathsIn(hook).length).toBeGreaterThan(0)
        for (const p of mmRelayPathsIn(hook)) expect(existsSync(p), `${p} does not exist`).toBe(true)
      })
    })
  }
})

describe('the parser itself catches the bug that shipped', () => {
  it('flags the old waiting/blocked form', () => {
    const old = 'STATE="waiting"\nmm-relay notify --state "$STATE" --body x'
    expect(statesPassedByHook(old)).toContain('waiting')
  })

  it('reads a literal --state value', () => {
    expect(statesPassedByHook('mm-relay notify --state progress')).toEqual(['progress'])
  })

  it('reports nothing when the flag is not passed at all', () => {
    expect(statesPassedByHook('mm-relay notify --body x --from y')).toEqual([])
  })

  it('reads the path out of a quoted assignment, not the variable name with it', () => {
    expect(mmRelayPathsIn('MM_RELAY="/repo/bin/mm-relay"')).toEqual(['/repo/bin/mm-relay'])
  })

  it('ignores a bin/mm-relay mentioned only in a comment', () => {
    expect(mmRelayPathsIn('# bin/mm-relay fails fast when nothing is listening')).toEqual([])
  })
})

describe.skipIf(!installed)('idle waiting ping lands as a session, not Needs you', () => {
  it('still fires on idle_prompt', () => {
    expect(hook).toMatch(/idle_prompt/)
  })

  it('marks the ping idle so the phone opens that agent', () => {
    expect(hook).toMatch(/--idle/)
  })

  it('does not dress the ping as a Needs-you wait', () => {
    expect(hook).not.toMatch(/Waiting on You/)
    expect(hook).not.toMatch(/--state\s+waiting/)
  })
})
