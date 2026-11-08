// Cloud event names and payloads. Keep the taxonomy in this map only.

import type {
  AppMode, HostShell, PermissionKey,
  PermissionStatus, PhoneRemoteDeviceKind, RunFailReason, TranscribeEngineRan, UpgradeReason,
} from './types';
import type { PhoneWelcomePick, RelayVerbWire } from './phone-remote-protocol';
import type { TourSource } from './tour/types';

export type RunSource =
  | 'panel'
  | 'listen'
  | 'followup'
  | 'suggestion'
  | 'capture'
  | 'phone'
  | 'chat'
  | 'job'
  | 'voice';

export type { RunFailReason };

export type SettingKey =
  | 'cursor_companion'
  | 'cursor_style'
  | 'sound'
  | 'capture_hud'
  | 'listen_auto_paste'
  | 'context_log'
  | 'run_transcript'
  | 'show_timing'
  | 'dynamic_island'
  | 'selection_bar'
  | 'selection_bar_fast'
  | 'dock_icon'
  | 'suggestions'
  | 'click_enabled'
  | 'fn_listen_enabled'
  | 'act_highlight'
  | 'feedback'
  | 'history_encryption'
  | 'live_companion'
  | 'hands_free_dictation'
  | 'speak_replies'
  | 'global_instructions'
  | 'phone_remote'
  | 'phone_remote_tunnel'
  | 'phone_remote_stay_awake'
  | 'phone_remote_clamshell'
  | 'phone_remote_away_mode'
  | 'phone_remote_skin'
  | 'agent_relay'
  | 'agent_relay_client'
  // One per verb rather than a single key with the verb in `value`: which kind
  // of message people mute is the whole question this pref exists to answer.
  | 'agent_relay_push_ask'
  | 'agent_relay_push_approve'
  | 'agent_relay_push_notify'
  | 'agent_relay_push_show'
  | 'agent_relay_push_photos_get'
  | 'agent_relay_photos'
  | 'decision_cards'
  | 'agent_relay_push_notify_level'
  | 'agent_relay_push_turn_end';

export type ListenSource = 'mac' | 'phone';

/** Runtime names for {@link ListenSource} — import instead of typing the literal. */
export const LISTEN_SOURCE = {
  mac: 'mac',
  phone: 'phone'
} as const satisfies { [K in ListenSource]: K };

export type PhoneTransport = 'lan' | 'tunnel';

/** Runtime names for {@link PhoneTransport} — import instead of typing the literal. */
export const PHONE_TRANSPORT = {
  lan: 'lan',
  tunnel: 'tunnel'
} as const satisfies { [K in PhoneTransport]: K };

export type IosSignInFailReason =
  /** GoTrue rate-limited the OTP send. */
  | 'rate_limited'
  /** Wrong or expired code at /verify. */
  | 'bad_code'
  /** The request never got a response — airplane mode, dead Wi-Fi. */
  | 'network'
  /** A non-2xx we didn't classify. Non-zero here means a branch is missing. */
  | 'other';

/** Runtime names for {@link IosSignInFailReason}. */
export const IOS_SIGNIN_FAIL_REASON = {
  rate_limited: 'rate_limited',
  bad_code: 'bad_code',
  network: 'network',
  other: 'other'
} as const satisfies { [K in IosSignInFailReason]: K };

export type IosPairFailReason =
  | 'invalid_code'
  | 'rate_limited'
  /** The typed address isn't a private host — a user pasting a public URL. */
  | 'bad_host'
  /** No response from the Mac at all. */
  | 'unreachable'
  | 'other';

/** Runtime names for {@link IosPairFailReason}. */
export const IOS_PAIR_FAIL_REASON = {
  invalid_code: 'invalid_code',
  rate_limited: 'rate_limited',
  bad_host: 'bad_host',
  unreachable: 'unreachable',
  other: 'other'
} as const satisfies { [K in IosPairFailReason]: K };

/** Which surface asked for the wrap. Splitting these is the point: an agent
 *  calling wrap_up on itself is the feature working, a user tapping the phone
 *  button is the user cleaning up after it. */
