/**
 * <mm-phone-demo> — a self-running iPhone that demos the phone remote.
 *
 * ONE custom element, no dependencies. Drop it anywhere:
 *
 *     <mm-phone-demo bundle="/remote/" skins="/skins.json"></mm-phone-demo>
 *
 * What's inside the phone is the REAL phone-remote bundle, not a mockup. A
 * hand-drawn replica of a UI that ships weekly looks right for about a month
 * and then quietly lies; booting react/dist means the skin, the keycap sculpt
 * and the pad are whatever actually shipped.
 *
 * It never opens a socket. `__MM_PREVIEW__` suppresses the disconnected banner
 * (App.tsx:4543) and the harness hides the status line, so a never-connected
 * load looks idle rather than broken. Because nothing here speaks WebSocket it
 * can NEVER trip the single-active-socket kick that would boot a real phone
 * off its session -- this is safe to run while someone is using the app.
 *
 * The loop: tap through the deck, then cycle skins. Autoplays, no controls.
 */

// The bundle lays out for a real iPhone. Render at these CSS pixels and scale
// the iframe, so the app's own media queries fire exactly as on device.
// Scaling the CONTENTS would change the pixel count the app sees and preview a
// layout no phone ever renders.
const PHONE_W = 390
const PHONE_H = 844

// Real iPhone 14/15 Pro insets. env(safe-area-inset-*) is ALWAYS 0 inside a
// desktop iframe, so the header and pad ride up under the island.
//
// Setting --safe-top does NOT fix it: the load-bearing rules call env() at the
// point of use, not the variable (.proTouchpad top, theme.css:4869;
// .proMirrorPane top, :4698). Measured with the var set to 59: pad top was
// still 46px = 0 + band 34 + gap 12. So the override has to restate those
// rules with a literal, which is what SAFE_CSS below does.
const SAFE_TOP = 59
const SAFE_BOTTOM = 34

// The same device turned sideways. Insets do NOT keep their portrait values --
// they rotate with the device, and the app already reads them that way: the
// landscape pad and control cluster take env(safe-area-inset-left/right)
// (theme.css:5916/5923) and a ~10px bottom (:5959, which spells out why
// portrait's 34 is wrong here). Inside an iframe every env() is 0, so those
// rules collapse to the bare --pro-inset and the deck renders flush to the
// bezel: no home-indicator lane along the bottom, and the notch band missing
// from whichever side it rotated to.
const SAFE_SIDE = 59
const SAFE_BOTTOM_LAND = 21

// .proControlsCell's own horizontal padding (theme.css:5085). The cluster box
// runs to the card edge and this padding is what actually sets the visible key
// edge, so the pad has to add it too or the two edges misalign by exactly 10.
const CELL_PAD_X = 10

// 16:10 with a hard height. The real pane takes its height inline from the
// stream's aspect ratio (App.tsx sizeMirrorPane); with no stream the CSS
// placeholder (260px) is a different shape to any Mac display. Declared up
// here because the pad's safe-area override has to clear it.
const MIRROR_H = Math.round((PHONE_W * 10) / 16)

// How much of the host width the turned phone spans. Not 1: a device touching
// both edges reads as clipped, and the drop shadow needs somewhere to land.
const LAND_FILL = 0.94

// The decorative QR on the laptop screen. Not a real code and not meant to be
// scanned -- it is 2s of hero art, and encoding a live pairing URL into the
// landing page would be a claim the demo cannot honour. Drawn as a grid of
// cells so it stays crisp at every width.
//
// Deterministic rather than random: a fresh pattern per page load would make
// the hero flicker differently for every visitor, and screenshot diffing the
// beat sweep would never match twice. The three finder squares are stamped on
// afterwards so it reads unmistakably as a QR at ~60px.
const QR_N = 11
const QR_CELLS = (() => {
  const on = []
  // A cheap deterministic hash -- any fixed pattern would do; this one just
  // avoids hand-writing 121 booleans.
  for (let y = 0; y < QR_N; y++) {
    for (let x = 0; x < QR_N; x++) {
      on.push((x * 7 + y * 13 + ((x * y) % 5)) % 3 === 0 ? 1 : 0)
    }
  }
  // Finder squares: 3x3 ring in three corners, plus the quiet ring around them.
  const stamp = (ox, oy) => {
    for (let y = -1; y <= 3; y++) {
      for (let x = -1; x <= 3; x++) {
        const px = ox + x
        const py = oy + y
        if (px < 0 || py < 0 || px >= QR_N || py >= QR_N) continue
        const edge = x === -1 || y === -1 || x === 3 || y === 3
        const ring = x === 0 || y === 0 || x === 2 || y === 2
        on[py * QR_N + px] = edge ? 0 : ring ? 1 : x === 1 && y === 1 ? 1 : 0
      }
    }
  }
  stamp(0, 0)
  stamp(QR_N - 3, 0)
  stamp(0, QR_N - 3)
  return on
})()

// What the demo "dictates". Short enough to type out inside the beat and still
// be readable at hero size, and it names a real thing MightyMouse does rather
// than being lorem filler.
const DICTATION = 'Summarise this page in three bullets'

// The desk dictation beat types PROSE, not a command: that beat sells plain
// transcription (free, local), so borrowing DICTATION above would say the
// feature is "talk to an AI" -- which is a different feature, one beat later.
// Short because the beat is 1s: the whole line has to land inside it.
const DESK_DICTATION = 'Thanks, that works for me'

// The voice beat's phases, as fractions of the beat. Recording is the longest
// leg because it is the one carrying the waveform; transcribing is deliberately
// short (the product IS fast -- a long spinner would advertise the opposite).
/** Phase marks as fractions of the Mic beat. At its 6000ms these are roughly:
 *  approach 0.5s, hold+waveform 2.2s, think 0.7s, pill 0.9s, toast+typing 1.7s.
 *  Each phase is >= ~0.7s on purpose -- below that two of them read as one
 *  event, which is what made the 3800ms version feel like everything at once. */
const VOICE = { hold: 0.08, release: 0.45, pill: 0.57, toast: 0.72 }

// Voice-beat chrome. Every class here is the REAL one from the app
// (MicWaveform, TranscribePill, TranscriptToast) so the demo inherits the
// shipped look; only the bits React drives from live audio are restated.
//
// All three are position:fixed in theme.css, which inside the iframe resolves
// against the phone's own viewport -- so they land in the right band without
// the demo positioning them itself.
const VOICE_CSS =
  // The waveform is a <canvas> the app paints from real mic levels. There is no
  // audio here, so it is drawn as bars instead -- same 96x52 fixed box, so it
  // occupies exactly the band the real one does.
  // RAISED above the app's own band. The shipped rule puts the waveform and the
  // pill at `--classic-safe-bottom + 20px`, which is the same strip the mic
  // button occupies -- on device that is fine because the two never show at
  // once, but the demo holds the mic DOWN for the whole beat, so the transcript
  // chrome landed on top of the button you are watching being pressed.
  // 132px clears the control cluster with room for the pill's own 52px height.
  // Sized to be READ, not to be tasteful. At 96x52 with 4px bars this was a
  // small red smudge you had to look for; the beat's job is to say "it is
  // listening", so the waveform is the loudest thing on the phone while it runs.
  // The dark plate behind it is what makes it legible over an arbitrary skin --
  // thin red bars on a light cork background had almost no contrast.
  `.mmBars{position:fixed;bottom:calc(var(--classic-safe-bottom) + 168px);left:50%;` +
  `transform:translateX(-50%);width:210px;height:96px;z-index:39;pointer-events:none;` +
  `display:flex;align-items:center;justify-content:center;gap:6px;opacity:0;` +
  `padding:0 18px;border-radius:22px;background:rgba(14,15,20,.72);` +
  `backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.4),` +
  `inset 0 0 0 1px rgba(255,255,255,.09);transition:opacity .16s}` +
  `.mmBars.on{opacity:1}` +
  `.mmBars i{display:block;width:8px;border-radius:4px;background:var(--red-light,#ff6b6b);` +
  // A glow keyed to the same red: at this size flat bars read as a static
  // graphic, and the bloom is what sells them as live level.
  `box-shadow:0 0 12px rgba(255,107,107,.55);height:20%;transform-origin:center}` +
  // Driven by --mmA (set per frame from a synthesised envelope) rather than a
  // CSS animation: the bars have to freeze when the loop is paused or scrubbed,
  // and a keyframe animation would keep running.
  // Wider travel than the old 12->88%: at this height a shallow swing looked
  // like a progress bar rather than a level meter.
  `.mmBars i{height:calc(10% + var(--mmA,0) * 88%)}` +
  // The pill and toast reuse the app's own rules; these only handle the
  // enter/leave, which React does by mounting and unmounting.
  `.micTranscribing.mmFade,.toast.mmFade{opacity:0;transition:opacity .18s}` +
  `.micTranscribing.mmFade.on,.toast.mmFade.on{opacity:1}` +
  // Same raise as the waveform, for the same reason -- the pill replaces the
  // bars in place, so if they don't share a bottom the beat visibly jumps.
  `.micTranscribing.mmFade{bottom:calc(var(--classic-safe-bottom) + 168px)}` +
  // The toast ships at a flat `bottom:140px` (no safe-area term), which already
  // clears the mic. It only needs to clear the RAISED pill, so it moves to a
  // flat 260px -- keeping it in px matches the rule it is overriding instead of
  // mixing units, and the two boxes never overlap while the pill fades out.
  `.toast.mmFade{bottom:260px}` +
  // The transcript lands in the Mac's front window as if it had been typed
  // there -- the payoff of the beat is the words arriving on the COMPUTER, not
  // on the phone.
  `.mmDictation{position:absolute;left:8px;right:8px;bottom:7px;font:600 6.5px/1.5 ` +
  `-apple-system,system-ui;color:rgba(255,255,255,.92);text-align:left;` +
  `background:rgba(20,22,34,.72);border-radius:4px;padding:4px 5px;opacity:0;` +
  `transition:opacity .2s}` +
  `.mmDictation.on{opacity:1}` +
  `.mmDictation b{color:rgb(255,160,80);font-weight:700}` +
  // The caret only blinks while text is still arriving; a caret left blinking
  // under a finished sentence reads as the app still waiting for you.
  `.mmDictation i{display:inline-block;width:3px;height:6.5px;margin-left:1px;` +
  `background:rgb(255,160,80);vertical-align:-1px;animation:mmCaret .7s steps(1) infinite}` +
  `@keyframes mmCaret{50%{opacity:0}}`

// Restate every rule that reads env(safe-area-inset-top) at the point of use.
// Overriding --safe-top alone does nothing for these (see the note above), so
// each selector is repeated here with the literal inset.
//
// The mirror pane is the exception that needs more than a number: React gates
// .proMirrorPane on `mirrorOn`, which is driven by a live WebRTC stream this
// embed will never have. So the pane is INJECTED (see mountMirror) and the app
// only needs to be told the geometry -- data-mirror='on' is what stops the pad
// reclaiming the band the pane occupies.
const SAFE_CSS =
  `:root{--safe-top:${SAFE_TOP}px;--pro-safe-bottom:${SAFE_BOTTOM}px;` +
  `--classic-safe-bottom:${SAFE_BOTTOM}px}` +
  // Portrait-scoped: 59px is the notch band, and rotated it is no longer a TOP
  // quantity. Left unscoped this pushed the landscape header down by a band
  // that had moved to the side.
  `.proRoot[data-orient='portrait'] .status,` +
  `.proRoot[data-orient='portrait'] .brandWatermark,` +
  `.proRoot[data-orient='portrait'] .chatBtn,` +
  `.proRoot[data-orient='portrait'] .historyBtn,` +
  `.proRoot[data-orient='portrait'] .reconnectBanner{top:${SAFE_TOP}px!important}` +
  // The iframe is a real 390x844 / 844x390 box, so its own orientation query is
  // truthful and covers any deck without a data-orient attribute.
  `@media (orientation:portrait){` +
  `.status,.brandWatermark,.chatBtn,.historyBtn,.reconnectBanner{top:${SAFE_TOP}px!important}}` +
  // ── LANDSCAPE ──
  // The side the notch rotated to: .wrap takes rotate(90deg) (:527), which is
  // clockwise, so the portrait TOP edge swings to the RIGHT. The app reads the
  // side insets through env() (theme.css:5916/5923/6058), which an iframe
  // always reports as 0, so the values have to be restated as literals here
  // exactly as the top/bottom pair above is.
  `@media (orientation:landscape){` +
  `:root{--safe-top:0px;--pro-safe-bottom:${SAFE_BOTTOM_LAND}px;` +
  `--classic-safe-bottom:${SAFE_BOTTOM_LAND}px}}` +
  // Restate the two rules that read a SIDE inset, same shape as the theme's own
  // (5916/5923) with env() replaced by the literal. --pro-mirror-w and
  // --pro-inset/--pro-gutter stay as vars so the split point is still the
  // app's, not a number copied out of it.
  // The pad's OUTER edge aligns to the visible key edge, not the notch inset.
  // The app's rule holds the pad ${SAFE_SIDE}px off the notch side, but the key
  // cluster ends at inset+${CELL_PAD_X} (its box is right:0 in the card,
  // theme.css:5087, padded ${CELL_PAD_X}px), so the cork stopped 49px short of
  // the buttons below it -- the user: the pad ends where the buttons end.
  // Measured: keys right 819, island's on-screen strip starts at 827.8, so the
  // aligned edge still clears the island by ~9px.
  `.proRoot[data-orient='landscape'][data-hand='right'] .proTouchpad{` +
  `left:calc(var(--pro-inset) + var(--pro-mirror-w,55%) + var(--pro-gutter))!important;` +
  `right:calc(var(--pro-inset) + ${CELL_PAD_X}px)!important}` +
  `.proRoot[data-orient='landscape'][data-hand='left'] .proTouchpad{` +
  `left:calc(var(--pro-inset) + ${CELL_PAD_X}px)!important;` +
  `right:calc(${SAFE_SIDE}px + var(--pro-inset) + var(--pro-mirror-w,55%) + var(--pro-gutter))!important}` +
  // The cluster shares the pad's bottom edge by definition (theme.css:5959), so
  // both must read the same expression or a dead band opens under the buttons.
  // The PAD half of that pair was missing, and it is the reported bug: the
  // landscape rule is `bottom: env(safe-area-inset-bottom, 10px)`, and a fallback
  // only fires when env() is UNSUPPORTED -- in an iframe it is supported and
  // returns 0, so the fallback never applies and the pad ran to the bezel.
  // Measured before: pad bottom 391 on a 390 root (-1), cell bottom 370 (+20).
  // The pad overhanging is what fills the gap under the mic, which reads as the
  // buttons having no safe zone -- they always did.
  // The mirror/screenshare pane is the THIRD box on this edge and it reads the
  // same dead env() (theme.css:6253+). Measured at -1 alongside the pad, so the
  // screenshare surface ran to the bezel too. All three boxes
  // that touch the bottom edge in landscape restate it here, together, because
  // fixing them one at a time is what produced two rounds of "still not fixed".
  `.proRoot[data-orient='landscape'] .proTouchpad,` +
  `.proRoot[data-orient='landscape'] .proMirrorPane,` +
  `.proRoot[data-orient='landscape'] .proControlsCell{` +
  `bottom:${SAFE_BOTTOM_LAND}px!important}` +
  // PORTRAIT ONLY, both of them. In landscape the mirror is a side rail whose
  // top and width the app already derives from the inset (theme.css:6253+), and
  // the pad sits BESIDE it rather than under it -- so a portrait "clear the
  // pane vertically" rule would push the pad off the bottom of the screen.
  `.proRoot[data-orient='portrait'] .proMirrorPane{top:${SAFE_TOP}px!important}` +
  // With the mirror up the pad has to clear the PANE, not the header -- the
  // app normally gets there by giving .proTouchpad an inline top from the
  // pane's measured height (App.tsx), which only runs for a real stream.
  // Measured without this: pad top 112 vs pane bottom 304, so the pad spent
  // 192px underneath the video.
  `.proRoot[data-orient='portrait'][data-mirror='on'] .proTouchpad{` +
  `top:calc(${SAFE_TOP}px + ${MIRROR_H}px + var(--pro-header-gap))!important}` +
  `.proRoot[data-orient='portrait'][data-mirror='off'] .proTouchpad{` +
  `top:calc(${SAFE_TOP}px + var(--pro-header-band) + var(--pro-header-gap))!important}`

// The Mac inside the mirror. Everything here is scoped under .mmFakeMac so it
// can never touch the real deck; .proMirrorPane itself is left to the app's own
// stylesheet, which is the whole reason the pane is injected into the app's
// document rather than drawn in the shadow root.
//
const MIRROR_CSS =
  // Portrait-scoped: landscape sizes the rail from aspect-ratio in CSS, and a
  // hard height there would fight it.
  `.proRoot[data-orient='portrait'] .proMirrorPane{height:${MIRROR_H}px!important}` +
  // The mirror POPS IN rather than being there on load. the user: it should arrive
  // after about half a second, so the viewer sees the phone first and then
  // watches the Mac land on it -- a screen that is already mirrored on frame 1
  // reads as a static screenshot and gives away nothing about what the product
  // does.
  //
  // The BOX animates too, not just the contents. Before the mirror lands the
  // pad is full height -- exactly what the app looks like with mirroring off --
  // and the arriving pane pushes it down. An earlier version faded only
  // .mmFakeMac inside a box that was always MIRROR_H tall, which kept the pad
  // permanently short and lost the "the trackpad is the main thing until your
  // Mac shows up" read.
  `.proRoot[data-orient='portrait'][data-mirror='off'] .proMirrorPane{` +
  `height:0!important;opacity:0}` +
  `.proRoot[data-orient='portrait'] .proMirrorPane{` +
  `transition:height .38s cubic-bezier(.22,1.18,.36,1),opacity .24s ease-out}` +
  `.proRoot[data-orient='portrait'] .proTouchpad{` +
  `transition:top .38s cubic-bezier(.22,1.18,.36,1)}` +
  `.proMirrorPane .mmFakeMac{opacity:0;transform:scale(.94);transform-origin:50% 42%;` +
  `transition:opacity .34s ease-out,transform .46s cubic-bezier(.22,1.18,.36,1)}` +
  `.proMirrorPane.mmLive .mmFakeMac{opacity:1;transform:none}` +
  `.mmFakeMac{position:absolute;inset:0;overflow:hidden;` +
  `background:linear-gradient(160deg,#3b2f4a,#1e2340 55%,#122031)}` +
  // Menu bar + traffic lights: the two cues that say "macOS" at 200px wide.
  `.mmFakeMac .mmBar{position:absolute;top:0;left:0;right:0;height:15px;` +
  `background:rgba(255,255,255,.16);backdrop-filter:blur(6px);display:flex;` +
  `align-items:center;gap:7px;padding:0 7px;font:600 8px/1 -apple-system,system-ui;` +
  `color:rgba(255,255,255,.92)}` +
  `.mmFakeMac .mmBar .sp{flex:1}` +
  // Big enough to read as "a Mac with something open" at hero size. Measured at
  // 64%/70%: a 248x171 window in a 388x244 pane left a navy L of empty desktop
  // down two sides and the mirror read as mostly wallpaper.
  `.mmWin{position:absolute;left:5%;top:13%;width:80%;height:80%;border-radius:7px;` +
  `background:#f7f5f2;box-shadow:0 8px 22px rgba(0,0,0,.42);overflow:hidden;` +
  `opacity:0;transform:scale(.97);transition:opacity .1s,transform .1s}` +
  `.mmWin.on{opacity:1;transform:none}` +
  // Each app is offset a little so a switch reads as a different window, not a
  // repaint of the same one.
  `.mmWin.app2{left:14%;top:18%;width:80%}` +
  `.mmWin.app3{left:9%;top:10%;width:86%;height:84%}` +
  `.mmWin .mmTitle{height:15px;display:flex;align-items:center;gap:4px;padding:0 6px;` +
  `background:#e8e3dc;font:600 7.5px/1 -apple-system,system-ui;color:#6b6259}` +
  `.mmWin .mmDot{width:5px;height:5px;border-radius:50%;background:#d9d3ca}` +
  `.mmWin .mmDot.r{background:#ff5f57}.mmWin .mmDot.y{background:#febc2e}` +
  `.mmWin .mmDot.g{background:#28c840}` +
  // Real Dock icons ship their own transparent margin, so 11px reads as ~9.
  `.mmWin .mmTIco{width:11px;height:11px;margin-left:2px}` +
  `.mmWin .mmBody{padding:7px 8px;display:flex;flex-direction:column;gap:4px;height:100%}` +
  // Browser: URL pill, hero block, three cards.
  `.mmUrl{display:flex;align-items:center;gap:4px;height:11px;border-radius:99px;` +
  `background:#eae5de;padding:0 6px;font:600 6px/1 -apple-system,system-ui;color:#8a8078}` +
  `.mmUrl i{width:4px;height:4px;border-radius:50%;background:#3fbf8f;flex:none}` +
  `.mmHero{height:40%;border-radius:4px;` +
  `background:linear-gradient(120deg,#ffd9b0,#ffb473 60%,#8fd6c4)}` +
  `.mmCols{display:flex;gap:4px;flex:1}` +
  `.mmCols i{flex:1;border-radius:3px;background:#ece7e0}` +
  // Spotify: dark player -- now-playing row, track list, green progress bar.
  // The window and title bar go dark too; the contrast against the two light
  // windows is what sells the arrival.
  // The 1px ring keeps the window's edge readable against the pane's own dark
  // gradient -- without it the whole mirror just "goes dark".
  `.mmWin.app3{background:#181818;box-shadow:0 8px 22px rgba(0,0,0,.42),` +
  `0 0 0 1px rgba(255,255,255,.14)}` +
  `.mmWin.app3 .mmTitle{background:#0f0f0f;color:#b3aea6}` +
  `.mmSpot{display:flex;flex-direction:column;gap:5px;height:100%}` +
  `.mmNow{display:flex;gap:5px;align-items:center}` +
  `.mmArt{width:26px;height:26px;border-radius:3px;flex:none;` +
  `background:linear-gradient(135deg,#7c5cff,#ff7ab6)}` +
  `.mmTrk{display:flex;flex-direction:column;gap:3.5px;flex:1}` +
  `.mmTrk i{height:4px;border-radius:2px;background:#4a4a4a}` +
  `.mmTrk i.t{width:55%;background:#e6e6e6}.mmTrk i.a{width:34%}` +
  `.mmList{display:flex;flex-direction:column;gap:4px;flex:1;margin-top:2px}` +
  `.mmList i{height:7px;border-radius:2px;background:#333}` +
  `.mmList i.on{background:#1db95445;outline:1px solid #1db95488}` +
  `.mmProg{height:4px;border-radius:2px;background:#4a4a4a;position:relative;` +
  `margin-top:auto;margin-bottom:16px}` +
  `.mmProg i{position:absolute;left:0;top:0;bottom:0;width:55%;border-radius:2px;` +
  `background:#1ed760}` +
  // Chat: alternating bubbles + a composer.
  `.mmChat{display:flex;flex-direction:column;gap:4px;height:100%}` +
  `.mmMsg{height:9px;border-radius:6px;width:56%}` +
  `.mmMsg.them{background:#e9e4dc;align-self:flex-start}` +
  `.mmMsg.me{background:#ffb473;align-self:flex-end}` +
  `.mmMsg.sm{width:38%}.mmMsg.lg{width:66%;height:14px}` +
  `.mmField{margin-top:auto;height:11px;border-radius:99px;background:#f0ebe4;` +
  `border:1px solid #e3ddd4}` +
  // The Mac's own pointer, driven from the same drag that moves the finger.
  `.mmCursor{position:absolute;width:9px;height:9px;z-index:6;` +
  `transform:translate(-1px,-1px);transition:none;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.5))}` +
  // The cursor companion's comet, ported from CursorApp.tsx renderComet(). The
  // orb and the tail are separate absolutely-positioned nodes for the same
  // reason they are in the app: the tail rotates about its own left edge while
  // the head only scales, so one element cannot carry both transforms.
  `.mmComet{position:absolute;top:0;left:0;width:20px;height:20px;` +
  `margin-left:-10px;margin-top:-10px;border-radius:50%;z-index:5;` +
  `transform-origin:center center;will-change:transform,filter;pointer-events:none}` +
  `.mmCometTail{position:absolute;top:0;left:0;width:40px;height:11px;` +
  `margin-top:-5.5px;border-radius:6px;z-index:4;transform-origin:left center;` +
  `will-change:transform,opacity;pointer-events:none}` +
  // Cmd-Tab overlay.
  // Tiles are 40px, not 26 -- at hero size the old ones were unreadable specks.
  // Transitions are .1s: this overlay has to feel like a keystroke landed.
  `.mmSwitcher{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.94);` +
  `display:flex;gap:8px;padding:9px 11px;border-radius:13px;background:rgba(22,22,28,.78);` +
  `backdrop-filter:blur(10px);opacity:0;transition:opacity .1s,transform .1s;z-index:7}` +
  `.mmSwitcher.on{opacity:1;transform:translate(-50%,-50%) scale(1)}` +
  // Tiles hold real Dock icons (which carry their own margin), so the tile
  // itself is transparent and selection is the macOS rounded-rect fill, not an
  // outline around a coloured chip.
  `.mmTile{width:40px;height:40px;border-radius:9px;display:grid;place-items:center;` +
  `background:transparent;transition:background .08s}` +
  `.mmTile img{width:38px;height:38px;display:block}` +
  `.mmTile.sel{background:rgba(255,255,255,.3)}`

