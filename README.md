<p align="center">
  <img src=".github/assets/logo.png" width="88" alt="MightyMouse logo">
</p>

<h1 align="center">MightyMouse - Make your computer 100x more useful</h1>

<p align="center">
  Talk and it types. Your coding agents keep working while you're out.<br>
  Answer them, and drive the whole computer, from your phone.
</p>

<p align="center">
  <a href="https://getmightymouse.com"><img src="https://img.shields.io/badge/download-getmightymouse.com-e8642c?style=flat-square" alt="Download"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f7d4f?style=flat-square" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS-1f1f1f?style=flat-square&logo=apple" alt="Platform: macOS">
  <img src="https://img.shields.io/badge/phone-iPhone%20%7C%20Android-1f1f1f?style=flat-square" alt="Phone: iPhone and Android">
</p>

<p align="center">
  <a href="https://getmightymouse.com"><b>Download</b></a> &nbsp;·&nbsp;
  <a href="#how-it-compares"><b>vs T3 Code</b></a> &nbsp;·&nbsp;
  <a href="#coming-from-conductor"><b>Coming from Conductor?</b></a> &nbsp;·&nbsp;
  <a href="#run-it-yourself"><b>Run it yourself</b></a> &nbsp;·&nbsp;
  <a href="#for-builders"><b>Help build it</b></a>
</p>

<p align="center">
  <img src=".github/assets/hero.webp" width="900" alt="MightyMouse on the computer starting a coding agent in acme-shop, with the same agent asking a question on the phone beside it">
</p>

## Bring any AI, keep the plan you pay for

MightyMouse doesn't sell you a model. It runs the ones you already use, signed in with your own accounts, and you can switch any time.

| | Works with |
| --- | --- |
| **Coding agents** | Claude Code · Codex · Cursor · OpenCode |
| **Chat** | Claude · ChatGPT models through Codex · Gemini · any model on OpenRouter |
| **Offline, on your own computer** | Ollama · Rapid-MLX on Apple Silicon |

<p align="center">
  <img src=".github/assets/desktop-models.webp" width="720" alt="The model picker listing your Claude plan, your Codex plan, Gemini, Ollama, Rapid-MLX, OpenRouter and OpenCode">
</p>

Each one is a single adapter in [`src/main/backend/adapters.ts`](src/main/backend/adapters.ts), so the next one is a small pull request away.

## On your computer

<p align="center">
  <img src=".github/assets/desktop-code.webp" width="880" alt="A coding agent fixed a checkout bug: the conversation, the three changed files and a Merge button for pull request 128">
</p>

**One home for your coding agents.** Give each agent its own branch, run a few side by side, then review every changed line, open the pull request and merge without leaving the app.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src=".github/assets/desktop-dial.webp" alt="The model picker with Claude models and a thinking dial set to Medium">
      <h3>Pick the model and how hard it thinks</h3>
      <p>Choose Claude, Codex or OpenCode, then turn the dial from quick to deep. Switch on Plan first and nothing changes until you say go.</p>
    </td>
    <td width="50%" valign="top">
      <img src=".github/assets/desktop-agents.webp" alt="Ten coding agents running side by side across three projects, on Claude, Codex and Cursor">
      <h3>Every agent on one board</h3>
      <p>See which agents are working, which handed work back and which need you, across every project.</p>
    </td>
  </tr>
</table>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src=".github/assets/talk-and-it-types.webp" alt="Holding fn and talking types an email">
      <h3>Talk and it types</h3>
      <p>Hold <kbd>fn</kbd> and talk. Your words land where your cursor is, in any app. Speech turns into text on your own computer, so it is free and stays private.</p>
    </td>
    <td width="50%" valign="top">
      <img src=".github/assets/fix-any-words.webp" alt="Selected text rewritten warmer in place">
      <h3>Better words, right where you are</h3>
      <p>Select text in any app and tap a fix: shorter, cleaner, easier to read, or ask for anything. The new words replace the old ones in place.</p>
    </td>
  </tr>
</table>

## Agents that keep going while you're out