export type RelaySessionWrapSource = 'agent' | 'phone' | 'mac';
export type RelaySessionArchiveSource = 'phone' | 'mac';

export type IosDiscoveryOutcome =
  | 'found'
  | 'not_found'
  /** Resolved a service but couldn't reach the address. */
  | 'unresolved'
  /** Local Network permission denied, or the browser itself failed to start. */
  | 'blocked'
  /** Not a sweep result: the user tapped back off the connect screen. */
  | 'left';

/** Runtime names for {@link IosDiscoveryOutcome}. */
export const IOS_DISCOVERY_OUTCOME = {
  found: 'found',
  not_found: 'not_found',
  unresolved: 'unresolved',
  blocked: 'blocked',
  left: 'left'
} as const satisfies { [K in IosDiscoveryOutcome]: K };

/** History-surface interaction. */
export type HistoryActionKind = 'open' | 'copy' | 'paste';

/** Media Library interaction. */
export type MediaLibraryActionKind = 'open' | 'chat' | 'delete' | 'retranscribe' | 'os_on' | 'os_off';

/** Quick-action (skill chip) interaction. */
export type QuickActionKind = 'select' | 'clear' | 'save';

export type PanelOpenSource =
  | 'hotkey'
  | 'tray'
  | 'dock'
  | 'history'
  | 'welcome'
  | 'mighty'
  | 'tour'
  | 'other';

export const PANEL_SOURCE_TOUR: PanelOpenSource = 'tour';

export const ONBOARDING_STEP_KEYS = ['accessibility', 'screen', 'microphone', 'backend'] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

export const CHECKLIST_STEP_KEYS = ['permissions', 'backend', 'first_run', 'transcribe', 'phone'] as const;

export type ChecklistStepKey = (typeof CHECKLIST_STEP_KEYS)[number];

/** Which onboarding UI produced the event — the four-step wizard or the
 *  one-screen setup. Lets the two funnels be compared after promotion. */
export const ONBOARDING_SURFACES = ['onescreen', 'first-run'] as const;

export type OnboardingSurface = (typeof ONBOARDING_SURFACES)[number];

export interface AnalyticsEventMap {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  app_launch: {};
  /** First process boot on this machine, before auth. Correlates download → open. */
  app_first_boot: {};
  session_start: { first_run?: boolean };
  identify: {};

  // ── Auth ─────────────────────────────────────────────────────────────────
  signin_started: { method?: 'otp' | 'password' };
  signin_completed: { method: 'otp' | 'password' };
  signout: {};
  onboarding_started: { reauth: boolean; surface: OnboardingSurface };
  onboarding_completed: { reauth: boolean; surface: OnboardingSurface };
  /** Gate closed without finishing (red X / ⌘W). The gap between this and
   *  onboarding_completed is people who bounced off the permission ask. */
  onboarding_abandoned: {};
  onboarding_required_verified: {};
  // MISNAMED — fires on any status CHANGE, so denials land here too.
  // Always filter on `status`; counting the event counts both directions.
  permission_granted: {
    permission: PermissionKey;
    status: PermissionStatus;
    at_launch?: boolean;
  };
  onboarding_step_viewed: { step: number; key: OnboardingStepKey };
  /** One-screen setup, the real first run since 2026-08-05. `preview` marks the
   *  Admin preview window: the Slack trigger drops those rows and dashboards
   *  must filter them too. */
  onboarding_screen_viewed: { preview: boolean };
  onboarding_permission_granted: { key: PermissionKey; preview: boolean };
  onboarding_provider_picked: { backend: string; preview: boolean };
  /** Allow pressed. Pair with onboarding_permission_granted for the per-key
   *  grant failure rate — a granted without an attempted came from System
   *  Settings directly. */
  onboarding_grant_attempted: { key: PermissionKey; preview: boolean };
  /** Allow pressed but the self-test never passed within the retry window.
   *  The user most likely landed in the drag-coach path or gave up. */
  onboarding_grant_failed: { key: PermissionKey; detail: string; preview: boolean };
  /** A grant is stuck behind the per-process TCC cache — the finish button
   *  became "Restart and finish". Once per screen visit. */
  onboarding_needs_restart: { preview: boolean };
  /** The screen loaded with something already broken (missing capture
   *  binaries, or the picked backend failing its test). Once per kind. */
  onboarding_blocked_shown: { kind: 'binaries' | 'backend'; preview: boolean };

