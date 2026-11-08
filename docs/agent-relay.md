# Agent relay + `mightymouse-code` MCP - the mental model

> Read this before touching `npm-shim/`, `src/main/agent-relay/`, the iOS NSE, or anything
> that publishes the npm package. This file is how the machine actually works and how to
> test/ship it.

## The one line

**The npm package is a dumb pipe. The Electron app IS the MCP server.**

Everyone's first wrong mental model is "we shipped an MCP server to npm". We did not. We
shipped a ~260-line stdio↔HTTP proxy that holds zero tool logic. Every verb - `notify`,
`ask`, `approve`, `show`, `recap`, `relay_pending`, `relay_resolve` - is registered and
executed inside the running Mac app. No app running, no tools.

**Any verb can carry a picture.** `notify`, `ask`, `approve` and `show` all take `capture: true`
(screenshot the Mac now) or `image_path` (a file already on this Mac); all three render surfaces
are verb-agnostic. Captures are JPG capped at a 1600px long edge (`SCREENSHOT_MAX_EDGE`), because
the iOS extension pulls the file inside a hard ~30s budget. On a failed image `ask`/`approve`
error out (the question is *about* the picture) while `notify` degrades to a text-only card and
says so in its tool result.

## The path, end to end

```
 agent (Claude Code / Codex / Cursor / VS Code)
   │  stdio
   ▼
 npx mightymouse-code                          npm-shim/mightymouse-code/bin/mightymouse-code.js
   │  proxies listTools/callTool. Adds x-mightymouse-from + x-mightymouse-cwd headers.
   │  Also holds a long-lived GET /presence socket so the Mac knows the terminal is alive.
   │  HTTP POST 127.0.0.1:17781/mcp
   ▼
 ELECTRON MAIN - the real McpServer            src/main/agent-relay/mcp/build-server.ts
   │  1. relayOffGuard()          verbs.ts:73     Settings toggle off ⇒ fail fast, no store write
   │  2. relayRequestStore.mint() store.ts:113    IN-MEMORY Map. Plus append-only audit log.
   │  3. sendRelayPush()          relay-send.ts:56
   │  4. await awaitResolution()  verbs.ts:81     BLOCKS the HTTP response on an EventEmitter
   │
   │  POST <EDGE_FUNCTION_URL>/agent-relay-push   ← the ONLY cloud hop
   ▼
 SUPABASE EDGE FN  ← the APNs .p8 key lives ONLY here, never on the Mac
   │
   ▼
 APNs → iPhone: push = requestId + a ≤300-char preview of the question/action (relay-send.ts bodyFor)
   │
   │  NSE wakes: MightyMouseNSE/NotificationService.swift:31-48
   │  GET 17771/relay-request?requestId=&credential=   ← fetches the REAL question text
   │       handled by src/main/phone-remote/server.ts:1293
   ▼
 you answer on the lock screen (or the phone-remote "Code" sheet)
   │  POST 17771/relay-respond  → relayRequestStore.resolve()  store.ts:173  (first answer wins)
   ▼
 the 'changed' event fires → awaitResolution unblocks → the HTTP response finally returns
   → the shim hands it back over stdio → the agent's tool call returns
```

`ask` and `approve` block for real. That is not a bug - the agent is genuinely parked until
you answer or the timeout fires. `notify` returns immediately.

## `recap` - the one verb that is not a request

The other four verbs mint a card someone has to see. `recap` writes one line onto the
session's own row and stops: no card, no push, no notification, nothing to answer.

It exists because every other field on a session says WHICH session it is - repo, branch,
model, slug - and with six panes open on one checkout those are all identical. `recap` is
the only field that says what it is ABOUT.

Three rules, each with a reason you will otherwise trip over:

- **It overwrites, deliberately.** `nameAgentSession` refuses to overwrite (a name is claimed
  once and defended); `recap` is the opposite, because a subject changes every time the work
  does. `__tests__/session-tldr.test.ts` guards that difference - a future refactor "fixing"
  the overwrite would freeze every row on its first topic.
- **It is per-session, not per-request.** Not to be confused with `notify`'s `last`, which
  recaps one finished request and dies with it. Different writer, different lifetime.
- **It needs a session id**, off `x-mightymouse-session`. Without one no row can be meant, so
  the call is refused rather than applied to the whole checkout.

