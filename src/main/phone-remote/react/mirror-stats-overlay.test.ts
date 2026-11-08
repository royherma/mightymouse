import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { format, sessionCode } from './mirror-bench'

/** A green typecheck proves nothing here -- the overlay mounts as valid JSX
 *  whether or not its props actually reached it. */
const HOSTS = ['MirrorPane.tsx']

const read = (f: string): string => readFileSync(join(__dirname, f), 'utf8')

describe('mirror stats overlay', () => {
  it.each(HOSTS)('is mounted in %s', (host) => {
    expect(read(host)).toContain('<MirrorStatsOverlay')
  })

  // Presence of the tag does not mean the props reached it, and a host that
  // renders the overlay without the app name reads as "the Mac stopped
  // reporting the app" rather than as a missing prop.
  it.each(HOSTS)('passes the frontmost app name in %s', (host) => {
    expect(read(host)).toContain('appName={appContext?.appName ?? null}')
  })

  // The session code is the whole point of the handle: a spoken report has to
  // reach the log lines. A host that renders the overlay without it shows
  // "#----" forever, which reads as "the session never started".
  it.each(HOSTS)('passes the session code in %s', (host) => {
    expect(read(host)).toContain('sessionCode={benchCode}')
  })

  // Read aloud off the glasses, so a code containing O/0 or I/1 is a report
  // that cannot be grepped back. Sampled rather than asserted on the alphabet
  // constant, which would only restate the source.
  it('mints codes with no ambiguous or vowel characters', () => {
    for (let i = 0; i < 200; i++) {
      const c = sessionCode()
      expect(c).toHaveLength(4)
      expect(c).toMatch(/^[BCDFGHJKLMNPQRTVWXYZ2346789]{4}$/)
    }
  })

  // Every emitted line, including the two degenerate ones -- "#K7QW never got
  // past warming up" is a real report and needs the code to be on that line.
  it('stamps the code on warming-up and no-sample lines', () => {
    expect(format(null, 'K7QW')).toContain('#K7QW')
    expect(format({ elapsedS: 0.5 } as never, 'K7QW')).toContain('#K7QW')
  })

  // Debug instrumentation that ships ON would cover the picture of every user
  // who mirrors, and nothing in the product turns it off. The overlay is ON by
  // default (a bare build:phone-remote is always someone iterating here, and
  // opting IN meant every such build silently dropped the numbers), so what
  // keeps it out of a release is the OPT-OUT chain below -- three links in two
  // files, any one of which shipping the overlay to every user.
  //
  // Asserted as source text, not by calling the flag: vitest does not run
  // vite's `define`, so mirrorStatsOverlayEnabled() is false here for a reason
  // that has nothing to do with what a release bundle does. Reading the chain
  // is the only thing in this process that can actually see it.
  it('is forced OFF down the release build chain', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../../package.json'), 'utf8'))

    // 1. Every packaged target (build:mac, release:mac, CI) funnels through
    //    `build` -- so this is the only line that has to opt out.
    expect(pkg.scripts.build).toContain('build:phone-remote:release')

    // 2. ...and that script is what sets the env var. A release script that
    //    stopped setting it would leave `build` opting out of nothing.
    expect(pkg.scripts['build:phone-remote:release']).toMatch(
      /MM_MIRROR_STATS=0\s+npm run build:phone-remote/
    )

    // 3. ...which only means anything if the define still reads it. `!== '0'`
    //    is load-bearing: flipping it to `=== '1'` silently inverts the
    //    default back and every iterating build loses the overlay again.
    const cfg = readFileSync(join(__dirname, 'vite.config.ts'), 'utf8')
    expect(cfg).toMatch(
      /__MIRROR_STATS_OVERLAY__:\s*JSON\.stringify\(\s*process\.env\.MM_MIRROR_STATS !== '0'\s*\)/
    )
  })

  // Second gate, narrower than the build flag: an iterating build:phone-remote
  // also serves the PHONE, where the numbers are occlusion over the very
  // picture being judged. Asserted as source text for the same reason the
  // release chain is -- jsdom has no 600x600 viewport, so calling the component
  // could only ever prove the false branch.
  it('is gated on the cursorless host, not just the build flag', () => {
    const src = read('MirrorStatsOverlay.tsx')
    expect(src).toContain("useCursorless } from './cursorless-host'")
    expect(src).toContain('if (!mirrorStatsOverlayEnabled() || !cursorless) return null')
  })

  // It renders over a long-press target (mirror touch mode). Eating that
  // gesture would break panning with no visible cause.
  it('never takes the pointer from the pane it covers', () => {
    const css = read('theme.css')
    const block = css.slice(css.indexOf('.mirrorStatsOverlay'))
    expect(block.slice(0, block.indexOf('}'))).toContain('pointer-events: none')
  })
})
