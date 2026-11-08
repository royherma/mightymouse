import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * The "did it break anything" suite for the Kokoro TTS rung.
 *
 * There are real users on a shipped, notarized build. The rung they will never
 * touch must be provably invisible to them, so the load-bearing assertion here is
 * NOT "Kokoro works" — it's that with nothing installed, `resolvedTtsProvider()`
 * returns exactly what it returned before the rung existed, and that every failure
 * mode falls DOWN the ladder to `say` without throwing.
 *
 * Every collaborator is mocked so no real filesystem, 350MB model, or subprocess
 * is involved:
 *  - ensure-kokoro decides installed/supported
 *  - PREFS decides enabled
 *  - execFile stands in for BOTH spawns (kokoro CLI and the `say` floor)
 *
 * Mocking execFile is load-bearing, not tidiness: a real `say` synthesis takes
 * ~4s, so four fall-through cases each spawning one blew the 5s per-test timeout
 * on a busy machine and passed on an idle one. A unit test must not depend on how
 * fast the box is.
 */
const isKokoroAvailable = vi.fn<() => boolean>()
const ensureKokoro = vi.fn<() => string | null>()
const kokoroPython = vi.fn<() => string | null>()
const getKokoroEnabled = vi.fn<() => boolean>()
/** Records every spawn attempt so a test can assert nothing was spawned at all. */
const execFileSpy = vi.fn<(cmd: string, args: string[]) => Error | null>()

vi.mock('../ensure-kokoro', () => ({
  isKokoroAvailable: () => isKokoroAvailable(),
  isKokoroSupportedPlatform: () => true,
  ensureKokoro: () => ensureKokoro(),
  kokoroPython: () => kokoroPython()
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/fake/app',
    getPath: () => '/fake/exe'
  }
}))
vi.mock('../../store/prefs', () => ({
  PREFS: { getKokoroEnabled: () => getKokoroEnabled() }
}))
vi.mock('node:child_process', () => ({
  // tts.ts calls execFile(cmd, args, opts, cb); the callback contract is all it uses.
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    const err = execFileSpy(cmd, args)
    queueMicrotask(() => cb(err))
  }
}))
// Both spawn paths read their output file back; neither file exists under mock.
vi.mock('node:fs/promises', () => ({
  readFile: () => Promise.resolve(Buffer.from('fake-wav-bytes')),
  unlink: () => Promise.resolve()
}))

import { resolvedTtsProvider, speak, TTS_PROVIDER } from '../tts'

/** The pre-Kokoro implementation, verbatim from `main`. The oracle for §5.1. */
function providerOnMain(hasKey: boolean): string {
  if (hasKey) return TTS_PROVIDER.elevenlabs
  return process.platform === 'darwin' ? TTS_PROVIDER.macosSay : TTS_PROVIDER.silent
}

const ORIGINAL_KEY = process.env.ELEVENLABS_API_KEY

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.ELEVENLABS_API_KEY
  // Default posture = every shipped user today: nothing installed, nothing enabled.
  isKokoroAvailable.mockReturnValue(false)
  ensureKokoro.mockReturnValue(null)
  kokoroPython.mockReturnValue(null)
  getKokoroEnabled.mockReturnValue(false)
  // Default: every spawn succeeds. Cases that need a failure opt in per-test.
  execFileSpy.mockReturnValue(null)
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ELEVENLABS_API_KEY
  else process.env.ELEVENLABS_API_KEY = ORIGINAL_KEY
})

describe('resolvedTtsProvider — uninstalled path is byte-identical to main (§5.1)', () => {
  it('returns exactly what main returns when Kokoro is absent, with no key', () => {
    expect(resolvedTtsProvider()).toBe(providerOnMain(false))
  })

  it('returns exactly what main returns when Kokoro is absent, with a key', () => {
    process.env.ELEVENLABS_API_KEY = 'test-key-not-a-real-secret'
    expect(resolvedTtsProvider()).toBe(providerOnMain(true))
  })

  it('stays identical to main when the model is installed but NOT enabled', () => {
    // The kill-switch case: 350MB on disk, toggle off → ladder unchanged.
    isKokoroAvailable.mockReturnValue(true)
    ensureKokoro.mockReturnValue('/fake/kokoro')
    getKokoroEnabled.mockReturnValue(false)
    expect(resolvedTtsProvider()).toBe(providerOnMain(false))
  })

  it('stays identical to main when enabled but NOT installed', () => {
    // Toggle on, download never happened (or was deleted by hand).
    getKokoroEnabled.mockReturnValue(true)
    isKokoroAvailable.mockReturnValue(false)
    expect(resolvedTtsProvider()).toBe(providerOnMain(false))
  })
})