  setup_check_viewed: { failing: number };
  /** Every required row passed. viewed → complete is the funnel that matters. */
  setup_check_complete: {};
  setup_fix_ran: { check: string; kind: string; ok: boolean };
  /**
   * One managed-binary download attempt. `setup_fix_ran` only says ok/fail, and
   * the reason is what decides whether the removed Homebrew path has to come
   * back: a `network` skew is a retry, a `checksum` skew is a bad release.
   * `reason` is a fixed bucket, never a raw error — those carry $HOME.
   */
  binary_downloaded: { binary: string; arch: string; ok: boolean; reason: string };
  setup_diagnostic: { ok: number; failing: number; failing_ids: string; optional_ids: string; ran_fix: string };
  screen_permission_blocked: { action: string };
  mic_permission_blocked: { action: string };

  // ── Panel lifecycle (the core hotkey surface) ────────────────────────────
  panel_opened: { source: PanelOpenSource };
  /** Panel dismissed without submitting (Esc / cancel). Submit ÷ open = friction. */
  panel_dismissed: {};
  /** User hit Stop on a live run — killed the in-flight CLI. `killed` = count SIGKILLed. */
  run_stopped: { killed: number };

  // ── Runs ─────────────────────────────────────────────────────────────────
  mode_submit: {
    mode: AppMode;
    backend: string;
    ctx: boolean;
    source: RunSource;
    attachments: number;
    attachment_images: number;
    attachment_audio: number;
    attachment_files: number;
  };
  run_completed: {
    mode: AppMode;
    backend: string;
    model: string;
    ok: boolean;
    duration_ms: number;
    chars_out: number;
    turns: number;
    ctx: boolean;
    source: RunSource;
    /** Whether the model reasoned before answering. Only the `local` backend can
     *  be true; false everywhere else, so filter on backend before reading it. */
    thinking?: boolean;
    /** Present only when ok=false. */
    reason?: RunFailReason;
    /** Present only when ok=false. */
    exit_code?: number;
    /** Truncated, secret-scrubbed stderr tail — the reason a failure is
     *  queryable in prod instead of only on the user's own machine. Present
     *  only when ok=false and stderr had something to say. */
    reason_detail?: string;
    pipeline_id?: string;
  };
  backend_switched: { to: string };
  /** Kept for back-compat with the existing failure event; run_completed{ok:false} supersedes for rate math. */
  backend_error: { which: string; mode: AppMode; exit_code: number };
  out_of_credits: { backend: string };
  first_run_succeeded: { mode: AppMode; backend: string };
  update_installed: { version: string; from_version: string };
  update_available: { version: string };
  update_downloaded: { version: string };

  // ── Activation checklist (Panel "Finish setup" card) ──────────────────────
  /** One checklist row flipped to done. `remaining` is the count still open
   *  AFTER this step, so a histogram of this event shows exactly where users
   *  stall on the way to activation. */
  checklist_step_completed: { step: ChecklistStepKey; remaining: number };
  /** All 5 rows done — the card collapses. */
  checklist_completed: {};

  // ── Voice / capture ──────────────────────────────────────────────────────
  capture_screenshot: {};
  recording_completed: { duration_s: number };
  listen_completed: {
    words: number;
    wpm: number;
    duration_s: number;
    source: ListenSource;
    /** Wall-clock ms inside whisper-cli (whisper.ts `tookMs`). */
    transcribe_ms: number;
    transcode_ms: number;
    total_ms: number;
    /** Processing ms ÷ audio ms. Lower is faster; comparable across clip lengths,
     *  which raw transcribe_ms is not. */
    rtf: number;
    /** Which engine produced the transcript — without it rtf is unattributable. */
    engine?: TranscribeEngineRan;
    /** True when parakeet failed and whisper silently produced this instead. */
    fell_back?: boolean;
  };
  smart_dictation_completed: {
    action: 'paste' | 'answer' | 'act' | 'act_cancelled' | 'fallback';
    words: number;
    backend: string;
    pipeline_id?: string;
  };

