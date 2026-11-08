import { pickByEnv, IS_DEV, IS_DEVTEST, instancePort, envVar, readAppEnv } from './env'
import type { MightyRunSource, ModelCatalogEntry, PermissionKey, QuickAction } from './types'
import { RELEASE_NOTES } from './config/release-notes'
import { buildPhoneRemote } from './config/phone-remote'
import { buildUiLabels } from './config/ui-labels'
import { THEME_TOKENS } from './config/theme-tokens'

// ── Supabase environments ────────────────────────────────────────────────────
// Two fully isolated projects so test traffic never touches prod data:
//   • staging — dev builds (npm run dev). Stripe SANDBOX keys live here.
//   • prod    — packaged builds. Stripe LIVE keys live here.
// pickByEnv(staging, prod) selects by IS_DEV, so a dev build can NEVER hit the
// prod project and a shipped build can NEVER hit staging. Anon keys are public
// by design (RLS-gated); the service_role key never ships in a desktop app.
// Each project carries its OWN Stripe secret + webhook secret in its Edge
// secrets — set via `supabase secrets set --project-ref <ref>`, never here.
// Exported so the web portal (a separate Vite app) can select its Supabase
// project by its OWN build flag (VITE_PORTAL_ENV) instead of IS_DEV — the desktop
// app keys env off dev/packaged, the portal keys it off which URL you deploy. Both
// read the same single source here, so the refs + public anon keys never drift.
export type SupabaseEnvName = 'staging' | 'prod'
export type SupabaseEnv = {
  NAME: SupabaseEnvName
  REF: string
  ANON_KEY: string
  DECIDE_URL: string
  AGENT_SIGN_URL: string
}
export const SUPABASE_ENVS: Record<SupabaseEnvName, SupabaseEnv> = {
  staging: {
    NAME: 'staging',
    REF: 'nyfzsxuslvceajlxmvry',
    DECIDE_URL: 'https://mightymouse-decide-staging.techguyver1337.workers.dev',
    AGENT_SIGN_URL: 'https://mightymouse-agent-sign-staging.techguyver1337.workers.dev',
    ANON_KEY:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55ZnpzeHVzbHZjZWFqbHhtdnJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxOTcwNDMsImV4cCI6MjA5NTc3MzA0M30.EvljnMIt7bg-TKiyvu87YwJ0njL_D0tfvtHEp-bQDCo'
  },
  prod: {
    NAME: 'prod',
    REF: 'czylhdjjfsxyltvgnnyh',
    DECIDE_URL: 'https://mightymouse-decide.techguyver1337.workers.dev',
    AGENT_SIGN_URL: 'https://agent.getmightymouse.com',
    ANON_KEY:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6eWxoZGpqZnN4eWx0dmdubnloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxODUzNDAsImV4cCI6MjA5NTc2MTM0MH0.B_jqHJM4bACKLs3H6_58fVTFz6-xL16hGpy-ynDWAD0'
  }
}

const APP_ENV_OVERRIDE = readAppEnv() as SupabaseEnvName | undefined
const RESOLVED_ENV: SupabaseEnvName =
  APP_ENV_OVERRIDE === 'staging' || APP_ENV_OVERRIDE === 'prod'
    ? APP_ENV_OVERRIDE
    : pickByEnv('staging', 'prod')

// The active project — staging in dev (or a staging-flagged packaged build),
// prod otherwise.
const SUPABASE_ENV = SUPABASE_ENVS[RESOLVED_ENV]
const SUPABASE_URL = `https://${SUPABASE_ENV.REF}.supabase.co`

const IS_STAGING_BUILD = RESOLVED_ENV === 'staging'
const STYLES_URL = IS_STAGING_BUILD ? 'https://mightymouse-portal-staging.pages.dev/styles' : 'https://app.getmightymouse.com/styles'
const PLAYBOOKS_URL = IS_STAGING_BUILD ? 'https://mightymouse-portal-staging.pages.dev/playbooks' : 'https://app.getmightymouse.com/playbooks'
const MOD_LINK_URL = IS_STAGING_BUILD ? 'https://mightymouse-portal-staging.pages.dev/m' : 'https://app.getmightymouse.com/m'
const APP_NAME_BASE = 'MightyMouse'

const BRAND_SLUG = APP_NAME_BASE.toLowerCase()
// GitHub owner/repo the auto-updater and Admin release tab read. Public, no auth.
const RELEASES_REPO = `royherma/${BRAND_SLUG}-releases`

