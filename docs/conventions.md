# Code conventions - literals, UI primitives, IPC, stores

The four conventions that have each caused real bugs here. `AGENTS.md` carries the one-line
version of each; this file is the detail. Read the relevant section before writing code in
that area.

---

## No magic strings - constants & enums only (HARD RULE)

**Untyped** magic strings (and magic numbers) are banned. The enemy is a meaningful literal
with NO type backing - a `string`/`number` the typechecker can't catch a typo in. A raw
literal that carries meaning - a status, kind, key, channel, route, event name, error code,
store key, CSS token, threshold, timeout - MUST be a named constant or a union/enum, defined
once and imported. Repeated or hand-duplicated literals are the worst offenders: they drift,
typo silently, and dodge the typechecker.

**The key test: is the literal already type-checked?** A literal assigned to or compared
against a string-union/`as const` type is FINE as-is - `setMode('ask')` where the param is
`AppMode = 'rewrite' | 'ask' | 'act'` is exactly as safe as `APP_MODE.ask`; typo it and TS
rejects it. Don't churn those into constant objects for no safety gain. The rule targets
literals the typechecker can't see: a bare `string` compared to `'act'`, a store-key typed by
hand in two files, an event name duplicated across modules.

**Why this is load-bearing:** an *untyped* literal (`"rewrte"` vs `"rewrite"` on a loose
`string`) compiles fine and fails at runtime; the same value behind a union or constant won't
compile. One definition = one place to change, grep, and refactor.

