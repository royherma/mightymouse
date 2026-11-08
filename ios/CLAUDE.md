# MightyMouse iOS

The iPhone app is a thin native shell around the phone remote web page. Read this before
editing any `.swift` file.

## Build and check

- The TypeScript checks do not compile Swift. After any change in `ios/`, build the
  `MightyMouse Dev` scheme for a simulator in Xcode.
- The `.xcodeproj` is hand-rolled: a new Swift file needs 4 manual `project.pbxproj` entries,
  or it compiles locally and fails the real build. Prefer adding code to an existing file.
- `MightyMouse Dev` (bundle id `com.mightymouse.ios.dev`) talks to a dev backend; `MightyMouse`
  Release talks to production. Simulator UI states: build with `-D MM_UI_STATE_<X>`.
- Debug builds can blank the launch screen through `__preview.dylib`. Check launch UI in a
  Release build.

## Who owns what

- Swift owns Keychain, Bonjour host candidates, haptics and QR scanning.
- Swift owns no connection state. Connection state in Swift is a bug.
- The WebView is the connection authority and reports `connState` on every change. The native
  bridge uses that message only to control the launch cover.
- Do not add a second pairing or socket state machine to Swift.
- Send Swift diagnostics to the Mac's log over the page's socket; a device log needs a cable.

## Platform facts that cost a day each

- Auto-PiP needs an active `AVAudioSession`; without one iOS declines with no delegate callback.
- `AVSampleBufferDisplayLayer` decodes H.264 itself; never write a `VTDecompressionSession`.
- `WKScriptMessage` carries no binary; bytes cross as base64, chunked at `0x8000`.
- `.defaultToSpeaker` is `.playAndRecord`-only; on `.playback` it blanks the mirror video.
- Both PiP paths run today: WebKit ejects to inline every trip, then native starts. Not a fault.
