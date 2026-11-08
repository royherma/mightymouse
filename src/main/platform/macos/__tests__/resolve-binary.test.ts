import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the OS-touching bits so resolution logic is testable in isolation:
//  - existsSync decides whether a candidate path is "real"
//  - execFileSync stands in for the login-shell `command -v <name>`
const existsSync = vi.fn<(p: string) => boolean>()
const execFileSync = vi.fn<() => string>()

vi.mock('fs', () => ({ existsSync: (p: string) => existsSync(p) }))
vi.mock('child_process', () => ({ execFileSync: () => execFileSync() }))

import { join } from 'path'
import { homedir } from 'os'
import { CONFIG } from '../../../../shared/config'
import { resolveBinary, resolveBinaryVerbose, clearBinaryCache } from '../resolve-binary'

const LOCAL = join(homedir(), '.local', 'bin', 'claude')
const HOMEBREW = '/opt/homebrew/bin/claude'
// Where we drop binaries we downloaded ourselves (ffmpeg, cloudflared).
// Derived from CONFIG, not hardcoded: a staging build appends a suffix to
// APP_NAME, so the literal path differs between builds.
const MANAGED_FFMPEG = join(homedir(), CONFIG.APP_NAME, 'bin', 'ffmpeg')
const HOMEBREW_FFMPEG = '/opt/homebrew/bin/ffmpeg'
const USER_FFMPEG = join(homedir(), '.local', 'bin', 'ffmpeg')

