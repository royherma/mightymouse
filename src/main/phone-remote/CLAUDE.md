# Phone remote - guide for coding agents

Read this before editing anything under `src/main/phone-remote/`. Code comments across the repo cite the rules below by name.

The phone remote turns a phone into a trackpad, keyboard and voice remote for the computer. A Node HTTPS and WebSocket server inside the Electron main process serves a React app to the phone browser over the local network (or a Cloudflare Tunnel). For the user-facing flows, read `docs/phone-remote-flows.md` first.

## The three that bite every time

1. **The phone app is a pre-built bundle.** `server.ts` serves `react/dist/`, not a dev server with hot reload. After any edit under `react/`, run `npm run build:phone-remote` and reload the page. Restarting the Mac app does not rebuild it, so you would be measuring old output.
2. **Never point a second controller at a running server.** The server allows one active socket, so a test client evicts the real phone or gets refused mid-gesture. Connect with `?observe=1` instead (dev and loopback only, input dropped server-side), or copy `__tests__/observer-live.test.ts`, which runs a real server on a test-only port.
3. **The wire protocol lives in one file: `src/shared/phone-remote-protocol.ts`.** `PhoneRemoteMessage`, `PhoneRemoteEvent` and friends are declared there and imported by both `server.ts` and `react/App.tsx`. Never paste a copy into either side: two similar unions typecheck fine apart, so `src/shared/__tests__/phone-remote-protocol.test.ts` fails the build on any re-declaration. Keep that file free of `electron`, `fs`, `path` and DOM-only types.

## The phone bundle imports only `src/shared`

- `react/vite.config.ts` builds a standalone bundle that runs in a plain phone browser tab: no Electron, no preload, no IPC. It may import `src/shared/**` (via `@shared`) and nothing from `src/main` or `src/preload`.
- A value that the Mac, the phone and the server all need (limits, reason strings, key names) goes in one `src/shared/` file, never hand-typed in each place.
- **Shared components are Tailwind-free.** The renderer uses Tailwind and the phone bundle does not (Tailwind only runs inside `.phonePulse`, through `ai/phone-pulse.css`). Never import a stylesheet from a shared component; hosts pass their own class names.

## Adding a phone-to-Mac command - the 3-file lockstep

| # | File | What you add |
| --- | --- | --- |
| 1 | `src/shared/phone-remote-protocol.ts` | the variant, once, on the `PhoneRemoteMessage` union |
| 2 | `react/App.tsx` (or the hook that owns the gesture) | the `send({...})` call |
| 3 | `src/main/ipc/phone-remote.ts` | a `case` in the message switch: permission check, runtime validation, the domain call |

- There is no "copy it to the other side" step. Miss step 3 and the exhaustiveness check fails the build, not the phone.
- A result pushed back to the phone is a `PhoneRemoteEvent` variant in the same file, plus a case in the client's `onmessage` switch.
- New key or modifier names go in `src/shared/phone-remote-keys.ts`. Step 3 must call `isPhoneRemoteKeyName` / `isPhoneRemoteModifier` before anything off the wire reaches `typeText`.
- **Never trust a wire string.** Once the tunnel is on, everything over the socket is attacker-controllable. Validate on the Mac side, not in the React app.

## Send the resolved identity, never an index

When one side has already resolved what the user picked, send the thing's id, not the inputs to resolve it again. The app switcher sends `appSwitchActivate {bundleId}` for the exact tile the phone highlighted, and the Mac calls `activateApp(bundleId)`.

- Sending a number made the Mac re-derive the pick against its own list read at a different moment, so "what I picked isn't what switched". Two derivations of one decision always drift.
- `quickSwitchTargetIndex()` in `TouchpadControls.tsx` is the one place a switch target resolves; `quick-switch-target.test.ts` locks it.
- Same rule anywhere a list can change under the user: hold a name or id, not a position.

## One connection state, one place