Survives an app restart via `~/.claude/.session-tldr/<id>` (`mcp/session-tldr-file.ts`),
which the shim reads back into the facts header on its next connect - same convention as the
naming hook's `.session-names/<id>`, and for the same reason: the agent has no way to know
the Mac app was relaunched, so nothing would ever say it again.

## Two ports, two completely different auth models

This is the single most confusing thing here, so hold it explicitly:

| Port | What | Auth |
|---|---|---|
| **17781** | MCP. Shim → app. | **NONE.** Loopback address check only (`http-listener.ts:205`). Any local process can claim any `from` name - `store.ts:43` calls it "a LABEL, never a credential." |
| **17771** | Phone-remote HTTP+WS. Also serves `/relay-request`, `/relay-image`, `/relay-respond`. | **Real.** Device credential minted by `POST /pair`, stored in the iOS Keychain via the App Group, validated on every call. |

They are separate legs of the same journey. Fixing auth on one tells you nothing about the
other. 17781 is unauthenticated *deliberately* - it is loopback-only, and requiring a token
would mean provisioning one into every agent's MCP config.

Port constants live in `CONFIG.AGENT_RELAY` (`src/shared/config.ts`), and the shim hardcodes
copies of them - see the port-lock trap below.

## Testing protocol - you do NOT need a phone

**`MM_RELAY_LOOPBACK_PUSH=1`** short-circuits APNs (`relay-send.ts:39-54`): a "push" prints to
your terminal instead of leaving the machine. The whole notify → answer → unblock loop runs
with the phone powered off.

