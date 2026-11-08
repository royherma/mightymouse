# MightyMouse - guide for coding agents

This file is for agents (and people) changing the MightyMouse code. Read it before editing.

MightyMouse is a macOS app that pairs with an iPhone or Android phone: voice typing, a trackpad and live screen on the phone, and coding agents that keep running on the computer and ask the phone for approval. Electron, Vite, React, TypeScript on the Mac, Swift on iOS, Kotlin on Android.

The product name is **MightyMouse**. "ShowAndTell" is an old folder name, never put it in UI or copy.

## Glossary

| Term | Meaning |
| --- | --- |
| Main | Electron main process, Node. `src/main/` |
| Preload | Context-isolated bridge that defines `window.api`. `src/preload/` |
| Renderer | The React UI, one entry per window. `src/renderer/src/` |
| Phone remote | HTTP and WebSocket server in the Mac app plus the web app served to the phone. `src/main/phone-remote/` |
| Backend / adapter | A coding-agent provider (Claude, Codex...) that the app spawns as a CLI. `src/main/backend/` |
| Relay | The channel between a running coding agent and the phone: notify, ask, approve, show. `docs/agent-relay.md` |
| `mightymouse-code` | The npm connector that lets any agent talk to the relay. `npm-shim/` |
| CHANNELS | The typed list of IPC channel names. `src/shared/ipc.ts` |

## Where code lives

| Area | What lives there |
| --- | --- |
| `src/main/backend/runner.ts` | The only place an LLM is invoked. Spawns the provider CLI. No HTTP or SDK calls. |
| `src/main/backend/adapters.ts` | `BACKENDS` registry, one adapter per provider. Add a provider by appending one adapter. |
| `src/main/platform/macos/` | `osascript` and native bridges: selection, window context, permissions. `resolve-binary.ts` finds a CLI at runtime, never hardcode binary paths. |
| `src/main/store/` | Settings (JSON), prefs (flat text), history (JSONL). See `docs/conventions.md`. |
| `src/main/capture/` | Screen recording, transcription, global hotkeys |
| `src/shared/` | Code used by both main and renderer: `config.ts`, `types.ts`, `ipc.ts`, `shortcuts.ts` |
| `src/preload/` | `index.ts` defines `window.api`, `index.d.ts` types it |
| `src/main/phone-remote/` | Phone remote. Read `docs/phone-remote-flows.md` first |
| `native/` | Swift and C helpers, built by `npm run build:helpers` |
| `ios/`, `android/` | The phone apps |

Read the source for hotkeys (`SHORTCUTS` in `src/shared/shortcuts.ts`) and per-provider behavior (`adapters.ts`) rather than trusting a copy in a doc.

## Ways to hurt yourself

- **Main and preload edits do not hot reload.** Only the renderer does. Restart the app after changing `src/main/` or `src/preload/`, or you are testing old code.
- **Preload and renderer are separate worlds** (`contextIsolation: true`). A global set in preload is invisible to the renderer. Pass values with `contextBridge.exposeInMainWorld` and read `window.*`.
- **Never read the history file directly.** It can be encrypted. Go through the history store.
- **Never spawn a provider binary by a hardcoded path.** Use `resolve-binary.ts`.
- **A phone remote edit needs the phone web app rebuilt** (`npm run build:phone-remote`). Restarting the Mac app alone does not rebuild it.
- **Do not add a second controller to the phone remote.** It allows one active controlling connection; a test client evicts the real phone.
- **No machine identifiers in labels users read** (pids, hex ids, uuids). Show the task title, the model name, the branch.
- **Do not edit files you were not asked to change**, even to reword a comment.

## Hit every surface

Before calling a UI change done, check each place it can show:

- Mac app windows
- The phone remote web app on a 390px wide screen
- The iPhone app and the Android app, if the screen is shared with them

Anything floating or fixed added to a shared screen must not cover a button, the composer or content. If it was not asked for on a surface, hide it there.

Adding an IPC call touches four files together: `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`.

## Working rules

- **Comments: zero by default.** Rename or split instead. A comment is one line, and only for a trap the code cannot show (a constant whose value is load-bearing, an ordering requirement). No JSDoc, no section banners, no narrating a change.
- **Least code that fully solves it.** No speculative abstraction, no dead options. Check whether the pattern exists before adding code, and extend it.
- **No magic strings.** Meaningful literals live in constants or enums in `src/shared/`.
- **Reuse UI primitives and tokens.** Check before writing JSX. No raw `<button>`, no one-off classes. Rules in `docs/conventions.md` and `DESIGN.md`.
- **New files need real logic** (about 80+ lines), otherwise the code belongs in its only consumer. A file already over about 1,500 lines gets a new module instead of more lines.
- **Do not write tests during feature work** unless a test is the fastest way to see your change work (a branchy pure function, or a bug with a known bad input). Never delete or weaken an existing test.
- **User-facing text:** plain words, say what the person gets, hyphens not em dashes, say "computer" not "Mac" unless it is a hard platform fact.

## Checks

```sh
npm run typecheck:node
npm run typecheck:web
npm run lint
npm test
```

Run typecheck as you go and the rest once at the end. If you touched `ios/`, compile it in Xcode for a simulator.

## Docs

| Doc | Read when |
| --- | --- |
| `DESIGN.md` | Adding or rearranging actions, designing a flow or a new window |
| `docs/conventions.md` | Writing code: constants, UI primitives, IPC, stores |
| `docs/subsystems.md` | Changing the LLM backend, history, startup order, window routing |
| `docs/agent-relay.md` | Anything touching `mightymouse-code`, `npm-shim/` or the relay |

Contributor flow: see `CONTRIBUTING.md`.