`src/main/phone-remote/connection-state.ts` is the whole answer to "am I connected": a 4-state union (`connecting`, `connected`, `blocked`, `disconnected`), a `BlockedReason` union, and `transition()`, the only function allowed to produce a state. `react/useConnection.ts` owns the socket and is its only caller.

- **Never assign a state literal.** Every change goes through `transition()`, which refuses illegal edges (a stray `retry` while connected leaves the state unchanged).
- **The native bridge emit lives inside `dispatch()`,** not at call sites. The iOS app reacts to the `connState` message, never a timer, and an emit a call site can forget is how two state machines drift apart.
- **A new reason is a new `BlockedReason` value,** not a boolean beside the union. Each maps to one screen in `App.tsx`'s `blocked` switch, and exhaustiveness forces that screen to exist.
- Native code (Swift, Kotlin) owns no connection state. It reads what the page tells it.

## A revoked phone must not retry - read the stated reason, never infer it

- The Mac closes a revoked phone's socket with a `BlockedReason` in `event.reason`. The client reads that string and dispatches it, with no inference step.
- Guessing "revoked or evicted" from timing (for example "did this socket ever open") is backwards for a revoke, which by definition arrives on a long-open session. The phone kept its deleted credential and retried forever.
- A retry loop also starves its own fix: repeated refusals trip the per-IP limiter that guards `POST /pair`, the one call that recovers the phone, and the pairing form only renders once retrying stops.
- Same rule for any other source of errors (camera, glasses, audio route): show the reason the source stated, never one derived from a frame that did not arrive.

## Multi-device: a close with no reason becomes a kick war

- **Every close a client can retry through needs a stated reason.** A bare `close()` arrives as 1005, falls into the generic retry, and two phones evict each other every second forever.
- Conflicts close `4409` with `superseded` or `busy`. Never `4401`, which makes a valid credential look revoked.
- **Every conflict recovery is a button, never the backoff ladder.** `transition()` has no edge from `blocked` back to `connecting` except an explicit `retry`. A war needs both sides auto-retrying, so neither may. `eviction-war.test.ts` locks it.
- `onVisible` (picking the phone up) is an auto-reconnect too. It retries only from `disconnected` or `blocked/mac-unreachable`, and reads a ref, not state, because the socket effect closes over the first render.
- A newcomer must not silently steal an in-use session: `decideTakeover` (`socket-admission.ts`) refuses inside `TAKEOVER_GRACE_MS` of real input. The connect-time prefs burst does not count as input.
- The takeover flag rides `sessionStorage` and the socket URL, not a socket message, because a refused phone has no socket to send on.
- Blocked screens render before the boot gate, so a refused newcomer is never stuck on "Connecting...". Keep new gates below them.

## Effects key on the node, not on a description of it

Gates (`bootGate`, the pairing form, blocked screens) return before `TouchpadLayout`, so the pad and its buttons may not exist when an effect first runs.

- An effect that reads `someRef.current` and bails on null, keyed on `[layout]` or similar, attaches to nothing and never re-runs when the node mounts. The trackpad and the mic each shipped with zero listeners for a whole session this way.
- Hold the node in state (`const [el, setEl] = useState(null)` with `ref={setEl}`) and key the effect on it. A ref assignment fires no render.
- The mic can mount twice (mirror mode), so `mic-nodes.ts` tracks a list of nodes, not one ref.
- **The smell is a dep list that reads as "everything that should change this".** Check that each entry is a node, not a description of one.

## Keyboard state is one enum

`KeyboardMode = 'none' | 'native' | 'virtual'` in `keyboard-state.ts` answers "which keyboard is up". Never add a second flag beside it.

- **Several commits in a row guarding one boolean means the boolean is wrong.** Make the illegal state unspellable instead of adding another guard.
- **A momentary control never writes a durable pref.** `virtual-keyboard-pref.ts` has one writer, the Settings switch; swap buttons change session state only.
- **Every control that raises a keyboard fires on `pointerdown`, never `click`.** iOS honours a programmatic `focus()` only inside the user-gesture window and silently does nothing outside it; `click` lands about 300ms after the touch ends, often outside that window.
- **The hidden `.keyboardInput` is a lever, not a buffer.** Focusing it summons the native keyboard, whoever focuses it (including the browser restoring focus after a dropdown closes). It is `disabled` in virtual mode for that reason.
- A handler fired inside your own `focus()` reads the pre-`setState` value. `applyKeyboardMode` marks its own focus with `intentionalFocusRef`, and clears `disabled` imperatively before focusing.

