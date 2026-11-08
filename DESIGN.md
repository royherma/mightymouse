# MightyMouse - Design Principles

The rulebook for UI/UX decisions across all surfaces (desktop app, Phone Remote, Settings). Read before designing a new flow, adding a second entry point to an existing one, or touching pairing/onboarding. Every rule here exists because it was violated once and cost real time - cited inline.

**Scope note:** `docs/conventions.md` → "UI building blocks" owns *component reuse* (tokens, primitives, icon family). This file owns *flow and interaction* decisions - how many steps, how many entry points, what's shown vs hidden. Don't duplicate the other; extend it.

---

## 1. One surface, one implementation

**Rule:** if two windows/pages show the same feature, they share ONE component + ONE state hook. Never hand-roll the same UI twice "because it's a lighter version."

**Why:** `SettingsApp.tsx`'s Phone Remote card and `PhoneRemoteQrApp.tsx` (the Panel-header QR window) spent months as two independent React implementations of the same pairing UI - the second even said out loud it was "a lighter, focused rebuild." Nothing forced a fix in one to reach the other, which is exactly how the two-QR-codes bug (rule 2) got on screen. It took three passes to unwind: `derivePairing()` unified the state, `PairQr` the QR, and finally `components/PairingPanel.tsx` the markup. Each pass only happened because someone hit a bug the *other* copy already had fixed.

**Apply it:** before writing a second screen for an existing feature, ask "can this be the same component with a `variant`/`compact` prop instead of a new file?" Default to yes. A second implementation is a maintenance debt you're choosing on purpose - only choose it with a stated reason, not as a shortcut.

## 2. One pairing surface per connection mode - never stack two at once

**Rule:** when a feature has multiple ways to connect (LAN vs off-network, QR vs manual, etc.), show exactly ONE at a time, switched by an explicit control. Never render two side by side and let the user guess which one matters.

**Why - the two-QR-codes incident:** the Cloudflare Tunnel (off-Wi-Fi) feature was bolted onto the existing LAN QR card as an always-visible second panel. Both a LAN QR and a tunnel QR rendered simultaneously, with nothing saying which to scan - and the visually dominant one was the weaker (LAN-only) code. Fixed by a `SegmentedControl` ("Wi-Fi only" / "Remote") that gates which single QR renders. The fix is preserved as a code comment at `SettingsApp.tsx:1897-1902` - read it before touching that card.

**Apply it:** adding a new connection method to something that already has one is a MODE, not an addition. Reach for a segmented control / tabs, not a second card stacked below the first.

## 3. Fixed-position elements need ONE shared coordinate system

**Rule:** every `position: fixed`/`position: absolute` element on a screen must be checked against every OTHER fixed element on that same screen before shipping - not just against the layout it was designed next to.

**Why:** shipped twice on the same surface. The Stop/Cancel button pair rendered directly on top of the app-switcher/settings buttons because each was individually correct but nobody checked the combination - typecheck and tests were clean. The Classic layout is 3 fixed-position circles at `left: 50% ±76px`, the same class of bug. The root cause: `TouchpadLayout.tsx` has multiple independently-positioned fixed elements with no shared coordinate system.

**Apply it:** Screenshot every state (idle AND active/recording/open), pull real `getBoundingClientRect()` numbers for every fixed element on screen, check for overlapping ranges. Don't eyeball a compressed screenshot when two elements are close.

## 4. Never expose a raw connection URL/IP as text when a QR can carry it

**Rule:** pairing info (LAN IP, tunnel hostname, port) is encoded ONLY in the QR payload. Never print it as copyable/readable text in the UI.

**Why:** deliberate, repeated design choice (`SettingsApp.tsx:1915-1917`, `:1979-1981`) - "the QR is the only pairing surface." Reduces both accidental leakage (screenshots, screen-share) and the temptation to hand-type a URL that will go stale.

**Apply it:** any future pairing/handoff flow (not just phone-remote) should default to QR-or-equivalent-opaque-transport over a visible URL, unless the user explicitly needs to type it somewhere a camera can't reach.

## 5. Minimize clicks - count the steps before shipping a flow

