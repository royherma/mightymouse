/**
 * The Windows shell: PowerShell, how we quote for it, and the one runner every
 * other Windows impl uses to talk to the OS.
 *
 * SINGLE SOURCE OF TRUTH, same as macos/shell.ts — every spawn site goes through
 * the boundary's `shell` domain so quoting can never drift between them.
 *
 * PowerShell and not cmd.exe: cmd has no way to quote an argument containing
 * both a quote and a caret, no command substitution, and no `&&` before Windows
 * 10 1809. The agent commands we build (adapters.ts) need all three.
 */
import { spawn } from 'child_process'

export const bin = 'powershell.exe'

/**
 * Empty, and that is the whole point: Windows has no Homebrew, and every CLI we
 * resolve is already an absolute path by the time it reaches a command string
 * (see resolve-binary.ts). Prepending anything here would only mask a resolver
 * that failed to do its job.
 */
export const pathPrefix = ''

/**
 * Quote one value as a single PowerShell argument.
 *
 * Single quotes, because a single-quoted PowerShell string is LITERAL — no `$`
 * expansion, no backtick escapes, no subexpressions. The only character with
 * meaning inside one is `'` itself, and it is escaped by doubling. A
 * double-quoted string would expand `$(...)`, which is exactly the injection a
 * quoting function exists to prevent.
 */
export function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Argv that makes `bin` run one command string.
 *
 * -NoProfile: a user's $PROFILE can print banners into stdout we parse, and
 *   costs 100-500ms per spawn.
 * -NonInteractive: a CLI that prompts must fail rather than hang forever on a
 *   console nobody can see.
 * -ExecutionPolicy Bypass: the policy is machine/GPO-set and a Restricted one
 *   would refuse the command outright on a locked-down corporate machine.
 */
export function spawnArgs(cmd: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd]
}

/**
 * Command fragment expanding to the CONTENTS of `path` as ONE argument.
 *
 * -Raw is load-bearing: without it Get-Content returns an ARRAY of lines, and
 * PowerShell joins an array into a native command's argument with SPACES — so
 * every newline in a prompt would silently become a space.
 * -Encoding UTF8 because Windows PowerShell 5.1 otherwise reads the file as the
 * system ANSI codepage and mangles anything non-ASCII the user selected.
 * .TrimEnd() matches `$(cat …)`, which strips trailing newlines on macOS.
 */
export function fileText(path: string): string {
  return `(Get-Content -Raw -Encoding UTF8 ${quote(path)}).TrimEnd()`
}

/** The env CLI children run with. Nothing to prepend — see pathPrefix. */
export function env(): NodeJS.ProcessEnv {
  return { ...process.env }
}

/** The tool line the act-mode system prompt shows the agent. */
export function agentToolHints(): string {
  return '- Use Windows-native tools when possible: `ffmpeg`, `Get-Clipboard`, `Set-Clipboard`, `Start-Process`, `Get-ChildItem`, `magick`, `pdftotext`, `pandoc`.'
}

export function applyLoginShellPath(): void {
  // Nothing to do: the launchd minimal-PATH problem this fixes on macOS has no
  // Windows equivalent — a GUI process inherits the full user + machine PATH.
}

// ── The internal PowerShell runner ──────────────────────────────────────────

/**
 * Long enough for a cold PowerShell start (~400ms) plus a UI Automation query on
 * a busy foreground app, short enough that a beachballing app can't freeze the
 * paste path that awaits it. Mirrors CONFIG.OSASCRIPT_TIMEOUT_MS's role on mac.
 */
const POWERSHELL_TIMEOUT_MS = 5_000

/**
 * -EncodedCommand takes base64 of UTF-16LE, which is how we hand PowerShell a
 * multi-line script with embedded quotes and newlines and have NOTHING re-parse
 * it on the way. Passing the same script as a `-Command` string means the
 * Windows command line, PowerShell's own parser, and cmd's caret rules all get a
 * turn at it first; every one of them is a quoting bug waiting to happen.
 */
function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Run a PowerShell script and resolve its trimmed stdout. The Windows analogue
 * of macos/selection.ts's runAppleScript, timeout semantics included: a hung
 * child is SIGKILLed and the promise rejects, so an awaiting caller degrades
 * instead of freezing.
 *
 * Not part of ShellApi — the contract's shell domain is about spawning the
 * user's CLIs. This is our own OS automation channel, private to platform/windows.
 */
export function runPowerShell(script: string, timeoutMs = POWERSHELL_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    // Force UTF-8 on the way out: PowerShell writes stdout in the console's
    // codepage (437/1252 by default), so a selection with an em dash or any
    // non-Latin text comes back as mojibake without this line.
    const prelude = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n'
    const child = spawn(
      bin,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodeScript(prelude + script)
      ],
      // windowsHide passes CREATE_NO_WINDOW, so no console flashes up AND — the
      // reason it matters here — the child never takes foreground focus away
      // from the app whose selection we are about to read.
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )

    let out = ''
    let err = ''
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8')
    })

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL')
        reject(new Error('powershell timed out'))
      })
    }, timeoutMs)

    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`powershell exited ${code}: ${err.trim()}`))
      })
    })
    child.on('error', (spawnErr) => finish(() => reject(spawnErr)))
  })
}
