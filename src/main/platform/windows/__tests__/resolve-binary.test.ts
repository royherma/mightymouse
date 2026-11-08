/**
 * The Windows resolver, tested on the thing a straight port of the macOS one
 * gets wrong: `claude` on Windows is `claude.cmd`, not `claude`, and the
 * extensionless twin npm drops beside it is a shell script Windows cannot
 * execute. A resolver that returns that twin reports "installed" and then every
 * run dies with "%1 is not a valid Win32 application".
 *
 * fs is mocked so the suite can assert a Windows filesystem from ubuntu.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const existsSyncMock = vi.fn<(p: string) => boolean>()
const readdirSyncMock = vi.fn<(p: string) => string[]>()
const execFileSyncMock = vi.fn()

vi.mock('fs', () => ({
  existsSync: (p: string) => existsSyncMock(p),
  readdirSync: (p: string) => readdirSyncMock(p),
  accessSync: vi.fn(),
  constants: { W_OK: 2 }
}))
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args)
}))
vi.mock('os', () => ({ homedir: () => 'C:\\Users\\roy' }))
// The resolver joins paths with `path.join`, which is POSIX on the ubuntu runner
// this suite runs on — so every candidate would come out with forward slashes and
// match nothing. Bind it to the win32 implementation, which is what the code is
// actually running against on the machine it is written for.
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path')
  return { ...actual.win32, default: actual.win32 }
})
vi.mock('../../../../shared/config', () => ({
  CONFIG: { CLAUDE_PATH: '', CODEX_PATH: '', OPENCODE_PATH: '', GEMINI_PATH: '' }
}))

import {
  resolveBinaryVerbose,
  resolveBinary,
  clearBinaryCache,
  resolveBrewBin
} from '../resolve-binary'

/** Every path is absent unless it's in this set. */
function onDisk(...paths: string[]): void {
  const present = new Set(paths)
  existsSyncMock.mockImplementation((p) => present.has(p))
}

beforeEach(() => {
  vi.clearAllMocks()
  clearBinaryCache()
  process.env.APPDATA = 'C:\\Users\\roy\\AppData\\Roaming'
  process.env.LOCALAPPDATA = 'C:\\Users\\roy\\AppData\\Local'
  readdirSyncMock.mockImplementation(() => {
    throw new Error('ENOENT')
  })
  existsSyncMock.mockReturnValue(false)
  execFileSyncMock.mockImplementation(() => {
    throw new Error('not found')
  })
})

describe('suffix probing', () => {
  it('finds claude.cmd, which is what `npm i -g` actually writes', () => {
    onDisk('C:\\Users\\roy\\AppData\\Roaming\\npm\\claude.cmd')
    expect(resolveBinaryVerbose('claude')).toEqual({
      path: 'C:\\Users\\roy\\AppData\\Roaming\\npm\\claude.cmd',
      source: 'priority-dir'
    })
  })

  it('prefers the .exe over the .cmd in the same dir', () => {
    onDisk('C:\\Users\\roy\\.local\\bin\\claude.exe', 'C:\\Users\\roy\\.local\\bin\\claude.cmd')
    expect(resolveBinaryVerbose('claude').path).toBe('C:\\Users\\roy\\.local\\bin\\claude.exe')
  })

  it('never returns the extensionless file — Windows cannot spawn it', () => {
    onDisk('C:\\Users\\roy\\AppData\\Roaming\\npm\\claude')
    expect(resolveBinaryVerbose('claude')).toEqual({ path: null, source: 'not-found' })
  })
})

describe('priority order', () => {
  it('an existing override beats every directory', () => {
    onDisk('D:\\tools\\claude.exe', 'C:\\Users\\roy\\.local\\bin\\claude.exe')
    expect(resolveBinaryVerbose('claude', 'D:\\tools\\claude.exe')).toEqual({
      path: 'D:\\tools\\claude.exe',
      source: 'override'
    })
  })

  it('a non-existent override is ignored rather than trusted', () => {
    onDisk('C:\\Users\\roy\\.local\\bin\\claude.exe')
    expect(resolveBinaryVerbose('claude', 'D:\\gone\\claude.exe').path).toBe(
      'C:\\Users\\roy\\.local\\bin\\claude.exe'
    )
  })

  it('.local\\bin (newest, standalone installer) beats the npm prefix', () => {
    onDisk(
      'C:\\Users\\roy\\.local\\bin\\claude.exe',
      'C:\\Users\\roy\\AppData\\Roaming\\npm\\claude.cmd'
    )
    expect(resolveBinaryVerbose('claude').path).toBe('C:\\Users\\roy\\.local\\bin\\claude.exe')
  })

  it('a version-manager npm is a fallback, never preferred over the global one', () => {
    readdirSyncMock.mockImplementation((p) =>
      p === 'C:\\Users\\roy\\AppData\\Roaming\\nvm' ? ['v18.20.4', 'v20.19.5'] : []
    )
    onDisk(
      'C:\\Users\\roy\\AppData\\Roaming\\npm\\npm.cmd',
      'C:\\Users\\roy\\AppData\\Roaming\\nvm\\v20.19.5\\npm.cmd'
    )
    expect(resolveBinaryVerbose('npm').path).toBe('C:\\Users\\roy\\AppData\\Roaming\\npm\\npm.cmd')
  })

  it('picks the newest nvm-windows version when nothing global exists', () => {
    readdirSyncMock.mockImplementation((p) =>
      p === 'C:\\Users\\roy\\AppData\\Roaming\\nvm' ? ['v18.20.4', 'v20.19.5'] : []
    )
    onDisk(
      'C:\\Users\\roy\\AppData\\Roaming\\nvm\\v18.20.4\\npm.cmd',
      'C:\\Users\\roy\\AppData\\Roaming\\nvm\\v20.19.5\\npm.cmd'
    )
    expect(resolveBinaryVerbose('npm').path).toBe(
      'C:\\Users\\roy\\AppData\\Roaming\\nvm\\v20.19.5\\npm.cmd'
    )
  })
})

describe('where.exe fallback', () => {
  it('takes the first RUNNABLE line, skipping the extensionless twin', () => {
    execFileSyncMock.mockReturnValue('C:\\custom\\claude\r\nC:\\custom\\claude.cmd\r\n')
    onDisk('C:\\custom\\claude', 'C:\\custom\\claude.cmd')
    expect(resolveBinaryVerbose('claude')).toEqual({
      path: 'C:\\custom\\claude.cmd',
      source: 'path-search'
    })
  })

  it('is not reached when a priority dir already answered', () => {
    onDisk('C:\\Users\\roy\\.local\\bin\\codex.exe')
    resolveBinaryVerbose('codex')
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('a where.exe miss (exit 1) is the ordinary not-installed case', () => {
    expect(resolveBinaryVerbose('codex')).toEqual({ path: null, source: 'not-found' })
  })
})

describe('caching', () => {
  it('caches a miss too, so a missing CLI does not re-shell on every call', () => {
    resolveBinary('codex')
    resolveBinary('codex')
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
  })

  it('clearBinaryCache forces a fresh look after an install', () => {
    resolveBinary('codex')
    clearBinaryCache()
    resolveBinary('codex')
    expect(execFileSyncMock).toHaveBeenCalledTimes(2)
  })
})

describe('resolveBrewBin', () => {
  it('is always null — Homebrew does not exist here, and a guess would strand the UI', () => {
    expect(resolveBrewBin()).toBeNull()
  })
})