**Rule:** for any flow with a clear end goal (pair a phone, upgrade a plan, install a cert), write down the step count before building it. If a step doesn't change what the user sees or does next, cut it.

**Concrete bar, phone-remote pairing (current, as-implemented):** Settings toggle ON → scan QR → tap through the cert warning once → done. Four steps. That's the ceiling - any new phone-remote feature that adds a step to this path (a confirmation dialog, an extra toggle before first use, a second QR) needs a specific stated reason, not just "seemed safer."

**Apply it:**
- Every new toggle/step in an existing flow costs real completion rate - treat it as a cost, not a free safety net.
- If a decision can be inferred (LAN vs tunnel from what's already toggled on) don't ask again.
- One control per decision. If the user has to make the same choice in two places (rule 1), that's not two chances to get it right - it's two chances to disagree with each other.

## 6. Reuse the platform's native affordance before building a custom one

**Rule:** when the OS/browser already has a solid UI for something, use it. Don't rebuild a worse version.

**Why:** the on-screen keyboard reuses the phone's real native keyboard (via a hidden focused `<input>`) instead of a custom virtual keyboard - same reasoning as "scan with the Camera app, not an in-app scanner" for QR pairing. Both cut real engineering cost AND land on UX users already know.

**Apply it:** before designing a custom control (keyboard, camera picker, share sheet, file picker), check if the native one can be wired up instead. Image paste does this correctly - native file picker covers camera + library in one button, no custom UI.

## 7. A design decision applied once must be written down where the next editor will see it

**Rule:** the fix site gets a ONE-LINE pointer naming the constraint. The story - what broke, how it was found, what was tried - goes in the commit message.

**Why:** this rule used to say "the principle goes in a comment at the fix site," with no length term. That licensed an incident report per fix, and its own flagship example (the two-QR comment) grew to 8 lines. A comment is the worst home for a war story: it isn't searchable, it rots silently, and it costs every future reader of that function. A pointer is enough to stop a regression; the reader who wants the story can read the commit.

**Apply it:** `{/* ONE QR, mode-switched - stacked QRs hid which to scan */}`. One line, names the invariant. If you can't fit the constraint in one line, the comment isn't the problem - put the story in the commit message and keep the one-line constraint.

## 8. Security/consent debt is still debt - track it explicitly, don't let scope creep bury it

**Rule:** when a feature note says "should be the FIRST fast-follow" (auth, PIN, consent), treat that as a blocking line item for the NEXT change in that area, not a someday-list entry that quietly never comes back.

**Why:** the original phone-remote design flagged token-gated pairing as "should likely be the FIRST fast-follow, not a someday item" - because voice commands can spend LLM billing credits, and anyone on the LAN with the QR could trigger them. It stayed unbuilt across many later phone-remote features while the surface it protects grew (the Cloudflare Tunnel makes the control surface reachable from any network). Pairing is now gated by a per-device credential minted by `POST /pair` (`src/main/phone-remote/device-credentials.ts`).

**Apply it:** if a design explicitly names a follow-up as urgent, the NEXT change that touches the same feature should either ship it or explicitly re-justify deferring it - not silently move on to unrelated feature work.

## 9. Every panel needs ONE dominant element - rank the data, don't flatten it

**Rule:** before shipping a panel, name the single thing the eye should land on first. If you can't name it, the panel has no hierarchy and will read as grey mush. Two sub-rules, both concrete:

- **A value beats its own label.** A stat's number gets a bigger size AND heavier weight than its caption - at minimum one full step apart (`text-base` value over a `text-2xs` label, not `text-sm` over `text-2xs`).
- **Ranked data gets a ranked form.** If the numbers differ by more than ~3×, chips/pills are the wrong container - they give every item identical weight. Use a bar list (length encodes rank pre-attentively) and cap it at ~6 with a `+N more`.

**Why - an admin user drawer:** it obeyed every rule in `docs/conventions.md` - primitives reused, zero raw hex, 3 px literals in 664 LOC, real "why" comments - and still shipped ugly. "What they do most" was 11 identical pills wrapped over three rows, so a 20× gap between the top event and the bottom was invisible; you had to read all 11 numbers and sort them yourself. The money header set values at `text-sm` and labels at `text-2xs`, close enough that four numbers scanned as one grey mass. **Typecheck and 999 tests were green the whole time** - neither checks whether anything is legible.

**Apply it:** "correct code, ugly pixels" is the failure mode this file's other rules don't catch. Reuse rules (`docs/conventions.md` → UI building blocks) say *which* component; this rule says whether the arrangement communicates. Also: a class string repeated 3+ times in one file is a missing primitive (the drawer had the same heading string 8×, now `SectionLabel`) - extract it in the same pass, not later.

## 10. Verify a UI change where it's cheapest - a NEW harness is the last resort, not the first move

**Rule:** pick the cheapest verification that actually shows the pixels, in this order. Stop at the first one that works.

1. **An existing harness already renders this surface?** Use it (`PlaygroundApp.tsx`, the `*-harness.local.html` files in `src/main/phone-remote/react/`).
2. **Surface reachable for real?** Screenshot the real thing - the Electron window. No harness.
3. **Gated (login/admin) or unreachable AND no existing harness covers it?** *Then* build one.
4. **Otherwise: no harness.** Read the diff/CSS, ship, and say what you read instead of what you screenshotted.

**Why:** a harness is real cost - a file, a fixture set, a build, a screenshot loop - and building one per change made every small edit feel like a project. The original incident was a *gated* surface (`/admin` only ever screenshots `<Login />`), and that's the case still worth a new harness. A spacing tweak, a copy change, a color swap, or a bugfix on a surface that already has a harness is not.

**Apply it:** harnesses live next to the surface they test (`*-harness.local.tsx`, `PlaygroundApp.tsx`) and are never imported by the prod bundle. When you *do* render, screenshot every state the change touches (rich AND empty - a ranked list with zero rows is where layouts degrade), and pull real `getBoundingClientRect()` numbers for fixed/absolute elements (rule 3) rather than eyeballing a compressed image. When you *don't*, say so plainly in the commit - "read the diff, no layout change; needs a visual check" - never imply you looked at pixels you didn't.

**A harness fits one screen at 1512x860.** All its states side by side in a grid, so a reviewer sees them at a glance with no scroll; only a long list (~10+ states) may scroll, and under 2 screens. Measure `document.documentElement.scrollHeight` before calling it done.

**Scratch/throwaway harnesses** (a scratchpad HTML page to iterate on phone-remote CSS): not the first move either. Read the code, make the fix, ship it. Build a scratch harness only after a fix has already failed once and you need to iterate on pixels.

## 11. Every state change must be visible within 100ms - a refetch is a loading state, not a no-op

**Rule:** if a user action triggers work, the pixels must change *immediately*, and keep saying "working" until it resolves. The four states - **idle / loading / stale / error** - are each a distinct render, and any surface that fetches has to answer all four. A skeleton that only covers the FIRST paint is a half-finished feature: every subsequent interaction goes silent.

Concretely, for any fetching surface:

- **First load → skeleton**, shaped like the real content (see rule 10's harness note - a wrong-shaped skeleton makes the layout jump, which is the jank it exists to prevent).
- **Refetch with data on screen → stale treatment, never nothing.** Dim the container (`opacity-50`) and kill `pointer-events`, or overlay a spinner. The user must never be able to read an old number as if it were the answer to what they just clicked.
- **The control that was clicked shows its own pending state** - the pressed range button, the toggled switch - because that's where the eye already is.
- **Any freshness timestamp goes stale-marked during a refetch.** "updated 9:26:48 AM" next to numbers being replaced is an active lie.
- **Errors are recoverable, not announcements.** An error banner needs a **Retry** button and must say what failed. And if data is still on screen behind the error, the error must say so - otherwise you're showing stale numbers under a red box and the user can't tell which half to believe.
- **Background/secondary fetches degrade visibly.** A supplementary call (deltas, enrichment) that fails silently makes a feature look unbuilt rather than unavailable.

**Why - an admin Traffic tab:** the dashboard gated the skeleton on `loading && !stats`. On first paint that's right; on every range switch after it, `stats` is truthy, so `switchRange` → `setLoading(true)` → **not one pixel changes.** Clicking 24h/7d/30d looked broken: the old range's numbers sat there fully opaque and clickable, `updated 9:26:48 AM` kept claiming freshness from the previous fetch, and the only signal anything happened was the number silently changing seconds later. `Failed to fetch` rendered as a bare red strip with no retry and no indication that the dashboard below it was still showing pre-error data. The delta fetch (the `days * 2` call) had no loading state at all - when it fails, DeltaChips just never appear and the tab reads as "trends were never built."

None of this was missing infrastructure. `Skeleton` + `StatsBodyV2Skeleton` already existed and were already good. The defect was that the loading state was wired for exactly one moment in the lifecycle.

**Apply it:** the test is *"if I click this and the network takes 3 seconds, what moves?"* If the honest answer is "nothing until the data lands," it isn't done. Write the gate as `loading` (any fetch), not `loading && !data` (first fetch only) - that single condition is the bug, and it will be the bug again in the next fetching surface. Verify it by throttling the network in the harness (rule 10) and screenshotting the in-flight frame, not just the settled one.

---

## 12. One token source - a colour defined twice is already drifting

**Rule:** every colour, radius, shadow, spacing step and font size in the product comes from **`CONFIG.THEME_TOKENS` in `src/shared/config.ts`** (71 keys). Three consumers read that object directly and inject it with the same key→`--css-var` algorithm - `src/renderer/src/theme.ts` (renderer), `src/main/phone-remote/react/main.tsx:37` (phone), `scripts/gen-ios-theme.mjs` (iOS). **Adding a colour means adding a key there.** Never a hex in a component, never a new `--var` in a stylesheet whose value is a colour.

What each thing is allowed to be:

- **`var(--token, #fallback)` is CORRECT usage, not a violation.** 51 of the 61 hex literals in the renderer are exactly this shape. A cleanup pass that strips those fallbacks makes the UI worse - the fallback is what paints during the frame before `injectTheme()` runs. Leave them.
- **A `--var` in `index.css` / `phone-remote/react/theme.css` is legitimate only for layout math** - safe-area insets, grid columns, component geometry (`--pro-gutter`, `--classic-safe-bottom`, `--kb-chip-h`). Never for a colour, radius, shadow or font size; those all already have tokens.
- **Brand marks are exempt** - `MouseGlyph`, `ProviderIcon`, `ConnectorBrandIcon`. A logo's colour is the vendor's, not our design system (same carve-out as the icon rule in `docs/conventions.md`).
- **Geometry that happens to be a colour is exempt** - `#000` inside a `linear-gradient` used as a `mask`, where the value is an alpha channel and not a design decision.
- **`phone-remote/react/skins/*` is exempt** - a skin IS a self-contained palette. It is the one place in the product where a literal colour is the deliverable rather than drift.
- **Translucent pure black/white is exempt** - `rgba(0,0,0,0.35)` is a scrim, `rgba(255,255,255,0.05)` is a glass lift. That's depth, not palette, and tokenising it buys nothing. Opaque `#fff`/`#000` still count, because those are text and surface colours that do have tokens.

**Why this rule exists, and why it isn't about drift:** an agent transcript had an agent report that UI tokens were "defined elsewhere" and work around them. The token layer was fine - it is genuinely one source with three honest consumers, which is further than most codebases get. The defect was that **this file, the one an agent opens when designing a surface, had eleven rules and none of them mentioned tokens.** The system was only written down in `docs/conventions.md:71`, which an agent designing UI has no reason to open. A correct system nobody can find gets reinvented, and the reinvention is what drifts.

**Measured baseline the day the rule was written**, after every exemption above: **62** in the renderer and **135 + 61 colour-holding `--var`s** in `phone-remote/react/theme.css`. Nearly all are a token retyped by hand - `index.css:66` is `THEME_TOKENS.bg` at a different alpha, `index.css:2870` is `rgb(255, 149, 61)` where `accent` exists.

Two things that number teaches. **The drift is in the stylesheets, not the components** - `.tsx` contributes ~30 of ~200; `index.css` and `theme.css` are the whole story. And **`rgba()` is the dominant colour literal here, not `#hex`**: an earlier hex-only grep of `.tsx` reported "10" and concluded the tree was clean. Don't re-derive this with a naive grep.

---

## 13. A new surface gets a design pass BEFORE the JSX

**Rule:** building a **new window, panel, screen, or a rebuilt layout of an existing one** starts with a design pass (for agents, the `impeccable` skill's `shape <surface>`), not with the first `<div>`. That pass decides three things and writes them into the reply: **the one dominant element** (rule 9), **the layout grid**, and **what each state looks like** (rule 11's idle/loading/stale/error, plus empty). Then build to that decision.

**Exempt - the normal loop, no design pass:** a spacing or colour tweak, a copy change, a bugfix, adding a row to a list that already exists, anything inside a layout that was already shaped. The trigger is *a composition that has never been decided*, not *a file under `src/renderer/`*. If you can name the dominant element of the surface you're editing without thinking, the pass already happened.

**Why - `VoiceRouteApp.tsx`:** the voice routing card in the HUD shipped looking bad. The file passes every mechanical rule in this document. **Zero raw hex** (rule 12), tokens throughout, one inline style and it's a `--face` custom property carrying a `why` comment. It has three separate landmine comments recording earlier fixes - the arrow that used to overlap the percentage (`VoiceRouteApp.tsx:281`), hover growing the whole card and moving rows out from under the cursor (`VoiceRouteApp.tsx:263`), the width spent per kind (`VoiceRouteApp.tsx:319`). Whoever wrote it was following the rules and fixing real defects as they appeared.

It still looks bad, and the two diagnoses that come to mind first are both wrong. It isn't drift - there are no off-token values in this file. It isn't a missing lint - no checker catches "this has three columns of equally-weighted rows and no dominant element." **The defect is that the composition was never decided.** It was assembled a fix at a time, each one locally correct, and the comments are the fossil record of exactly that: every one documents a collision between two elements that were never laid out relative to each other in the first place. A layout arrived at by patching collisions is the thing this rule exists to prevent.

**Why the pass and not a screenshot:** rule 10 tells you to read the diff and not build a harness, and the default loop in `docs/conventions.md` is not to screenshot. **Both stay true - this rule does not touch them.** They're right about *verification*, which is the reviewer's loop and their eyes. They were silently carrying a second job they were never meant to do: with no design step anywhere, "don't screenshot" became "nobody ever thinks about the composition." A screenshot after the fact would only have shown the bad layout, and the agent that shipped it had no standard to judge it against - that's why a critique pass wasn't chosen here. The decision has to exist before the code, or there is nothing to build to.

**Apply it:** invoke the skill, take its Operate mode for app UI (scanability and hierarchy outrank expression), and put the three decisions in the reply as two or three lines before the first edit. `impeccable` also has `critique` and `polish` for a surface that already exists - those run on request, not as part of this rule. One line in the commit saying which surface got a shape pass; a new surface that skipped it should say why.

**The harness is part of the surface, not a favour to the next agent.** A new surface ships with its `*-harness.local.html` in the same commit, tracked in git. A harness nobody can find is the same as absent: an agent that can't see one will ship blind exactly as rule 10 step 4 permits.

**This is not hypothetical - it's the second half of the same incident.** `voice-route-harness.local.html` **already existed** when the surface shipped looking bad. It appeared in no listing, and it was still **untracked in git** - one `git checkout` from gone. The verification path was built and then invisible, which is worse than missing, because everyone downstream reasonably concluded there wasn't one.

**So the cheap check, in order:** find the surface's harness → open it → screenshot every state the change touches → read the pixels for the two defects that a typecheck can never catch: **any two boxes overlapping, any text clipped.** Seconds, not a project. If the surface has no harness, adding one is part of the work.

---

## 14. New Mac UI is the kit

**Rule:** a screen is a `WindowFrame` of `Card`s of `Stack`s and `Row`s of `Button`s. The list lives in `docs/conventions.md`. This file does not copy it.

**Why:** `PanelApp.tsx` did not import `Button` (31 raw `<button`s). `PlaygroundApp.tsx`'s Buttons section, the catalog, was itself raw `<button className="bg-accent ...">`. Conventions already said to reuse the primitive, and nothing failed, so the next screen reinvented it. Same shape as rule 12.

**Apply it:** an added raw `<button` or a new class selector in `src/renderer/src/index.css` is drift. Existing debt is grandfathered. A control that cannot be `Button` yet carries `kit-ok:` on that line. Overlay windows (cursor, gaze, highlight, draw, cheese, island, sound, hands-free, webrtc capture, drag coach) are exempt. Do not add a component type.

---

## 15. Place new actions by purpose and priority

**Rule:** adding a button means arranging the whole action group. Keep the primary action first and visually dominant. Group related secondary actions together, with short labels and consistent control heights. Do not prepend a new secondary action merely because it is easy to insert there.

**Why:** the session rail's Archive action initially occupied a tall, half-empty row above “Go to this agent,” wrapping “Archive session” onto two lines. The existing two-column layout already had room beside Wrap up. The fix moved it there and shortened the label to “Archive.” Reusing Button alone did not produce a good arrangement.

**Apply it:** session actions read as: Go to this agent; Open folder / Copy path; Archive (or Restore). Archive is the desktop session cleanup action; do not reintroduce Wrap up alongside it. Archiving hides a session and must not stop its agent. Use the existing shared grid and spacing tokens; do not shrink text to squeeze in redundant words. Check the whole group at its narrow supported width, including missing actions, disabled controls, confirmation and error states. A passing typecheck does not verify visual placement; report source-only verification honestly when visual verification was not performed.

---

## 16. A row that belongs to a project shows the project's picture

**Rule:** any list row, header or chip that names a project or a session inside one leads with `ProjectAvatar` (`src/renderer/src/components/ProjectIcon.tsx`) - the project's picture, else its chosen icon, else the fallback. Never a generic lucide glyph (`Folder`, `SquareTerminal`) in that slot. Resolve a session to its project with `mightyProjectForCwd` (`src/shared/relay-sessions.ts`).

**Why:** people scan by picture before they read. The sidebar, Factory and session detail already showed avatars; the Cmd-K search showed a terminal glyph on every Code session row until it was fixed to match.

**Apply it:** before shipping any new list of projects or sessions, grep the row for `ProjectAvatar`. Missing = not done. Size 13-18 in dense lists, 22+ in pickers.

---

## 17. A page never takes over the left sidebar - its own filters go in a column inside the page

**Rule:** the left sidebar always shows the same thing: the nav and the projects with their sessions. A page that needs a project picker or any other filter list puts it in its own column inside the page, left of its content, using the shared `keys-rail` / `keys-rail-row` classes (`src/renderer/src/components/KeysPanel.css`). Never `createPortal` page content into the sidebar's `listSlot`.

**Why:** Made portaled its project filter into the sidebar and hid the sessions list, so the sidebar changed shape on one page only and people lost their sessions. Keys and Infrastructure already did it right with an in-page column, and Made was changed to match.

**Apply it:** a new page with a scope picker copies `KeysPanel.tsx` / `InfraPanel.tsx`: rail column, then a head naming the picked scope (`ProjectAvatar` + name, rule 16), then the content. Grep the new page for `listSlot` - any hit is a violation.

---

## Known open items

Not violations of the rules above - just current state that a future session should know before assuming these are settled:

| Item | State |
|---|---|
| Cert SAN strategy (LAN IP vs `.local` hostname) | Unresolved - IP-change forces cert regen, which breaks standalone/PWA trust |
| Classic vs Pro touchpad layout | Accepted permanent fork, not a migration path - new features build Pro-first + a separate Classic path per feature |

## When to add to this file

A UX mistake that cost real time gets a rule here, written the session it's found, cited to the file:line or commit that proves it. Don't add speculative "best practice" bullets that aren't grounded in something that actually happened in this codebase - that's how a rules file turns into unread boilerplate.