// The apps the switcher cycles. Real app icons (extracted from the installed
// apps' own .icns, same pipeline as src/main/capture/app-icon.ts) -- a
// recognisable Dock icon is what makes the Cmd-Tab beat land; generic glyphs
// read as a mockup. Only apps with a `kind` get a window; the last three are
// switcher-only, like the rest of a real Cmd-Tab row. Each windowed app gets a
// DIFFERENT body treatment, not just a different title -- at hero size a window
// is ~250px wide and three grey-line mockups are indistinguishable, so the
// switch would read as a flicker rather than a change of app.
const MAC_APPS = [
  { key: 'app1', name: 'Chrome', icon: '/demo-icons/chrome.png', kind: 'browser' },
  { key: 'app2', name: 'Slack', icon: '/demo-icons/slack.png', kind: 'chat' },
  { key: 'app3', name: 'Spotify', icon: '/demo-icons/spotify.png', kind: 'music' },
  { key: 'notion', name: 'Notion', icon: '/demo-icons/notion.png' },
  { key: 'figma', name: 'Figma', icon: '/demo-icons/figma.png' },
  // Deliberately last and deliberately window-less: MightyMouse sits in the row
  // as one of the apps already running, which is the claim. Giving it a window
  // would make the demo about looking AT MightyMouse rather than through it.
  { key: 'mm', name: 'MightyMouse', icon: '/demo-icons/mightymouse.png' }
]

const MAC_AGENTS = [
  { name: 'Music', glyph: '♪', tint: '#d97757', task: 'Your evening mix' },
  { name: 'Movie', glyph: '▶', tint: '#0d0d0d', task: 'Paused at 42:10', ask: true }
]

/** Body markup per app kind. */
function macBody(kind) {
  if (kind === 'browser') {
    return (
      `<div class="mmUrl"><i></i><span>getmightymouse.com</span></div>` +
      `<div class="mmHero"></div>` +
      `<div class="mmCols"><i></i><i></i><i></i></div>`
    )
  }
  if (kind === 'music') {
    // Spotify-shaped: dark surface, album art + track lines, a green progress
    // bar. The dark window IS the tell -- the other two windows are light.
    return (
      `<div class="mmSpot">` +
      `<div class="mmNow"><i class="mmArt"></i>` +
      `<div class="mmTrk"><i class="t"></i><i class="a"></i></div></div>` +
      `<div class="mmList"><i class="on"></i><i></i><i></i><i></i></div>` +
      `<div class="mmProg"><i></i></div>` +
      `</div>`
    )
  }
  return (
    `<div class="mmChat">` +
    `<div class="mmMsg them"></div><div class="mmMsg me"></div>` +
    `<div class="mmMsg them sm"></div><div class="mmMsg me lg"></div>` +
    `<div class="mmField"></div></div>`
  )
}

// The cursor companion's comet palette. Ported from CursorApp.tsx, which reads
// CONFIG.THEME_TOKENS.accent and .cyan.
//
// Note the constants there are still NAMED BLUE/CYAN from an older palette --
// the values they resolve to today are brand orange and teal. Copied by value
// on purpose: an actually-blue comet would be off-brand, and this file cannot
// import from src/shared.
const COMET_A = [255, 160, 80]
const COMET_B = [120, 210, 190]
const mixRgb = (a, b, t) =>
  `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)}, ${Math.round(a[1] + (b[1] - a[1]) * t)}, ` +
  `${Math.round(a[2] + (b[2] - a[2]) * t)})`

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t)

/* Trackpad heat map. 22 pools at ~1.1s of cooling is roughly a second of
   visible history at demo drag speeds -- long enough to read the shape of the
   gesture, short enough that the pad never looks permanently smeared. */
const HEAT_POOL = 22
const HEAT_LIFE = 1100
const HEAT_MIN_STEP = 5 // px between stamps; below this, dwelling stacks in place

/** Paint one comet (head + tail) at a pixel position, from CursorApp.tsx
 *  renderComet(). Shared by BOTH comets: the Mac pointer in the mirror, and the
 *  one under the finger on the trackpad. the user: the flare "is kind of our default
 *  thing" and belongs on the pad too, not just the screen.
 *
 *  `wave` is the app's idle breathing. The first port of this dropped it, which
 *  left the comet perfectly dead whenever the pointer stopped -- the app's never
 *  is. Period matches CursorApp's own pulse.
 */
const paintComet = (head, tail, px, py, sp, angleDeg) => {
  if (!head) return
  const wave = 0.5 + 0.5 * Math.sin(performance.now() / 380)
  const speedN = Math.min(sp / 22, 1)
  const tint = mixRgb(COMET_A, COMET_B, speedN)
  const glow = 12 + wave * 8 + speedN * 22
  head.style.transform = `translate3d(${px}px, ${py}px, 0) scale(${1 + wave * 0.16 + speedN * 0.35})`
  head.style.background = tint
  head.style.filter = `drop-shadow(0 0 ${glow}px ${tint}) drop-shadow(0 0 ${glow * 0.5}px ${tint})`
  if (!tail) return
  const len = 28 + speedN * 120
  tail.style.opacity = String(0.45 + speedN * 0.5)
  tail.style.transform = `translate3d(${px}px, ${py}px, 0) rotate(${angleDeg + 180}deg) scaleX(${len / 40})`
  tail.style.background = `linear-gradient(90deg, ${tint} 0%, ${mixRgb(COMET_A, COMET_B, speedN * 0.5)} 40%, transparent 100%)`
}

/** Sets the preview flags inside the demo iframe; see boot(). Bump ?v= with the file. */
const PREVIEW_SCRIPT = '/phone-demo-preview.js?v=20261105b'

class MMPhoneDemo extends HTMLElement {
  connectedCallback() {
    this.bundleUrl = this.getAttribute('bundle') || '/dist/'
    this.skinsUrl = this.getAttribute('skins') || './skins.json'
    // Honour the OS preference. Autoplay is the default because the whole
    // point is that it explains itself unattended, but "I get motion sick"
    // outranks that -- reduced motion gets a still of the deck.
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    // ?demo-debug turns the geometry outlines on. The markup must NOT carry a
    // hardcoded `debug` -- it ships to prod and paints boxes over the hero --
    // so the URL is the only switch. Set before build() so the shadow CSS,
    // which gates on :host([debug]), sees the attribute on first paint.
    if (new URLSearchParams(location.search).has('demo-debug')) {
      this.setAttribute('debug', '')
    }
    this.cancelled = false
    this.paused = false
    // Read by the render tick but never yet written: the tick bar is display-only
    // so far. Declared rather than dropped -- render()'s guard and every
    // "scrub backwards" invariant in this file are what a scrubber would attach to.
    this.scrubbing = false
    // Explicitly a boolean. Left undefined, fit()'s classList.toggle('land',
    // undefined) becomes a bare toggle -- the first pre-boot fit() flipped the
    // class ON and the loading phone lay sideways until the first beat stood
    // it back up, live on screen.
    this.landscape = false
    this.build()
    this.start()
    this.startDebugReadout()
  }

  disconnectedCallback() {
    this.cancelled = true
    this.io?.disconnect()
    if (this.dbgTimer) clearInterval(this.dbgTimer)
  }

  // Every box that touches an edge, measured against the edge it must not
  // cross. Only the deltas are shown: a rect dump is unreadable at a glance and
  // the question is always "how far past the line is it", never "where is it".
  // Runs on an interval rather than per-frame -- the numbers only move when a
  // beat changes, and a rAF loop here would fight the demo's own animation.
  startDebugReadout() {
    const out = this.$('.dbgReadout')
    if (!out || this.dbgTimer) return
    const px = (n) => (Math.round(n * 10) / 10).toFixed(1)
    // A gap is GOOD when the box stays inside its edge. Red is the failure the
    // outlines could never show: a negative number, i.e. hanging over.
    const row = (label, gap) => {
      const t = gap < 0 ? 'i' : 'b'
      return `<u>${label.padEnd(15)}</u> <${t}>${px(gap).padStart(7)}</${t}>\n`
    }
    const tick = () => {
      if (!this.hasAttribute('debug')) {
        out.textContent = ''
        return
      }
      let d = null
      try {
        d = this.frame && this.frame.contentDocument
      } catch {
        /* cross-origin */
      }
      const root = d && d.querySelector('.proRoot')
      if (!root) {
        out.innerHTML = '<u>waiting for bundle…</u>'
        return
      }
      const R = root.getBoundingClientRect()
      const land = root.getAttribute('data-orient') === 'landscape'
      let s = `<u>${land ? 'LANDSCAPE' : 'PORTRAIT'}  ${px(R.width)}x${px(R.height)}</u>\n`
      s += `<u>gap to safe edge, px</u>\n`
      // The three boxes that share the bottom edge in landscape. All three read
      // the same dead env() in theme.css, and all three were at -1.
      for (const [label, sel] of [
        ['pad bottom', '.proTouchpad'],
        ['mirror bottom', '.proMirrorPane'],
        ['cell bottom', '.proControlsCell']
      ]) {
        const el = d.querySelector(sel)
        if (el) s += row(label, R.bottom - el.getBoundingClientRect().bottom)
      }
      const pad = d.querySelector('.proTouchpad')
      if (pad) {
        const p = pad.getBoundingClientRect()
        s += row('pad right', R.right - p.right)
        s += row('pad left', p.left - R.left)
        s += row('pad top', p.top - R.top)
      }
      // The island is a SHELL element, not an iframe one, so it is measured in
      // page space against the screen it must not cover.
      const isl = this.$('.island'),
        scr = this.$('.screen')
      if (isl && scr) {
        const I = isl.getBoundingClientRect(),
          S = scr.getBoundingClientRect()
        // How much of the pill lies ON the display. Rotation moves which screen
        // edge it sits against, so the overlap is taken on the axis the phone is
        // long in rather than assuming an edge. A real island straddles the
        // edge, so a few px is right and 20+ means it is adrift on the screen.
        const over = land ? Math.max(0, S.right - I.left) : Math.max(0, I.bottom - S.top)
        s += `<u>island on screen</u>  ${over > 12 ? `<i>${px(over).padStart(6)}</i>` : `<b>${px(over).padStart(6)}</b>`}\n`
      }
      out.innerHTML = s
    }
    tick()
    this.dbgTimer = setInterval(tick, 400)
  }