<table>
  <tr>
    <td width="50%" valign="top">
      <img src=".github/assets/answer-from-phone.webp" alt="An agent on the computer asks a question and the answer is tapped on a phone lock screen">
      <h3>Answer from the lock screen</h3>
      <p>An agent's question arrives with its choices as buttons. Tap one and the work keeps going. Approvals ask for Face ID first.</p>
    </td>
    <td width="50%" valign="top">
      <img src=".github/assets/computer-in-your-hand.webp" alt="A phone showing the computer's live screen with keys and a mic button">
      <h3>Your computer in your hand</h3>
      <p>Your phone shows your live screen and turns into a trackpad, a keyboard and a microphone. Fix a typo from the couch or check on an agent from the kitchen.</p>
    </td>
  </tr>
</table>

| You get | What it means |
| --- | --- |
| **Close the lid, work continues** | Turn it on and your computer stays awake with the lid shut, so busy agents keep going and your phone still reaches them. |
| **Everything waiting, in one stack** | Swipe through every agent that needs you, one card at a time. |
| **Undo to any message** | Put the files back to how they were before any earlier message. |
| **A dark screen for the room** | While you drive from your phone, the computer's own screen stays black to anyone nearby. |
| **Show it, don't explain it** | Tap for a screenshot or hold to record your screen and voice, and get the transcript. |

<p align="center">
  <img src=".github/assets/phone-trackpad.webp" width="260" alt="Phone trackpad with live screen">
  <img src=".github/assets/phone-keyboard.webp" width="260" alt="Full keyboard on the phone">
  <img src=".github/assets/phone-agents.webp" width="260" alt="Several agents running, seen from the phone">
</p>
<p align="center"><sub>Straight from the phone: trackpad, full keyboard, and a screen full of agents at work.</sub></p>

## How it compares

T3 Code puts your agent on your phone. MightyMouse puts the whole computer there, agent included.

| | MightyMouse | T3 Code |
| --- | :---: | :---: |
| Runs Claude Code, Codex, Cursor and OpenCode | ✅ | ✅ |
| Each agent on its own branch, changed files, pull request and merge | ✅ | ✅ |
| Undo the files back to an earlier message | ✅ | ✅ |
| iPhone and Android apps | ✅ | ✅ |
| Open source, MIT | ✅ | ✅ |
| Your computer's live screen, trackpad and keyboard on the phone | ✅ | ❌ |
| Voice typing into any app, free and on your own computer | ✅ | ❌ |

An editor gives you agents inside one window. A chat app gives you one company's models. MightyMouse gives you every agent you pay for, across the whole computer, and lets you leave the desk.

<sub>T3 Code checked against github.com/pingdotgg/t3code on 8 Nov 2026. Something out of date? Open an issue and we'll fix it.</sub>

## Coming from Conductor?

Bring your workspaces with you. MightyMouse finds the Conductor workspaces already on your computer and picks each one up in Claude Code, on its branch, with the end of the old chat so the agent knows where it stopped.

