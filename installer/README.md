# installer/ - thin-stub first-install prototype

**Prototype only - unsigned, not wired into CI.** See "What's NOT done" below for what's
left before this ships.

## What this is

A minimal SwiftUI macOS app (`MightyMouseInstaller`) that mirrors the `native/`
Pattern B convention (hand-compiled Swift, no Xcode project checked in) but produces
a real windowed `.app` bundle instead of a CLI helper, since a stub installer needs
a UI. Launch flow:

1. Show a branded window (dark bg matching `MouseGlyph`'s own fill colors, orange
   accent from `THEME_TOKENS.accent`) with the mouse glyph + progress bar.
2. Download `mightymouse.dmg` from the public releases repo via `URLSession`,
   reporting progress on the bar.
3. Mount the dmg, copy `MightyMouse.app` to `/Applications`, unmount, launch it.
4. Quit.

## Why SwiftUI app bundle, not another Electron shell

- Binary size: a Swift/AppKit app is single-digit MB; a second Electron shell would
  drag in another ~150MB Chromium+Node runtime just to show a progress bar - directly
  contradicts the whole point of a *thin* stub.
- Faster to code-sign/notarize (one small Mach-O + minimal frameworks vs. an entire
  Electron app structure).
- No new dependency surface (no second `package.json`/`node_modules`).

## Build

```sh
cd installer/MightyMouseInstaller
bash build.sh
open build/MightyMouseInstaller.app
```

Requires Xcode Command Line Tools (`swiftc` in PATH) - same requirement as `native/`.

## Gatekeeper research verdict

**Not a blocker.** Notarization is a static, submission-time malware scan of the
signed binary - it does not monitor runtime behavior. Apple's docs describe scanning
"what exists at submission time, not what an app may retrieve after launch."
Sparkle (the standard macOS auto-update framework, used by hundreds of shipped
Developer ID apps) does this exact download-then-install shape today with no
notarization issues. No forum/doc evidence found of Apple rejecting or Gatekeeper
flagging an app specifically for downloading + installing another app.

**Caveat:** zero of 7 major macOS apps checked (1Password, Notion, Slack, Figma,
Dropbox, Chrome, Docker Desktop) actually ship a thin-stub *first-install* installer
on macOS - they all link the full dmg directly. Chrome's stub installer exists but is
Windows-only. So there's no macOS UX precedent for the *pattern*, only for the
underlying *mechanism* (download + install another signed app, which Sparkle proves
is fine). This is a UX/convention gap, not a Gatekeeper risk.

## What's NOT done (required before ship)

- [ ] Real code signing + notarization
- [ ] Entitlements file (network client, no sandbox or scoped sandbox for
      `/Applications` write - needs testing against actual Gatekeeper, not just docs)
- [ ] Retry/resume UX for interrupted downloads
- [ ] Checksum/signature verification of the downloaded dmg before mount (currently
      relies on the dmg's own code signature + Gatekeeper quarantine check on open)
- [ ] CI build/sign/notarize step
- [ ] `electron-builder.yml` or standalone packaging config to produce a distributable
      `.app` (currently just a raw build output, no `Info.plist` versioning/icon baked
      into a release artifact)
- [ ] Real end-to-end test: fresh Mac, download stub, run, confirm MightyMouse installs
      and launches
