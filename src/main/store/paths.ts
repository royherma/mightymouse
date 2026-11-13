import { homedir, tmpdir } from 'os'
import { basename, join } from 'path'
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { CONFIG } from '../../shared/config'
import { IS_DEVTEST } from '../../shared/env'

const HOME = homedir()
// A test that did not mock homedir() would otherwise append to the user's live inbox and history.
const UNISOLATED_TEST = !!process.env.VITEST && HOME === process.env.HOME
const ROOT_DIR = UNISOLATED_TEST
  ? join(tmpdir(), `mm-vitest-${process.pid}`, CONFIG.APP_NAME)
  : join(HOME, CONFIG.APP_NAME)
if (UNISOLATED_TEST) mkdirSync(ROOT_DIR, { recursive: true })

/** Basename of the auth session file. Declared up here rather than read off
 *  PATHS.AUTH_SESSION because seedStagingRootOnce() runs before PATHS exists. */
const AUTH_SESSION_FILENAME = 'auth-session.json'

/**
 * One-time seed of the staging root from the legacy shared root.
 *
 * Staging used to be namespaced only for PACKAGED builds, so a dev build wrote
 * its (always-staging) data to the plain ~/MightyMouse — the same dir prod uses.
 * Namespacing on the resolved env fixed that collision, but it also means an
 * existing dev install looks factory-fresh on first launch: no history, no
 * settings, signed out. The data is not gone, it is one directory over.
 *
 * So: if we resolve to staging and our root does not exist yet while the legacy
 * one does, copy it across once. That data was always staging data, so this
 * moves it to where it now belongs rather than duplicating anything meaningful.
 * Copy (not move) leaves prod's dir untouched — if this build ever resolves back
 * to prod, its original data is still exactly where it was.
 *
 * Called from initializePaths() BEFORE it mkdirs the root — creating an empty
 * ROOT_DIR first would satisfy the "already migrated" guard below and strand the
 * legacy data forever. Deliberately not a module-load side effect: touching the
 * filesystem at import time runs inside any test file's hoisted fs mock, before
 * that mock's own state exists, and takes unrelated suites down with a TDZ error.
 *
 * Best-effort by design: a failure here must degrade to a fresh-looking install,
 * never to a crashed boot, so a partial copy is preferable to a thrown error.
 */
function seedStagingRootOnce(): void {
  if (!CONFIG.IS_STAGING || IS_DEVTEST) return
  const legacyRoot = join(HOME, 'MightyMouse')
  if (legacyRoot === ROOT_DIR) return
  if (existsSync(ROOT_DIR) || !existsSync(legacyRoot)) return
  try {
    cpSync(legacyRoot, ROOT_DIR, {
      recursive: true,
      // Everything EXCEPT the auth session. A Supabase JWT is scoped to one
      // project, so prod's token means nothing to staging — copying it produces
      // a session that looks present, fails every call, and shows up as a blank
      // sign-in window rather than an honest signed-out state. Signing in once
      // per env is the correct cost of two separate projects.
      filter: (src) => basename(src) !== AUTH_SESSION_FILENAME
    })
    console.log(
      `[paths] staging now has its own data dir. Seeded ${ROOT_DIR} from ${legacyRoot} ` +
        '(one-time; auth excluded, the original is untouched).'
    )
  } catch (err) {
    console.error(`[paths] could not seed ${ROOT_DIR} from ${legacyRoot} — starting clean:`, err)
  }
}

