# Agent-relay notification contract

The full path from "an agent wants to notify or ask a human" to "the human's answer is typed
back into the terminal that asked." Three agents each shipped locally-correct changes to pieces
of this loop and breakage landed in the seams none of them owned - most recently the `notify`
`--state waiting` incident: a zod enum was narrowed in-repo, every in-repo caller
was updated, the gate went green, and an out-of-repo bash hook kept sending the removed
value, silently, for hours. This doc exists so the next change can see the whole chain before
narrowing anything.

Companion doc: `docs/agent-relay.md` (architecture, ports). This doc is the hop-by-hop
contract; read that one for *why* the system is shaped this way.

## The two verbs, in one line each

- **`notify`** - a fire-and-forget announcement. Settles and closes the instant it's sent
  (`store.ts:227`, `this.settle(request.id, {}, null, null)` runs inline inside `mint()`);
  nothing tappable ever reaches the sender; `state` is `done|progress` **only**, by design  - 
  a notify is delivered and closed on send, so it can never truthfully say a human is needed
  (`STATE_HINT`, `verbs.ts:90-96`). Use it for "I finished" / "still working."
- **`ask`** - carries up to 4 options (`verbs.ts:291`, zod `.max(4)`), blocks the calling
  tool call open server-side via `awaitResolution()` (`verbs.ts:191-210`) until the phone
  (or terminal picker) resolves it, renders as tappable chips, and
  the answer gets typed back into the terminal that asked. Use it when the agent needs a real
  decision or a piece of text back.

(`approve` and `show` are the other two verbs, same blocking shape as `ask`; not part
of the traced chain below.)

## The hop table

| # | Hop | Crosses | Owning file | What the receiving side requires |
|---|---|---|---|---|
| 1 | An agent hook fires (e.g. a Claude Code `Notification` hook) | Claude Code → bash, **outside this repo** | the caller's own hook script | the hook filters on `notification_type` (e.g. `permission_prompt\|idle_prompt\|agent_needs_input\|elicitation_dialog`) and exits 0 silently on everything else |
| 2 | Hook decides notify vs. ask by reading the transcript | bash → any script | the caller's own hook script | a full-file JSONL scan (not tail-only - tail misses pending asks on files >1MB); finds the last `tool_use` whose id never appears as a `tool_result.tool_use_id` |
| 3 | Hook calls the MCP endpoint | bash → untyped caller, no TS, no schema check | the caller's own script | the JSON-RPC POST needs `Accept: application/json, text/event-stream` (a bare `Accept: application/json` 406s) and an `x-mightymouse-origin` header naming the terminal pane |
| 4 | Caller POSTs JSON-RPC over loopback | process → HTTP, localhost only | `src/main/agent-relay/mcp/http-listener.ts` | POST to `MCP_ROUTE` on port 17781 (`CONFIG.AGENT_RELAY.MCP_PORT`); non-loopback remote address gets a 403 even though the socket is already bound 127.0.0.1-only (`http-listener.ts:328-332`) |
| 5 | Listener builds a fresh `McpServer`, dispatches to the verb handler | HTTP → zod-validated tool call | `src/main/agent-relay/mcp/verbs.ts` | input matching the verb's zod `inputSchema` - **this is the only compiler/runtime-checked boundary in the whole chain**; anything upstream (hook, script) that drifts from this schema fails here, at request time, with a JSON-RPC error |
| 6 | Handler mints/settles the request | in-process | `src/main/agent-relay/store.ts` | `RELAY_NOTIFY_STATES = ['done', 'progress']` (`store.ts:40`) - zod **rejects** anything else, it does not map to a neighbor; `mint()` writes an audit `'created'` row (except notify, which self-settles and writes `'sent'` instead) |
| 7 | Store pushes to the phone | process → cloud (Supabase Edge Fn) → APNs | `src/main/agent-relay/relay-send.ts` | a registered push-capable device (`pushableDevice()`); the push body is a **fixed, verb-agnostic shape** - see below, this is the field that was assumed and is now confirmed |
| 8 | Phone (NSE or app) fetches the full card | HTTPS over LAN/tunnel, credential-gated | `src/main/phone-remote/server.ts` `handleRelayRequest` (`:1293-1351`) | a valid device credential (`?credential=`, 401 if not) and a live, unexpired `requestId` (404 if not); a successful GET here is the ONLY thing that calls `markFetched()` (`:1349`), i.e. the only proof of delivery |
| 9 | User answers; answer flows back and gets typed into the terminal | HTTPS → store → `AgentSession` addressing → tmux/CGEvent | `src/main/phone-remote/server.ts` `handleRelayRespond` (`:1462-1550+`) → `src/main/ipc/agent-relay.ts:241-266` → `src/main/agent-relay/picker-keys.ts` | `handleRelayRespond` requires the same device credential; `sendPickerAnswer()` requires `origin.tmuxPane` for the reliable path, else falls back to CGEvent-on-frontmost-window |

## The seams - the load-bearing section

