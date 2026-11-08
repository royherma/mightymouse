import { useId, useRef } from 'react'
import type { InstallableSkin } from '@shared/types'
import { BottomIconRow, KeyPillGrid } from './TouchpadControls'
import { useNotchPath } from './useNotchPath'

/** Width the real deck is designed against. The stage below is laid out at this
 *  width in real deck pixels and then scaled down to the card, so the deck's own
 *  CSS stays the only source of sizing -- nothing here re-specifies a size. */
const DECK_DESIGN_WIDTH_PX = 390

/** A miniature of the pro deck -- the REAL deck, scaled down, not a drawing of it.
 *
 *  It mounts the actual `.proCard` / `.proTouchpad` / `.proControlsCell` markup
 *  and the actual `KeyPillGrid` + `BottomIconRow` components with inert
 *  callbacks. That is the whole design: the deck is markup and CSS, so nothing
 *  about it needs to be live to be LOOKED at.
 *
 *  Why not a hand-drawn miniature (what this replaced): a drawing is a second
 *  source of truth for the deck's anatomy. It shipped as one circle and three
 *  bars next to a pad -- nothing like the real cluster -- and every future change
 *  to the deck would have drifted it again. Real components can't drift.
 *
 *  Why not `TouchpadLayout` itself: it takes ~90 props including live MediaStream
 *  refs, a <video> and IPC callbacks. The control cluster is the part that reads
 *  as "the remote"; the rest is machinery.
 *
 *  Skin selection works exactly as the live deck's does -- a `data-skin`
 *  attribute matched by the existing `.proRoot[data-skin='x']` token blocks -- so
 *  adding a skin is still "one token block + one SKIN_OPTIONS entry" and its
 *  store card paints itself, with zero per-skin preview code.
 *
 *  That data-skin indirection is also why a REMOTE skin needs no code here: its
 *  sanitised token block is served from /_skins.css and matches the same
 *  attribute, so a catalog skin previews exactly like a built-in one.
 *
 *  With one caveat, learned the hard way: tokens alone are not a skin. An IMAGE
 *  skin also needs `data-img-skin`, because the rules that paint pictures --
 *  and the rules that remove the sculpt underneath them -- are selected by that
 *  attribute, not by the presence of a token. A card that stamped only
 *  data-skin therefore inherited every picture token and applied none of them.
 *  Both attributes are stamped below, the second from the `imageSkin` prop the
 *  caller resolves the same way the live deck does. */
