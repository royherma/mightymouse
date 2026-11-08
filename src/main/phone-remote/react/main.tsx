import './ai/phone-kit.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import App from './App'
import { DeckBoundary, installClientErrorHooks } from './DeckBoundary'
import { applyDebugLayout, getDebugLayoutEnabled } from './debug-layout'
import { installArrowFocusNav } from './arrow-focus-nav'
import { installEnterActivatesFocused } from './enter-activates-focused'
import { installCursorlessWatch } from './cursorless-host'
import { capabilities } from './host-capabilities'
import { primeDeviceHints } from './device-hints'
import './theme.css'
/* Skin blocks, split out of theme.css (2026-07-24). Each is scoped entirely to
   `.proRoot[data-skin='<id>']`, so they are independent of each other.

   IMPORTED HERE, NOT via @import in theme.css. `@import` is only legal BEFORE
   any rule in a stylesheet -- at the bottom of theme.css, where these needed to
   go for cascade order, PostCSS drops them SILENTLY and every skin vanishes
   while the build still reports success (shipped exactly that way, caught
   on-device: all skins rendered as Classic).

   ORDER IS LOAD-BEARING. These must stay AFTER './theme.css': a skin beats the
   generic `.proRoot[data-skin]` rules inside theme.css on source order, not
   specificity, so moving a line above it silently hands the win back.

   Adding a skin stays what SKINS.md promises: one registry entry in skins.ts,
   one file here, one import line. No TypeScript beyond the union member. */
import './skins/proII.css'
import './skins/cap.css'
import './skins/military.css'
import './skins/amethyst.css'

// Mirrors src/renderer/src/theme.ts's injectTheme() exactly -- same
// key->CSS-var algorithm, same CONFIG.THEME_TOKENS source of truth. Inlined
// here (not imported) because that file lives under src/renderer/src, which
// this standalone phone-remote bundle deliberately never depends on.
function injectTheme(): void {
  const root = document.documentElement
  for (const [key, val] of Object.entries(CONFIG.THEME_TOKENS)) {
    const cssKey = `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`
    root.style.setProperty(cssKey, val)
  }
}

/** Link the local server's stylesheet of INSTALLED remote skins.
 *
 *  A <link> rather than a fetch-and-inline: the browser blocks first paint on a
 *  stylesheet in <head>, so a phone already wearing a remote skin paints it
 *  immediately instead of flashing the base cascade and snapping. Nothing is
 *  fetched from the internet here -- the Mac cached this at install time and
 *  serves it from localhost, so this costs one LAN request and works offline.
 *
 *  Always linked, even with no remote skins installed: the route then returns
 *  an empty stylesheet, which is cheaper than teaching the page to conditionally
 *  add a link and get the ordering right. */
function linkRemoteSkinStyles(): void {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = CONFIG.PHONE_REMOTE.REMOTE_SKIN_CSS_ROUTE
  link.dataset.remoteSkins = ''
  document.head.appendChild(link)
}

/** Stamp the host shell onto <html> so CSS can select on it.
 *
 *  `@media (display-mode: standalone)` is FALSE inside the native WKWebView --
 *  that query answers "was this launched from a Home Screen icon", and a native
 *  app was not. So every standalone-only correction in theme.css (the 100vh
 *  viewport fix and the --pro-safe-bottom / --classic-safe-bottom floors) fell
 *  through to the Safari branch in the native shell, even though the native
 *  shell has exactly the PWA's geometry: no browser chrome, full-screen web
 *  view, real home indicator underneath. The controls landed on the indicator.
 *
 *  Set here rather than in index.html because `nativeBridge.available` is a
 *  feature check on an object WKWebView installs before the bundle boots --
 *  keeping the one detection path the app already trusts, instead of adding a
 *  second UA-sniffing one that could disagree with `capabilities.shell`. */
function markHostShell(): void {
  document.documentElement.dataset.shell = capabilities.shell
}

installClientErrorHooks()
injectTheme()
markHostShell()
// Publishes the cursorless verdict to CSS and to React. The stylesheet cannot
// ask this question itself: the glasses answer `any-pointer: none` with "I have
// a pointer", so the one media query that should work is the one that lies.
// Watched rather than read once -- the simulator sizes its 600x600 frame AFTER
// load, so a verdict taken at import answers for a viewport that is gone.
installCursorlessWatch()
// A cursorless host (glasses, TV remote) sends Enter with no click behind it,
// so without this every button highlights and does nothing. Installed for every
// host -- on a phone no Enter arrives without a keyboard, and then the focus is
// a text field, which this declines.
installEnterActivatesFocused()
// The other half: the band's swipes arrive as arrow keys, and the browser moves
// focus on Tab only. Ungated -- it declines inside text fields and only
// preventDefaults once a move is certain, so a laptop still scrolls.
installArrowFocusNav()
// Async and Chromium-only, so it's started at boot rather than read inline: the
// WS connect path is synchronous and would otherwise always see nulls.
primeDeviceHints()
linkRemoteSkinStyles()
// Restore the debug tint before first paint, so reloading with the flag on
// doesn't flash the real colors first.
applyDebugLayout(getDebugLayoutEnabled())

/** Retire the pre-React boot splash from index.html.
 *
 *  Called from createRoot's commit callback, not a timer: the splash has to
 *  outlive first paint or the handoff is the white flash it exists to hide.
 *  The extra rAF waits one frame past commit so the deck has actually painted
 *  under it before the fade starts. */
function dismissBootSplash(): void {
  const boot = document.getElementById('boot')
  if (!boot) return
  requestAnimationFrame(() => {
    boot.classList.add('boot-done')
    boot.addEventListener('transitionend', () => boot.remove(), { once: true })
    // The transition never fires if the element is already display:none-ish or
    // the frame is dropped under load, which would strand an invisible overlay
    // over the whole app -- it has inset:0 and would eat every touch.
    setTimeout(() => boot.remove(), 600)
  })
}

// Backstop, independent of React: every removal path above runs from onReady,
// so an App that throws before its first commit leaves the splash up forever --
// and because it hides by opacity, "up" means an invisible inset:0 shield that
// swallows every touch on the trackpad. Losing the splash is a cosmetic bug;
// keeping it is a dead remote.
setTimeout(dismissBootSplash, 8000)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DeckBoundary>
      <App onReady={dismissBootSplash} />
    </DeckBoundary>
  </StrictMode>
)