  phone_paired: {
    transport: PhoneTransport;
    reconnect: boolean;
    shell: HostShell | null;
    /** iphone / ipad / android / mac / unknown, parsed from the UA. */
    kind: PhoneRemoteDeviceKind;
    /** 'Safari' / 'Chrome' / 'Samsung Internet'. Empty when unparseable. */
    browser: string;
    /** Major version only ('18'), so this stays a low-cardinality dimension. */
    browser_version: string;
    /** 'iOS' / 'Android' / 'macOS'. */
    os: string;
    os_version: string;
  };
  /** The server refused an off-Wi-Fi grant. The free-tier upgrade moment — pairs
   *  with checkout_started to measure whether the prompt actually converts. */
  phone_remote_tunnel_refused: {
    code: string;
    /** Narrowest exhausted window, or null for a non-tier refusal. */
    window: string | null;
  };
  phone_device_paired: {
    shell: HostShell | null;
    kind: PhoneRemoteDeviceKind;
    model_known: boolean;
    os: string;
    os_version: string;
    total_devices: number;
  };
  phone_connect_failed: {
    last_outcome: string;
    last_detail: string;
    outcomes: string;
    attempts: number;
    device: string;
  };
  phone_device_revoked: {
    /** True when the user cleared every device at once, not one row. */
    all: boolean;
    /** Days since this device last connected, null if it never did. */
    idle_days: number | null;
    /** Past the stale threshold the list already flags in the UI. */
    stale: boolean;
    total_devices: number;
  };
  /** An Away Mode session ended, reporting what happened to the cover.
   *  The cover is deferred, so `covered:false` is the ordinary case of a user
   *  who never actually walked away — the split between the two is the signal. */
  away_mode_session: {
    /** False when the session ended before the delay elapsed, so the screen was
     *  never covered at all. */
    covered: boolean;
    /** Whole session length, comparable to phone_session_ended.duration_s. */
    duration_s: number;
    /** Seconds the screen was actually black. 0 when covered is false. */
    covered_s: number;
    /** 'human' = someone touched the Mac and took it back; 'disconnect' = the
     *  phone went away or the session was torn down without a human present. */
    ended_by: 'human' | 'disconnect';
  };

  phone_first_step: {
    step: 'shown' | `welcome_${PhoneWelcomePick}` | 'move' | 'tap' | 'talk' | 'mic_denied' | 'expired';
    s_since_shown: number;
  };

  phone_session_ended: {
    duration_s: number;
    /** Cursor moves + drags. The "did they touch the trackpad at all" signal. */
    moves: number;
    /** Taps, two-finger taps, double-taps. */
    clicks: number;
    /** Hold-to-speak recordings that produced a transcript. */
    voice_runs: number;
    /** Chat turns sent from the phone (each becomes a run_completed{source:'phone'}). */
    chat_turns: number;
    /** True when the session did nothing but connect — the drop-off cohort. */
    idle: boolean;
    /** Every message the phone sent, so moves: 0 tells a silent phone from one stuck off the pad. */
    messages: number;
    /** Distinct message types in arrival order, first 12. */
    message_types: string;
  };

  ios_app_launch: {
    /** True on a genuine process start, false on a resume from background. */
    cold: boolean;
  };
  ios_signin_started: {};
  ios_signin_completed: {};
  ios_signin_failed: { reason: IosSignInFailReason };
  ios_pair_started: { manual: boolean };
  ios_pair_succeeded: { manual: boolean };
  ios_pair_failed: { manual: boolean; reason: IosPairFailReason };
  ios_discovery_result: { outcome: IosDiscoveryOutcome };
  ios_local_network_primed: {};
  ios_chat_opened: {};