## The keyboard bar is rendered TWICE - wire both hosts

`AppContextBar` (app chip plus dropdowns) has two hosts: `KeyboardAccessoryBar` over the native keyboard and the header row of `VirtualKeyboard`. Any component with two hosts follows the same rules (`AppSwitchGrid`, the relay interview nav).

- Every control preventDefaults on `pointerdown`. Ending a touch on a non-input blurs the hidden input, which collapses the keyboard and the bar before a `click` handler runs.
- `onSheetOpenChange` is required on both hosts (pass `() => {}` if there is nothing to do). It tells "a dropdown took focus" apart from "the user closed the keyboard"; without it the blur handler tears the keyboard down mid-tap.
- Both hosts share one mount rule (`barHostVisible(mode, host)`), and `accessoryBarVisible()` keeps the strip mounted while a sheet is open. `accessory-bar-visible.test.ts` locks it.
- Adding a control to the bar? Check it in both hosts; a green typecheck proves neither. A bug that shows on only one keyboard is a host lifecycle bug, not CSS.
- One component, never a copy per layout: a fix applied to one copy silently misses the other.

## Layout and CSS

- **One layout.** `TouchpadLayout` is the only structural layout. Skins render inside it through `data-skin`; never add a structural branch for a skin.
- **Orientation is tracked in JS** (`isLandscape`, `data-orient`). Landscape rules are scoped `.proRoot[data-orient='landscape']`. Never add a bare `@media (orientation: landscape)` override.
- **A hook that measures takes orientation as a dep, even if it never reads it.** Rotation changes no other input it watches, so `useNotchPath` kept the old orientation's shape. Only a real device shows this; an iframe resize does not.
- **`.proRoot` is already short.** `position: fixed; top: 0; bottom: 0` ends at the safe area, so a child at `bottom: env(safe-area-inset-bottom)` counts it twice. Children anchor to `--pro-safe-bottom`. Measure, never assume a keyboard or inset height.
- **A surface that can be open with a keyboard sizes against `useFreeViewport`, not `vh`.** The native keyboard shrinks only the visual viewport. The margin is per edge; subtract it twice for a centred modal. `computeFreeBand` is the pure geometry.
- **`@property` with `syntax: '<bg-size>'` or `'<position>'` is invalid** and silently dropped. Use `syntax: '*'`, and read the computed value before judging a CSS mode from a screenshot.
- **On an image skin a box-shadow is always a rectangle.** `[data-img]` sets `border-radius: 0`, so glows use a `drop-shadow()` filter, which follows the image's alpha. The `background:` shorthand also clears `background-image`.
- **A surface hidden with `opacity: 0` is still a tap target.** Gate `pointer-events: auto` on the same class that makes it visible, and gate the handlers too. `visibility` and `display` enforce this themselves; `opacity` never does.
- **A centre-point hit check passes a control whose far half is dead.** Walk the full box every 4px at left, centre and right, for both `data-hand` values, since the control cluster mirrors with handedness.
- **Fixed layers have no shared coordinate system.** Anything floating over the full-screen share must clear `.ai` (z 1300), not the cluster tiers, or it opens underneath. Two individually correct rules can still collide; check `elementFromPoint` on the real page.
- **Reversing an icon row?** Set `--pro-seam-flip` in the same rule as `flex-direction`, and keep its default in the `var()` fallback, not on the element.
- **A pref-backed gate is permanent.** Do not append one next to transient gates (`chatOpen`, `settingsOpen`); resolve collisions by geometry or hit-test deferral, never by unmounting.
- **The way out of a full-screen gate is `TerminalBack` (`react/TerminalState.tsx`),** never a button owned by `TouchpadLayout`, which is not mounted under those gates.
- **Back on the AI screens is a stack in `ai/AiRoot.tsx`:** `goTo`, `goBack`, `goHome`. Never set the route to home directly.
- **A session's `label` changes after it connects.** Find an open conversation by `sessionId`.
- **Icons are lucide-react,** one family. Logos and faithful glyphs (the Mac cursor) are the carve-out and may be inline SVG. On the phone, sender and session marks show the project icon (`ProjectMark`), never the generated agent face.