describe('binary-resolver', () => {
  beforeEach(() => {
    existsSync.mockReset()
    execFileSync.mockReset()
    // Resolutions are cached per binary name across calls — clear so each test
    // starts cold rather than seeing a prior test's resolution.
    clearBinaryCache()
  })

  it('uses a valid override without shelling out', () => {
    existsSync.mockImplementation((p) => p === '/opt/claude')
    expect(resolveBinary('claude', '/opt/claude')).toBe('/opt/claude')
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('ignores an override that does not exist and falls through to which', () => {
    // Neither common install dir (opt/homebrew or usr/local) has it, so this
    // must fall all the way through to the login-shell `which`.
    existsSync.mockImplementation((p) => p === '/somewhere/else/claude')
    execFileSync.mockReturnValue('/somewhere/else/claude\n')
    expect(resolveBinary('claude', '/nope/claude')).toBe('/somewhere/else/claude')
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })

  it('ignores an empty/whitespace override and resolves via which', () => {
    existsSync.mockImplementation((p) => p === '/somewhere/else/codex')
    execFileSync.mockReturnValue('/somewhere/else/codex\n')
    expect(resolveBinary('codex', '   ')).toBe('/somewhere/else/codex')
  })

  it('resolves via a common install dir before shelling out to which', () => {
    // /usr/local/bin is one of CONFIG.SHELL_PATH_PREFIX's dirs — resolveBinary
    // should find it directly via existsSync and never touch the login shell.
    existsSync.mockImplementation((p) => p === '/usr/local/bin/codex')
    expect(resolveBinary('codex')).toBe('/usr/local/bin/codex')
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it('resolves via login shell when no common dir has it', () => {
    existsSync.mockImplementation((p) => p === '/somewhere/else/codex')
    execFileSync.mockReturnValue('/somewhere/else/codex\n')
    expect(resolveBinary('codex')).toBe('/somewhere/else/codex')
  })

  it('takes the first line of which output and trims it', () => {
    existsSync.mockImplementation((p) => p === '/real/claude')
    execFileSync.mockReturnValue('  /real/claude  \nsome trailing noise\n')
    expect(resolveBinary('claude')).toBe('/real/claude')
  })

  it('returns null when which points at a path that does not exist', () => {
    existsSync.mockReturnValue(false)
    execFileSync.mockReturnValue('/ghost/claude\n')
    expect(resolveBinary('claude')).toBeNull()
  })

  it('returns null when the shell call throws', () => {
    existsSync.mockReturnValue(false)
    execFileSync.mockImplementation(() => {
      throw new Error('command not found')
    })
    expect(resolveBinary('claude')).toBeNull()
  })

  it('caches a resolution per name and reuses it', () => {
    existsSync.mockImplementation((p) => p === '/somewhere/else/claude')
    execFileSync.mockReturnValue('/somewhere/else/claude\n')
    expect(resolveBinary('claude')).toBe('/somewhere/else/claude')
    expect(resolveBinary('claude')).toBe('/somewhere/else/claude')
    expect(execFileSync).toHaveBeenCalledTimes(1) // second call served from cache
  })

  it('caches a null result too — a miss sticks until the cache is cleared', () => {
    // cache.has(name) is true even when the stored value is null, so a miss is NOT
    // re-resolved on the next call. Caller must clearBinaryCache() (e.g. after the
    // user installs the CLI or edits the override in Settings) to pick up a change.
    existsSync.mockReturnValue(false)
    execFileSync.mockReturnValue('/ghost/claude\n')
    expect(resolveBinary('claude')).toBeNull()
    existsSync.mockReturnValue(true) // "binary now installed" — but cache still holds null
    expect(resolveBinary('claude')).toBeNull()
    expect(execFileSync).toHaveBeenCalledTimes(1) // second call served from cached null
    // Only after a clear does the new state take effect. Once existsSync is
    // stubbed to true for everything, the FIRST priority-dir candidate now
    // "exists" too — resolution short-circuits there rather than reaching which.
    // First priority dir is ~/.local/bin (highest, above homebrew).
    clearBinaryCache()
    expect(resolveBinary('claude')).toBe(join(homedir(), '.local', 'bin', 'claude'))
  })

  it('clearBinaryCache forces a fresh resolution', () => {
    existsSync.mockImplementation((p) => p === '/somewhere/else/claude')
    execFileSync.mockReturnValue('/somewhere/else/claude\n')
    resolveBinary('claude')
    clearBinaryCache()
    resolveBinary('claude')
    expect(execFileSync).toHaveBeenCalledTimes(2)
  })
})

// The whole point of the rework: pick the RIGHT binary across every real-world
// install shape, deterministically, with provenance. Each row is a setup we've
// actually seen or must support.
describe('binary-resolver — setup matrix', () => {
  beforeEach(() => {
    existsSync.mockReset()
    execFileSync.mockReset()
    clearBinaryCache()
  })

  it('two binaries present (~/.local + homebrew) → ~/.local wins (the newer, logged-in one)', () => {
    // This is Roy's actual machine: ~/.local/bin/claude @2.1.207 logged-in vs an
    // older /opt/homebrew/bin/claude @2.0.30 logged-out. Priority must pick ~/.local.
    existsSync.mockImplementation((p) => p === LOCAL || p === HOMEBREW)
    const r = resolveBinaryVerbose('claude')
    expect(r.path).toBe(LOCAL)
    expect(r.source).toBe('priority-dir')
    expect(execFileSync).not.toHaveBeenCalled() // never touched the flaky login shell
  })

  it('homebrew-only → resolves homebrew, no shell', () => {
    existsSync.mockImplementation((p) => p === HOMEBREW)
    const r = resolveBinaryVerbose('claude')
    expect(r.path).toBe(HOMEBREW)
    expect(r.source).toBe('priority-dir')
  })

  it('override always wins even when priority dirs have the binary', () => {
    existsSync.mockImplementation((p) => p === LOCAL || p === HOMEBREW || p === '/custom/claude')
    const r = resolveBinaryVerbose('claude', '/custom/claude')
    expect(r.path).toBe('/custom/claude')
    expect(r.source).toBe('override')
  })

  it('exotic install (nvm/asdf shim on PATH) → login-shell last resort finds it', () => {
    // Not in any priority dir; only the login shell knows the shim path.
    const shim = join(homedir(), '.asdf', 'shims', 'codex')
    existsSync.mockImplementation((p) => p === shim)
    execFileSync.mockReturnValue(`${shim}\n`)
    const r = resolveBinaryVerbose('codex')
    expect(r.path).toBe(shim)
    expect(r.source).toBe('login-shell')
  })

  it('nothing installed → not-found, no crash', () => {
    existsSync.mockReturnValue(false)
    execFileSync.mockReturnValue('')
    const r = resolveBinaryVerbose('claude')
    expect(r.path).toBeNull()
    expect(r.source).toBe('not-found')
  })

  it('login-shell returns a phantom path → validated away → not-found', () => {
    // `which` prints a path that no longer exists (stale hash) — must not trust it.
    existsSync.mockReturnValue(false)
    execFileSync.mockReturnValue('/ghost/claude\n')
    const r = resolveBinaryVerbose('claude')
    expect(r.path).toBeNull()
    expect(r.source).toBe('not-found')
  })

  // The managed-binary dir (~/MightyMouse/bin) sits at a deliberate position in
  // priorityDirs(): below the user's own dirs, above Homebrew. Both halves are
  // product promises, and a reorder would keep every other test green — so they
  // are pinned here.
  describe('managed binary dir ordering', () => {
    it("prefers the USER's own ffmpeg over the one we downloaded", () => {
      existsSync.mockImplementation((p) => p === USER_FFMPEG || p === MANAGED_FFMPEG)
      // "If they have it installed, we earn it" — ours must never shadow theirs.
      expect(resolveBinary('ffmpeg')).toBe(USER_FFMPEG)
    })

    it('prefers our downloaded ffmpeg over Homebrew', () => {
      existsSync.mockImplementation((p) => p === MANAGED_FFMPEG || p === HOMEBREW_FFMPEG)
      expect(resolveBinary('ffmpeg')).toBe(MANAGED_FFMPEG)
    })

    it('finds the downloaded ffmpeg on a Mac with nothing else installed', () => {
      // The whole point: no Homebrew, no user install, and it still resolves
      // without shelling out to a login shell that would find nothing.
      existsSync.mockImplementation((p) => p === MANAGED_FFMPEG)
      execFileSync.mockReturnValue('')
      const r = resolveBinaryVerbose('ffmpeg')
      expect(r.path).toBe(MANAGED_FFMPEG)
      expect(r.source).toBe('priority-dir')
    })
  })
})