  // ── Agent relay ──────────────────────────────────────────────────────────
  /** An MCP verb minted a request. notify excluded — it settles at mint, so it
   *  reports as sent-and-done via relay_request_resolved{seconds:0} instead. */
  relay_request_sent: { verb: RelayVerbWire };
  /** A human answered. `seconds` is the whole point: it is the only measure of
   *  whether the flow is smooth or the agent sat there blocked. */
  relay_request_resolved: { verb: RelayVerbWire; seconds: number; via: string };
  /** Nobody answered in time. A rising rate here means pushes are not landing
   *  or are not answerable — the silent failure this feature is most prone to. */
  relay_request_timeout: { verb: RelayVerbWire; seconds: number };
  /** Someone cleared a request instead of answering it. Distinct from timeout
   *  on purpose: a timeout says the push did not land or reach anyone, a
   *  dismiss says it landed and was not worth answering. One is a delivery
   *  problem, the other is a content problem, and a single counter hides both. */
  relay_request_dismissed: { verb: RelayVerbWire; seconds: number };
  /** The NSE (or phone app) actually fetched the request content over
   *  GET /relay-request -- the one signal that separates "push never landed"
   *  from "landed but nobody answered" (docs/agent-relay.md gap #3). Fires at
   *  most once per request; a re-fetch of the same id is deduped upstream. */
  relay_request_delivered: { verb: RelayVerbWire };
  /** A wrap-up actually started: the user accepted and step 1 was typed. The
   *  only count of sessions ENDED on purpose, and the one number that says
   *  whether agents are being closed out or left to rot in the list. */
  relay_session_wrap_started: { source: RelaySessionWrapSource };
  /** How that wrap ended, up to ~80s later. `closed` is the good outcome; a
   *  rising `asked` means the agent outlives the wait and the row self-reaps,
   *  which reads to the user as a wrap that did nothing. */
  relay_session_wrap_finished: { source: RelaySessionWrapSource; outcome: string };
  relay_session_started: {};
  code_session_started: { harness: string };
  code_session_completed: { harness: string; ok: boolean };
  code_project_added: { first: boolean; has_folder: boolean };
  ftue_path_picked: { path: 'talk' | 'phone' | 'code' | 'skip' };
  ftue_step: { path: 'talk' | 'phone' | 'code'; step: string; ms_since_first_boot: number; skipped?: boolean };
  relay_session_archived: { source: RelaySessionArchiveSource };

  // ── Feature adoption / value ─────────────────────────────────────────────
  setting_toggled: { key: SettingKey; value: string };
  setting_saved: { key: string };
  whisper_model_download: {};
  ffmpeg_install: {};
  panel_mode_override: { mode: AppMode | null };
  panel_ctx_toggle: { on: boolean };
  history_action: { kind: HistoryActionKind };
  media_library_action: { kind: MediaLibraryActionKind };
  quick_action: { kind: QuickActionKind };
  /** The rewrite result actually landed at the cursor — the primary VALUE event. */
  rewrite_pasted: { chars: number };
  /** Result was ready but couldn't be delivered (focus lost, paste blocked). */
  rewrite_paste_skipped: { reason: 'focus_lost' | 'no_target' };
  feedback_given: { rating: 'up' | 'down' | 'note'; mode: AppMode; backend: string; has_note: boolean };

  bug_report_submitted: Record<string, never>;

  // ── Billing ──────────────────────────────────────────────────────────────
  /** The upgrade window opened, tagged with the limit that sent the user there.
   *  Head of the funnel: upgrade_opened → checkout_started → checkout_returned. */
  upgrade_opened: { reason: UpgradeReason };
  checkout_started: { pack_id: string; reason?: UpgradeReason };
  checkout_opened: { pack_id: string };
  checkout_failed: {
    pack_id: string;
    reason:
      | 'not_signed_in'
      | 'no_url'
      | 'session_error'
      | 'lifetime_disabled'
      | 'lifetime_sold_out'
      | 'already_lifetime';
  };
  /** Stripe deep-link return — closes the purchase funnel client-side. */
  checkout_returned: { result: 'success' | 'cancel' };

