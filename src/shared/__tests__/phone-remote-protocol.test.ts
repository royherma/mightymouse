import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/** The phone<->Mac protocol must be declared in exactly ONE file.
 *
 *  This is a text test on purpose, and it is the only thing that can catch the
 *  bug it guards. `server.ts` and `App.tsx` each used to hand-declare their own
 *  copy of both unions; a TS union has zero runtime footprint, so two
 *  structurally similar copies typecheck fine independently and `tsc` stays
 *  silent while they drift. They drifted twice -- most visibly
 *  `appSwitchNext`/`appSwitchClose`, which reached a live handler on the Mac
 *  that no phone could ever reach, undetected for months.
 *
 *  So: fail loudly the moment someone pastes a union back in instead of
 *  importing it. A compile-time check cannot do this. */
const ROOT = join(__dirname, '..', '..', '..')

const CONSUMERS = [
  'src/main/phone-remote/server-runtime.ts',
  'src/main/phone-remote/react/hooks/use-connection.ts'
]

/** A local declaration -- `type X =` / `interface X {`. Deliberately does NOT
 *  match `import type { X }` or `export type { X }`, which are how both files
 *  are supposed to get these now. */
function declares(source: string, name: string): boolean {
  return new RegExp(`^\\s*(export\\s+)?(type\\s+${name}\\s*=|interface\\s+${name}\\b)`, 'm').test(
    source
  )
}

describe('phone remote wire protocol', () => {
  const PROTOCOL_TYPES = ['PhoneRemoteMessage', 'PhoneRemoteEvent', 'DictationEntry']

  it('is declared in the shared file', () => {
    const shared = readFileSync(join(ROOT, 'src/shared/phone-remote-protocol.ts'), 'utf8')
    for (const name of PROTOCOL_TYPES) expect(declares(shared, name), name).toBe(true)
  })

  for (const file of CONSUMERS) {
    it(`${file} imports the protocol instead of re-declaring it`, () => {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const name of PROTOCOL_TYPES) {
        expect(
          declares(source, name),
          `${file} hand-declares ${name}. Import it from @shared/phone-remote-protocol instead -- ` +
            'two copies of a union typecheck fine independently and silently drift.'
        ).toBe(false)
      }
      expect(source).toMatch(/from '(@shared|\.\.\/\.\.\/shared)\/phone-remote-protocol'/)
    })
  }

  // App.tsx stopped speaking the wire when useConnection took the socket, so it
  // is no longer required to import -- but a re-declaration there is still the
  // drift this file exists to stop.
  it('App.tsx does not re-declare the protocol it no longer imports', () => {
    const source = readFileSync(join(ROOT, 'src/main/phone-remote/react/hooks/use-mirror.tsx'), 'utf8')
    for (const name of PROTOCOL_TYPES) expect(declares(source, name), name).toBe(false)
  })

  it('stays free of Node- and DOM-only types so both build configs accept it', () => {
    const shared = readFileSync(join(ROOT, 'src/shared/phone-remote-protocol.ts'), 'utf8')
    // Comments stripped first: they legitimately NAME these things while
    // explaining the wire, and a test that trips over its own prose is a test
    // people delete rather than trust.
    const code = shared.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // The phone bundle has no Node builtins; the main process has no DOM lib.
    // Either kind of import makes the file unusable on one of the two sides --
    // which is the exact false premise ("the phone can't import @shared") that
    // justified hand-copying these unions in the first place.
    expect(code).not.toMatch(/from '(electron|fs|path|os|crypto|child_process|http|https|ws)'/)
    expect(code).not.toMatch(/\bRTC[A-Z]\w*|\bHTMLElement\b|\bHTMLCanvasElement\b/)
  })
})
