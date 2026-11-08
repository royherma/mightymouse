import { describe, expect, it } from 'vitest'
import { parseStartupPrompt } from '../picker-keys'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rescanCodexThreads, withCodexThreads } from '../codex-threads'

const TRUST = ["", "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────", " Accessing workspace:", "", " /Users/me/project", "", " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source", " project, or work from your team). If not, take a moment to review what's in this folder first.", "", " Claude Code'll be able to read, edit, and execute files here.", "", " Security guide", "", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"]
const MCP = ["", "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────", "  New MCP server found in this project: probe", "", "  MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP", "  documentation.", "", "    Use this MCP server", "    Use this and all future MCP servers in this project", "  ❯ Continue without using this MCP server", "", "  Enter to confirm · Esc to cancel"]
const NUMBERED_WITH_DETAIL = ["────────────────────────────────────────", " Do you want to use bypass permissions mode?", "", "    1. No, exit", "       Nothing changes", "  ❯ 2. Yes, I accept", "       Every command runs without asking", "", " Enter to confirm · Esc to cancel"]

describe('parseStartupPrompt', () => {
  it('reads the Codex hook trust prompt before the session starts', () => {
    const p = parseStartupPrompt([
      '',
      '  Hooks need review',
      '  2 hooks are new or changed.',
      '  Hooks can run outside the sandbox after you trust them.',
      '',
      '› 1. Review hooks',
      '  2. Trust all and continue',
      "  3. Continue without trusting (hooks won't run)",
      '',
      '  Press enter to confirm or esc to go back',
      ''
    ])
    expect(p?.options).toEqual([
      'Review hooks',
      'Trust all and continue',
      "Continue without trusting (hooks won't run)"
    ])
    expect(p?.selected).toBe(0)
    expect(p?.question).toContain('Hooks need review')
  })

  it('reads the unnumbered trust dialog and asks its real question', () => {
    const p = parseStartupPrompt(TRUST)
    expect(p?.options).toEqual(['No, exit', 'Yes, I trust this folder'])
    expect(p?.selected).toBe(0)
    expect(p?.question).toBe('Quick safety check: Is this a project you created or one you trust?')
  })

  it('tracks the selected Codex row after moving down', () => {
    const p = parseStartupPrompt([
      '  Hooks need review',
      '',
      '  1. Review hooks',
      '› 2. Trust all and continue',
      "  3. Continue without trusting (hooks won't run)",
      '',
      '  Press enter to confirm or esc to go back'
    ])
    expect(p?.selected).toBe(1)
    expect(p?.options).toHaveLength(3)
  })

  it('offers the actual shortcuts in the Codex hooks overview', () => {
    const p = parseStartupPrompt([
      '  Skills warning from the previous screen',
      '',
      '  Hooks',
      '  Lifecycle hooks from config and enabled plugins.',
      '',
      '  ⚠ 2 hooks need review before they can run.',
      '',
      '  Event                 Installed   Active      Review',
      '  PreCompact            1           0           1',
      '  PostCompact           1           0           1',
      '',
      '  Press t to trust all; enter to review hooks; esc to close'
    ])
    expect(p?.question).toBe('Hooks')
    expect(p?.detail).toContain('2 hooks need review')
    expect(p?.detail).not.toContain('Skills warning')
    expect(p?.options).toEqual(['Review hooks', 'Trust all and continue', 'Back'])
    expect(p?.keys).toEqual(['Enter', 't', 'Escape'])
  })

  it('reads a question with no question mark and a selection on the last row', () => {
    const p = parseStartupPrompt(MCP)
    expect(p?.question).toBe('New MCP server found in this project: probe')
    expect(p?.options).toHaveLength(3)
    expect(p?.selected).toBe(2)
  })

  it('drops description lines under numbered options', () => {
    const p = parseStartupPrompt(NUMBERED_WITH_DETAIL)
    expect(p?.options).toEqual(['No, exit', 'Yes, I accept'])
    expect(p?.selected).toBe(1)
  })

  it('reads a mid-turn tool permission question', () => {
    const p = parseStartupPrompt(["⏺ Writing current date to when.txt", "────────────────────────────────────────", " Bash command", " Tip: auto mode handles these prompts for you", " Write current date to when.txt and show it", "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌", " date > when.txt && cat when.txt", "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and always allow access to /private/tmp/repro from this project", "   3. Yes, and switch to auto mode · auto mode handles these prompts for you", "   4. No", "", " Esc to cancel · Tab to amend"])
    expect(p?.question).toBe('Do you want to proceed?')
    expect(p?.detail).toContain('date > when.txt')
    expect(p?.detail).not.toContain('Tip:')
    expect(p?.options).toHaveLength(4)
    expect(p?.options[3]).toBe('No')
    expect(p?.selected).toBe(0)
  })

  it('reads the read-outside-the-folder question', () => {
    const p = parseStartupPrompt(["────────────────────────────────────────", " Read outside the working directories", "────────────────────────────────────────", " Read(/Users/me/.cache/clipaste/shot.png)", "────────────────────────────────────────", " Auto mode and the sandbox read outside the working directories without asking.", "", " Allow this read outside the working directories?", " ❯ 1. Yes, and keep allowing any reads outside the working directories", "   2. No, and block reads outside the working directories from now on", "   3. No, and ask again next time", "   4. Yes, but ask again next time", "", " Esc to cancel · Tab to amend"])
    expect(p?.question).toBe('Allow this read outside the working directories?')
    expect(p?.options[3]).toBe('Yes, but ask again next time')
  })

  it('does not promote a fragment cut off by the top of the screen to the question', () => {
    const p = parseStartupPrompt(["— treated as possibly protected via rulesets, not assumed unprotected", "  · Trusted cloud buckets left at shipped default (None configured) — no", "bucket names appeared in the recon", "", " ❯ Looks good — save it", "   Discard and exit", "", " Enter to confirm · Esc to cancel"])
    expect(p?.question).toBe('')
    expect(p?.detail).toContain('Trusted cloud buckets')
    expect(p?.options).toEqual(['Looks good — save it', 'Discard and exit'])
  })

  it('sees no question on a plain screen', () => {
    expect(parseStartupPrompt(['> hello', '', '  ? for shortcuts'])).toBeNull()
  })
})

it('keeps a terminal Codex session when desktop threads are listed', () => {
  const home = mkdtempSync(join(tmpdir(), 'mm-codex-startup-'))
  const now = new Date()
  const folder = join(home, '.codex', 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'rollout-desktop.jsonl'), [
    { type: 'session_meta', payload: { id: 'desktop-chat', thread_source: 'user', timestamp: now.toISOString() } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'low' } },
    { type: 'event_msg', timestamp: now.toISOString(), payload: { type: 'task_complete' } }
  ].map((record) => JSON.stringify(record)).join('\n') + '\n')
  const terminal = { label: 'Terminal Codex', since: now.getTime(), facts: { agent: 'codex' }, origin: { tmuxPane: '%96' } }
  const desktopShim = { label: 'Shared desktop shim', since: now.getTime(), facts: { agent: 'codex' } }
  try {
    rescanCodexThreads(home)
    const listed = withCodexThreads([terminal, desktopShim])
    expect(listed).toContain(terminal)
    expect(listed).not.toContain(desktopShim)
    expect(listed.some((s) => s.sessionId === 'desktop-chat')).toBe(true)
    const connected = withCodexThreads([{ ...terminal, sessionId: 'desktop-chat' }])
    expect(connected).toHaveLength(1)
    expect(connected[0].origin).toEqual(terminal.origin)
    expect(connected[0].facts?.model).toBe('GPT 5.6 Sol')
    expect(connected[0].facts?.effort).toBe('low')
    expect(connected[0].lastTurnEndedAt).toBe(now.getTime())
  } finally {
    rmSync(home, { recursive: true, force: true })
    rescanCodexThreads(home)
  }
})