export const PATHS = {
  ROOT: ROOT_DIR,
  LOG: join(ROOT_DIR, 'rewrite.log'),
  // Every Siri/App-Intent attempt, one JSON line. On DISK, not devLog: an intent
  // runs with no window and no terminal attached, so a console line is written
  // to nobody. This file is the only record of what was said and which verb ran.
  INTENT_LOG: join(ROOT_DIR, 'intent-log.jsonl'),
  COMPUTER_USE_LOG: join(ROOT_DIR, 'computer-use-log.jsonl'),
  HIDEOUT_TODAY: join(ROOT_DIR, 'hideout-today.json'),
  COMPUTER_USE_RECORDING: join(ROOT_DIR, 'computer-use-recording.jsonl'),
  HISTORY: join(ROOT_DIR, 'rewrite-history.jsonl'),
  // Timestamped pre-conversion copies of the history file. Every encrypt/decrypt
  // toggle writes a fresh backup here BEFORE touching the live file, so a botched
  // conversion can never lose records.
  BACKUPS: join(ROOT_DIR, 'backups'),
  // History-at-rest encryption toggle. Absent/0 = plaintext (dev default), 1 = encrypted.
  HISTORY_ENC_PREF: join(ROOT_DIR, 'history-encryption-toggle.txt'),
  // Incognito mode. Absent/0 = off (default), 1 = on. When on, every activity-log
  // write (history, events, analytics/cloud, feedback, captures side-logs, last-
  // instruction, run log, tmp dumps) early-returns at its store chokepoint.
  INCOGNITO_PREF: join(ROOT_DIR, 'incognito-toggle.txt'),
  OUTCOMES: join(ROOT_DIR, 'rewrite-outcomes.jsonl'),
  // Explicit user feedback (👍/👎 + "what I expected" note) keyed by run_id.
  // Append-only, latest line per run_id wins. Honors the history-encryption toggle.
  FEEDBACK: join(ROOT_DIR, 'rewrite-feedback.jsonl'),
  // Feedback-loop master toggle. Default ON (absent/≠0 = on) — hides the rating UI
  // AND stops folding corrections into the prompt when off.
  FEEDBACK_PREF: join(ROOT_DIR, 'feedback-enabled.txt'),
  RESOURCE_HISTORY: join(ROOT_DIR, 'resource-history.jsonl'),
  // Append-only log of every predict that showed nothing (error/timeout/declined/
  // empty). The "why did the suggestion not help" record — there's no other trace
  // otherwise (devLog is dev-only, cloud analytics has counts not detail).
  SUGGESTION_FAILURES: join(ROOT_DIR, 'suggestion-failures.jsonl'),
  // Append-only trace of EVERY predict (success or fail), with the full assembled
  // prompt, which context blobs were populated, the source (idle/manual), timing,
  // and the suggestions shown. The "replay why we got THIS suggestion" record —
  // suggestion-failures.jsonl only covers empty runs; a good-but-wrong run leaves
  // no trace without this. Verbose, so swept like tmp (cleanupTmp covers the dir).
  SUGGESTION_TRACE: join(ROOT_DIR, 'suggestion-trace.jsonl'),
  LAST_INSTR: join(ROOT_DIR, 'rewrite-last-instruction.txt'),
  LAST_MODE: join(ROOT_DIR, 'rewrite-last-mode.txt'),
  CTX_PREF: join(ROOT_DIR, 'rewrite-ctx-toggle.txt'),
  // Live, unsubmitted panel input — written on every keystroke (debounced) so the
  // draft survives a Panel remount, not just a submit. Empty = no draft pending.
  DRAFT_INPUT: join(ROOT_DIR, 'rewrite-draft-input.txt'),
  // The quick-action key selected in the panel, if any (mirrors the in-memory
  // panelState.activeAction so it can be restored across a remount). Empty = none.
  ACTIVE_ACTION_KEY: join(ROOT_DIR, 'rewrite-active-action-key.txt'),
  BACKEND_FILE: join(ROOT_DIR, 'rewrite-backend.txt'),
  // Which Ollama model tag the `local` backend runs (e.g. "gemma3:27b"). Empty
  // until the user picks one in Settings from their `ollama list` output.
  OLLAMA_MODEL_FILE: join(ROOT_DIR, 'rewrite-ollama-model.txt'),
  // Which Rapid-MLX model alias the `mlx` backend runs (e.g. "qwen3-0.6b-4bit").
  // Empty until the user picks one in Settings from their served `/v1/models` list.
  MLX_MODEL_FILE: join(ROOT_DIR, 'rewrite-mlx-model.txt'),
  OPENCODE_MODEL_FILE: join(ROOT_DIR, 'rewrite-opencode-model.txt'),
  OPENROUTER_MODEL_FILE: join(ROOT_DIR, 'rewrite-openrouter-model.txt'),
  CLAUDE_CHAT_MODEL_FILE: join(ROOT_DIR, 'chat-claude-model.txt'),
  CODEX_CHAT_MODEL_FILE: join(ROOT_DIR, 'chat-codex-model.txt'),
  // Whether a thinking-capable Ollama model reasons before answering. Default OFF
  // (file-absent = off): measured 6.4x slower and scoring worse on short tasks.
  THINKING_FILE: join(ROOT_DIR, 'rewrite-thinking.txt'),
  // Which model the paid `mightymouse` backend runs, chosen in the panel's model
  // dropdown (OpenRouter slug from CONFIG.MODEL_CATALOG). Empty = the server's
  // feature-routed default. Only consulted for the mightymouse backend.
  SELECTED_MODEL_FILE: join(ROOT_DIR, 'rewrite-selected-model.txt'),
  MODEL_CATALOG_FILE: join(ROOT_DIR, 'model-catalog.json'),
  CODE_AGENT_MODEL_FILE: join(ROOT_DIR, 'code-agent-model.txt'),
  CODEX_CATALOG_FILE: join(ROOT_DIR, 'codex-model-catalog.json'),
  BROWSER_TASK_MODEL_FILE: join(ROOT_DIR, 'browser-task-model.txt'),
  CURSOR_PREF: join(ROOT_DIR, 'cursor-companion-toggle.txt'),
  // Email handed off from the landing-page download (mightymouse://onboard?email=)
  // so the sign-in screen pre-fills it. Consumed once on sign-in, then cleared.
  PENDING_AUTH_EMAIL: join(ROOT_DIR, 'pending-auth-email.txt'),
  // Run Transcript Inspector ("Show run details") toggle. Absent/0 = off (default),
  // 1 = on. When on, the HUD shows an expand icon and the runner streams rich
  // transcript events to the full-screen inspector. Debug/admin surface.
  RUN_TRANSCRIPT_PREF: join(ROOT_DIR, 'run-transcript-toggle.txt'),
  // "Show timing" toggle. Absent = on (the default), 0 = off. Filename is the
  // pre-merge transcribe-time one so an existing off setting survives.
  SHOW_TIMING_PREF: join(ROOT_DIR, 'transcribe-time-toggle.txt'),
  // Dynamic Island overlay toggle. Absent/0 = off (opt-in), 1 = on.
  ISLAND_PREF: join(ROOT_DIR, 'dynamic-island-enabled.txt'),
  // Selection bar over highlighted text. Absent/1 = on (the default), 0 = off.
  SELECTION_BAR_PREF: join(ROOT_DIR, 'selection-bar-enabled.txt'),
  // Selection bar runs rewrites on our hosted API. Absent/0 = off (it spends credits).
  SELECTION_BAR_FAST_PREF: join(ROOT_DIR, 'selection-bar-fast.txt'),
  // The bar's chips, user-editable. Absent = first run, seeded from DEFAULT_ACTIONS.
  SELECTION_ACTIONS: join(ROOT_DIR, 'selection-actions.json'),
  // One-off prompts typed into Ask, newest first, so one can be re-run or kept.
  SELECTION_RECENTS: join(ROOT_DIR, 'selection-recent-prompts.json'),

  // How often each skill has been picked as a voice-routing destination. Ranks
  // which skills are offered, since all of them will not fit in one ranking call.
  // Show the app's Dock icon. Absent/1 = on (the default), 0 = off (tray-only).
  // Runtime-only: the bundle sets no LSUIElement, so this flips live via
  // app.dock.show()/hide() with no restart.
  DOCK_ICON_PREF: join(ROOT_DIR, 'dock-icon-enabled.txt'),
  // Live Voice Companion overlay toggle ("Live mode"). Absent/0 = off (opt-in), 1 = on.
  COMPANION_PREF: join(ROOT_DIR, 'live-companion-enabled.txt'),
  // Whether a live turn may DRIVE the Mac (click/type) rather than only answer.
  // Absent = ON: screen control is the point of Live mode, so it is opt-OUT, unlike
  // every toggle around it. 0 = answers only.
  LIVE_ACTS_PREF: join(ROOT_DIR, 'live-acts-enabled.txt'),
  // "Read answers aloud" in Mighty chat — voice as a MODE on chat, independent of
  // whether the companion overlay is up (see prefs.getSpeakReplies).
  SPEAK_REPLIES_PREF: join(ROOT_DIR, 'speak-replies-enabled.txt'),
  // Which companion visualization to draw (mouse3d | warp2d | placeholder).
  // Absent = the default renderer. See src/shared/companion-renderers.ts.
  COMPANION_RENDERER: join(ROOT_DIR, 'companion-renderer.txt'),
  COMPANION_SIZE: join(ROOT_DIR, 'companion-size.txt'),
  CURSOR_STYLE: join(ROOT_DIR, 'cursor-style.txt'),
  // Phone Remote server toggle. Absent/0 = off (default, matches "opt-in, no
  // server listening until asked"), 1 = on. Restored on launch same as the
  // cursor/island/companion toggles (see startAppTail() in main/index.ts).
  PHONE_REMOTE_PREF: join(ROOT_DIR, 'phone-remote-enabled.txt'),
  // Paired phone credentials. Encrypted at rest via
  // safe-storage: unlike the toggles beside it, this file grants full remote
  // control of the Mac to whoever holds a value in it.
  PHONE_REMOTE_DEVICES: join(ROOT_DIR, 'phone-remote-devices.json'),
  // Append-only audit trail for agent-relay requests (notify/ask/approve/show):
  // one JSONL row per resolution, including drops. Not a UI in v1 -- design.
  AGENT_RELAY_LOG: join(ROOT_DIR, 'agent-relay-log.jsonl'),
  AGENT_RELAY_LOOPBACK_LOG: join(ROOT_DIR, 'agent-relay-loopback-push.jsonl'),
  // Agent relay MCP server toggle. Absent/0 = off (default, opt-in) -- same
  // shape as PHONE_REMOTE_PREF, so no MCP port ever listens until asked.
  AGENT_RELAY_PREF: join(ROOT_DIR, 'agent-relay-enabled.txt'),
  AGENT_RELAY_PHOTOS_PREF: join(ROOT_DIR, 'agent-relay-photos-enabled.txt'),
  DECISION_CARDS_PREF: join(ROOT_DIR, 'decision-cards-enabled.txt'),
  PULSE_PREF: join(ROOT_DIR, 'pulse-enabled.txt'),
  PULSE_SESSIONS: join(ROOT_DIR, 'pulse-sessions.txt'),
  PULSE_LOG: join(ROOT_DIR, 'pulse.jsonl'),
  // Mirrors the relay card to a native macOS notification. A FILE rather than
  // an env var because the dev app is launched through make -> python -> npm,
  // and a shell-prefixed var is dropped at the make boundary -- the flag read
  // as "off" no matter how it was set, which is indistinguishable from the
  // feature being broken.
  AGENT_RELAY_MAC_NOTIFY_PREF: join(ROOT_DIR, 'agent-relay-mac-notify.txt'),
  // Which verbs are allowed to buzz the phone. Absent = all four on: a missing
  // or unparseable file must fail towards being notified, never towards
  // silence, since the whole point of a push is that nobody is looking.
  AGENT_RELAY_PUSH_FILTER: join(ROOT_DIR, 'agent-relay-push-filter.json'),
  // When each session's clock started, so an app restart doesn't re-stamp a
  // long-running agent as brand new. A cache: a miss costs an accurate age.
  AGENT_RELAY_SESSION_STARTS: join(ROOT_DIR, 'agent-relay-session-starts.json'),
  AGENT_RELAY_SESSION_ARCHIVE: join(ROOT_DIR, 'agent-relay-session-archive.json'),
  // Ring buffer of connect/reject/evict/pair transitions. Survives restart and
  // is written in packaged builds, which is the point: devLog is IS_DEV-only
  // and truncates on restart, so a pairing failure that a restart clears leaves
  // no evidence anywhere else. Hashed device ids only -- safe to paste into a
  // bug report.
  PHONE_REMOTE_JOURNAL: join(ROOT_DIR, 'phone-remote-journal.json'),
  MIRROR_TUNING_LEDGER: join(ROOT_DIR, 'mirror-tuning-ledger.jsonl'),
  // Off-Wi-Fi access via Cloudflare Tunnel toggle.
  // Absent/0 = off (default, opt-in) -- flipping this is what provisions +
  // runs the tunnel alongside the LAN server; nothing to detect or install.
  PHONE_REMOTE_TUNNEL_PREF: join(ROOT_DIR, 'phone-remote-tunnel-enabled.txt'),
  PHONE_REMOTE_FIRST_STEPS: join(ROOT_DIR, 'phone-first-steps.json'),
  // Stable per-install id (32 hex chars) minted on first tunnel enable --
  // derives the tunnel name + public hostname, so it must never change for
  // the life of an install (see getPhoneRemoteInstallId()).
  PHONE_REMOTE_INSTALL_ID: join(ROOT_DIR, 'phone-remote-install-id.txt'),
  WEB_MAC_PRESENCE_ID: join(ROOT_DIR, 'web-mac-presence-id.txt'),
  WEB_PROJECTS_SYNCED: join(ROOT_DIR, 'web-projects-synced.json'),
  WEB_CHATS_SYNCED: join(ROOT_DIR, 'web-chats-synced.json'),
  // Cached provision result {hostname, tunnelToken, port} (mode 600) -- lets
  // a re-enable skip the Edge Function round-trip entirely.
  PHONE_REMOTE_TUNNEL_STATE: join(ROOT_DIR, 'phone-remote-tunnel.json'),
  // Managed binaries we download on demand (cloudflared, ffmpeg). One dir so a
  // single entry in resolve-binary.ts's priorityDirs() covers every one of them.
  BIN: join(ROOT_DIR, 'bin'),
  // Opt-in downloaded ML models (currently just Kokoro TTS). Data, not binaries,
  // so it sits beside bin/ rather than in it. One folder to delete to uninstall.
  MODELS: join(ROOT_DIR, 'models'),
  // Kokoro voice toggle. Absent/0 = off (opt-in). The kill-switch: off drops the
  // TTS ladder back to `say` without deleting the model.
  KOKORO_PREF: join(ROOT_DIR, 'kokoro-voice-enabled.txt'),
  // Trackpad move-delta multiplier, e.g. "1.5". Absent = default (1.0).
  PHONE_REMOTE_SENSITIVITY: join(ROOT_DIR, 'phone-remote-sensitivity.txt'),
  // The global hotkey ChatGPT.app is bound to for "start voice chat", e.g.
  // "cmd+shift+v". Absent = the user hasn't set one in ChatGPT, so the intent
  // refuses instead of pressing a key nothing listens for.
  // Legacy file, kept for migration only: a pre-split 'proII'/'cap' value here
  // is migrated onto the skin file below by prefs.ts. Nothing writes it now.
  PHONE_REMOTE_LAYOUT: join(ROOT_DIR, 'phone-remote-layout.txt'),
  // Which skin paints the pro layout: 'default' | 'proII' | 'cap'. Purely how
  // it looks — orthogonal to the layout file above, which decides what renders.
  // Absent = the CONFIG default.
  PHONE_REMOTE_SKIN: join(ROOT_DIR, 'phone-remote-skin.txt'),
  // Skins installed from the catalog endpoint rather than compiled into the
  // phone bundle: one directory per skin, holding sanitised skin.css, a
  // manifest.json, and any declared image assets. Owned by
  // phone-remote/remote-skins.ts — nothing else should read or write in here.
  REMOTE_SKINS_DIR: join(ROOT_DIR, 'skins'),
  // Pro layout color scheme: 'light' | 'dark'. Absent = light. Irrelevant to
  // the classic layout, which has always been theme-token-driven separately.
  // A legacy 'proII' value here is migrated to the layout file by prefs.ts.
  PHONE_REMOTE_COLOR_SCHEME: join(ROOT_DIR, 'phone-remote-color-scheme.txt'),
  // Pro layout handedness: 'right' | 'left'. Absent = right. Mirrors the whole
  // layout horizontally so the control cluster sits under whichever thumb is
  // holding the phone.
  PHONE_REMOTE_HANDEDNESS: join(ROOT_DIR, 'phone-remote-handedness.txt'),
  // Landscape-only key-cluster position: 'bottom' | 'top'. Absent = bottom.
  // The vertical counterpart to handedness above — that one picks the side of
  // the screen, this one picks the end of the column.
  PHONE_REMOTE_KEYS_POSITION: join(ROOT_DIR, 'phone-remote-keys-position.txt'),
  // Landscape-only deck distribution: 'stacked' | 'split'. Absent = stacked.
  // The third axis beside handedness and keys position — those two place ONE
  // cluster, this one decides whether there are two.
  PHONE_REMOTE_DECK_MODE: join(ROOT_DIR, 'phone-remote-deck-mode.txt'),
  // Which split concept, when deck mode is 'split'. Absent = fan.
  PHONE_REMOTE_SPLIT_CONCEPT: join(ROOT_DIR, 'phone-remote-split-concept.txt'),
  // Portrait-only mirror placement: 'stacked' | 'bleed' | 'glass' | 'inset'.
  // Absent = stacked, the shipped layout.
  PHONE_REMOTE_MIRROR_PLACEMENT: join(ROOT_DIR, 'phone-remote-mirror-placement.txt'),
  PHONE_REMOTE_SHOW_CURSOR: join(ROOT_DIR, 'phone-remote-show-cursor.txt'),
  // Arc around the button cluster that scrubs the MRU app list. Absent = off.
  PHONE_REMOTE_APP_RING: join(ROOT_DIR, 'phone-remote-app-ring.txt'),
  PHONE_REMOTE_STAY_AWAKE: join(ROOT_DIR, 'phone-remote-stay-awake.txt'),
  PHONE_REMOTE_CLAMSHELL: join(ROOT_DIR, 'phone-remote-clamshell.txt'),
  // On-disk name predates the "Away Mode" rename; keeping it preserves existing
  // users' opt-in.
  PHONE_REMOTE_AWAY_MODE: join(ROOT_DIR, 'phone-remote-away-mode.txt'),
  ONBOARDING_DONE: join(ROOT_DIR, 'onboarding-complete.txt'),
  // The wizard step the user is currently on. Written on every step change, so a
  // manual Cmd+Q recovers exactly like our own relaunch does. Absent = no wizard
  // in progress; cleared when onboarding completes.
  ONBOARDING_STEP: join(ROOT_DIR, 'onboarding-step.txt'),
  FTUE_MOCK: join(ROOT_DIR, 'ftue-mock.txt'),
  // Set just before WE relaunch to clear a stale TCC cache mid-setup, so the next
  // boot knows the restart was ours and reopens what the user was in. Absent on
  // any normal launch; consumed (deleted) on read.
  SETUP_RESUME: join(ROOT_DIR, 'setup-resume.txt'),
  // Activation latch: the user has had at least one successful run. Absent = not yet.
  FIRST_RUN_OK: join(ROOT_DIR, 'first-run-succeeded.txt'),
  // First process boot on this install (before auth). Absent = never booted here.
  FIRST_BOOT: join(ROOT_DIR, 'first-boot.txt'),
  // Same shape, for the "try transcribe" checklist row: has listen/dictation ever
  // completed once. Absent = not yet.
  TRANSCRIBE_OK: join(ROOT_DIR, 'transcribe-succeeded.txt'),
  // Same shape, for the "grant permissions" checklist row: have the required
  // permissions ever all been granted at once. Absent = not yet.
  PERMISSIONS_OK: join(ROOT_DIR, 'permissions-succeeded.txt'),
  // The user has opened the checklist at least once while it read 5/5 complete.
  // Until then the ring stays in the header even at full, so finishing the last
  // step off-screen can't make it vanish unseen. Absent = not yet acknowledged.
  CHECKLIST_SEEN_DONE: join(ROOT_DIR, 'checklist-seen-done.txt'),
  // Version of the last launch, so a boot on a higher version = an update landed.
  // Written at startup; absent on a fresh install (which is not an update).
  LAST_SEEN_VERSION: join(ROOT_DIR, 'last-seen-version.txt'),
  // Value tour shown once (after the perms wizard). Absent = not seen.
  TOUR_SEEN: join(ROOT_DIR, 'tour-seen.txt'),
  // Staging-only: skip real auth with a synthetic test-admin user (never read in prod).
  DEV_BYPASS_AUTH: join(ROOT_DIR, 'dev-bypass-auth.txt'),
  // Auth + analytics
  AUTH_SESSION: join(ROOT_DIR, AUTH_SESSION_FILENAME),
  ANON_ID: join(ROOT_DIR, 'anon-id.txt'),
  MAX_REC_MIN: join(ROOT_DIR, 'max-recording-min.txt'),
  SOUND_PREF: join(ROOT_DIR, 'sound-enabled.txt'),
  CAPTURE_HUD_PREF: join(ROOT_DIR, 'capture-hud-enabled.txt'),
  LISTEN_AUTOPASTE_PREF: join(ROOT_DIR, 'listen-autopaste-enabled.txt'),
  // Voice routing (experimental): rank open apps after a recording and offer the
  // best destination. Absent = off, so the normal auto-paste path is untouched.
  VOICE_ROUTING_PREF: join(ROOT_DIR, 'voice-routing-enabled.txt'),
  // Whether "Go there & submit" (activate the app first) is offered alongside
  // "Paste & submit". Absent = off.
  VOICE_ROUTING_GOTO_PREF: join(ROOT_DIR, 'voice-routing-goto-enabled.txt'),
  VOICE_ROUTING_SKILLS_PREF: join(ROOT_DIR, 'voice-routing-skills-enabled.txt'),
  VOICE_ROUTING_AGENTS_PREF: join(ROOT_DIR, 'voice-routing-agents-enabled.txt'),
  VOICE_ROUTING_CARD_WIDTH_PREF: join(ROOT_DIR, 'voice-routing-card-width.txt'),
  // One JSONL row per routing decision: what was ranked, what was chosen, and
  // whether the user overrode Jev. This is the only measure of whether the
  // ranking is actually any good.
  VOICE_ROUTING_LOG: join(ROOT_DIR, 'voice-routing-log.jsonl'),
  ACTION_LOG: join(ROOT_DIR, 'action-log.jsonl'),
  ACTION_PLUGINS_DIR: join(ROOT_DIR, 'plugins'),
  ACTIONS_PREF: join(ROOT_DIR, 'actions-enabled.txt'),
  ACTIONS_IDLE_PREF: join(ROOT_DIR, 'actions-idle-enabled.txt'),
  ACTIONS_DISABLED_CAPABILITIES_PREF: join(ROOT_DIR, 'actions-disabled-capabilities.txt'),
  // History-panel kind filter — CSV of HIDDEN run kinds (e.g. "listen,screenshot").
  // Storing the hidden set (not the visible one) means file-absent = nothing hidden
  // = all kinds visible, and any future kind defaults visible without a migration.
  HISTORY_FILTER_PREF: join(ROOT_DIR, 'history-filter-hidden.txt'),
  // Mighty sidebar: CSV of HIDDEN conversation sources (e.g. "listen,capture"),
  // same absent-means-nothing-hidden shape as HISTORY_FILTER_PREF above.
  MIGHTY_SOURCE_FILTER_PREF: join(ROOT_DIR, 'mighty-source-filter-hidden.txt'),
  // Sidebar: show conversations nothing was ever sent in. Stores the SHOWN state,
  // inverting the pref above, because this one defaults ON — a capture mints a
  // reply-less session per voice note, so absent must mean hidden, not shown.
  MIGHTY_SHOW_EMPTY_PREF: join(ROOT_DIR, 'mighty-sidebar-show-empty.txt'),
  MIGHTY_RENDER_MARKUP_PREF: join(ROOT_DIR, 'mighty-render-markup.txt'),
  // Detail mode: show run timing (and, later, deeper run insight) in the chat.
  // Global on purpose — any surface can read this one flag to decide how much of a
  // run's internals to expose. Only the Mighty chat header drives it today.
  MIGHTY_DETAIL_MODE_PREF: join(ROOT_DIR, 'mighty-detail-mode.txt'),
  // Mighty chat: user-dragged conversation-sidebar width (px) and whether it's shown.
  MIGHTY_SIDEBAR_WIDTH_PREF: join(ROOT_DIR, 'mighty-sidebar-width.txt'),
  CANVAS: join(ROOT_DIR, 'canvas.json'),
  MIGHTY_ZOOM_LEVEL_PREF: join(ROOT_DIR, 'mighty-zoom-level.txt'),
  MIGHTY_SIDEBAR_SHOWN_PREF: join(ROOT_DIR, 'mighty-sidebar-shown.txt'),
  MIGHTY_LAST_MODE_PREF: join(ROOT_DIR, 'mighty-last-mode.txt'),
  MIGHTY_LAST_CODE_SESSION_PREF: join(ROOT_DIR, 'mighty-last-code-session.txt'),
  MIGHTY_CONTEXT_RAIL_SHOWN_PREF: join(ROOT_DIR, 'mighty-context-rail-shown.txt'),
  // Mighty chat window bounds (JSON {x,y,width,height}) so it reopens at the size
  // and place the user left it, instead of the fixed default every time.
  MIGHTY_WINDOW_BOUNDS_PREF: join(ROOT_DIR, 'mighty-window-bounds.json'),
  // Mighty chat tab strip: all ChatWorkspaceTabs (panes, layout ratios) plus the
  // per-day tab-letter counters used by the auto-naming scheme. One JSON blob so a
  // tab and its naming counter always persist together, atomically.
  MIGHTY_WORKSPACES_PREF: join(ROOT_DIR, 'mighty-workspaces.json'),
  EVENTS: join(ROOT_DIR, 'rewrite-events.yaml'),
  SPEECH: join(ROOT_DIR, 'speech.jsonl'),
  AGENT_SESSIONS: join(ROOT_DIR, 'agent-sessions.jsonl'),
  AGENT_SPEND_CACHE: join(ROOT_DIR, 'agent-spend-cache.json'),
  ACTIONS: join(ROOT_DIR, 'rewrite-actions.json'),
  TMP: join(ROOT_DIR, 'tmp'),
  // One folder per LLM run (ask/rewrite/listen/suggestion/cheese), named by run_id:
  // ~/MightyMouse/runs/<run_id>/ holding run.json + prompt.txt + out.txt. Permanent
  // (the history row points here via run_dir), so NOT swept like tmp. Act keeps its
  // own richer acts/<slug>-<stamp>/ working dir and just records that path instead.
  RUNS: join(ROOT_DIR, 'runs'),
  ACTS: join(ROOT_DIR, 'acts'),
  ACTS_AUDITS: join(ROOT_DIR, 'acts', 'audits'),
  LATEST_ACT: join(ROOT_DIR, 'acts', 'latest.txt'),
  // Capture / recording
  CAPTURES: join(ROOT_DIR, 'captures'),
  MARKUPS: join(ROOT_DIR, 'markups'),
  LATEST_CAPTURE: join(ROOT_DIR, 'captures', 'latest.txt'),
  // Cached macOS app icons (PNG, one per app) for the Media Library app filter.
  APP_ICONS: join(ROOT_DIR, 'app-icons'),
  // Cached site favicons (PNG, one per host) for the panel's context row badge.
  FAVICONS: join(ROOT_DIR, 'favicons'),
  LINK_PREVIEWS: join(ROOT_DIR, 'link-previews'),
  // Enrichment cache for OS screenshots/recordings (opt-in Media Library source).
  // Those files live in the user's screencapture folder (e.g. ~/Desktop) which we
  // must NOT write into, so their insights.json is cached here, one subfolder per
  // file keyed by a hash of its absolute path (see osCacheFolder).
  OS_CACHE: join(ROOT_DIR, 'os-screenshot-cache'),
  // Opt-in: include the user's own macOS screenshots/recordings in the Media
  // Library. Absent/0 = off (default), 1 = on. Read by listMedia at scan time.
  OS_SCREENSHOTS_PREF: join(ROOT_DIR, 'os-screenshots-enabled.txt'),
  // Experimental: native CoreAudio mic path pref flag (native-mic.ts).
  // Default OFF — file-absent means disabled.
  USE_NATIVE_MIC: join(ROOT_DIR, 'use-native-mic.txt'),
  // Ambient context log (Feature D)
  CONTEXT_LOG_DIR: join(ROOT_DIR, 'context-log'),
  CONTEXT_LOG_LATEST: join(ROOT_DIR, 'context-log', 'latest.txt'),
  CONTEXT_LOG_PREF: join(ROOT_DIR, 'context-log-toggle.txt'),
  // Last-picked analytics range, so reopening the window restores it.
  ANALYTICS_RANGE: join(ROOT_DIR, 'analytics-range.txt'),
  // Experimental: idle suggestion bubble near the cursor. Default OFF.
  EXPERIMENTAL_SUGGESTIONS: join(ROOT_DIR, 'experimental-suggestions.txt'),
  // Let an ask answer move + click a coordinate (CGEvent). Default OFF — the
  // model only points unless this is explicitly enabled (needs Accessibility).
  CLICK_PREF: join(ROOT_DIR, 'click-enabled-toggle.txt'),
  FN_LISTEN_PREF: join(ROOT_DIR, 'fn-listen-toggle.txt'),
  SHIFT_LISTEN_PREF: join(ROOT_DIR, 'shift-listen-toggle.txt'),
  // Dev-only: touch this file to fire the insights pipeline on demand (skips the
  // idle wait). Empty/invalid body → real prediction; a Suggestion[] JSON body →
  // that exact set is shown (deterministic per test). Watched only in dev.
  INSIGHTS_TRIGGER: join(ROOT_DIR, 'insights-trigger.txt'),
  SETTINGS_FILE: join(ROOT_DIR, 'settings.json'),
  // Default whisper model location (whisper.cpp convention)
  WHISPER_MODEL_DEFAULT: join(HOME, '.cache', 'whisper', 'ggml-base.en.bin'),
  WHISPER_CACHE_DIR: join(HOME, '.cache', 'whisper'),
  // The user's Claude Code skills dir — the live source of truth for the slash
  // commands a claude/codex backend run can invoke. Read fresh, never cached to
  // disk: adding/removing a skill there must reflect immediately in the chip editor.
  CLAUDE_SKILLS: join(HOME, '.claude', 'skills'),

  // ── Mighty (standing personal agent) ─────────────────────────────────────────
  // Self-contained feature dir. sessions/jobs/registry are append-only JSONL read
  // ONLY through the MIGHTY store (encryption honors the history toggle, like
  // rewrite-history.jsonl). workspace/ is Mighty's file-creation sandbox — the act
  // agent is granted ONLY this dir, so everything it builds lands here. runs/ holds
  // per-run prompt/output dumps (swept like tmp).
  MIGHTY_DIR: join(ROOT_DIR, 'mighty'),
  MIGHTY_SESSIONS: join(ROOT_DIR, 'mighty', 'sessions.jsonl'),
  MIGHTY_JOBS: join(ROOT_DIR, 'mighty', 'jobs.jsonl'),
  MIGHTY_REGISTRY: join(ROOT_DIR, 'mighty', 'registry.jsonl'),
  // Projects group sessions with optional default backend/model/system-prompt.
  // Same latest-line-wins JSONL shape as sessions/jobs.
  MIGHTY_PROJECTS: join(ROOT_DIR, 'mighty', 'projects.jsonl'),
  MIGHTY_PROJECT_IMAGES: join(ROOT_DIR, 'mighty', 'project-images'),
  MIGHTY_WORKSPACE: join(ROOT_DIR, 'mighty', 'workspace'),
  // Never the home folder: Claude Code does not save trust there, so every start would ask again.
  CODE_NO_PROJECT: join(ROOT_DIR, 'code', 'No project'),
  CODE_NEW_PROJECTS: join(ROOT_DIR, 'Projects'),
  // Inside the workspace because that is the agent's only writable dir.
  MIGHTY_MEMORY: join(ROOT_DIR, 'mighty', 'workspace', 'MEMORY.md'),
  MIGHTY_RUNS: join(ROOT_DIR, 'mighty', 'runs'),
  // User-editable Mighty settings (persona name override, custom instructions,
  // default output format). One small JSON file — related knobs kept together
  // rather than scattered as flat .txt files, written through PREFS.
  MIGHTY_SETTINGS: join(ROOT_DIR, 'mighty', 'settings.json'),
  // Keys map: metadata only (name, shape, source, expiry). Values live in the macOS
  // keychain under service 'claude-key', shared with ~/.local/bin/key.
  KEYS_DIR: join(ROOT_DIR, 'keys'),
  KEYS_RECORDS: join(ROOT_DIR, 'keys', 'records.jsonl'),
  KEYS_MAPS: join(ROOT_DIR, 'keys', 'maps.json'),
  // Global custom instructions (text + per-mode appliesTo toggles), reaching
  // rewrite/ask/act/mighty. Replaces the old Mighty-only instructions field —
  // see the one-time migration in PREFS.getGlobalInstructions().
  GLOBAL_INSTRUCTIONS: join(ROOT_DIR, 'global-instructions.json'),
  // Act-mode highlight-box overlay toggle. Absent/1 = on (default), 0 = off —
  // flashes a dashed box around each on-screen click/type/drag target so the
  // user sees where an act run is about to act before it lands.
  ACT_HIGHLIGHT_PREF: join(ROOT_DIR, 'act-highlight-toggle.txt')
}