## A harness frame is a screenshot or it is not there

The connect harness (`react/connect-harness.local.html`) renders the real React gates, so its frames are evidence. The native iOS lobby is SwiftUI and cannot render there.

- Show a native screen with a simulator capture, never a hand-drawn HTML copy. A drawing shares no markup with the device, so it cannot show spacing, contrast or what is really on screen, and a caption saying "not a screenshot" does not fix that.
- No build flag reaches the state you need? Add one: `ios/MightyMouse/AppModel.swift` has one `-D MM_UI_STATE_<X>` per state. An unmatched flag runs live, so check you captured the screen you meant.
- If a capture is truly impossible, leave the frame out and name the missing states.

## Skins

Read `react/SKINS.md` before writing one. Remote skin CSS is sanitised by `remote-skins.ts`: only `--pro-*` properties and declared `url()` assets survive. Mobile Safari caches skin images across reloads, so reinstalling under the same id serves stale assets; bump to a fresh id to check a change.

## Prefs live in two places

- **Mac-side prefs** (`PHONE_REMOTE_*` keys in `src/main/store/paths.ts`): enabled, tunnel, layout, skin, colour scheme, handedness, keys position, sensitivity, stay-awake, paired devices. They reach the phone in the first paint and then the `layoutPrefs` event.
- **Phone-local `localStorage`** (never sent to the Mac): haptics, debug layout, virtual keyboard and dock position, lazy mode, camera picture-in-picture, open settings sections, host discovery state and the device credential.
- Decide which side a new pref belongs to before adding it. A display choice that only matters to one phone is phone-local.

## Server surface

| Route | Purpose |
| --- | --- |
| `GET /whoami` | unauthenticated discovery probe |
| `POST /pair` | 6-digit code to a durable device credential (an installed web app's only way in) |
| skin routes | catalog, installed skin CSS, skin assets |
| everything else | static files from `react/dist/`, falling back to `index.html` with prefs injected |

- One credential authorizes a socket: the device credential (`?d=`) from `/pair`. The QR carries a pairing code (`?c=`), which is spent on `/pair` before the first socket dial.
- An installed iOS web app has its own storage and launches with no query string, so anything passed in a URL never reaches it. That is why `POST /pair` exists.
- The pairing UI is one component, `src/renderer/src/components/PairingPanel.tsx`. A surface that needs it different takes a prop.

## Diagnosing on-device bugs

- Read the stuck screen's exact words first. The certificate message and the "session expired" message come from unrelated branches.
- `from: '127.0.0.1'` in a rejection log does not mean the phone never arrived: the tunnel dials the server as localhost.
- Correct bytes on disk plus a wrong picture on the device means a cache in between, not a bad file.
- After the Mac app restarts, the phone can keep painting its last frame while receiving nothing. Confirm the socket is live before judging a render.
- `connection-journal.ts` records connect, reject, evict and pair with a reason, in packaged builds too. Evictions there mean the one-socket rule, not a network fault.
- Anything invisible on the device (haptics, a handler that may not fire) needs a readout painted on the phone; a Mac log only proves it ran.
- Turn on Settings, Debug layout colours, and ask which colour fills a gap before reasoning about CSS values.

## Loop

```sh
npm run build:phone-remote   # after any react/ edit, then reload the phone
npm run dev                  # main-process changes (server.ts, ipc/phone-remote.ts) need an app restart
npm run typecheck:node && npm run typecheck:web
npm test -- src/main/phone-remote
```
