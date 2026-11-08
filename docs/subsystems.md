# Subsystems - backend, history recall, encryption, startup

Detail for the four subsystems whose *behavior* isn't obvious from reading their entry file.
Read the relevant section here before changing one.

---

## LLM backend

- Chosen by `PREFS.getBackend()`. Default `CONFIG.DEFAULT_BACKEND`.
- All modes (rewrite / ask / act) honor the pref. Per-backend command-building lives in the
  adapter (`adapters.ts`), not in `runner.ts`.
- Binaries resolve at runtime (`platform/macos/resolve-binary.ts`); `*_PATH` in `config.ts` are optional
  overrides, empty by default.
- **Add a provider by appending one adapter to `BACKENDS`.** No `if (backend === ...)` branches
  anywhere - `BackendId` derives from the registry keys.
- `runner.ts` is the ONLY place an LLM is invoked. Spawns via `CONFIG.SHELL -c`. No HTTP/SDK.

---

## History recall - "what did I ask yesterday?"

The user can ask about their OWN past activity and get an answer from `rewrite-history.jsonl`.
Flow lives in `ipc.ts` `resolveRecall()`, called in the `submit` handler before the normal run:

1. **`mightBeRecall(instr)`** (`recall-classifier.ts`) - free synchronous keyword gate. Skips
   ~98% of queries with zero cost.
2. If the gate passes AND backend is `mightymouse` → **`classifyRecallIntent()`** fires ONE fast
   Haiku call through `llm-proxy` (`feature:'recall_classify'`) for a structured
   `{intent, dateWindow, semanticQuery}`. Free `claude`/`codex` backends have no Haiku path, so
   they fall back to **`parseDateRange()`** (`history-date-parser.ts`, pure regex). **This fork
   is intentional.**
3. Retrieve via `HISTORY.readByDate()` / `HISTORY.searchText()` (warm-cached), serialize with
   `assembleHistoryRecall()` (`context-memory.ts`, 6000-char budget), answer as an `ask` with the
   recall blob as `memoryBlob` and `CONFIG.SYSTEM_PROMPT_RECALL`.

Any classify failure degrades to a normal ask - never a crash.

**Upgrade seam:** at ~20k rows swap the JSONL scan in `history.ts` for sqlite FTS5 or shell out
to qmd; the `HISTORY` interface stays put, callers untouched. To add more memory tools (search
screenshots, summarize a period), extend the `RecallIntent` union + one dispatch branch - don't
build a tool-call protocol until 3-4+ tools.

---

## History encryption at rest (toggleable)

Off by default (dev). Toggle in Settings → `PREFS.getHistoryEncryption()`. `safe-storage.ts`
wraps Electron `safeStorage` (Keychain, no dep); each line is a `{"v":1,"d":"<b64>"}` envelope,
legacy plaintext reads transparently, a decrypt failure (wrong machine) skips the row, never
crashes.

`reconcileHistoryEncryption()` (run at startup + on toggle) **backs up to `backups/` BEFORE**
any convert, transforms, then atomic-renames - the original is never mutated destructively,
unreadable rows are kept verbatim.

The auth JWT (`supabase.ts` `fsStorage`) is **ALWAYS** encrypted (higher value than history).

**Hard rule: never read `rewrite-history.jsonl` directly - go through `HISTORY.*`**, or you'll
read ciphertext when the toggle is on (`buildAnalyticsData` learned this).

---

## Startup sequence (`index.ts`, `app.whenReady`)

`registerIpcHandlers()` → register hotkeys (one uiohook watcher for all) → restore persistent
overlays/toggles from PREFS (e.g. cursor companion).

---

## Live companion - the screen-control gate

A live turn (voice or Stage's typed bar) runs through `runCompanionAskTurn` →
`runMighty`, and whether that turn can DRIVE the Mac is one flag: `screenControl`. It
selects `SYSTEM_PROMPT_ACT_SCREEN` (the mm-input verb list) at
`src/main/backend/prompts.ts:331`, where `{{BIN}}` / `{{UIBIN}}` / `{{SHOTBIN}}` are
replaced with real absolute binary paths. Off, the same turn is chat that can only
look; on, it clicks and types.

Every tool call the run makes comes back as a `step` stage event
(`src/shared/act-step-label.ts` turns a `RunEvent` into `click 812,340`), which is what
Stage draws. Screenshots the agent takes carry `imagePath`; the renderer turns that into
a URL with `window.api.mediaUrl()`.

## Windows are routed by query param

`main.tsx` reads `?window=` and mounts the matching `XApp.tsx` (`panel` is the default). To add
a window: new `XApp.tsx` + a branch in `main.tsx` + a `BrowserWindow` loader that appends
`?window=x`. Current routes live in `main.tsx` - read them there.

---

## Dev vs prod - use `src/shared/env.ts`, never raw `is.dev`

`src/shared/env.ts` is the SINGLE SOURCE OF TRUTH for environment. Import from it instead of
sprinkling `is.dev` / `process.env.NODE_ENV` / `app.isPackaged` around (those have shipped
dev-only surfaces to prod before).

- `IS_DEV` / `IS_PROD` - booleans, safe to import from main OR renderer.
- `devOnly(fn)` - run a side effect only in dev (e.g. a debug tray entry). The Component
  Playground tray item is gated this way.
- `devLog.log` / `devLog.warn` - silent in prod. `devLog.error` always surfaces (never swallow a
  real failure).
- `pickByEnv(dev, prod)` - pick a value by environment.

---

## Quality gate

- **Lint is NOT in the blocking gate yet** - the repo carries pre-existing eslint debt. Lint gets
  promoted once that debt is cleared.
- `noImplicitAny` is on in both tsconfigs. Keep it that way.