  // ── Suggestions (insights) ───────────────────────────────────────────────
  suggestion_shown: { front_app: string; count: number; modes: AppMode[]; source: 'idle' | 'manual' };
  suggestion_dismissed: { front_app: string; count: number };
  suggestion_accepted: { front_app: string; mode: AppMode; shown_index: number; instruction_stem: string };
  suggestion_write_pasted: { front_app: string; chars: number };
  suggestion_write_focus_lost: { trigger_app: string; current_app: string };
  suggestion_failed: {
    front_app: string;
    source: 'idle' | 'manual';
    outcome: 'error' | 'timeout' | 'declined' | 'no-suggestions';
    reason: string;
  };

  action_proposed: {
    trigger: 'voice' | 'idle' | 'phone';
    front_app: string;
    action_id: string;
    count: number;
    percent: number;
    latency_ms: number;
    via: 'proxy' | 'direct';
  };
  action_executed: { trigger: 'voice' | 'idle' | 'phone'; action_id: string; ok: boolean; overrode: boolean; run_ms: number };
  action_dismissed: { trigger: 'voice' | 'idle' | 'phone'; action_id: string; front_app: string };

  // ── Tour ─────────────────────────────────────────────────────────────────
  tour_started: { source: TourSource };
  tour_step_viewed: { step: number; key: string };
  tour_skipped: { step: number };
  tour_completed: {};
  tour_reopened: {};
  /** Closes the permission→tour→panel chain. `dismissed` = red-X, the one exit
   *  that hands off to nothing. */
  tour_handoff: { to: 'panel' | 'none'; dismissed: boolean };
  tour_key_confirmed: { stepKey: string; msToPress: number };
  tour_key_timed_out: { stepKey: string };
  tour_phone_paired: { stepKey: string; msToPair: number };
  tour_phone_pair_timed_out: { stepKey: string };
}

/** Union of every valid event name. */
export type AnalyticsEventName = keyof AnalyticsEventMap;

/** Props type for a given event name. */
export type AnalyticsEventProps<K extends AnalyticsEventName> = AnalyticsEventMap[K];

