import { Button } from '@shared/ui/Button'
// Always-visible brand mark, top-left corner. Just the mouse emoji -- no
// wordmark alongside it, since .status already carries text (connection
// state) in the top-center and a second text block reads as redundant UI.
// Emoji instead of the SVG glyph: cuter, and needs zero cross-boundary
// import (this bundle is isolated from src/renderer, see vite.config.ts).
//
// Tapping it opens the referral share sheet. It stays visually a watermark
// (no button chrome) -- the affordance is the press-scale, not a border. It's
// a real <button> with a label rather than the aria-hidden <div> it used to
// be, so it's reachable and announced instead of invisible to assistive tech.
export default function BrandWatermark(props: {
  onPress: () => void
  /** Where this sits in the arrow-key ring -- see arrow-focus-nav.ts. Passed by
   *  the host because the mark's ring position is a property of the deck around
   *  it, not of the mark. */
  navGroup?: string
  navOrder?: number
}): React.JSX.Element {
  return (
    <Button
      variant="bare"
      className="brandWatermark"
      data-nav-group={props.navGroup}
      data-nav-order={props.navOrder}
      /* Names the token an image skin paints this from, exactly like the eight
         buttons. Inert on its own -- see skins.ts IMAGE_BUTTON_REGIONS. */
      data-img="mark"
      onClick={props.onPress}
      aria-label="Share MightyMouse"
    >
      <span aria-hidden="true">🐭</span>
    </Button>
  )
}