Every place below crosses a language or process boundary with no compiler and no test watching
it. For each: what breaks, and how it would show up.

| Seam | What breaks | How it shows up |
|---|---|---|
| **Out-of-repo hooks vs. the zod schemas in `verbs.ts`** | A hook hardcodes verb/flag names as string literals in its notify/ask calls. Narrowing or renaming a zod field in-repo does not touch it - it lives outside the repo and outside the typecheck entirely. This is the exact incident: `RELAY_NOTIFY_STATES` was narrowed to `done\|progress` in `store.ts`, every in-repo caller was fixed, the gate was green, and a hook kept sending `--state waiting`. | **Silently.** The hook redirected its notify call to `/dev/null` (`>/dev/null 2>&1`). The relay rejected every one of these with JSON-RPC -32602 for hours with zero visible signal. |
| **Push payload vs. fetched card** | `sendRelayPush()`'s body (`relay-send.ts:107-128`) is `{deviceToken, requestId, verb, title, body, from, level, test, bundleId}` - **`options` is never included.** Confirmed by direct read, not assumed. A client that renders tappable chips straight from the push (skipping the `GET /relay-request` fetch) will show a title/body with zero buttons, because the array simply isn't there to render. | Silently, from the push alone - no error, just a card with text and no chips until/unless the fetch succeeds. |
| **Content text rides the push as a fallback** | `bodyFor()` (`relay-send.ts:219-234`) fills `body` for **every** verb, not just notify: `ask`→`params.question`, `approve`→`[action, detail].join(' - ')`, `show`→`params.caption`, each `.slice(0,300)`. The comment states why: "the NSE's tunnel fetch failed often enough that ask/approve/show arrived as a bare title with no message." So **content text rides the push for all four verbs; only the `options` array still requires the fetch.** | Not a failure mode - the push alone is a real fallback UI. |
| **The two keystroke transports in `picker-keys.ts` do not share a key vocabulary** | `keysFor()` (`picker-keys.ts:92-95`): tmux takes `['Down', 'Enter']`; CGEvent takes `['down', 'return']`. Swapping which set goes to which transport, or adding a third transport with a third vocabulary, is not type-checked - both are plain string arrays. | **Silently, and worse than a no-op**: the file's own comment states it plainly - `tmux send-keys … return` (wrong casing) types the literal word "return" into the pane and exits 0. No exception, no log line, just wrong text landing in the terminal. |
| **CGEvent fallback cannot read the screen** | `sendPickerAnswer()` refuses free-text answers outright on the CGEvent path (`picker-keys.ts:146-152`) because, unlike tmux's `capture-pane`, it has no way to confirm Claude Code's "Type something." row is actually drawn before blindly sending keys at it. | Loud, by design - logs `'no tmux pane to read - free-text answers need one'` and returns `'skipped'` rather than typing into the wrong place. This is the one seam in the table that fails safe. |
| **Origin addressing depends on env vars surviving two process hops** | The caller derives `x-mightymouse-origin` from `TMUX_PANE`/`CMUX_*` in its own environment, which it only has if the hook's backgrounded subshell inherits the parent shell's env. Any wrapper that clears env before exec (a different shell, a sandboxed re-exec) breaks pane-targeting with no schema to catch it. | Falls back to CGEvent-on-frontmost-window (hop 9's fallback path) - wrong pane gets the keystrokes if another window is frontmost, no error. |

## Rules for changing this loop

- **Narrowing or renaming a `notify`/`ask`/`approve`/`show` zod field in `verbs.ts` requires
  grepping every out-of-repo caller (agent hooks such as `~/.claude/hooks/`) for every flag name
  being removed or renamed**, before merging - those files are outside the typecheck and outside
  this repo's search entirely.
- **A new seam (new out-of-repo caller, new transport, new payload field) needs a contract
  test**, following the shape of the existing tests already locking pieces of this chain
  (`src/shared/__tests__/phone-remote-protocol.test.ts`'s "two copies must not diverge" pattern
  is the closest existing analog; there is currently no test pinning the bash-hook-to-zod-schema
  seam specifically - that gap is exactly how the `--state waiting` incident shipped).
- **Never assume a hook's output is silent for cosmetic reasons.** Hooks commonly discard
  stdout/stderr on purpose (to avoid adding hook latency) - that means every failure mode in
  this table that "shows up silently" will continue to show up silently until someone reads
  the audit log (`PATHS.AGENT_RELAY_LOG`) directly.
- **A change to the push payload shape (`relay-send.ts`'s `bodyFor()`/`titleFor()`) must be
  cross-checked against what the NSE/app render from the push alone**, since the push is a
  real fallback UI, not just a wake-up ping - a field silently dropped from the
  push body now degrades what the user sees before any fetch happens, not just before any tap.
- **A new keystroke transport in `picker-keys.ts` must define its own `keysFor()` case** - do
  not assume any existing vocabulary transfers; tmux and CGEvent already disagree with each
  other and a third transport should not be assumed to match either.