  build() {
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <style>
        /* Height, not width, is the binding constraint in a hero: at the width
           the grid hands over, a 390x844 phone runs past the fold. So the host
           takes a max-height and the phone is sized FROM it, staying centred in
           whatever width it was given. Measured: 330px wide -> 714px tall, in a
           slot with ~540px. */
        /* --mm-scene is the ONE size term for this component: the phone's
           height, and everything scaled to it. Every box that must stay in
           proportion reads this, never a percentage of some parent that only
           coincidentally matches. */
        :host { display:block; container-type:inline-size;
                --mm-max-h:520px; --mm-cap-h:34px; --mm-hud-lane:30px;
                --mm-scene:min(var(--mm-max-h), calc(100cqw * ${PHONE_H} / ${PHONE_W})); }
        /* The host box is phone + caption strip. The caption lives INSIDE it so
           the component never writes outside its own bounds -- a hero slot
           can't be expected to leave room for an overhang it can't see. */
        /* The stack reserves the PORTRAIT height for the whole loop. Letting it
           collapse when the phone turns would bounce the caption (and any hero
           copy below it) up and down twice a loop. The phone stays vertically
           centred in that fixed box, so the rotation reads as the device
           turning in place rather than the layout resizing around it. */
        /* padding-top is the HUD's lane. The pill is absolutely positioned at
           top:0, so without reserved space it would sit over the phone (or get
           clipped by the host) instead of above it. */
        .stack { position:relative; display:flex; flex-direction:column;
                 align-items:center; justify-content:center;
                 padding-top:var(--mm-hud-lane); }
        /* The wrap is the PHONE's own box: portrait aspect, sized by height.
           It sits inside a SQUARE lane (.wrapLane) because a phone that turns
           sweeps a square -- its long edge is vertical in portrait and
           horizontal in landscape, so the only box that contains both without
           the layout resizing is one as wide as the phone is tall. Reserving
           the portrait silhouette instead was what forced landscape to shrink:
           the rotated long edge had nowhere sideways to go, the fill scale hit
           its clamp, and the turned phone came out SMALLER than the upright
           one. Square lane, and landscape can finally grow into it.

           The lane is square in WIDTH only. Reserving a square HEIGHT too would
           leave a portrait phone floating in a box far taller than itself and
           push the caption a lane-width down the page. Height still tracks the
           portrait phone; the extra room landscape needs is horizontal. */
        /* Width is stated in the SAME terms as height rather than via
           aspect-ratio:1 -- as a grid item the lane sizes to its content, and
           an aspect-ratio with an auto width just loses to the 240px phone
           inside it. Repeating the expression is what actually makes it
           square, and square is the point: it is the horizontal room the
           rotated phone grows into. */
        .wrapLane { position:relative; display:grid; place-items:center;
                    height:var(--mm-scene); width:var(--mm-scene);
                    max-width:100%; flex:none; }

        /* ── debug boxes: <mm-phone-demo debug> ──
           Four boxes share this stage and none of them is obviously the one a
           given rule resolves against, which is exactly how a width cap ends up
           measured off the wrong parent. Outlines, not backgrounds, so the demo
           underneath stays readable while the boxes are up.
             RED    host      -- what % and cqw actually resolve against
             BLUE   wrapLane  -- the square the rotated phone grows into
             GREEN  wrap      -- the phone itself, what the eye compares to
             ORANGE cap       -- the flashcard
           The magenta line is the host's centre: if the card is centred, its
           box straddles that line. */
        :host([debug]) { outline:2px solid rgba(255,0,0,.55); outline-offset:-2px; }
        :host([debug]) .wrapLane { outline:2px solid rgba(0,110,255,.65); }
        :host([debug]) .wrap { outline:2px solid rgba(0,190,60,.85); }
        :host([debug]) .cap { outline:2px dashed rgba(255,60,0,.95); }
        :host([debug]) .stack::after {
          content:''; position:absolute; left:50%; top:0; bottom:0; width:1px;
          background:rgba(255,0,220,.7); z-index:99; pointer-events:none;
        }
        /* Live safe-edge readout. Outlines alone cannot answer "is this 20px
           gap the one the CSS asked for?", and every landscape bug in this file
           so far has been a box overhanging the screen by a number nobody could
           see -- the pad and the mirror pane both sat at -1 for months. Each row
           is MEASURED from real rects inside the iframe, never recomputed from
           the constants, so when a row disagrees with the CSS the row is right.
           Green = clear, red = past the edge. */
        .dbgReadout { display:none; }
        :host([debug]) .dbgReadout {
          display:block; position:absolute; top:0; left:calc(100% + 10px);
          min-width:250px; z-index:100; pointer-events:none;
          font:10.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
          background:rgba(12,14,18,.93); color:#dfe5ee; padding:8px 10px;
          border-radius:7px; box-shadow:0 4px 18px rgba(0,0,0,.4);
          white-space:pre;
        }
        .dbgReadout b { color:#7ee2a8; font-weight:600; }
        .dbgReadout i { color:#ff9aa8; font-style:normal; font-weight:600; }
        .dbgReadout u { color:#8b94a3; text-decoration:none; }
        /* The phone keeps its own portrait box and is sized by HEIGHT, exactly
           as before the lane existed. Sizing it height:100% instead collapsed
           the whole component to 0x0: an aspect-ratio box with a percentage
           height inside a grid item has no definite height to resolve against,
           so it and every descendant measured zero and the phone vanished. */
        .wrap { position:relative;
                height:var(--mm-scene);
                aspect-ratio:${PHONE_W}/${PHONE_H};
                transition:transform .62s cubic-bezier(.55,.06,.3,1); }
        /* Landscape turns the WHOLE device -- bezel, island, screen, overlays --
           so the phone physically lies on its side. Rotating only the iframe
           leaves an upright phone containing sideways content, which reads as a
           rendering bug rather than a rotation.
           The scale term GROWS it: a rotated phone is 844 long against a column
           sized for 390, so without a scale >1 the sideways device reads as a
           shrunken toy. --mm-land-k is computed in fit() from the width actually
           available, which is why it isn't a constant here. */
        .wrap.land { transform:rotate(90deg) scale(var(--mm-land-k,1)); }
        /* Genuinely absent, for the opening beat that is about the Mac alone.
           Every other beat has the phone on screen somewhere, so until the
           Smart beat existed there was no "no phone" state at all -- and
           stagePhone(false) only drops the intro STAGING, which parks a
           full-size phone dead centre over the laptop rather than removing it.
           visibility (not display) so the element keeps its box and nothing
           below it reflows when the phone leaves and comes back. */
        .wrap.gone { visibility:hidden; }
        /* Intro staging. During the opening the phone is a SMALL prop beside the
           laptop, then it takes the stage: --mm-intro-k/x/y are driven per frame
           by the intro beats and are 1/0/0 for the whole rest of the loop, so
           every later beat gets exactly the transform it had before the intro
           existed.
           Written as its own class rather than folded into .wrap's transform so
           the landscape rule above stays the single owner of the rotate.

           Offsets are in cqw (a share of the COMPONENT's width), not percent:
           a percentage here resolves against the wrap's own box, which is the
           240px-wide phone -- so "58%" moved it 139px and threw it out of the
           hero column. cqw is the same unit the rest of this stylesheet sizes
           in, so an offset means the same thing at every rung of the ladder. */
        .wrap.intro { transform:translate(var(--mm-intro-x,0cqw), var(--mm-intro-y,0cqw))
                                scale(var(--mm-intro-k,1));
                      /* Above the laptop (.mac is z-index:2). The phone is the
                         thing being held UP TO the screen, so it has to occlude
                         the lid -- behind it, the pairing reads as the phone
                         being swallowed by the laptop. */
                      position:relative; z-index:3; }
        .capBox { position:relative; height:var(--mm-cap-h); width:100%; }

        /* Chapter ticks. the user wants this to read as "its own trailer", and a
           trailer tells you it ENDS -- a loop with no visible length reads as
           an idle animation you can ignore. One segment per beat, widths
           proportional to duration so the bar is an honest map of the runtime.
           The five skin beats are ~560ms against Pad's 2200, so without the
           min-width they collapse to slivers and the bar looks broken. */
        /* --mm-ticks lets a host hide the bar (set it to none) without
           reaching into this shadow root, which a page stylesheet cannot do.
           Nothing uses it right now: the bar costs ~4.5px, and on a phone the
           runtime map is worth more than that -- without it a looping demo
           reads as an idle animation. Kept as the escape hatch, not a default. */
        /* box-sizing matters here: a shadow root does NOT inherit the page's
           "* { box-sizing:border-box }" reset, so width:100% + padding:0 2px
           made this 4px WIDER than its parent. That overhang set the hero's
           min-content floor and gave the whole page a horizontal scrollbar
           on a 390px viewport. */
        .ticks { display:var(--mm-ticks, flex); gap:3px; justify-content:center;
                 box-sizing:border-box; width:100%; padding:0 2px; margin-top:2px; }
        .tick { height:2.5px; border-radius:2px; flex:0 1 auto; min-width:5px;
                background:rgba(120,105,95,.2); overflow:hidden; }
        .tick i { display:block; height:100%; width:100%; border-radius:2px;
                  background:rgb(255,160,80); transform-origin:left center;
                  transform:scaleX(0); }
        /* Past beats stay filled (paintTicks sets scaleX inline), so the bar
           accumulates like a progress bar rather than blinking one segment at a
           time. Dimmed so the ACTIVE segment still reads as the current one. */
        .tick.done { opacity:.5; }
        @media (prefers-reduced-motion: reduce) { .ticks { display:none } }

        /* ── the laptop ─────────────────────────────────────────────────────
           The loop opens on a Mac, because "point your phone at your computer"
           only means anything once you have SEEN the computer. It lives in the
           same square lane as the phone (the lane is as wide as the phone is
           tall, which is room enough for a 16:10 lid) and is laid out from the
           lane's centre, so nothing about the host's box changes when it
           leaves.

           Sized off --mm-scene, the SAME term the phone's height resolves to,
           so the two objects cannot drift apart. It was 74% of the lane, which
           only matched because a square lane's width equals the phone's height
           -- an accident that broke the moment the lane stopped being square. */
        .mac { position:absolute; top:50%; left:50%;
               width:calc(0.82 * var(--mm-scene));
               transform:translate(-50%,-50%) scale(var(--mm-mac-k,1));
               transform-origin:center; z-index:2; opacity:0;
               transition:opacity .45s, transform .62s cubic-bezier(.55,.06,.3,1);
               pointer-events:none; }
        .mac.on { opacity:1; }
        /* The lid. Aluminium edge, dark screen, and a chin thick enough to read
           as a MacBook rather than a monitor. */
        .macLid { position:relative; aspect-ratio:16/10; border-radius:2.4% / 3.8%;
                  background:linear-gradient(160deg,#3a3f47,#22262c 42%,#2e333a);
                  padding:1.6%;
                  box-shadow:0 1.6cqw 4cqw rgba(20,16,12,.26),
                             inset 0 0 0 .1cqw rgba(255,255,255,.13); }
        .macScreen { position:absolute; inset:1.6%; border-radius:1.4% / 2.2%;
                     overflow:hidden; background:#0f1117;
                     display:flex; flex-direction:column; }
        /* The base. A trapezoid read is faked with a wide rounded bar plus a
           narrower notch -- cheap, and at hero size indistinguishable from a
           drawn hinge. */
        .macBase { position:relative; height:1.9cqw; margin:0 -6%;
                   border-radius:0 0 22% 22% / 0 0 90% 90%;
                   background:linear-gradient(180deg,#31363d,#1c1f24);
                   box-shadow:0 .6cqw 1.4cqw rgba(20,16,12,.3); }
        .macBase::after { content:''; position:absolute; top:0; left:50%;
                          transform:translateX(-50%); width:14%; height:34%;
                          border-radius:0 0 99px 99px; background:#14161a; }

        /* The desktop behind the pairing card. the user asked for "a nice Mac vibe
           bg with the QR in front" -- a flat panel filling the lid reads as a
           kiosk, not as someone's Mac. So: a warm dusk wallpaper in the brand's
           own orange, a menu bar, and a dock. All three are pure CSS at ~200px
           wide; nothing here is an image the hero would have to wait on. */
        .macDesk { position:absolute; inset:0;
                   background:linear-gradient(175deg,#2b3350 0%,#4a3a5c 38%,
                                              #8a5340 74%,#c9743f 100%); }
        /* The blown-out sun low on the horizon is what sells "wallpaper" rather
           than "gradient" -- it gives the light a source and a direction. */
        .macDesk::after { content:''; position:absolute; inset:0;
                          background:radial-gradient(38% 26% at 50% 88%,
                            rgba(255,190,120,.55), rgba(255,190,120,0) 70%); }
        .macBar { position:absolute; top:0; left:0; right:0; height:7.5%;
                  display:flex; align-items:center; gap:4%; padding:0 3%;
                  background:rgba(18,20,28,.42); backdrop-filter:blur(6px);
                  font:600 clamp(3px,.85cqw,5px)/1 -apple-system,system-ui,sans-serif;
                  color:rgba(255,255,255,.82); z-index:2; }
        /* The Apple slot is a dot, not a glyph: at this size a real logo is 3px
           of mush, and a neutral dot reads as a menu bar without pretending to
           be a trademark we did not draw. */
        .macBar b { width:1cqw; height:1cqw; border-radius:50%;
                    background:rgba(255,255,255,.7); flex:none; }
        .macBar .sp { flex:1; }
        .macDock { position:absolute; bottom:2.5%; left:50%; transform:translateX(-50%);
                   display:flex; gap:1.4%; padding:.9% 1.4%; border-radius:14%/30%;
                   background:rgba(255,255,255,.16); backdrop-filter:blur(8px);
                   box-shadow:inset 0 0 0 .08cqw rgba(255,255,255,.22); z-index:2; }
        /* Real Dock icons (same set as the Cmd-Tab beat). They ship their own
           rounded-square shape and margin, so no chip behind them. */
        .macDock img { width:2.8cqw; aspect-ratio:1; display:block; }
        .macLink, .macRun { display:flex; align-items:center; gap:.5cqw; }
        .macLink i { width:.8cqw; height:.8cqw; border-radius:50%; background:rgba(255,255,255,.35);
                     transition:background .3s, box-shadow .3s; }
        .mac.paired .macLink i { background:#3fbf8f; box-shadow:0 0 .8cqw #3fbf8f; }
        .macRun { padding:.25cqw .7cqw; border-radius:.5cqw; color:#ffb877;
                  background:rgba(255,138,60,.18); }
        .macAgents { position:absolute; top:11%; right:2.5%; width:25%; z-index:2;
                     display:flex; flex-direction:column; gap:1cqw; }
        .macAgent { padding:1cqw 1.1cqw; border-radius:.8cqw; background:rgba(22,24,32,.78);
                    backdrop-filter:blur(10px); box-shadow:inset 0 0 0 .08cqw rgba(255,255,255,.14);
                    display:flex; flex-direction:column; gap:.7cqw;
                    font:500 clamp(3px,.95cqw,6px)/1.15 -apple-system,system-ui,sans-serif;
                    color:rgba(255,255,255,.7); }
        .macAgentTop { display:flex; align-items:center; gap:.6cqw; color:#fff; font-weight:650; }
        .macAgentTop b { width:1.6cqw; aspect-ratio:1; border-radius:.35cqw; display:grid; place-items:center;
                          font:700 clamp(3px,.9cqw,6px)/1 ui-monospace,monospace; color:#fff;
                          box-shadow:inset 0 0 0 .06cqw rgba(255,255,255,.2); }
        .macAgentTask { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .macAgentBar { height:.45cqw; border-radius:99px; background:rgba(255,255,255,.12); overflow:hidden; }
        .macAgentBar i { display:block; height:100%; width:40%; border-radius:99px;
                         background:linear-gradient(90deg,#ff8a3c,#ffb877);
                         animation:mmAgentRun 3.2s ease-in-out infinite alternate; }
        .macAsk span { display:inline-block; padding:.25cqw .6cqw; border-radius:.45cqw; font-weight:650; }
        .macAsk .ask { color:#1a1208; background:#ffb877; animation:mmCharge 1.4s ease-in-out infinite; }
        .macAsk .ok { display:none; color:#3fbf8f; background:rgba(63,191,143,.16); }
        .mac.paired .macAsk .ask { display:none; }
        .mac.paired .macAsk .ok { display:inline-block; }
        .mac.paired .macAgent:last-child .macAgentBar i { animation-duration:1.6s; }
        @keyframes mmAgentRun { from { width:22% } to { width:88% } }
        @media (prefers-reduced-motion: reduce) {
          .macAgentBar i, .macAsk .ask { animation:none; }
        }
        /* The laptop's OWN pointer. macCursor() paints inside the mirror pane,
           which is still closed during the Drive beat -- so without a cursor
           drawn on the laptop itself there is nothing to watch move, and the
           beat's whole claim (your finger here moves the pointer THERE) has no
           evidence on screen. Drawn as a classic arrow via clip-path so it
           reads as a mouse pointer at ~10px rather than as a dot. */
        .macPtr { position:absolute; top:0; left:0; width:2.6cqw; aspect-ratio:.62;
                  background:#fff; filter:drop-shadow(0 .12cqw .25cqw rgba(0,0,0,.55));
                  clip-path:polygon(0 0, 0 78%, 26% 60%, 44% 100%, 62% 90%,
                                    46% 54%, 76% 52%);
                  opacity:0; transition:opacity .2s; z-index:4;
                  pointer-events:none; }
        .macPtr.on { opacity:1; }
        /* The pointer once MightyMouse is on it. Same arrow, wearing the comet
           glow the real app puts on the cursor -- so the ignite is a change of
           STATE on one object, not a swap to a different object. */
        .macPtr.lit { background:linear-gradient(160deg,#ffd9a8,#ff8a3c);
                      filter:drop-shadow(0 0 .5cqw rgba(255,138,60,.95))
                             drop-shadow(0 0 1.4cqw rgba(255,138,60,.55)); }
        /* The desktop asleep. The wake is a filter on ONE element rather than a
           per-child animation: the menu bar, dock and wallpaper all sit inside
           .macScreen, so dulling the parent dims the whole machine in a single
           interpolation and cannot desync. */
        .macScreen { filter:saturate(var(--mm-wake-s,1)) brightness(var(--mm-wake-b,1)); }
        /* Boot glow: while the bundle loads, the asleep Mac visibly CHARGES --
           a warm breath rising from the dock plus a slow diagonal sheen. Gated
           on .mac.booting, which start() removes the moment boot lands, so the
           Smart beat's ignite stays the loop's only wake. */
        .macBoot { position:absolute; inset:0; z-index:6; opacity:0;
                   pointer-events:none; transition:opacity .6s ease-out;
                   background:radial-gradient(85% 65% at 50% 96%,
                     rgba(255,150,60,.5), rgba(255,150,60,.12) 48%, transparent 72%); }
        .mac.booting .macBoot { opacity:1; animation:mmCharge 2.2s ease-in-out infinite; }
        .macBoot::after { content:''; position:absolute; inset:0;
                          background:linear-gradient(115deg,transparent 40%,
                            rgba(255,205,150,.14) 50%,transparent 60%);
                          background-size:260% 100%;
                          animation:skelSweep 2.2s ease-in-out infinite; }
        @keyframes mmCharge { 0%,100% { opacity:.4 } 50% { opacity:1 } }
        @media (prefers-reduced-motion: reduce) {
          .mac.booting .macBoot { animation:none; opacity:.6; }
          .macBoot::after { animation:none; }
        }
        /* The answer MightyMouse pops next to the cursor. Deliberately wordless
           bars: at ~200px wide real text is mush, and the beat only has to read
           as "something intelligent just answered", not as a specific answer. */
        .macAi { position:absolute; width:34%; padding:2.6% 2.8%; border-radius:4.5%/8%;
                 background:rgba(24,26,34,.9); backdrop-filter:blur(12px);
                 box-shadow:0 1cqw 2.4cqw rgba(10,8,14,.5),
                            inset 0 0 0 .09cqw rgba(255,255,255,.18);
                 display:flex; flex-direction:column; gap:8%;
                 transform-origin:0 0; z-index:5; pointer-events:none;
                 opacity:0; }
        .macAi i { display:block; height:.9cqw; border-radius:99px;
                   background:rgba(255,255,255,.34); }
        /* First bar is the brand colour so the panel is legibly OURS, and the
           bars are ragged so it reads as prose rather than as a loading skeleton. */
        .macAi i:first-child { background:linear-gradient(90deg,#ff8a3c,#ffb877);
                               width:62%; }
        .macAi i:nth-child(2) { width:100%; }
        .macAi i:nth-child(3) { width:84%; }
        /* The dictation beat's text field. A bare caret + line on the desktop
           rather than a window chrome: the claim is "your words land wherever
           the cursor already is", and drawing a document window would say the
           opposite -- that dictation belongs to one app. */
        .macType { position:absolute; top:46%; left:50%; transform:translate(-50%,-50%);
                   width:56%; display:flex; align-items:center; gap:1.2cqw;
                   padding:2.4% 3.2%; border-radius:2.4%/9%;
                   background:rgba(20,22,30,.72); backdrop-filter:blur(10px);
                   box-shadow:inset 0 0 0 .09cqw rgba(255,255,255,.14);
                   opacity:0; transition:opacity .18s; z-index:3; }
        .macType.on { opacity:1; }
        .macType b { color:#ff8a3c; font:700 clamp(5px,1.5cqw,9px)/1 ui-monospace,monospace; }
        .macType span { color:rgba(255,255,255,.92); white-space:nowrap;
                        font:500 clamp(5px,1.45cqw,9px)/1.1 -apple-system,system-ui,sans-serif; }
        /* The caret. Steady while text is still arriving -- a blink at 1s of
           screen time reads as a rendering glitch, not as a cursor. */
        .macType i { width:.22cqw; height:1.7cqw; background:rgba(255,255,255,.9); }

        /* MightyMouse's pairing window, floating IN FRONT of the desktop as a
           real window would -- that is what makes the QR read as "our app is
           open on your Mac" instead of "your Mac is a QR code". Deliberately
           not the real app in an iframe: 2s of screen time at ~200px wide does
           not justify booting a second bundle. */
        .macApp { position:absolute; top:53%; left:50%;
                  transform:translate(-50%,-50%);
                  /* 34%, not 52: at half the screen the pairing card read as
                     the whole desktop being a QR code. */
                  width:34%; display:flex; flex-direction:column; align-items:center;
                  gap:5%; padding:6% 5%; border-radius:3.5%/4.5%;
                  background:rgba(28,30,38,.82); backdrop-filter:blur(14px);
                  box-shadow:0 1.4cqw 3cqw rgba(10,8,14,.42),
                             inset 0 0 0 .09cqw rgba(255,255,255,.16);
                  z-index:3; transition:opacity .3s; }
        .macAppTitle { font:700 clamp(5px,1.5cqw,9px)/1 -apple-system,system-ui,sans-serif;
                       color:rgba(255,255,255,.92); letter-spacing:.02em; }
        .macAppHint { font:500 clamp(4px,1.2cqw,7.5px)/1 -apple-system,system-ui,sans-serif;
                      color:rgba(255,255,255,.55); text-align:center; }
        /* The QR is a CSS grid of cells from a fixed pattern, not an <img>: it
           has to stay crisp at any size and must never be a network request the
           hero waits on. It is decorative -- .qr is aria-hidden and nothing in
           the demo claims it is scannable. */
        /* border-box, or the 4% padding is ADDED to the 62% and the white block
           paints wider than the card was sized for -- the shadow root carries no
           border-box reset (see the .tick note). 52%, not 62: the code is one
           element on a pairing card, not the card's whole content. */
        .qr { display:grid; box-sizing:border-box; width:52%; aspect-ratio:1; padding:4%;
              background:#fff; border-radius:8%;
              grid-template-columns:repeat(${QR_N}, 1fr);
              box-shadow:0 .4cqw 1.2cqw rgba(0,0,0,.35); }
        .qr i { background:#0d0f14; }
        /* The scan pulse: a ring that leaves the QR when the phone "reads" it.
           This is the only moment in the intro that says the two devices are
           now talking, so it is a real element rather than a colour change.
           It sits at the CARD's centre (53%), not the screen's -- the card is
           offset for the menu bar, and a ring centred on the screen would leave
           from just below the code it is supposed to be leaving. */
        .qrPulse { position:absolute; top:53%; left:50%; width:22%; aspect-ratio:1;
                   transform:translate(-50%,-50%) scale(1); border-radius:12%;
                   border:.3cqw solid rgb(255,160,80); opacity:0; z-index:4; }
        .qrPulse.on { animation:mmScan .9s cubic-bezier(.2,.6,.3,1); }
        @keyframes mmScan {
          0%   { opacity:.9; transform:translate(-50%,-50%) scale(1); }
          100% { opacity:0;  transform:translate(-50%,-50%) scale(2.1); }
        }
        /* Once paired, the Mac drops the QR and shows it is connected. Without
           this the laptop would leave the frame still asking to be paired,
           which reads as the pairing having failed. */
        /* Same box as .macApp, so the two cross-fade in place instead of the
           confirmation appearing somewhere the QR never was. */
        .macPaired { position:absolute; top:53%; left:50%;
                     transform:translate(-50%,-50%);
                     width:34%; display:flex; flex-direction:column;
                     align-items:center; justify-content:center; gap:6%;
                     padding:9% 5%; border-radius:3.5%/4.5%;
                     background:rgba(28,30,38,.82); backdrop-filter:blur(14px);
                     box-shadow:0 1.4cqw 3cqw rgba(10,8,14,.42),
                                inset 0 0 0 .09cqw rgba(255,255,255,.16);
                     opacity:0; transition:opacity .3s; z-index:3; }
        .macPaired.on { opacity:1; }
        .macPaired .dot { width:1.4cqw; height:1.4cqw; border-radius:50%;
                          background:#3fbf8f; box-shadow:0 0 1.4cqw #3fbf8f; }

        /* The camera viewfinder. the user: the phone should read as a CAMERA held up
           to the screen -- it sees the QR, and only then does the UI appear.
           Without this the phone is just a second device parked next to a
           laptop and nothing explains why the code matters.
           It covers the phone's own screen (so the real bundle is hidden while
           the phone is "not paired yet"), then fades to reveal the app at the
           exact moment the Mac says connected. */
        .cam { position:absolute; inset:0; z-index:5; opacity:0;
               transition:opacity .32s; pointer-events:none;
               background:#0a0b0e; display:flex;
               align-items:center; justify-content:center; }
        .cam.on { opacity:1; }
        /* What the lens sees: the same wallpaper as the Mac, darkened and
           blurred, so the phone is visibly looking AT that desktop rather than
           showing an unrelated black rectangle. */
        .cam::before { content:''; position:absolute; inset:0;
                       background:linear-gradient(175deg,#2b3350,#8a5340 74%,#c9743f);
                       filter:blur(1.2cqw) brightness(.5); }
        /* The QR as the lens sees it: smaller, and squared up in the middle of
           the frame the way a scanner app centres its target. */
        .camQr { position:relative; display:grid; box-sizing:border-box;
                 width:44%; aspect-ratio:1;
                 padding:4%; background:#fff; border-radius:6%;
                 grid-template-columns:repeat(${QR_N}, 1fr); }
        .camQr i { background:#0d0f14; }
        /* Corner brackets -- the single most recognisable "this is a scanner"
           cue. Drawn as one element with four clipped borders rather than four
           divs. */
        .camFrame { position:absolute; top:50%; left:50%;
                    transform:translate(-50%,-50%); width:62%; aspect-ratio:1;
                    background:
                      linear-gradient(rgb(255,160,80),rgb(255,160,80)) 0 0/28% .5cqw,
                      linear-gradient(rgb(255,160,80),rgb(255,160,80)) 0 0/.5cqw 28%,
                      linear-gradient(rgb(255,160,80),rgb(255,160,80)) 100% 0/28% .5cqw,
                      linear-gradient(rgb(255,160,80),rgb(255,160,80)) 100% 0/.5cqw 28%,
                      linear-gradient(rgb(255,160,80),rgb(255,160,80)) 0 100%/28% .5cqw,
                      linear-gradient(rgb(255,160,80),rgb(255,160,80)) 0 100%/.5cqw 28%,
                      linear-gradient(rgb(255,160,80),rgb(255,160,80)) 100% 100%/28% .5cqw,
                      linear-gradient(rgb(255,160,80),rgb(255,160,80)) 100% 100%/.5cqw 28%;
                    background-repeat:no-repeat; }
        /* The sweep line. Motion is what separates "a camera is looking" from
           "a still picture of a QR code". */
        .camScan { position:absolute; top:50%; left:50%; width:62%; height:.4cqw;
                   transform:translate(-50%,-50%);
                   background:linear-gradient(90deg,transparent,
                     rgb(255,160,80),transparent);
                   opacity:0; }
        .cam.on .camScan { animation:camSweep 1.5s ease-in-out infinite; }
        @keyframes camSweep {
          0%,100% { opacity:0; transform:translate(-50%,-340%); }
          50%     { opacity:.95; transform:translate(-50%,240%); }
        }

        @media (prefers-reduced-motion: reduce) {
          .mac, .qrPulse, .cam { transition:none; animation:none; }
          .cam.on .camScan { animation:none; }
        }

        /* The device. A dark bezel with a bright screen inside it -- the bezel
           is what makes it read as a phone rather than a floating rectangle. */
        /* --mm-bezel is the ONE bezel width. The chassis padding, the screen
           inset and the island's edge inset all read it, so they cannot drift
           apart -- three literals is how the island ended up floating off the
           bezel and onto the keys. */
        .device { --mm-bezel:1.6%;
                  position:absolute; inset:0; border-radius:14.5%/6.7%;
                  background:linear-gradient(150deg,#2c2f36,#15171b 45%,#23262c);
                  padding:var(--mm-bezel); box-shadow:
                    0 2.2cqw 5cqw rgba(20,16,12,.28),
                    0 .5cqw 1.4cqw rgba(20,16,12,.18),
                    inset 0 0 0 .12cqw rgba(255,255,255,.14);
                  overflow:hidden; }
        .screen { position:absolute; inset:var(--mm-bezel); border-radius:13.2%/6%;
                  overflow:hidden; background:#000; }
        /* The bundle takes ~0.5-3s to fetch, write and mount, and the chassis
           paints instantly -- so without this the hero holds a dead black
           rectangle. The skeleton is a sweep over the phone's own dark screen,
           not a spinner: a spinner inside a fake phone reads as "the product is
           slow", a lit screen reads as "it's waking up". */
        /* A dim take on the app's own dusk gradient, not near-black: at 0.16
           alpha on #14161c the sweep was invisible in practice and the loading
           phone read as a dead slab. */
        .skel { position:absolute; inset:0; z-index:6; pointer-events:none;
                background:linear-gradient(170deg,#232138,#2a2440 55%,#382840);
                transition:opacity .5s ease-out; }
        .skel::after { content:''; position:absolute; inset:0;
                       background:linear-gradient(105deg,transparent 38%,
                         rgba(255,178,110,.30) 50%,transparent 62%);
                       background-size:280% 100%;
                       animation:skelSweep 1.5s ease-in-out infinite; }
        .device.mmReady .skel { opacity:0; }
        @keyframes skelSweep { 0% { background-position:180% 0 }
                               100% { background-position:-80% 0 } }
        @media (prefers-reduced-motion: reduce) {
          .skel::after { animation:none; }
        }
        /* Inert on purpose. This is a looping demo, not a usable remote: live
           hover states advertise controls that do nothing, and an iframe
           swallows the parent's mousemove, which strands the landing page's
           cursor-trail emoji at the phone's edge instead of gliding over it. */
        .screen iframe { border:0; display:block; transform-origin:0 0;
                         pointer-events:none; }

        /* Dynamic island. Purely cosmetic -- the bundle draws its own notch
           path for the pad carve, this is the physical pill above it.

           Geometry is the real 15 Pro's, in % of the 390x844 device box: the
           island is 125x37pt sitting 11pt below the top edge, so 32% x 4.4% at
           top 1.3%. It shipped at 26% x 3.1% / top 2.6% -- a pill both too
           small and parked twice as far in as the real one, which portrait
           forgives (it just reads as a slightly odd notch on a blank bezel) and
           LANDSCAPE does not. Rotated, the device's top edge becomes the side
           the key cluster lives on, so that inset walked the pill off the bezel
           and straight over the keyboard button -- a black slab across
           Esc/Enter.

           A top offset CANNOT anchor it to the bezel, which is what two attempts
           got wrong. Two reasons, both measured: top resolves against the
           container's HEIGHT while padding resolves against its WIDTH, so one
           --mm-bezel token yields 8.31px here and 3.84px there; and top is
           already measured from the padding box, so any positive value stacks
           ON TOP of the bezel the padding just drew. Together that put the pill
           12.15px in on a 7.81px bezel -- clear of it, on the screen, over the
           keys (island right 878.1 vs screen right 876.6).

           So it is positioned against the screen edge instead: top:0 puts it at
           the padding box's edge, i.e. exactly the screen's top line, and the
           negative translateY lifts it back into the bezel band, the way a real
           island straddles the display edge. The only number it depends on is
           its own size. 22% leaves ~4.7px of pill on the display and keeps its
           outer edge inside the chassis -- measured; at 42% it cleared the
           screen but hung 9px off the phone. */
        .island { position:absolute; top:0; left:50%;
                  transform:translate(-50%,-22%);
                  width:32%; height:4.4%; border-radius:99px; background:#0b0c0e;
                  z-index:4; pointer-events:none; }

        /* The finger. A soft disc, not an arrow: this is a touch and it has to
           read as one at hero size. */
        /* box-sizing is explicit: the shadow root has no border-box reset (see
           the .tick note), so aspect-ratio would hold the CONTENT box square
           and let the border push the painted box off-square. Safari renders
           that as a squashed teardrop rather than the disc Chrome shows. */
        .finger { position:absolute; box-sizing:border-box;
                  width:11.5%; aspect-ratio:1; border-radius:50%;
                  background:radial-gradient(circle at 34% 30%,
                    rgba(255,255,255,.92), rgba(255,255,255,.26) 58%, rgba(255,255,255,0) 72%);
                  border:.35cqw solid rgba(255,255,255,.72);
                  box-shadow:0 .3cqw .9cqw rgba(0,0,0,.28);
                  transform:translate(-50%,-50%); z-index:6; opacity:0;
                  transition:opacity .25s, scale .12s; pointer-events:none; }
        .finger.down { scale:.85; }
        /* Trackpad touch = a HEAT MAP, not the comet. the user, correcting an
           earlier build: "it's not a comet it's a heat map". The distinction is
           accumulation. A comet is one orb with a directional tail -- it says
           WHERE YOU ARE and WHICH WAY. Heat says WHERE YOU HAVE BEEN, and it
           pools: dwell in one place and it gets hotter, sweep through and it
           leaves a cooling smear. So this is a ring of soft radial pools, each
           stamped at a sample point and fading on its own clock, rather than a
           single tracked node. No hard edge, no tail.

           The Mac cursor in the mirror KEEPS the comet -- that one is the real
           shipped cursor companion, and the two surfaces read as different
           things on purpose: your finger leaves heat, the pointer flies.

           Positioned in DEVICE PIXELS (translate3d) because the blur radius and
           pool size are absolute, and a percentage would stretch them out of
           round on a non-square device box. place() does the conversion.

           Blend is plus-lighter, NOT screen. Screen was the first attempt, and
           against the cork pad's mid-tone brown it lifts an orange pool to
           almost exactly the pad's own luminance -- a heat map that measured as
           painting was invisible in the screenshot. plus-lighter adds light
           rather than inverting toward white, so heat stays orange and stacked
           pools genuinely compound where the finger dwells. */
        .padHeat { position:absolute; inset:0; z-index:4; pointer-events:none;
                   opacity:0; transition:opacity .22s ease-out;
                   mix-blend-mode:plus-lighter; }
        .device.trailing .padHeat { opacity:1; }
        .heatDot { position:absolute; top:0; left:0; border-radius:50%;
                   pointer-events:none; will-change:transform,opacity;
                   transform-origin:center center; }

        /* Press flare. Brand-tinted, not white, so a tap belongs to the same
           visual language as the comet. Two nodes on staggered timing: a hard
           ring that snaps out, and a soft glow that lingers behind it. One
           element can only carry one timing curve, and a press that expands and
           fades at a single rate reads as a CSS default rather than a hit. */
        .ripple { position:absolute; box-sizing:border-box;
                  width:11.5%; aspect-ratio:1; border-radius:50%;
                  border:.42cqw solid rgba(255,176,104,.92); transform:translate(-50%,-50%);
                  z-index:5; pointer-events:none;
                  box-shadow:0 0 1.6cqw rgba(255,160,80,.5);
                  animation:rip .5s cubic-bezier(.16,.84,.44,1) forwards; }
        @keyframes rip { to { scale:2.6; opacity:0 } }
        .ripple.glow { border-color:transparent; box-shadow:none;
                       background:radial-gradient(circle,
                         rgba(255,170,96,.5), rgba(255,170,96,0) 70%);
                       animation:ripGlow .62s ease-out forwards; }
        @keyframes ripGlow { 0% { scale:.6; opacity:.9 } 100% { scale:3.1; opacity:0 } }

        /* Caption. Sits under the phone, not over it -- an overlay would cover
           the deck, which is the thing being sold. -14% put it into the next
           section on the page; it belongs inside the host's own box. */
        /* The caption ANIMATES IN, it doesn't crossfade. the user: it should feel
           like a trailer's lower-third. It rises, settles, and overshoots
           slightly on the scale -- a pure opacity fade reads as a slideshow,
           which is the thing that made the old loop feel static.
           filter:blur on the way in does the heavy lifting: it's what makes
           the word feel like it ARRIVES rather than appears. */
        .cap { position:absolute; left:0; right:0; bottom:0; text-align:center;
               font:600 clamp(12px,3.6cqw,17px)/1.35 -apple-system,system-ui,sans-serif;
               color:var(--mm-cap,#6b6259); letter-spacing:-.01em;
               opacity:0; transform:translateY(7px) scale(.975); filter:blur(3px);
               transition:opacity .2s ease-out, transform .2s ease-out, filter .2s ease-out; }
        .cap.on { opacity:1; filter:blur(0);
                  transform:translateY(0) scale(1);
                  transition:opacity .34s cubic-bezier(.16,.84,.44,1),
                             transform .44s cubic-bezier(.22,1.2,.36,1),
                             filter .3s ease-out; }

        /* Skin name, shown only while the skin carousel is running.

           Lives in .stack, NOT .wrap -- same reason as .hud below, and it
           shipped inside .wrap and hit exactly the failure that comment
           predicts. The wrap carries the landscape rotation, so a child's
           top/left resolve in the TURNED frame: the tag rode the phone round
           and rendered as vertical text over Esc/Enter, its border-radius:99px
           pill reading as a black slab across the keyboard button. Outside the wrap it simply
           never rotates, so one anchor is right in both orientations.

           Anchored under the HUD rather than to the phone's own notch: the tag
           used to sit at 7.6% of .device to clear the island (measured, tagTop
           175 vs islandBottom 177), but .device is the thing that turns. The
           stack's top edge holds still through the rotation, which is the whole
           point of moving here, so the offset is expressed against that. */
        .skinTag { position:absolute; top:9%; left:50%; translate:-50% 0;
                   z-index:7; padding:.5cqw 2.4cqw; border-radius:99px;
                   background:rgba(12,12,14,.72); color:#fff; backdrop-filter:blur(6px);
                   font:600 clamp(9px,2.5cqw,12px)/1 -apple-system,system-ui,sans-serif;
                   opacity:0; transition:opacity .3s; pointer-events:none; }
        .skinTag.on { opacity:1; }

        /* Feature HUD. Names the capability at the moment it fires -- the
           caption says what the finger is doing, this says why it matters.
           Lives in .stack, NOT .wrap: the wrap carries the landscape rotation,
           and a child of it inherits that turn. Counter-rotating the label back
           was tried and is worse than useless -- the -90 cancels the shell's
           +90 so the text reads straight, but left/bottom are then resolved in
           the shell's rotated frame and the pill lands on the top edge
           (measured: 64x10 at the wrap's top, not the left rail).
           Outside the wrap it simply never rotates.
           Anchored to the TOP of the stack, not to the caption strip. The stack
           reserves portrait height in both orientations, so its top edge holds
           still while the phone turns -- and a caption-anchored pill needs a
           computed lift to clear the key cluster, which put it inside the phone
           over the trackpad the moment the lift under-shot. */
        .hud { position:absolute; left:50%; top:0;
               translate:-50% 0; z-index:8;
               display:flex; align-items:center; gap:1.6cqw;
               padding:1.1cqw 3cqw; border-radius:99px;
               background:rgba(12,12,14,.78); backdrop-filter:blur(8px);
               box-shadow:0 .4cqw 1.6cqw rgba(0,0,0,.3),
                          inset 0 0 0 .1cqw rgba(255,255,255,.13);
               color:#fff; white-space:nowrap;
               font:600 clamp(9px,2.7cqw,13px)/1 -apple-system,system-ui,sans-serif;
               opacity:0; transition:opacity .3s, translate .3s;
               pointer-events:none; }
        .hud.on { opacity:1; }
        .hud i { width:1.6cqw; height:1.6cqw; border-radius:50%; flex:none;
                 background:rgb(255,160,80);
                 box-shadow:0 0 1.4cqw rgb(255,160,80); }

        /* FLASHCARDS -- opt-in via the flashcards attribute. Off by default,
           so every existing page keeps the subtitle strip untouched.
           NB: no backticks in this block -- it is a template literal.

           The card is pulled OUT of .capBox (a short strip below the phone) and
           re-anchored to the full host box, which is why .capBox drops its own
           positioning: that promotes the host to be the nearest positioned
           ancestor, and the inset + margin:auto pair then resolves against it.
           The strip still occupies its flow height, so nothing below reflows. */
        :host([flashcards]) .capBox { overflow:visible; position:static; }
        :host([flashcards]) .cap {
          /* top keeps the card clear of the phone's working UI -- the browser
             pane and the top of the trackpad -- so it never covers what the
             demo is showing. Anchoring to bottom instead would drift with the
             card's own height as the text wraps to 2 or 3 lines.

             It is a % of the HOST, which is taller than the phone lane by the
             hud and caption lanes. Squeeze those (as the landing page does on
             mobile) and a fixed 74% drops the card off the phone's bottom edge
             onto the ticks, so --mm-cap-top lets the host retune it. */
          /* left+right+auto margins is what centres a shrink-to-fit box: with
             both insets set and a max-content width, the leftover splits
             evenly. Do not drop either inset -- the card falls to the left. */
          position:absolute; left:0; right:0; top:var(--mm-cap-top,74%); bottom:0; margin:auto;
          /* Per-beat placement, set from say(). Defaults leave the card centred
             and level if the JS never runs. --fy is a PERCENTAGE so the wander
             scales with the phone rather than being a fixed nudge that reads
             huge on a small tile and invisible on a large one. */
          --fx:0px; --fy:0%; --fr:0deg;
          /* max-width CAPS the line length, width:max-content makes the box
             SHRINK to the wrapped text. A plain width fills the cap whatever
             the text does, which is what left "is the remote" floating in a
             band of empty orange -- the second line is short, but the box was
             still 52%. Balanced wrapping picks the break; the box then follows
             the longest line instead of the cap. */
          width:max-content; max-width:min(52%,215px); height:max-content;
          /* Above the phone shell and the iframe, below the HUD pill (8). */
          z-index:7;
          padding:.62em .78em; border-radius:9px;
          font:700 clamp(13px,3.9cqw,18px)/1.28 -apple-system,system-ui,sans-serif;
          letter-spacing:-.015em; text-wrap:balance; white-space:normal;
          /* Two themes, alternating per beat -- a single colour repeated 12
             times a loop is its own pattern, so the card flips between them.
             Orange is the default; .capInk is the inverse. */
          background:linear-gradient(180deg,var(--mm-accent,rgb(242,170,98)),
                                            var(--mm-accent-deep,rgb(231,146,70)));
          color:#fff;
          box-shadow:0 14px 34px rgba(228,142,64,.4),
                     inset 0 1px 0 rgba(255,255,255,.3);
          /* The rest state IS the exit: say() drops .on ~150ms before swapping
             the text, so this plays as the card clearing out. */
          opacity:0; filter:none;
          transform:translate(var(--fx),var(--fy)) rotate(var(--fr));
          transition:opacity .16s ease-in, transform .16s ease-in;
        }
        /* Every keyframe composes the offset and angle so the card flies toward
           its own resting spot rather than to centre and then jumping. The
           overshoot at 60% is what makes it read as thrown, not placed. */
        :host([flashcards]) .cap.on {
          opacity:1; filter:none;
          animation:mmFcL .52s cubic-bezier(.16,1.5,.32,1) both;
          transition:none;
        }
        :host([flashcards]) .cap.capR.on { animation-name:mmFcR; }

        /* Ink theme: black card, orange type. The shadow goes neutral-dark --
           an orange glow under a black card reads as a colour bleed. */
        :host([flashcards]) .cap.capInk {
          background:linear-gradient(180deg,rgb(38,34,31),rgb(22,20,18));
          color:var(--mm-accent,rgb(242,170,98));
          box-shadow:0 14px 34px rgba(20,18,17,.42),
                     inset 0 1px 0 rgba(255,255,255,.12);
        }
        @keyframes mmFcL {
          from { opacity:0; transform:translate(calc(var(--fx) - var(--mm-fc-throw,62px)),var(--fy))
                                      scale(.8) rotate(calc(var(--fr) - 7deg)) }
          60%  { opacity:1; transform:translate(var(--fx),var(--fy))
                                      scale(1.05) rotate(calc(var(--fr) + 2.5deg)) }
          to   { opacity:1; transform:translate(var(--fx),var(--fy))
                                      scale(1) rotate(var(--fr)) }
        }
        @keyframes mmFcR {
          from { opacity:0; transform:translate(calc(var(--fx) + var(--mm-fc-throw,62px)),var(--fy))
                                      scale(.8) rotate(calc(var(--fr) + 7deg)) }
          60%  { opacity:1; transform:translate(var(--fx),var(--fy))
                                      scale(1.05) rotate(calc(var(--fr) - 2.5deg)) }
          to   { opacity:1; transform:translate(var(--fx),var(--fy))
                                      scale(1) rotate(var(--fr)) }
        }

        @media (prefers-reduced-motion: reduce) {
          .finger, .ripple { display:none; }
          .cap { opacity:1; }
          /* Keep the card readable and still: no throw, no tilt. */
          :host([flashcards]) .cap { opacity:1; animation:none; transform:none; }
        }
      </style>
      <div class="stack">
        <div class="wrapLane">
          <div class="mac" aria-hidden="true">
            <div class="macLid">
              <div class="macScreen">
                <div class="macDesk"></div>
                <div class="macBar"><b></b><span>MightyMouse</span><span class="sp"></span><span class="macLink"><i></i>Phone</span><span class="macRun">Couch mode</span><span>9:41</span></div>
                <div class="macAgents">${MAC_AGENTS.map((a) => `<div class="macAgent"><div class="macAgentTop"><b style="background:${a.tint}">${a.glyph}</b><span>${a.name}</span></div><div class="macAgentTask">${a.task}</div><div class="macAgentBar"><i></i></div>${a.ask ? '<div class="macAsk"><span class="ask">Paused</span><span class="ok">Played from phone</span></div>' : ''}</div>`).join('')}</div>
                <div class="macDock">${MAC_APPS.map((a) => `<img src="${a.icon}" alt="">`).join('')}</div>
                <div class="macApp">
                  <div class="macAppTitle">MightyMouse</div>
                  <div class="qr">${QR_CELLS.map((c) => `<i${c ? '' : ' style="background:transparent"'}></i>`).join('')}</div>
                  <div class="macAppHint">Scan to pair your phone</div>
                </div>
                <div class="macPaired">
                  <div class="dot"></div>
                  <div class="macAppTitle">Phone connected</div>
                </div>
                <div class="qrPulse"></div>
                <div class="macType"><b>❯</b><span></span><i></i></div>
                <div class="macAi"><i></i><i></i><i></i></div>
                <div class="macPtr"></div>
                <div class="macBoot"></div>
              </div>
            </div>
            <div class="macBase"></div>
          </div>
          <div class="wrap">
            <div class="device">
              <div class="screen"><iframe part="frame" title="MightyMouse phone remote demo"></iframe>
                <div class="cam" aria-hidden="true">
                  <div class="camQr">${QR_CELLS.map((c) => `<i${c ? '' : ' style="background:transparent"'}></i>`).join('')}</div>
                  <div class="camFrame"></div>
                  <div class="camScan"></div>
                </div>
              </div>
              <div class="skel" aria-hidden="true"></div>
              <div class="island"></div>
              <div class="padHeat"></div>
              <div class="finger"></div>
            </div>
          </div>
        </div>
        <div class="skinTag"></div>
        <div class="hud"><i></i><span></span></div>
        <div class="capBox"><div class="cap"></div></div>
        <div class="ticks"></div>
        <div class="dbgReadout" aria-hidden="true"></div>
      </div>`

    this.$ = (s) => root.querySelector(s)
    this.frame = this.$('iframe')
    this.finger = this.$('.finger')
    this.cap = this.$('.cap')
    this.skinTag = this.$('.skinTag')
    this.device = this.$('.device')
    this.padHeat = this.$('.padHeat')
    // Fixed-size pool, reused round-robin. Creating a node per sample would
    // churn ~30 elements a second for the whole loop; recycling means the DOM
    // count is constant and the oldest pool is exactly the one about to be
    // overwritten anyway, because it has already cooled to nothing.
    this.heatDots = []
    for (let i = 0; i < HEAT_POOL; i++) {
      const d = document.createElement('div')
      d.className = 'heatDot'
      d.style.opacity = '0'
      this.padHeat.appendChild(d)
      this.heatDots.push({ el: d, born: -1e9, size: 0 })
    }
    this._heatNext = 0
    this.hud = this.$('.hud')
    this.hudText = this.$('.hud span')
    this.mac = this.$('.mac')
    this.macPaired = this.$('.macPaired')
    this.macPtr = this.$('.macPtr')
    this.macApp = this.$('.macApp')
    this.macAi = this.$('.macAi')
    this.macType = this.$('.macType')
    this.macTypeText = this.$('.macType span')
    this.qrPulse = this.$('.qrPulse')
    this.cam = this.$('.cam')
    this.wrapEl = this.$('.wrap')

    // Only animate while on screen. A hero that keeps ticking after the reader
    // scrolls past is pure battery burn on a phone.
    // Offscreen and manually-paused are separate reasons to stop; `paused` is
    // their OR. One flag for both let a scroll silently resume a clock the
    // harness had explicitly paused.
    this.io = new IntersectionObserver(
      ([e]) => {
        this.offscreen = !e.isIntersecting
        this.paused = this.offscreen || this.userPaused
        // Same observer resolves the first-boot gate -- a second one would
        // fire on the same entries for no benefit.
        if (e.isIntersecting) this._seen?.()
      },
      { threshold: 0.15 }
    )
    this.io.observe(this)

    new ResizeObserver(() => this.fit()).observe(this)
  }

  /** Size the iframe to the phone and scale it into the screen cutout.
   *
   *  In landscape the iframe becomes genuinely 844x390 and the whole DEVICE is
   *  rotated 90deg. The app reads `window.innerWidth > window.innerHeight`
   *  (App.tsx:2025) off a `resize` listener, so nothing short of a real
   *  dimension swap flips it -- an attribute or a CSS rotate leaves the app
   *  convinced it is still portrait and the deck lays out wrong.
   */
  fit() {
    const land = this.landscape
    const w = land ? PHONE_H : PHONE_W
    const h = land ? PHONE_W : PHONE_H
    const wrap = this.$('.wrap')
    const scr = this.$('.screen')
    // offset* NOT getBoundingClientRect: the shell carries a rotate+scale in
    // landscape, and the rect would report the transformed box (and a rotating
    // intermediate mid-transition). offset* is layout space, so the cutout
    // measures the same in both orientations -- which is the whole point, since
    // the shell rotating is what swaps width for height.
    const cutW = scr.offsetWidth
    const cutH = scr.offsetHeight
    const cut = land ? cutH : cutW
    if (!cut) return
    this.k = cut / w
    this.frame.style.width = `${w}px`
    this.frame.style.height = `${h}px`
    // The shell is rotated +90 in landscape, so an unrotated iframe would ride
    // that rotation and present its content sideways. Counter-rotate -90 to put
    // the app back upright inside the turned device, then translate down by the
    // scaled width: rotating about 0,0 swings the box up out of the cutout.
    this.frame.style.transform = land
      ? `translateY(${cutH}px) rotate(-90deg) scale(${this.k})`
      : `scale(${this.k})`
    // Landscape should FILL the width, not shrink to the portrait column. The
    // rotated device's long edge is the wrap's layout HEIGHT, so the scale that
    // makes it span the host is hostW/wrapH. Capped so the short edge (the
    // wrap's width, now vertical) can't outgrow the box the stack reserved --
    // otherwise the phone spills over the caption.
    // Fill the SQUARE lane. Both terms measure against the lane, not the host:
    // the lane is the box actually reserved for the turning phone, and it is
    // as wide as it is tall, so the rotated long edge is no longer the thing
    // that runs out of room first. fillW grows the long edge across the lane's
    // width; capH stops the short edge (now vertical) outgrowing its height.
    // Previously capH was wrapH/wrapW against a PORTRAIT box, which always won
    // and is why landscape came out smaller than portrait.
    // Make the lane square from JS. Every CSS route to this (aspect-ratio,
    // repeating the min() on width) lost to flex/grid content sizing and left
    // the lane at the phone's 240px, which is exactly the portrait clamp the
    // square arena exists to remove. offsetHeight is already the resolved
    // portrait height, so mirroring it onto width is unambiguous.
    const lane = this.$('.wrapLane')
    const laneH = lane?.offsetHeight || 0
    // Square, but never wider than the slot we were given -- a lane that
    // overflows the host would push the turned phone outside the hero column.
    const hostW = this.getBoundingClientRect().width
    if (lane && laneH) lane.style.width = `${hostW ? Math.min(laneH, hostW) : laneH}px`
    const laneW = lane?.offsetWidth || 0
    const wrapW = wrap.offsetWidth
    const wrapH = wrap.offsetHeight
    if (laneW && wrapH && wrapW) {
      const fillW = (laneW * LAND_FILL) / wrapH
      const capH = (laneH * LAND_FILL) / wrapW
      wrap.style.setProperty('--mm-land-k', String(Math.min(fillW, capH)))
    }
    // !! matters: toggle with an undefined force arg is a bare toggle, which
    // is how the pre-boot phone ended up sideways.
    wrap.classList.toggle('land', !!land)
  }

  /** Flip orientation. Costs a real resize, so the app re-lays-out for real. */
  setLandscape(on) {
    if (this.landscape === on) return
    this.landscape = on
    this.fit()
    // The app listens on `resize`, which an iframe dimension change fires by
    // itself -- but the mirror pane is OURS, so its geometry has to be redone
    // here. Cheapest correct move is a remount at the new size.
    const doc = this.frame.contentDocument
    doc?.querySelector('.proMirrorPane')?.remove()
    this.mirror = null
    // Same document, same staleness: mountVoice runs off mountMirror, so a
    // retained handle would point at nodes in the torn-down document.
    this.voice = null
    this._downEl = null
    requestAnimationFrame(() => this.mountMirror())
  }

  /* ── timing ─────────────────────────────────────────────────────────────── */

  sleep(ms) {
    return new Promise((res) => {
      const t0 = performance.now()
      const tick = () => {
        if (this.cancelled) return res('x')
        if (this.paused) return requestAnimationFrame(tick)
        if (performance.now() - t0 >= ms) return res()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }

  /* ── the finger ─────────────────────────────────────────────────────────── */

  /** Map a point from the APP's coordinates (inside the iframe) into the
   *  percentages place() writes on the finger.
   *
   *  This is the one primitive every finger movement depends on, and doing it by
   *  hand is a trap: in landscape .wrap carries rotate(90deg) while .device --
   *  the finger's offset parent -- carries no transform at all, so the app's
   *  axes and the finger's axes are a quarter turn apart. Deriving that
   *  conversion by hand failed four separate ways (wrong swap direction, wrong
   *  aspect term, client-rect vs layout-box, offsetLeft vs client offset), each
   *  one plausible enough to ship and wrong enough to put the finger on the
   *  mirror while it aimed at the trackpad.
   *
   *  So don't derive it -- ask the browser. getScreenCTM() is the exact matrix
   *  the browser used to paint the iframe, whatever transforms are stacked on
   *  it, so inverting the device's matrix and composing gives the true mapping
   *  in every orientation without this code knowing a rotation exists.
   *
   *  Everything that touches a control (tap, holdOn, keyTaps, padDrag) goes
   *  through rectOf, which goes through here -- fix it once, fixed everywhere.
   */
  appToDevice(ax, ay) {
    const f = this.finger
    if (!f) return null
    // CALIBRATE, don't derive. Park the finger at three known percentages, read
    // back where each one actually lands on screen, and solve for the affine map
    // between the two spaces. Whatever transforms sit between them -- rotation,
    // scale, future ones nobody has written yet -- are already baked into what
    // the browser reports, so this cannot drift out of sync with the CSS the way
    // a hand-derived formula does.
    const probe = (px, py) => {
      f.style.left = `${px}%`
      f.style.top = `${py}%`
      const b = f.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }
    const saved = [f.style.left, f.style.top]
    // Suppress the finger's position transition for the duration, or the probes
    // read points partway through an eased move rather than the real targets.
    const savedT = f.style.transition
    f.style.transition = 'none'
    const o = probe(0, 0)
    const ux = probe(100, 0) // where +100% of x goes, in screen px
    const uy = probe(0, 100) // and +100% of y
    f.style.left = saved[0]
    f.style.top = saved[1]
    void f.offsetWidth
    f.style.transition = savedT

    // Basis vectors of device-% in screen space.
    const bx = { x: ux.x - o.x, y: ux.y - o.y }
    const by = { x: uy.x - o.x, y: uy.y - o.y }
    const det = bx.x * by.y - bx.y * by.x
    if (!det) return null

    // The app point, in screen px.
    const sp = this.appToScreen(ax, ay)
    if (!sp) return null
    // Invert the 2x2 to go screen px -> device %.
    const dx = sp.x - o.x
    const dy = sp.y - o.y
    return {
      x: (dx * by.y - dy * by.x) / det,
      y: (bx.x * dy - bx.y * dx) / det
    }
  }

  /** A point in the app's own document -> screen px. The iframe's client rect
   *  already carries whatever transform is on it, so scaling by k against its
   *  top-left is enough and stays correct if the shell is rotated. */
  appToScreen(ax, ay) {
    const doc = this.frame?.contentDocument
    if (!doc) return null
    // Use a real element in the app document as the reference: its client rect
    // is reported in screen space by the same engine that painted it.
    const root = doc.documentElement.getBoundingClientRect()
    return { x: root.left + ax * this.k, y: root.top + ay * this.k }
  }

  /* ── the surface seam ───────────────────────────────────────────────────────
   *
   *  The timeline asks the phone's screen for exactly two things: WHERE a
   *  control is, and MAKE it look pressed. On the landing page that screen is
   *  the real phone-remote bundle in an iframe, so both go through it.
   *
   *  A surface with no bundle (the onboarding window, which must not open a
   *  socket) overrides these two and answers from its own drawn panel. Every
   *  beat, duration, caption and easing above stays shared and untouched --
   *  these are the only methods that know an iframe exists.
   */

  /** The DOM node for a control selector, or null. */
  controlNode(sel) {
    return this.frame?.contentDocument?.querySelector(sel) || null
  }

  /** Paint a control as pushed. Sweeps the others so at most one is ever down. */
  pressNode(el, down) {
    const doc = this.frame?.contentDocument
    if (doc) {
      for (const p of doc.querySelectorAll('.proKeyPill[style], .proMicSideBtn[style]')) {
        if (p !== el && p.style.transform) {
          p.style.transform = ''
          p.style.filter = ''
        }
      }
    }
    if (!el) return
    el.style.transition = 'transform .07s ease-out, filter .07s ease-out'
    el.style.transform = down ? 'scale(.94) translateY(1px)' : ''
    el.style.filter = down ? 'brightness(.9)' : ''
  }

  /** Look up a control the bundle actually renders and convert it to device %.
   *  A miss is logged loudly: a finger tapping empty space reads as a timing
   *  bug, and "silently tapped nothing" is the most expensive failure here. */
  rectOf(sel) {
    const el = this.controlNode(sel)
    if (!el) {
      console.warn(`[mm-phone-demo] no "${sel}" — bundle changed or not mounted`)
      return null
    }
    const r = el.getBoundingClientRect()
    const scr = this.$('.screen')
    const dev = this.device.getBoundingClientRect()
    const sb = scr.getBoundingClientRect()
    const ox = sb.left - dev.left
    const oy = sb.top - dev.top
    // The SIZE comes back too, not just the centre. Anything that drags across
    // a control has to scale its path to that control's actual box: the
    // trackpad is a ~90%-wide square in portrait but a ~27%-wide column in
    // landscape, so a path written in fixed percent offsets slides straight off
    // it and lands on the mirror instead.
    //
    // In LANDSCAPE the two coordinate spaces are a quarter turn apart. .wrap is
    // rotated +90deg and the iframe counter-rotates -90deg so the app stays
    // upright inside the turned shell -- but the finger is a sibling of the
    // iframe, so it gets the wrap's rotation and NOT the counter-rotation. A
    // rect read off the app therefore has to be turned back by that same +90
    // before place() can use it, or the finger aims at the trackpad and lands
    // on the mirror (the bug: pad top-right, finger bottom-left).
    //
    return {
      x: ((ox + (r.left + r.width / 2) * this.k) / dev.width) * 100,
      y: ((oy + (r.top + r.height / 2) * this.k) / dev.height) * 100,
      w: ((r.width * this.k) / dev.width) * 100,
      h: ((r.height * this.k) / dev.height) * 100
    }
  }

  place(x, y) {
    this.finger.style.left = `${x}%`
    this.finger.style.top = `${y}%`
    if (!this.tracking) return
    // Percent -> device px. Pool size and blur are absolute, so they have to be
    // stamped in a square space or they come out elliptical.
    const box = this.device.getBoundingClientRect()
    if (!box.width) return
    const px = (x / 100) * box.width
    const py = (y / 100) * box.height
    const prev = this._padLast
    const sp = prev ? Math.hypot(px - prev.x, py - prev.y) : 0

    // Stamp on distance, not on every frame. Frame-rate stamping would burn the
    // whole pool in 22 frames of a fast drag and leave a stub of a trail; on a
    // slow one it would pile 60 pools on the same pixel. Distance makes the
    // trail's LENGTH the honest thing and lets dwell-in-place stack naturally,
    // because a still finger simply never advances past the threshold and keeps
    // re-heating the pool it already owns.
    if (!prev || sp >= HEAT_MIN_STEP) {
      this._padLast = { x: px, y: py }
      // Faster drag = wider, hotter pool, same as pressing harder smears more.
      const speedN = Math.min(sp / 26, 1)
      this.stampHeat(px, py, speedN)
    } else if (this._heatHold) {
      // Dwelling: keep the current pool alive rather than letting it cool, so
      // holding still reads as heat BUILDING, which is the whole metaphor.
      this._heatHold.born = performance.now() - HEAT_LIFE * 0.35
    }
    this.coolHeat()
  }

  /** Stamp one heat pool at a pixel point. */
  stampHeat(px, py, speedN) {
    const slot = this.heatDots[this._heatNext % HEAT_POOL]
    this._heatNext++
    if (!slot) return
    const size = 40 + speedN * 30
    const t = speedN * 0.4
    const ch = (i) => Math.round(COMET_A[i] + (COMET_B[i] - COMET_A[i]) * t)
    const core = `${ch(0)}, ${ch(1)}, ${ch(2)}`
    slot.born = performance.now()
    slot.size = size
    slot.el.style.width = `${size}px`
    slot.el.style.height = `${size}px`
    slot.el.style.marginLeft = `${-size / 2}px`
    slot.el.style.marginTop = `${-size / 2}px`
    // No hard edge anywhere in the stop list -- the moment a heat pool has a
    // visible rim it stops reading as heat and starts reading as a bubble.
    // Under plus-lighter, overlapping pools SUM. A solid core at full tint
    // therefore blows out to white where the trail doubles back on itself,
    // which reads as flame rather than heat. Starting the stop list already
    // partly transparent leaves room for that stacking to be the thing that
    // brightens the dwell points, instead of every single pool being maximal.
    slot.el.style.background =
      `radial-gradient(circle, rgba(${core}, .62) 0%, ` +
      `rgba(255,152,72,.4) 34%, rgba(255,142,60,.16) 60%, rgba(255,138,56,0) 78%)`
    slot.el.style.transform = `translate3d(${px}px, ${py}px, 0) scale(.72)`
    slot.el.style.opacity = '0'
    this._heatHold = slot
  }

  /** Age every pool one frame. Pools grow slightly and fade as they cool, so a
   *  trail reads hottest and tightest at the finger and diffuse behind it. */
  coolHeat() {
    const now = performance.now()
    for (const s of this.heatDots) {
      const age = (now - s.born) / HEAT_LIFE
      if (age < 0 || age > 1) {
        if (s.el.style.opacity !== '0') s.el.style.opacity = '0'
        continue
      }
      // Ramp in over the first 12% so a fresh stamp doesn't pop at full heat.
      const rise = Math.min(age / 0.12, 1)
      // cool^1.5, not cool^2. Squaring dropped a mid-life pool to a quarter
      // brightness, which measured as "painting" while being invisible on the
      // cork pad -- the trail existed only in the DOM. 1.5 keeps the body of
      // the smear readable and still ends at nothing.
      const cool = (1 - age) ** 1.5
      s.el.style.opacity = String(rise * cool * 0.95)
      const grow = 0.72 + age * 0.55
      const t = s.el.style.transform
      const i = t.indexOf(' scale(')
      if (i > 0) s.el.style.transform = `${t.slice(0, i)} scale(${grow.toFixed(3)})`
    }
  }

  /** Start/stop the heat map. Clearing `_padLast` on release matters: without
   *  it the next press measures its speed against wherever the finger last was
   *  and opens with one fake, oversized pool. */
  trail(on) {
    this.tracking = on
    this.device.classList.toggle('trailing', on)
    if (on) return
    this._padLast = null
    this._heatHold = null
    // Let the existing pools cool on their own clock rather than snapping off.
    // The container fades over .22s, which is shorter than a pool's life, so
    // the smear dies with the touch instead of hanging around the empty pad.
    for (const s of this.heatDots) s.born = -1e9
  }

  async moveTo(x, y, ms = 460) {
    const x0 = parseFloat(this.finger.style.left) || x
    const y0 = parseFloat(this.finger.style.top) || y
    const t0 = performance.now()
    return new Promise((res) => {
      const tick = () => {
        if (this.cancelled) return res()
        if (this.paused) return requestAnimationFrame(tick)
        const p = Math.min(1, (performance.now() - t0) / ms)
        const e = easeInOut(p)
        this.place(x0 + (x - x0) * e, y0 + (y - y0) * e)
        if (p < 1) return requestAnimationFrame(tick)
        res()
      }
      requestAnimationFrame(tick)
    })
  }

  press(ms = 150, target = null) {
    for (const cls of ['ripple glow', 'ripple']) {
      const el = document.createElement('div')
      el.className = cls
      el.style.left = this.finger.style.left
      el.style.top = this.finger.style.top
      this.device.appendChild(el)
      setTimeout(() => el.remove(), 700)
    }
    this.finger.classList.add('down')
    // Depress the key itself, not just the finger. Without this the cap stays
    // proud while a translucent disc sits on top of it, which reads as the
    // finger hovering rather than pressing. Inline transform so it composes
    // with whatever the skin's own :active rule does (some skins ship one,
    // some don't -- this makes the press visible either way).
    if (target) {
      target.style.transition = 'transform .07s ease-out, filter .07s ease-out'
      target.style.transform = 'scale(.94) translateY(1px)'
      target.style.filter = 'brightness(.9)'
    }
    return this.sleep(ms).then(() => {
      this.finger.classList.remove('down')
      if (target) {
        target.style.transform = ''
        target.style.filter = ''
      }
    })
  }

  show(on) {
    this.finger.style.opacity = on ? '1' : '0'
  }

  /** Take the touch layer down INSTANTLY, for the intro beats only.
   *
   *  show(false) fades over .25s, which is right mid-loop but wrong on the wrap:
   *  the fade then overlaps the intro's scale(.42) and you catch a squashed
   *  half-transparent disc clipped by the pad's rounded carve -- it reads as a
   *  stray triangle sitting on the trackpad. Ripples are worse: they are real
   *  elements on a 700ms self-delete, so a press fired in the last beat outlives
   *  the reset entirely.
   *
   *  The pad heat trail is CORRECT during the touch beats and is only dropped
   *  here, where nothing is touching anything yet. */
  clearTouch() {
    const f = this.finger
    if (f) {
      const t = f.style.transition
      f.style.transition = 'none'
      f.style.opacity = '0'
      f.classList.remove('down')
      void f.offsetWidth
      f.style.transition = t
    }
    this.device?.querySelectorAll('.ripple').forEach((el) => el.remove())
    this.device?.classList.remove('trailing')
    if (this.padHeat) this.padHeat.style.opacity = '0'
  }

  /** Where the finger actually is right now, in device-percent.
   *
   *  Falls back to the RENDERED position rather than a made-up point: an unset
   *  inline style still paints somewhere, and inventing (50, 62) is what made
   *  the finger snap to mid-screen when Pad re-anchored after the Mirror beat. */
  fingerAt() {
    const sx = parseFloat(this.finger.style.left)
    const sy = parseFloat(this.finger.style.top)
    if (Number.isFinite(sx) && Number.isFinite(sy)) return [sx, sy]
    const box = this.device.getBoundingClientRect()
    const r = this.finger.getBoundingClientRect()
    if (!box.width || !r.width) return [50, 62]
    return [
      ((r.left + r.width / 2 - box.left) / box.width) * 100,
      ((r.top + r.height / 2 - box.top) / box.height) * 100
    ]
  }

  /**
   * Ease the finger from WHEREVER IT IS to (x, y) over the first `span` of a
   * beat's progress. Frame-driven, not a promise -- beats are pure functions of
   * p, so a travel animation has to be too, or scrubbing backwards can't undo it.
   *
   * The anchor is captured once per approach (`_glideKey` changes) instead of
   * being read every frame: reading the live position each frame makes the
   * finger chase a receding target and it never arrives. Capturing it means a
   * beat entered from any previous position glides in continuously rather than
   * teleporting to a hardcoded start point -- the jump the user saw between beats.
   */
  glideTo(key, x, y, p, span) {
    if (this._glideKey !== key) {
      this._glideKey = key
      this._glideFrom = this.fingerAt()
    }
    const [x0, y0] = this._glideFrom
    const lp = span > 0 ? easeInOut(clamp01(p / span)) : 1
    this.place(x0 + (x - x0) * lp, y0 + (y - y0) * lp)
    return lp
  }

  /** Move onto a real control, press it, and fire its handler. Returns false on
   *  a miss so a beat can bail instead of miming against nothing. */
  async tap(sel, { moveMs = 460, hold = 150, activate = true } = {}) {
    const r = this.rectOf(sel)
    if (!r) return false
    await this.moveTo(r.x, r.y, moveMs)
    const el = this.controlNode(sel)
    await this.press(hold, el)
    if (activate) {
      // pointerdown, not click: every control that raises a keyboard in this
      // app fires on pointerdown (react/CLAUDE.md), and click lands ~300ms
      // later -- outside the window some of them care about.
      el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      el?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      el?.click?.()
    }
    return true
  }

  say(text) {
    if (!text) return this.cap.classList.remove('on')
    // Same text (a re-entered beat, a scrub inside one) must NOT restart the
    // animation, or dragging the scrubber strobes the caption.
    if (this._capText === text) return
    this._capText = text
    // Drop `.on` first so the line animates OUT, then swap the words and let it
    // fly back in. Setting textContent while `.on` is still applied just
    // replaces the glyphs in place -- no motion at all, which is the bug this
    // whole change exists to fix.
    this.cap.classList.remove('on')
    clearTimeout(this._capT)
    this._capT = setTimeout(() => {
      this.cap.textContent = text
      // Force a reflow so the browser sees the out-state before the in-state;
      // without it the two class changes coalesce into no transition.
      void this.cap.offsetWidth
      this.cap.classList.add('on')
    }, 150)
  }

  /**
   * Per-beat flashcard placement. No-op unless `flashcards` is set.
   *
   * Entry side alternates, and X is SIDE-BOUND rather than merely biased: the
   * magnitude never exceeds 0.66 of the base, so the random term cannot drag
   * the card across centre and a card thrown from the left always settles left
   * of centre. Y alternates high/low on its own cadence -- tying it to the X
   * flip would trace a diagonal, which is just a different pattern. The theme
   * flips on its own cadence for the same reason. Both are seeded at random so
   * two demos on one page do not march in lockstep.
   */
  _rollCard() {
    if (!this.hasAttribute('flashcards')) return
    if (this._fcHigh === undefined) this._fcHigh = Math.random() < 0.5
    if (this._fcInk === undefined) this._fcInk = Math.random() < 0.5
    this._fcRight = !this._fcRight
    this._fcHigh = !this._fcHigh
    this._fcInk = !this._fcInk
    const Y_BASE = 14
    const sx = this._fcRight ? 1 : -1
    const spread = () => 1 - Math.random() * 0.66
    const s = this.cap.style
    // X is a share of the LEFTOVER room, not a pixel nudge. margin:auto centres
    // the card, so half the slack is exactly the travel that lands its far edge
    // on the host's edge; 0.86 of that keeps a sliver of inset. A flat 26px was
    // invisible at hero size -- every card read as centred, straddling centre.
    //
    // Measured, not expressed in CSS: a % inside translate() resolves against
    // the ELEMENT, so the slack (a host-vs-card difference) has no CSS spelling
    // here. The card is laid out before this runs, so both boxes are readable.
    const slack = Math.max(0, this.clientWidth - this.cap.offsetWidth) / 2
    s.setProperty('--fx', (sx * 0.86 * slack * spread()).toFixed(1) + 'px')
    s.setProperty('--fy', ((this._fcHigh ? -1 : 1) * Y_BASE * spread()).toFixed(1) + '%')
    s.setProperty('--fr', ((Math.random() * 2 - 1) * 3.6 - sx * 1.4).toFixed(2) + 'deg')
    this.cap.classList.toggle('capR', this._fcRight)
    this.cap.classList.toggle('capInk', this._fcInk)
  }

  /**
   * Feature HUD. Idempotent on the same text so a per-frame caller doesn't
   * restart the fade -- beats drive this from `at(p)`, which runs every frame.
   */
  showHud(text) {
    if (!text) {
      this.hud.classList.remove('on')
      this._hudText = ''
      return
    }
    if (this._hudText === text) return
    this._hudText = text
    this.hudText.textContent = text
    this.hud.classList.add('on')
  }

  /* ── booting the real bundle ────────────────────────────────────────────── */

  async boot(skin = 'proII') {
    if (!this.html) {
      const res = await fetch(`${this.bundleUrl}index.html`)
      if (!res.ok) throw new Error(`no bundle at ${this.bundleUrl} — build:phone-remote`)
      // The <base> keeps every relative asset resolving once the document is
      // loaded into a srcdoc iframe whose own URL is this page; "./" src/href
      // attributes are also made absolute because Chrome's speculative preload
      // in srcdoc resolves them before <base> applies (a 404 per asset).
      // Attribute-less inline <script>s are stripped: the iframe inherits this
      // page's CSP (script-src without 'unsafe-inline'), so they would only be
      // blocked and log console errors. The module <script src> is kept. The
      // preview flags come from phone-demo-preview.js instead (see boot()).
      this.html = (await res.text())
        .replace(/<script>[\s\S]*?<\/script>/g, '')
        .replace(/(\s(?:src|href)=")\.\//g, `$1${this.bundleUrl}`)
        .replace('<head>', `<head><base href="${this.bundleUrl}">`)
    }
    if (!this.skins) {
      this.skins = await fetch(this.skinsUrl)
        .then((r) => r.json())
        .catch(() => [])
    }

    const remote = skin.startsWith('remote:')
    const entry = remote ? this.skins.find((s) => s.id === skin.slice(7)) : null
    const prefs = {
      layout: 'pro',
      // A remote skin is painted by injected CSS keyed on data-skin=<id>, so the
      // pref carries the bare id -- the `remote:` prefix is this component's
      // own routing, not something the bundle understands offline.
      skin: remote ? (entry?.id ?? 'default') : skin,
      colorScheme: 'light',
      handedness: 'right',
      keysPosition: 'bottom',
      deckMode: 'unified',
      showCursor: true,
      renderMarkup: false
    }

    const inject =
      // PREVIEW_MODE hides the reconnect BANNER but not the status line, which
      // still reads "Can't reach your Mac -- rescan the QR code" on a load that
      // was never meant to connect. Hidden here rather than in the app: this is
      // an embed concern, and the real app needs that line.
      // .reconnectBanner is ALSO gated on PREVIEW_MODE in the app, so this is
      // belt-and-braces -- but that gate is a module-eval read of an injected
      // global, and anything that costs it the race (a stale cached bundle, a
      // srcdoc ordering change) paints a red "Reconnecting… (attempt 4)"
      // strip across the hero. CSS in the same document can't lose that race.
      `<style>.proStatus,.reconnectBanner{display:none!important}` +
      SAFE_CSS +
      MIRROR_CSS +
      VOICE_CSS +
      (entry ? entry.css : '') +
      `<\/style>`

    // Rewriting a loaded iframe in place does not reliably re-mount
    // the app (deck-viewer hit this: the deck comes back empty on every reboot
    // after the first). Replacing the element gives a genuinely fresh document.
    // The document goes in via srcdoc (no document.write). The bundle reads
    // __MM_PREVIEW__ / __MM_LAYOUT_PREFS__ at module top level, so they must
    // exist before its module script runs; an inline <script> would be blocked
    // by the inherited CSP, so a same-origin external classic script
    // (phone-demo-preview.js) sets them first, reading the prefs from this
    // iframe's data-mm-prefs. It also stubs WebSocket so the never-connecting
    // preview does not log failed wss:// handshakes.
    const fresh = this.frame.cloneNode(false)
    fresh.dataset.mmPreview = ''
    fresh.dataset.mmPrefs = JSON.stringify(prefs)
    fresh.srcdoc = this.html
      .replace(`<base href="${this.bundleUrl}">`, (m) => m + `<script src="${PREVIEW_SCRIPT}"><\/script>`)
      .replace('</head>', inject + '</head>')
    this.frame.replaceWith(fresh)
    this.frame = fresh
    this.fit()
    await new Promise((r) => requestAnimationFrame(r))
    const up = await this.waitForDeck()

    // data-img-skin is what REMOVES the token sculpt (the keycap's baked top
    // face, the pad's hint label) so the skin's pictures are what you see. The
    // app derives it from the INSTALLED-skin record, which only exists after a
    // real install -- offline the CSS loads and the deck still renders as a
    // flat colour slab. Stamped here from the catalog's own imageSkin flag.
    if (up && entry?.imageSkin) {
      const root = this.frame.contentDocument.querySelector('.proRoot')
      root?.setAttribute('data-img-skin', '')
      root?.setAttribute('data-skin', entry.id)
    }
    // Every boot writes a fresh document, so the pane has to be re-injected --
    // including on each skin swap, or the mirror vanishes halfway through the
    // carousel and the pad jumps up to reclaim the band.
    this.mirror = null
    // Same document, same staleness: mountVoice runs off mountMirror, so a
    // retained handle would point at nodes in the torn-down document.
    this.voice = null
    this._downEl = null
    if (up) this.mountMirror()
    return up
  }

  /* ── the screen mirror ──────────────────────────────────────────────────── */

  /** Build the mirror pane inside the app's own document.
   *
   *  Injected rather than switched on: .proMirrorPane is React-gated on
   *  `mirrorOn`, which only goes true off a live WebRTC stream. Flipping
   *  data-mirror alone moves the PAD (theme.css:4925 reclaims the band when
   *  mirror is off) but never creates the pane, so both are needed -- the
   *  attribute for the app's geometry, the node for the picture. Class names
   *  match the app's so the pane inherits the real stylesheet.
   */
  /** Show/hide the Mac inside the mirror. Idempotent -- beats call it every
   *  frame from `at(p)`, and re-adding a class that is already there would
   *  restart nothing but costs a style recalc per frame. */
  revealMirror(on) {
    const pane = this.mirror?.pane || this.frame.contentDocument?.querySelector('.proMirrorPane')
    if (!pane) return
    if (pane.classList.contains('mmLive') === on) return
    pane.classList.toggle('mmLive', on)
    // The PANE's box, not just its contents. Before the mirror arrives the pad
    // owns the full height it has in the app with mirroring off; turning the
    // mirror on is what shortens it. Fading only .mmFakeMac left the pad short
    // from frame 1, so the mirror looked like it had always been there and the
    // trackpad never read as the main event.
    this.frame.contentDocument
      ?.querySelector('.proRoot')
      ?.setAttribute('data-mirror', on ? 'on' : 'off')
    // The pad is mid-transition for 380ms after this; re-measure across it or
    // the notch carve keeps the height the pad had before the mirror moved.
    this.pokeNotch([0, 200, 420])
  }

  mountMirror() {
    const doc = this.frame.contentDocument
    const card = doc?.querySelector('.proCard')
    if (!card) return false
    // Two callsites can race onto the same document (the boot rAF and the
    // orientation remount); a second pane stacks on the first and covers every
    // later window switch with a stale Chrome window.
    doc.querySelector('.proMirrorPane')?.remove()
    // Mounts CLOSED and is opened by revealMirror below. A remount mid-loop
    // (skin swap, orientation flip) re-opens it on the same frame, so only a
    // fresh load — which always starts on the Mirror beat — actually shows the
    // tall pad.
    doc.querySelector('.proRoot')?.setAttribute('data-mirror', 'off')
    const pane = doc.createElement('div')
    pane.className = 'mirrorPane proMirrorPane'
    // Portrait height is left to the [data-mirror] rules in MIRROR_CSS -- they
    // are what animate the box open, and an inline height (no !important) would
    // outrank the collapsed `off` rule and pin the pane open from frame 1.
    // Landscape's rail is sized from aspect-ratio by the stylesheet either way.
    pane.innerHTML =
      `<div class="mmFakeMac">` +
      `<div class="mmBar"><b></b><span>Finder</span><span class="sp"></span><span>100%</span></div>` +
      MAC_APPS.filter((a) => a.kind)
        .map(
          (a, i) =>
            `<div class="mmWin ${a.key}${i === 0 ? ' on' : ''}">` +
            `<div class="mmTitle"><i class="mmDot r"></i><i class="mmDot y"></i>` +
            `<i class="mmDot g"></i><img class="mmTIco" src="${a.icon}" alt="">` +
            `<span>${a.name}</span></div>` +
            `<div class="mmBody">${macBody(a.kind)}</div></div>`
        )
        .join('') +
      // Tail first, then orb, then the arrow: paint order is the z-order the
      // companion uses -- the glyph rides on top of its own glow.
      `<div class="mmCometTail"></div><div class="mmComet"></div>` +
      `<svg class="mmCursor" viewBox="0 0 12 12" fill="none">` +
      `<path d="M1 1l9 3.6-3.7 1.2L4.9 10z" fill="#fff" stroke="#111" stroke-width="1"` +
      ` stroke-linejoin="round"/></svg>` +
      `<div class="mmSwitcher">` +
      MAC_APPS.map(
        (a, i) =>
          `<div class="mmTile${i === 0 ? ' sel' : ''}">` +
          `<img src="${a.icon}" alt="${a.name}"></div>`
      ).join('') +
      `</div>`
    card.prepend(pane)
    // Landscape's pad and controls are offset by --pro-mirror-w to clear the
    // rail (theme.css:5884). App.tsx publishes it from the live stream's width;
    // with no stream the CSS falls back to 55%, which is not the width of a
    // 16:10 rail in an 844x390 viewport. Set it from the same aspect the pane
    // actually uses so the two agree.
    const html = doc.documentElement
    if (this.landscape) {
      const railW = Math.round((PHONE_W - SAFE_BOTTOM) * 1.6)
      html.style.setProperty('--pro-mirror-w', `${railW}px`)
    } else {
      html.style.removeProperty('--pro-mirror-w')
    }
    this.mirror = {
      pane,
      cursor: pane.querySelector('.mmCursor'),
      comet: pane.querySelector('.mmComet'),
      tail: pane.querySelector('.mmCometTail'),
      switcher: pane.querySelector('.mmSwitcher'),
      tiles: [...pane.querySelectorAll('.mmTile')],
      wins: MAC_APPS.map((a) => pane.querySelector(`.mmWin.${a.key}`)),
      // Previous position in px, for the velocity the comet reacts to.
      last: null
    }
    this.macCursor(0.5, 0.55)
    // A remount (skin swap, orientation flip) builds a fresh pane with no
    // mmLive, which would replay the pop-in in the middle of the loop. Only the
    // Mirror beat is allowed to animate it; everywhere else it arrives already
    // on. No transition on this first paint, or the swap itself fades.
    if (this.current && this.current.name !== 'Mirror') {
      const fake = pane.querySelector('.mmFakeMac')
      if (fake) fake.style.transition = 'none'
      // Suppress the BOX transition too, not just the contents' -- otherwise a
      // mid-loop skin swap animates the pane open again and the pad slides.
      pane.style.transition = 'none'
      pane.classList.add('mmLive')
      doc.querySelector('.proRoot')?.setAttribute('data-mirror', 'on')
      requestAnimationFrame(() => {
        if (fake) fake.style.transition = ''
        pane.style.transition = ''
      })
    }
    // The deck mounts with mirror OFF, so useNotchPath measures a full-height
    // pad and bakes that into the clip path -- then data-mirror='on' shortens
    // the pad by 204px and the carve is stale (measured: path ran to y=310 on a
    // 521px pad, i.e. a square bite in the wrong place). The hook's own
    // ResizeObserver settles on a timer that has already fired by now, so it
    // needs a second nudge once the pane is in the tree.
    this.pokeNotch([0, 120, 400])
    this.mountVoice()
    return true
  }

  /** Build the voice-beat chrome inside the app's document.
   *
   *  Injected for the same reason the mirror is: React gates the waveform, the
   *  transcribe pill and the toast on a live recording and a real Whisper round
   *  trip, neither of which exists in an embed. The CLASSES are the app's own,
   *  so all three inherit the shipped styling (and every skin's overrides of
   *  it) rather than being re-drawn here.
   */
  mountVoice() {
    const doc = this.frame.contentDocument
    const root = doc?.querySelector('.proRoot')
    if (!root) return
    for (const sel of ['.mmBars', '.mmVoicePill', '.mmVoiceToast']) {
      doc.querySelector(sel)?.remove()
    }
    const bars = doc.createElement('div')
    bars.className = 'mmBars'
    bars.innerHTML = '<i></i>'.repeat(7)
    const pill = doc.createElement('div')
    // micTranscribeLive is what the app puts up between release and transcript.
    pill.className = 'micTranscribing micTranscribeLive mmVoicePill mmFade'
    pill.innerHTML = '<span>Transcribing…</span>'
    const toast = doc.createElement('div')
    toast.className = 'toast mmVoiceToast mmFade'
    toast.innerHTML = `<span class="toastText">${DICTATION}</span>`
    root.append(bars, pill, toast)
    this.voice = { bars: [...bars.querySelectorAll('i')], barBox: bars, pill, toast }
  }

  /** Hold the mic, watch it hear you, then watch the words land on the Mac.
   *
   *  Four phases, because the value is the HANDOFF between them -- a beat that
   *  only holds the mic shows a button being pressed, not a product working:
   *    hold      finger down, waveform reacting
   *    release   waveform out
   *    pill      "Transcribing…" in the same band the waveform just left
   *    toast     transcript on the phone AND typing into the Mac's front window
   *
   *  Everything is derived from `p` rather than timers so scrubbing backwards
   *  un-does each phase exactly as it did it.
   */
  voiceBeat(p) {
    const v = this.voice
    if (!v) return
    const rec = p >= VOICE.hold && p < VOICE.release
    // Hold the REAL mic button. .proMicSideBtn is Cancel/Stop, which only
    // exists once recording is already under way -- pressing it to START was
    // miming against a control the user never touches first.
    this.holdOn('.proMicBtn', p, VOICE.hold, VOICE.release)
    v.barBox.classList.toggle('on', rec)
    if (rec) {
      // A synthesised envelope: three detuned sines so the bars never fall into
      // a visible repeating pattern, plus a per-bar phase offset so they don't
      // pump in unison. Speech-shaped enough to read as a voice, and cheap.
      const t = (p - VOICE.hold) / (VOICE.release - VOICE.hold)
      v.bars.forEach((b, i) => {
        const ph = i * 0.7
        const a =
          0.5 +
          0.32 * Math.sin(t * 34 + ph) +
          0.12 * Math.sin(t * 61 + ph * 1.7) +
          0.06 * Math.sin(t * 97 + ph * 2.3)
        // Taper the ends so the cluster reads as a waveform, not a bar chart.
        const taper = 1 - Math.abs(i - (v.bars.length - 1) / 2) / v.bars.length
        b.style.setProperty('--mmA', String(clamp01(a * (0.55 + taper * 0.75))))
      })
    }
    v.pill.classList.toggle('on', p >= VOICE.pill && p < VOICE.toast)
    const done = p >= VOICE.toast
    v.toast.classList.toggle('on', done)
    // Type the transcript into the Mac's front window, in step with the tail of
    // the beat. The phone showing a transcript is the feature; the Mac ACTING
    // on it is the point.
    this.dictate(done ? clamp01((p - VOICE.toast) / (1 - VOICE.toast - 0.08)) : 0)
  }

  /* ── the opening: laptop, QR, pairing ───────────────────────────────────── */

  /** Stage the phone for the intro.
   *
   *  `k` is its scale, `x`/`y` its offset from the lane centre in percent of
   *  its own box. All three are written as CSS vars and consumed by .wrap.intro,
   *  so the intro never touches the transform the landscape rule owns.
   *
   *  Called with on=false to hand the stage back: the class comes off and the
   *  phone is exactly where every later beat expects it, with no leftover
   *  transform to unwind.
   */
  stagePhone(on, k = 1, x = 0, y = 0) {
    const w = this.wrapEl
    if (!w) return
    // 'gone' is a third state, not a flavour of off: off means "on stage at its
    // normal size", which is what every beat after the intro wants.
    w.classList.toggle('gone', on === 'gone')
    if (on === 'gone') return
    if (!on) {
      w.classList.remove('intro')
      w.style.removeProperty('--mm-intro-k')
      w.style.removeProperty('--mm-intro-x')
      w.style.removeProperty('--mm-intro-y')
      return
    }
    w.classList.add('intro')
    w.style.setProperty('--mm-intro-k', String(k))
    w.style.setProperty('--mm-intro-x', `${x}cqw`)
    w.style.setProperty('--mm-intro-y', `${y}cqw`)
  }

  /** Show/hide the laptop. `k` scales it so it can withdraw as the phone grows.
   *  Idempotent on the class for the same reason revealMirror is: beats call
   *  this every frame. */
  showMac(on, k = 1) {
    if (!this.mac) return
    if (this.mac.classList.contains('on') !== on) this.mac.classList.toggle('on', on)
    this.mac.style.setProperty('--mm-mac-k', String(k))
  }

  /** The laptop's screen state: 'qr' while waiting, 'paired' once the phone has
   *  read it. Split out because three separate beats need to assert it, and a
   *  scrub backwards has to be able to put the QR back. */
  macState(paired) {
    this.macPaired?.classList.toggle('on', paired)
    this.mac?.classList.toggle('paired', paired)
    // The QR pane fades out under the paired pane rather than being removed, so
    // the two cross-fade instead of the screen blinking through the background.
    if (this.macApp) this.macApp.style.opacity = paired ? '0' : '1'
  }

  /** The pointer drawn ON the laptop screen, in the same 0..1 coordinates
   *  macCursor takes. Separate from macCursor because that one lives inside the
   *  mirror pane, which is shut during Drive -- the beat where watching the Mac
   *  pointer follow the finger is the entire point. Pass on=false to hide it. */
  macDeskCursor(fx, fy, on = true) {
    const c = this.macPtr
    if (!c) return
    c.classList.toggle('on', on)
    if (!on) return
    c.style.left = `${clamp01(fx) * 100}%`
    c.style.top = `${clamp01(fy) * 100}%`
  }

  /** How awake the Mac looks, 0 = asleep (grey, dim) .. 1 = fully alive.
   *  The opening beat runs this 0 -> 1 so the machine visibly gains its colour
   *  at the moment MightyMouse takes the cursor. Driven as two CSS vars on one
   *  parent so every element on the desktop wakes on the same curve. */
  macWake(k) {
    const s = this.$('.macScreen')
    if (!s) return
    const e = clamp01(k)
    // Asleep is desaturated but not fully grey: a 0-saturation Mac reads as a
    // broken screenshot, whereas a washed-out one reads as "before".
    s.style.setProperty('--mm-wake-s', String(0.28 + 0.72 * e))
    s.style.setProperty('--mm-wake-b', String(0.62 + 0.38 * e))
  }

  /** MightyMouse's answer panel on the laptop. `k` runs 0 -> 1 to snap it open
   *  from the cursor's corner; fx/fy place its top-left in the same 0..1 space
   *  macDeskCursor uses, so it hangs off the pointer wherever that is. */
  macAiPanel(k, fx = 0, fy = 0) {
    const el = this.macAi
    if (!el) return
    const e = clamp01(k)
    el.style.opacity = String(e)
    el.style.left = `${clamp01(fx) * 100}%`
    el.style.top = `${clamp01(fy) * 100}%`
    // Snap open from the pointer: scale from 0.7 with a slight rise, so the
    // panel looks thrown by the cursor rather than cross-faded in place.
    el.style.transform = `translateY(${(1 - e) * 1.2}cqw) scale(${0.7 + 0.3 * e})`
  }

  /** The desk dictation field. `frac` runs 0 -> 1 to type DESK_DICTATION in;
   *  <= 0 takes the field down. Rebuilt from the fraction each call, so a
   *  scrub backwards shortens the line instead of leaving it finished. */
  macDictate(frac) {
    const el = this.macType
    if (!el) return
    const e = clamp01(frac)
    if (e <= 0) return el.classList.remove('on')
    el.classList.add('on')
    const n = Math.round(DESK_DICTATION.length * e)
    if (this.macTypeText) this.macTypeText.textContent = DESK_DICTATION.slice(0, n)
  }

  /** Whether the pointer is wearing MightyMouse's glow. */
  macPtrLit(on) {
    this.macPtr?.classList.toggle('lit', !!on)
  }

  /** Camera viewfinder over the phone's screen. Idempotent for the same reason
   *  showMac is: the intro beats assert it every frame. */
  showCam(on) {
    if (!this.cam) return
    if (this.cam.classList.contains('on') !== on) this.cam.classList.toggle('on', on)
  }

  /** Fire the scan ring once. Restarting a CSS animation needs the class off,
   *  a reflow, then on -- without the reflow the browser coalesces the two
   *  class writes and the animation never replays on a loop or a scrub. */
  pulseScan() {
    const el = this.qrPulse
    if (!el) return
    el.classList.remove('on')
    void el.offsetWidth
    el.classList.add('on')
  }

  /** Take down everything the voice beat put up. */
  clearVoice() {
    const v = this.voice
    if (v) {
      v.barBox.classList.remove('on')
      v.pill.classList.remove('on')
      v.toast.classList.remove('on')
    }
    // Sweep every window, not just the current one: the app can change under a
    // scrub, and a line left in a background window resurfaces on the next
    // Cmd-Tab with no beat owning it.
    for (const el of this.frame.contentDocument?.querySelectorAll('.mmDictation') || []) {
      el.classList.remove('on')
    }
  }

  /** Reveal the dictated line in the Mac's front window, `frac` of the way
   *  through. Rebuilt from scratch each call so a scrub backwards shortens it. */
  dictate(frac) {
    const m = this.mirror
    if (!m) return
    const win = m.wins[this.appIdx] || m.wins[0]
    if (!win) return
    let el = win.querySelector('.mmDictation')
    if (!el) {
      el = this.frame.contentDocument.createElement('div')
      el.className = 'mmDictation'
      win.appendChild(el)
    }
    if (frac <= 0) return el.classList.remove('on')
    el.classList.add('on')
    const n = Math.round(DICTATION.length * frac)
    const shown = DICTATION.slice(0, n)
    // Caret only while text is still arriving.
    el.innerHTML = `<b>❯</b> ${shown}${n < DICTATION.length ? '<i></i>' : ''}`
  }

  /** Force useNotchPath to re-measure the pad.
   *
   *  The hook settles on its own timer, which has usually already fired by the
   *  time we change the pad's height -- so any code that resizes the pad has to
   *  nudge it again or the carve stays where the pad USED to end.
   */
  pokeNotch(delays = [0]) {
    const pad = this.frame.contentDocument?.querySelector('.proTouchpad')
    if (!pad) return
    const poke = () => {
      pad.style.paddingBottom = pad.style.paddingBottom ? '' : '0.01px'
      window.requestAnimationFrame(() => (pad.style.paddingBottom = ''))
    }
    for (const d of delays) {
      if (d === 0) requestAnimationFrame(poke)
      else setTimeout(poke, d)
    }
  }

  /** Put the Mac's pointer at a fraction of the mirror pane, and fly the cursor
   *  companion's comet in behind it.
   *
   *  The comet is a port of CursorApp.tsx renderComet() -- same speed
   *  normalisation, same glow/scale/tail curves, same colour ramp. It is driven
   *  from the delta between calls rather than a pointer event, which is the only
   *  difference: there is no real pointer here, so velocity comes from the
   *  animation itself.
   */
  macCursor(fx, fy) {
    const m = this.mirror
    if (!m?.cursor) return
    const x = clamp01(fx) * 100
    const y = clamp01(fy) * 100
    m.cursor.style.left = `${x}%`
    m.cursor.style.top = `${y}%`

    // Speed in px/frame, matching the app's units -- it normalises against a
    // raw pointer delta, so the fractions have to come back to pixels first.
    const box = m.pane.getBoundingClientRect()
    const px = (x / 100) * box.width
    const py = (y / 100) * box.height
    const prev = m.last || { x: px, y: py }
    const dx = px - prev.x
    const dy = py - prev.y
    const sp = Math.hypot(dx, dy)
    m.last = { x: px, y: py }
    // Keep the last real heading: at rest dx/dy are 0 and atan2 would snap the
    // tail to 0deg, so a stopped comet would kick sideways before fading.
    if (sp > 0.4) m.angle = (Math.atan2(dy, dx) * 180) / Math.PI
    const angle = m.angle || 0

    paintComet(m.comet, m.tail, px, py, sp, angle)
  }

  /** Raise the app switcher and land on `idx`. */
  switchApp(idx) {
    const m = this.mirror
    if (!m) return
    // Remembered so the voice beat can type into whichever window is actually
    // in front, rather than assuming the browser is.
    this.appIdx = idx
    m.tiles.forEach((t, i) => t.classList.toggle('sel', i === idx))
    m.wins.forEach((w, i) => w?.classList.toggle('on', i === idx))
  }

  /** Poll for the mount. A fixed delay silently no-ops when the bundle is slow,
   *  and then every lookup downstream misses at once. */
  /** Resolve once the demo has been on screen at least once.
   *
   *  Resolves immediately if it already is -- IntersectionObserver fires on
   *  observe(), so by the time start() awaits this an above-the-fold hero has
   *  usually already been marked visible and there is nothing to wait for.
   */
  whenVisible() {
    if (this.offscreen === false) return Promise.resolve()
    return new Promise((res) => {
      this._seen = () => {
        this._seen = null
        res()
      }
    })
  }

  waitForDeck(tries = 80) {
    return new Promise((res) => {
      const attempt = (n) => {
        if (this.cancelled) return res(false)
        if (this.frame.contentDocument?.querySelector('.proRoot')) return res(true)
        if (n <= 0) return (console.warn('[mm-phone-demo] deck never mounted'), res(false))
        setTimeout(() => attempt(n - 1), 40)
      }
      attempt(tries)
    })
  }

  /* ── the loop ───────────────────────────────────────────────────────────── */

  /** The loop as DATA, not as a chain of awaits.
   *
   *  Every beat declares a duration and a pure `at(p)` that renders its own
   *  progress, so any point in the loop can be drawn from the clock alone.
   *  That is what makes the scrubber possible: a setTimeout chain can only ever
   *  play forward at 1x, and cannot answer "show me t=14s".
   *
   *  `enter` runs once when a beat becomes current (state the beat needs but
   *  can't derive from p -- a boot, a caption). Scrubbing backwards re-fires it.
   */
  buildTimeline() {
    const beats = [
      {
        // The hook, and the only beat that has to land in under a second. the user:
        // "it shows the mouse on the screen, and then boom, the screen gets a
        // lot smarter." So the ONE object on screen at t=0 is the cursor, and
        // the thing that changes is that same cursor -- MightyMouse takes it,
        // the desk wakes up behind it, an answer appears. Selling the promise
        // before the product's mechanics get a single frame is what earns the
        // rest of the loop; the phone story cannot start until this has landed.
        name: 'Smart',
        ms: 1900,
        cap: 'Make your computer 100x more useful',
        hud: 'MightyMouse',
        enter: () => {
          this.clearTouch()
          this.macState(false)
          this.macPtrLit(false)
          this.macAiPanel(0)
        },
        at: (p) => {
          this.showMac(true, 1)
          // No phone at all yet -- this beat is about the Mac.
          this.stagePhone('gone')
          this.showCam(false)
          // The pairing card is not the story here, so the desk is bare.
          if (this.macApp) this.macApp.style.opacity = '0'

          // Ignition at 30% (~0.57s): everything before it is the "before"
          // state, everything after is the product.
          const LIT = 0.3
          const lit = p >= LIT
          // Drift in from the left, then settle -- a cursor already parked in
          // the middle at frame 1 reads as a screenshot, not as someone using
          // the machine.
          const travel = easeInOut(clamp01(p / LIT))
          const cx = 0.26 + 0.22 * travel
          const cy = 0.58 - 0.1 * travel
          this.macDeskCursor(cx, cy, true)
          this.macPtrLit(lit)
          // The wake is FAST -- the user wants "boom". Full colour ~260ms after the
          // ignite, then it just holds while the answer writes itself.
          this.macWake(easeInOut(clamp01((p - LIT) / 0.14)))
          // Panel opens just behind the wake so the two read as one event with
          // a consequence, rather than as two separate flourishes.
          this.macAiPanel(easeInOut(clamp01((p - LIT - 0.06) / 0.16)), cx + 0.03, cy + 0.04)
        }
      },
      {
        // The one concrete, zero-setup thing MightyMouse does, placed before any
        // mechanics: no pairing, no key, no cloud. the user: it shows value
        // immediately. Matches Smart's length rather than the 1s it started at:
        // a 24-char line typing in under a second reads as a flicker, and the
        // claim only lands if the finished sentence sits still long enough to
        // be read. Every later beat shifts back by the difference, which is fine.
        name: 'Dictate',
        ms: 1900,
        cap: 'Talk instead of typing',
        hud: 'Free Private Dictation',
        enter: () => {
          this.clearTouch()
          this.macState(false)
          this.macDictate(0)
        },
        at: (p) => {
          this.showMac(true, 1)
          // Still no phone: this beat is about the Mac alone, same as Smart.
          this.stagePhone('gone')
          this.showCam(false)
          // The pairing card would claim setup is required, which is the exact
          // opposite of this beat's point.
          if (this.macApp) this.macApp.style.opacity = '0'
          // The cursor sits where the text is about to land, so the line reads
          // as arriving AT the caret rather than somewhere unrelated.
          this.macDeskCursor(0.5, 0.46, true)
          this.macPtrLit(true)
          // Type across 12%-60%, then hold the finished line for the rest. The
          // hold is the point of the beat: a sentence still arriving when the
          // caption changes never gets read, so the typing is deliberately
          // front-loaded and the last ~760ms is dead air on purpose.
          this.macDictate(clamp01((p - 0.12) / 0.48))
        }
      },
      {
        // The hand-off. The Smart beat has already sold what MightyMouse does to
        // the Mac; this one turns that into a reason to reach for the phone, so
        // it opens the pairing card and brings the phone in. Still short: the
        // viewer is waiting for the phone, not studying the desktop.
        name: 'Desk',
        ms: 1100,
        cap: 'Control it from your phone',
        hud: 'Pair your phone',
        enter: () => {
          this.clearTouch()
          this.macState(false)
        },
        at: (p) => {
          this.showMac(true, 1)
          // The phone slips in from the right over the back half of the beat,
          // which puts its arrival at ~0.5s -- the timing the user asked for.
          // It comes to rest DEAD CENTRE, held up in front of the laptop.
          // Parking it off to one side (the first build used x=24cqw) reads as
          // two devices sitting next to each other; a camera being pointed at
          // something is centred ON that something, which is the whole story
          // this beat has to tell.
          // y is NEGATIVE: the lane is as tall as the full-size phone, so a
          // 0.42 phone shrinks about the lane's centre and its bottom lands
          // level with the laptop's base. Lifting it puts the phone over the
          // lid rather than over the hinge.
          const inn = clamp01((p - 0.45) / 0.55)
          this.stagePhone(true, 0.42, 44 * (1 - easeInOut(inn)), -6)
          // The phone arrives already in camera mode -- it is being raised TO
          // the screen, so it is looking before it lands.
          this.showCam(true)
        }
      },
      {
        // The pairing itself. The phone reads the code, the ring fires, the Mac
        // flips to connected. This is the beat that explains what the product
        // IS, so it gets the longest slot of the three.
        name: 'Pair',
        ms: 1700,
        cap: 'Scan once. That’s the setup.',
        hud: 'Pairing',
        enter: () => {
          this.clearTouch()
          this.macState(false)
        },
        at: (p) => {
          this.showMac(true, 1)
          // Nudge TOWARD the screen to "read" the code, then settle back. The
          // lean is a scale bump, not a sideways slide: the phone is already
          // dead centre in front of the laptop, so moving it closer means
          // bigger, the way it looks when you push a camera at something.
          const lean = Math.sin(clamp01(p / 0.5) * Math.PI)
          this.stagePhone(true, 0.42 + 0.05 * lean, 0, -6)
          // One ring, at the moment of contact. Fired from a threshold crossing
          // rather than every frame -- pulseScan restarts the animation, so
          // calling it per frame would freeze the ring at frame 1.
          const scanned = p >= 0.42
          if (scanned !== this._scanned) {
            this._scanned = scanned
            if (scanned) this.pulseScan()
          }
          // Both surfaces flip on the SAME threshold: the viewfinder lifts to
          // reveal the app at the exact frame the Mac says connected. Splitting
          // them reads as two unrelated events rather than one handshake.
          this.macState(p >= 0.55)
          this.showCam(p < 0.55)
        }
      },
      {
        // Paired -- so PROVE it, with both devices still on screen. the user: show
        // the phone moving the mouse and see it happen on the Mac, while you
        // can still see both, and only THEN hide the Mac.
        // This beat does not touch showMac at all: the laptop stays exactly
        // where the pairing left it. The phone grows a little (0.42 -> 0.52) so
        // the trackpad is legible, but stays small enough that the Mac's screen
        // is still the thing you are watching.
        name: 'Drive',
        ms: 2600,
        cap: 'Stand up, walk around, go touch grass',
        hud: 'Connected',
        enter: () => {
          this.clearTouch()
          this.macState(true)
          this.show(true)
        },
        at: (p) => {
          this.showCam(false)
          this.showMac(true, 1)
          const grow = easeInOut(clamp01(p / 0.25))
          this.stagePhone(true, 0.42 + 0.1 * grow, 0, -6)
          // The finger on the phone and the Mac's own cursor are driven from
          // ONE parameter, so the two surfaces cannot disagree -- that
          // correspondence IS the point of the beat.
          const d = clamp01((p - 0.2) / 0.75)
          const sweep = easeInOut(d)
          const cx = 0.3 + 0.42 * sweep
          const cy = 0.62 - 0.2 * Math.sin(sweep * Math.PI)
          this.place(28 + 44 * sweep, 62 - 22 * Math.sin(sweep * Math.PI))
          // Paint BOTH pointers from the same coordinates: the desk one is what
          // you can actually see here (the mirror is still shut), and keeping
          // macCursor in step means the pane opens next beat already showing the
          // cursor where the finger left it, instead of snapping.
          this.macDeskCursor(cx, cy)
          this.macCursor(cx, cy)
        }
      },
      {
        // The mirror arrives while the laptop is STILL THERE. That is the whole
        // point: for a moment the same screen is on both devices at once, which
        // is what seeing your screen from anywhere actually means. Opening it
        // after the Mac had gone (the old order) meant the pane appeared, the
        // Mac vanished, and the pane re-appeared -- read as a flicker.
        name: 'Mirror',
        ms: 2400,
        cap: 'See your screen, from anywhere',
        hud: 'Screen mirroring',
        // Start blank, so the pop-in has something to pop in FROM. Re-entering
        // the beat (loop, scrub back) has to reset it or the reveal only ever
        // plays once per page load.
        enter: () => {
          this.revealMirror(false)
          this.macState(true)
        },
        at: (p) => {
          // Laptop held, phone held at Drive's size -- neither moves, so the
          // only new thing in frame is the mirror pane itself.
          this.showMac(true, 1)
          this.showCam(false)
          this.stagePhone(true, 0.52, 0, -6)
          // ~0.55s into a 2400ms beat: the pane pops early, then the rest of the
          // beat is dwell on the live Mac rather than a wait for it to arrive.
          this.revealMirror(p >= 0.23)
          // Cursor drifts while the mirror is being introduced, so the pane
          // reads as live video rather than a screenshot. The laptop's own
          // pointer tracks the same path -- with both devices in frame, the
          // mirror only reads as a MIRROR if the two agree.
          const cx = 0.34 + 0.3 * easeInOut(clamp01(p * 1.6))
          const cy = 0.6 - 0.16 * p
          this.macCursor(cx, cy)
          this.macDeskCursor(cx, cy)
        }
      },
      {
        // Only NOW does the laptop withdraw -- after you have seen the cursor
        // move on it AND seen its screen arrive on the phone. The mirror stays
        // up through the handoff, so nothing closes and re-opens.
        name: 'Takeover',
        ms: 1200,
        cap: 'An extension of your computer',
        hud: 'Connected',
        enter: () => {
          this.clearTouch()
          this.macState(true)
        },
        at: (p) => {
          const e = easeInOut(p)
          this.showCam(false)
          // Hold the mirror THROUGH the handoff. Dropping it here is exactly the
          // bug this reorder fixes.
          this.revealMirror(true)
          // The Mac shrinks and fades rather than sliding off: sliding needs
          // somewhere to slide TO, and the lane is exactly as wide as the phone
          // needs, so anything leaving sideways clips against the hero column.
          this.showMac(p < 0.82, 1 - 0.34 * e)
          if (p >= 0.82) {
            // Hand the stage back for good. Every later beat then renders with
            // no intro transform at all.
            this.stagePhone(false)
          } else {
            // Grows from where Mirror left it (0.52), not from 0.42, or the
            // phone visibly snaps smaller on the beat boundary.
            this.stagePhone(true, 0.52 + 0.48 * e, 0, -6 * (1 - e))
          }
        }
      },
      {
        name: 'Pad',
        ms: 3400,
        cap: 'Swipe to move the cursor',
        hud: 'Trackpad',
        enter: () => this.show(true),
        at: (p) => this.padDrag(p)
      },
      {
        name: 'Switch',
        // The flick itself stays snappy -- the user: "people don't have that much
        // patience". The extra length is TAIL, not a slower switch: appSwitch
        // closes the overlay by 40% of the beat and the rest dwells on the app
        // you landed on, which is the payload. A leisurely *switch* reads as the
        // app being slow; a leisurely *arrival* reads as the demo being calm.
        ms: 3000,
        cap: 'Flick between apps',
        hud: 'Cmd-Tab',
        enter: () => this.show(true),
        at: (p) => this.appSwitch(p)
      },
      {
        name: 'Mic',
        // The longest beat, and deliberately so: it is the only one that shows
        // a full round trip (hold -> hear -> transcribe -> act) rather than a
        // single control being used. Four phases need the room; much under
        // ~3.5s and the transcript is gone before it can be read. At 6s each
        // phase gets ~1.5s, which is the point where they stop overlapping.
        ms: 6000,
        cap: 'Hold the mic. Just say it.',
        hud: 'Voice commands',
        enter: () => {
          this.show(true)
          this.dictate(0)
        },
        at: (p) => this.voiceBeat(p)
      },
      {
        name: 'Keys',
        ms: 2800,
        cap: 'Real keys, right where your thumb is',
        hud: 'Shortcut keys',
        enter: () => this.show(true),
        at: (p) => this.keyTaps(p)
      },
      {
        name: 'Landscape',
        ms: 2600,
        cap: 'Turn it sideways for a bigger screen',
        hud: 'Landscape mode',
        // The rotation itself is the wrapper's job now -- it holds landscape from
        // here to the end of the loop.
        enter: () => this.show(false),
        at: (p) => {
          // Give the rotation a moment to land and the pad to re-measure at its
          // new box, then drive the SAME drag the portrait Pad beat uses. The
          // beat used to move only the Mac cursor, so landscape showed a pointer
          // travelling with no finger and no heat trail behind it -- the one
          // thing this demo is meant to prove was missing from it.
          // padDrag measures .proTouchpad itself, so it needs no landscape
          // coordinates of its own; re-basing p onto 0..1 is the whole change.
          if (p < 0.22) {
            this.show(false)
            this.macCursor(0.4 + 0.1 * easeInOut(clamp01(p / 0.22)), 0.5)
            return
          }
          this.show(true)
          this.padDrag(clamp01((p - 0.22) / 0.78))
        }
      },
      // Only the first three. The skins are the tail of the loop and the one
      // stretch with no finger and no motion, so every extra one is dead air
      // before it wraps -- three is enough to say "there are skins".
      ...this.skins.slice(0, 3).map((s, i) => ({
        name: s.label,
        // Each skin needs long enough to READ the tag and see the deck it names.
        // At 560ms they were a flicker.
        ms: 900,
        // One caption repeated across three swaps plus Reset held the same words
        // on screen for 3.1s at the very end of the loop -- the decks changed
        // underneath but the card sat frozen, which reads as a stuck demo rather
        // than a beat. Each swap gets its own line so the text moves with them.
        cap: ['Make it yours', 'Or this one', 'Or build your own'][i],
        hud: 'Custom skins',
        skin: `remote:${s.id}`,
        enter: () => {
          this.show(false)
          this.skinTag.textContent = s.label
          this.skinTag.classList.add('on')
        },
        at: () => {}
      })),
      {
        name: 'Reset',
        ms: 420,
        // No caption: this beat exists to put the default deck back before the
        // loop wraps, and a fourth repeat of the skin line was the tail of the
        // 3.1s stall. An empty cap makes say() clear the card, so the loop ends
        // on the phone alone rather than on stale words.
        cap: '',
        skin: 'proII',
        enter: () => this.skinTag.classList.remove('on'),
        at: () => {}
      }
    ]
    // Orientation is sticky state, so every beat has to assert the one it wants
    // -- otherwise scrubbing backwards out of Landscape leaves the phone
    // sideways for the rest of the loop. Wrapping here rather than repeating
    // setLandscape() in a dozen enter() bodies.
    //
    // The phone goes sideways at the Landscape beat and STAYS there to the end:
    // the skins run last, and rotating back upright just to show them read as a
    // random flip. Positional rather than by name so adding or removing a
    // skin can't silently leave a beat on the wrong side of the rule.
    const landFrom = beats.findIndex((b) => b.name === 'Landscape')
    // The intro's staging is sticky state too, and the worst kind: it scales the
    // phone down. A scrub from Pair into Keys without this leaves the rest of
    // the loop playing on a 42%-size phone parked off to the side.
    // Mirror is on this list now: it plays with the laptop still up, so the
    // cleanup below would otherwise tear down the Mac it is standing next to.
    const INTRO = new Set(['Smart', 'Dictate', 'Desk', 'Pair', 'Drive', 'Mirror', 'Takeover'])
    // The beats that run BEFORE screen mirroring is introduced.
    const BEFORE_MIRROR = new Set(['Smart', 'Dictate', 'Desk', 'Pair', 'Drive'])
    // The pointer drawn on the laptop screen is sticky the same way: only Drive
    // and Mirror move it, so it would otherwise sit frozen mid-screen through
    // Desk and Pair (a stray arrow over the QR card) and outlive the Mac itself.
    const DESK_PTR = new Set(['Smart', 'Dictate', 'Drive', 'Mirror'])
    for (const [i, b] of beats.entries()) {
      const own = b.enter
      const wantLand = landFrom !== -1 && i >= landFrom
      const isMirror = b.name === 'Mirror'
      const isMic = b.name === 'Mic'
      const isIntro = INTRO.has(b.name)
      const preMirror = BEFORE_MIRROR.has(b.name)
      const wantPtr = DESK_PTR.has(b.name)
      const isSmart = b.name === 'Smart'
      const isDictate = b.name === 'Dictate'
      b.enter = () => {
        this.setLandscape(wantLand)
        if (!wantPtr) this.macDeskCursor(0, 0, false)
        // The desk dictation field is sticky state like everything else here:
        // only Dictate raises it, so every other beat has to take it down or a
        // scrub out of it leaves a line of text on the desktop for the rest of
        // the loop -- including over the pairing card two beats later.
        if (!isDictate) this.macDictate(0)
        // The opening beat is the only one that dims the Mac or hangs an answer
        // panel off the cursor. Both are asserted away here rather than in each
        // of the ten beats that follow: a scrub can land anywhere, and a Mac
        // left dimmed at 0.28 saturation for the rest of the loop is the exact
        // failure a per-beat cleanup would eventually miss.
        if (!isSmart) {
          this.macWake(1)
          this.macAiPanel(0)
        }
        // The lit pointer and the hidden phone belong to BOTH Mac-only beats,
        // so they clear on a wider condition than the dimming above: Dictate
        // lights its own cursor and stages the phone away, and folding it into
        // the isSmart branch would undo both at the frame it starts.
        if (!isSmart && !isDictate) {
          this.macPtrLit(false)
          // The phone is only absent during the two Mac-only beats. Clearing it
          // here means no other beat can inherit an invisible phone, however the
          // loop is entered.
          this.wrapEl?.classList.remove('gone')
        }
        // Only the three intro beats own the laptop and the shrunken phone;
        // every other beat has to assert them away, in BOTH directions (the
        // loop wraps back to Desk, and the scrubber can land anywhere).
        if (!isIntro) {
          this.stagePhone(false)
          this.showMac(false)
          // The viewfinder is the worst of the three to leave behind: it is
          // opaque and covers the real bundle, so a scrub out of Pair would
          // play the whole rest of the loop over a blank camera screen.
          this.showCam(false)
          this._scanned = false
        }
        // Force the next glide to re-anchor. Without this the key set during a
        // PREVIOUS beat is still current when the new beat's first approach
        // runs, so glideTo skips its capture and eases from a stale anchor --
        // which is how Pad ended up snapping to mid-screen out of Mirror.
        this._glideKey = null
        // Same sticky-state problem: the waveform, pill, toast and the typed
        // line all belong to the Mic beat, so leaving it in ANY direction has
        // to clear them or they stay up for the rest of the loop.
        if (!isMic) this.clearVoice()
        // Mirror visibility is sticky state, same problem as orientation: only
        // the Mirror beat animates it in, so every OTHER beat has to assert it
        // on. Without this, scrubbing forward out of Mirror (or a remount from
        // a skin swap) leaves the Mac hidden for the rest of the loop.
        //
        // EXCEPT the beats before it. Screen mirroring is the thing Mirror
        // reveals, so Desk/Pair/Drive have to show a phone that does NOT have
        // it yet -- otherwise the pane is already up when the beat whose whole
        // job is to introduce it begins, and there is nothing left to reveal.
        if (!isMirror) this.revealMirror(!preMirror)
        own?.()
      }
    }
    let t = 0
    for (const b of beats) {
      b.t0 = t
      t += b.ms
    }
    this.beats = beats
    this.total = t
    this.buildTicks()
  }

  /** One segment per beat, flex-sized by duration. Built once per timeline. */
  buildTicks() {
    const bar = this.$('.ticks')
    if (!bar) return
    bar.textContent = ''
    this.tickEls = this.beats.map((b) => {
      const seg = document.createElement('div')
      seg.className = 'tick'
      seg.style.flexGrow = String(b.ms)
      seg.appendChild(document.createElement('i'))
      bar.appendChild(seg)
      return seg
    })
  }

  /** Fill the current segment by progress, mark the earlier ones done. Driven
   *  from render() rather than a beat's enter(), because the ACTIVE segment has
   *  to advance every frame, not once when the beat opens. */
  paintTicks(idx, p) {
    if (!this.tickEls) return
    for (let i = 0; i < this.tickEls.length; i++) {
      const seg = this.tickEls[i]
      const done = i < idx
      if (seg.classList.contains('done') !== done) seg.classList.toggle('done', done)
      // Always restate the inline transform, including on done segments. The
      // .done rule paints them full, but leaving a stale scaleX behind means a
      // scrub backwards un-dones a segment that still carries a partial fill.
      const fill = /** @type {HTMLElement} */ (seg.firstChild)
      fill.style.transform = `scaleX(${i === idx ? p.toFixed(3) : done ? 1 : 0})`
    }
  }

  async start() {
    // The loading stage is the OPENING beat's own first frame: the asleep Mac,
    // no phone. Holding the full-size phone here instead meant a slow network
    // showed a giant dark slab that then vanished for the Mac-only opening
    //. Smart's enter/at assert this exact
    // state, so boot finishing is a wake-up, not a scene change.
    this.wrapEl?.classList.add('gone')
    this.showMac(true, 1)
    this.macWake(0)
    if (this.macApp) this.macApp.style.opacity = '0'
    this.mac?.classList.add('booting')
    // Nothing is fetched until the demo is actually on screen. Booting on mount
    // spent a bundle fetch + a document.write on readers who never scrolled to
    // it, and burned beat 1 offscreen so the first thing they DID see was the
    // middle of the loop.
    await this.whenVisible()
    if (this.cancelled) return
    // Skins have to be loaded before the timeline is built -- each one is its
    // own beat, so the total duration depends on how many came back.
    const ok = await this.boot('proII')
    if (!ok) return
    // Deck is mounted and painted -- drop the skeleton. Only ever removed on a
    // successful boot, so a failed fetch keeps the lit screen rather than
    // exposing the dead black one underneath.
    this.device?.classList.add('mmReady')
    // The charge glow belongs to loading only -- from here the Smart beat's
    // ignite owns every wake visual.
    this.mac?.classList.remove('booting')
    // Reduced motion gets ONE line standing in for the whole loop, so it says
    // what the remote is for rather than naming any single beat's mechanic.
    // The loading stage above has to be struck manually here -- there is no
    // timeline to assert the phone back on.
    if (this.reduced) {
      return this.renderStill()
    }
    this.buildTimeline()
    this.clock = 0
    this.emit()
    this.raf()
  }

  /** Reduced motion gets ONE still standing in for the whole loop, so it says
   *  what the remote is for rather than naming any single beat's mechanic.
   *  A hook so subclasses can hold a different frame. */
  renderStill() {
    this.wrapEl?.classList.remove('gone')
    this.showMac(false)
    this.say('Control your computer from your phone')
  }

  /** One rAF driving everything. Wall-clock delta, so a scrub or a stall never
   *  makes the animation drift out of step with the reported time. */
  raf() {
    let last = performance.now()
    const tick = (now) => {
      if (this.cancelled) return
      const dt = now - last
      last = now
      if (!this.paused && !this.scrubbing) {
        this.clock = (this.clock + dt) % this.total
        this.render()
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  beatAt(t) {
    const b = this.beats.find((x) => t >= x.t0 && t < x.t0 + x.ms)
    return b || this.beats[this.beats.length - 1]
  }

  /** Draw whatever the clock currently says. The only place beats are run. */
  render() {
    const b = this.beatAt(this.clock)
    if (b !== this.current) {
      this.current = b
      // Re-roll on the BEAT edge, not inside say() -- say() dedupes on text, so
      // two consecutive beats sharing a caption would keep the same card and
      // the alternation would visibly stall. Queued to land inside say()'s
      // 150ms out-window, while the card is invisible.
      if (this.hasAttribute('flashcards')) {
        clearTimeout(this._fcT)
        this._fcT = setTimeout(() => this._rollCard(), 140)
      }
      this.say(b.cap)
      this.showHud(b.hud)
      // A beat that names a skin owns a boot. Async, so the beat keeps
      // rendering while the new document mounts -- awaiting here would stall
      // the whole clock on every swap.
      if (b.skin && b.skin !== this.skinShown) {
        this.skinShown = b.skin
        this.boot(b.skin)
      }
      b.enter?.()
    }
    const p = clamp01((this.clock - b.t0) / b.ms)
    b.at(p)
    this.paintTicks(this.beats.indexOf(b), p)
    this.emit()
  }

  /** Tell the host page where we are, so a harness can draw a scrubber. */
  emit() {
    this.dispatchEvent(
      new CustomEvent('mm-progress', {
        detail: { t: this.clock, total: this.total, beat: this.current?.name || '' }
      })
    )
  }

  /** Jump to a point on the timeline. */
  seek(t) {
    if (!this.total) return
    this.clock = Math.max(0, Math.min(this.total - 1, t))
    // Force enter() to re-run for the beat we land in.
    this.current = null
    this.render()
  }

  setPaused(on) {
    this.userPaused = on
    this.paused = on || this.offscreen
  }

  /* ── beat bodies: pure functions of progress ────────────────────────────── */

  /** Two-leg drag across the pad, with the Mac cursor following it 1:1. That
   *  correspondence IS the product -- finger here, pointer there. */
  padDrag(p) {
    const pad = this.rectOf('.proTouchpad')
    if (!pad) return
    // The path is written as FRACTIONS OF THE PAD, not as device percentages.
    // The pad is a ~90%-wide square in portrait but a ~27%-wide column in
    // landscape, so the old fixed offsets (±16% of the device) were wider than
    // the landscape pad itself -- the finger swung off it onto the mirror and
    // dragged across the bottom of the screen instead. These fractions are the
    // portrait literals divided by the portrait box, so portrait is unchanged.
    const fx = (f) => pad.x + pad.w * f
    const fy = (f) => pad.y + pad.h * f
    const a = [fx(-0.18), fy(-0.15)] // start, upper-left of the pad
    const b = [fx(0.07), fy(-0.22)] // across and slightly up
    const c = [fx(0.17), fy(0.15)] // then down-right
    // approach → leg 1 → leg 2 → lift
    const legs = [
      { to: 0.18, from: a, via: a },
      { to: 0.52, from: a, via: b },
      { to: 0.86, from: b, via: c }
    ]
    if (p < legs[0].to) {
      // The approach leg travels from wherever the last beat left the finger to
      // the pad, instead of snapping onto the pad and waiting there.
      this.glideTo('pad:approach', legs[0].via[0], legs[0].via[1], p, legs[0].to)
      this.finger.classList.remove('down')
      this.trail(false)
      this.macCursor(0.3, 0.66)
      return
    }
    const leg = p < legs[1].to ? legs[1] : legs[2]
    const span = leg === legs[1] ? [legs[0].to, legs[1].to] : [legs[1].to, legs[2].to]
    const lp = easeInOut(clamp01((p - span[0]) / (span[1] - span[0])))
    const x = leg.from[0] + (leg.via[0] - leg.from[0]) * lp
    const y = leg.from[1] + (leg.via[1] - leg.from[1]) * lp
    const frac = leg === legs[1] ? lp * 0.5 : 0.5 + lp * 0.5
    const down = p < legs[2].to
    this.finger.classList.toggle('down', down)
    this.trail(down)
    this.place(x, y)
    // The Mac pointer traces the same path, mapped into the mirror's box.
    this.macCursor(0.3 + frac * 0.42, 0.66 - frac * 0.3)
  }

  /** Cmd-Tab: raise the switcher, step the selection, commit.
   *
   *  Deliberately front-loaded -- the overlay is up by 6% and both steps are
   *  done by 62%, leaving the tail of the beat to show the app you landed on.
   *  Holding the switcher open for most of the beat is what made this feel
   *  sluggish; the payload is the ARRIVAL, not the menu.
   */
  appSwitch(p) {
    const m = this.mirror
    if (!m) return
    // Marks are fractions of a 3000ms beat but describe an absolute ~1.2s flick:
    // overlay up by 240ms, both steps done by 1.2s, then 1.8s of dwell on the
    // app that arrived. Retiming the beat WITHOUT rescaling these is what makes
    // a longer loop feel sluggish instead of calmer.
    const open = p > 0.16 && p < 0.5
    m.switcher.classList.toggle('on', open)
    const idx = p < 0.26 ? 0 : p < 0.38 ? 1 : 2
    this.switchApp(idx)
    // Press the app-switcher key, not whatever the previous beat left the finger
    // on. Without this the Mac overlay cycles while the thumb sits on the pad --
    // it reads as the wrong button causing the switch.
    // 0.16 of a 3000ms beat = ~480ms of travel. The run-up has to be long enough
    // to EASE across; a 90ms one arrives correctly but covers the distance in
    // two frames, which looks like a teleport even though nothing snapped.
    this.holdOn('.proIconBtn[data-img="switcher"]', p, 0.16, 0.5)
    // A small drift after the commit, so the comet has something to react to
    // and the landed app doesn't sit dead still.
    if (p >= 0.5) this.macCursor(0.46 + 0.32 * (p - 0.5), 0.52 + 0.2 * (p - 0.5))
  }

  /**
   * Set/clear the depressed look on a control, driven per frame rather than by
   * a timer. holdOn and keyTaps compute their down-state from progress, so they
   * can't use press()'s sleep -- and scrubbing backwards has to be able to
   * UN-press. Tracks the last element so a beat that moves between keys always
   * releases the one it left.
   */
  setDown(el, down) {
    // Clear by SWEEP, not by remembered node. A skin swap re-mounts the iframe
    // document, so a tracked `_downEl` can point into the OLD document -- the
    // clear then lands on a detached node while the new key stays visibly
    // pressed. That was the stuck-Tab bug. Sweeping the live document instead
    // means the invariant ("at most one pill is down") cannot go stale.
    this.pressNode(el, down)
    this._downEl = el && down ? el : null
  }

  /** Hold the finger on a control between two progress marks. */
  holdOn(sel, p, from, to) {
    const r = this.rectOf(sel)
    if (!r) return
    const el = this.controlNode(sel)
    if (p < from) {
      // Glide in from the finger's real position, not a fixed point -- see
      // glideTo. Keyed on the selector so re-entering a beat re-anchors.
      this.glideTo(`hold:${sel}`, r.x, r.y, p, from)
      this.finger.classList.remove('down')
      this.setDown(el, false)
    } else {
      this.place(r.x, r.y)
      const down = p < to
      this.finger.classList.toggle('down', down)
      this.setDown(el, down)
      if (!this.rippled && p >= from) {
        this.rippled = true
        this.press(60)
      }
    }
    if (p < from) this.rippled = false
  }

  /** Tab, then Enter -- two visibly different caps. */
  keyTaps(p) {
    // Each key gets a real run-up: Tab travels over the first 0.24 (~670ms of a
    // 2800ms beat), Enter over 0.46->0.66 (~560ms). Same reason as appSwitch --
    // a correct-but-two-frame glide still reads as a jump.
    const seq = [
      { sel: ".proKeyPill[data-img='tab']", from: 0.24, to: 0.42 },
      { sel: ".proKeyPill[data-img='enter']", from: 0.66, to: 0.84 }
    ]
    const i = p < 0.46 ? 0 : 1
    const step = seq[i]
    const r = this.rectOf(step.sel)
    if (!r) return
    // Travel occupies the whole run-up to the key rather than a fixed 0.1 slice.
    // The old window started at `from - 0.1`, which for the first key is
    // negative -- so lp was already 1 on frame 1 and the finger teleported onto
    // Tab the instant the beat began.
    const start = i === 0 ? 0 : 0.46
    this.glideTo(`keys:${i}`, r.x, r.y, p - start, step.from - start)
    const down = p >= step.from && p < step.to
    this.finger.classList.toggle('down', down)
    this.setDown(this.controlNode(step.sel), down)
    // One flare per key, on the frame it goes down. `_flared` is the step index
    // rather than a bool so the second key still fires after the first, and
    // scrubbing backwards re-arms it.
    if (down && this._flared !== i) {
      this._flared = i
      this.press(60)
    }
    if (!down && this._flared === i) this._flared = null
    this.show(p < 0.9)
  }
}

customElements.define('mm-phone-demo', MMPhoneDemo)

// Exported for the onboarding surface, which subclasses it to swap the live
// bundle for a drawn panel. Also the CSS the injected mirror/voice chrome needs,
// since a surface with no bundle has no stylesheet to inherit them from.
export { MMPhoneDemo, MIRROR_CSS, VOICE_CSS, SAFE_CSS, MAC_APPS }