Where the canonical sets already live (extend these, don't fork a new literal):

| 🔤 Kind of literal | 📁 Home (define + import) |
|---|---|
| IPC channel names | `CHANNELS.*` in `src/shared/ipc.ts` |
| Window routes (`?window=`) | the `?window=` switch in `src/renderer/src/main.tsx` |
| Backend ids | `BACKENDS` keys in `src/main/backend/adapters.ts` (`BackendId` derives from them) |
| Modes (rewrite / ask / act) | `src/shared/mode.ts` + `src/shared/types.ts` unions |
| Colors / spacing / radii / sizes | `THEME_TOKENS` in `src/shared/config.ts` |
| Timeouts / ceilings / thresholds | `CONFIG.*` in `src/shared/config.ts` |
| Store keys / file names | the store module that owns them (`store/prefs.ts`, `store/settings.ts`) |
| Event / error names | `analytics.ts` / the error pipeline |

Hard rules:
- **Define the literal once, then reference the symbol.** Never type the same meaningful string
  in two places - extract a `const` or union member.
- **Type the value first.** A free `string` field/param that only ever holds a few values should
  be a union (`type Mode = 'rewrite' | 'ask' | 'act'`) - that alone makes the typechecker reject
  typos and exhausts `switch`es. Reach for an `as const` object (`HUD_MODE`) when you also need
  the value at runtime, or a real `enum` only when you need its runtime object.
- **No `if (x === 'somestring')` where `x` is an untyped `string`.** Either type `x` as the
  union, or compare against the named constant.
- **Already-typed union/`as const` members are fine inline** - `'ask'` against `AppMode`,
  `HUD_MODE.recording`. The type already guards them.
- **Exceptions (fine to inline):** a string used exactly once with no semantic weight (a log
  message, a one-off `aria-label`), and obvious non-magic numbers (`0`, `1`, `-1`, index math).
- **Cleanup is in-scope, always.** Passing through code with a stray literal that belongs in one
  of the homes above? Promote it now - that's "fix what you see," not scope creep.

---

## UI building blocks - reuse, never reinvent

Renderer UI is built on a token + primitive layer. **Before writing any JSX, check if a
primitive already exists. If it does, import it. If a pattern appears 2+ times, extract a
primitive - don't copy-paste the inline styles.** This is load-bearing: raw duplicated JSX is
how this UI rots.

| 🔎 Need | 📁 Source of truth |
|---|---|
| Colors / spacing / radii / shadows / font sizes | `THEME_TOKENS` in `src/shared/config.ts` - the ONE source. Injected as CSS vars by `src/renderer/src/theme.ts`, wired into Tailwind via `tailwind.config.js`. |
| Containers | `WindowFrame` (the window), `Card` + `SectionHeader` (`src/shared/ui/Card.tsx`; `panel` = portal look), `Stack` (vertical), `Row` (horizontal). A screen is a window of cards of stacks of rows. |
| Actions | `Button` in `src/shared/ui/Button.tsx` (re-exported from `components/Button.tsx`) - `primary`, `secondary`, `ghost`, `text`, `success`, `danger`, `icon`, `bare`; `size` md/lg; `busy` (a row, tab, or link that must not gain padding or a border). |
| Text | `Muted` in `src/shared/ui/Text.tsx` |
| Controls | In `src/shared/ui/` (re-exported from `components/`): `Switch`, `Badge`, `Kbd`, `Spinner`, `ProgressBar`, `Input`. Mac-only in `components/`: `SegmentedControl`, `ChipPicker` (needs `AppIcon`), `ConfirmDialog`, `TitleBar`, `LoadingBody` |
| **UI icons** | **`lucide-react` - the ONLY icon family.** `import { Zap } from 'lucide-react'`; size via `size=`, never `strokeWidth=` (one weight). Icon-only action = `Button variant="quiet"`. Copy = `CopyButton` (`showLabel` when two sit together) - never a hand-built `<Copy`. Icons inherit `currentColor`. |
| Not the kit | Feature screens in `components/` (`KeysPanel`, `CodePanel`, `PairingPanel`, `session-thread`). Compose them out of the containers. Do not copy them as primitives, and do not add a new component type. |
| Shared hooks | `src/renderer/src/hooks/` (`useIpcSubscriptions`, `useInterval`) |
| Sidebar notices / banners | `usePostNotice({ id, title, detail?, action?, body?, sticky?, version? })` from `components/SidebarNotices.tsx`. One stack in the Mac sidebar foot: top notice shown, the rest under "N more", X remembers the hide per `version` (new version shows again). `sticky` = no X, sorts first. Never hand-roll a dismissible banner. |

Hard rules:
- **Shared pieces live in `src/shared/ui/`; app folders only re-export.** A new shared folder needs its glob in both Tailwind configs (`tailwind.config.js`, `phone-pulse.tailwind.config.js`).
- **One icon family: `lucide-react`. Do NOT add a second icon pack** (heroicons, react-icons,
  tabler, feather, phosphor, emoji-as-icons). Adding an icon = one import from lucide. If lucide
  genuinely lacks a glyph, hand-roll a single inline SVG in `components/` - don't pull in another
  dependency. **Exception - BRAND marks** (`MouseGlyph`, `ProviderIcon`'s Anthropic/OpenAI logos):
  these are logos, not UI icons, and stay hand-rolled inline SVG. Emoji are still fine as
  decorative content inside `Badge`s/copy, just not as the UI icon system.
- **No raw `<button`.** Use `Button`. An added raw `<button` in the Mac app, phone remote and `src/shared` (not
  `src/shared/ui`), or a new class selector in `src/renderer/src/index.css`, is drift. Existing ones are grandfathered. A control that
  cannot be `Button` yet carries `kit-ok:` on that line. `DESIGN.md` rule 14.
- **No raw hex colors in JSX.** Use a token (`var(--blue)`, Tailwind `bg-blue`). The only hex
  lives in `THEME_TOKENS`. Full rule + the four exemptions (`var()` fallbacks, brand marks,
  gradient-mask geometry, layout-math vars): `DESIGN.md` rule 12.
- **Colors - every surface reads `THEME_TOKENS`, no hand-copied brand.** Mac and phone
  get CSS vars at runtime; iOS gets `Generated/Theme.swift` (`MMColor`/`MMRgb`). Change a color in
  `theme-tokens.ts`, then `npm run gen:ios-theme` - never edit a generated block.
- **No inline `style={{...}}` blobs that re-compose a known pattern** (a badge, a bar, a tab
  switcher). If the CSS class or a primitive exists, use it.
- **Don't define a component privately inside an `*App.tsx`** if another window needs the same
  thing - put it in `components/` and import it. (We got burned: `GlowDot` was re-implemented in
  3 windows.)
- **`PlaygroundApp.tsx` is the living catalog** of the design system - check it to see what's
  already available before building new.

---

## IPC convention - always use CHANNELS

Every channel name is a constant in `src/shared/ipc.ts` (`CHANNELS.*`). Never use a bare string
literal in `ipcMain.handle`/`.on`, `ipcRenderer.invoke`/`.send`, or `webContents.send`. Payload
params in `ipc.ts` handlers are typed against `types.ts`.

Adding an IPC call touches **4 files in lockstep**:
1. `src/shared/ipc.ts` - add the `CHANNELS` constant.
2. `src/main/ipc.ts` - `ipcMain.handle(CHANNELS.x, ...)`.
3. `src/preload/index.ts` - `window.api` method calling `ipcRenderer.invoke(CHANNELS.x, ...)`.
4. `src/preload/index.d.ts` - the method signature on `CustomAPI`.

---

## Relay verbs - the schema and the generic are ONE edit

A verb in `src/main/agent-relay/mcp/verbs.ts` declares its params twice, and TypeScript only
connects the two through the handler's generic:

```ts
const recapHandler: VerbHandler<{
  text: z.ZodString
  generated: z.ZodOptional<z.ZodBoolean>   // ← every inputSchema key needs a line here
}> = {
  inputSchema: {
    text: z.string().max(TLDR_MAX),
    generated: z.boolean().optional()
  },
  async run(args) { /* args.generated is typed only because of the generic above */ }
}
```

**Adding a key to `inputSchema` without widening `VerbHandler<…>` does not fail where you added
it.** It fails at the read (`args.generated` → TS2339) and at the schema literal (TS2353), so
the error points at two places that both look correct in isolation. `npm run typecheck` is the only thing
that catches it, so run it before you stop.

Zod-to-generic mapping for the shapes verbs actually use:

| `inputSchema` | Generic entry |
|---|---|
| `z.string()` | `z.ZodString` |
| `z.boolean().optional()` | `z.ZodOptional<z.ZodBoolean>` |
| `z.number().optional()` | `z.ZodOptional<z.ZodNumber>` |
| `z.array(z.string()).optional()` | `z.ZodOptional<z.ZodArray<z.ZodString>>` |
| a shared field const (`fromField`, `testField`, `imagePathField`) | `typeof fromField` |

That last row is the house idiom, not a shortcut: fields reused across verbs are declared once
as a const and referenced with `typeof`, so widening the field updates every verb that takes it.
Spell out a zod type only for a key that verb alone has.

**Then restart.** Verb handlers are main-process code, so restart the app before testing the new
key - a typecheck proves it compiles, never that the running app has it. A flag tested against a
stale binary reads as working while doing nothing.

---

## Two stores - don't confuse them

| Store | File | Holds | Shape |
|---|---|---|---|
| `SETTINGS` (`store/settings.ts`) | `~/MightyMouse/settings.json` | ffmpeg/whisper paths, AV devices | typed JSON, batched `.set(patch)` |
| `PREFS` (`store/prefs.ts`) | `~/MightyMouse/*.txt` (one value/file) | cursor companion, backend, last instruction/mode, ctx toggle | flat text, write-through |

Live toggles (cursor companion, model backend) go in **PREFS** - no schema migration, written on
change. Path-style config goes in **SETTINGS**, saved behind a Save button. All under
`~/MightyMouse/` (= `CONFIG.APP_NAME`).

**History (`rewrite-history.jsonl`) is a third store** - append-only JSONL of every run (full
instruction/selection/result/turns), owned by `store/history.ts`. Read it through `HISTORY.*`
(warm-cached, decrypts transparently), **NEVER by reading the file directly** - a direct read
breaks when encryption is on. Pre-conversion backups land in `~/MightyMouse/backups/`.

## Preload/renderer are separate worlds - `contextIsolation: true`

`globalThis.X = value` set in preload is invisible to the renderer - `sandbox: false` grants
`process` in preload but does NOT merge the two V8 worlds. To move a value preload→renderer, use
`contextBridge.exposeInMainWorld` and read it from `window.*`, never a shared global.

## Comments: write ZERO - the full rule

**The default number of comments in a diff is 0, not "a few".** Output code, not code plus
narration. A comment that restates what the line already says (`// set the flag`, `// loop over
items`, `// handler for click`) is noise every reader has to read past - delete it before you write it.
Section banners, `// --- helpers ---`, JSDoc on any function, and "what this file does"
headers are all the same violation. If the code needs a sentence to be understood, rename the
variable or split the function instead.

**The code is the truth; a comment only ever carries what no code can.** Two tests, both must
pass: nothing in the file already says it (a name, a type, a signature, a test), and it fits in
ONE line. **On line 2 you are over - stop and delete.** A multi-line `/** */` block above a
function is banned outright: no JSDoc, no param docs, no essays. If it genuinely needs a
paragraph, the paragraph goes in the commit message and the code
gets nothing.

**The only three that survive:** a landmine (do this wrong and it breaks in a way you'd never
guess), a non-obvious constant's *value* (`// 1200ms - below this the WS reconnect races`), or a
deliberate deviation from the obvious approach. Each is a `why`, never a `what`, and each is one
line. If you can't state the landmine, there isn't one.

**When editing existing code, strip the dead narration on lines you're already changing.** Not a
sweep - **never go back over untouched comments**, no trimming, rewording, or auditing pass - but
a line you're rewriting anyway doesn't get to keep its `// increment counter`.

Symptom of violation: a diff where you could delete every green comment line and lose nothing.

## Don't touch what you weren't asked to touch

Fires before every `Edit`. **A line whose only change is prose is a violation** - rewording a
comment, "improving" phrasing, re-explaining code you didn't change. If the code on that line is
byte-identical before and after, revert the line.

Symptom: a diff where the red and green halves say the same thing in different words.

## Don't write tests during feature work - the full rule

**Hard rule.** Ship the code, not the code plus its test. Tests are backfilled in one pass before
a release, diffing against the last tag and covering what's
actually risky. Writing a test alongside every change doubled the diff and the loop time for
coverage that mostly restated the implementation.

**Exception - write the test inline only when it IS the fastest way to see your change work:** a
pure function with branchy logic where a `vitest` run beats an app restart, or a bug with a
known bad input (that input is the cheapest proof the fix landed). If you're writing a test to be
thorough rather than to get an answer, that's the rule firing - stop and leave it for the
release backfill.

**Never delete or weaken an existing test** to make something pass.

## File size and placement

**New files need ~80+ lines of real logic**, or the code belongs inside its only consumer.
Splitting a feature across modules to make each look small is gaming the LOC estimate.

**Ratchet breaker:** adding to a file already over ~1,500 LOC? New module/hook/component instead  - 
the 80-LOC floor doesn't apply. Hub files (`App.tsx`, `MightyApp.tsx`, IPC handlers) only grow
because appending is the smallest diff. Don't feed them.

**Least code that fully solves it** - no speculative abstraction, no dead options; delete more
than you add when you can. **Guard the architecture:** check if the pattern exists before adding
code. Extend it; don't fork a new one. A change that fights the architecture is a signal about
the architecture.

## The reviewer is the tester - the full screenshot rule

**Default for a UI change: edit → typecheck → restart the app if it touched
`src/main`/`src/preload` → one line saying what changed. Then STOP.** The reviewer runs and tests the app
themselves; a harness spin-up is dead time in their loop. "Not screenshotted" is the normal, correct
report.

**Screenshot only when you genuinely can't resolve geometry by reading** (a new `position: fixed`
element, a moved box, a z-index change) - judgement, not a checklist. When asked, do it
properly: an existing harness (building a new one is the last resort, `DESIGN.md`
rule 10), every state the change touches.

**The one carve-out: a brand-new window/panel/screen.** Shape it first (`DESIGN.md` rule 13),
then look at it once in its harness before saying it's done - that surface has never had eyes on
it, and "read the diff" can't tell you two boxes overlap. This is a NEW composition only; a tweak
inside an existing layout stays in the no-screenshot default above.

Either way, **say what you actually verified** - never just "done."
