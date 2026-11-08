# MightyMouse iOS App Store shell

This is the native iOS host for the existing Phone Remote React bundle. The
WebView owns the UI and websocket protocol; Swift supplies capabilities that a
Safari/PWA host cannot provide:

- Bonjour discovery and self-signed LAN certificate handling
- Keychain credentials
- native haptics during touch movement
- Siri/App Intents
- native email OTP sign-in and solo onboarding

## Build

Open `MightyMouse.xcodeproj` in Xcode 26, select a development team, and build
the `MightyMouse` target for a device. The app expects the Mac's Phone Remote
server to advertise `_https._tcp.` as `MightyMouse Remote`.

### Two schemes

Pick one from the scheme dropdown in the toolbar; that is the whole switch. They
differ in identity as well as backend, so a dev build installs *beside* the
TestFlight/App Store copy instead of replacing it -- both live on the phone at
once, with separate storage and Keychain.

| | MightyMouse Dev | MightyMouse |
|---|---|---|
| Configuration | Debug | Release |
| Bundle id | `com.mightymouse.ios.dev` | `com.mightymouse.ios` |
| Home screen | MightyMouse Dev, amber icon | MightyMouse, dark icon |
| Supabase | staging | prod |

Every action in each scheme -- run, profile, analyze, archive -- is pinned to
that one configuration, so a selected scheme cannot build the other app's
identity. **Archive from `MightyMouse` when shipping**; archiving the Dev scheme
produces the dev bundle id, which the App Store will reject.

On the command line the scheme carries the configuration, so no extra flag:
`xcodebuild -scheme "MightyMouse Dev" ...`.

The dev icon is generated, not hand-drawn -- rerun after any change to
`AppIcon-1024.png` so the two never drift apart:

```sh
python3 scripts/gen-ios-dev-icon.py
```

`AppConfig.stagingTestAdmin` reads an `MMStagingTestPassword` Info.plist key
that is deliberately not checked in, so the Debug test-admin bypass is absent
until you add the key plus a matching build setting locally. That is the safe
default -- see the comment on that property for why there is no literal
fallback.

The app is intentionally not connected to the Electron build. The web bundle
continues to build with `npm run build:phone-remote` and is served by the Mac.
