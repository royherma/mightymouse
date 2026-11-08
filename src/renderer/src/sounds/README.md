# UI sound effects

These play at capture/action moments. The current files are **generated placeholder tones** — replace them with real sounds by dropping a file with the exact same name. No code change needed (filenames are the contract).

| File | Fires when | Intended feel |
|---|---|---|
| `screenshot.wav` | Screenshot captured | Quick camera-shutter snap, very short (<200ms) |
| `record-start.wav` | Recording begins | Soft rising "pop"/blip, signals "live now" |
| `record-stop.wav` | Recording stopped + saved | Gentle descending chime, "wrapped up" |
| `done.wav` | Transcription finished | Light "ding"/tick, neutral completion |
| `success.wav` | Rewrite / Ask / Act succeeded | Bright positive flourish ("Hero"-like) |
| `error.wav` | Any failure | Low dull "thunk"/buzz ("Basso"-like) |
| `thinking.wav` | Suggestion shortcut recognized (⌘⌥⇧S) | Soft rising two-note chime, "got it, generating" |

## Format

- `.wav` (broadest support, no decode lag on play)
- Mono, 44.1kHz
- Short (< 1s), with a tiny fade in/out to avoid clicks
- Normalized so all six sit at a similar loudness

## How it's wired

Playback is cross-platform: a hidden persistent renderer window (`SoundApp.tsx`) preloads these via Vite asset imports and plays them through the Web `Audio()` API on IPC from the main process. No `afplay` / native deps, so it works on Mac + Windows. Muting is the "Sound effects" toggle in Settings (`~/MightyMouse/sound-enabled.txt`).
