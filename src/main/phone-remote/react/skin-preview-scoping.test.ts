import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every rule that reaches OUT of the deck's subtree to paint <html>/<body>.
 *
 *  These exist because iOS leaves a band below the visible viewport that no
 *  element inside .proRoot can paint. They are also the only selectors in the
 *  file that a store preview can trigger from outside its own card: SkinPreview
 *  mounts a genuine `.proRoot`, so `body:has(.proRoot)` matched a 180px card and
 *  repainted the entire page in whichever skin sorted last (Roy, on-device
 *  2026-07-31 — the store showed grey and cream columns running the full sheet).
 *
 *  No reset inside .skinPreview can undo this; :has() escapes the subtree by
 *  design. So the exclusion has to be written into every such selector, and this
 *  test is what keeps the next one from shipping without it. */
/* Comments stripped first: this file explains the selectors it declares, so a
   quoted `body:has(.proRoot)` in the prose above the fix reads as a violation. */
const THEME_CSS = readFileSync(join(__dirname, 'theme.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

/* `html:has(` / `body:has(` up to the opening brace. */
const ESCAPING_RULE_RE = /(?:html|body):has\([^{]*?\)(?=\s*\{)/g

describe('skin preview scoping', () => {
  it('has at least one escaping rule, so the test is testing something', () => {
    expect(THEME_CSS.match(ESCAPING_RULE_RE)?.length ?? 0).toBeGreaterThan(0)
  })

  it('excludes .skinPreview from every html/body :has() rule', () => {
    const unscoped = (THEME_CSS.match(ESCAPING_RULE_RE) ?? []).filter(
      (rule) => !rule.includes(':not(.skinPreview)')
    )
    expect(unscoped).toEqual([])
  })

  /* `.proRoot.proRoot` buys (0,2,0) so the PWA/native height rules outrank the
     skin blocks. That also outranks `.proRoot.skinPreview`, so it forced the
     viewport height onto a store card and the preview grew to fill the sheet --
     the aspect-ratio never stood a chance (Roy, on-device 2026-07-31, native
     shell). Any future doubled-class root rule has the same reach. */
  it('excludes .skinPreview from the doubled-class viewport-height rules', () => {
    const unscoped = (THEME_CSS.match(/\.proRoot\.proRoot(?::not\([^)]*\))?/g) ?? []).filter(
      (rule) => !rule.includes(':not(.skinPreview)')
    )
    expect(unscoped).toEqual([])
  })
})
