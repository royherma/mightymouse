import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The whole feature is one CSS block plus one Escape handler, so the thing
// worth locking is the hide list: a class renamed out from under it fails
// SILENTLY on a HUD nobody is looking at, leaving a control painted over the
// picture with a live focus stop. Both badges shipped under wrapper class names
// that the first draft of this list got wrong.
const CSS = readFileSync(join(__dirname, 'theme.css'), 'utf8')
const TSX = readFileSync(join(__dirname, 'TouchpadLayout.tsx'), 'utf8')
// The snackbars moved into the shared MirrorPane; the root flag they are
// scoped to still lives on the layout, so both files have to be read.
const PANE = readFileSync(join(__dirname, 'MirrorPane.tsx'), 'utf8')

const HIDDEN = [
  'proTouchpad',
  'proControlsCell',
  'proMicSideBtn',
  'proStatus',
  'proBlobs',
  'proAppRingHit',
  'proZoomBarWrap',
  'brandWatermark',
  'chatBtn',
  'remoteMenuBtn',
  'historyBtn',
  'mirrorAudioControl',
  'micInputBadge',
  'toast',
  'reconnectBanner'
]

describe('fullscreen mirror hides everything but the picture', () => {
  for (const cls of HIDDEN) {
    it(`hides .${cls}`, () => {
      // Matches the last selector in the list too, which ends in `{` not `,`.
      expect(CSS).toMatch(
        new RegExp(`\\.proRoot\\[data-mirror-full='on'\\] \\.${cls}\\s*[,{]`)
      )
    })
  }

  it('keeps the video pane visible — it is the only thing left', () => {
    expect(CSS).not.toContain(`.proRoot[data-mirror-full='on'] .proMirrorPane,`)
  })

  // The snackbars are hidden EXCEPT the D-pad mode pill, which is the one thing
  // this mode paints. A blanket `.mirrorSnackbar` in the hide list would take it
  // down with the other two and the toggle would go back to being invisible.
  it('hides the touch-mode and cursor-tracking pills but not the mode pill', () => {
    expect(CSS).toMatch(
      /\.proRoot\[data-mirror-full='on'\] \.mirrorSnackbar:not\(\.isDpadMode\)\s*[,{]/
    )
    expect(PANE).toContain('mirrorSnackbar isDpadMode')
  })

  it('stamps the flag the hide list is scoped to', () => {
    expect(TSX).toContain(`data-mirror-full={fullMirror.active ? 'on' : undefined}`)
  })

  it('no longer stamps a bar-visibility flag — there is no bar to fade', () => {
    expect(TSX).not.toContain('data-mirror-bar')
    expect(CSS).not.toContain('data-mirror-bar')
  })
})
