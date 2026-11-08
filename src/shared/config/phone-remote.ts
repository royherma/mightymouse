// Phone Remote tunables — the iPhone trackpad/voice surface served over LAN.
// Split out of config.ts: 868 lines, by far the largest behavioural block.
// Takes supabaseUrl as an argument so this module stays free of env resolution.

export const buildPhoneRemote = (supabaseUrl: string) => ({
  // Fixed default port so the QR payload is predictable; an uncommon high port
  // avoids clashing with common dev servers (3000/5173/8080/etc). If taken,
  // server.ts retries PORT_RANGE_SIZE consecutive ports upward before giving up.
  PORT: 17771,
  PORT_RANGE_SIZE: 5,
  SKIN_CATALOG_URL: `${supabaseUrl}/functions/v1/phone-remote-skins`,
  // Path the local server re-serves installed skin assets from. Sanitised
  // CSS points here, so it must stay in sync with server.ts's static handler.
  REMOTE_SKIN_ASSET_ROUTE: '/_skin-assets',
  // Path the phone GETs to open the store: triggers the catalog fetch and
  // returns built-in + installed remote skins in one payload.
  REMOTE_SKIN_CATALOG_ROUTE: '/_skins',
  // Where the local server serves the concatenated CSS of installed skins.
  REMOTE_SKIN_CSS_ROUTE: '/_skins.css',
  // Three timers, all armed when the phone drops, all 10m — but NOT one value:
  // only the blocker release is a one-way door (it re-arms macOS's idle lock,
  // and a locked Mac cannot be unlocked from the phone). Sharing a name hid that
  // asymmetry, so tuning the safe cover silently retuned the lockout.
  // They stay equal by default; keep the teardown order that the 2026-08-07
  // lockout paid for by never making CURTAIN_ON_PHONE_GONE_MS the longest.
  CURTAIN_ON_PHONE_GONE_MS: 10 * 60 * 1000,
  // Only ever reached with NOTHING PAIRED -- stay-awake.ts refuses to arm the
  // watchdog once a device exists, because no elapsed time distinguishes a
  // pocketed phone from an abandoned one and guessing wrong locks the user out
  // of the Mac their phone was the only way into (Roy, 2026-09-09). This value
  // caps the battery leak of a server holding the display awake for a phone
  // that never paired; it is not a session timeout and must not become one.
  IDLE_LOCK_REARM_MS: 10 * 60 * 1000,
  CLAMSHELL_REVERT_MS: 10 * 60 * 1000,
  CLAMSHELL_AGENT_RECHECK_MS: 60 * 1000,
  // A session whose hooks went quiet this long is treated as dead, so a crashed agent cannot hold a closed Mac awake forever.
  CLAMSHELL_AGENT_QUIET_MS: 30 * 60 * 1000,
  // After Protect, the click's own mouseup would otherwise lock. Same 2s the
  // tray used so a hand can leave the mouse. Cafe touch-to-lock after that.
  AWAY_COVER_ARM_MS: 2_000,
  // Used ONLY when displaysleep is 0/"never", which leaves no delay to inherit.
  // Deliberately not a ceiling: capping the user's own display-sleep delay
  // covers the screen on someone using the phone as a trackpad at their desk.
  AWAY_COVER_DELAY_FALLBACK_MS: 10 * 60 * 1000,
  // Floor for the same, for a Mac configured to sleep almost immediately --
  // below this the screen covers while the user is still reaching for their
  // phone, which reads as the feature misfiring.
  AWAY_COVER_DELAY_MIN_MS: 5 * 1000,
  // A postpone ceiling and a deadline factor used to live here. Both deleted:
  // `make why Q="postpone ceiling"`.
  WS_PING_MS: 30 * 1000,
  ICON_PORT: 17871,
  // Extended-display mode: fallback size for the virtual display if the Mac's
  // own primary-display size reads back unusable. Normally it copies that
  // size, so both mirror and extend stream one aspect ratio into one pane.
  EXTEND_FALLBACK_WIDTH: 1170,
  EXTEND_FALLBACK_HEIGHT: 640,
  // A 0 or absurd size is rejected by the WindowServer with the same silent
  // non-attach as any other bad config -- very hard to diagnose after the fact.
  EXTEND_MIN_PX: 640,
  EXTEND_MAX_PX: 4096,
  // The extended screen outlives the phone, so Settings polls for one instead
  // of being pushed to: it can also vanish with no IPC (macOS terminating the
  // helper), which would leave a pushed flag claiming a display that's gone.
  EXTEND_STATUS_POLL_MS: 2_000,
  PAIR_CODE_PATH: '/pair',
  // Unauthenticated, same as GET /whoami: the phone POSTs failed dials here
  // when the WS never opens, so the Mac journal still gets the why.
  CONNECT_LOG_PATH: '/connect-log',
  CONNECT_LOG_FLUSH_MS: 2_000,
  CLIENT_ERROR_PATH: '/client-error',
  // Authed POST: the phone registers its APNs device token here after every
  // launch (agent-relay PRD §5). Token is stored next to the device
  // credential; the cloud relay never sees it until a push is actually sent.
  PUSH_TOKEN_PATH: '/push-token',
  // Authed GET (?requestId=&credential=): the Notification Service Extension
  // fetches a pending request's real content over the tunnel (agent-relay
  // PRD §5 item 4) -- the push itself carries only a request_id.
  RELAY_REQUEST_PATH: '/relay-request',
  // Authed POST: the lock-screen notification action posts its answer back
  // here with the same request_id (agent-relay PRD §4).
  RELAY_RESPOND_PATH: '/relay-respond',
  // Authed GET (?requestId=&credential=): the NSE's second fetch for a
  // 'show' verb -- the image bytes themselves. Scoped by request_id, not a
  // raw filesystem path, so a lock-screen extension can never walk the Mac.
  RELAY_IMAGE_PATH: '/relay-image',
  // Authed GET (?sessionId=&turn=&item=&credential=): one media file a chat
  // turn carries. Addressed by POSITION in the stored session, never by path
  // -- same reason as the image route above: the store decides which file this
  // credential may read, so the wire never gets to name one.
  CHAT_MEDIA_PATH: '/chat-media',
  // Authed GET (?requestId=&credential=): the icon of the app the agent is
  // running in, so a card can wear Claude Code's/Cursor's face instead of
  // ours. Same request_id scoping as the image route -- the bundle id comes
  // off the stored request's origin, never off the wire.
  RELAY_AVATAR_PATH: '/relay-avatar',
  // Authed POST: the iOS Share Extension sends one image (base64) or one
  // string of text here. It is a short-lived process with no deck, so it
  // cannot use the WS binary path the way the remote app would.
  SHARE_PATH: '/share',
  // Authed POST: ends one agent session (wrap-up prompt, then /exit, then the
  // pane). It lives on THIS port, not the MCP one, because 17781 is
  // unauthenticated by design -- a kill verb there would let any local
  // process close any terminal on the Mac.
  SESSION_WRAP_PATH: '/session-wrap',
  // Authed POST: runs ONE named action from the closed table in
  // main/intent-actions.ts. This is the Siri path -- an App Intent fires it
  // with nobody at the keyboard, so like /share it opens no socket and cannot
  // evict the live deck.
  INTENT_PATH: '/intent',
  // How many resolved relay cards the Code sheet keeps visible (grayed out)
  // below the pending ones. Was 5 per PRD §6b "the last few resolved ones",
  // which is a tail across ALL agents -- so once a session detail sheet
  // started filtering it per-agent, a busy agent's timeline could come back
  // empty because five other agents had spoken more recently. A row is a few
  // hundred bytes and the 6h retention still bounds the store, so the cost of
  // 50 is noise and it makes a single agent's history actually readable.
  RELAY_RESOLVED_TAIL: 50,
  // 6 digits is the AirPlay/Bluetooth convention -- long enough that
  // guessing it inside the TTL is hopeless once rate-limiting applies,
  // short enough to read off a screen and type without a mistake.
  PAIR_CODE_LENGTH: 6,
  RATE_LIMIT_COOLDOWN_MS: 30_000,
  // Query param the QR embeds the pairing code under, so a scan runs the
  // same /pair exchange as typing. Never authorizes a socket -- unlike the
  // deleted PAIRING_TOKEN_PARAM, it can only mint one credential, once.
  PAIR_CODE_PARAM: 'c',
  PAIR_ERROR_COPY: {
    'invalid-code': "That code didn't work. Check the Mac and try again.",
    'rate-limited': 'Too many tries. Wait a minute, then try again.',
    // No mention of Wi-Fi: the same failure happens over the tunnel, where
    // naming the network sends the user to fix a setting that isn't wrong.
    unreachable: "Can't reach your Mac. Make sure it's awake and MightyMouse is open."
  } as Record<string, string>,
  PAIR_ERROR_FALLBACK: 'Pairing failed. Try a fresh code from your Mac.',
  // Minted on demand and short-lived: the code is only ever in flight while
  // the user is looking at both screens at once.
  PAIR_CODE_TTL_MS: 5 * 60 * 1000,
  // localStorage key for the durable per-device credential the /pair
  // exchange returns. Survives server restarts.
  DEVICE_CREDENTIAL_KEY: 'mm-remote-device-credential',
  // Query param the WS upgrade carries the device credential on -- the only
  // credential a socket accepts.
  DEVICE_CREDENTIAL_PARAM: 'd',
  STANDALONE_PARAM: 's',
  SHELL_PARAM: 'sh',
  DEVICE_MODEL_PARAM: 'dm',
  OS_VERSION_PARAM: 'ov',
  // A cursorless host (the glasses) declaring itself at connect time. The
  // role follows from this, never from arrival order.
  CURSORLESS_PARAM: 'cl',
  // How long an uncredentialed socket waits on the paired phone's Allow/Deny
  // before it is closed as 'no-credential'. Long enough to pull the phone out
  // of a pocket, short enough that a stranger probing the tunnel cannot park
  // a socket on the Mac indefinitely.
  APPROVAL_TTL_MS: 45 * 1000,
  // How recently the phone must have been touched for a new device to be able
  // to ask it for approval unprompted. 3min: long enough to put the phone down,
  // pick up the glasses and connect them, short enough that a phone forgotten
  // on a desk stops being a doorbell a stranger with the tunnel URL can ring.
  APPROVAL_PRESENCE_MS: 3 * 60 * 1000,
  // WS close code for a denied or expired approval. Deliberately 4401 with a
  // BlockedReason the client already handles: the device ends up in the same
  // place as any other uncredentialed arrival -- the pairing code form.
  CLOSE_CODE_APPROVAL_DENIED: 4401,
  MDNS_HOSTNAME: 'mightymouse.local',
  MDNS_SERVICE_INSTANCE: 'MightyMouse Remote',
  MDNS_SERVICE_TYPE: '_https._tcp',
  DISCOVERY_MDNS_TIMEOUT_MS: 400,
  DISCOVERY_LAST_KNOWN_TIMEOUT_MS: 1500,
  DISCOVERY_PROBE_TIMEOUT_MS: 2500,
  // How many /24 host addresses to probe concurrently. Capped well below
  // 254 so this doesn't look like a port scan to network monitoring or the
  // phone's own iOS Local Network permission heuristics (PRD §5 risk).
  DISCOVERY_PROBE_CONCURRENCY: 32,
  // localStorage key for the last host that successfully completed a WS
  // connection -- candidate #3 in the discovery order (PRD §4 Layer 2).
  DISCOVERY_LAST_HOST_KEY: 'mm-remote-last-host',
  // localStorage key for the last Cloudflare Tunnel hostname a /whoami hit
  // advertised -- candidate #3.5, off-LAN discovery (cloudflare-tunnel PRD).
  DISCOVERY_LAST_TUNNEL_HOST_KEY: 'mm-remote-last-tunnel-host',
  CLOSE_REASON_REVOKED: 'credential-revoked',
  // Evicted by a newer connection. Credentials stay valid, so this is NOT a
  // 4401 -- the phone yields and offers "take control back" rather than
  // retrying, which is what turned one kick into a 1s ping-pong war.
  CLOSE_REASON_EVICTED: 'evicted',
  // Refused because the incumbent is actively in use. The newcomer offers an
  // explicit takeover instead of silently stealing the session.
  CLOSE_REASON_BUSY: 'busy',
  // The SAME phone arriving on a second transport (LAN + tunnel), not a rival
  // device. Its stale socket is retired quietly: closing 'evicted' would put
  // a "take control" button on a phone competing only with itself.
  CLOSE_REASON_SUPERSEDED: 'superseded',
  // WS close code for all of the above: 4409 (conflict), never 4401 --
  // overloading 'unauthorized' is what made a valid credential look revoked.
  CLOSE_CODE_CONFLICT: 4409,
  // The PHONE ended the session from its own Settings. Distinct from a
  // network drop so the Mac's journal doesn't log a deliberate goodbye as a
  // fault, and the phone frees the single-socket slot immediately.
  CLOSE_CODE_LEFT: 4410,
  // How recently the active phone must have sent input to hold the Mac
  // against a newcomer. Past it the session is idle and takeover is silent.
  TAKEOVER_GRACE_MS: 20_000,
  // Set to '1' on the WS URL by a phone that tapped "take control". Rides the
  // URL because a refused phone has no socket to send a message on.
  TAKEOVER_PARAM: 'takeover',
  // Set to '1' by a read-only client (an agent verifying layout). Held
  // outside `activeSocket`, so it never reaches the takeover gate.
  OBSERVE_PARAM: 'observe',
  WEB_CLIENT_PARAM: 'web',
  PREVIEW_PARAM: 'preview',
  // Reconnect backoff ladder (Layer 3): 1s -> 2s -> 4s -> 8s -> 16s -> 30s
  // cap. Index by attempt number, clamping to the last entry past its length.
  RECONNECT_BACKOFF_MS: [1000, 2000, 4000, 8000, 16000, 30000],
  // After this many consecutive failed reconnect attempts, stop retrying the
  // same host and escalate to a full Layer 2 re-discovery sweep -- the host
  // is provably gone, not just slow.
  RECONNECT_ESCALATE_AFTER: 5,
  // Wall-clock ceiling on a phone that has NEVER connected, after which the
  // client stops retrying and states `mac-unreachable`. 45s: past the worst
  // honest cold start (a full subnet sweep is ~30s) but well short of the
  // forever the native shell and the PWA used to spin for, since neither can
  // reach the Safari cert escape that was the only other terminal branch.
  // A ladder cap alone can't do this -- the 30s rung repeats indefinitely.
  CONNECT_BUDGET_MS: 45_000,
  MOVE_THROTTLE_MS: 20,
  // Floor between unsolicited hostStatus pushes (battery/AC change) -- a
  // connect-time push always fires regardless, since that phone has never
  // seen a value yet.
  HOST_STATUS_THROTTLE_MS: 60_000,
  // Below this, a held-then-released mic tap is almost certainly an accidental
  // touch, not a real instruction — reject client-side before ever opening a
  // WS audio frame or spending a transcode/whisper hop on it.
  MIN_RECORDING_MS: 300,
  // Soft "still recording" nudge cadence while a mic recording is live.
  // A reminder toast only — recordings are deliberately NEVER auto-stopped
  // or capped, since long dictations are a real use case.
  RECORDING_REMINDER_MS: 120_000,
  TRANSCRIBE_TIMEOUT_MS: 150_000,
  // How long the phone's own "writing down what you said" spinner waits before
  // settling on its own. Generous next to Apple Speech's usual 1-3s: this is
  // the app-was-backgrounded backstop, not a deadline for the recognizer.
  CLIP_PHONE_TEXT_TIMEOUT_MS: 20_000,
  MAX_AUDIO_BYTES: 48 * 1024 * 1024,
  // A 2048px-long-edge JPEG at q0.85 lands ~300-500 KB; 12 MB leaves room for
  // an undownscaled fallback while still bounding memory on a route that is
  // internet-reachable once the tunnel is on.
  MAX_IMAGE_BYTES: 12 * 1024 * 1024,
  // A hidden window stays in screenshots until the window server draws one more frame.
  INK_HIDE_SETTLE_MS: 80,
  INK_SNAPSHOT_MAX_W: 1600,
  INK_SNAPSHOT_JPEG_QUALITY: 82,
  // Hands-free dictation segment boundaries. Copied from the renderer's
  // useVoiceActivity.ts VAD_TUNING, which was measured against a real room:
  // vad-web's own defaults (0.3/0.25/1400ms) never fire onSpeechEnd at all,
  // because ambient noise holds Silero's score above the exit threshold and
  // resets the redemption counter every frame. Widening the gap between the
  // two thresholds is the fix — enter on confident speech, exit as soon as
  // it's merely ambiguous.
  HANDS_FREE_VAD: {
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    /** Silence that ends an utterance. This is the "pause and it lands" feel. */
    redemptionMs: 700,
    minSpeechMs: 250,
    preSpeechPadMs: 500
  },
  /** Where the phone bundle serves the Silero model + ORT wasm from. */
  HANDS_FREE_ASSET_PATH: './vad/',
  // Move-sensitivity multiplier range (Settings slider). 1.0 = raw finger
  // delta passthrough (the original behavior); user asked to be able to turn
  // it up well past that without touching code.
  SENSITIVITY_MIN: 0.5,
  SENSITIVITY_MAX: 20,
  SENSITIVITY_DEFAULT: 1,
  MIRROR_TOUCH_HOLD_CANCEL_THRESHOLD_NORM: 0.02,
  MIRROR_TOUCH_LONG_PRESS_MS: 1000,
  MIRROR_TOUCH_SNACKBAR_REST_MS: 2000,
  CHAT_SESSION_PAGE_SIZE: 15,
  CHAT_SESSION_LIST_MAX: 150,
  // How far you drag DOWN from the top of the agent list to pull its search
  // box into view. Past the slop a flick carries, so starting a scroll never
  // reveals it by accident. Doubles as the scroll-down distance that puts it
  // away again.
  SESSION_SEARCH_PULL_PX: 64,
  CHAT_MESSAGE_MAX_CHARS: 4000,
  // Ceiling on the agent full screen's "Sending…" stand-in, for a reply that
  // never wakes anything: the pane is gone, the agent is wedged, or the text
  // landed somewhere that mints no turn. Not the normal exit -- the agent's own
  // turn starting is, and that arrives whenever it arrives. 30s because the
  // stamp comes from the shim's next report and a cold CLI can take tens of
  // seconds to answer; anything shorter gives up while the agent is waking.
  SESSION_SENDING_MAX_MS: 30_000,
  // Two taps on one swipe-deck chip inside this window send it. 350ms: past a
  // deliberate double-tap, under the pause between picking a chip and
  // changing your mind about it.
  DECK_CHIP_DOUBLE_TAP_MS: 350,
  // Preview text per row in the session picker. One line on a phone at the
  // list's font size -- long enough to recognize a thread, short enough that
  // listing a page never ships real transcript content.
  CHAT_PREVIEW_MAX_CHARS: 80,
  CHAT_TRANSCRIPT_TURN_LIMIT: 1000,
  CHAT_STEP_LIMIT: 24,
  // Off-LAN access via Cloudflare Tunnel (cloudflare-tunnel PRD). The Edge
  // Function provisions per-install; this block only holds client-side knobs
  // for the cloudflared download + process lifecycle (cloudflare-tunnel.ts).
  TUNNEL: {
    // Edge Function name (appended to CONFIG.BILLING.EDGE_FUNCTION_URL).
    FN: 'phone-remote-tunnel',
    // The public URL has no explicit port -- Cloudflare's edge terminates
    // TLS on 443 and routes into the tunnel; discovery probes need this.
    HTTPS_PORT: 443,
    // Official release assets; `latest/download` redirects to the current
    // version so we never pin one (cloudflared self-reports staleness).
    CLOUDFLARED_DOWNLOAD_BASE: 'https://github.com/cloudflare/cloudflared/releases/latest/download',
    // Older builds trust the compromised eMudhra intermediates (Cloudflare notice 2026-10-20).
    CLOUDFLARED_MIN_VERSION: '2026.10.3',
    // One Edge call per provision; generous because it does 4-5 sequential
    // Cloudflare API round-trips server-side.
    PROVISION_TIMEOUT_MS: 20_000,
    // From spawn to "Registered tunnel connection" in cloudflared's log --
    // normally ~2s; the cap only fires on a genuinely broken network.
    START_TIMEOUT_MS: 30_000,
    // Bounded crash-restart so a flapping tunnel surfaces as an honest
    // error state instead of a silent respawn loop.
    RESTART_MAX: 3,
    RESTART_BACKOFF_MS: [1_000, 3_000, 8_000],
    // Grace after SIGTERM-ing an orphaned cloudflared from a previous app
    // instance, before spawning the replacement — its edge connections need
    // a beat to deregister or the fresh child races a still-live ghost.
    REAP_SETTLE_MS: 400
  },
  // Session metering for the off-LAN path (session-meter.ts). Reports open and
  // close; the server deposits, reconciles, and reaps.
  USAGE: {
    // Edge Function name (appended to CONFIG.BILLING.EDGE_FUNCTION_URL).
    FN: 'phone-remote-usage',
    // Short and unforgiving: this fires during connect and teardown, so a hung
    // request must never hold either up. Dropping the report is fine — the
    // server-side reaper bills anything that never lands.
    TIMEOUT_MS: 4_000
  },
  MIRROR_ICE_SERVERS: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ],
  MIRROR_TURN: {
    // Edge Function name (appended to CONFIG.BILLING.EDGE_FUNCTION_URL).
    // Returns { iceServers } or a 501 when the account isn't configured.
    FN: 'phone-remote-turn',
    // Short — this is one HTTPS round-trip that gates starting the mirror,
    // so a hung request must not leave the user staring at a dead toggle.
    // On timeout we fall back to MIRROR_ICE_SERVERS and still try.
    FETCH_TIMEOUT_MS: 6_000,
    // The PHONE's deadline for the Mac's reply, and it MUST exceed the Mac's
    // own budget above or it can never be met: the Mac spends up to
    // FETCH_TIMEOUT_MS on Cloudflare, plus a Supabase getSession() that may
    // refresh a token, plus WS transit. Both ends read one 6s constant until
    // 08-11, so a slow mint made the phone give up ~2s BEFORE the credentials
    // landed -- it then negotiated STUN-only against a Mac holding a relay,
    // and every such attempt died at "connect timeout" (glasses logs, 6/7).
    CLIENT_WAIT_MS: 10_000,
    // Re-fetch creds this long before the server-side TTL (2h) expires.
    // Credentials only gate NEW connections, so a small margin is plenty.
    REFRESH_MARGIN_MS: 5 * 60_000
  },
  LIMITS: {
    /** Headline, per capped reason. The window that ran out, in user words. */
    LIMIT_TITLE: {
      daily: 'Away-from-home time is used up for today',
      weekly: 'Away-from-home time is used up for this week',
      monthly: 'Away-from-home time is used up for this month'
    },
    /** The reassurance. This is the load-bearing line: degrade, never dead-end. */
    STILL_WORKS: 'Your phone still works on your home network - nothing to do.',
    /** Shown under the title when the server told us when it comes back. */
    RESETS_PREFIX: 'More time in',
    /** Fallback when the reset time is unknown, so the row is never blank. */
    RESETS_UNKNOWN: 'More time soon.',
    /** The upgrade line. One sentence, no pressure, no price (that's the portal's job). */
    UPGRADE: 'Pro removes the limit.',
    UPGRADE_CTA: 'See Pro'
  },
  MIRROR_CAPPED_WIDTH: 1280,
  MIRROR_CAPPED_HEIGHT: 800,
  MIRROR_CAPPED_FRAME_RATE: 20,
  MIRROR_MAX_BITRATE_CAPPED: 1_500_000,
  MIRROR_MAX_BITRATE_NATIVE: 4_000_000,
  // Meta Ray-Ban Display. Its viewport is a documented, fixed 600x600 CSS px
  // (see react/cursorless-host.ts), so anything wider is discarded by the
  // downscaler after being encoded, sent, and decoded in full. 960x600 keeps
  // the Mac's 16:10 aspect while its 600px HEIGHT matches the viewport
  // exactly -- letterboxed into a square box, height is the binding edge, so
  // this is the largest size with no wasted pixel. 2.8x fewer pixels than
  // capped, which is the whole reason the glasses were dropping frames.
  // MATCH THE PANEL: 600x600 square, not a 16:10 slice of the Mac's screen.
  // The original 960x600 was picked because height is the binding edge when a
  // wide frame is letterboxed into a square -- true, and the wrong question.
  // A 16:10 frame in a 1:1 box shows only 600x375, so 960x600 encoded 576k
  // pixels to display 225k: 61% of the encoder's work was discarded before
  // anything reached the glass, which is what made H.264 emit 0.5-0.7fps.
  // 600x600 encodes 360k and displays all 360k -- 60% MORE visible picture
  // than 960x600 for 38% LESS encoding, and it fills the panel instead of
  // letterboxing. Nothing here trades quality for speed; the old number was
  // simply paying for pixels the panel never had room to show.
  //
  // RAISED TO 1200 once the panel stopped showing the desktop 1:1. The
  // reasoning above assumed the whole 600x386 frame maps onto the 600px
  // panel; cursor-follow fill zoom (~1.87x) means the panel now shows a
  // ~320px-wide SLICE of that frame blown back up to 600px, so every glyph
  // is a ~1.9x upscale of pixels already thrown away at capture. Measured as
  // small dense text (X timeline) unreadable while Slack's larger type
  // survived. 1200 makes the zoomed view roughly 1:1 source-to-panel.
  // getDisplayMedia treats these as a BOUNDING BOX, so a 16:10 desktop
  // arrives ~1200x772, not 1200x1200.
  // Tested 798 on 2026-08-12: NOT the fps lever. It collapsed identically to
  // 1200 (estimate -> 180k, target floored at 30k, 0fps), because the real
  // cause was the re-assert edge guard firing every poll. Width stays 1200
  // for the legibility reasoning above.
  MIRROR_GLASSES_WIDTH: 1200,
  MIRROR_GLASSES_HEIGHT: 1200,
  // 25, testing the 20/30 midpoint (Run 12). 30 lost twice (~7kbit/frame,
  // frozen time doubled; brake-off variant hit 29% loss) but the failure
  // was a slope, not a cliff -- 25 at ~8kbit/frame may hold. If freeze/min
  // beats ~11s on a bad link or ~6s on a good one, keep; else settle 20.
  MIRROR_GLASSES_FRAME_RATE: 25,
  // 1.5M. This constant has been wrong three times -- 1.2M, then 600k for a
  // TURN relay that does not exist, then 2.5M on the theory that the cap was
  // what held H.264 back. Raising it to 2.5M changed NOTHING: the stream still
  // collapsed 928x598 -> 464x299 on exactly the same curve, which is what
  // proved the cap was never the binding constraint. Read framesSent, not this
  // number: the Mac was emitting 0.5-0.7fps while claiming to send 928x598.
  // 2.5M, raised with the jump to 1200-wide capture: 1.5M was sized for
  // 600x386 and is ~4x too tight for the new pixel count on text, which is
  // the least compressible content we send. This is a CEILING, not a target
  // -- the measured estimate rarely clears 1M, so it only matters on the
  // link that can actually use it.
  MIRROR_MAX_BITRATE_GLASSES: 2_500_000,
  // Below this send-side estimate the glasses re-assert their encoding on
  // every stats poll. 400k: a healthy run measured 700-1000k and a collapsed
  // one parked at 180-240k for minutes, so the gap is wide and this sits in
  // it. Above the threshold nothing is written, which keeps a good stream
  // untouched.
  MIRROR_GLASSES_REASSERT_BELOW: 400_000,
  // Master switch for the dip re-assert above.
  //
  // TRUE, and now measured from both sides -- do not "clean this up".
  //
  // §9.13 turned it OFF on the theory that its keyframes caused the residual
  // ~0.5s hitches, since the estimate had been seen recovering unaided once
  // the video-mode capture swap was gone. Turning it off made things clearly
  // WORSE in the same 1200x774 config: fps 9.3->8.3 flat became 10.2->5.5
  // falling, freeze 13 events/11.9s over 80s became 9/14.3s in 39s, and
  // active fell 98-100% -> 69-72%, i.e. the stream was dead a third of the
  // time. The re-assert is not overhead the recovery tolerates; it is part of
  // what produces the recovery. Its keyframe cost is real but strictly
  // cheaper than the stall it prevents.
  // A/B 2026-08-12 16:47: six re-asserts in the live log each preceded a
  // target=30k floor within one poll, on the build where the latch is fixed.
  // The §9.13 measurement above predates that fix, so it does not cover this
  // build. Off for one run against the decoded BENCH avg; restore if worse.
  MIRROR_GLASSES_REASSERT_ENABLED: false,
  // Input-idle before the encoder goes back to 'balanced'. 800ms: long enough
  // that the gaps inside one continuous scroll don't flap the preference,
  // short enough that letting go and reading feels immediate.
  MIRROR_GLASSES_MOTION_IDLE_MS: 800,
  // Keepalive frame rate while the screen is static, in fps. 0 disables.
  //
  // getDisplayMedia emits nothing when no pixels change, so a still screen
  // drops the send rate to ~1fps -- and at that rate the glasses' Wi-Fi radio
  // power-saves between frames. Measured: rtt 75-121ms while frames flow,
  // 1744-3406ms at 1fps, same route=host/prflx. The first update after a
  // pause therefore pays a radio wake before a single byte of the new frame
  // moves, which is most of what "slow to start" is.
  //
  // 5fps of a heavily downscaled static screen is a few KB/s -- inter-frame
  // deltas of an unchanged picture are nearly empty -- and holds the radio
  // awake and the bandwidth estimate warm for the transition that matters.
  //
  // Driven from the SENDER, not a capture constraint: `{ frameRate: { min } }`
  // on getDisplayMedia throws "min constraints are not supported" and takes
  // the whole capture down with it -- an unsupported `min` is fatal there, not
  // ignored the way an unsupported `ideal` is. Non-zero enables a same-value
  // setParameters write on each idle stall-poll; 0 disables the trickle.
  // A/B 2026-08-12 16:52: 0 for one run. With the re-assert off this is the
  // last idle-time setParameters writer, and the symptom it targets (radio
  // power-save) was ruled out at 16:42 -- a floored encoder was measured at
  // rtt=24-36ms, i.e. no sleeping radio. Restore to 5 if decoded fps drops.
  MIRROR_GLASSES_TRICKLE_FPS: 0,
  // Receiver jitter buffer target on the glasses, in ms.
  //
  // 0, and it should stay 0 unless freezes prove otherwise. A buffer trades
  // latency for smoothness, and the metric here is latency to the FIRST
  // updated frame after motion starts -- a target of N ms adds N ms to every
  // frame, which is the exact quantity being optimised.
  //
  // Briefly set to 200 on the theory that rtt=2168ms meant uneven arrival
  // needing absorption. Reverted: the benches showed freeze=0-2/1.5s, i.e.
  // nothing to absorb, and Roy read the result as slow. The RTT spike is the
  // radio waking (see MIRROR_GLASSES_TRICKLE_FPS), not jitter. Raise this
  // only against a bench showing real freezes.
  MIRROR_GLASSES_JITTER_TARGET_MS: 0,
  // Video mode: retune the glasses for full-motion video instead of a desk.
  //
  // Every glasses constant above it was measured against a STILL desktop --
  // the complaint that drove them was small text being illegible, so the
  // trades all buy per-frame sharpness with frames. Watching video inverts
  // every one of those trades, and the ledger shows the cost: a Streamio
  // session on 2026-08-12 13:49 benched avg=7.5fps with freeze=20/22.6s
  // (~20% of 109s frozen), against 18.1fps / 2 freezes / 0.7s measured at
  // 11:25 the same morning on the same codec and hardware.
  //
  // MEASURED 2026-08-12 14:00, and the contentHint half is the win: stall
  // went 15-19 -> 0 in every window (frames that ARRIVED and failed to
  // decode, so this is the honest codec signal), min fps lifted 0.0 -> 1.0
  // for the first time in any glasses run, and freeze fell ~30s -> ~7s per
  // window. VP9's screen-content tooling was choking on photographic content.
  //
  // 'auto' detects video from SUSTAINED motion -- see VIDEO_SUSTAIN_MS. true
  // and false pin it on/off for a bisect. Code-only by design: the user never
  // sees a mode, so there is no setting, no toggle, and no new noun to learn.
  //
  // 'auto' cannot reach all three call sites equally, and that asymmetry is
  // the design rather than a gap in it. contentHint and the motion downscale
  // are live-writable, so auto flips them mid-session; the capture width and
  // frameRate live in a getDisplayMedia constraint, so changing them costs a
  // full re-acquire -- a black flash mid-film on every false positive. They
  // are therefore read at CAPTURE time only and follow on the next capture.
  // Since the measured win is contentHint, the live half is the half worth
  // having.
  // 'auto' parked 2026-08-12: the detector promotes on sustained INPUT
  // motion, and hands-off video playback has none -- Streamio ran a full
  // session at video=false. Forced true until detection is content-driven.
  // OFF, and this is the measured default, not a parked experiment (§9.13).
  // 'auto' re-acquires the capture ~2s after every connect (setVideoDetected
  // -> swapCapture), and that keyframe burst lands while the estimate is
  // still settling: 1032k at connect -> 192k two seconds after the swap, then
  // parked for the remaining 55s of continuous playback. Delivered fps decayed
  // 8.4 -> 5.0 and freeze grew to 44 events/48.2s.
  //
  // With it off the estimate DIPS AND RECOVERS (1180k -> 489k -> 941k -> 664k)
  // and fps holds flat 9.3 -> 8.3 across 80s, at 1200x774 -- nearly double the
  // pixels of the 640px video profile, steadier and sharper at once.
  //
  // Re-enabling means promoting WITHOUT re-acquiring the capture. The hint and
  // the capture rate must still move together (see setVideoDetected), so that
  // is a real redesign, not a flag flip.
  MIRROR_GLASSES_VIDEO_MODE: false as 'auto' | boolean,
  // How long motion must run UNBROKEN before it reads as video, in ms.
  //
  // How long the source frame rate must hold past a threshold before the mode
  // flips, in ms. Applies in BOTH directions.
  //
  // 2s: cheap to be wrong about either way, which is what makes it safe to be
  // this aggressive. A false positive costs one contentHint write -- no
  // keyframe, no re-acquire -- and reverts on the next quiet stretch. 15s was
  // tried first and is wrong: most of an opening shot in the wrong mode.
  MIRROR_GLASSES_VIDEO_SUSTAIN_MS: 2_000,
  // Source fps at or above which the screen reads as video, sustained for
  // VIDEO_SUSTAIN_MS.
  //
  // 4: measured off a Streamio session 2026-08-12, which produced 5-9fps
  // sustained (BENCH avg=5.0-9.9 over ~120s) while an idle desk sits near 0
  // and a scroll burst spikes for barely a second. 4 sits under the film and
  // over the desk, and the dwell is what rejects the burst.
  MIRROR_GLASSES_VIDEO_ON_FPS: 4,
  // Source fps below which video mode gives up, sustained for the same dwell.
  //
  // 2, not 4: equal thresholds would flap the mode on every dark or static
  // shot, and each flap is a contentHint change mid-film. The gap is the
  // hysteresis -- a film has to genuinely stop before the desk trades come
  // back.
  MIRROR_GLASSES_VIDEO_OFF_FPS: 2,
  // How often to sample the source frame rate, in ms.
  //
  // 1000: getStats is a read, so this is cheap, and it has to divide the 2s
  // dwell finely enough that the flip lands near the dwell rather than a whole
  // period late.
  MIRROR_GLASSES_VIDEO_POLL_MS: 1_000,
  // Capture framerate while video mode is on.
  //
  // 10, after 24 and then 18 both produced the SAME monotonic staircase:
  // 800x516 -> 600x387 -> 400x258 -> 300x193, the encoder paying for frames
  // it cannot afford by shrinking the picture, continuously, never finding a
  // floor. Every size change costs a keyframe, which is where the choppiness
  // actually comes from -- the 18fps run measured freeze=16/13.9s with
  // min=1.0fps while never once delivering 18fps.
  //
  // The number to beat is one window in that run: the instant the capture
  // swapped, before the slide began, it benched 800x516 avg=9.4fps min=8.0fps
  // freeze=0/0.0s -- the best window in the whole log. 10 asks for roughly
  // what that window proved the link sustains, so the encoder should HOLD
  // 800x516 rather than hunt downward for something affordable.
  //
  // Do not raise this to chase smoothness; raising it is what cost the
  // smoothness. It also matches MIRROR_GLASSES_FRAME_RATE's 12 -> 10 cut,
  // made for the same reason (docs/gotchas.md, 2026-08-12). If more is wanted
  // here, buy quality at a STABLE size -- not a bigger frame-rate request.
  MIRROR_GLASSES_VIDEO_FRAME_RATE: 10,
  // Capture width while video mode is on, in px.
  //
  // 800, not MIRROR_GLASSES_WIDTH's 1200. That 1200 exists to make small text
  // legible under cursor-follow zoom on a DESK -- a film has no small text,
  // so the extra pixels are spent and then thrown away by a 600px panel. The
  // number is not arbitrary: at 24fps the encoder degraded THROUGH 800x516
  // on its way down, i.e. it is a size this link has actually carried. Making
  // it the target rather than a waypoint means the encoder holds it with
  // headroom instead of hunting downward for something affordable.
  //
  // DORMANT while MIRROR_GLASSES_VIDEO_MODE is false -- nothing reads this
  // today. Left at 800 (not the 640 tried in §9.13) because the 640 run was
  // measured against the re-acquire bug that has since been removed, so its
  // verdict does not transfer to a future promote-without-swap design.
  MIRROR_GLASSES_VIDEO_WIDTH: 800,
  SYSTEM_AUDIO_SAMPLE_RATE: 48_000,
  SYSTEM_AUDIO_CHANNELS: 2,
  SYSTEM_AUDIO_MAX_BITRATE: 128_000,
  SYSTEM_AUDIO_MAX_BUFFER_MS: 400,
  // localStorage key for the phone's "Computer audio" toggle. Phone-local
  // like the camera/haptics prefs: whether you want the Mac's sound in THIS
  // hand right now is a property of the device, not app-wide config.
  SHARE_AUDIO_KEY: 'mm-remote-share-audio',
  // Phone mic -> Mac wire format (phone-mic-as-mac-input PRD). Mono because
  // the source is one phone microphone; a second channel would carry a
  // duplicate and double the relay bytes for nothing.
  PHONE_MIC_CHANNELS: 1,
  // Frames the capture worklet accumulates before posting. `process` fires
  // every 128 frames (~2.7ms at 48k), so posting per quantum would be ~375
  // IPC hops a second -- this trades 10ms of latency for ~10x fewer.
  PHONE_MIC_BATCH_FRAMES: 480,
  PHONE_MIC_DUCKS_SYSTEM_AUDIO: false,
  MIRROR_CONNECT_TIMEOUT_MS: 20_000,
  // How long framesSent may sit unchanged before capture is declared
  // stalled (display sleep freezes the encoder with no track event to
  // catch it -- see WebrtcCaptureApp.tsx). Two consecutive stalled polls
  // at MIRROR_STALL_POLL_MS, so a single slow tick can't false-positive.
  MIRROR_STALL_POLL_MS: 2_000,
  MIRROR_STALL_THRESHOLD_POLLS: 2,
  // 400ms: macOS mutes the capture track on app activation and recovery takes
  // ~10ms, so the phone must not paint the connecting overlay on a stall the
  // Mac is about to heal. Well above that, well under a frozen frame becoming
  // noticeable if recovery genuinely fails.
  MIRROR_STALL_OVERLAY_GRACE_MS: 400,
  // Receive-side benchmark poll (react/mirror-bench.ts). 1s because fps is a
  // per-second figure and a longer gap would average away the stutter the
  // measurement exists to catch; the BENCH summary line prints far less
  // often (below) so the journal does not fill with heartbeats.
  MIRROR_BENCH_POLL_MS: 1_000,
  MIRROR_BENCH_LOG_EVERY_N: 10,
  // Mac-side encoder stat line cadence, in 2s stall-guard polls. 2 → every
  // 4s: the tuning protocol runs 30s sessions, and at the old every-10th
  // (20s) a whole run captured ONE sample — the fps decline it exists to
  // localize fell between ticks.
  MIRROR_MAC_STATS_LOG_EVERY_N: 2,
  // Paints the live bench numbers over the top-left of the mirrored picture,
  // which is the ONLY surface readable while the glasses are actually on --
  // the dev log and the phone screen are both behind your face during a run.
  //
  MIRROR_PANE_TOP: 44,
  MIRROR_TRACKPAD_GAP: 10,
  PRO_MIRROR_PANE_TOP: 'env(safe-area-inset-top, 0px)',
  PRO_HEADER_BAND_HEIGHT: 40,
  CURSOR_STREAM_POLL_MS: 50,
  // Zoom range for the Pro mirror bar. Shared by the bar AND the pinch
  // gesture so the two can never disagree about the ceiling — tapping the
  // bar's + end and pinching all the way in land on the exact same scale.
  MIRROR_ZOOM_MIN: 1,
  MIRROR_ZOOM_MAX: 4,
  // Where a cursorless host (Ray-Ban Display) STARTS. An absolute scale on
  // the same 1..4 range the pill shows, not a multiplier. 1.0 means the
  // whole desktop fits INSIDE the 600x600 panel -- anything above it scales
  // the picture past the glass and silently loses the edges (measured as
  // vid=900x900 on a 600x600 viewport at the old 1.5 start). Zoom up from
  // here to read; cursor-follow pans across whatever is then cropped.
  MIRROR_ZOOM_CURSORLESS_BASE: 1,
  // One Neural Band swipe in the glasses' zoom mode. Multiplicative, so a
  // step feels the same at 1x and at 4x. 1.15 crosses the whole 1-4 range in
  // ~9 swipes; the Left/Right coarse pair does it in ~4.
  MIRROR_DPAD_ZOOM_STEP: 1.15,
  MIRROR_DPAD_ZOOM_STEP_COARSE: 1.4,
  // Fraction of the PANNABLE EXTENT per swipe, not px: a px step would cross
  // the desktop in 3 swipes at 1.2x and 30 at 4x.
  MIRROR_DPAD_PAN_STEP: 0.18,
  // Minimum gap between minimap aim points while a thumb is dragging. ~12/s,
  // which the tunnel carries trivially beside the video it is already
  // pushing. Safe to throttle at all only because the payload is a POSITION:
  // a dropped frame costs smoothness, never accumulated error.
  MIRROR_VIEWER_PAN_THROTTLE_MS: 80,
  // How long the minimap lingers after zoom returns to 1x. At 1x there is
  // nothing left to aim, but hiding on the instant would snatch away the very
  // frame that shows the view opening back out to the full screen -- the user
  // would see a jump, not a zoom-out. Matches SHOW_CURSOR_FADE_AFTER_MS: the
  // same "let them glance at it, then get out of the way" beat.
  MINIMAP_IDLE_HIDE_MS: 2_500,
  MINIMAP_FADE_MS: 400,
  // How long the mode pill stays up after a pinch. Shorter than the 2s touch
  // pills: this one confirms a toggle the user just made deliberately, so it
  // only has to be caught, not read twice.
  MIRROR_DPAD_MODE_TOAST_MS: 1_500,
  // Hold on the zoom knob before it locks the view to the Mac cursor. Long
  // enough that a scrub which pauses mid-track doesn't arm follow by
  // accident, short enough to still read as a deliberate press-and-hold.
  ZOOM_FOLLOW_HOLD_MS: 450,
  // Movement that cancels an in-flight hold. A finger resting on glass
  // drifts a few px, so 0 would make the hold impossible to complete; past
  // this the gesture is a scrub, not a press.
  ZOOM_FOLLOW_HOLD_SLOP_PX: 10,
  VOLUME_HOLD_MS: 450,
  // Movement that cancels the pending hold and lets the press fall through to
  // the plain mute tap. Same resting-finger drift allowance as the zoom knob.
  VOLUME_HOLD_SLOP_PX: 10,
  VOLUME_WRITE_INTERVAL_MS: 80,
  // Volume step each haptic detent marks while dragging, in percent.
  VOLUME_DETENT_STEP: 5,
  PRO_ZOOM_BAR_HEIGHT: 44,
  PRO_MIRROR_FALLBACK_HEIGHT: 260,
  // Window for the hidden skin-corner double tap (TouchpadLayout). Longer
  // than a system double-click: the target is invisible and at the screen
  // edge, so the second tap is a deliberate re-aim rather than a reflex.
  SKIN_CORNER_DOUBLE_TAP_MS: 500,
  PRO_LANDSCAPE_RAIL_WIDTH: 300,
  PRO_LANDSCAPE_PAD_MIN_WIDTH: 256,
  // Gap between the landscape mirror and the touchpad beside it. The width
  // cap subtracts this so the mirror can't grow into the gutter and close
  // it back up -- keep in sync with --pro-gutter in theme.css.
  PRO_LANDSCAPE_GUTTER: 18,
  SKIN_DEFAULT: 'proII' as const,
  COLOR_SCHEME_DEFAULT: 'light' as const,
  HANDEDNESS_DEFAULT: 'right' as const,
  // Landscape-only: which end of the touchpad column the key cluster sits at.
  // 'bottom' keeps the shipped behavior (and matches portrait), so nobody's
  // layout moves under them on upgrade — the flip is strictly opt-in.
  KEYS_POSITION_DEFAULT: 'bottom' as const,
  DECK_MODE_DEFAULT: 'stacked' as const,
  // Which split, when deck mode is 'split'. 'fan' is the only variant measured
  // with zero controls past the regrip limit — see the PRD's results table.
  SPLIT_CONCEPT_DEFAULT: 'fan' as const,
  // Portrait-only: where the mirror sits. 'stacked' is the shipped layout and
  // emits no attribute at all, so a bug in the other three can never reach a
  // user who hasn't opted in.
  MIRROR_PLACEMENT_DEFAULT: 'stacked' as const,
  PRO_SPLIT_MAX_CLUSTER_FRAC: 0.42,
  APP_RING_DEFAULT: false,
  // Ring band width, and how far it sits outside the cluster's carve. The
  // band has to clear a fingertip (~44px is the tap-target floor) while
  // leaving the pad the drag area it exists for.
  APP_RING_BAND_PX: 46,
  APP_RING_GAP_PX: 8,
  // Ceiling on the radius, as a fraction of the pad's shorter side. Keeps the
  // arc a ring in its corner instead of a stripe across the drag area.
  APP_RING_MAX_PAD_FRAC: 0.42,
  // Most slots the arc will divide itself into. Past this a slot is narrower
  // than a fingertip, so the list windows instead of shrinking further —
  // same cap logic as QuickSwitchOverlay's MAX_VISIBLE, one axis over.
  APP_RING_MAX_SLOTS: 9,
  APP_RING_ICON_PX: 22,
  APP_RING_ICON_PEAK_PX: 40,
  // Resting icons sit at this until the thumb nears them. 0.35 read as
  // greyed-out rather than idle -- the icons are the whole point of the ring,
  // so they must be identifiable BEFORE the finger arrives (Roy, on device).
  APP_RING_ICON_REST_OPACITY: 0.7,
  APP_RING_ICON_PEAK_OPACITY: 1,
  APP_RING_FALLOFF_PX: 64,
  // The picked app, drawn again at readable size just off the band. The icon
  // ON the band sits under the thumb that picked it, so the confirmation the
  // ring already had was the one thing a finger covers.
  APP_RING_POPOUT_PX: 76,
  // Clearance from the band's outer edge to the preview's near edge. Roughly
  // a fingertip, so the thumb resting on the band never reaches it.
  APP_RING_POPOUT_GAP_PX: 26,
  // The app name's pill. Generous ratio on purpose: a pill wider than its
  // text reads fine, a narrow one clips the name.
  APP_RING_LABEL_FONT_PX: 14,
  APP_RING_LABEL_GLYPH_RATIO: 0.62,
  APP_RING_LABEL_PAD_X: 12,
  APP_RING_LABEL_HEIGHT_PX: 26,
  // Preview edge to pill edge — enough that they read as two objects.
  APP_RING_LABEL_GAP_PX: 12,
  APP_RING_DWELL_MS: 180,
  APP_RING_ICON_STAGGER_MS: 28,
  APP_RING_SUMMON_ARC_PX: 150,
  // How far outside the band that trace may wander before it's abandoned.
  // The finger is tracing a band it cannot see yet, so holding it to the
  // painted stroke width alone would make the gesture a guess.
  APP_RING_SUMMON_SLACK_PX: 28,
  APP_RING_GRAB_SLACK_PX: 18,
  APP_RING_DISMISS_HOLD_MS: 450,
  // Ceiling on the dismiss zone, as a fraction of the arc. The zone itself is
  // derived per slot count (ringDismissZoneT) so it always ends BELOW slot 0
  // — as a flat value it swallowed the first icon from five apps up.
  APP_RING_DISMISS_ZONE_MAX_T: 0.12,
  APP_RING_REFRESH_IDLE_MS: 15_000,
  // The zoom track: an outer ring that scrubs the picture on connected
  // glasses. Independent of the app ring (which is off by default), and sits
  // outside it when both are up. Narrower than APP_RING_BAND_PX because it
  // carries a knob rather than a row of icons, and every px of radius here
  // comes off the pad's usable drag area.
  RING_ZOOM_BAND_PX: 34,
  // Clearance between the two painted strokes. Set on device (Roy): the two
  // arcs must read as separate controls, not one thick band. Still smaller
  // than the SUM of the two bands' grab slack, so the hit regions overlap in
  // the seam -- the outer one takes a touch there by radius, which is why
  // RING_ZOOM_GRAB_SLACK_PX shrinks the zoom track's own slack to fit inside.
  RING_ZOOM_GAP_PX: 14,
  // The zoom track's grab slack, replacing APP_RING_GRAB_SLACK_PX on that
  // band alone. Strictly under RING_ZOOM_GAP_PX so the tolerance stops inside
  // the gap: with the strokes this close, the app ring's painted stroke is
  // where the eye aims at an app icon, and the outer band wins ties by radius
  // -- full slack here would take those touches. ring-zoom.test.ts locks it.
  RING_ZOOM_GRAB_SLACK_PX: 4,
  // The knob's diameter. Wider than the band it rides so it reads as an
  // object ON the track rather than a lit segment OF it.
  RING_ZOOM_KNOB_PX: 40,
  // How far from the knob a touch may land and still grab it. Same role as
  // ZoomBar's KNOB_GRAB_PX, measured along the arc instead of across a bar.
  RING_ZOOM_GRAB_ARC_PX: 44,
  // The multiplier, drawn again off the band while scrubbing -- the app ring's
  // popout for the same reason: the knob is under the thumb that grabbed it,
  // so the one thing the control reports is the one thing a finger covers.
  // Smaller than APP_RING_POPOUT_PX: it carries two glyphs, not an app icon.
  RING_ZOOM_POPOUT_PX: 56,
  // Arc px kept clear at EACH end of the zoom track. The quarter runs corner
  // to corner, so t=0/t=1 sit flush on the pad edges the radius is capped
  // against, leaving half the 40px knob off the pad -- measured 20px over at
  // minimum zoom. Just over the knob's radius, so it clears with a hair.
  RING_ZOOM_END_INSET_PX: 24,
  // Smallest zoom change worth sending. The glasses' link idles at 247-597ms
  // RTT with the radio power-saving between frames, so a packet per touchmove
  // buys nothing a coarser step doesn't -- and 0.02x is already below what
  // the eye resolves on a 600px panel.
  RING_ZOOM_MIN_STEP: 0.02,
  // The scroll rail: a strip on the HANDEDNESS edge, above the cluster, so
  // the thumb never crosses the pad. Summoned by drawing a line down it.
  // Width of the edge strip a summon may START in, and the island's own
  // width once it's up. ~44 is the tap-target floor, same reasoning as
  // APP_RING_BAND_PX.
  RAIL_STRIP_PX: 44,
  // Rub-to-mirror: a one-finger left-right-left scrub along the pad's top
  // edge toggles screen share. Depth of the band a rub may start and stay
  // in -- deeper than a tap target because the rub is a whole stroke, not a
  // point, but shallow enough that ordinary cursor work lower down can
  // never reach it.
  RUB_BAND_PX: 90,
  // Vertical drift that kills a rub. A rub is horizontal by definition; a
  // finger climbing this far is drawing something else.
  RUB_DRIFT_PX: 55,
  // Travel one direction needs before it counts as a leg. Below this a
  // jittery hold would manufacture reversals out of noise.
  RUB_LEG_PX: 34,
  // Legs required to fire: 3 == left-right-left (2 direction reversals).
  // Two would fire on any back-and-forth correction during a normal drag.
  RUB_LEGS: 3,
  // How long the whole rub may take. A rub is fast; stretching the window
  // lets a slow meandering drag accumulate legs by accident.
  RUB_WINDOW_MS: 900,
  // How far a summon trace may wander horizontally before it's abandoned --
  // same role as APP_RING_SUMMON_SLACK_PX, one axis over.
  RAIL_STRAY_PX: 30,
  // Vertical travel one direction needs before it counts as a summon leg.
  // Matches RUB_LEG_PX: the same thumb draws both, so the scrub that toggles
  // the mirror and the one that raises the rail ask for the same motion.
  RAIL_SUMMON_LEG_PX: 34,
  // Legs required to raise the rail: 3 == up-down-up (2 direction reversals).
  // Two would fire on any back-and-forth correction during a normal drag, and
  // a false positive steals a live cursor drag -- so this grows, never shrinks.
  RAIL_SUMMON_LEGS: 3,
  // How long the whole scrub may take. Stretching the window lets a slow
  // meandering drag near the edge accumulate legs by accident.
  RAIL_SUMMON_WINDOW_MS: 900,
  // Fraction of the rail's own height each end's rate zone claims. The
  // middle (1 - 2x this) stays ~1:1.
  RAIL_RATE_ZONE_FRAC: 0.2,
  // Continuous-scroll speed range at the rate zone's near/far edge, px/sec
  // fed into the same applyScrollDelta pipe a drag already uses.
  RAIL_RATE_MIN_PX_S: 80,
  RAIL_RATE_MAX_PX_S: 900,
  // How often the rate zone synthesizes a tick while the thumb holds still.
  RAIL_RATE_TICK_MS: 16,
  // Breathing room between the island's bottom and the topmost cluster
  // button. They share a side, so with 0 the ✕ sits against the keys and a
  // thumb reaching for one grazes the other.
  RAIL_CLUSTER_GAP_PX: 12,
  // Along-rail travel, in px, before the knob commits to a direction. Below
  // this a held thumb's own jitter flickers the chevron between up and down.
  RAIL_KNOB_DIR_PX: 3,
  SHOW_CURSOR_DEFAULT: true,
  // How long the pointer lingers after the finger stops before fading out.
  // Long enough to glance at, short enough that a resting finger doesn't
  // leave a pointer parked on the touchpad indefinitely.
  SHOW_CURSOR_FADE_AFTER_MS: 2500,
  // Fade duration itself — a soft dissolve rather than a pop, matching the
  // touchDot's own transition feel.
  SHOW_CURSOR_FADE_MS: 400,
  TRAIL_MAX_POINTS: 14,
  // Minimum px between sampled points. Without it, a resting finger emits
  // dozens of touchmove events at the same spot and the whole trail collapses
  // into one dark blob under the pointer.
  TRAIL_MIN_SAMPLE_PX: 4,
  // How long a point survives after the finger stops. Slightly shorter than
  // the pointer's own fade so the tail clears first and the pointer is the
  // last thing to go — a tail outliving its head reads as a bug.
  TRAIL_POINT_TTL_MS: 600,
  // Head/tail size in px. The newest point is TRAIL_DOT_MAX_PX and the oldest
  // TRAIL_DOT_MIN_PX, interpolated across the list.
  TRAIL_DOT_MAX_PX: 26,
  TRAIL_DOT_MIN_PX: 7,
  TRAIL_COLOR_TAIL: { h: 32, s: 14, l: 47 },
  TRAIL_COLOR_HEAD: { h: 25, s: 70, l: 59 }
})