1. Download MightyMouse from [getmightymouse.com](https://getmightymouse.com) and open it.
2. Go to **Code**. Your workspaces are listed under **From Conductor**.
3. Click **Continue here** on any of them.

From there you get what you had, plus your phone: plan first and change nothing until you say go, and merge the pull request from your pocket.

## Run it yourself

You need a Mac and a current Node LTS release.

```sh
git clone https://github.com/royherma/mightymouse.git
cd mightymouse
npm ci
npm run dev
```

`npm run dev` starts the app with hot reload. Changes in `src/renderer/` show instantly. Changes in `src/main/` and `src/preload/` need the app restarted.

| To do this | Run |
| --- | --- |
| Make a production build | `npm run build` |
| Package the app | `npm run build:mac` |
| Rebuild the web app your phone loads | `npm run build:phone-remote` |
| Check types, lint and tests | `npm run typecheck` · `npm run lint` · `npm test` |

Apps you build yourself are not signed by Apple, so macOS asks you to confirm the first launch (right-click the app, then Open). The iPhone app lives in `ios/` (open it in Xcode) and the Android app in `android/` (open it in Android Studio).

### Free and paid

Everything that runs on your computer is free. Paid plans cover what runs on ours.

| | Free | Paid plans |
| --- | --- | --- |
| The app, voice typing, phone remote on Wi-Fi | ✅ Unlimited | ✅ Unlimited |
| Agents ask and you answer from your phone's lock screen | ✅ | ✅ |
| Coding agents and chat on your own Claude, Codex, Cursor, OpenCode, Gemini or OpenRouter account | ✅ Unlimited | ✅ Unlimited |
| Your computer from anywhere | ✅ Unlimited with your own Cloudflare Tunnel or Tailscale, or free minutes on ours | ✅ Ours, built in, unlimited |
| Our AI and cloud runs, no AI account of your own needed | ✅ A free weekly allowance | ✅ A bigger allowance, plus top-ups |

See [pricing](https://getmightymouse.com/pricing). Sign-in uses a free MightyMouse account.

**Your own tunnel.** The phone remote listens on port `17771`. Point any tunnel at it, open the address on your phone and approve the phone on your computer the first time:

```sh
cloudflared tunnel --url https://localhost:17771 --no-tls-verify
```

A quick tunnel gets a new address each run. A [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) keeps one. With Tailscale, open `https://<your computer's Tailscale name>:17771` on the phone.

## For builders

### How it fits together

```
  coding agent (Claude Code, Codex, Cursor, VS Code)
        │  MCP over stdio
        ▼
  npm-shim/mightymouse-code        a thin pipe, no tool logic
        │  HTTP on 127.0.0.1
        ▼
 ┌──────────────────────── Mac app (Electron) ────────────────────────┐
 │  src/main           hotkeys, capture, speech to text, the agent    │
 │                     relay (the real MCP server), backend/runner.ts │
 │                     spawns the agent CLIs                          │
 │  src/preload        the window.api bridge                          │
 │  src/renderer       React UI, one entry per window                 │
 │  src/main/phone-remote   HTTP + WebSocket server and phone web app │
 └──────────────────────────────────┬─────────────────────────────────┘
                                    │  Wi-Fi
            ┌───────────────────────┼───────────────────────┐
     iPhone app (ios/)      Android app (android/)     phone browser
```

### Where things live

| Folder | What it is |
| --- | --- |
| `src/main/` | Electron main process: hotkeys, capture, transcription, the agent relay |
| `src/main/backend/` | One adapter per AI provider. `runner.ts` is the only place a model is called |
| `src/renderer/` | The React UI, one entry per window |
| `src/main/phone-remote/` | The server your phone connects to, plus the React app it loads |
| `src/shared/` | Code both sides use: `config.ts`, `types.ts`, `ipc.ts`, `shortcuts.ts` |
| `npm-shim/mightymouse-code/` | The connector that lets any coding agent notify, ask and get approvals through the app |
| `native/` | Small Swift and C helpers: input, screen capture, accessibility, audio |
| `ios/`, `android/` | The phone apps (Swift and Kotlin) |

Read [AGENTS.md](AGENTS.md) first. Deeper dives: [docs/agent-relay.md](docs/agent-relay.md), [docs/relay-contract.md](docs/relay-contract.md), [docs/phone-remote-flows.md](docs/phone-remote-flows.md), [docs/subsystems.md](docs/subsystems.md), [docs/conventions.md](docs/conventions.md) and [DESIGN.md](DESIGN.md).

### Good first areas to help

- **Bring another coding agent.** Each one is a single adapter in `src/main/backend/adapters.ts`.
- **Teach agents a new trick.** The tools an agent can call (`notify`, `ask`, `approve`, `show`) live in `src/main/agent-relay/mcp/verbs.ts`. Start with [docs/agent-relay.md](docs/agent-relay.md).
- **Make the phone feel better.** Trackpad, keys and the swipe stack are React in `src/main/phone-remote/react/`.
- **Faster, sharper speech to text.** The engines are wired in `src/main/capture/whisper.ts`.
- **Native screens on Android.** The Android app pairs by QR code and loads the same phone remote as the browser. The iPhone app goes further with native lock-screen answers; bringing those to Android is open.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). If you code with an agent, point it at [AGENTS.md](AGENTS.md). Found a security issue? See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