describe('resolvedTtsProvider — the rung resolves only when fully armed', () => {
  it('picks Kokoro when installed AND enabled AND no key', () => {
    isKokoroAvailable.mockReturnValue(true)
    getKokoroEnabled.mockReturnValue(true)
    expect(resolvedTtsProvider()).toBe(TTS_PROVIDER.kokoro)
  })

  it('never outranks a paid ElevenLabs key', () => {
    // They paid for it; an opt-in freebie must not silently override it.
    process.env.ELEVENLABS_API_KEY = 'test-key-not-a-real-secret'
    isKokoroAvailable.mockReturnValue(true)
    getKokoroEnabled.mockReturnValue(true)
    expect(resolvedTtsProvider()).toBe(TTS_PROVIDER.elevenlabs)
  })
})

describe('speak() — every Kokoro failure mode falls through, zero throws (§4.6)', () => {
  type Case = {
    name: string
    available: boolean
    enabled: boolean
    cli: string | null
    /** When set, the mocked spawn of this interpreter fails — the real ENOENT stand-in. */
    spawnFailsFor?: string
    python?: string | null
  }
  const CASES: Case[] = [
    { name: 'not installed', available: false, enabled: true, cli: null, python: null },
    { name: 'not enabled', available: true, enabled: false, cli: '/fake/kokoro', python: '/fake/python' },
    { name: 'enabled but CLI vanished between check and spawn', available: true, enabled: true, cli: null, python: null },
    {
      name: 'spawn fails (bad binary path)',
      available: true,
      enabled: true,
      cli: '/nonexistent/kokoro-cli',
      python: '/nonexistent/kokoro-python',
      spawnFailsFor: '/nonexistent/kokoro-python'
    }
  ]

  for (const c of CASES) {
    it(`${c.name} → resolves without throwing, never returns provider 'kokoro'`, async () => {
      isKokoroAvailable.mockReturnValue(c.available)
      getKokoroEnabled.mockReturnValue(c.enabled)
      ensureKokoro.mockReturnValue(c.cli)
      kokoroPython.mockReturnValue(c.python ?? null)
      if (c.spawnFailsFor) {
        const bad = c.spawnFailsFor
        execFileSpy.mockImplementation((cmd) =>
          cmd === bad ? new Error(`spawn ${bad} ENOENT`) : null
        )
      }

      const result = await speak('Hello there.')

      // The contract: a resolved SpeakResult, never a rejection. Whatever produced
      // it, it is NOT a successful Kokoro synthesis — it fell to the `say` floor.
      expect(result).toBeDefined()
      expect(result.provider).not.toBe(TTS_PROVIDER.kokoro)
      expect(result.provider).toBe(TTS_PROVIDER.macosSay)
      expect(typeof result.mimeType).toBe('string')
    })
  }

  it('empty text is silent and never spawns anything', async () => {
    isKokoroAvailable.mockReturnValue(true)
    getKokoroEnabled.mockReturnValue(true)
    ensureKokoro.mockReturnValue('/fake/kokoro')

    const result = await speak('   ')

    expect(result.audio).toBeNull()
    expect(result.provider).toBe(TTS_PROVIDER.silent)
    expect(ensureKokoro).not.toHaveBeenCalled()
    expect(kokoroPython).not.toHaveBeenCalled()
    expect(execFileSpy).not.toHaveBeenCalled()
  })
})

describe('TTS_PROVIDER — the shape the orchestrator depends on', () => {
  it('keeps every pre-existing provider id unchanged', () => {
    // companion-orchestrator.ts labels stage events with these strings; renaming
    // one is a silent break in the UI, not a type error.
    expect(TTS_PROVIDER.elevenlabs).toBe('elevenlabs')
    expect(TTS_PROVIDER.macosSay).toBe('macos-say')
    expect(TTS_PROVIDER.silent).toBe('silent-no-key')
  })

  it('adds exactly one new id', () => {
    expect(TTS_PROVIDER.kokoro).toBe('kokoro')
    expect(Object.keys(TTS_PROVIDER)).toHaveLength(4)
  })
})
