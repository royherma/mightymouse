# Contributing to MightyMouse

Thanks for building with us. This page is the short version of how to get a change in.

## Set up

```sh
npm ci
npm run dev
```

You need a Mac and a current Node LTS release. Renderer edits (`src/renderer/`) hot reload. Edits in `src/main/` or `src/preload/` need the app restarted.

## Check your change before you open a PR

```sh
npm run typecheck:node
npm run typecheck:web
npm run lint
npm test
```

`npm run check` runs typecheck, lint and tests together. Typecheck is the fast one, run it as you go. If you touched `ios/`, build the iOS app in Xcode (simulator, no signing needed).

## Code rules

These are checked in review.

- **Write no comments by default.** If the code needs a sentence to be understood, rename the variable or split the function. One line is the maximum, and only for a trap someone could not guess from reading (a constant whose value matters, a call that must run before another).
- **Least code that solves it.** No speculative options, no abstraction for a second use that does not exist yet.
- **No magic strings.** A meaningful literal (a channel name, a mode, a key) lives in a constant or enum in `src/shared/`. See `docs/conventions.md`.
- **IPC changes touch four files together:** `src/shared/ipc.ts` (the `CHANNELS` constant), `src/main/ipc.ts` (the handler), `src/preload/index.ts` (the `window.api` method) and `src/preload/index.d.ts` (its type).
- **Reuse UI primitives.** Check the existing primitives and tokens before writing JSX. Do not add raw buttons or new one-off classes. See `docs/conventions.md` and `DESIGN.md`.
- **Extend the pattern that exists.** Look for how the codebase already does a thing and add to it. A change that fights the architecture is a sign to ask first.
- **Keep your diff to what you changed.** No drive-by rewording or reformatting of lines you did not need to touch.
- **User-facing text:** plain words, say what the person gets, hyphens not em dashes.

## How pull requests flow

Open your PR on this public repo. We review it here. When it is approved we merge it on our side and it shows up in the next sync, with your authorship. That means your PR may show as closed rather than merged for a short while before the sync lands.

## Good first areas

- Fixes in the phone remote web app (`src/main/phone-remote/`)
- Renderer polish: states with no words, dead ends, empty screens
- Native helpers in `native/`
- Support for another coding agent in `src/main/backend/adapters.ts` (one adapter per provider)
- Docs fixes and clearer error messages
- Android app improvements in `android/`

Not sure where to start? Open an issue and say what you want to build.

## Reporting bugs and security issues

Bugs and ideas: open an issue. Security problems: see [SECURITY.md](SECURITY.md), do not open a public issue.