Drive the verbs by pointing any MCP client at `127.0.0.1:17781/mcp` (see "Hooking it up to an
agent" below), and answer through `/relay-request` + `/relay-respond`, the same surfaces the
shipped product uses.

### Automated coverage

11 vitest files, all TypeScript side:

```
src/main/agent-relay/__tests__/            store · mcp-clients · relay-send
src/main/agent-relay/mcp/__tests__/        ask-approve-show · notify-handler · presence
                                           session-naming · tooling-tools · shim-port-lock
src/shared/__tests__/relay-cards.test.ts
src/renderer/src/components/__tests__/relay-status.test.ts
src/main/phone-remote/react/__tests__/relay-harness-strings.test.ts
```

**Zero Swift tests.** `ios/MightyMouseTests/` has only `PairingURLTests.swift`, unrelated.
`NotificationService.swift`, `MacRelayClient.swift`, and `RelayNotificationCategory.swift`
are covered by nothing.

## The trap: the shim hardcodes CONFIG values

The shim ships outside the build, so it cannot import `CONFIG`. It hardcodes `127.0.0.1`,
`17781`, `/mcp`, and the identity header names.

**Changing `CONFIG.AGENT_RELAY` without republishing the package silently breaks
`npx mightymouse-code` for everyone who already installed it.**

`shim-port-lock.test.ts` asserts the two copies match. A failure there means, in order:
update the shim → bump its `package.json` version → publish it → *then* land the config
change. Not the other way around.

## Hooking it up to an agent

`src/main/agent-relay/mcp-clients.ts` detects installed clients and writes the config for
them - this is the in-app Settings "Set up for me" button, IPC-wired at
`agent-relay.ts:136-142`.

| Client | File it writes | Shape |
|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers` key |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` key |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` | `servers` key |
| Codex | `~/.codex/config.toml` | appends `[mcp_servers.mightymouse-code]` |

The entry it writes is `{"command": "npx", "args": ["-y", "mightymouse-code"]}`.

**Dev machines are usually different.** A dev `~/.claude.json` often points `command: "node"` at the
repo's local shim path directly, so edits to `npm-shim/` take effect on restart with no
publish. If you are debugging "my change didn't apply", check which of the two you are on.

The shim can also be skipped entirely - an agent pointed straight at `127.0.0.1:17781/mcp`
gets identical behavior, minus the `from`/`cwd` identity headers.

## How do we know the flow is smooth - and how do we catch it breaking

### What instrumentation exists

Two analytics events, both about *setup*, neither about *use*:

| Event | Fires when | File |
|---|---|---|
| `setting_toggled{key:'agent_relay'}` | Someone flips the relay toggle | `src/main/ipc/agent-relay.ts:94` |
| `setting_toggled{key:'agent_relay_client'}` | Someone clicks "Set up for me" | `src/main/ipc/agent-relay.ts:140` |

That is the entire list. **No verb call, resolution, timeout, or failure emits anything.**

So the only question we can answer is "did anyone turn it on." We cannot answer any of the
ones that decide whether this feature is good:

- Did the push actually reach the phone?
- Did the phone render real content, or a bare title? (the unproven NSE path)
- Did the human answer, or did the agent sit there until timeout?
- **How long did the agent block?** - the single number that says "smooth" or "painful"
- Did the same person use it twice? (the only real signal of value)
- When it broke, where did it break?

### The one thing we do have: the audit log

`store.ts:102` appends every mint and every resolve to `PATHS.AGENT_RELAY_LOG` as JSONL.
It is local-only, per-machine, never uploaded. On your own Mac it is the forensic record  - 
the store holds live state, the log holds history. On a user's machine it is
invisible to us.

### The gaps, in priority order

1. **No latency measurement.** Mint timestamp and resolve timestamp both exist in the store;
   nothing computes or reports the delta. This is the cheapest, highest-value fix: emit
   `relay_resolved{verb, seconds, via}` and you immediately know whether the flow is smooth.
2. **No failure telemetry.** A timeout, a push that never lands, an NSE fetch that 404s  - 
   all silent. A suppressed failure leaves no trace.
   A relay that quietly stops working looks identical to a relay nobody uses.
3. **No delivery confirmation.** The Mac fires at Supabase and assumes. Nothing reports back
   that APNs accepted it, that the NSE woke, or that content was fetched. The NSE hitting
   `GET /relay-request` is the natural checkpoint - the Mac *already sees that request* and
   could log it as proof of delivery. That single line would have caught the untested-NSE
   problem months earlier.
4. **No retention view.** `agent_relay` toggled-on counts tell you about installs, not use.
   A zero here would be genuinely ambiguous
   between "broken" and "nobody wants it" - and we'd have no way to tell them apart.

### What "smooth" should mean, concretely

Before adding instrumentation, agree the target so the numbers mean something:

- **notify** - fire and forget, agent never blocks. Success = push visible on the lock screen.
- **ask / approve** - the agent blocks. Smooth = you answer from the lock screen without
  unlocking, without opening the app, in seconds. Any flow that requires opening MightyMouse
  to answer has already failed the promise.
- **The failure mode that matters most** is the silent one: agent blocked, no push arrived,
  human has no idea anything is waiting. That is worse than the feature not existing, because
  it stalls the agent. A timeout with a clear "nobody answered" is the acceptable floor.

### Cheapest path to actually measuring it

Order of work:

1. Emit `relay_request_sent{verb}` at mint and `relay_request_resolved{verb, seconds, via}`
   at resolve - both already have the data in hand at `store.ts:113` / `store.ts:173`.
2. Emit `relay_request_timeout{verb, seconds}` on the timeout branch.
3. Log the NSE's `GET /relay-request` hit at `server.ts:1293` as delivery proof.

Until 1-3 exist, any claim about whether the relay works for real users is a guess.

## Where things live

| Need | File |
|---|---|
| Tool registration | `src/main/agent-relay/mcp/build-server.ts` |
| Verb handlers | `src/main/agent-relay/mcp/verbs.ts` |
| HTTP transport / port bind | `src/main/agent-relay/mcp/http-listener.ts` |
| Session subject, across restarts | `src/main/agent-relay/mcp/session-tldr-file.ts` |
| Request lifecycle, mint/resolve | `src/main/agent-relay/store.ts` |
| Push → Supabase → APNs | `src/main/agent-relay/relay-send.ts` |
| MCP client config writing | `src/main/agent-relay/mcp-clients.ts` |
| Phone-side HTTP handlers | `src/main/phone-remote/server.ts` (`/relay-request`, `/relay-respond`) |
| iOS NSE | `ios/MightyMouseNSE/NotificationService.swift` |
| iOS relay HTTP client | `ios/MightyMouse/MacRelayClient.swift` |
| The published proxy | `npm-shim/mightymouse-code/bin/mightymouse-code.js` |
| Ports/constants | `CONFIG.AGENT_RELAY` in `src/shared/config.ts` |
