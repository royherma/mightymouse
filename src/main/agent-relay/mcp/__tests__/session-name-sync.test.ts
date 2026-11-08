/**
 * The shim (not a ~/.claude hook) copies /rename from the transcript into the
 * name file. Hooks in a dotfile ship to nobody; this module ships in
 * mightymouse-code and is what every install actually runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  renameFromTranscript,
  claudeTranscriptPath,
  readPublishedName,
  isManualName,
  publishSessionName,
  syncRenameFromTranscript,
  sessionNameDir,
  sessionScoreDir,
  tailFile
} from '../../../../../npm-shim/mightymouse-code/bin/session-name.js'

const RENAME_LINE =
  '{"type":"system","content":"<local-command-stdout>Session renamed to: kill-other-claude-sessions</local-command-stdout>"}'

describe('renameFromTranscript', () => {
  it('pulls the name out of Claude Code\'s /rename stdout line', () => {
    expect(renameFromTranscript(RENAME_LINE)).toBe('kill-other-claude-sessions')
  })

  it('ignores custom-title without a /rename', () => {
    const blob = '{"type":"custom-title","customTitle":"word-scored-name"}\n'
    expect(renameFromTranscript(blob)).toBe('')
  })

  it('keeps the last /rename when there are two', () => {
    const blob =
      'Session renamed to: first-name</local-command-stdout>\n' +
      'Session renamed to: second-name</local-command-stdout>\n'
    expect(renameFromTranscript(blob)).toBe('second-name')
  })

  it('ignores a tool result that quotes the mark, keeping the real /rename before it', () => {
    const blob =
      RENAME_LINE +
      '\n{"type":"user","content":"name=${line#*\\"Session renamed to: \\"}\\n name=${name%%</local-command-stdout>*}"}\n'
    expect(renameFromTranscript(blob)).toBe('kill-other-claude-sessions')
  })
})

describe('claudeTranscriptPath', () => {
  it('encodes cwd the way Claude Code names the projects folder', () => {
    expect(
      claudeTranscriptPath(
        '/Users/ada',
        '/Users/ada/Desktop/Development/ShowAndTell',
        'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75'
      )
    ).toBe(
      '/Users/ada/.claude/projects/-Users-ada-Desktop-Development-ShowAndTell/abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75.jsonl'
    )
  })

  it('flattens an underscore the way newer Claude Code does', () => {
    expect(
      claudeTranscriptPath('/Users/ada_dev', '/Users/ada_dev/app', 'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75')
    ).toBe(
      '/Users/ada_dev/.claude/projects/-Users-ada-dev-app/abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75.jsonl'
    )
  })

  it('refuses a session id that could escape the directory', () => {
    expect(claudeTranscriptPath('/h', '/cwd', '../etc')).toBe('')
  })
})

describe('syncRenameFromTranscript', () => {
  let home: string
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mm-ssot-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('writes the file and the .manual marker so auto-namers stop', () => {
    const jsonl = join(home, 'session.jsonl')
    writeFileSync(jsonl, RENAME_LINE + '\n')
    expect(
      syncRenameFromTranscript({ home, sessionId: id, transcriptPath: jsonl, full: true })
    ).toBe('kill-other-claude-sessions')
    expect(readPublishedName(sessionNameDir(home), id)).toBe('kill-other-claude-sessions')
    expect(isManualName(sessionScoreDir(home), id)).toBe(true)
  })

  it('is a no-op when the same manual name is already published', () => {
    const jsonl = join(home, 'session.jsonl')
    writeFileSync(jsonl, RENAME_LINE + '\n')
    syncRenameFromTranscript({ home, sessionId: id, transcriptPath: jsonl, full: true })
    expect(
      syncRenameFromTranscript({ home, sessionId: id, transcriptPath: jsonl, full: true })
    ).toBe('')
  })

  it('updates when the user /renames a second time', () => {
    const jsonl = join(home, 'session.jsonl')
    writeFileSync(jsonl, 'Session renamed to: first-name</local-command-stdout>\n')
    syncRenameFromTranscript({ home, sessionId: id, transcriptPath: jsonl, full: true })
    writeFileSync(jsonl, 'Session renamed to: second-name</local-command-stdout>\n')
    expect(
      syncRenameFromTranscript({ home, sessionId: id, transcriptPath: jsonl, full: true })
    ).toBe('second-name')
    expect(readPublishedName(sessionNameDir(home), id)).toBe('second-name')
  })

  it('tail misses a rename buried past 64k; full scan finds it', () => {
    const jsonl = join(home, 'big.jsonl')
    writeFileSync(
      jsonl,
      'Session renamed to: buried-old-rename</local-command-stdout>\n' + 'x'.repeat(80 * 1024)
    )
    expect(renameFromTranscript(tailFile(jsonl))).toBe('')
    expect(
      syncRenameFromTranscript({ home, sessionId: id, transcriptPath: jsonl, full: true })
    ).toBe('buried-old-rename')
  })

  it('copies a live reproducing transcript into a temp HOME, not the real one', () => {
    const real = join(
      process.env.HOME || '',
      '.claude/projects/-Users-royhermannn-new-Desktop-Development-ShowAndTell/abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75.jsonl'
    )
    if (!existsSync(real)) return
    expect(
      syncRenameFromTranscript({
        home,
        sessionId: 'abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75',
        transcriptPath: real,
        full: true
      })
    ).toBe('kill-other-claude-sessions')
    expect(readFileSync(join(home, '.claude/.session-names/abfc7e33-c7b4-402d-ac6c-dfc31f7c5e75'), 'utf8')).toBe(
      'kill-other-claude-sessions'
    )
  })
})

describe('publishSessionName', () => {
  it('creates the directory a first-time install does not have', () => {
    const home = mkdtempSync(join(tmpdir(), 'mm-ssot-pub-'))
    try {
      const names = sessionNameDir(home)
      publishSessionName(names, sessionScoreDir(home), 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', 'from-hook', false)
      expect(readPublishedName(names, 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe('from-hook')
      expect(isManualName(sessionScoreDir(home), 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