export default function SkinPreview({
  skin,
  isLandscape,
  imageSkin
}: {
  skin: InstallableSkin
  isLandscape: boolean
  /** Whether this skin paints pictures. Passed in rather than looked up: a
   *  remote skin's answer lives on its manifest and arrives with the catalog
   *  row this card is built from, so the caller already holds it. */
  imageSkin: boolean
}): React.JSX.Element {
  /* BottomIconRow types micRef as a required ref. The real deck attaches
     press-and-hold listeners through it; here nothing reads it, but the prop is
     not optional so it needs a real ref object rather than a cast. */
  const micRef = useRef<HTMLButtonElement>(null)

  /* The notch is the whole reason the pad reads as part of the deck rather than
     a rectangle laid on top of it: it measures the REAL rects of the two key
     rows and the icon row and carves the pad's edge to hug each one.
     An earlier preview skipped it and squared the pad off at the cluster band
     instead, which left the bottom third of every card as bare deck.
     Running the real hook is both more honest and less
     code than any approximation of it. */
  const padRef = useRef<HTMLDivElement>(null)
  const keyGridRef = useRef<HTMLDivElement>(null)
  const iconRowRef = useRef<HTMLDivElement>(null)
  /* Per-instance clip id. The store mounts four previews beside the live deck
     and the hook's tween paints through document.getElementById, so a shared id
     would have all five write into the first node in the DOM. */
  /* Stripped of non-word characters because useId emits colons (":r0:") and a
     raw colon is invalid inside a url(#...) reference -- the clip silently
     never applies. */
  const notchId = `skinNotch${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const pathId = `${notchId}-path`
  const notchPath = useNotchPath(
    padRef,
    keyGridRef,
    iconRowRef,
    'right',
    /* The preview's cluster sits at the bottom in both orientations -- it never
       exposes the keys-on-top option, so the shipped default is the honest
       value here rather than a prop nobody sets. */
    'bottom',
    pathId
  )

  return (
    <div
      /* 'default' is plain pro wearing only the base cascade, so it carries no
         data-skin value -- exactly like TouchpadLayout's real root. */
      {...(skin === 'default' ? {} : { 'data-skin': skin })}
      /* Same opt-in the live deck stamps, off the same set, so the two cannot
         disagree about what an image skin is. Without it a card carried the
         skin's picture tokens and nothing that reads them -- every image rule in
         theme.css hangs off [data-img-skin] -- so the pad painted its fallback
         colour and the card showed a sculpted deck in the wrong palette, which
         is precisely the "picture of a product you are not using" the
         data-orient comment below refuses to ship. */
      data-img-skin={imageSkin ? '' : undefined}
      /* Pinned light regardless of the viewer's colour-scheme pref. Every
         skin's tokens are built over the LIGHT base (see LIGHT_PINNED_SKINS),
         so a preview inheriting a dark ambient theme would show the plain
         skin's dark palette next to three light ones -- three cards lying
         about what you'd get. Pinning makes all four comparable. */
      data-theme="light"
      /* Both attributes are load-bearing, not decoration. The deck's layout
         rules are scoped to them: .proControlsCell gets its `right` edge only
         from [data-hand], and 27 rules key off [data-orient]. Without these the
         cluster has no horizontal anchor and collapses to the card's left edge.

         data-orient FOLLOWS the real orientation rather than being pinned to
         portrait. Held sideways you are wearing the landscape deck -- a
         different layout, not a rotated one: a 300px side rail, a gutter, the
         cluster on a flank at 46% height. A card showing the portrait deck
         while you hold the phone in landscape is a picture of a product you
         are not currently using, which is the one thing a store card must
         never be. The card's own shape follows in CSS. */
      data-orient={isLandscape ? 'landscape' : 'portrait'}
      /* Declares a fact rather than patching a symptom: this preview renders no
         camera mirror, and the deck already models exactly that case.
         Without it the pad is offset by var(--pro-mirror-w, 55%) to clear a
         pane that does not exist -- App.tsx writes that variable at runtime
         from the live stream, and a preview runs no JS, so the fallback stood.
         The pad was squeezed into ~40% of the deck on the wrong side, with bare
         deck showing where the pad should be.
         Fixed here rather than in CSS because the override would need to beat
         .proRoot[data-orient][data-hand], which is the same specificity and
         declared later -- a fight this attribute wins by simply being true. */
      data-mirror="off"
      data-hand="right"
      className="proRoot skinPreview"
      aria-hidden="true"
    >
      {/* The stage is a full-size deck that the CSS scales down to the card --
          390px wide portrait, 845px landscape (the deck's two design widths).
          Laying out at true size and shrinking is what keeps this an honest
          picture: every proportion inside is the deck's own. */}
      <div className="skinPreviewStage">
        <div className="proCard">
          {/* Same clip wiring as the real deck: userSpaceOnUse because the hook
              builds the path in the pad's own absolute pixels to match the
              rects it measured. */}
          <svg width="0" height="0" aria-hidden="true" focusable="false">
            <defs>
              <clipPath id={notchId} clipPathUnits="userSpaceOnUse">
                {notchPath && <path id={pathId} d={notchPath} />}
              </clipPath>
            </defs>
          </svg>
          <div
            className={`proTouchpad${notchPath ? ' notchReady' : ''}`}
            ref={padRef}
            /* Set inline, not via the .notchReady class: that rule hardcodes
               url(#proNotchDynamic), the live deck's single id, which every
               preview would otherwise clip to. -webkit- included because iOS
               Safari -- the only browser this surface runs in -- still needs
               the prefix for clip-path: url(). */
            style={
              notchPath
                ? {
                    WebkitClipPath: `url(#${notchId})`,
                    clipPath: `url(#${notchId})`
                  }
                : undefined
            }
          />
          <div className="proControlsCell">
            {/* Inert callbacks. `pointer-events: none` on the preview root
                already makes the whole subtree untappable, so these are
                belt-and-braces -- they mean a future change that drops the
                pointer-events rule still can't fire a key press from a store
                card. */}
            <KeyPillGrid pressKey={() => {}} openKeyboard={() => {}} gridRef={keyGridRef} />
            <BottomIconRow
              recording={false}
              handsFree="off"
              handsFreeSpeaking={false}
              micRef={micRef}
              rowRef={iconRowRef}
              toggleAppSwitcher={() => {}}
              appSwitchOpen={false}
              quickSwitchTap={() => {}}
              quickSteps={0}
              settingsOpen={false}
              setSettingsOpen={() => {}}
              openWindowLayouts={() => {}}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

export { DECK_DESIGN_WIDTH_PX }