export function initializePaths(): void {
  // Must precede the mkdir loop — see seedStagingRootOnce().
  seedStagingRootOnce()
  const dirs = [PATHS.ROOT, PATHS.TMP, PATHS.RUNS, PATHS.ACTS, PATHS.ACTS_AUDITS, PATHS.CAPTURES, PATHS.APP_ICONS, PATHS.FAVICONS, PATHS.LINK_PREVIEWS, PATHS.OS_CACHE, PATHS.CONTEXT_LOG_DIR, PATHS.BACKUPS, PATHS.MIGHTY_DIR, PATHS.MIGHTY_WORKSPACE, PATHS.MIGHTY_RUNS, PATHS.BIN, PATHS.ACTION_PLUGINS_DIR]
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}

// Per-run prompt/output dumps (prompt-*.txt, out-*.txt) accumulate in TMP and hold
// full prompt + response text. They're only needed mid-run, so sweep anything older
// than a day on launch — bounds the plaintext-on-disk window without encrypting them.
export function cleanupTmp(maxAgeMs = 24 * 60 * 60 * 1000): void {
  if (!existsSync(PATHS.TMP)) return
  const cutoff = Date.now() - maxAgeMs
  try {
    for (const name of readdirSync(PATHS.TMP)) {
      const p = join(PATHS.TMP, name)
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      } catch {
        // skip files we can't stat/remove (in-use, perms)
      }
    }
  } catch (err) {
    console.error('Failed to clean tmp dir:', err)
  }
}