export const ANALYTICS_EVENT = {
  app_launch: 'app_launch',
  app_first_boot: 'app_first_boot',
  session_start: 'session_start',
  identify: 'identify',
  panel_opened: 'panel_opened',
  panel_dismissed: 'panel_dismissed',
  run_stopped: 'run_stopped',
  signin_started: 'signin_started',
  signin_completed: 'signin_completed',
  signout: 'signout',
  onboarding_started: 'onboarding_started',
  onboarding_completed: 'onboarding_completed',
  onboarding_abandoned: 'onboarding_abandoned',
  onboarding_required_verified: 'onboarding_required_verified',
  permission_granted: 'permission_granted',
  first_run_succeeded: 'first_run_succeeded',
  update_installed: 'update_installed',
  update_available: 'update_available',
  update_downloaded: 'update_downloaded',
  onboarding_step_viewed: 'onboarding_step_viewed',
  onboarding_screen_viewed: 'onboarding_screen_viewed',
  onboarding_permission_granted: 'onboarding_permission_granted',
  onboarding_provider_picked: 'onboarding_provider_picked',
  onboarding_grant_attempted: 'onboarding_grant_attempted',
  onboarding_grant_failed: 'onboarding_grant_failed',
  onboarding_needs_restart: 'onboarding_needs_restart',
  onboarding_blocked_shown: 'onboarding_blocked_shown',
  setup_check_viewed: 'setup_check_viewed',
  setup_check_complete: 'setup_check_complete',
  setup_fix_ran: 'setup_fix_ran',
  binary_downloaded: 'binary_downloaded',
  screen_permission_blocked: 'screen_permission_blocked',
  mic_permission_blocked: 'mic_permission_blocked',
  setup_diagnostic: 'setup_diagnostic',
  mode_submit: 'mode_submit',
  run_completed: 'run_completed',
  backend_switched: 'backend_switched',
  backend_error: 'backend_error',
  out_of_credits: 'out_of_credits',
  checklist_step_completed: 'checklist_step_completed',
  checklist_completed: 'checklist_completed',
  capture_screenshot: 'capture_screenshot',
  recording_completed: 'recording_completed',
  listen_completed: 'listen_completed',
  smart_dictation_completed: 'smart_dictation_completed',
  phone_paired: 'phone_paired',
  phone_remote_tunnel_refused: 'phone_remote_tunnel_refused',
  phone_device_paired: 'phone_device_paired',
  phone_connect_failed: 'phone_connect_failed',
  phone_device_revoked: 'phone_device_revoked',
  phone_first_step: 'phone_first_step',
  phone_session_ended: 'phone_session_ended',
  away_mode_session: 'away_mode_session',
  ios_app_launch: 'ios_app_launch',
  ios_signin_started: 'ios_signin_started',
  ios_signin_completed: 'ios_signin_completed',
  ios_signin_failed: 'ios_signin_failed',
  ios_pair_started: 'ios_pair_started',
  ios_pair_succeeded: 'ios_pair_succeeded',
  ios_pair_failed: 'ios_pair_failed',
  ios_discovery_result: 'ios_discovery_result',
  ios_local_network_primed: 'ios_local_network_primed',
  ios_chat_opened: 'ios_chat_opened',
  relay_request_sent: 'relay_request_sent',
  relay_request_resolved: 'relay_request_resolved',
  relay_request_timeout: 'relay_request_timeout',
  relay_request_dismissed: 'relay_request_dismissed',
  relay_request_delivered: 'relay_request_delivered',
  relay_session_wrap_started: 'relay_session_wrap_started',
  relay_session_wrap_finished: 'relay_session_wrap_finished',
  relay_session_started: 'relay_session_started',
  code_session_started: 'code_session_started',
  code_session_completed: 'code_session_completed',
  code_project_added: 'code_project_added',
  ftue_path_picked: 'ftue_path_picked',
  ftue_step: 'ftue_step',
  relay_session_archived: 'relay_session_archived',
  setting_toggled: 'setting_toggled',
  setting_saved: 'setting_saved',
  whisper_model_download: 'whisper_model_download',
  ffmpeg_install: 'ffmpeg_install',
  panel_mode_override: 'panel_mode_override',
  panel_ctx_toggle: 'panel_ctx_toggle',
  history_action: 'history_action',
  media_library_action: 'media_library_action',
  quick_action: 'quick_action',
  rewrite_pasted: 'rewrite_pasted',
  rewrite_paste_skipped: 'rewrite_paste_skipped',
  feedback_given: 'feedback_given',
  bug_report_submitted: 'bug_report_submitted',
  upgrade_opened: 'upgrade_opened',
  checkout_started: 'checkout_started',
  checkout_opened: 'checkout_opened',
  checkout_failed: 'checkout_failed',
  checkout_returned: 'checkout_returned',
  suggestion_shown: 'suggestion_shown',
  suggestion_dismissed: 'suggestion_dismissed',
  suggestion_accepted: 'suggestion_accepted',
  suggestion_write_pasted: 'suggestion_write_pasted',
  suggestion_write_focus_lost: 'suggestion_write_focus_lost',
  suggestion_failed: 'suggestion_failed',
  action_proposed: 'action_proposed',
  action_executed: 'action_executed',
  action_dismissed: 'action_dismissed',
  tour_started: 'tour_started',
  tour_step_viewed: 'tour_step_viewed',
  tour_skipped: 'tour_skipped',
  tour_completed: 'tour_completed',
  tour_reopened: 'tour_reopened',
  tour_handoff: 'tour_handoff',
  tour_key_confirmed: 'tour_key_confirmed',
  tour_key_timed_out: 'tour_key_timed_out',
  tour_phone_paired: 'tour_phone_paired',
  tour_phone_pair_timed_out: 'tour_phone_pair_timed_out'
} as const satisfies { [K in AnalyticsEventName]: K };