export const CONFIG = {
  // App Branding & Identity (Edit here to rename the app)
  APP_NAME: IS_DEVTEST ? `${APP_NAME_BASE} Dev Test` : IS_STAGING_BUILD ? `${APP_NAME_BASE} Staging` : APP_NAME_BASE,
  BRAND_NAME: IS_DEVTEST ? `${APP_NAME_BASE} Dev Test` : IS_STAGING_BUILD ? `${APP_NAME_BASE} Staging` : APP_NAME_BASE,
  BRAND_ICON: '🐭',
  // The PRODUCT, never this build. Use in copy that names the thing the user
  // bought ("ask MightyMouse for help", the built-in model's label) — BRAND_NAME
  // there renders "MightyMouse Staging" and reads like a separate product.
  // BRAND_NAME stays for copy that must identify WHICH build is running.
  PRODUCT_NAME: APP_NAME_BASE,
  // Display name of the SHIPPED iPhone app, which has one name in both envs --
  // a staging Mac build still pairs with an app called "MightyMouse". Use where
  // the copy names that app rather than this build (the paired-devices row).
  IOS_APP_NAME: APP_NAME_BASE,
  // Lowercase identifier form of the brand (no " Staging" suffix) — for URLs,
  // slugs, and subaddresses. Display copy uses BRAND_NAME instead.
  BRAND_SLUG,
  // Public releases feed. RELEASE_PAGE is where "Get update" sends the user;
  // RELEASE_LATEST_API is the JSON the Admin dashboard reads for latest-vs-installed.
  RELEASE_PAGE_URL: `https://github.com/${RELEASES_REPO}/releases/latest`,
  RELEASE_LATEST_API: `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`,
  // Keep in sync with package.json "version". Shown in Settings footer.
  APP_VERSION: '0.55.0',

  // mightymouse:// in prod/dev; mightymouse-staging:// in a staging packaged build
  // (registered in main/index.ts, matched in deeplink.ts — read PROTOCOL_SCHEME
  // from there, never hardcode 'mightymouse').
  PROTOCOL_SCHEME: IS_DEVTEST ? `${BRAND_SLUG}-devtest` : IS_STAGING_BUILD ? `${BRAND_SLUG}-staging` : BRAND_SLUG,

  SUPABASE: {
    URL: SUPABASE_URL,
    ANON_KEY: SUPABASE_ENV.ANON_KEY
  },
  ENV_NAME: SUPABASE_ENV.NAME as 'staging' | 'prod',
  IS_STAGING: SUPABASE_ENV.NAME === 'staging',
  WEB_CHAT_URL:
    SUPABASE_ENV.NAME === 'staging'
      ? 'https://mightymouse-portal-staging.pages.dev/chat'
      : 'https://app.getmightymouse.com/chat',

  ADMIN_EMAILS: [
    'dev@example.com',
    'dev2@example.com',
    'test-admin@staging.local',
    'test-admin-2@staging.local',
    'test-admin-3@staging.local'
  ],

  // Dogfooding accounts that aren't admins. Filtered out of analytics alongside
  // ADMIN_EMAILS so internal traffic never inflates the funnel.
  INTERNAL_EMAILS: ['internal@example.com'] as string[],

  // Seeded staging admins, each with its own credit balance and history — so a
  // test that exhausts one account's limits continues on the next. Not real
  // mailboxes, so they can't do magic-link; the password flow is the only way in.
  STAGING_TEST_ADMINS: [
    {
      EMAIL: 'test-admin@staging.local',
      PASSWORD: envVar('MM_STAGING_TEST_PASSWORD') ?? ''
    },
    {
      EMAIL: 'test-admin-2@staging.local',
      PASSWORD:
        envVar('MM_STAGING_TEST_PASSWORD_2') ?? ''
    },
    {
      EMAIL: 'test-admin-3@staging.local',
      PASSWORD:
        envVar('MM_STAGING_TEST_PASSWORD_3') ?? ''
    }
  ],

  // Homebrew lives at a different prefix per architecture. Probe Apple Silicon
  // first — Intel Macs are the minority now and an Apple Silicon Mac never has
  // the Intel path. Used to install the capture helper tools (ffmpeg/whisper).
  BREW_PATH: {
    appleSilicon: '/opt/homebrew/bin/brew',
    intel: '/usr/local/bin/brew'
  },
  // Where we send a user who has no Homebrew at all.
  BREW_INSTALL_URL: 'https://brew.sh',

  CLAUDE_PATH: '',
  CLAUDE_MODEL: 'opus',
  CLAUDE_MODEL_FALLBACKS: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  CLAUDE_FAST_MODEL: 'sonnet',
  CLAUDE_FAST_MODEL_FALLBACKS: ['claude-sonnet-5-5'],
  CODEX_PATH: '',
  CODEX_MODEL: '',
  CODEX_MODEL_FALLBACK: 'codex-default',
  CODEX_REASONING_EFFORT: 'low',
  OPENCODE_PATH: '',
  OPENCODE_MODEL: 'openrouter/anthropic/claude-sonnet-5.5',
  OPENROUTER_DEFAULT_MODEL: 'anthropic/claude-sonnet-5.5',
  OPENCODE_FAST_MODEL: 'openrouter/anthropic/claude-fable-5.1',
  // gemini's `auto` model selection was unreliable/slow-to-hang in headless runs
  // during testing — always pass an explicit -m, never leave it empty.
  GEMINI_PATH: '',
  GEMINI_MODEL: 'gemini-3.1-pro',
  GEMINI_FAST_MODEL: 'gemini-3-flash',
  // Ollama has no CLI binary to resolve — it's a background HTTP service. Base
  // URL is fixed (Ollama always binds 11434 locally, no auth); OLLAMA_MODEL is
  // the user's chosen pulled model, empty until they pick one in Settings.
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  OLLAMA_MODEL: '',
  // 32768 caps VRAM paging vs some models' full window (up to 262144).
  OLLAMA_NUM_CTX_MAX: 32768,
  OLLAMA_KEEP_ALIVE: '30m',
  OLLAMA_STARTER_MODEL: 'qwen3.5:9b',
  CODE_PROVIDER_NPM: {
    claude: '@anthropic-ai/claude-code',
    codex: '@openai/codex',
    opencode: 'opencode-ai'
  },
  CODE_PROVIDER_SETUP_COPY: {
    claude: 'Anthropic’s coding agent',
    codex: 'OpenAI’s coding agent',
    opencode: 'Use almost any model',
    cursor: 'Use your Cursor plan',
    ollama: 'Free and private, runs on this Mac',
    installing: 'Installing',
    starting: 'Starting',
    downloading: 'Downloading a model',
    failed: "Couldn't finish. Click to try again."
  },
  // Rapid-MLX (the `mlx` backend) is a local OpenAI-compatible HTTP server on Apple
  // Silicon — like Ollama, no CLI binary to resolve, no auth. Default port 8000.
  // MLX_MODEL is the user's chosen served-model alias, empty until picked in Settings.
  RAPIDMLX_BASE_URL: 'http://127.0.0.1:8000',
  RAPIDMLX_MODEL: '',
  SCREENCAPTURE_PATH: '/usr/sbin/screencapture',
  // The picker badges this one "Recommended" and needs no install. Defaulting to
  // `claude` instead pre-selected a CLI the user has to install themselves, so a
  // non-technical first-run hit "Claude CLI not found" having never chosen Claude.
  DEFAULT_BACKEND: 'mightymouse' as const,

  MODEL_CATALOG_FN: 'model-catalog',
  MODEL_CATALOG_REFRESH_MS: 6 * 60 * 60 * 1000,
  MODEL_CATALOG: [
    { id: 'anthropic/claude-opus-5.5', label: 'Opus 5.5', tier: 'premium' as const },
    { id: 'anthropic/claude-sonnet-5.5', label: 'Sonnet 5.5', tier: 'mid' as const },
    { id: 'anthropic/claude-fable-5.1', label: 'Fable 5.1', tier: 'premium' as const },
    { id: 'anthropic/claude-haiku-5.5', label: 'Haiku 5.5', tier: 'cheap' as const },
    { id: 'openai/gpt-6-astra', label: 'GPT-6 Astra', tier: 'premium' as const },
    { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', tier: 'mid' as const },
    { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', tier: 'mid' as const },
    { id: 'z-ai/glm-5.3', label: 'GLM 5.3', tier: 'cheap' as const },
    { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', tier: 'cheap' as const },
    { id: 'moonshotai/kimi-k3', label: 'Kimi K3', tier: 'premium' as const },
    { id: 'qwen/qwen3.8-max-0902', label: 'Qwen 3.8 Max', tier: 'mid' as const },
    { id: 'x-ai/grok-4.7', label: 'Grok 4.7', tier: 'mid' as const },
    { id: 'meta/muse-wonder', label: 'Muse Wonder', tier: 'premium' as const }
  ] as ModelCatalogEntry[],

  // Short price-tier hint shown next to a model in the dropdown. Copy lives here so
  // the label never drifts. No exact $ — pricing is server-controlled (billing_config).
  MODEL_TIER_LABEL: {
    cheap: 'Budget',
    mid: 'Balanced',
    premium: 'Top'
  } as Record<'cheap' | 'mid' | 'premium', string>,

  BACKEND_META: {
    mightymouse: {
      label: `${APP_NAME_BASE} API`,
      tip: `You’re using the official ${APP_NAME_BASE} API. The AI behind your answers.`
    },
    claude: { label: 'Claude', tip: 'You’re using your own Claude. The AI behind your answers.' },
    codex: { label: 'Codex', tip: 'You’re using your own Codex. The AI behind your answers.' },
    opencode: {
      label: 'OpenCode',
      tip: 'You’re using your own OpenCode. The AI behind your answers.'
    },
    gemini: { label: 'Gemini', tip: 'You’re using your own Gemini. The AI behind your answers.' },
    local: {
      label: 'Local',
      tip: 'Runs fully offline on your machine via Ollama. Nothing leaves your computer.'
    },
    openrouter: {
      label: 'OpenRouter',
      tip: 'You’re using your own OpenRouter key. The AI behind your answers.'
    },
    mlx: {
      label: 'Rapid-MLX',
      tip: 'Runs fully offline on your Mac via Rapid-MLX. Fast Apple Silicon models. Nothing leaves your computer.'
    }
  } as Record<string, { label: string; tip: string }>,

  BACKEND_CHECK: {
    installed: { label: 'CLI installed', reason: 'CLI not found' },
    loggedIn: { label: 'Logged in', reason: 'is not logged in' },
    signedIn: { label: 'Signed in', reason: 'needs you to sign in' },
    balance: {
      label: 'Balance',
      reason: 'is out of credits',
      provisioning: 'Adding your free usage'
    },
    serviceRunning: { label: 'Service running', reason: "isn't running" },
    modelSelected: { label: 'Model selected', reason: 'has no model selected' },
    apiKey: { label: 'API key', reason: 'needs an API key' }
  } as const,

  // Mode display metadata — the ONE home for the mode-badge tooltip. Keys must
  // match the AppMode union ('rewrite' | 'ask' | 'act'). The badge cycles in this
  // order on click / Shift+Tab. One short line each (see Voice & copy in CLAUDE.md).
  MODE_META: {
    rewrite: { label: 'Fix my text', tip: 'Rewrites your text in place.' },
    ask: { label: 'Answer me', tip: 'Answers a question about your screen.' },
    act: { label: 'Do it for me', tip: 'Does a task for you.' }
  } as Record<string, { label: string; tip: string }>,

  // Seeded into rewrite-actions.json the first time it's missing. Empty on
  // purpose: the old default Transcribe pill read as a "transcribe the selection"
  // button and confused new users. Users own the file after the seed.
  DEFAULT_QUICK_ACTIONS: [] as QuickAction[],
  // Key of that retired seed — purged from existing installs on load.
  RETIRED_QUICK_ACTION_KEYS: ['default-transcribe'],

  RUN_TIMEOUT_MS: {
    rewrite: 60_000,
    ask: 60_000,
    act: 300_000,
    // Fast Haiku intent-classify call for history recall — short ceiling so a slow
    // classify never delays the answer; on expiry we fall back to a normal ask.
    recall_classify: 3_000
  } as Record<string, number>,

  // Interactive act's wedge detector: kill if the CLI streams NOTHING for this
  // long, well under RUN_TIMEOUT_MS.act so a dribbling/hung run doesn't eat the
  // full 300s before anyone finds out. Resets on every parsed event (runner.ts).
  ACT_STALL_MS: 90_000,

  ACT_HIGHLIGHT: {
    DURATION_MS: 1600,
    BOX_SIZE_PX: 110
  },

  AGENT_CURSOR: {
    MIN_MS: 280,
    MAX_MS: 1100,
    MS_PER_SQRT_PX: 22,
    ENTER_MS: 420,
    ENTER_OFFSET_PX: 60,
    ARC_MIN: 0.08,
    ARC_MAX: 0.2,
    OVERSHOOT_MIN_PX: 220,
    OVERSHOOT_RATIO: 0.03,
    OVERSHOOT_MAX_PX: 14,
    SETTLE_MS: 140,
    PRESS_MS: 110,
    MAX_TILT_DEG: 10,
    RIPPLE_MS: 500,
    CARET_BLINK_MS: 1000,
    FADE_MS: 200,
    IDLE_HIDE_MS: 60_000,
    PULSE_MS: 1600
  },

  CANVAS: {
    MODEL: 'groq/openai/gpt-oss-20b',
    TIMEOUT_MS: 15_000,
    MAX_CHATS: 40,
    MAX_BUBBLES: 80,
    MAX_FOLDERS: 60,
    THINK_PROMPT:
      'You file one new note on a person\'s idea canvas. You get the note, their projects, their recent chats and the notes already on the canvas. ' +
      'Reply with JSON only, no prose, in exactly this shape: ' +
      '{"action":"continue|chat|note","planet":"<a project id, or sandbox>","guesses":["<project id>"],"tags":["3 to 6 short lowercase words"],"related":[{"id":"<existing note id>","why":"<3 to 6 words>"}],"session":{"id":"<chat id>","why":"<3 to 6 words>"} or null,"directions":["three next moves"]}. ' +
      'planet: the project this note is clearly about. A project goes by every name in its about (product name, folder, repo) and holds the folders listed in its inside, so a note naming any of them belongs there, even when a word is misspelled or cut short. Also use what its recent chats are about. Sandbox when none clearly fits, and always sandbox for a short or vague note with no clear subject ("make it cheaper"). guesses: only when planet is sandbox - up to 3 project ids the note could be about, most likely first; [] when nothing points to any project. related: 0 to 3 existing notes with a real connection, never a vague one. ' +
      'session: only a chat this note clearly continues. A note that points back ("those", "that", "it", "again", "the X") continues the most recent chat (lowest minutesAgo) on the same subject. ' +
      'action: continue when session is set and the note adds to that chat; chat when the note asks or tells the AI to do, answer, find, write or make something - a command ("start the server", "fix the login", "run the tests") is always chat, even when no project fits; note only when it is a thought, idea or personal to-do the AI cannot do for them ("book a dentist" is a note). ' +
      'directions: 3 different, concrete next moves, each under 12 words, in plain words.',
    DIRECTIONS_PROMPT:
      'Someone is moving an idea forward one step at a time. Given the idea and the steps taken so far, give exactly 3 different, concrete next moves, each under 12 words, in plain words. ' +
      'Reply with JSON only: {"directions":["...","...","..."]}'
  },
  SELECTION_BAR: {
    // Deprecated: false kills the watcher, the ⌘⌥⇧T key and the Settings section.
    ENABLED: false,
    // Inner pill. Window is this plus PAD on every side (shadow + radius slack).
    // WIDTH is the starting/fallback width; the bar measures its own content on
    // show and asks main to resize between MIN and MAX. Chips absorb all of the
    // shrink — the gear and context toggle stay fully visible at every size.
    WIDTH: 400,
    MIN_WIDTH: 280,
    MAX_WIDTH: 760,
    HEIGHT: 38,
    PAD: 14,
    // Tall enough for the open gear menu (two rows + padding). The window grows
    // to this only while the menu is open, then snaps back to HEIGHT.
    MENU_HEIGHT: 154,
    // Sits ABOVE the mouse-up point so it never covers the text just selected.
    OFFSET_Y: 58,
    // A drag ends with mouseup, but AXSelectedText lags the release in most apps
    // — reading immediately returns the PREVIOUS selection. 180ms is the shortest
    // delay that read correctly in Chrome, Safari, Notes, and VS Code.
    SETTLE_MS: 180,
    // A bar over zero characters has nothing to act on, so it never shows.
    MIN_CHARS: 1,
    // Above this, AX reads of huge selections get slow enough to feel broken.
    MAX_CHARS: 100_000,
    // A chip's title is truncated to this so a long user-authored one can't push
    // the gear off the fixed-width bar.
    MAX_LABEL_CHARS: 12,
    // Menu chrome (speed rows + divider + Add/Reset), then one of these per chip,
    // then this again when the editor is open. Drives the window height.
    MENU_ROW_HEIGHT: 28,
    EDITOR_HEIGHT: 110,
    // The bar is an offer, not a mode: unclaimed, it leaves on its own. Hovering
    // pauses the countdown, so reading the chips never costs you the bar.
    AUTO_HIDE_MS: 6_000,
    // Only a seed. Once a default is deletable, restoring these on an empty file
    // would resurrect every chip the user removed.
    DEFAULT_ACTIONS: [
      {
        key: 'fix',
        label: 'Fix',
        instruction:
          'Fix the spelling and grammar. Keep the wording and tone exactly as they are otherwise.'
      },
      {
        key: 'shorten',
        label: 'Shorter',
        instruction: 'Make this shorter and tighter. Keep every point, cut the filler.'
      },
      {
        key: 'improve',
        label: 'Improve',
        instruction: 'Rewrite this so it reads better. Keep my voice and the same meaning.'
      },
      { key: 'ask', label: 'Ask', instruction: null }
    ] as { key: string; label: string; instruction: string | null }[],
    // Direct Groq 2026-08-16: 328-462ms total vs gemini-2.5-flash 700ms through OpenRouter.
    // Must match the proxy allowlist + price map (migration 0082, llm-proxy
    // GROQ_PRICES_PER_M). Groq retired llama-3.1-8b-instant and every Fast run
    // 404'd; the cloud side moved and this constant was left behind.
    FAST_MODEL: 'groq/openai/gpt-oss-20b',
    // ~4x the measured warm round-trip, so a slow day still lands rather than
    // falling back to the panel.
    FAST_TIMEOUT_MS: 15_000,
    // Long enough to read the ✓ over the freshly pasted text, short enough that
    // the bar isn't sitting in the way once the user looks back at their doc.
    DONE_LINGER_MS: 900,
    // The result preview: taller than the pill because it shows the whole rewrite.
    // The text area inside scrolls at 240px, so this is that plus the button row.
    PREVIEW_HEIGHT: 320,
    // The bar's own History list. Six is what fits under the bar without the list
    // becoming a screen to read — this surface answers "where did that one go",
    // not "show me everything" (the panel's flyout is still the full record).
    HISTORY_ROWS: 6,
    // Two lines per row (what was asked, what came back) plus the gap.
    HISTORY_ROW_HEIGHT: 46,
    // Header + empty-state line, before any rows are added on.
    HISTORY_CHROME: 56,
    // The Ask row's question field, on top of the bar's own 40px.
    ASK_HEIGHT: 44,
    // Recent one-off prompts, offered under the Ask field. Four fits under the
    // bar without the stack becoming its own screen to read.
    MAX_RECENT_PROMPTS: 4,
    // A recent prompt is a whole sentence, so it gets a far longer leash than a
    // chip label — it is read, not glanced at.
    MAX_RECENT_CHARS: 80,
    // One recent row, matching the menu's rows so the two stacks line up.
    RECENT_ROW_HEIGHT: 28,
    // Drives the progress bar's curve only — the run is not cut off here.
    // Measured warm round-trip through llm-proxy 2026-08-16.
    FAST_EXPECTED_MS: 3_400,
    // The user's own CLI pays process startup on top of the model, so it gets a
    // longer leash than the hosted path.
    OWN_TIMEOUT_MS: 45_000,
    // Curve only, same as FAST_EXPECTED_MS: a warm CLI rewrite lands well inside
    // OWN_TIMEOUT_MS, so pacing to the ceiling would crawl.
    OWN_EXPECTED_MS: 9_000
  },

  ACT_CONTROL: {
    SOCKET_NAME: 'mm-act-control.sock',
    POINTER_NAME: 'mm-act-control.path'
  },

  PREWARM_IDLE_REFRESH_MS: 5 * 60_000,

  SPARES: {
    MAX: 3,
    RECYCLE_MS: 30 * 60_000
  },

  AUTH_INIT_TIMEOUT_MS: 8_000,

  ONBOARDING_GATE_TIMEOUT_MS: 4_000,
  AUTH_RESEND_COOLDOWN_S: 30,
  // How long the green "Granted ✓" beat holds before the wizard auto-advances
  // to the next step. Long enough to register as feedback, short enough that it
  // never feels like waiting.
  ONBOARDING_ADVANCE_MS: 900,
  SETUP_POLL_MS: 3_000,

  TOUR_UNLOCK_MS: 8_000,
  // The phone-pairing step's own unlock window. ~3x the hotkey one because the
  // action is 3x longer: pick up a phone, open the camera, aim, tap the banner.
  // 8s would unlock while a genuinely-succeeding user is still raising their arm.
  TOUR_PHONE_UNLOCK_MS: 25_000,
  TOUR_ADVANCE_MS: 900,
  TOUR_DEMO_ADVANCE_MS: 2_600,
  // How long the `wrong` shake+flash holds before reverting to idle (§4.4 table).
  TOUR_WRONG_RESET_MS: 700,
  // The beat after the perms wizard closes, so the one window startAppTail opens
  // next never animates in on top of one still animating out.
  POST_ONBOARDING_MS: 400,

  POINT_CLICK_DELAY_MS: 650,

  // Per-image OCR ceiling (media-library enrichment). Accurate Vision OCR on a
  // dense 4K shot can run a few seconds; cap so one slow frame can't stall a
  // whole video enrichment pass. Measured baseline ~2.4s accurate / ~0.4s fast.
  OCR_TIMEOUT_MS: 15_000,
  // Video frame sampling for OCR: one frame every N seconds, capped at MAX frames
  // so a long recording can't explode into hundreds of OCR calls.
  VIDEO_FRAME_INTERVAL_S: 2,
  VIDEO_FRAME_MAX: 40,
  // App-icon resolution (osascript + defaults + sips) for the Media Library app
  // filter. Each step is fast; cap so a hung osascript can't block the IPC.
  APP_ICON_TIMEOUT_MS: 4_000,
  // Favicon fetch for the panel context row's site badge. Network call, so keep
  // the ceiling tight — a slow/offline fetch must degrade to "no badge", never
  // stall the context row (which repaints on a poll while the panel is open).
  FAVICON_TIMEOUT_MS: 4_000,
  // Rendered favicon edge in px. Displayed at ~10px as a corner badge on the app
  // icon, so 32 keeps it crisp on Retina without wasting cache bytes.
  FAVICON_PX: 32,
  FAVICON_SERVICE_URL: 'https://www.google.com/s2/favicons',
  LINK_PREVIEW_TIMEOUT_MS: 6_000,
  LINK_PREVIEW_HTML_BYTES: 512 * 1024,
  LINK_PREVIEW_IMAGE_BYTES: 8 * 1024 * 1024,
  OSASCRIPT_TIMEOUT_MS: 3_000,
  // Waveform peak extraction (ffmpeg → raw PCM). Cap the decoded bytes so a long
  // recording can't balloon memory: 8kHz × 2 bytes × ~600s ≈ 9.6MB.
  WAVEFORM_MAX_BYTES: 10_000_000,
  // Media Library list auto-refresh. The scan is cheap (folder count, no file
  // reads), so a slow poll + a focus refresh keeps new captures showing up
  // without a manual reopen.
  MEDIA_REFRESH_MS: 5_000,
  // Library keyword search scans every capture's transcript + OCR text, so it runs
  // on the settled query rather than per keystroke.
  MEDIA_SEARCH_DEBOUNCE_MS: 120,
  PANEL_CONTEXT_POLL_MS: 1_500,

  // UI label SSOT — shared across tray menu, panel tooltip, and window titles
  // so the same surface never drifts between processes.
  UI_LABELS: buildUiLabels(APP_NAME_BASE),

  SHORTCUT_ICONS: [
    '⚡',
    '✨',
    '🎯',
    '🚀',
    '🔥',
    '💡',
    '📝',
    '✏️',
    '🐦',
    '📷',
    '🎨',
    '🖼️',
    '📊',
    '📈',
    '🔍',
    '💬',
    '📧',
    '📬',
    '🗒️',
    '📋',
    '✅',
    '⭐',
    '❤️',
    '🏷️',
    '🔗',
    '📌',
    '🧠',
    '🤖',
    '🛠️',
    '⚙️',
    '🎬',
    '🎵',
    '🌐',
    '💻',
    '📱',
    '🔑',
    '🧹',
    '🪄',
    '📎',
    '🗂️'
  ],

  CAPTURE_HISTORY_LABEL: {
    listen: 'Voice note',
    recording: 'Screen recording',
    screenshot: 'Screenshot'
  } as const,

  CAPTURE_TURN_Q: {
    ask: 'Answer this',
    act: 'Do this'
  } as const,

  // Default panel placeholder shown when no prior instruction exists
  DEFAULT_PLACEHOLDER: 'make it shorter, remove dashes, fix grammar...',

  LAST_HINT_PREFIX: 'last: ',

  RELEASE_NOTES,

  // Schema version for history JSONL rows (bump when HistoryEntry shape changes)
  HISTORY_SCHEMA_VERSION: 3,

  FFMPEG_PATH: '',
  WHISPER_PATH: '',
  WHISPER_MODEL_PATH: '', // resolved at runtime to ~/.cache/whisper/ggml-base.en.bin if empty
  WHISPER_MODEL_DEFAULT_NAME: 'ggml-base.en.bin',
  WHISPER_MODEL_URL: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  // Two models, because `.en` builds physically cannot decode another language:
  // English stays on the small fast one, every other language needs the 1.6GB
  // multilingual build. Keyed by model name so the file name IS the cache key —
  // both live in WHISPER_CACHE_DIR and must coexist, since overwriting one with
  // the other is how switching language back to English silently breaks.
  WHISPER_QUICK_MODEL_NAME: 'ggml-tiny.en.bin',
  WHISPER_MODELS: {
    'ggml-tiny.en.bin':
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    'ggml-base.en.bin':
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    'ggml-large-v3-turbo.bin':
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    'parakeet-tdt-0.6b-v3.q8_0.gguf':
      'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/main/parakeet-tdt-0.6b-v3.q8_0.gguf'
  } as Record<string, string>,
  WHISPER_MODEL_MULTILINGUAL_NAME: 'ggml-large-v3-turbo.bin',

  // Managed ffmpeg, downloaded on demand into ~/MightyMouse/bin on a Mac that
  // has none. Built LGPL v2.1+ from source (scripts/build-managed-ffmpeg.sh) —
  // every convenient prebuilt is GPL or --enable-nonfree and undistributable.
  // Signed + notarized under our Developer ID, so Gatekeeper accepts it on a
  // clean Mac; the sha256 is verified BEFORE the atomic rename, and a mismatch
  // deletes the partial rather than leaving a half-file that looks installed.
  // Pinned tag, never `latest` — the auto-update feed reads the newest release.
  FFMPEG_DOWNLOAD: {
    arm64: {
      url: 'https://github.com/royherma/mightymouse-releases/releases/download/ffmpeg-7.1-lgpl/ffmpeg-lgpl-arm64',
      sha256: '4885c5d515c8d745b1b4ac77798e47c86440e4670e9c1971914e8cd796f50fa9',
      bytes: 20616016
    },
    x64: {
      url: 'https://github.com/royherma/mightymouse-releases/releases/download/ffmpeg-7.1-lgpl/ffmpeg-lgpl-x86_64',
      sha256: '79542602c950f0e4d3dea1375534018a0dbc5d8bea3d92b421578599e046d38b',
      bytes: 24898432
    }
  } as Record<string, { url: string; sha256: string; bytes: number }>,

  // whisper.cpp v1.8.2 (MIT), built from source and notarized under our
  // Developer ID. arm64 carries Metal (embedded library) + Accelerate; x86_64
  // is Accelerate + AVX2. Both statically linked — `otool -L` shows only
  // /usr/lib and /System/Library, which is the check that matters: a Homebrew
  // dylib linked on the build machine passes codesign AND notarization, then
  // dyld-crashes on every clean Mac (managed-ffmpeg PRD §4.1).
  WHISPER_DOWNLOAD: {
    arm64: {
      url: 'https://github.com/royherma/mightymouse-releases/releases/download/whisper-cpp-1.8.2/whisper-cli-arm64',
      sha256: '8e6a641b602d8077fe13f75e82934bf9878cace94167eb93980f2f44166e7fa5',
      bytes: 2815504
    },
    x64: {
      url: 'https://github.com/royherma/mightymouse-releases/releases/download/whisper-cpp-1.8.2/whisper-cli-x86_64',
      sha256: '770a8cf203d1166b3ad9ce07c69976075ee721c1553774f73ec109a321b6b641',
      bytes: 2544208
    }
  } as Record<string, { url: string; sha256: string; bytes: number }>,

  // Parakeet: NVIDIA's ASR model, 2.8x faster than whisper turbo on the same
  // Mac (PRD 2026-09-21). Shipped as NVIDIA's own builds pinned by sha256 —
  // nothing of ours to compile.
  //
  // ATTRIBUTION, required by the licenses and owed on any surface that lists
  // them: "NVIDIA Parakeet TDT 0.6B v3" is CC-BY-4.0 (attribution is a license
  // CONDITION, not a courtesy), and the NeMo-Speech engine is Apache-2.0, whose
  // NOTICE file ships inside the archive at
  // nemo-speech/share/licenses/nemo-speech/NOTICE.
  PARAKEET_MODEL_NAME: 'parakeet-tdt-0.6b-v3.q8_0.gguf',
  PARAKEET_MODEL_URL:
    'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/resolve/main/parakeet-tdt-0.6b-v3.q8_0.gguf',
  PARAKEET_MODEL_BYTES: 713975456,
  // The engine is an ARCHIVE of 12 files, not one binary: bin/nemo-speech plus
  // 11 dylibs it loads via @loader_path/../lib, so bin/ and lib/ must stay
  // siblings after unpacking or every run dies in dyld.
  PARAKEET_DIR_NAME: 'nemo-speech',
  PARAKEET_BIN_SUBPATH: 'nemo-speech/bin/nemo-speech',
  // Resident `nemo-speech serve` holding the model in memory. Spawning the CLI
  // per clip re-pays process start + 11 dylibs + a 680 MB model load every
  // press: measured 2512 ms median vs 1229 ms through the server, 6/6
  // interleaved pairs on the same 4.36 s clip (2026-09-21).
  PARAKEET_SERVER_PORT: instancePort(IS_STAGING_BUILD ? 17873 : 17872),
  PARAKEET_SERVER_HOST: '127.0.0.1',
  PARAKEET_SERVER_READY_TIMEOUT_MS: 60_000,
  PARAKEET_DOWNLOAD: {
    'darwin-arm64': {
      url: 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-macos-aarch64-metal.tar.gz',
      sha256: 'f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244',
      bytes: 3465028
    },
    'darwin-x64': {
      url: 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-macos-x86_64-cpu.tar.gz',
      sha256: '042a4612e07460fab6a39b5d862aa1e39d0ac3eaedfdb979f3f5fc12de510c20',
      bytes: 3618245
    },
    'win32-x64': {
      url: 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-windows-x86_64-vulkan.zip',
      sha256: 'b5e7b04a637da4eb25a60253e2db65774998e8dfb48c08b4db763009b82ac7ac',
      bytes: 21967184
    }
  } as Record<string, { url: string; sha256: string; bytes: number }>,

  CAPTURE_ERROR: {
    ffmpegMissing: 'Recording needs a free helper tool. Install it in one click.',
    whisperMissing: 'Transcribing needs a free helper tool. Install it in one click.',
    // Shown instead of the install button when Homebrew (our installer) is absent.
    brewMissing: 'Installing it needs Homebrew first. Get it at brew.sh, then try again.',
    // Button + progress labels for the one-click fix.
    installAction: 'Install it',
    installing: 'Installing…',
    installed: 'Installed. Try recording again.',
    installFailed: "That didn't work. Open Settings to try again.",
    // The screen half of a recording never started. Named as a capability, not
    // as "ffmpeg spawn error" — what died underneath is our problem (PRD §4.0).
    videoFailed: "Couldn't record your screen. Nothing was saved.",
    // Whisper heard speech it can't write down because English is selected.
    // Pasting its guess would put nonsense in the user's document, so we say
    // nothing and name the one setting that fixes it.
    wrongLanguage: "That didn't sound like English. Pick your language in Settings."
  },

  // Toast shown on the PHONE when a mirror/share request is declined at the
  // Mac. Two causes look the same from the phone (no picture), so the copy
  // splits on the one thing the person can act on: is it a permission?
  MIRROR_DECLINE: {
    permissionOff: 'Turn on Screen Recording for MightyMouse to share your screen.',
    tryAgain: "Couldn't start sharing your screen. Try again in a second."
  },

  RECORDER_SPAWN_GRACE_MS: 250,

  // Homebrew formula install ceilings. ffmpeg pulls ~70 dependencies and builds
  // for several minutes on a cold cache; whisper-cpp is small. A too-short
  // timeout kills the install midway and looks like a random failure.
  BREW_INSTALL_TIMEOUT_MS: 300000,
  BREW_INSTALL_TIMEOUT_FFMPEG_MS: 900000,
  // `npm install -g` on a cold cache is ~20-60s; 5 min is generous headroom
  // for a slow connection without hanging the row forever.
  NPM_INSTALL_TIMEOUT_MS: 300000,

  // rapid-mlx pulls 8 dependencies including python, mlx and a gcc bottle
  // (~500 MB of gcc alone), so it outruns the standard formula ceiling.
  BREW_INSTALL_TIMEOUT_LOCAL_MS: 900000,
  // Rapid-MLX compiles Metal shaders on first serve — measured ~24s cold
  // (PRD 2026-07-16). 90s leaves room for a slower Mac without hanging forever.
  LOCAL_SERVICE_START_TIMEOUT_MS: 90000,
  LOCAL_SERVICE_POLL_MS: 1000,

  // Progress + result copy for the one-click local-backend setup. Deliberately
  // says nothing about Homebrew, formulae, or daemons — the user asked for a
  // working local model, not a package manager.
  LOCAL_SETUP_COPY: {
    installing: 'Downloading and installing',
    installingSlow: 'Still installing, big download',
    starting: 'Starting the service',
    startingSlow: 'Warming up, this takes a minute the first time',
    noBrew: 'This Mac is missing something we need to set it up automatically.',
    installFailed: "Couldn't finish the setup.",
    startFailed: "Installed, but it didn't start in time.",
    unsupportedArch: 'Rapid-MLX needs an Apple Silicon Mac.',
    noModels: 'Installed. Download a chat model to finish.'
  },

  // A setup run is 2 phases, so each owns half the bar. Without this split the
  // bar would jump back to 0 when install hands off to start.
  LOCAL_SETUP_PHASE_WEIGHT: { installing: 0.5, starting: 0.5 },
  // Neither phase reports real progress, so the bar is elapsed/expected, capped
  // just under the handoff so it never claims done before the service answers.
  LOCAL_SETUP_PHASE_CEILING: 0.95,
  LOCAL_SETUP_TICK_MS: 500,
  // Measured cold starts: brew install ollama ~40s, rapid-mlx first serve ~24s.
  // These only pace the bar — the real deadlines are the TIMEOUT_MS above.
  LOCAL_SETUP_EXPECTED_MS: { installing: 60000, starting: 30000 },
  LOCAL_SETUP_SLOW_AFTER_MS: 45000,

  // Onboarding wizard step chrome. One step per screen, one decision each — the
  // header copy changes per step so the user always knows what THIS screen wants.
  // `stepLabel` is a function so "Step 2 of 4" has exactly one definition.
  ONBOARDING_STEPS: {
    stepLabel: (n: number, total: number): string => `Step ${n} of ${total}`,
    accessibility: {
      title: 'Work on whatever you select',
      blurb: `Allow Accessibility so your hotkeys fire and the answer lands back in your text.`
    },
    screen: {
      // The quit-and-reopen caveat used to live here and made this the longest
      // blurb in the wizard. It's now the self-test detail line, which shows only
      // when the grant is on and capture still fails — the one moment it's true.
      title: 'Show it what you see',
      blurb: `Allow Screen Recording so ${APP_NAME_BASE} can screenshot and record your work. Skip it - we'll ask again the first time you use it.`
    },
    microphone: {
      title: 'Talk instead of typing',
      blurb: `Allow the mic and your words turn into text anywhere. Skip it - we'll ask again the first time you talk.`
    },
    backend: {
      title: 'Pick your AI',
      blurb: `${APP_NAME_BASE} is free. Only extra AI features cost, and only when you use them. Pick who answers when you hit a hotkey.`
    },
    granted: "You're set",
    /** Same verified state on the LAST step, where "You're set" reads as mid-flow.
     *  Points at "Done, let's go" — the only action on that screen. */
    grantedLast: 'All set - hit the button below',
    /** The step's live state, shown ABOVE the button. States the fact, not the
     *  instruction — the button already carries the instruction. */
    stateOff: 'Not granted yet',
    stateOn: 'Granted',
    /** Granted, but macOS won't apply it until restart. The app restarts itself,
     *  so the copy promises the return trip rather than assigning a chore. */
    restartState: 'Granted',
    restart: `Restart ${APP_NAME_BASE}`,
    restartHint: 'macOS needs a restart to apply it. Takes a second, and you land right back here.',
    /** Matches the word macOS itself uses in the dialog we're about to open. */
    grant: 'Allow',
    /** Shown when a step was ALREADY granted on arrival, so nothing auto-advances
     *  and the user needs a way forward that isn't Skip. */
    next: 'Next',
    skip: 'Skip for now',
    continueLabel: 'Continue',
    done: "Done, let's go",
    /** Dev FTUE replay. A permanent banner for the whole wizard, never a
     *  per-result note — an intermittent marker stops being trusted. */
    mockBanner: 'DEV REPLAY - results below are faked, not your Mac. Click to show real ones',
    /** The screen step never grants under the replay (ftue-replay.ts). Must not
     *  point at another button — "Done, let's go" can sit below the fold. */
    mockUnwinnable: 'Replay always fails this step - Allow will not turn it green',
    reauthTitle: 'Turn Accessibility back on',
    reauthBlurb:
      'It got switched off, maybe by System Settings or a Mac update. Press Allow to turn it on again.'
  },

  // One-screen setup: everything the four-step wizard asks for, on one page.
  // Separate copy block from ONBOARDING_STEPS because the shapes differ — a row
  // gets a fragment that fits beside a button, not a step's sentence-length
  // blurb. Both exist while the two run side by side.
  ONBOARDING_ONE_SCREEN: {
    /** Window height with the provider list collapsed to one card, and with it
     *  open. The window grows rather than squeezing the list to a sliver. */
    height: 640,
    heightExpanded: 800,
    title: `Set up ${APP_NAME_BASE}`,
    welcomePrefix: 'Build with',
    tagline: 'Describe what you want. Build it from your phone, the web, or your Mac.',
    providerHeading: '1. Pick your AI',
    providerSub: 'You can always change this later.',
    /** The picker shows ONE card by default. Everything else is behind this,
     *  so a first-timer has nothing to decide. */
    providerMore: 'Show more options',
    providerLess: 'Show fewer options',
    permsHeading: `2. Allow ${APP_NAME_BASE} to help`,
    permsHeadingReauth: `Allow ${APP_NAME_BASE} to help`,
    permsSub: "We only ask for what's needed.",
    /** Marks the two permissions the app runs fine without, so a user scanning
     *  the rows can tell the hard ask from the nice-to-haves without reading. */
    optionalTag: 'Optional',
    requiredTag: 'Required',
    rows: {
      accessibility: {
        label: 'Accessibility',
        why: `Lets your hotkeys work in any app. Without it, ${APP_NAME_BASE} can't respond when you call it.`,
        required: true
      },
      microphone: {
        label: 'Microphone',
        why: 'Talk instead of typing. Skip it and voice features stay off.',
        required: false
      },
      screen: {
        label: 'Screen',
        why: 'Powers screenshots and screen answers. Skip it and those stay off.',
        required: false
      }
    },
    /** Granted, but macOS won't apply it until relaunch. No per-row button —
     *  the finish button does the restart once, at the end. */
    restartRowState: 'Needs restart',
    restartNote: `${APP_NAME_BASE} will restart once to finish.`,
    waitingHint: `Turn ${APP_NAME_BASE} on in System Settings, then come back here.`,
    allSet: 'All set',
    waiting: 'Waiting…',
    checking: 'Checking…',
    done: "Let's go",
    ctaSub: 'Takes less than a minute',
    privacyFooter: 'Your data stays private and secure.',
    /** Replaces `done` when any granted permission is waiting on a relaunch.
     *  Names the restart up front so it isn't a surprise after the click. */
    restartFinish: 'Restart and finish',
    /** Under a disabled finish button. States what's missing and why it
     *  matters — a dead button with no reason reads as broken. */
    gateHint: 'Press Allow under Accessibility to continue.',
    /** Admin-only preview: same screen as real first run, but nothing it does
     *  writes setup state. The banner is what tells them apart on sight. */
    previewBanner: 'PREVIEW - nothing here writes real setup state'
  },

  // Drag-to-add coach: shown when Grant ran but the permission still reads off,
  // which almost always means the app isn't in the System Settings list at all.
  // Never say "TCC" or "app bundle" — name only what the user can see on screen.
  ONBOARDING_DRAG_COACH: {
    // Appears the moment Grant is pressed, BEFORE we know whether the list
    // already has us — so it must state the destination, never diagnose a
    // failure. The icon is a real draggable .app bundle (webContents.startDrag).
    title: `Drag ${APP_NAME_BASE} into the list`,
    blurb: `If ${APP_NAME_BASE} isn't listed above, drag it in:`,
    steps: 'Drag the icon up into the list. Or click + and pick it from Applications.',
    /** Sits under the icon, naming the gesture the icon actually supports. */
    dragHint: 'Drag me ↑',
    /** Tooltip on the lone close control (top-left, macOS convention). */
    closeLabel: 'Close',
    panesWithList: ['accessibility', 'screen'] as PermissionKey[]
  },

  DRAG_COACH_PANEL: {
    WIDTH: 460,
    HEIGHT: 300,
    GAP: 12
  },

  // Replaces onboarding + tour for a genuinely new user.
  FIRST_RUN: {
    WIDTH: 520,
    HEIGHT: 520,
    TRANSCRIPT_HOLD_MS: 3000,
    GRANT_POLL_MS: 1000,
    GRANT_SLOW_MS: 60_000,
    title: `Set up ${APP_NAME_BASE}`,
    skipped: {
      title: `${APP_NAME_BASE} lives in your menu bar (top right).`,
      sub: 'Hold fn anywhere to talk.',
      button: 'OK'
    },
    skipForNow: 'Skip for now',
    enterHint: 'Press Return to start',
    scan: {
      title: 'Scan this with your iPhone camera',
      sub: 'Your phone becomes part of your Mac. No app to install.',
      wifi: 'Your iPhone and Mac must be on the same Wi-Fi.',
      talkInstead: 'No phone handy? Try talking instead'
    },
    move: {
      titleWaiting: 'One switch to turn on',
      title: 'Slide a finger on your phone.',
      permHint: `A System Settings window just opened. Turn the switch on next to ${APP_NAME_BASE}.`,
      openSetting: "Didn't see it? Open the setting",
      allowed: 'Allowed. The pointer follows your finger.',
      skip: 'Skip this'
    },
    talk: {
      titlePrefix: 'Now hold',
      titleSuffix: 'and say anything.',
      phoneTitle: 'Now press the mic on your phone and say anything.',
      sub: 'Runs on your Mac. Free. Nothing leaves it.',
      placeholder: 'Your words land here',
      loadingTitle: 'Getting ready...',
      downloading: 'Getting the speech model ready...',
      fnHelp: 'or change the key',
      orHold: 'fn not working? Hold',
      skipWait: "Don't wait, I'll try it later"
    },
    done: {
      title: "That's it. Your phone now runs your Mac.",
      rowTalk: 'Talk, it types',
      rowKept: 'Everything you say is saved. Find it later.',
      openLibrary: 'See saved',
      button: 'Open my phone remote'
    }
  },

  SCREEN_PERMISSION_TTL_MS: 30_000,

  MIN_SCREENSHOT_BYTES: 1024,

  // Long edge in px. 1600 is the point where a Retina frame stops being a
  // multi-MB download without becoming unreadable on a 6" phone screen.
  SCREENSHOT_MAX_EDGE: 1600,
  // sips JPEG quality. 75 measured 311 KB against 883 KB at full resolution on
  // the same frame; 85 buys visible nothing on a phone for 3x the bytes.
  SCREENSHOT_JPG_QUALITY: 75,

  SCREEN_PERMISSION: {
    blocked: `${APP_NAME_BASE} needs permission to see your screen`,
    fixLabel: 'Grant access'
  },

  ONBOARDING_CAPTURE: {
    title: 'Screen & voice capture',
    blurb: `Lets ${APP_NAME_BASE} record your screen and transcribe what you say.`,
    ready: 'Ready to record',
    missing: 'Recording needs one more piece',
    fixLabel: 'Set it up'
  },

  ONBOARDING_BACKEND: {
    title: 'AI backend',
    blurb: `${APP_NAME_BASE} needs a working AI to run your hotkeys.`,
    // Names the way out. The old line stated a problem and stopped, on the one
    // step that can't gate — so a user could walk past it into a dead first run.
    missing: `Not connected yet. Pick ${APP_NAME_BASE} above to start without installing anything.`,
    missingOwn: `${APP_NAME_BASE} could not connect. Check your internet and press Try again.`,
    retryLabel: 'Try again'
  },

  SETUP_CHECK: {
    // Window size. Six rows plus header/footer fit without scrolling; matching
    // the onboarding wizard's width keeps the two surfaces feeling like one app.
    windowWidth: 520,
    windowHeight: 640,

    title: 'Setup',
    headingAllGood: 'Everything ready',
    headingNeedsWork: 'Almost there',
    doneWhileFixing: 'Hide',
    // The button on the panel's backend-warning banner. Names the outcome, not
    // the destination: "Fix this" over "CLI not found" read as "go install a
    // CLI", hiding the zero-install switch waiting one click away.
    bannerFixLabel: 'Show me how',
    blurbAllGood: `Everything's ready. ${APP_NAME_BASE} can see your screen, hear you, and answer.`,
    // Takes the count because the fixed string claimed "a couple … one each"
    // over five rows, on the one surface whose job is being accurate.
    blurbNeedsWork: (n: number): string =>
      n === 1 ? 'One thing still needs a tap.' : `${n} things still need a tap.`,
    recheck: 'Check again',
    done: 'Done',

    accessibility: {
      label: 'Reading your screen',
      ok: 'Ready',
      fail: `${APP_NAME_BASE} needs permission to read selected text`,
      fixLabel: 'Grant access'
    },
    screen: {
      label: 'Screen recording',
      ok: 'Ready',
      fail: `${APP_NAME_BASE} needs permission to capture your screen`,
      fixLabel: 'Grant access',
      /** Button copy when the grant exists but macOS is still caching the old answer. */
      restartLabel: 'Restart to apply',
      /** Shown while we relaunch to pick up a grant macOS is still caching. */
      restarting: 'Restarting to pick that up…'
    },
    microphone: {
      label: 'Voice',
      ok: 'Ready',
      fail: 'Talking to MightyMouse needs microphone access',
      fixLabel: 'Grant access'
    },
    recording: {
      // Deliberately NOT "Screen recording" — that is the permission row's
      // label, and two identical labels made a fixed permission look unfixed.
      label: 'Saving recordings',
      ok: 'Ready to record',
      fail: 'Saving a recording needs one more piece',
      // Shown instead of a button we already know will fail. Names no tool: the
      // person who hits this does not know what ffmpeg or Homebrew are, and the
      // old copy sent them to brew.sh to install a package manager.
      // Kept for the case where the download itself fails (offline, or a
      // checksum mismatch). No longer about Homebrew — the fix downloads.
      noBrew:
        'We could not set this up automatically on this Mac. Everything else still works, and you can rewrite and ask as normal.',
      // Shown while the ~20MB download runs, with a percentage beside it.
      working: 'Downloading screen recording',
      // A failed download is worth retrying — offline is the common cause.
      failedRetry: "That didn't finish. Check your connection and try again.",
      fixLabel: 'Set it up'
    },
    transcription: {
      label: 'Voice transcription',
      ok: 'Ready',
      fail: 'Turning your voice into text needs one more piece',
      // Distinct from `fail`: the engine is installed and the mic is the thing
      // missing. Saying "needs one more piece" here sent a user to reinstall
      // the engine six times while his mic stayed blocked.
      needsMic: 'Ready once you turn on the microphone',
      needsMicFixLabel: 'Turn on microphone',
      // Two downloads under one bar: the engine (~3MB) then the model (~148MB),
      // so the percentage is the model's — the engine is over before it shows.
      working: 'Downloading voice transcription',
      failedRetry: "That didn't finish. Check your connection and try again.",
      fixLabel: 'Set it up'
    },
    backend: {
      label: 'Your AI',
      ok: 'Connected',
      // `{name}` is replaced with the backend's friendly label (BACKEND_META).
      notConnected: '{name} isn’t connected yet',
      notSignedIn: `Sign in to your AI, or use ${APP_NAME_BASE} instead.`,
      noCredits: '{name} is out of credits',
      fixLabelConnect: 'Connect {name}',
      fixLabelSignIn: 'Sign in',
      fixLabelTopUp: 'Add credits',
      // The zero-install escape hatch. Shown alongside a failing own-AI row —
      // the one sanctioned two-button case, because it's a real product choice.
      switchLabel: `Use ${APP_NAME_BASE} instead`,
      // Same escape hatch, worded for the case where it sits BESIDE a working
      // primary ("Connect Local"): it's the backup, not the main route. The
      // sign-in/top-up step stays out of the label — a button that says only
      // "Add credits" never says what the credits are for.
      switchLabelBackup: `Use ${APP_NAME_BASE} as backup`,
      switchDetail: 'Works right now, nothing to set up. Runs on credits.'
    },

    // Progress + failure. Never shows raw tool output — that's where the
    // forbidden vocabulary lives.
    working: 'Working on it…',
    workingSlow: 'Still going. Big download.',
    failedAuto: 'We couldn’t set this up automatically.',
    // Genuinely no route left (no package manager at all). Last resort only,
    // and never the primary action — the escape hatch outranks it.
    manualHint: 'You can also set this up yourself.'
  },
  WHISPER_LANG: 'en',

  EMBED_MODEL_ID: 'Xenova/bge-small-en-v1.5',
  EMBED_DIM: 384,
  // bge models want this prefix on the *query* side for retrieval (not on docs).
  EMBED_QUERY_PREFIX: 'Represent this sentence for searching relevant passages: ',
  // Long bodies get chunked before embedding so a single email/transcript
  // doesn't blow the model's context or dilute the vector.
  EMBED_CHUNK_CHARS: 1200,

  // AVFoundation devices. Stored by NAME (survives index reshuffling when you
  // plug/unplug an iPhone, etc); resolved to a live index at record time.
  VIDEO_DEVICE: 'Capture screen 0',
  AUDIO_DEVICE: 'MacBook Pro Microphone',

  // Tap-vs-hold threshold for the screenshot/record capture hotkey (ms). A quick
  // tap takes a screenshot; holding past this starts a screen recording.
  TAP_HOLD_MS: 150,

  LISTEN_SMART_HOLD_MS: 3_000,

  // Two taps of the listen hotkey inside this window arm hands-free dictation.
  // 400ms: long enough for a deliberate double-tap on a four-key chord, short
  // enough that two separate dictation toggles never collide into one.
  LISTEN_DOUBLE_TAP_MS: 400,
  TALK_TRANSCRIBING_MAX_MS: 20_000,
  // Off: a quick second tap kept dropping people into hands-free by accident. Second tap now just stops.
  LISTEN_DOUBLE_TAP_HANDS_FREE: false,

  VOICE_ENHANCE: { TIMEOUT_MS: 90_000 },

  ACTIONS: {
    // workers/decide, not the Supabase edge function: the Worker checks the JWT at the PoP nearest the Mac, no GoTrue hop.
    DECIDE_URL: SUPABASE_ENV.DECIDE_URL,
    // 3s is the product limit, not a budget to widen: past this the card is
    // slower than doing it by hand. Measured 2103-3711ms, so calls still die
    // here — the fix is making the call faster, not raising this number.
    DECIDE_TIMEOUT_MS: 3_000,
    // Probability of the winning action, not its confidence — both are per-question.
    VOICE_PRESELECT_PROBABILITY: 0.6,
    PRIME_TTL_MS: 20_000,
    COMMAND_NOUL: 0.5,
    IDLE_MOUSE_MS: 3_000,
    IDLE_KEYBOARD_MS: 3_000,
    IDLE_MIN_PROBABILITY: 0.9,
    IDLE_COOLDOWN_MS: 120_000,
    MAX_PROPOSALS: 3,
    // Always ranked and shown on the voice card beside the agents, not only when they win.
    RESERVED_ACTION_IDS: ['input.rewrite'],
    // 0.005 rounds to 0% on the card, and a 0% row is noise.
    RESERVED_MIN_PROBABILITY: 0.005,
    // Only the copy sent to Jev — the action itself still runs on the full
    // selection (engine.ts run input), so raising this cannot truncate output.
    // Unbounded, one long selection put the body over the proxy's 64KB and
    // every call 413'd into the slow fallback.
    MAX_STATE_SELECTION_CHARS: 4_000,
    // Not TypeSafe's 255 ceiling: the decide proxy caps the body at 64KB
    // (supabase/functions/decide MAX_BODY_BYTES) and 255 options 413'd every
    // call, forcing the direct-key fallback — two round-trips, ~2s to ~4s.
    MAX_SLOT_OPTIONS: 150,
    // The real limit is bytes, not options: accessibility labels run from 3 to
    // 300 chars, so 150 options was 42KB on a rich page. Below the proxy's 64KB
    // (supabase/functions/decide MAX_BODY_BYTES) with room for state and the
    // agent fan-out criteria, which grow with the number of running agents.
    MAX_QUESTIONS_BYTES: 40 * 1024,
    CHIP_PICKER_OPTIONS: 8,
    // Below this the chip shows it guessed, rather than reading as a settled pick.
    CHIP_UNSURE_CONFIDENCE: 0.7,
    MUTE_AFTER_DISMISSALS: 3,
    HABIT_HALF_LIFE_DAYS: 14,
    HABIT_RECENT_ROWS: 500,
    CONTEXT_RECENT_APPS: 5,
    CONTEXT_RECENT_ACTIONS: 5,
    RUN_TIMEOUT_MS: 15_000,
    PLUGIN_RESCAN_MS: 2_000
  },

  COORDINATION_ATTENTION: {
    // More than this and the freshest 100 get checked, the rest keep rule order.
    MAX_AGENTS: 100,
    // 50 agents measured ~33.6KB; 100 in one call is 67.2KB, over the proxy's 64KB cap.
    CHUNK_SIZE: 50,
    CALL_TIMEOUT_MS: 3_000,
    // A reload inside this window reuses the last score instead of re-asking Jev.
    CACHE_LIFE_MS: 60_000
  },

  BROWSER_TASK: {
    AGENT_SIGN_URL: SUPABASE_ENV.AGENT_SIGN_URL,
    FILL_MODELS: ['groq/openai/gpt-oss-20b', 'anthropic/claude-sonnet-5'],
    FEATURE: 'computer_use',
    FILL_TIMEOUT_MS: 20_000,
    FILE_CHOOSER_WAIT_MS: 3_000,
    FILL_MAX_TOKENS: 4_000,
    MAX_SOURCE_CHARS: 40_000,
    MAX_FILE_BYTES: 25 * 1024 * 1024,
    DOC_TIMEOUT_MS: 15_000,
    UNSURE_BELOW: 0.6,
    MARK_FILLED: '#22c55e',
    MARK_CHECK: '#f59e0b',
    MAX_ROUNDS: 4,
    PRESS_SETTLE_MS: 300,
    STEP_MODELS: ['anthropic/claude-sonnet-5'],
    STEP_TIMEOUT_MS: 45_000,
    STEP_MAX_TOKENS: 3_000,
    MAX_STEPS: 40,
    STEP_HISTORY: 20,
    MAX_SAME_ACTION: 3,
    NEW_TAB_WAIT_MS: 2_500,
    MAX_WORK_TABS: 4,
    SIDE_TAB_TEXT: 3_000,
    SIDE_TAB_CONTROLS: 120,
    LOAD_WAIT_MS: 15_000,
    MOD_MODELS: ['anthropic/claude-sonnet-5'],
    MOD_TIMEOUT_MS: 90_000,
    MOD_MAX_TOKENS: 8_000,
    MOD_PAGE_LINES: 400,
    MOD_RECHECK_WAIT_MS: 2_000,
    MOD_PAGE_CALL_MS: 8_000,
    // Own world so a mod's globals never collide with page-driver's (1717).
    MOD_WORLD_ID: 1818,
    // Built-in mods ship in the app, so they run without the lock that MOD_WORLD_ID gets.
    MOD_BUILT_IN_WORLD_ID: 1819,
    MOD_LINK_URL,
    MODS_FN: 'mods',
    MOD_CALL_TIMEOUT_MS: 15_000,
    MOD_SITE_LIST_TTL_MS: 10 * 60_000,
    MOD_SYNC_EVERY_MS: 30 * 60_000,
    MOD_DRAFT_MODEL: 'groq/openai/gpt-oss-20b',
    MOD_DRAFT_TIMEOUT_MS: 15_000,
    // gpt-oss reasons first on this feature; 400 left no room for the answer.
    MOD_DRAFT_MAX_TOKENS: 2_000,
    MOD_ASKS_PER_MINUTE: 20,
    MOD_BLOCKED_PATHS: /\/(login|log-in|signin|sign-in|signup|sign-up|oauth2?|auth|checkout|payment|billing|password)\b/i
  },
  COMPUTER_USE: {
    MAX_STEPS: 25,
    MAX_RUN_MS: 120_000,
    // Times pure chance (1 / options offered). A flat 0.4 stopped run 1 at step 0: Jev's correct pick of 9 scored 0.23.
    MIN_CONFIDENCE_OVER_CHANCE: 1.5,
    // 0.6 — every recorded app or site hop that was right scored 0.86+, every wrong one 0.52 or less
    MIN_CONFIDENCE_TO_LEAVE: 0.6,
    MAX_UNCHANGED_STEPS: 2,
    MAX_SAME_STEP: 3,
    STATUS_BOX_LINGER_MS: 60_000,
    MAX_SAME_KIND_RUN: 3,
    MAX_SCROLLS_PER_RUN: 3,
    ALWAYS_HAND_OVER: [
      'buy',
      'pay',
      'purchase',
      'place order',
      'order',
      'checkout',
      'delete',
      'remove',
      'transfer',
      'unsubscribe'
    ],
    HAND_OVER_AFTER_TYPING: [
      'post',
      'send',
      'reply',
      'tweet',
      'publish',
      'submit',
      'share',
      'comment'
    ],
    MAX_ITEMS: 120,
    MAX_OFFSCREEN_ITEMS: 40,
    MAX_LABEL_CHARS: 80,
    HISTORY_STEPS: 6,
    // Below this the next read sees the screen from before the click landed and the run stops as "nothing changed".
    SETTLE_MS: 400,
    WAIT_STEP_MS: 800,
    WRITER_TIMEOUT_MS: 6_000,
    WRITER_FEATURE: 'computer_use',
    JEV_USD_PER_M_INPUT_TOKENS: 0.042,
    STOP_CORNER_PX: 4,
    SEARCH_URL: 'https://www.google.com/search?q=',
    BROWSER_BUNDLE_IDS: [
      'com.apple.Safari',
      'com.google.Chrome',
      'company.thebrowser.Browser',
      'com.brave.Browser',
      'com.microsoft.edgemac',
      'org.mozilla.firefox'
    ]
  },

  SUGGESTIONS: {
    IDLE_MS: 4_000, // cursor still this long → show the bubble
    MOVE_PX: 6, // movement under this many px counts as "still"
    MAX: 3, // most suggestions shown at once (maps to the ⌘1/2/3 chords)
    PREDICT_TIMEOUT_MS: 30_000,
    RECENT_HISTORY: 12,
    OUTCOME_RECENT: 300,
    TOP_ACCEPTED_STEMS: 5,
    INSTRUCTION_STEM_WORDS: 6,
    MIN_LABEL_CHARS: 3,
    MAX_LABEL_CHARS: 72,
    MAX_INSTRUCTION_CHARS: 500,
    // Cap on a 'write' suggestion's pre-generated paste body. Wide enough for a
    // tweet/reply/short email, bounded so a runaway draft can't bloat the bubble.
    MAX_WRITE_CHARS: 1200,
    // Max width (px) of the hover-preview/edit panel that expands to the right of a
    // 'write' chip. The textarea grows with content up to this width, then wraps —
    // long drafts read bigger but never run off-screen.
    PREVIEW_MAX_WIDTH: 420,
    // Levenshtein ratio (changed chars / max length) at/above which an edited draft
    // counts as 'rewritten' rather than 'edited'. Half the body changed = the draft
    // missed; below that = a tweak. Drives HistoryEntry.edit_type.
    REWRITE_RATIO: 0.5,
    PASTE_SETTLE_MS: 90,
    PASTE_REFOCUS_MS: 100,
    CLICKABLE_OFF_DELAY_MS: 120,
    PREVIEW_CLOSE_GRACE_MS: 250,
    ACCEPT_BOOST: 2.4,
    DISMISS_PENALTY: 1.1,
    RECENCY_HALF_LIFE_MS: 7 * 24 * 60 * 60 * 1000,

    CONTEXT_BUDGET_CHARS: 3500,
    // Rows of current-app-scoped history to pull before packing (HISTORY.searchText).
    SCOPED_HISTORY_ROWS: 8,
    // Days back the scoped-history fallback window reaches when there's no app match.
    SCOPED_HISTORY_FALLBACK_DAYS: 7,
    // Ambient typing fed to the assembler: more + longer than the 1500-char tone-hint
    // blob, because suggestions reason over "what am I doing right now".
    AMBIENT_SNIPPETS: 8,
    AMBIENT_SNIPPET_CHARS: 140,
    // Label-quality gate: minimum words for a specific action label. One-word labels
    // ("Yesterday", "Explain") are dead UI copy — reject them. Phrases earn a slot.
    MIN_LABEL_WORDS: 2,
    // Generic single-token labels that read like toolbar buttons, never personal
    // actions. Rejected even if they clear MIN_LABEL_WORDS as the whole label.
    GENERIC_LABEL_BLOCKLIST: [
      'explain',
      'transcribe',
      'yesterday',
      'today',
      'help',
      'summarize',
      'rewrite',
      'translate',
      'fix',
      'ask',
      'continue'
    ] as readonly string[],

    // ── Manual-trigger feedback (in-bubble "preliminary step") ─────────────────
    // Only the manual ⌘⌥⇧S path shows these — idle stays silent. The bubble morphs
    // loading → ready, or shows a short note then auto-fades on empty/error.
    FEEDBACK: {
      LOADING_TEXT: 'Thinking about your next move',
      EMPTY_TEXT: 'Nothing jumps out right now',
      ERROR_TEXT: "Couldn't think of one. Try again",
      // Shown after Esc parks the bubble: the keycap + this label tell the user how
      // to close it (Enter, or the ✕). Bubble has already stopped trailing by now.
      CANCEL_HINT_TEXT: 'to close',
      // How long an empty/error note lingers before it fades itself away (ms).
      AUTO_FADE_MS: 3_200,
      // Fade-out transition duration for the auto-dismiss (ms).
      FADE_OUT_MS: 260
    }
  },

  ESTIMATOR: {
    // Most recent matching runs to median over. A window (not all history) so the
    // estimate tracks the user's current machine/model, not a year-old baseline.
    SAMPLE_WINDOW: 20,
    // Below this duration a sample is treated as noise (an instant cache hit /
    // error that slipped through ok===true) and skipped, so it can't drag the median.
    MIN_SAMPLE_MS: 250,
    // Confidence tiers by how many samples backed the median. 1 sample still
    // estimates (low confidence) — we'd rather show an imperfect bar than none.
    CONFIDENCE_MED_AT: 8, // ≥ this many samples → 'med'
    CONFIDENCE_HIGH_AT: 16, // ≥ this many samples → 'high'
    // Bar fill ceiling while a run is still going. Holds here (with a shimmer) once
    // elapsed ≥ eta, so the bar never reads 100%/"done" before the run actually is.
    BAR_CAP_PCT: 95
  },

  // Dimensions & Limits
  PANEL_W: 520,
  PANEL_H: 250,
  PANEL_MIN_H: 240,
  PANEL_CHAT_MIN_H: 420,
  PANEL_MIN_W: 380,
  PANEL_MAX_W: 1100,
  PANEL_MAX_H: 800,
  // Floor for the composer's drag handle — matches .input-wrap's min-height.
  PANEL_COMPOSER_MIN_H: 44,
  MAX_PREVIEW_LEN: 80,
  MAX_SKILL_BYTES: 3500,

  ISLAND: {
    // Fallback notch geometry when the native reader is unavailable. ~32pt tall,
    // ~185pt wide matches a 14" MacBook Pro; close enough for any notched model.
    NOTCH_H: 32,
    NOTCH_W: 185,
    // Bleed the window a few px ABOVE the screen top so its top edge tucks fully
    // behind the black notch with no hairline seam. Harmless — overflow is masked.
    TOP_BLEED: 6,
    // Idle blob: small gutters beside the notch, short drop below it.
    GUTTER_COLLAPSED: 6,
    DROP_COLLAPSED: 6,
    // Active blob: wide gutters for content (icon + waveform + label), taller drop.
    GUTTER_EXPANDED: 130,
    DROP_EXPANDED: 56,
    COLLAPSE_MS: 1_800,
    // After a done/error state the emitter auto-resets to idle, so a stuck run
    // can never leave the island showing a stale spinner forever.
    RESET_MS: 2_000,
    // First-run demo: when the user flips the island ON, play a short scripted
    // tour through the states so they see + understand it immediately.
    // DEMO_STEP_MS is how long each demo state holds before the next.
    DEMO_STEP_MS: 1_300
  },

  COMPANION: {
    WIDTH: 300,
    HEIGHT: 460,
    MARGIN: 24,
    HIDEOUT_MIN_W: 400,
    HIDEOUT_MIN_H: 460,
    PILL_H: 52,
    // Transparent inset around the minimized capsule; below ~20 the bubble shadow clips on the window edge.
    PAD: 20,
    CAPTION_MAX_H: 140,
    // Width the puck window grows by at the `debug` size, to seat the signal
    // panel BESIDE the circle. Debug deliberately never goes full-screen: the
    // End button lives on the puck, so leaving the puck stranded the user with
    // no way to stop the conversation.
    DEBUG_PANEL_W: 320,
    CYCLE_MS: 2_000,
    THINKING_MIN_MS: 500,
    TALKING_HOLD_MS: 2_500,
    TALKING_MS_PER_CHAR: 45,
    TALKING_HOLD_MAX_MS: 12_000,
    WAKE_ARM_MS: 8_000,
    FOLLOW_UP_MS: 8_000,
    ACK_AFTER_MS: 1_200,
    DRAFT_EVERY_MS: 600,
    CAPTION_W: 300,
    CAPTION_HOLD_MS: 4_000,
    // Caption shown under the character while `listening` — the explicit text half
    // of the "clearly hearing you" signal (alongside the ring + pose + ears).
    LISTENING_CAPTION: 'Listening…',
    // Phase 1 mocked ResponseSource (see live-listen.ts mockRespond) — shown
    // when no canned keyword matches. Phase 2 replaces the whole call site with
    // a real ask-turn; this string never ships past that swap.
    MOCK_REPLY_FALLBACK: "Got it. I'm not wired to a real brain yet, but I heard you.",
    ELEVENLABS_VOICE_ID: '21m00Tcm4TlvDq8ikWAM',
    ELEVENLABS_MODEL_ID: 'eleven_flash_v2_5',
    SAY_VOICE: '',
    SAY_RATE: 175,
    SAY_DATA_FORMAT: 'LEI16@22050',
    SAY_MIME: 'audio/wav',
    // Kokoro 82M (Apache 2.0) — the free/offline voice that actually sounds human,
    // one rung above `say` and below a paid ElevenLabs key. Apple Silicon only (MLX).
    // 'af_heart' is the default of Kokoro's 54 voices. Writes WAV, same as `say`.
    KOKORO_VOICE: 'af_heart',
    KOKORO_MIME: 'audio/wav',
    KOKORO_MODEL_REPO: 'prince-canuma/Kokoro-82M',
    // KokoroPipeline's own single-char language code ('a' = American English),
    // NOT an ISO 'en' — it indexes the model's phonemizer table and a wrong value
    // is rejected outright.
    KOKORO_LANG_CODE: 'a',
    KOKORO_DOWNLOAD: {
      url: '',
      sha256: '',
      sizeBytes: 0
    },
    // Cold spawn measured at ~5.1s for 6s of audio on an M1 Max (26 Jul 2026) —
    // the model reloads per call. Ceiling is generous because a timeout falls
    // through to `say`, and cutting a real synthesis short is the worse failure.
    KOKORO_TIMEOUT_MS: 30_000,
    // Wall-clock ceiling for one companion ask-turn (buildRewritePrompts + runBackend,
    // see companion-orchestrator.ts) — a live voice turn should fail fast into
    // silence/idle rather than sit in "thinking" as long as a panel ask can (RUN_TIMEOUT_MS.ask).
    ASK_TIMEOUT_MS: 20_000,
    VISION_MAX_TURNS_PER_MIN: 4
  },

  // Phone Remote: local HTTP+WS server (main process only) serving a QR-paired
  // trackpad + hold-to-speak page. Off by default; PREFS.getPhoneRemoteEnabled()
  // gates whether the server is even listening (see phone-remote/server.ts).
  PHONE_REMOTE: (() => {
    const base = buildPhoneRemote(SUPABASE_URL)
    return { ...base, PORT: instancePort(base.PORT), ICON_PORT: instancePort(base.ICON_PORT) }
  })(),

  // Code agent relay (PRD 2026-08-12-1786501335). The MCP server lives inside
  // Electron main and speaks Streamable HTTP on localhost -- both the bundled
  // agent (pointed at this port directly) and `npx mightymouse-code` (a stdio
  // shim that proxies here) are the same server, never a forked copy.
  AGENT_RELAY: {
    // Loopback-only; distinct from PHONE_REMOTE.PORT so toggling one server
    // never contends with the other's port-retry ladder.
    MCP_PORT: instancePort(17781),
    MCP_ROUTE: '/mcp',
    // Held open by the npx shim for its whole life, so the set of open sockets
    // here IS the set of open agent sessions -- the shim is spawned when a
    // session starts and killed when it ends. Counting these needs no timeout:
    // a closed terminal drops the socket, and the count follows immediately.
    PRESENCE_ROUTE: '/presence',
    // Read-only mirror of what the panel's session list shows, so the list can
    // be checked from a terminal (`bin/mm-relay sessions`) instead of by
    // hovering the UI and reading pixels. Loopback-only, like every route here.
    SESSIONS_ROUTE: '/sessions',
    // Fires the deck's suggestion path for one session and returns what it
    // produced, so the chips can be checked from a terminal instead of by
    // holding the phone. `relaySuggest` arrives over the phone's WS otherwise,
    // which nothing but a real handset can send. Loopback-only.
    SUGGEST_ROUTE: '/suggest',
    // Refreshes one session's liveness stamp. Its own route rather than the
    // `busy` verb because a PostToolUse hook calls it on EVERY tool call: the
    // verb path costs a Node spawn plus an MCP handshake (670ms vs 11ms here).
    ACTIVE_ROUTE: '/active',
    // PreCompact/PostCompact hooks: `?session=<id>&on=1|0&trigger=auto|manual`.
    COMPACT_ROUTE: '/compact',
    // Unlike every other route here, a web page can reach these, so each call carries a per-session key.
    PAGE_ROUTE_PREFIX: '/page/',
    // Set by the npx shim, which is the only caller that knows the agent's cwd
    // and branch. Copied verbatim in npm-shim/mightymouse-code/bin -- that file
    // ships outside this build and cannot import it.
    IDENTITY_HEADER: 'x-mightymouse-from',
    CWD_HEADER: 'x-mightymouse-cwd',
    // The agent's own session id. IDENTITY_HEADER cannot serve as the join key
    // for a reconnect, because renaming a session is exactly what changes it --
    // a naming hook publishes the real name seconds after the shim booted, and
    // the shim reconnects to report it. This one never changes for a session.
    SESSION_HEADER: 'x-mightymouse-session',
    // JSON: repo, branch, pid, agent, effort, entrypoint -- whichever of those
    // the host actually exposes. One header instead of one per fact, so adding
    // a display field later never touches the parsing on this side.
    FACTS_HEADER: 'x-mightymouse-facts',
    // JSON: cmux workspace/pane ids, tmux pane/socket, host bundle id -- however
    // much of the "where do I click to see this agent" address the shim's env
    // exposes. Same one-header-not-one-per-field shape as FACTS_HEADER, and the
    // same contract: every key optional, an empty object is a normal answer for
    // an agent running outside cmux/tmux.
    ORIGIN_HEADER: 'x-mightymouse-origin',
    // Failed opens before this socket registered; absent means first try. A
    // session that arrived after dozens of retries is otherwise indistinguishable
    // from one that arrived instantly.
    ATTEMPTS_HEADER: 'x-mightymouse-attempts',
    // Edge Function name (appended to CONFIG.BILLING.EDGE_FUNCTION_URL).
    PUSH_FN: 'agent-relay-push',
    PUSH_TIMEOUT_MS: 8_000,
    // The cloud answer path: the phone POSTs to ANSWER_FN when it cannot reach
    // this Mac directly, and PENDING_FN is this Mac's own end (register a
    // request at push time, claim answers on a poll).
    ANSWER_FN: 'agent-relay-answer',
    PENDING_FN: 'agent-relay-pending',
    // Polled, not Realtime: this would be the codebase's first Realtime
    // consumer, and a socket that must survive sleep/wake/network-change is a
    // lot of new failure surface for a path that only runs while the DIRECT
    // path is already broken. At 15s the worst case adds about a poll's delay
    // to an answer that would otherwise never arrive at all.
    CLOUD_POLL_MS: 15_000,
    // APNs delivers on an exact bundle-id match, and a staging Mac pairs with
    // the `.dev` iOS build -- so the topic has to follow the env, not a single
    // server-side constant. The relay allow-lists these two values.
    IOS_BUNDLE_ID: IS_STAGING_BUILD ? 'com.mightymouse.ios.dev' : 'com.mightymouse.ios',
    PANE_PREVIEW_LINES: 32,
    PANE_PREVIEW_MAX_CHARS: 2000,
    // Context for a swipe-card's suggested actions. Deliberately smaller than
    // the preview above: a full pane is mostly input-box chrome, and the model
    // is being asked for three short instructions, not a summary.
    SUGGEST_PANE_LINES: 8,
    SUGGEST_PANE_MAX_CHARS: 600,
    SUGGEST_SAID_MAX_CHARS: 1500,
    // Cards the agent sent before this one, oldest first, for "what has it been
    // telling me lately" without replaying a whole session.
    SUGGEST_RECENT_CARDS: 4,
    PROJECT_IDEAS: {
      TIMEOUT_MS: 60_000,
      TTL_MS: 6 * 60 * 60 * 1000,
      MIN_REGEN_MS: 30 * 60 * 1000,
      GIT_TIMEOUT_MS: 3_000,
      MAX_COMMITS: 12,
      MAX_DIRTY: 20,
      MAX_PLANS: 10,
      MAX_ASKS: 8,
      MAX_TITLES: 12,
      ASK_CHARS: 240,
      NOTES_CHARS: 1500,
      TRANSCRIPT_HEAD_BYTES: 256 * 1024,
      TITLE_TAIL_BYTES: 64 * 1024,
      TITLE_RECHECK_MS: 30_000,
      MAX_FEEDBACK: 40,
      DONE_CHECK_TIMEOUT_MS: 120_000
    },
    // How far capture-pane reaches into scrollback; chrome stripping can eat
    // most of the visible screen, so the preview needs history to fill from.
    PANE_PREVIEW_SCROLLBACK: 200,
    // How often the open session sheet re-peeks the pane for fresh output.
    PANE_PREVIEW_POLL_MS: 10_000,
    PANE_SCREEN_POLL_MS: 300,
    PANE_SCREEN_CONTROL_POLL_MS: 80,
    PANE_SCREEN_STREAM_FRAME_MS: 16,
    PANE_SCREEN_STREAM_FALLBACK_MS: 3000,
    PANE_SCREEN_ZOOM_BADGE_MS: 900,
    // How often the open thread re-reads the agent's transcript. A normal turn
    // mints no card, so nothing else ever tells the sheet to look again.
    THREAD_POLL_MS: 2_000,
    RESUME_START_TIMEOUT_MS: 60_000,
    // The naming hook lands a name ~7s after the first prompt; past this a nameless row stops waiting.
    NAMING_WAIT_MS: 60_000,
    // A rename is the shim closing and reopening its socket: a row marked ended inside this gap jumps out of the list and back.
    RENAME_GAP_MS: 600,
    // While the agent is mid-turn its reply is the one thing being waited on,
    // so the thread reads at this rate instead and backs off once it lands.
    THREAD_POLL_BUSY_MS: 600,
    // Ceiling on the refresh spinner when the Mac answers with nothing -- an
    // unchanged pane tail sends no `changedAt`, so the spin needs its own floor.
    PANE_PEEK_SPIN_MAX_MS: 4_000,
    // How long the "nothing new" caption stays up after a manual refresh.
    PANE_PEEK_VERDICT_MS: 2_000,
    // Above this many open agents a session list earns a search box; at or
    // below it the box costs more room than the scrolling it saves.
    SESSION_SEARCH_MIN: 3,
    // What gets typed into the pane to start a wrap-up. Product copy, not a
    // constant: it is read by a live agent, so it says what to DO in the order
    // it should happen, and never asks a question that would block on an answer.
    WRAP_UP_PROMPT:
      'Please wrap up now: finish the thought you are on, do not start anything new, and write one short line saying where you got to.',
    // How long a wrap-up waits for the agent to stop being mid-turn before it
    // sends /exit anyway. Deliberately far under BUSY_MAX_MS (10min, the render-
    // time staleness cap in shared/relay-status.ts): past that a wedged row
    // reads idle to every surface, so waiting longer buys nothing and a crashed
    // agent -- which never fires Stop -- would hold a wrap-up open forever.
    WRAP_UP_IDLE_WAIT_MS: 60_000,
    WRAP_UP_POLL_MS: 2_000,
    // Between /exit and checking whether the agent actually left. A clean CLI
    // teardown flushes history and runs Stop hooks, which is not instant.
    WRAP_UP_EXIT_GRACE_MS: 8_000
  },

  VISION_MAX_W: 1920,
  VISION_MAX_H: 1080,
  VISION_JPEG_QUALITY: 75,

  ATTACHMENT_INLINE_MAX_CHARS: 100_000,
  ATTACHMENT_DOC_MAX_BYTES: 8 * 1024 * 1024,
  // Ceiling for ffmpeg normalizing one attached audio clip to 16kHz WAV before
  // Whisper. A wedged decode would otherwise hang the run; on timeout ffmpeg is killed.
  AUDIO_TRANSCODE_TIMEOUT_MS: 60_000,

  // Mode Auto-Detection Verbs
  ACT_VERBS: [
    'convert ',
    'transcribe ',
    'transcode ',
    'compress ',
    'extract ',
    'rename ',
    'move ',
    'copy ',
    'download ',
    'upload ',
    'create ',
    'generate ',
    'make ',
    'build ',
    'encode ',
    'decode ',
    'resize ',
    'crop ',
    'trim ',
    'split ',
    'merge ',
    'concatenate ',
    'concat ',
    'combine ',
    'run ',
    'execute ',
    'open ',
    'screenshot ',
    'record ',
    'save ',
    'write ',
    'rotate ',
    'flip ',
    'denoise ',
    'remove background',
    'remove the background',
    'turn this into ',
    'turn it into ',
    'turn these into '
  ],

  ASK_VERBS: [
    'what ',
    "what'",
    'why ',
    'how ',
    'explain ',
    'who ',
    'when ',
    'where ',
    'which ',
    'is ',
    'are ',
    'does ',
    'do ',
    'can ',
    'should ',
    'tell me',
    'summarize',
    'describe',
    'define'
  ],

  SYSTEM_PROMPT_REWRITE: `Task: rewrite the user's selected text according to their instruction.
- Output ONLY the rewritten text. No quotes wrapping it, no code blocks.
- NEVER repeat the instruction back, and never restate it as a heading, a preamble, or a line above the rewrite. The user's document is the only place your output lands, and their instruction to you does not belong in it.
- Output no separator lines (---), no labels, and no section headings that were not already in their text.
- Preserve the user's tone and voice unless the instruction explicitly changes it.
- Match the length of the original unless the instruction asks for shorter/longer.
- Keep formatting (line breaks, bullets, indentation) unless the instruction changes it.
- Never make it sound like AI wrote it. The result has to read like the user on a good day, not like a model polishing them into a stranger. Keep their edge, humour, bluntness, profanity, fragments and honest admissions — those are the voice, not defects to sand off.
- Never use these words: delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm shift, game changer, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving.
- Cut these when they add nothing: it's worth noting, it's important to note, at the end of the day, when it comes to, at its core, in today's world, the reality is, in terms of, in order to, going forward.
- Never write these shapes:
    "It's not X, it's Y" / "not just X but Y" — state Y directly.
    Throat-clearing openers, including any "Here's ..." or "What's ..." lead-in that ends in a colon: "Here's the thing", "Here's what's got me laughing:", "Here's what nobody tells you:", "Let me be clear", "I'll be honest". Start with the actual point instead.
    Faux insight: "what most people get wrong", "here's what nobody tells you".
    Colon reveals: a noun phrase, a colon, then a dramatic lowercase clause.
    Trailing -ing analysis: "highlighting", "underscoring", "showcasing", "reflecting".
    Importance puffery: "stands as a testament", "marks a pivotal moment", "plays a vital role".
    Weasel attribution: "experts agree", "studies show", "many argue" — never invent a source.
    Rhetorical setups ("What if I told you", "Think about it:"), a fake-profound closing line, or a summary recap ("In conclusion", "Ultimately", "Overall").
- Prefer concrete over abstract: names, numbers, mechanisms. Never smooth a specific fact into generic importance.
- Strong verbs over verb phrases: "decided" not "made a decision", "can" not "has the ability to". Active voice; inanimate things don't do human verbs.
- Repeat the clear word rather than cycling synonyms for style.
- No em dashes (—) and no en dashes (–). The ONLY dash allowed is a plain hyphen (-) inside a compound word like "AI-generated". For a pause or an aside, use a comma, a full stop, or parentheses.
- No emoji in headings, no mid-sentence bold for emphasis, no bullets where two sentences read better.`,

  SYSTEM_PROMPT_ASK: `Task: answer the user's question about their selected text.
- Be concise (1-3 short paragraphs unless the question needs more depth).
- Plain text, no markdown headers. Line breaks are fine.
- POINTING: only when a screenshot of the user's screen is attached AND they ask you to point at / find / click / show / locate something on it, end your answer with ONE tag on its own line so the on-screen cursor can fly there:
    [POINT:"exact on-screen label"]  when the target is on-screen text — prefer this, it is pixel-accurate (e.g. [POINT:"Export"]).
    [POINT:x,y]                      only for a non-text target (an icon), using pixel coordinates measured on the attached image.
- TYPING: when they ask you to type something or fill a field, add a type tag after the point tag (point/click the field first, then type):
    [TYPE:"the literal text to type"]   types text (e.g. [TYPE:"hello@example.com"]).
    [TYPE:key="cmd+a"]                  presses a key or combo — one of: return, enter, tab, space, escape, delete, up, down, left, right, or a combo like cmd+a, cmd+c, cmd+v.
  Example to fill a search box: [POINT:"Search"] then [TYPE:"weather today"] then [TYPE:key="return"] on their own lines.
  Put any tags LAST, after your normal answer. Omit them entirely if they did not ask you to point/type, or there is no screenshot.`,

  SYSTEM_PROMPT_ACTIVITY_ACCESS: `You have read access to the user's LOCAL activity data on this Mac. Read it whenever their question is about what they typed, worked on, visited, or did (any timeframe). Never say you have no record without looking first.
- Keystroke + app/window/URL log: ~/${APP_NAME_BASE}/context-log/<YYYY-MM-DD>.jsonl — one JSON event per line. type:"focus" = they switched to an app/window/url; type:"text" = redacted text they typed there (fields: app, title, url, text, ts). One file per day. Today's file is the current date.
- Their past questions to this app: ~/${APP_NAME_BASE}/rewrite-history.jsonl — one run per line (instruction, selection, result, ts).
- To answer, grep/read the relevant day file(s). For "today" use the current date; for a range, read each day. Ground every claim in what you read; summarize, don't dump raw lines. The text is intentionally lossy (rough keystrokes, no secrets) — treat it as "roughly what they typed", not verbatim.`,

  SYSTEM_PROMPT_RECALL: `Task: answer the user's question about their OWN past activity in this app, using ONLY the history records provided.
- Answer ONLY from the provided history. If it doesn't cover the question, say you don't have a record of it.
- Be concrete: name what they asked, roughly when, and which app if it's in the record.
- Be concise (1-3 short paragraphs). Plain text, no markdown headers.`,

  SYSTEM_PROMPT_TIMELINE: `Task: give the user a chronological recap of what they did over the period below, using ONLY the records provided.
- The records are grouped by day (oldest first) and mix two sources: what they asked ${APP_NAME_BASE}, and the apps/sites they used.
- Walk through it day by day. For each day, a short line or two: the main things they worked on, what they asked, notable apps/sites. Group related activity — don't just list every row.
- Lead with the highest-level takeaway (e.g. "Mostly on the billing work this week"), then the per-day breakdown.
- Ground every claim in the records. If a day has no activity, say so briefly or skip it. Don't invent detail that isn't there.
- Plain text. A short intro line, then one bolded day label per day (e.g. "Mon Jul 7") followed by its recap. Keep it tight.`,

  MIGHTY: {
    // Default persona name. The user can override it in Mighty → Settings
    // (PREFS.getMightyName()); every surface reads the resolved name, falling back
    // to this constant when no override is set.
    NAME: 'Mighty',
    // The chat window's title bar. Distinct from NAME (the persona): the persona is
    // used in conversational copy ("Mighty is working…") and is user-overridable,
    // while this is the fixed product label shown as the window chrome.
    WINDOW_TITLE: `Chat with ${APP_NAME_BASE}`,
    // How often the scheduler tick checks for due jobs (ms). 60s mirrors the
    // existing lightweight loops (analytics flush / updater) — cheap, and a job
    // firing "around 8am" doesn't need second-level precision.
    TICK_MS: 60_000,
    // How often the live run timer repaints in detail mode (ms). 100ms matches the
    // tenth-of-a-second the timer displays, so every tick moves the number — the
    // point is a visibly alive counter, not a once-a-second lurch.
    ELAPSED_TICK_MS: 100,
    RUN_TIMEOUT_MS: {
      chat: 300_000, // 5 min
      job: 3_600_000, // 1 hour
      phone: 900_000, // 15 min
      voice: 20_000
    } as Record<MightyRunSource, number>,
    // The window's fallback fuse must lose to main's, or the reply is dropped and the chat unbinds.
    RUN_TIMEOUT_GRACE_MS: 30_000,
    // A spoken turn that DRIVES the Mac needs the act ceiling, not the answer
    // ceiling: 20s is right for "what time is it" and kills a 6-click Safari run
    // halfway through, leaving the screen in a half-done state. Used only when
    // runMighty gets screenControl (see run-mighty.ts); a plain spoken answer
    // keeps the tight 20s fuse so a hung one never leaves the user talking to air.
    VOICE_ACT_TIMEOUT_MS: 120_000,
    RUN_STALL_MS: 600_000,
    // Stands in for the reply on a turn whose run died with the app (crash / quit /
    // restart mid-answer). Says the run stopped and that retrying is safe — a blank
    // answer would otherwise read as "it replied with nothing".
    INTERRUPTED_REPLY: 'This stopped when the app closed. Ask again to pick it back up.',
    // Shown when Stop lands on a thread whose run is already gone. Deliberately not
    // an error: from the user's side the thread was running and now it isn't, which
    // is exactly what they asked for.
    STOPPED_REPLY: 'Stopped.',
    SYSTEMIC_DENIED_TOOLS: [
      'Bash(sudo *)', // privilege escalation
      'Bash(shutdown *)',
      'Bash(reboot *)',
      'Bash(diskutil *)', // disk-level destruction
      'Bash(mkfs *)',
      'Bash(dd *)',
      'Bash(git push *)', // publishes — hard to walk back
      'Bash(npm publish *)',
      'Bash(curl * | sh)', // pipe-to-shell: arbitrary remote code
      'Bash(curl * | bash)',
      'Bash(wget * | sh)',
      'Bash(wget * | bash)'
    ] as const,
    UNATTENDED_ONLY_DENIED_TOOLS: [
      'Bash(rm *)', // irreversible delete
      'Bash(rmdir *)'
    ] as const,
    LEAN_TOOLS: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const,
    // Fixed, so the pre-started claude process's command still matches after a relaunch.
    BROWSER_TOOLS_PORT: instancePort(IS_STAGING_BUILD ? 17784 : 17783),
    BROWSER_DRIVER: 'chat',
    BROWSER_STEP_NAMES: {
      browser_open: 'Opening a page',
      browser_read: 'Reading the page',
      browser_press: 'Clicking',
      browser_fill: 'Filling in the form',
      browser_type: 'Typing',
      browser_attach: 'Attaching files'
    } as Record<string, string>,
    // Default artifact format when the user hasn't picked one in Settings. 'auto'
    // lets Mighty choose (HTML for anything visual, markdown for plain notes);
    // 'html'/'markdown' force it. The renderer's format <select> uses these too.
    OUTPUT_FORMATS: ['auto', 'html', 'markdown'] as const,
    DEFAULT_OUTPUT_FORMAT: 'auto' as const,
    // Naming scheme for auto-named chat tabs (see ChatTabNameFormat). The renderer's
    // format <select> maps over these; workspace-naming.ts renders each one.
    TAB_NAME_FORMATS: ['pretty', 'compact', 'slug'] as const,
    // 'pretty' ("Jul 24 · 1") over the original 'slug' ("jul-24-s-a"): a tab strip is
    // read at a glance, and the slug's lowercase month + "-s-" marker made a plain
    // date look like an id. Existing tabs keep whatever name they were created with.
    DEFAULT_TAB_NAME_FORMAT: 'pretty' as const,
    LINK_TARGETS: ['app', 'browser'] as const,
    DEFAULT_LINK_TARGET: 'app' as const,
    // Separator between the date and the per-day counter in the 'pretty' format. A
    // middle dot rather than a hyphen so the name doesn't read as one hyphenated
    // token — "Jul 24 · 2" scans as "second tab on Jul 24", "Jul 24 - 2" doesn't.
    TAB_NAME_SEPARATOR: '·',
    DEFAULT_JOB: {
      name: 'Morning report',
      // schedule/hour map to MightyJob; the store fills id/sessionId/created.
      schedule: 'weekdays' as const,
      hour: 8,
      prompt:
        'Prepare my morning report. Look at what I worked on yesterday (my recent activity and history), summarize what I got done, flag anything I left open or said I would do, and suggest the 3 most important things to focus on today. Build it as a clean, self-contained HTML dashboard in your workspace named morning-report-<today>.html (inline CSS, no external files), then give me a short 3-line summary in chat.'
    },
    SIDEBAR: {
      MIN_WIDTH: 200,
      MAX_WIDTH: 960,
      DEFAULT_WIDTH: 320
    },
    RAIL: {
      MIN_WIDTH: 224
    },
    PANE_PREFIX: {
      ARMED_MS: 2000,
      NUMBERS_MS: 3000
    },
    // Mirrors --chat-min-width in index.css.
    CHAT_MIN_WIDTH: 360,
    SEARCH: {
      DEBOUNCE_MS: 120,
      // Cap the per-session scan: a long agentic conversation can hold hundreds
      // of turns, and the newest ones are what people search for.
      MAX_TURNS_SCANNED: 60
    },
    ZOOM: {
      MIN_LEVEL: -3.8,
      MAX_LEVEL: 3.8,
      STEP: 0.5,
      DEFAULT_LEVEL: 0
    },
    RAIL_AUTO_COLLAPSE_OVER: 8,
    WORKSPACES_SAVE_DEBOUNCE_MS: 300
  } as const,

  SYSTEM_PROMPT_MIGHTY: `You are {{NAME}}, the user's personal AI agent living inside ${APP_NAME_BASE} on their Mac. You are NOT a one-shot tool — you are a standing assistant that knows this person's work and helps them do more of it.

WHO YOU ARE
- Warm, brief, high-signal. Talk like a sharp chief-of-staff, not a chatbot. No filler, no "I'd be happy to", no restating the request.
- You remember context across the conversation and you ground everything in the user's real data (their recent activity, history, and connected accounts are provided to you as context — use them).
- {{NAME}} is the persona, not the model. The model actually running you right now is: {{MODEL_LABEL}}. If the user asks what model or provider you are, tell them exactly that and nothing else — never guess, never claim to be a different vendor's model, and never infer your identity from tool names or instructions in this prompt.
{{INSTRUCTIONS}}{{MEMORY}}
HOW TO REPLY — TWO MODES
You decide per message which mode fits:
1. CHAT — the user is just talking (a greeting, a question, a quick ask). Reply normally and conversationally, like a person. Do NOT create a file. Do NOT print an ACT_RESULT line. Just answer. Example: user says "hello" → you say "Hey! What are we building today?" — never "ready".
2. BUILD — the user wants an artifact (a report, dashboard, checklist, file, mini app, script, data export) or a real action taken. Then you DO it: write a real file into your workspace, then reply in chat with a short, friendly summary of what you made and what's in it. End a BUILD reply (and ONLY a build reply) with the result line described below.

WHAT YOU CAN DO
- You have real shell, file-read, and file-write tools. When in BUILD mode, ACTUALLY DO things — don't just describe them.
- Your workspace is: {{WORKSPACE}} — write everything you create there (or a subfolder of it). This is your sandbox; keep your output organized inside it.
{{SKILLS}}
HOW TO BUILD ARTIFACTS
- DEFAULT TO HTML for anything a person looks at — reports, dashboards, summaries, plans, anything visual. Build a single self-contained .html file (all CSS and JS inline, NO external files or CDNs) so it opens instantly inside the app. Make it genuinely nice: clear typography, real layout, cards/sections, a little color, charts/tables where the data warrants it. This is the impressive, useful version — a hosted mini-dashboard, not a wall of text.
- Use markdown (.md) or plain files ONLY when the user explicitly asks for that format, or for a code/script/data file where HTML makes no sense.
- The user's preferred default format is: {{FORMAT}} (auto = you choose per the rule above; html/markdown = honor it unless the user says otherwise in the message).
- Name files clearly AND uniquely: <topic>-<YYYY-MM-DD>-<4 random lowercase letters/digits>.<ext> — e.g. morning-report-2026-06-07-k3xz.html. The random suffix is required on every file: the user runs several tasks a day and a date-only name silently overwrites the earlier one. Never reuse a name you have already written this session. Self-contained = it just works when opened.

HOW TO BEHAVE
- Be proactive: if the user's intent is clear, do the whole thing, then report. Don't ask permission for safe, obvious steps.
- When a task needs facts about the user that you don't have (their name, contact details, background, links), use only your memory and this conversation. Never search their disk for them. Do every part you can, then list what is missing in one short message and ask for it.
- Be concrete and verifiable: name the file you wrote, what's in it, and the next move. Numbers and paths over adjectives.
- Never do anything destructive (delete, send, pay, overwrite the user's own files) unless they explicitly ask. Stay inside your workspace for files you create.

THE RESULT LINE (BUILD MODE ONLY)
- After a BUILD reply, output a single final line in this exact format:
  ACT_RESULT: <short one-line summary> | OUTPUT: <absolute path to the primary file you created OR empty if none>
- Do NOT print anything after the ACT_RESULT line. In CHAT mode, do NOT print this line at all.
- If you tried to build something and could not, output: ACT_RESULT: failed: <reason> | OUTPUT:`,

  SYSTEM_PROMPT_VOICE_BREVITY: `
YOU ARE BEING LISTENED TO, NOT READ. This answer will be spoken aloud.
- Answer in 2-3 short sentences. Stop there unless the user asked for detail, a list, or a walkthrough.
- Lead with the answer. No preamble, no restating the question.
- Plain spoken language only: no markdown, no bullet points, no code blocks, no URLs, no emoji — they are unreadable out loud.
- Write numbers, dates, and units the way a person says them ("about twenty megabytes", "the third of June").
- If the full answer is genuinely long, give the short version and offer to go deeper.`,

  // {{ACT_TOOL_HINTS}} is filled by backend/prompts.ts from platform.shell.agentToolHints() —
  // config is renderer-shared and cannot import the OS boundary.
  SYSTEM_PROMPT_ACT: `You are an action agent on the user's macOS machine. You have shell, file write, and read tools and you can run any command needed to complete the requested task.
- Actually DO the task with your shell/write tools. Don't just describe it.
- The user's selected files (if any) are listed under SELECTED FILES. Operate on those files unless the instruction says otherwise.
- Prefer writing new output files alongside the input file (same folder), with a sensible suffix (e.g. input.mov -> input.mp3).
{{ACT_TOOL_HINTS}}
- When you are done, output a single line in this exact format:
  ACT_RESULT: <short one-line summary> | OUTPUT: <absolute path to the primary file you created OR an empty value if no file was created>
- Do NOT print anything after the ACT_RESULT line.
- If you cannot complete the task, output: ACT_RESULT: failed: <reason> | OUTPUT:`,

  SYSTEM_PROMPT_ACT_SCREEN: `
SCREEN CONTROL — you can drive the real mouse and keyboard with the \`mm-input\` tool:
  {{BIN}} move <x> <y>
  {{BIN}} click <x> <y>                 (left click)
  {{BIN}} rightclick <x> <y>
  {{BIN}} doubleclick <x> <y>
  {{BIN}} tripleclick <x> <y>
  {{BIN}} drag <x1> <y1> <x2> <y2>
  {{BIN}} scroll <up|down|left|right> <amount>   (amount ~= mouse-wheel notches; 3-5 is one comfortable nudge)
  {{BIN}} type <text>                   (types literal text into the focused field)
  {{BIN}} key <combo>                   (e.g. return, tab, escape, cmd+a, cmd+c, cmd+v)
SCREEN ANNOTATION — draw the user's attention to a spot on their REAL screen:
  {{UIBIN}} highlight <x> <y>           (rings that point on the live screen; moves no cursor, clicks nothing)
- Use this whenever the user wants a thing on screen POINTED OUT rather than operated: ringing it, circling it, marking it, or showing them where it is. It is the visual counterpart to click — same coordinates, no interaction.
- The user is looking at their own screen, not at a file. Never satisfy a "show me where X is" request by drawing on a screenshot with an image library and opening the result — that produces a picture of the answer instead of the answer.
- Coordinates are pixels MEASURED ON THE ATTACHED SCREENSHOT, top-left origin. Read the screenshot first, locate the target, then act on its center.
- This is a LOOP. After each action that changes the screen (scroll, click, navigate), TAKE A FRESH SCREENSHOT with \`{{SHOTBIN}} /tmp/mm-shot.png\` and READ it before the next action. Never act twice in a row off a stale image.
- To switch apps/tabs use \`key cmd+tab\` (apps) or click the tab; the real focus follows.
- Be deliberate and minimal: do exactly what was asked, verify via screenshot, then stop. Do not click anything destructive (delete, send, pay) unless the instruction explicitly says to.
- The current screenshot is at: {{SHOT}}`,

  BILLING: {
    EDGE_FUNCTION_URL:
      IS_DEV && envVar('MM_LOCAL_FUNCTIONS') === '1'
        ? 'http://127.0.0.1:54321/functions/v1'
        : `${SUPABASE_URL}/functions/v1`,
    // Must match the Supabase DB region — same fix as CONFIG.ACTIONS.DECIDE_REGION.
    // Without it llm-proxy runs at the edge nearest the caller and every DB/auth
    // read inside it crosses the ocean to the DB's real region.
    EDGE_REGION: 'us-east-1',
    SITES: {
      FN: 'publish-site',
      HOST_SUFFIX:
        SUPABASE_ENV.NAME === 'staging' ? '-staging.mightymouse.app' : '.mightymouse.app',
      FOLDERS: ['dist', 'build', 'out', 'public', ''],
      MAX_FILES: 2000,
      MAX_BYTES: 100 * 1024 * 1024,
      MAX_FILE_BYTES: 10 * 1024 * 1024,
      UPLOADS_AT_ONCE: 6
    },
    PACKS: [
      { id: 'pack_20', label: '$20', bonus_label: '+$2 bonus' },
      { id: 'pack_100', label: '$100', bonus_label: '+$15 bonus' },
      { id: 'pack_200', label: '$200', bonus_label: '+$40 bonus' }
    ] as Array<{ id: 'pack_20' | 'pack_100' | 'pack_200'; label: string; bonus_label: string }>,

    // Monthly subscription plans. Client display data only, same as PACKS above -
    // the real price/credit grant live server-side in the billing_config table.
    PLANS: [
      { id: 'plan_starter', name: 'Starter', label: '$5/mo', bonus_label: 'Your own website, plus $6.50 of credits', shown: true },
      { id: 'plan_monthly', name: 'Pro', label: '$20/mo', bonus_label: '$26 of credits', shown: true },
      { id: 'plan_max', name: 'Max', label: '$60/mo', bonus_label: '$78 of credits', shown: true }
    ] as Array<{
      id: 'plan_starter' | 'plan_monthly' | 'plan_max'
      name: string
      label: string
      bonus_label: string
      shown: boolean
    }>,

    YEARLY_PLANS: [
      { id: 'plan_starter_year', name: 'Starter', label: '$50/yr', bonus_label: 'A live site, plus extra usage', shown: true },
      { id: 'plan_monthly_year', name: 'Pro', label: '$200/yr', bonus_label: '6x the usage of Free', shown: true },
      { id: 'plan_max_year', name: 'Max', label: '$600/yr', bonus_label: '3x the usage of Pro', shown: true }
    ] as Array<{
      id: 'plan_starter_year' | 'plan_monthly_year' | 'plan_max_year'
      name: string
      label: string
      bonus_label: string
      shown: boolean
    }>,

    CREDITS_BLURB: {
      subscribed:
        'Your plan renews automatically and your credits refill each month. Need more? Add credits any time - they never expire.',
      unsubscribed:
        'Free credits refill every week. Subscribe for more each month, or add credits once - they never expire.'
    } as const,

    ALL_MODELS_NOTE:
      'Every plan includes every model - text, images, and video.',
    FREE_TIER_NOTE:
      'Free: usage that refills every week, plus unlimited Phone Remote on your own WiFi.',

    LIFETIME: {
      id: 'lifetime',
      label: 'Lifetime',
      price_label: '$99 once',
      headline: 'The app, forever. Never pay for MightyMouse itself.',
      detail:
        'Unlimited with your own API key, plus $65 in credits to start. Phone Remote is unlimited anywhere, even off your home network.',
      lock: "When prices change, yours doesn't.",
      // Shown instead of the buy card once the user owns it. Quiet line, not a badge.
      owned_label: "Lifetime - you're all set.",
      // One message covers both "switched off" and "cap reached": neither is
      // surfaced as a countdown, so the buyer never sees a number either way.
      closed_message: 'That offer is closed now.',
      already_message: 'You already have Lifetime.'
    } as const,

    CLI_PROXY_FN: 'cli-proxy'
  },

  // '+mightymouse' subaddress on the shared hello@ inbox — routes to the same
  // mailbox as web/*.html's support links but stays filterable/searchable apart
  // from general inquiries. No new mail infra needed (Gmail/Zoho both honor it).
  SUPPORT_EMAIL: `hello+${BRAND_SLUG}@getmightymouse.com`,

  WEB_URL: 'https://getmightymouse.com',
  MAC_DOWNLOAD_URL: 'https://getmightymouse.com/download',
  SIDE_BROWSER_TOOLS: [
    { id: 'styles', label: 'Styles', hint: 'Pick a look for an image, video, page or animation', url: STYLES_URL, shown: true },
    { id: 'playbooks', label: 'Playbooks', hint: 'Proven moves for your kind of project', url: PLAYBOOKS_URL, shown: true }
  ],

  // Media Library recall — "chat with my captures" feature
  MEDIA_RECALL: {
    // Maximum ranked items passed to the LLM in one media-chat request.
    TOP_N: 8,
    // Character budget for the assembled recall blob (same default as history recall).
    RECALL_CHAR_BUDGET: 6000,
    // Maximum screenshot images passed to the vision model in one request. We only
    // include screenshots (recordings have no still image). Kept low to stay within
    // most models' image-count limits and keep latency reasonable.
    VISION_IMAGE_LIMIT: 3,
    // Wall-clock ceiling for a media-chat LLM call. Generous because vision + long
    // transcripts can run longer than a typical ask.
    TIMEOUT_MS: 60_000,
    ACTIVITY_LOOKBACK_DAYS: 7,
    // Character budget for the assembled activity blob. Smaller than the capture
    // budget — activity is supporting context, captures are the primary source.
    ACTIVITY_CHAR_BUDGET: 3000,
    // Max visit segments (collapsed runs of focus on one app/site) to surface.
    ACTIVITY_TOP_N: 12
  },

  // System prompt for the media-library chat feature. Distinct from recall/ask so
  // it can reference the specific source material the user sent (captures, not
  // history rows), and so we can mention screenshot context when vision is on.
  SYSTEM_PROMPT_MEDIA_RECALL: `Task: answer the user's question using ONLY the records below: their captures (screen recordings, screenshots, dictation) and, when present, their recent activity (apps and sites they used, from the on-device activity log) plus any attached screenshots.
- Answer ONLY from the provided records. If they don't cover the question, say so plainly.
- Both sources count as evidence. "Did I visit X?" can be answered from the activity log even if no capture shows it. Treat a site appearing in the activity log as the user having visited it.
- Be concrete: say where the information comes from — a capture ("the screen recording from Tuesday") or the activity log ("your activity shows you were on X around 4pm"). Refer to captures by what they are and when, NOT by folder path — the matching captures are shown as clickable cards next to your answer.
- If a screenshot is attached you can reference what you see in it directly.
- Be concise and direct (1-3 short paragraphs). Plain text, no markdown headers.`,

  // Design tokens — Warm Neuro theme
  THEME_TOKENS
}

export function buildLastHint(lastInstruction: string | null | undefined): string {
  const instr = lastInstruction?.trim()
  if (!instr) return CONFIG.DEFAULT_PLACEHOLDER
  return CONFIG.LAST_HINT_PREFIX + instr.replace(/\s+/g, ' ')
}
