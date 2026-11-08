import { useEffect, useState, useCallback, useRef, Fragment, JSX } from 'react'
import { useInterval } from './hooks/useInterval'
import * as Select from '@radix-ui/react-select'
import type {
  SettingsState,
  BackendTestResult,
  BackendId,
  LocalModel,
  LocalSetupState,
  LocalSetupProgress,
  SubscriptionStatus,
  LifetimeOffer,
  GlobalInstructionsSettings,
  SettingsSectionFocus,
  PhoneRemoteTunnelStatus,
  AgentRelayStatus,
  McpClientId,
  McpClientState,
  VoiceRoutingMode
} from '../../shared/types'
import type { UsageMeter } from '../../shared/billing-math'
import { UsageMeterView } from '../../shared/usage-meter'
import { derivePairing } from '../../shared/phone-remote-pairing'
import { CONFIG } from '../../shared/config'
import { parakeetCanTranscribe } from '../../shared/whisper-languages'
import type { RelayVerbWire } from '../../shared/phone-remote-protocol'
import {
  DEFAULT_RELAY_PUSH_FILTER,
  RELAY_PUSH_VERBS,
  RELAY_PUSH_LABELS,
  RELAY_PUSH_FOOTNOTE,
  RELAY_NOTIFY_LEVEL_LABEL,
  RELAY_NOTIFY_LEVEL_HINT,
  RELAY_TURN_END_LABEL,
  RELAY_TURN_END_HINT,
  DEFAULT_RELAY_TURN_END_PING,
  type RelayNotifyPushLevel,
  type RelayPushSettings
} from '../../shared/relay-push-filter'
import {
  CursorStyleId,
  DEFAULT_CURSOR_STYLE,
  toCursorStyle,
  visibleCursorStyles
} from '../../shared/cursor-styles'
import { LanguagePicker } from './components/settings/LanguagePicker'
import { BackendConnections } from './components/settings/BackendConnections'
import { PlanLogins } from './components/settings/PlanLogins'
import { OpenRouterKey } from './components/settings/OpenRouterKey'
import { MouseGlyph } from './MouseGlyph'
import { LoadingBody } from './WindowFrame'
import { ChatPrefs, type ChatSettingsHooks } from './mighty/MightySecondaryTabs'
import { MightyMacAlerts } from './mighty/MightyMacAlerts'
import { PulseSetting } from './components/session-pulse-mac'
import { AllProjectsModal } from './mighty/AllProjectsModal'
import { GlowDot } from './components/GlowDot'
import { Switch } from './components/Switch'
import { Badge } from './components/Badge'
import { Button } from './components/Button'
import { CopyButton } from './components/CopyButton'
import { PAIR_QR_SIZE } from './components/PairQr'
import { PairingPanel } from './components/PairingPanel'
import { ProgressBar } from './components/ProgressBar'
import { KokoroVoiceCard } from './components/KokoroVoiceCard'
import { SegmentedControl } from './components/SegmentedControl'
import { MultiSelectDropdown, type MultiSelectOption } from './components/MultiSelectDropdown'
import { ProviderIcon, type ProviderIconId } from './components/ProviderIcon'
import { UsageHistory } from './components/UsageHistory'
import { ActionsSettingsSection } from './components/ActionsSettingsSection'
import { CARD_CLS, SECTION_HEADER_CLS } from './components/Card'
import {
  SECTIONS,
  ADMIN_ONLY_SECTIONS,
  SIMPLE_SECTIONS,
  BUCKETS,
  SECTION_ANCHOR_ID,
  sectionDomId,
  useSidebarVisible,
  SIDEBAR_WIDTH_PX,
  CONTENT_WIDTH_PX,
  COLLAPSE_STORAGE_KEY,
  loadCollapsedSections,
  anySectionVisible,
  bucketOf,
  BUCKET_TITLES,
  SETTINGS_PAGE_STORAGE_KEY,
  type BucketKey,
  type SectionKey,
  type CollapseCtx
} from './components/settings/registry'
import { Section, SettingRow } from './components/settings/sections'
import { SettingsSidebar, SidebarToggle } from './components/settings/SettingsSidebar'
import { relayStatusLine, listNames } from '../../shared/relay-status'
import { TRANSCRIPT_FORMATS, TRANSCRIPT_FORMAT_KEY } from '../../shared/transcript-format'
import { useUpdateNotifications } from './hooks/useUpdateNotifications'
import { prettyOllamaModel } from '../../shared/model-label'
import { ShieldCheck, BarChart3, Search, X, Eye, EyeOff, SquareTerminal } from 'lucide-react'

// Card + section-header classes now live in components/Card.tsx so every
// window shares one definition. Local aliases keep the 30+ usage sites terse.
const cardCls = CARD_CLS
const sectionCls = SECTION_HEADER_CLS
const inputCls =
  'flex-1 w-full bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-mono outline-none transition-colors focus:border-accent focus:shadow-focus'
// Ghost text for a blank binary-path override input — shown when nothing is typed.
const OVERRIDE_PATH_PLACEHOLDER = 'Override path (auto-detected)'
// Top-level grouping header (Essentials / Capture / Advanced). Heavier than the
// per-section sectionCls so the three buckets read as the primary structure.
const bucketCls =
  'text-sm uppercase text-on-surface font-bold tracking-[0.12em] mt-8 mb-1 pb-1.5 border-b border-surface3'

// Auto-update status → human copy + a Badge color family. `idle`/`not-available`
// read as "up to date"; `available` is the actionable state.
type UpdateUiKey =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'download-progress'
  | 'downloaded'
  | 'error'

const UPDATE_STATUS_TEXT: Record<UpdateUiKey, string> = {
  idle: 'Up to date',
  checking: 'Checking for updates…',
  available: 'A newer version is ready to install',
  'not-available': 'Up to date',
  'download-progress': 'Downloading update…',
  downloaded: 'Update downloaded. Restart to install.',
  error: 'Update check failed'
}

const UPDATE_BADGE: Record<UpdateUiKey, { color: string; label: string }> = {
  idle: { color: 'green', label: 'Up to date' },
  checking: { color: 'accent', label: 'Checking' },
  available: { color: 'amber', label: 'Update available' },
  'not-available': { color: 'green', label: 'Up to date' },
  'download-progress': { color: 'accent', label: 'Downloading' },
  downloaded: { color: 'amber', label: 'Ready' },
  error: { color: 'red', label: 'Error' }
}

function UpdateBadge({ state }: { state: UpdateUiKey }): JSX.Element {
  const meta = UPDATE_BADGE[state] || UPDATE_BADGE.idle
  return <Badge color={meta.color}>{meta.label}</Badge>
}

const SETUP_COPY = CONFIG.LOCAL_SETUP_COPY

// Why a setup run stopped, in the user's words. Keyed by the machine-readable
// reason main returns, so the renderer never parses tool output.
const SETUP_FAIL_COPY: Record<string, string> = {
  'no-brew': SETUP_COPY.noBrew,
  'install-failed': SETUP_COPY.installFailed,
  'start-failed': SETUP_COPY.startFailed,
  'no-models': SETUP_COPY.noModels,
  'unsupported-arch': SETUP_COPY.unsupportedArch
}

// The 4 modes custom instructions can apply to — checklist items in the
// Instructions section's multi-select dropdown.
const INSTRUCTIONS_MODE_OPTIONS: MultiSelectOption[] = [
  { value: 'rewrite', label: 'Rewrite' },
  { value: 'ask', label: 'Ask' },
  { value: 'act', label: 'Act' },
  { value: 'mighty', label: 'Mighty' }
]

export const MODELS: Array<{
  value: BackendId
  label: string
  description: string
  icon: ProviderIconId
  badge?: string
  // adminOnly providers are hidden from regular users' picker until someone
  // asks for them. Admins (advancedMenu) still see the full list.
  adminOnly?: boolean
}> = [
  {
    value: 'mightymouse',
    label: CONFIG.PRODUCT_NAME,
    icon: 'mightymouse',
    badge: 'Recommended',
    description: 'Just works. No account to connect.'
  },
  {
    value: 'claude',
    label: 'Claude',
    icon: 'claude',
    description: 'Use your existing Claude subscription.'
  },
  {
    value: 'codex',
    label: 'OpenAI Codex',
    icon: 'codex',
    description: 'Use your existing ChatGPT subscription.'
  },
  {
    value: 'opencode',
    label: 'OpenCode',
    icon: 'opencode',
    adminOnly: true,
    description: 'Use your existing OpenCode / OpenRouter account.'
  },
  {
    value: 'gemini',
    label: 'Gemini',
    icon: 'gemini',
    adminOnly: true,
    description: 'Use your existing Gemini CLI login.'
  },
  {
    value: 'local',
    label: 'Local',
    icon: 'local',
    adminOnly: true,
    description: 'Runs fully offline via Ollama. Nothing leaves your computer.'
  },
  {
    value: 'mlx',
    label: 'Rapid-MLX',
    icon: 'mlx',
    adminOnly: true,
    description:
      'Runs fully offline via Rapid-MLX. Fast Apple Silicon models, nothing leaves your Mac.'
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    icon: 'openrouter',
    adminOnly: true,
    description: 'Use your own OpenRouter key. Hundreds of models, billed by OpenRouter.'
  }
]

export default function SettingsApp({
  onBack,
  chat
}: {
  onBack?: () => void
  chat: ChatSettingsHooks
}): JSX.Element {
  const [state, setState] = useState<SettingsState | null>(null)
  // Platform-specific "no installer" sentence; the Mac default paints until it lands.
  const [ffmpegInstallHint, setFfmpegInstallHint] = useState(CONFIG.CAPTURE_ERROR.brewMissing)
  const [query, setQuery] = useState('')
  const [projectsOpen, setProjectsOpen] = useState(false)
  // Which sections are collapsed, keyed by SectionKey. Missing key = open.
  const [collapsed, setCollapsed] = useState<Partial<Record<SectionKey, boolean>>>(() =>
    loadCollapsedSections()
  )
  // Section to force open regardless of collapsed state — set by a tray deep
  // link (focusSection below); not persisted, and not touched by search
  // (search's force-open is derived straight from `query`, see Section).
  const [forceOpenKey, setForceOpenKey] = useState<SectionKey | null>(null)
  const toggleSection = useCallback((key: SectionKey): void => {
    setCollapsed((prev) => {
      // The map stores COLLAPSED, so flipping a section means storing the
      // negation of its current open state. (This read as a sign error for
      // years because the value was named `isOpen` while living in `collapsed`.)
      const wasOpen = !prev[key]
      const next = { ...prev, [key]: wasOpen }
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage unavailable (private mode, quota) — collapse state just
        // won't persist across window opens this session; not worth surfacing.
      }
      return next
    })
  }, [])
  const { shown: sidebarShown, toggle: toggleSidebar } = useSidebarVisible()
  const [page, setPage] = useState<BucketKey>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_PAGE_STORAGE_KEY)
      if (saved && saved in BUCKETS) return saved as BucketKey
    } catch {
      // Falls back to the first page.
    }
    return 'essentials'
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const openPage = useCallback((next: BucketKey): void => {
    setPage(next)
    scrollRef.current?.scrollTo({ top: 0 })
    try {
      localStorage.setItem(SETTINGS_PAGE_STORAGE_KEY, next)
    } catch {
      // Page choice just won't persist.
    }
  }, [])
  // Search is collapsed to a title-bar icon by default so it takes no vertical
  // space. Opening it reveals a sticky bar; ⌘F opens+focuses, Esc closes+clears.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [showNotes, setShowNotes] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [dlPct, setDlPct] = useState<number | null>(null)
  // Latest brew output line during an ffmpeg/whisper install — proof of life on
  // a multi-minute job, so the button never looks hung.
  const [installLine, setInstallLine] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // Editable path fields
  const [ffmpeg, setFfmpeg] = useState('')
  const [whisper, setWhisper] = useState('')
  const [whisperModel, setWhisperModel] = useState('')
  const [whisperLang, setWhisperLang] = useState(CONFIG.WHISPER_LANG)
  const [videoDevice, setVideoDevice] = useState('')
  const [audioDevice, setAudioDevice] = useState('')
  const [siriScreenAnswer, setSiriScreenAnswer] = useState(true)
  const [smallPanel, setSmallPanel] = useState(false)
  const [holdForSmart, setHoldForSmart] = useState(false)
  const [advancedMode, setAdvancedMode] = useState(false)
  const [webAccess, setWebAccess] = useState(true)
  const [codeOwnCopy, setCodeOwnCopy] = useState(false)

  // Live PREFS toggles (write-through on change, not gated behind Save)
  const [backend, setBackend] = useState<BackendId>('claude')
  const backendRowRef = useRef<HTMLDivElement | null>(null)
  const [ollamaModel, setOllamaModel] = useState('')
  const [mlxModel, setMlxModel] = useState('')
  const [thinkingEnabled, setThinkingEnabled] = useState(false)
  // Shared list state for BOTH local backends (`local`/Ollama and `mlx`/Rapid-MLX) —
  // only one backend is active at a time, so one list slot serves whichever is picked.
  const [localModels, setLocalModels] = useState<LocalModel[]>([])
  const [localModelsLoading, setLocalModelsLoading] = useState(false)
  // One-click setup for the two local services. `setupState` is derived in main
  // (install vs start vs nothing); `setupBusy` non-null means a run is live.
  const [setupState, setSetupState] = useState<LocalSetupState | null>(null)
  const [setupBusy, setSetupBusy] = useState<LocalSetupProgress | null>(null)
  const [setupRunning, setSetupRunning] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [cursorCompanion, setCursorCompanion] = useState(false)
  const [cursorStyle, setCursorStyle] = useState<CursorStyleId>(DEFAULT_CURSOR_STYLE)
  const [maxRecMin, setMaxRecMin] = useState(5)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [captureHud, setCaptureHud] = useState(true)
  const [dynamicIsland, setDynamicIsland] = useState(false)
  const [selectionBar, setSelectionBar] = useState(true)
  const [liveCompanion, setLiveCompanion] = useState(false)
  // Whether a voice turn may CLICK AND TYPE on the Mac, as opposed to only
  // answering out loud. Off is the safe half of voice mode, and until now it had
  // no control anywhere in the product.
  const [liveActs, setLiveActs] = useState(true)
  // Which companion the voice loop draws. Only two are user-facing: the mouse
  // character, and Stage. (warp2d/placeholder stay dev-only picks in the debug
  // panel — see companion-renderers.ts.)
  const [dockIcon, setDockIcon] = useState(false)
  const [suggestions, setSuggestions] = useState(false)
  // Defaults true to match the pref, so the switch doesn't flash off before the
  // first settings payload lands.
  const [fnListenEnabled, setFnListenEnabled] = useState(true)
  const [clickEnabled, setClickEnabled] = useState(false)
  const [actHighlight, setActHighlight] = useState(true)
  const [voiceRoutingMode, setVoiceRoutingMode] = useState<VoiceRoutingMode>('off')
  const [voiceRoutingGoTo, setVoiceRoutingGoTo] = useState(false)
  const [voiceRoutingSkills, setVoiceRoutingSkills] = useState(true)
  const [voiceRoutingAgents, setVoiceRoutingAgents] = useState(true)
  const [feedbackEnabled, setFeedbackEnabled] = useState(true)
  const [listenAutoPaste, setListenAutoPaste] = useState(true)
  const [transcriptFormats, setTranscriptFormats] = useState<Record<string, boolean>>({})
  const [contextLog, setContextLog] = useState(false)
  const [agentPhotos, setAgentPhotos] = useState(false)
  const [decisionCards, setDecisionCards] = useState(false)
  const [runTranscript, setRunTranscript] = useState(false)
  // Seeded ON to match the pref's default, so the switch doesn't flash off for the
  // frame before settingsGetPrefs resolves.
  const [showTiming, setShowTiming] = useState(true)
  const [historyEncryption, setHistoryEncryption] = useState(false)
  const [incognito, setIncognito] = useState(false)
  const [phoneRemoteEnabled, setPhoneRemoteEnabled] = useState(false)
  // Windows has no pointer synthesis, so the whole section is hidden rather than
  // offering a trackpad that cannot move the cursor.
  const [phoneRemoteSupported, setPhoneRemoteSupported] = useState(true)
  const [phoneRemoteStayAwake, setPhoneRemoteStayAwake] = useState(false)
  const [extendedScreenOn, setExtendedScreenOn] = useState(false)
  const [phoneRemoteClamshell, setPhoneRemoteClamshell] = useState(false)
  const [clamshellError, setClamshellError] = useState<string | null>(null)
  const [phoneRemoteAwayMode, setPhoneRemoteAwayMode] = useState(false)
  const [awayModeError, setAwayModeError] = useState<string | null>(null)
  const [phoneRemoteAwayHeld, setPhoneRemoteAwayHeld] = useState(false)
  const [coverBusy, setCoverBusy] = useState(false)
  // QR data URL for the current server session; null = not fetched/shown. Cleared
  // on toggle-off so a stale QR (pointing at a dead server) never lingers on screen.
  const [phoneRemoteQr, setPhoneRemoteQr] = useState<string | null>(null)
  const [phoneRemoteConnected, setPhoneRemoteConnected] = useState(false)
  const [phoneRemoteError, setPhoneRemoteError] = useState<string | null>(null)
  const [agentRelay, setAgentRelay] = useState<AgentRelayStatus>({ enabled: false, running: false })
  const [relayPush, setRelayPush] = useState<RelayPushSettings>({
    filter: DEFAULT_RELAY_PUSH_FILTER,
    notifyLevel: 'all',
    turnEndPing: DEFAULT_RELAY_TURN_END_PING
  })
  const [agentRelayTestState, setAgentRelayTestState] = useState<
    'idle' | 'sending' | 'sent' | { error: string }
  >('idle')
  const [mcpClients, setMcpClients] = useState<McpClientState[]>([])
  const [mcpClientError, setMcpClientError] = useState<string | null>(null)
  const [showManualSnippet, setShowManualSnippet] = useState(false)
  // Off-Wi-Fi access (Cloudflare Tunnel): no detection gate — nothing needs to
  // be pre-installed. Status streams live from main while it sets up (download
  // pct → provisioning → up), so the row is never a frozen spinner.
  const [tunnelEnabled, setTunnelEnabled] = useState(false)
  const [tunnelStatus, setTunnelStatus] = useState<PhoneRemoteTunnelStatus>({ state: 'stopped' })
  const [tunnelQr, setTunnelQr] = useState<string | null>(null)
  const [globalInstructions, setGlobalInstructions] = useState<GlobalInstructionsSettings>({
    text: '',
    appliesTo: { rewrite: true, ask: true, act: true, mighty: true }
  })
  // Is the signed-in user an admin? Server truth — an email allowlist in
  // main/auth.ts. Never a toggle. This is the REAL check: it ignores the
  // preview below, so the switch that turns the preview off stays reachable.
  const [isAdmin, setIsAdmin] = useState(false)
  // Admin-only preview: hide every admin surface — here AND in the tray — so an
  // admin sees the app exactly as a real user does. Lives in the main process
  // (session-only, never persisted) so both surfaces flip together; it gates
  // RENDERING only, since main-process handlers re-check the real email.
  const [viewAsUser, setViewAsUser] = useState(false)
  // The one gate every admin-only section reads. An admin previewing as a user
  // is treated as a non-admin for RENDERING only.
  const advancedMenu = isAdmin && !viewAsUser
  const simple = !advancedMode
  const pageAvailable = (bucket: BucketKey): boolean =>
    (BUCKETS[bucket] as readonly SectionKey[]).some(
      (k) =>
        (!simple || SIMPLE_SECTIONS.includes(k)) &&
        (advancedMenu || !ADMIN_ONLY_SECTIONS.includes(k)) &&
        (k !== 'phoneRemote' || phoneRemoteSupported)
    )
  const shownPage: BucketKey = pageAvailable(page) ? page : 'essentials'
  const paged = sidebarShown && !query.trim()
  const collapse: CollapseCtx = {
    collapsed,
    onToggle: toggleSection,
    forceOpenKey,
    simple,
    page: paged ? BUCKETS[shownPage] : null
  }
  const showBucketHeader = (keys: readonly SectionKey[]): boolean =>
    !paged && anySectionVisible(query, simple ? keys.filter((k) => SIMPLE_SECTIONS.includes(k)) : keys)

  // Signed-in account (Supabase auth)
  const [account, setAccount] = useState<{ email: string; userId: string } | null>(null)
  // Account deletion is armed by the first click and fired by the second.
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Hidden debug panel (platform, app version, user id) — revealed by
  // double-clicking the "Settings" title. Not persisted; off on every open.
  const [showDebug, setShowDebug] = useState(false)

  // Auto-update status (live broadcasts from main) + a local "just clicked check" flag.
  const update = useUpdateNotifications()
  const [checking, setChecking] = useState(false)

  // Credits balance (null = not loaded yet, undefined = user not on mightymouse backend)
  const [balanceCents, setBalanceCents] = useState<number | null>(null)
  const [usage, setUsage] = useState<UsageMeter | null>(null)
  // Top-up UX: which pack is mid-checkout, plus a status line (error or "opened in browser").
  const [topupPending, setTopupPending] = useState<string | null>(null)
  const [topupMsg, setTopupMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // Track polling interval so we can clear it on unmount or re-topup
  const topupPollRef = useRef<NodeJS.Timeout | null>(null)
  // Credits tab: Monthly (subscribe) vs One-time (packs). Defaults to Monthly —
  // that's the growth goal, and it's the tab that needs the nudge; a one-time
  // buyer will find the other tab in one click regardless.
  const [creditsTab, setCreditsTab] = useState<'monthly' | 'onetime'>('monthly')
  // Current subscription (null = none / not subscribed). Loaded once on mount
  // and re-pulled after a checkout return, so "Subscribed" flips without a
  // manual refresh.
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null)
  // Whether the Lifetime offer can be bought right now. null = unknown (signed
  // out, or the server call failed) and renders NOTHING — fail closed, so a
  // capped offer is never shown when we can't confirm it's live.
  const [lifetime, setLifetime] = useState<LifetimeOffer | null>(null)

  // Backend connection test
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<(BackendTestResult & { backend: BackendId }) | null>(
    null
  )

  // THE way to land on a section, whether the request came from another window
  // (tray, the QR window's upgrade CTA) or from a button in this one. Clear the
  // search first so the target can't be filtered out, force it open so it isn't
  // a collapsed empty header, then scroll once that re-render has landed.
  const jumpToSection = useCallback(
    (key: SectionKey): void => {
      openPage(bucketOf(key))
      setForceOpenKey(key)
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          document
            .getElementById(sectionDomId(key))
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        )
      )
    },
    [openPage]
  )

  const focusSection = useCallback(
    (section: SettingsSectionFocus): void => {
      setQuery('')
      jumpToSection(section)
    },
    [jumpToSection]
  )

  // Seed the editable form fields from stored settings. Call ONLY on initial
  // load and right after an explicit Save — NOT from the 4s status poll, or
  // it clobbers an in-progress edit (e.g. a freshly picked audio device) with
  // the still-stale stored value before the user can hit Save.
  const seedForm = useCallback((s: SettingsState) => {
    setFfmpeg(s.paths.ffmpeg)
    setWhisper(s.paths.whisper)
    setWhisperModel(s.paths.whisperModel)
    setWhisperLang(s.whisperLang)
    setVideoDevice(s.devices.video)
    setAudioDevice(s.devices.audio)
    setSiriScreenAnswer(s.siriScreenAnswer)
    setSmallPanel(s.smallPanel)
    setHoldForSmart(s.holdForSmartDictation)
    setAdvancedMode(s.advancedMode)
    setWebAccess(s.webAccess)
    setCodeOwnCopy(s.codeOwnCopy)
    setTranscriptFormats(s.transcriptFormats)
  }, [])

  const apply = useCallback(
    (s: SettingsState) => {
      setState(s)
      seedForm(s)
    },
    [seedForm]
  )

  // Live status poll: refresh permission/status state only, never the editable
  // form fields (those are owned by the user until Save).
  const refresh = useCallback(async () => {
    const s = await window.api.settingsGet()
    setState(s)
  }, [])

  useEffect(() => {
    refresh()
    window.api.settingsGetPrefs().then((p) => {
      setBackend(p.backend)
      setOllamaModel(p.ollamaModel)
      setMlxModel(p.mlxModel)
      setThinkingEnabled(p.thinkingEnabled)
      setCursorCompanion(p.cursorCompanion)
      setCursorStyle(toCursorStyle(p.cursorStyle))
      setMaxRecMin(p.maxRecordingMin)
      setSoundEnabled(p.soundEnabled)
      setCaptureHud(p.captureHud)
      setDynamicIsland(p.dynamicIsland)
      setSelectionBar(p.selectionBar)
      setLiveCompanion(p.liveCompanion)
      setLiveActs(p.liveActs)
      setDockIcon(p.dockIcon)
      setSuggestions(p.suggestions)
      setClickEnabled(p.clickEnabled)
      setFnListenEnabled(p.fnListenEnabled)
      setActHighlight(p.actHighlight)
      setFeedbackEnabled(p.feedbackEnabled)
      setListenAutoPaste(p.listenAutoPaste)
      setContextLog(p.contextLog)
      setAgentPhotos(p.agentPhotos)
      setDecisionCards(p.decisionCards)
      setRunTranscript(p.runTranscript)
      setShowTiming(p.showTiming)
      setHistoryEncryption(p.historyEncryption)
      setIncognito(p.incognito)
      setPhoneRemoteEnabled(p.phoneRemoteEnabled)
      setPhoneRemoteSupported(p.phoneRemoteSupported)
      setPhoneRemoteStayAwake(p.phoneRemoteStayAwake)
      setPhoneRemoteClamshell(p.phoneRemoteClamshell)
      setPhoneRemoteAwayMode(p.phoneRemoteAwayMode)
      setPhoneRemoteAwayHeld(p.phoneRemoteAwayHeld)
      // Toggle restored ON from a prior session (or Settings simply reopened)
      // never had its QR set in THIS window's state -- fetch it now instead of
      // leaving the "Ready to pair" badge with nothing to scan.
      if (p.phoneRemoteEnabled) void fetchPhoneRemoteQr()
    })
    // Deliberately NOT p.advancedMenu — that one already answers "no" while the
    // preview is on, which would hide the switch that turns the preview off.
    window.api.admin.getViewAsUser().then(({ realAdmin, viewAsUser: on }) => {
      setIsAdmin(realAdmin)
      setViewAsUser(on)
    })
    window.api.agentRelayGetStatus().then(setAgentRelay)
    window.api.agentRelayGetPushFilter().then(setRelayPush)
    window.api.agentRelayListClients().then(setMcpClients)
    // Sessions open and close while Settings sits there, so the count has to be
    // pushed — nothing else here would prompt a re-read.
    const offRelayStatus = window.api.onAgentRelayStatusChanged(setAgentRelay)
    // The phone's alerts sheet writes the same prefs, so these switches move
    // while Settings sits open -- nothing else here would prompt a re-read.
    const offRelayFilter = window.api.onAgentRelayPushFilterChanged(setRelayPush)
    window.api.phoneRemoteGetTunnel().then((t) => {
      setTunnelEnabled(t.enabled)
      setTunnelStatus(t.status)
      setTunnelQr(t.qrDataUrl)
    })
    window.api.getGlobalInstructions().then(setGlobalInstructions)
    window.api.settingsInstallHint('ffmpeg').then(setFfmpegInstallHint)
    const t = setInterval(refresh, 4000) // live status while user fixes perms in System Settings
    const off = window.api.onModelDownloadProgress(({ pct }) => setDlPct(pct))
    // Live brew output during an ffmpeg/whisper install (multi-minute job).
    const offInstall = window.api.onBinaryInstallProgress(({ line }) => setInstallLine(line))

    // Load initial balance and subscribe to push updates from the webhook grant path
    window.api.billingGetBalance().then((cents) => setBalanceCents(cents ?? null))
    window.api.billingGetUsage().then(setUsage)
    const offBalance = window.api.onBillingBalanceChanged((cents) => {
      setBalanceCents(cents)
      window.api.billingGetUsage().then(setUsage)
    })

    // Load the current subscription (if any) so the Monthly tab can show
    // "Subscribed" instead of the plan buttons.
    window.api.billingGetSubscription().then(setSubscription)

    // Is Lifetime buyable? The server folds enabled + cap + already-owned into
    // one boolean (billing_config isn't client-readable), so this is a pull, not
    // a computation. Re-pulled after a checkout return so the card swaps to the
    // "you're all set" line without a restart.
    window.api.billingGetLifetimeOffer().then(setLifetime)

    // The mightymouse:// checkout deep link returned (browser handed back to the
    // app). Show the result and stop the top-up poll — the balance push above
    // already refreshes the number on success. A plan checkout also needs a
    // subscription re-pull, since that comes from a separate table, not the push.
    const offReturn = window.api.onBillingCheckoutReturn((status) => {
      if (topupPollRef.current) {
        clearInterval(topupPollRef.current)
        topupPollRef.current = null
      }
      setTopupMsg(
        status === 'success'
          ? { kind: 'ok', text: 'Added, thanks!' }
          : { kind: 'err', text: 'Checkout canceled. No charge made.' }
      )
      if (status === 'success') {
        window.api.billingGetSubscription().then(setSubscription)
        window.api.billingGetLifetimeOffer().then(setLifetime)
      }
    })

    // Signed-in account: load + subscribe to auth changes
    void window.api.auth.getSession().then(setAccount)
    const offAuth = window.api.auth.onChange(setAccount)

    // Keep the card in sync when Incognito is flipped from the tray while
    // Settings is open (the prefs read on mount would otherwise go stale).
    const offIncognito = window.api.onIncognitoChanged(setIncognito)

    // Same deal for "View as user" — it's flippable from the tray, so an open
    // Settings window has to follow along or the two disagree about what's hidden.
    const offViewAsUser = window.api.onViewAsUserChanged(setViewAsUser)

    // Live connect/disconnect push from the phone-remote server (see
    // registerPhoneRemoteHandlers in main/ipc/phone-remote.ts) so the status
    // line updates the instant a phone joins/leaves, no polling needed.
    const offPhoneRemote = window.api.onPhoneRemoteStatus((s) =>
      setPhoneRemoteConnected(s.connected)
    )

    // A pairing code is single-use: /pair clears it, so the QR fetched on mount
    // encodes a dead code and every later scan 401s. Main re-encodes against the
    // live code and pushes it here. Null means nothing scannable -- keep the old.
    const offPhoneDevices = window.api.onPhoneRemoteDevicesChanged((p) => {
      if (p.qrDataUrl) setPhoneRemoteQr(p.qrDataUrl)
      if (p.tunnelQrDataUrl) setTunnelQr(p.tunnelQrDataUrl)
    })

    // Live tunnel lifecycle stream (download pct → provisioning → up/error) so
    // the off-Wi-Fi row shows real progress while cloudflared sets up. The URL/
    // QR are re-pulled once it lands on 'up' — main owns QR generation.
    const offTunnel = window.api.onPhoneRemoteTunnelStatus((s) => {
      setTunnelStatus(s)
      if (s.state === 'up') {
        window.api.phoneRemoteGetTunnel().then((t) => {
          setTunnelQr(t.qrDataUrl)
        })
      } else {
        setTunnelQr(null)
      }
    })

    // Away Mode can start or end from anywhere — a phone connecting, the user
    // touching this Mac, the tray. Without this the button keeps offering to
    // black out a screen that is already black.
    const offCoverState = window.api.onPhoneRemoteAwayState(setPhoneRemoteAwayHeld)

    void window.api.settingsTakeFocusSection().then((s) => s && focusSection(s))
    const offFocusSection = window.api.onSettingsFocusSection(
      () => void window.api.settingsTakeFocusSection().then((s) => s && focusSection(s))
    )

    return () => {
      clearInterval(t)
      off()
      offInstall()
      offBalance()
      offReturn()
      offAuth()
      offIncognito()
      offViewAsUser()
      offPhoneRemote()
      offPhoneDevices()
      offTunnel()
      offRelayStatus()
      offRelayFilter()
      offCoverState()
      offFocusSection()
      if (topupPollRef.current) clearInterval(topupPollRef.current)
    }
  }, [refresh])

  // Centre the selected backend card in its horizontal strip. Without this a
  // backend late in the list (Rapid-MLX) sits off-screen right, so the strip
  // shows three cards none of which is the one in use. scrollLeft, not
  // scrollIntoView: the latter would also scroll the whole Settings page.
  const centreBackendCard = useCallback((smooth: boolean) => {
    const row = backendRowRef.current
    const card = row?.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (!row || !card) return
    row.scrollTo({
      left: card.offsetLeft - (row.clientWidth - card.offsetWidth) / 2,
      behavior: smooth ? 'smooth' : 'auto'
    })
  }, [])

  // Collapsing the section unmounts the row entirely, so an effect alone would
  // no-op on a collapsed AI Model and never re-run on expand. The callback ref
  // fires on every mount, which covers both.
  const attachBackendRow = useCallback(
    (el: HTMLDivElement | null) => {
      backendRowRef.current = el
      if (el) requestAnimationFrame(() => centreBackendCard(false))
    },
    [centreBackendCard]
  )
  useEffect(() => {
    centreBackendCard(true)
  }, [backend, advancedMenu, centreBackendCard])

  // ⌘F opens the search and focuses it; Esc clears + collapses it back to the
  // title-bar icon. Window-scoped so it works no matter where focus is.
  const openSearch = useCallback(() => {
    setSearchOpen(true)
    // Focus after the input has mounted/animated in.
    requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [])
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openSearch()
      } else if (e.key === 'Escape' && searchOpen) {
        closeSearch()
      } else if (e.key === 'Escape') {
        onBack?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSearch, closeSearch, searchOpen, onBack])

  // Opens the Stripe checkout for a pack OR a plan and polls balance every 5s
  // for up to 60s so the UI reflects the webhook grant without the user having
  // to refresh. Surfaces failures inline — a silent {ok:false} used to look
  // like a dead button. Shared by both Credits tabs; `kind` picks Checkout's
  // 'payment' vs 'subscription' mode server-side.
  // Packs only. Subscriptions and Lifetime run through the upgrade window, which
  // owns their refusal copy (sold out / already owned) and the result state.
  const openCheckout = async (id: string): Promise<void> => {
    setTopupMsg(null)
    setTopupPending(id)
    let res: { ok: boolean; error?: string }
    try {
      res = await window.api.billingOpenCheckout({ kind: 'pack', id, reason: 'settings' })
    } catch {
      res = { ok: false }
    }
    setTopupPending(null)

    if (!res.ok) {
      setTopupMsg({
        kind: 'err',
        text: account
          ? 'Could not start checkout. Check your connection and try again.'
          : 'Sign in first to buy credits.'
      })
      return
    }

    setTopupMsg({ kind: 'ok', text: 'Checkout opened in your browser. Finish there.' })
    if (topupPollRef.current) clearInterval(topupPollRef.current)
    let elapsed = 0
    topupPollRef.current = setInterval(async () => {
      elapsed += 5
      const cents = await window.api.billingGetBalance()
      if (cents !== null) setBalanceCents(cents)
      if (elapsed >= 60 && topupPollRef.current) {
        clearInterval(topupPollRef.current)
        topupPollRef.current = null
      }
    }, 5000)
  }

  // Opens the Stripe Customer Portal so a subscriber can manage or cancel.
  const openPortal = async (): Promise<void> => {
    setTopupMsg(null)
    setTopupPending('portal')
    let res: { ok: boolean }
    try {
      res = await window.api.billingOpenPortal()
    } catch {
      res = { ok: false }
    }
    setTopupPending(null)
    if (!res.ok) {
      setTopupMsg({ kind: 'err', text: 'Could not open billing. Try again in a moment.' })
    }
  }

  const chooseBackend = async (b: BackendId): Promise<void> => {
    setBackend(b) // optimistic
    setTestResult(null) // stale result from the previous backend no longer applies
    const confirmed = await window.api.settingsSetBackend(b)
    setBackend(confirmed)
  }

  const chooseOllamaModel = async (model: string): Promise<void> => {
    setOllamaModel(model) // optimistic
    const confirmed = await window.api.settingsSetOllamaModel(model)
    setOllamaModel(confirmed)
  }

  const chooseMlxModel = async (model: string): Promise<void> => {
    setMlxModel(model) // optimistic
    const confirmed = await window.api.settingsSetMlxModel(model)
    setMlxModel(confirmed)
  }

  // Ollama / Rapid-MLX both manage their own model storage — there's nothing to
  // browse or type a path for, only a list of what's already available. Fetch the
  // right list whenever a local backend is selected so the dropdown always reflects
  // the current machine. Both write the shared localModels slot (only one active).
  useEffect(() => {
    if (backend !== 'local' && backend !== 'mlx') return
    let cancelled = false
    setLocalModelsLoading(true)
    setSetupError(null)
    const list =
      backend === 'mlx' ? window.api.settingsListMlxModels() : window.api.settingsListLocalModels()
    list.then((models) => {
      if (cancelled) return
      setLocalModels(models)
      setLocalModelsLoading(false)
    })
    // What the button should offer is a separate question from what's in the
    // dropdown: a stopped service lists nothing but is one click from running.
    window.api.settingsLocalSetupState(backend).then((state) => {
      if (!cancelled) setSetupState(state)
    })
    return () => {
      cancelled = true
    }
    // Re-derive on the busy EDGE, not on every tick — `setupBusy` now updates
    // twice a second, and depending on the object would refetch just as often.
  }, [backend, setupRunning])

  useEffect(() => {
    return window.api.onLocalSetupProgress((payload) => setSetupBusy(payload))
  }, [])

  /**
   * Install and/or start the local service, then re-read the model list.
   *
   * Both steps live behind ONE button on purpose — "install" and "start" are our
   * problem, not a choice we should make the user understand.
   */
  const runLocalSetup = async (): Promise<void> => {
    if (backend !== 'local' && backend !== 'mlx') return
    setSetupError(null)
    // Seed a 0% tick so the bar appears on click, not on main's first timer fire.
    setSetupRunning(true)
    setSetupBusy({
      backend,
      phase: 'starting',
      message: SETUP_COPY.starting,
      percent: 0,
      elapsedMs: 0
    })
    const res = await window.api.settingsSetUpLocalBackend(backend)
    setSetupBusy(null)
    setSetupRunning(false)
    if (!res.ok) {
      setSetupError(SETUP_FAIL_COPY[res.reason ?? 'install-failed'] ?? SETUP_COPY.installFailed)
      return
    }
    if (res.startedModel) setMlxModel(res.startedModel)
  }

  const testBackend = async (): Promise<void> => {
    const target = backend
    setTesting(true)
    setTestResult(null)
    // Guard against a missing/stale IPC handler hanging the button forever.
    const timeout = new Promise<BackendTestResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: false,
            checks: [{ label: 'IPC', ok: false, detail: 'No response from app' }],
            advice: 'The app may be running a stale build. Restart it (npm run dev).'
          }),
        12000
      )
    )
    const r = await Promise.race([window.api.settingsTestBackend(target), timeout])
    setTestResult({ ...r, backend: target })
    setTesting(false)
  }

  // Manual "Check for updates". `checking` clears when the next status event lands
  // (or after a short floor so the spinner doesn't flash). In dev the check no-ops.
  const checkForUpdates = async (): Promise<void> => {
    setChecking(true)
    await window.api.update.check()
    setTimeout(() => setChecking(false), 1500)
  }

  const toggleCursorCompanion = async (next: boolean): Promise<void> => {
    setCursorCompanion(next) // optimistic
    const confirmed = await window.api.settingsSetCursor(next)
    setCursorCompanion(confirmed)
  }

  const chooseCursorStyle = async (next: string): Promise<void> => {
    const id = toCursorStyle(next)
    setCursorStyle(id) // optimistic; main pushes the live overlay swap
    const confirmed = await window.api.settingsSetCursorStyle(id)
    setCursorStyle(toCursorStyle(confirmed))
  }

  const commitMaxRec = async (next: number): Promise<void> => {
    const confirmed = await window.api.settingsSetMaxRec(next)
    setMaxRecMin(confirmed)
  }

  const toggleThinking = async (next: boolean): Promise<void> => {
    setThinkingEnabled(next) // optimistic
    const confirmed = await window.api.settingsSetThinkingEnabled(next)
    setThinkingEnabled(confirmed)
  }

  const toggleSound = async (next: boolean): Promise<void> => {
    setSoundEnabled(next) // optimistic
    const confirmed = await window.api.settingsSetSound(next)
    setSoundEnabled(confirmed)
  }

  const toggleCaptureHud = async (next: boolean): Promise<void> => {
    setCaptureHud(next) // optimistic
    const confirmed = await window.api.settingsSetCaptureHud(next)
    setCaptureHud(confirmed)
  }

  const toggleSuggestions = async (next: boolean): Promise<void> => {
    setSuggestions(next) // optimistic
    const confirmed = await window.api.settingsSetSuggestions(next)
    setSuggestions(confirmed)
  }

  const toggleDynamicIsland = async (next: boolean): Promise<void> => {
    setDynamicIsland(next) // optimistic
    const confirmed = await window.api.settingsSetDynamicIsland(next)
    setDynamicIsland(confirmed)
  }

  const toggleSelectionBar = async (next: boolean): Promise<void> => {
    setSelectionBar(next) // optimistic
    const confirmed = await window.api.settingsSetSelectionBar(next)
    setSelectionBar(confirmed)
  }

  const toggleLiveCompanion = async (next: boolean): Promise<void> => {
    setLiveCompanion(next) // optimistic
    const confirmed = await window.api.settingsSetCompanion(next)
    setLiveCompanion(confirmed)
  }

  const toggleLiveActs = async (next: boolean): Promise<void> => {
    setLiveActs(next) // optimistic
    const confirmed = await window.api.settingsSetLiveActs(next)
    setLiveActs(confirmed)
  }

  const toggleDockIcon = async (next: boolean): Promise<void> => {
    setDockIcon(next) // optimistic
    const confirmed = await window.api.settingsSetDockIcon(next)
    setDockIcon(confirmed)
  }

  const toggleFnListen = async (next: boolean): Promise<void> => {
    setFnListenEnabled(next) // optimistic
    // Main fires the Accessibility prompt on enable (the fn tap needs the same
    // grant uiohook does), so refresh the permission panel right after.
    const confirmed = await window.api.settingsSetFnListen(next)
    setFnListenEnabled(confirmed)
    if (next) refresh()
  }

  const toggleClickEnabled = async (next: boolean): Promise<void> => {
    setClickEnabled(next) // optimistic
    // Main fires the Accessibility prompt on enable; refresh the permission
    // panel right after so the granted/denied hint below updates without waiting
    // for the next 4s poll.
    const confirmed = await window.api.settingsSetClick(next)
    setClickEnabled(confirmed)
    if (next) refresh()
  }

  const toggleActHighlight = async (next: boolean): Promise<void> => {
    setActHighlight(next) // optimistic
    const confirmed = await window.api.settingsSetActHighlight(next)
    setActHighlight(confirmed)
  }

  // Fire the OS Accessibility prompt from the Click card's Grant button, then
  // refresh so the chip flips green the moment it's granted (no 4s poll wait).
  const grantAccessibility = async (): Promise<void> => {
    await window.api.settingsRequestPermission('accessibility')
    refresh()
  }

  useEffect(() => {
    void window.api.voiceRoutingConfigGet().then((cfg) => {
      setVoiceRoutingMode(cfg.mode)
      setVoiceRoutingGoTo(cfg.offerGoTo)
      setVoiceRoutingSkills(cfg.showSkills)
      setVoiceRoutingAgents(cfg.showAgents)
    })
  }, [])

  const pickVoiceRoutingMode = async (next: VoiceRoutingMode): Promise<void> => {
    setVoiceRoutingMode(next)
    await window.api.voiceRoutingConfigSet({ mode: next })
  }

  const toggleVoiceRoutingGoTo = async (next: boolean): Promise<void> => {
    setVoiceRoutingGoTo(next)
    await window.api.voiceRoutingConfigSet({ offerGoTo: next })
  }

  const toggleVoiceRoutingSkills = async (next: boolean): Promise<void> => {
    setVoiceRoutingSkills(next)
    await window.api.voiceRoutingConfigSet({ showSkills: next })
  }

  const toggleVoiceRoutingAgents = async (next: boolean): Promise<void> => {
    setVoiceRoutingAgents(next)
    await window.api.voiceRoutingConfigSet({ showAgents: next })
  }

  // Keep-awake: pure pref write, no failure path to surface -- main applies the
  // power blocker live if the server is already running, or defers it to the
  // next start. Optimistic with no rollback because the handler can't fail.
  const toggleStayAwake = async (next: boolean): Promise<void> => {
    setPhoneRemoteStayAwake(next)
    await window.api.phoneRemoteSetStayAwake(next)
  }

  // The extended screen deliberately survives the phone disconnecting, so this
  // is the only way to get rid of one from the Mac. Optimistic: destroying the
  // helper process can't fail, and the poller re-asserts the truth either way.
  const clearExtendedScreen = async (): Promise<void> => {
    setExtendedScreenOn(false)
    await window.api.phoneRemoteClearExtendedScreen()
  }

  // Polled only while Phone Remote is enabled -- with the remote off there is
  // no path that creates a display, so a timer would just be a wakeup for nothing.
  useInterval(
    () => {
      void window.api
        .phoneRemoteGetExtendedScreen()
        .then((r) => setExtendedScreenOn(r.active))
        .catch(() => setExtendedScreenOn(false))
    },
    phoneRemoteEnabled ? CONFIG.PHONE_REMOTE.EXTEND_STATUS_POLL_MS : null
  )

  // Clamshell: NOT optimistic, unlike every other toggle here -- flipping it on
  // fires a macOS admin prompt the user can dismiss. Showing the switch as ON
  // before the password lands would claim the lid is covered when it isn't, so
  // the switch only moves once main confirms the flag is actually set.
  const toggleClamshell = async (next: boolean): Promise<void> => {
    setClamshellError(null)
    const res = await window.api.phoneRemoteSetClamshell(next)
    if (res.ok) {
      setPhoneRemoteClamshell(next)
      return
    }
    // Cancelled = a deliberate "no", not an error worth shouting about; the
    // switch simply stays where it was.
    setPhoneRemoteClamshell(false)
    if (!res.cancelled) setClamshellError(res.error ?? "Couldn't change the sleep setting.")
  }

  // Same non-optimistic rule as clamshell, for the same reason plus a worse one:
  // showing this ON when it isn't would tell the user their screen is private
  // while the desktop is sitting there in the open.
  const toggleAwayMode = async (next: boolean): Promise<void> => {
    setAwayModeError(null)
    const res = await window.api.phoneRemoteSetAwayMode(next)
    if (res.ok) {
      setPhoneRemoteAwayMode(next)
      return
    }
    setPhoneRemoteAwayMode(false)
    if (res.cancelled) return
    setAwayModeError(
      res.reason === 'no-input-watch'
        ? 'Needs Accessibility access to notice when you come back to this Mac. Grant it in System Settings > Privacy & Security > Accessibility, then try again.'
        : (res.error ?? "Couldn't turn this on.")
    )
  }

  // Non-optimistic like the two above and for the same reason: this switch is
  // the entire privacy boundary for a screenshot taken with nobody watching, so
  // it shows OFF until the Mac has confirmed it wrote OFF.
  const toggleSiriScreenAnswer = async (next: boolean): Promise<void> => {
    const s = await window.api.settingsSave({ siriScreenAnswer: next })
    setSiriScreenAnswer(s.siriScreenAnswer)
  }

  const toggleTranscriptFormat = async (id: string, next: boolean): Promise<void> => {
    const s = await window.api.settingsSave({ [`${TRANSCRIPT_FORMAT_KEY}${id}`]: next })
    setTranscriptFormats(s.transcriptFormats)
  }

  const toggleAdvancedMode = async (next: boolean): Promise<void> => {
    const s = await window.api.settingsSave({ advancedMode: next })
    setAdvancedMode(s.advancedMode)
    chat.onAdvancedModeChange(s.advancedMode)
  }

  const toggleSmallPanel = async (next: boolean): Promise<void> => {
    const s = await window.api.settingsSave({ smallPanel: next })
    setSmallPanel(s.smallPanel)
  }

  const toggleHoldForSmart = async (next: boolean): Promise<void> => {
    const s = await window.api.settingsSave({ holdForSmartDictation: next })
    setHoldForSmart(s.holdForSmartDictation)
  }

  const toggleCodeOwnCopy = async (next: boolean): Promise<void> => {
    const s = await window.api.settingsSave({ codeOwnCopy: next })
    setCodeOwnCopy(s.codeOwnCopy)
  }

  const toggleWebAccess = async (next: boolean): Promise<void> => {
    const s = await window.api.settingsSave({ webAccess: next })
    setWebAccess(s.webAccess)
  }

  // Cover the screen right now, rather than waiting for a phone to connect. Same
  // non-optimistic rule as the toggle above: `active` comes back from main, so
  // the button never claims the screen is covered when it isn't.
  const toggleCoverNow = async (): Promise<void> => {
    setAwayModeError(null)
    setCoverBusy(true)
    const res = await window.api.phoneRemoteToggleCoverNow()
    setCoverBusy(false)
    setPhoneRemoteAwayHeld(res.active)
    if (res.ok || res.cancelled) return
    setAwayModeError(
      res.reason === 'no-input-watch'
        ? 'Needs Accessibility access to notice when you come back to this Mac. Grant it in System Settings > Privacy & Security > Accessibility, then try again.'
        : (res.error ?? "Couldn't cover the screen.")
    )
  }

  // Turning keep-awake OFF must also drop clamshell -- it's the parent toggle,
  // and leaving a machine-wide sleep flag set under a hidden row is exactly the
  // "stuck awake with no visible cause" failure this feature has to avoid.
  const toggleStayAwakeWithClamshell = async (next: boolean): Promise<void> => {
    await toggleStayAwake(next)
    if (!next && phoneRemoteClamshell) await toggleClamshell(false)
  }

  // Phone Remote: turning on starts the local HTTP+WS server and returns a QR
  // (or a failure reason if there's no Wi-Fi / the port's stuck busy after
  // retrying). Turning off kills the server immediately -- no confirm needed,
  // matches the ship gate's "toggle off immediately kills server" requirement.
  const togglePhoneRemote = async (next: boolean): Promise<void> => {
    setPhoneRemoteEnabled(next) // optimistic
    setPhoneRemoteError(null)
    if (!next) {
      setPhoneRemoteQr(null)
      setPhoneRemoteConnected(false)
      await window.api.phoneRemoteSetEnabled(false)
      return
    }
    const result = await window.api.phoneRemoteSetEnabled(true)
    if (!result.ok) {
      setPhoneRemoteEnabled(false)
      setPhoneRemoteQr(null)
      setPhoneRemoteError(
        result.reason === 'no-lan'
          ? 'No network to pair on - connect to Wi-Fi, or turn on off-Wi-Fi access'
          : "Couldn't start - try again"
      )
      return
    }
    setPhoneRemoteQr(result.qrDataUrl ?? null)
  }

  const toggleAgentRelay = async (next: boolean): Promise<void> => {
    setAgentRelay((prev) => ({ ...prev, enabled: next })) // optimistic
    setAgentRelayTestState('idle')
    setAgentRelay(await window.api.agentRelaySetEnabled(next))
  }

  const toggleRelayPush = async (verb: RelayVerbWire, next: boolean): Promise<void> => {
    setRelayPush((prev) => ({ ...prev, filter: { ...prev.filter, [verb]: next } })) // optimistic
    setRelayPush(await window.api.agentRelaySetPushFilter(verb, next))
  }

  const setRelayNotifyLevel = async (next: RelayNotifyPushLevel): Promise<void> => {
    setRelayPush((prev) => ({ ...prev, notifyLevel: next })) // optimistic
    setRelayPush(await window.api.agentRelaySetNotifyLevel(next))
  }

  const setRelayTurnEndPing = async (next: boolean): Promise<void> => {
    setRelayPush((prev) => ({ ...prev, turnEndPing: next })) // optimistic
    setRelayPush(await window.api.agentRelaySetTurnEndPing(next))
  }

  const sendAgentRelayTest = async (): Promise<void> => {
    setAgentRelayTestState('sending')
    const result = await window.api.agentRelaySendTest()
    setAgentRelayTestState(result.ok ? 'sent' : { error: result.detail })
    setAgentRelay(await window.api.agentRelayGetStatus())
  }

  const setUpMcpClient = async (id: McpClientId): Promise<void> => {
    setMcpClientError(null)
    const result = await window.api.agentRelayConfigureClient(id)
    if (!result.ok) setMcpClientError(result.detail)
    setMcpClients(await window.api.agentRelayListClients())
  }

  // Re-fetch the QR for an ALREADY-running server -- used on mount (toggle
  // restored ON from a prior session never showed a QR otherwise, see
  // ipc/phone-remote.ts's phoneRemoteGetQr handler) and by the manual "Pair"
  // button, so re-flipping the switch off/on isn't the only way to see it again.
  const fetchPhoneRemoteQr = async (): Promise<void> => {
    setPhoneRemoteError(null)
    const result = await window.api.phoneRemoteGetQr()
    if (!result.ok) {
      setPhoneRemoteQr(null)
      setPhoneRemoteError(
        result.reason === 'no-lan'
          ? 'No network to pair on - connect to Wi-Fi, or turn on off-Wi-Fi access'
          : "Couldn't reach the server - try again"
      )
      return
    }
    setPhoneRemoteQr(result.qrDataUrl ?? null)
  }

  // Badge + QR both come out of ONE derivation (shared/phone-remote-pairing.ts).
  // They used to read unrelated state, which is how the badge could promise a
  // QR that no branch would ever render. Never re-derive either inline.
  const pairing = derivePairing({
    enabled: phoneRemoteEnabled,
    connected: phoneRemoteConnected,
    lanQr: phoneRemoteQr,
    tunnelEnabled,
    tunnelStatus,
    tunnelQr
  })

  // Off-Wi-Fi access: one tap, zero installs/logins. Main provisions the
  // tunnel server-side on first enable and streams progress back over
  // onPhoneRemoteTunnelStatus, so the row narrates itself while this awaits.
  const toggleTunnel = async (next: boolean): Promise<void> => {
    setTunnelEnabled(next) // optimistic
    if (!next) {
      setTunnelQr(null)
    }
    const result = await window.api.phoneRemoteSetTunnelEnabled(next)
    if (!result.ok) {
      setTunnelEnabled(!next)
      return
    }
    if (next) {
      setTunnelQr(result.qrDataUrl ?? null)
    }
  }

  // Retry after a failed/stalled tunnel: full off→on, so main tears the old
  // attempt down (and reaps any orphaned cloudflared) before spawning again.
  // A bare re-enable would hit startTunnel()'s idempotent early-return.
  const retryTunnel = async (): Promise<void> => {
    await window.api.phoneRemoteSetTunnelEnabled(false)
    await toggleTunnel(true)
  }

  const toggleFeedback = async (next: boolean): Promise<void> => {
    setFeedbackEnabled(next) // optimistic
    const confirmed = await window.api.settingsSetFeedback(next)
    setFeedbackEnabled(confirmed)
  }

  const toggleListenAutoPaste = async (next: boolean): Promise<void> => {
    setListenAutoPaste(next) // optimistic
    const confirmed = await window.api.settingsSetListenAutoPaste(next)
    setListenAutoPaste(confirmed)
  }

  const toggleShowTiming = async (next: boolean): Promise<void> => {
    setShowTiming(next) // optimistic
    const confirmed = await window.api.settingsSetShowTiming(next)
    setShowTiming(confirmed)
  }

  const toggleAgentPhotos = async (next: boolean): Promise<void> => {
    setAgentPhotos(next) // optimistic
    const confirmed = await window.api.settingsSetAgentPhotos(next)
    setAgentPhotos(confirmed)
  }

  const toggleDecisionCards = async (next: boolean): Promise<void> => {
    setDecisionCards(next)
    setDecisionCards(await window.api.settingsSetDecisionCards(next))
  }

  const toggleContextLog = async (next: boolean): Promise<void> => {
    setContextLog(next) // optimistic
    const confirmed = await window.api.settingsSetContextLog(next)
    setContextLog(confirmed)
  }

  const toggleIncognito = async (next: boolean): Promise<void> => {
    setIncognito(next) // optimistic
    const confirmed = await window.api.settingsSetIncognito(next)
    setIncognito(confirmed)
  }

  // Write-through save for the Instructions section — text + per-mode toggles
  // are one object, so every change (text edit or a Switch flip) saves the
  // whole thing. No debounce on toggles; the text field debounces below.
  const saveGlobalInstructions = (next: GlobalInstructionsSettings): void => {
    setGlobalInstructions(next) // optimistic
    void window.api.setGlobalInstructions(next)
  }
  const toggleInstructionsAppliesTo =
    (mode: keyof GlobalInstructionsSettings['appliesTo']) =>
    (next: boolean): void => {
      saveGlobalInstructions({
        ...globalInstructions,
        appliesTo: { ...globalInstructions.appliesTo, [mode]: next }
      })
    }
  // Flips one mode from the multi-select dropdown's checklist item.
  const onToggleInstructionsMode = (mode: string): void => {
    const key = mode as keyof GlobalInstructionsSettings['appliesTo']
    toggleInstructionsAppliesTo(key)(!globalInstructions.appliesTo[key])
  }
  // Text edits debounce to avoid a write-through IPC call per keystroke. Reads
  // fresh state via the ref (not the closed-over `globalInstructions`) so a
  // toggle flip during the debounce window isn't clobbered by a stale write.
  const instructionsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const globalInstructionsRef = useRef(globalInstructions)
  globalInstructionsRef.current = globalInstructions
  const onInstructionsTextChange = (text: string): void => {
    setGlobalInstructions((prev) => ({ ...prev, text })) // optimistic, local only
    if (instructionsSaveTimer.current) clearTimeout(instructionsSaveTimer.current)
    instructionsSaveTimer.current = setTimeout(() => {
      void window.api.setGlobalInstructions({ ...globalInstructionsRef.current, text })
    }, 500)
  }

  const toggleRunTranscript = async (next: boolean): Promise<void> => {
    setRunTranscript(next) // optimistic
    const confirmed = await window.api.settingsSetRunTranscript(next)
    setRunTranscript(confirmed)
  }

  const toggleHistoryEncryption = async (next: boolean): Promise<void> => {
    setHistoryEncryption(next) // optimistic
    // Main backs up + converts the file, then returns the effective state (stays
    // off if safeStorage is unavailable on this machine).
    const confirmed = await window.api.settingsSetHistoryEncryption(next)
    setHistoryEncryption(confirmed)
    setMsg(confirmed === next ? null : 'Encryption is unavailable on this machine.')
  }

  const clearHistory = async (): Promise<void> => {
    if (
      !window.confirm(
        'Delete all your history? A backup is saved first, but this clears the live record.'
      )
    )
      return
    const backup = await window.api.settingsClearHistory()
    setMsg(backup ? 'History cleared. Backup saved.' : 'History cleared.')
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    const s = await window.api.settingsSave({
      ffmpeg,
      whisper,
      whisperModel,
      whisperLang,
      videoDevice,
      audioDevice
    })
    apply(s)
    setBusy(null)
    setMsg('Saved')
    setTimeout(() => setMsg(null), 1500)
  }

  // The language persists the moment it's picked. Every other field on this
  // page has an explicit Save, but a dropdown that silently reverts on close is
  // the top complaint shape for exactly this kind of control.
  const saveLanguage = async (code: string): Promise<void> => {
    setWhisperLang(code)
    apply(await window.api.settingsSave({ whisperLang: code }))
  }

  const downloadModel = async (): Promise<void> => {
    setBusy('model')
    setDlPct(0)
    const { result, state: s } = await window.api.settingsDownloadModel()
    apply(s)
    setBusy(null)
    setDlPct(null)
    setMsg(result.ok ? 'Model downloaded' : `Download failed: ${result.error}`)
    setTimeout(() => setMsg(null), 3000)
  }

  const installWhisper = async (): Promise<void> => {
    setBusy('whisper')
    const { result, state: s } = await window.api.settingsInstallWhisper()
    apply(s)
    setBusy(null)
    setInstallLine(null)
    setMsg(result.ok ? 'whisper-cpp installed' : 'Install failed (see console)')
    if (!result.ok) console.error(result.output)
    setTimeout(() => setMsg(null), 3000)
  }

  // One-click ffmpeg. Recording is dead without it, so this is the fix behind
  // the "Recording needs a free helper tool" error the HUD shows.
  const installFfmpeg = async (): Promise<void> => {
    setBusy('ffmpeg')
    const { result, state: s } = await window.api.settingsInstallFfmpeg()
    apply(s)
    setBusy(null)
    setInstallLine(null)
    setMsg(result.ok ? CONFIG.CAPTURE_ERROR.installed : CONFIG.CAPTURE_ERROR.installFailed)
    if (!result.ok) console.error(result.output)
    setTimeout(() => setMsg(null), 5000)
  }

  if (!state) {
    return (
      <LoadingBody label="Loading settings…" />
    )
  }

  const ffmpegBin = state.binaries.find((b) => b.key === 'ffmpeg')
  const whisperBin = state.binaries.find((b) => b.key === 'whisper')
  const modelBin = state.binaries.find((b) => b.key === 'whisperModel')
  const parakeetBin = state.binaries.find((b) => b.key === 'parakeet')

  // Whether the current query matches any visible section — drives the
  // "no settings match" hint. Admin sections can't be search results when
  // they're not rendered, so the page never surfaces a knob you can't reach.
  const searchableKeys = (Object.keys(SECTIONS) as SectionKey[]).filter(
    (k) =>
      (advancedMenu || !ADMIN_ONLY_SECTIONS.includes(k)) &&
      (!simple || SIMPLE_SECTIONS.includes(k)) &&
      (k !== 'selectionBar' || CONFIG.SELECTION_BAR.ENABLED)
  )
  const anyResults = anySectionVisible(query, searchableKeys)

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      {sidebarShown && (
        <SettingsSidebar
          query={query}
          page={paged ? shownPage : null}
          onPage={openPage}
          advancedMenu={advancedMenu}
          phoneRemoteSupported={phoneRemoteSupported}
          simple={simple}
          onJump={jumpToSection}
          onBack={onBack}
        />
      )}
      {/* Left padding clears the fixed nav (its width + the usual 24px gutter)
          and drops back to a plain gutter when it's hidden. The nav is fixed
          rather than a flex sibling so this stays ONE div: the file isn't
          prettier-clean at HEAD, so a nesting level here reindents ~1.9k
          unrelated lines. */}
      <div
        className="px-6 pb-6 pt-5"
        style={{
          maxWidth: CONTENT_WIDTH_PX,
          marginLeft: sidebarShown
            ? `max(${SIDEBAR_WIDTH_PX}px, calc((100% + ${SIDEBAR_WIDTH_PX - CONTENT_WIDTH_PX}px) / 2))`
            : 'auto',
          marginRight: 'auto'
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1
              className="text-display font-bold mb-1.5 select-none"
              onDoubleClick={() => setShowDebug((v) => !v)}
              title={showDebug ? undefined : 'Double-click for debug info'}
            >
              {paged ? BUCKET_TITLES[shownPage] : CONFIG.UI_LABELS.SETTINGS}
            </h1>
            {state.recording && <p className="text-muted text-md mb-5">🔴 recording in progress</p>}
            {showDebug && (
              <p className="text-muted text-sm mb-5 font-mono">
                Platform: {state.platform} · v{CONFIG.APP_VERSION}
                {account && (
                  <>
                    {' '}
                    · {account.email} · {account.userId}
                  </>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 mt-1">
            <SidebarToggle shown={sidebarShown} onToggle={toggleSidebar} />
            <Button
              variant="icon"
              aria-label="Search settings"
              title="Search settings (⌘F)"
              className="flex items-center justify-center bg-transparent border border-surface3 text-muted rounded-sm cursor-pointer transition-colors hover:bg-surface2 hover:text-on-surface"
              onClick={() => (searchOpen ? closeSearch() : openSearch())}
            >
              <Search size={14} strokeWidth={2.25} />
            </Button>
            {/* Setup, not "Permissions" — this used to reopen the permissions
                wizard, which covers three of the six things that can actually be
                broken. The other three (recording, transcription, your AI) are
                what lost two testers on 2026-07-23. One button, all six. */}
            <Button
              variant="ghost"
              className="flex items-center gap-1.5 bg-transparent border border-surface3 text-muted rounded-sm px-2.5 text-sm font-semibold cursor-pointer transition-colors hover:bg-surface2 hover:text-on-surface"
              onClick={() => void window.api.setup.open()}
            >
              <ShieldCheck size={14} strokeWidth={2.25} />
              {CONFIG.SETUP_CHECK.title}
            </Button>
            <Button
              variant="ghost"
              className="flex items-center gap-1.5 bg-transparent border-0 text-muted rounded-sm px-2 text-sm font-semibold cursor-pointer transition-colors hover:bg-surface2 hover:text-on-surface"
              onClick={() => window.api.openAnalyticsWindow()}
            >
              <BarChart3 size={14} strokeWidth={2.25} />
              Analytics
            </Button>
          </div>
        </div>

        {/* Search — collapsed to a title-bar icon by default (no vertical space).
            When opened it pins as a sticky bar under the title bar so it stays
            reachable while scrolling. Matches section titles + synonyms. */}
        {searchOpen && (
          <div className="sticky top-0 z-[5] -mx-6 px-6 py-2.5 mb-3 bg-bg/95 backdrop-blur border-b border-surface2">
            <div className="relative">
              <Search
                size={16}
                strokeWidth={2.25}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                className="w-full bg-surface2 border border-surface3 rounded-md text-on-surface pl-9 pr-9 py-2 text-md outline-none transition-colors focus:border-accent focus:shadow-focus placeholder:text-muted"
              />
              <Button
                variant="icon"
                aria-label="Close search"
                onClick={closeSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center justify-center text-muted hover:text-on-surface cursor-pointer bg-transparent border-0"
              >
                <X size={15} strokeWidth={2.25} />
              </Button>
            </div>
          </div>
        )}

        {simple && (
          <div className="flex items-center justify-between gap-3 rounded-md px-3 py-2 mb-3 border bg-surface1 border-surface3">
            <div className="flex items-center gap-2 min-w-0">
              <SquareTerminal size={14} strokeWidth={2.25} className="text-muted" />
              <div className="min-w-0">
                <div className="text-sm font-semibold">{CONFIG.UI_LABELS.SIMPLE_CODE_PROMPT}</div>
                <div className="text-muted text-xs">{CONFIG.UI_LABELS.SIMPLE_CODE_DETAIL}</div>
              </div>
            </div>
            <Switch on={false} onChange={(on) => void toggleAdvancedMode(on)} />
          </div>
        )}

        {/* View as user — admins only. Hides every admin section so you can read
            the page as a real user sees it. Deliberately loud while it's on:
            it changes what the window shows, so it must never be mistaken for
            the normal view. Preview only; real access is enforced in main. */}
        {isAdmin && (
          <div
            className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 mb-3 border ${
              viewAsUser ? 'bg-violet/10 border-violet/40' : 'bg-surface1 border-surface3'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Eye
                size={14}
                strokeWidth={2.25}
                className={viewAsUser ? 'text-violet' : 'text-muted'}
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold">View as user</div>
                <div className="text-muted text-xs">
                  {viewAsUser
                    ? 'Admin surfaces hidden here and in the menu bar. This is what a real user sees.'
                    : 'Hide admin surfaces here and in the menu bar to see what a real user sees.'}
                </div>
              </div>
            </div>
            {/* Write through to main — the flag is shared with the tray, and the
                broadcast comes back to set our state. */}
            <Switch on={viewAsUser} onChange={(on) => void window.api.admin.setViewAsUser(on)} />
          </div>
        )}

        {/* Phone Remote sits above Essentials — its own top-level block, and the
            longest card on the page once paired (QR + pairing mode + keep-awake +
            clamshell). It collapses like every other section so it can be folded
            away when you're not pairing a phone. */}
        {phoneRemoteSupported && (
          <Section
            sectionKey="phoneRemote"
            title={SECTIONS.phoneRemote.title}
            keywords={SECTIONS.phoneRemote.keywords}
            query={query}
            collapse={collapse}
            anchorId={SECTION_ANCHOR_ID.phoneRemote}
          >
            <div className={cardCls}>
              {/* No card title — the section header above already says PHONE REMOTE. */}
              <SettingRow
                title={
                  <div className="text-muted text-sm">
                    Use your phone as a trackpad and mic for your Mac.
                  </div>
                }
                control={<Switch on={phoneRemoteEnabled} onChange={togglePhoneRemote} />}
              />
              {phoneRemoteEnabled && pairing.canRetry && (
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {/* Retry re-runs whichever half is actually failing: the
                      tunnel when it's on (it reaps orphaned cloudflared
                      processes first), otherwise the LAN QR fetch. */}
                  <Button
                    variant="ghost"
                    className="px-2 text-sm"
                    onClick={() => (tunnelEnabled ? void retryTunnel() : void fetchPhoneRemoteQr())}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {phoneRemoteError && (
                <div className="text-red-400 text-sm mt-2">{phoneRemoteError}</div>
              )}

              {/* ONE QR, no mode — stacked QRs hid which to scan. make why Q="two QR" */}
              {phoneRemoteEnabled && (
                <div className="mt-4 pt-4 border-t border-surface3">
                  <PairingPanel
                    pairing={pairing}
                    tunnelEnabled={tunnelEnabled}
                    tunnelStatus={tunnelStatus}
                    onTunnelToggle={toggleTunnel}
                    onTunnelRetry={() => void retryTunnel()}
                    onLanRetry={fetchPhoneRemoteQr}
                    qrSize={PAIR_QR_SIZE.sm}
                    dense
                    showCertNote
                    onUpgrade={() => window.api.openUpgradeWindow('phone_remote_minutes')}
                  />

                  {/* Only rendered while a display actually exists -- a
                      permanent row for something that is usually absent would be
                      dead UI, and this one doubles as the status ("it's still
                      up") the user otherwise has no way to check. */}
                  {extendedScreenOn && (
                    <div className="flex justify-between items-center gap-3 mt-4 pt-4 border-t border-surface3">
                      <div className="max-w-[380px]">
                        <div className="text-sm">Extended screen</div>
                        <div className="text-muted text-xs mt-1">
                          Your phone added a second screen, and it stays after the phone disconnects
                          so your windows stay put. Clearing it moves them back.
                        </div>
                      </div>
                      <Button variant="ghost" onClick={clearExtendedScreen}>
                        Clear
                      </Button>
                    </div>
                  )}

                  {/* Keep-awake sits OUTSIDE the pairing panel: it applies to
                      both LAN and off-Wi-Fi sessions, so hiding it in the remote
                      panel would strand LAN users with a sleeping screen. */}
                  <div className="flex justify-between items-center gap-3 mt-4 pt-4 border-t border-surface3">
                    <div className="max-w-[380px]">
                      <div className="text-sm">Keep this Mac awake</div>
                      <div className="text-muted text-xs mt-1">
                        Stops the screen sleeping while Phone Remote is on, so it stays reachable.
                        Uses more battery. Closing the lid still sleeps it.
                      </div>
                    </div>
                    <Switch on={phoneRemoteStayAwake} onChange={toggleStayAwakeWithClamshell} />
                  </div>

                  {/* Clamshell is nested under keep-awake because it's a strict
                      escalation of it — showing it while the screen can still
                      sleep on idle would promise lid-closed control we can't
                      deliver. */}
                  {phoneRemoteStayAwake && (
                    <div className="flex justify-between items-center gap-3 mt-3">
                      <div className="max-w-[380px]">
                        <div className="text-sm">Works with the lid closed</div>
                        <div className="text-muted text-xs mt-1">
                          Keeps this Mac reachable after you shut it, and your agents keep working
                          until they finish. Asks for your password, and changes a system setting
                          until you turn it off. Leave it plugged in - a closed Mac gets warm.
                        </div>
                        {clamshellError && (
                          <div className="text-red-400 text-xs mt-1">{clamshellError}</div>
                        )}
                      </div>
                      <Switch on={phoneRemoteClamshell} onChange={toggleClamshell} />
                    </div>
                  )}

                  {/* Peer of clamshell, not a child of keep-awake: this one is
                      about who can SEE the Mac, not whether it stays powered,
                      and it's just as useful on a Mac that sleeps normally. */}
                  <div className="flex justify-between items-center gap-3 mt-3">
                    <div className="max-w-[380px]">
                      <div className="text-sm">Protect this screen while you use your phone</div>
                      <div className="text-muted text-xs mt-1">
                        Nobody near this Mac sees what you're doing. We cover it once you stop using
                        it, while your phone keeps showing the live screen. If someone sits down and
                        touches it, the Mac locks.
                      </div>
                      {awayModeError && (
                        <div className="text-red-400 text-xs mt-1">{awayModeError}</div>
                      )}
                    </div>
                    <Switch on={phoneRemoteAwayMode} onChange={toggleAwayMode} />
                  </div>

                  {/* Child of the switch above, not a peer: offering cover
                      under an OFF toggle reads as a second, contradictory
                      switch. The switch off is how the session ends. */}
                  {(phoneRemoteAwayMode || phoneRemoteAwayHeld) && (
                    <div className="flex justify-between items-center gap-3 mt-3">
                      <div className="max-w-[380px]">
                        <div className="text-sm">Protect the screen now</div>
                        <div className="text-muted text-xs mt-1">
                          Covers this Mac right now. After that, touching it locks the Mac.
                        </div>
                      </div>
                      <Button variant="ghost" disabled={coverBusy} onClick={toggleCoverNow}>
                        Protect
                      </Button>
                    </div>
                  )}

                  {/* Sits with the other screen-privacy switches, not with the
                      phone pairing rows above: what it governs is who may look
                      at this screen, which is the question this section answers. */}
                  <div className="flex justify-between items-center gap-3 mt-3">
                    <div className="max-w-[380px]">
                      <div className="text-sm">Let Siri see this screen</div>
                      <div className="text-muted text-xs mt-1">
                        Ask Siri what's on your Mac and get an answer out loud, without touching it.
                        Your screen stays covered while you're away.
                      </div>
                    </div>
                    <Switch on={siriScreenAnswer} onChange={toggleSiriScreenAnswer} />
                  </div>
                </div>
              )}
            </div>
          </Section>
        )}

        {showBucketHeader(BUCKETS.essentials) && (
          <div className={bucketCls}>Essentials</div>
        )}

        {/* Account */}
        <Section
          sectionKey="account"
          title={SECTIONS.account.title}
          keywords={SECTIONS.account.keywords}
          query={query}
          className={sectionCls + ' mt-3'}
          collapse={collapse}
        >
          <div className={cardCls}>
            <div className="font-semibold text-lg">{account ? account.email : 'Not signed in'}</div>
            <div className="text-muted text-sm mt-1">
              {account ? `Signed in to ${CONFIG.BRAND_NAME}` : 'Sign in to sync your usage'}
            </div>

            {account && (
              <div className="flex justify-between items-center gap-3 mt-4">
                <div className="max-w-[380px]">
                  <div className="text-sm">Use my Mac from the web</div>
                  <div className="text-muted text-xs mt-1">
                    Your chats follow you to the web and back, and you can pick up where you left off
                    from any browser.
                  </div>
                </div>
                <Switch on={webAccess} onChange={toggleWebAccess} />
              </div>
            )}

            {/* Two taps, never one: this cannot be undone and there is no
              recovery flow to send anyone to afterwards. Arming also survives
              nothing -- closing Settings resets it, so a stray click days later
              can't land on a primed button. */}
            {account && (
              <div className="mt-4">
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (!deleteArmed) {
                      setDeleteArmed(true)
                      return
                    }
                    setDeleting(true)
                    setDeleteError(null)
                    void window.api.auth.deleteAccount().then((result) => {
                      setDeleting(false)
                      if (!result.ok) {
                        setDeleteError(result.error || 'Could not delete your account.')
                        setDeleteArmed(false)
                      }
                      // On success the auth broadcast clears `account`, which
                      // unmounts this whole block -- nothing to reset here.
                    })
                  }}
                  disabled={deleting}
                  className="text-sm text-muted hover:underline disabled:opacity-50"
                >
                  {deleting
                    ? 'Deleting…'
                    : deleteArmed
                      ? 'Click again to delete everything - this cannot be undone'
                      : 'Delete my account'}
                </Button>
                {deleteArmed && !deleting && (
                  <div className="text-muted text-sm mt-2">
                    Deletes your account, your usage history, and cancels any subscription.
                  </div>
                )}
                {deleteError && <div className="text-muted text-sm mt-2">{deleteError}</div>}
              </div>
            )}
          </div>
        </Section>

        {/* Instructions — one text block, applied wherever its toggle is on */}
        <Section
          sectionKey="instructions"
          title={SECTIONS.instructions.title}
          keywords={SECTIONS.instructions.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <p className="text-muted text-sm mb-3">{CONFIG.UI_LABELS.CUSTOM_INSTRUCTIONS_HINT}</p>
            <textarea
              value={globalInstructions.text}
              onChange={(e) => onInstructionsTextChange(e.target.value)}
              rows={4}
              placeholder={CONFIG.UI_LABELS.CUSTOM_INSTRUCTIONS_PLACEHOLDER}
              className="w-full resize-none bg-surface2 rounded-lg px-3 py-2 text-md outline-none focus:shadow-focus mb-3"
            />
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted">Applies to</span>
              <MultiSelectDropdown
                options={INSTRUCTIONS_MODE_OPTIONS}
                selected={
                  new Set(
                    INSTRUCTIONS_MODE_OPTIONS.map((o) => o.value).filter(
                      (m) =>
                        globalInstructions.appliesTo[
                          m as keyof GlobalInstructionsSettings['appliesTo']
                        ]
                    )
                  )
                }
                onChange={onToggleInstructionsMode}
                summary={
                  Object.values(globalInstructions.appliesTo).every(Boolean)
                    ? 'All'
                    : Object.values(globalInstructions.appliesTo).some(Boolean)
                      ? `${Object.values(globalInstructions.appliesTo).filter(Boolean).length} selected`
                      : 'None'
                }
              />
            </div>
          </div>
        </Section>

        {/* AI Model */}
        <Section
          sectionKey="aiModel"
          title={SECTIONS.aiModel.title}
          keywords={SECTIONS.aiModel.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <p className="text-muted text-sm mb-3">
              Choose who answers when you ask {CONFIG.PRODUCT_NAME} for help. Only extra AI features
              cost, and only when you use them.
            </p>
            <div
              ref={attachBackendRow}
              className="flex gap-2.5 overflow-x-auto pb-1 -mx-0.5 px-0.5 cursor-style-row"
            >
              {MODELS.filter((m) => advancedMenu || !m.adminOnly || backend === m.value).map(
                (m) => {
                  const active = backend === m.value
                  return (
                    <Button
                      variant="ghost"
                      key={m.value}
                      onClick={() => chooseBackend(m.value)}
                      aria-pressed={active}
                      style={{ width: '168px' }}
                      className={
                        'relative shrink-0 text-left cursor-pointer rounded-lg px-3.5 py-3 text-on-surface border transition-[color,background-color,border-color,transform] duration-150 outline-none focus-visible:shadow-focus active:scale-[0.98] active:duration-75 ' +
                        (active
                          ? 'bg-surface2 border-accent shadow-focus'
                          : 'bg-transparent border-surface3 hover:border-muted-dark')
                      }
                    >
                      {m.badge && (
                        <span
                          className="absolute top-2 right-2 rounded-full font-semibold uppercase whitespace-nowrap leading-none"
                          style={{
                            fontSize: '9px',
                            letterSpacing: '0.04em',
                            padding: '3px 7px',
                            background: 'var(--amber-bg-subtle)',
                            border: '1px solid var(--amber-border-subtle)',
                            color: 'var(--amber)'
                          }}
                        >
                          {m.badge}
                        </span>
                      )}
                      <span
                        className="flex items-center justify-center w-9 h-9 rounded-lg bg-surface2 border border-surface3 shrink-0"
                        aria-hidden
                      >
                        <ProviderIcon id={m.icon} size={22} />
                      </span>
                      <div className="font-semibold text-lg mt-2.5">{m.label}</div>
                      <div className="text-muted text-sm mt-1 leading-snug">{m.description}</div>
                    </Button>
                  )
                }
              )}
            </div>
            {backend === 'openrouter' && <OpenRouterKey inputCls={inputCls} />}
            {backend === 'local' && (
              <div className="mt-3">
                <div className="text-md font-semibold">Model</div>
                {localModelsLoading ? (
                  <div className="text-muted text-sm mt-1">Looking for pulled models…</div>
                ) : localModels.length === 0 ? (
                  <LocalSetupRow
                    backend="local"
                    state={setupState}
                    busy={setupBusy}
                    error={setupError}
                    onRun={runLocalSetup}
                  />
                ) : (
                  <Select.Root value={ollamaModel} onValueChange={chooseOllamaModel}>
                    <Select.Trigger
                      className="mt-1 w-full flex items-center justify-between bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-sans outline-none transition-colors hover:border-muted-dark focus:border-accent focus:shadow-focus data-[placeholder]:text-muted"
                      aria-label="ollama model"
                    >
                      <Select.Value placeholder="Pick a model">
                        {ollamaModel ? prettyOllamaModel(ollamaModel) : 'Pick a model'}
                      </Select.Value>
                      <Select.Icon className="text-muted">▾</Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content
                        position="popper"
                        sideOffset={4}
                        className="z-50 max-h-72 overflow-hidden bg-surface2 border border-surface3 rounded-md shadow-panel"
                      >
                        <Select.Viewport className="p-1">
                          {localModels.map((m) => (
                            <SelectItem key={m.name} value={m.name}>
                              {prettyOllamaModel(m.name)} ({(m.sizeBytes / 1e9).toFixed(1)} GB
                              {m.vision ? ', vision' : ''}
                              {m.tools ? ', tools' : ''})
                            </SelectItem>
                          ))}
                        </Select.Viewport>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                )}
                {/* Admin-only capability detail for the currently-selected model, so we
                  can eyeball how the panel reads before shipping it to everyone. The
                  dropdown rows already tag (vision, tools) compactly; this is the
                  fuller, persistent view of what the model you're ON can actually do. */}
                {advancedMenu &&
                  ollamaModel !== '' &&
                  (() => {
                    const m = localModels.find((lm) => lm.name === ollamaModel)
                    if (!m) return null
                    const caps: Array<{ label: string; ok: boolean }> = [
                      { label: 'Vision (screenshots)', ok: m.vision },
                      { label: 'Tool calling (act)', ok: m.tools },
                      { label: 'Think before answering', ok: m.thinking }
                    ]
                    return (
                      <div className="mt-2 bg-surface2 border border-surface3 rounded-md p-2.5 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-on-surface">{m.name}</span>
                          <span className="text-muted">{(m.sizeBytes / 1e9).toFixed(1)} GB</span>
                        </div>
                        <div className="mt-2 flex flex-col gap-1">
                          {caps.map((c) => {
                            const color = c.ok ? 'var(--green-light)' : 'var(--red-light)'
                            return (
                              <div key={c.label} className="flex items-center gap-2">
                                <span
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                                />
                                <span className="text-muted">{c.label}</span>
                              </div>
                            )
                          })}
                        </div>
                        <div className="mt-2 text-muted text-xs leading-snug">
                          Admin-only preview. Rewrite &amp; ask always work locally; act needs tool
                          calling.
                        </div>
                        {/* Only rendered for a model that declares it — Ollama hard-errors
                          on a think request to a model without the capability. */}
                        {m.thinking && (
                          <div className="mt-2 pt-2 border-t border-surface3">
                            <SettingRow
                              title={
                                <div className="font-semibold text-md">Think before answering</div>
                              }
                              control={<Switch on={thinkingEnabled} onChange={toggleThinking} />}
                            >
                              <div className="text-muted text-sm">
                                Slower, but better for hard multi-step questions. Off is faster for
                                most things. Chat only.
                              </div>
                            </SettingRow>
                          </div>
                        )}
                      </div>
                    )
                  })()}
              </div>
            )}
            {backend === 'mlx' && (
              <div className="mt-3">
                <div className="text-md font-semibold">Model</div>
                {localModelsLoading ? (
                  <div className="text-muted text-sm mt-1">Looking for served models…</div>
                ) : localModels.length === 0 ? (
                  <LocalSetupRow
                    backend="mlx"
                    state={setupState}
                    busy={setupBusy}
                    error={setupError}
                    onRun={runLocalSetup}
                  />
                ) : (
                  <Select.Root value={mlxModel} onValueChange={chooseMlxModel}>
                    <Select.Trigger
                      className="mt-1 w-full flex items-center justify-between bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-sans outline-none transition-colors hover:border-muted-dark focus:border-accent focus:shadow-focus data-[placeholder]:text-muted"
                      aria-label="rapid-mlx model"
                    >
                      <Select.Value placeholder="Pick a model">
                        {mlxModel || 'Pick a model'}
                      </Select.Value>
                      <Select.Icon className="text-muted">▾</Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content
                        position="popper"
                        sideOffset={4}
                        className="z-50 max-h-72 overflow-hidden bg-surface2 border border-surface3 rounded-md shadow-panel"
                      >
                        <Select.Viewport className="p-1">
                          {localModels.map((m) => (
                            <SelectItem key={m.name} value={m.name}>
                              {m.name}
                              {m.vision ? ' (vision)' : m.tools ? ' (tools)' : ''}
                            </SelectItem>
                          ))}
                        </Select.Viewport>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                )}
              </div>
            )}
            <div className="mt-3">
              <Button variant="ghost" disabled={testing} onClick={testBackend}>
                {testing ? 'Checking…' : 'Check it works'}
              </Button>
              {testResult && testResult.backend === backend && (
                <div className="mt-2.5 flex flex-col gap-1.5">
                  {testResult.checks.map((c) => {
                    const color = c.ok ? 'var(--green-light)' : 'var(--red-light)'
                    return (
                      <div key={c.label} className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ background: color, boxShadow: `0 0 8px ${color}` }}
                        />
                        <span className="text-md font-semibold" style={{ color }}>
                          {c.label}
                        </span>
                        <span className="text-muted text-sm">{c.detail}</span>
                      </div>
                    )
                  })}
                  {testResult.advice && (
                    <div className="text-sm mt-0.5" style={{ color: 'var(--yellow)' }}>
                      {testResult.advice}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Section>

        {/* Credits — usage-based balance + a Monthly (subscribe) / One-time (packs)
            toggle for the mightymouse backend. Monthly is the growth goal, so it's
            the default tab; One-time is one click away and behaves exactly as
            before. Whichever tab is active, its buttons are the only checkout
            entry points — no mixing recurring and one-time in the same list. */}
        <Section
          sectionKey="credits"
          title={SECTIONS.credits.title}
          keywords={SECTIONS.credits.keywords}
          query={query}
          collapse={collapse}
          anchorId={SECTION_ANCHOR_ID.credits}
        >
          <div className={cardCls}>
            {usage ? (
              <div className="mb-2">
                <UsageMeterView meter={usage} />
              </div>
            ) : (
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-muted text-sm">Your balance</span>
                <span className="font-bold text-2xl leading-none">
                  {balanceCents === null ? '—' : `$${(balanceCents / 100).toFixed(2)}`}
                </span>
              </div>
            )}
            <p className="text-muted text-sm mb-3">
              {subscription?.status === 'active'
                ? CONFIG.BILLING.CREDITS_BLURB.subscribed
                : CONFIG.BILLING.CREDITS_BLURB.unsubscribed}
            </p>

            {/* Already bought — a quiet confirmation line, not a badge. Lifetime is
              no longer sold (see migration 0102); existing owners still see this. */}
            {lifetime?.alreadyOwned && (
              <div className="rounded-md border border-surface3 bg-surface2 px-3 py-2.5 mb-3 text-on-surface text-sm font-semibold">
                {CONFIG.BILLING.LIFETIME.owned_label}
              </div>
            )}

            {subscription?.status === 'active' ? (
              <div className="rounded-md border border-surface3 bg-surface2 px-3 py-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-on-surface font-semibold text-md">Subscribed</div>
                  <div className="text-muted text-sm mt-0.5">
                    {subscription.currentPeriodEnd
                      ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                      : 'Renews automatically'}
                  </div>
                </div>
                <Button variant="ghost" disabled={topupPending === 'portal'} onClick={openPortal}>
                  {topupPending === 'portal' ? 'Opening…' : 'Manage'}
                </Button>
              </div>
            ) : (
              <SegmentedControl
                items={[
                  { id: 'monthly', label: 'Monthly' },
                  { id: 'onetime', label: 'One-time' }
                ]}
                active={creditsTab}
                onChange={setCreditsTab}
                className="mb-3"
              />
            )}

            {/* Subscriptions and Lifetime live in the upgrade window now — one
              paywall for the whole app, so pricing copy has a single home. Packs
              stay here: a top-up is account maintenance, not an upgrade decision. */}
            {subscription?.status !== 'active' && creditsTab === 'monthly' && (
              <Button
                variant="ghost"
                onClick={() => window.api.openUpgradeWindow('settings')}
                className="w-full flex items-center justify-between gap-3 rounded-md border border-surface3 bg-surface2 px-3 py-3 cursor-pointer transition-all hover:border-accent hover:shadow-focus"
              >
                <span className="text-on-surface font-bold text-xl leading-none">
                  Monthly plans
                </span>
                <span className="text-green-light text-sm font-semibold">
                  From {CONFIG.BILLING.PLANS[0].label} - every model, resets monthly
                </span>
              </Button>
            )}

            {subscription?.status !== 'active' && creditsTab === 'onetime' && (
              <div className="grid grid-cols-3 gap-2">
                {CONFIG.BILLING.PACKS.map((pack) => {
                  const pending = topupPending === pack.id
                  return (
                    <Button
                      variant="ghost"
                      key={pack.id}
                      onClick={() => openCheckout(pack.id)}
                      disabled={topupPending !== null}
                      className="flex flex-col items-center gap-0.5 rounded-md border border-surface3 bg-surface2 px-2 py-3 cursor-pointer transition-all hover:border-accent hover:shadow-focus disabled:opacity-50 disabled:cursor-default disabled:hover:border-surface3 disabled:hover:shadow-none"
                    >
                      <span className="text-on-surface font-bold text-xl leading-none">
                        {pending ? '…' : pack.label}
                      </span>
                      {pack.bonus_label && (
                        <span className="text-green-light text-xlg font-semibold mt-0.5">
                          {pack.bonus_label}
                        </span>
                      )}
                    </Button>
                  )
                })}
              </div>
            )}

            {topupMsg && (
              <div
                className="text-sm mt-2.5"
                style={{ color: topupMsg.kind === 'ok' ? 'var(--cyan)' : 'var(--red-light)' }}
              >
                {topupMsg.text}
              </div>
            )}
          </div>
        </Section>

        <Section
          sectionKey="aiPlans"
          title={SECTIONS.aiPlans.title}
          keywords={SECTIONS.aiPlans.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <BackendConnections
              rows={MODELS.filter(
                (m) => m.value !== 'mightymouse' && (advancedMenu || !m.adminOnly || backend === m.value)
              )}
            />
            <PlanLogins />
          </div>
        </Section>

        {/* Usage — per-call charge history for the mightymouse backend. Shows the
            user exactly what they were charged for, grouped by day. RLS-backed. */}
        <Section
          sectionKey="usage"
          title={SECTIONS.usage.title}
          keywords={SECTIONS.usage.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <UsageHistory compact />
          </div>
        </Section>

        <Section
          sectionKey="advancedMode"
          title={SECTIONS.advancedMode.title}
          keywords={SECTIONS.advancedMode.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <div className="flex justify-between items-center gap-3">
              <div className="max-w-[380px]">
                <div className="text-sm">{CONFIG.UI_LABELS.SIMPLE_CODE_PROMPT}</div>
                <div className="text-muted text-xs mt-1">
                  {CONFIG.UI_LABELS.SIMPLE_CODE_DETAIL}. {CONFIG.UI_LABELS.SIMPLE_CODE_OFF_NOTE}.
                </div>
              </div>
              <Switch on={advancedMode} onChange={toggleAdvancedMode} />
            </div>
          </div>
        </Section>

        {showBucketHeader(BUCKETS.chat) && <div className={bucketCls}>Chat</div>}

        <Section
          sectionKey="chat"
          title={SECTIONS.chat.title}
          keywords={SECTIONS.chat.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <ChatPrefs
              onNameChange={chat.onNameChange}
              onTabNameFormatChange={chat.onTabNameFormatChange}
            />
          </div>
        </Section>

        <Section
          sectionKey="projects"
          title={SECTIONS.projects.title}
          keywords={SECTIONS.projects.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <Button variant="ghost" onClick={() => setProjectsOpen(true)}>
              {CONFIG.UI_LABELS.SETTINGS_OPEN_PROJECTS}
            </Button>
          </div>
          <div className={cardCls}>
            <div className="flex justify-between items-center gap-3">
              <div className="max-w-[380px]">
                <div className="text-sm">Give each new Code conversation its own copy</div>
                <div className="text-muted text-xs mt-1">
                  Agents working on the same project at once never overwrite each other&apos;s files.
                  Each copy starts from your last commit, on its own branch.
                </div>
              </div>
              <Switch on={codeOwnCopy} onChange={toggleCodeOwnCopy} />
            </div>
          </div>
          {projectsOpen && (
            <AllProjectsModal onClose={() => setProjectsOpen(false)} onChanged={chat.onProjectsChanged} />
          )}
        </Section>

        <Section
          sectionKey="alerts"
          title={SECTIONS.alerts.title}
          keywords={SECTIONS.alerts.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <MightyMacAlerts />
            <PulseSetting />
          </div>
        </Section>

        {showBucketHeader(BUCKETS.capture) && <div className={bucketCls}>Capture</div>}

        <Section
          sectionKey="dictation"
          title={SECTIONS.dictation.title}
          keywords={SECTIONS.dictation.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <div className="text-sm text-muted">What MightyMouse listens for when you dictate.</div>
            <LanguagePicker
              state={state}
              value={whisperLang}
              onChange={saveLanguage}
              onDownloaded={apply}
            />
            <div className="flex justify-between items-center gap-3 mt-4 pt-4 border-t border-surface3">
              <div className="max-w-[380px]">
                <div className="text-sm">Hold the listen key to write for the screen</div>
                <div className="text-muted text-xs mt-1">
                  Hold it 3 seconds and MightyMouse rewrites what you said to fit the app
                  you're in.
                </div>
              </div>
              <Switch on={holdForSmart} onChange={toggleHoldForSmart} />
            </div>
          </div>
        </Section>

        {/* Cursor Companion */}
        <Section
          sectionKey="cursor"
          title={SECTIONS.cursor.title}
          keywords={SECTIONS.cursor.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <div className="flex justify-between items-center">
              <div className="max-w-[380px]">
                <div className="font-semibold text-lg">Animated pointer</div>
                <div className="text-muted text-sm mt-1">
                  Show a glowing pointer that follows your cursor across the screen.
                </div>
              </div>
              <Switch on={cursorCompanion} onChange={toggleCursorCompanion} />
            </div>

            {cursorCompanion && (
              <div className="mt-4 pt-4 border-t border-surface3">
                <div className="font-semibold text-md mb-2">Pointer style</div>
                {/* Horizontally scrolling preview cards — pick by look, not name. */}
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 cursor-style-row">
                  {visibleCursorStyles(advancedMenu).map((s) => (
                    <CursorStyleCard
                      key={s.id}
                      meta={s}
                      active={s.id === cursorStyle}
                      onPick={() => chooseCursorStyle(s.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* Click to act — admin-only (needs Accessibility + auto-clicks; not for the
            simple view). Let an Ask answer move + click a spot on screen. Off by
            default. The pointer (point-at) always works; this only adds the real click. */}
        {advancedMenu && (
          <Section
            sectionKey="click"
            title={SECTIONS.click.title}
            keywords={SECTIONS.click.keywords}
            query={query}
            collapse={collapse}
          >
            <div className={cardCls}>
              <SettingRow
                title={
                  <div className="font-semibold text-lg">
                    Click to act <Badge color="violet">Admin</Badge>
                  </div>
                }
                control={<Switch on={clickEnabled} onChange={toggleClickEnabled} />}
              >
                <div className="text-muted text-sm">
                  Let an answer point at a spot and actually click it for you. Without this it only
                  points. Needs Accessibility.
                </div>
                {clickEnabled &&
                  (() => {
                    // Surface the real Accessibility grant whenever clicking is on, so
                    // the user can SEE and FIX it here — clicks silently no-op without
                    // it. Granted → a green confirm chip; missing → amber chip + a
                    // Grant button that fires the OS prompt and refreshes live.
                    const granted =
                      state.permissions.find((p) => p.key === 'accessibility')?.status === 'granted'
                    return (
                      <div className="flex items-center gap-2 mt-2">
                        <Badge color={granted ? 'green' : 'amber'}>
                          {granted ? '✓ Accessibility granted' : 'Accessibility needed'}
                        </Badge>
                        {!granted && (
                          <Button variant="ghost" onClick={grantAccessibility}>
                            Grant
                          </Button>
                        )}
                      </div>
                    )
                  })()}
              </SettingRow>
            </div>
          </Section>
        )}

        {/* Act highlight — flashes a dashed box around where act mode is about to
            click/type/drag, so a real screen action never happens with zero
            warning. On by default. Independent of Click to act — it observes the
            CLI's own mm-input calls, it doesn't gate them. */}
        <Section
          sectionKey="actHighlight"
          title={SECTIONS.actHighlight.title}
          keywords={SECTIONS.actHighlight.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={
                <div className="font-semibold text-lg">{CONFIG.UI_LABELS.SHOW_BEFORE_ACTING}</div>
              }
              control={<Switch on={actHighlight} onChange={toggleActHighlight} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.SHOW_BEFORE_ACTING_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        <Section
          sectionKey="actions"
          title={SECTIONS.actions.title}
          keywords={SECTIONS.actions.keywords}
          query={query}
          collapse={collapse}
        >
          <ActionsSettingsSection />
        </Section>

        <Section
          sectionKey="voiceRouting"
          title={SECTIONS.voiceRouting.title}
          keywords={SECTIONS.voiceRouting.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={
                <div className="font-semibold text-lg">
                  Action routing <Badge color="blue">Experimental</Badge>
                </div>
              }
            >
              <div className="text-muted text-sm">
                After you dictate, {CONFIG.PRODUCT_NAME} looks at the apps you have open and offers
                the one your words most likely belong in. Pick it and the text is pasted there. Your
                words are never rewritten.
              </div>
              <SegmentedControl
                items={[
                  { id: 'off', label: 'Off' },
                  { id: 'hover', label: 'With a button' },
                  { id: 'always', label: 'Always' }
                ]}
                active={voiceRoutingMode}
                onChange={(m) => void pickVoiceRoutingMode(m)}
                className="mt-3 max-w-[420px]"
              />
              <div className="text-muted text-sm">
                {voiceRoutingMode === 'hover'
                  ? 'Your words are pasted as usual. A small round button shows on the bottom-left corner of the transcript card - click it and you get the list of places to send it instead.' +
                    (fnListenEnabled
                      ? ' Already know it belongs somewhere else? Hold fn and tap Option while you record, and the list opens by itself when you stop.'
                      : '')
                  : voiceRoutingMode === 'always'
                    ? 'Every dictation opens the list of places to send it.'
                    : 'Dictation pastes into whatever app you are in.'}
              </div>
            </SettingRow>

            {voiceRoutingMode !== 'off' && (
              <div className="mt-4 pt-4 border-t border-surface3 flex justify-between items-center">
                <div className="max-w-[380px]">
                  <div className="font-semibold text-md">Offer &quot;go there&quot;</div>
                  <div className="text-muted text-sm mt-1">
                    Adds a second button that pastes and then leaves you in that app, instead of
                    returning you to what you were doing.
                  </div>
                </div>
                <Switch on={voiceRoutingGoTo} onChange={toggleVoiceRoutingGoTo} />
              </div>
            )}

            {voiceRoutingMode !== 'off' && (
              <div className="mt-4 pt-4 border-t border-surface3 flex justify-between items-center">
                <div className="max-w-[380px]">
                  <div className="font-semibold text-md">Send to a skill</div>
                  <div className="text-muted text-sm mt-1">
                    Say what you want and pick the skill that does it - it runs straight away, with
                    what you said as the instruction.
                  </div>
                </div>
                <Switch on={voiceRoutingSkills} onChange={toggleVoiceRoutingSkills} />
              </div>
            )}

            {voiceRoutingMode !== 'off' && (
              <div className="mt-4 pt-4 border-t border-surface3 flex justify-between items-center">
                <div className="max-w-[380px]">
                  <div className="font-semibold text-md">Send to a coding agent</div>
                  <div className="text-muted text-sm mt-1">
                    Talk to an agent that is already running without finding its window first - your
                    words go into its prompt and it starts.
                  </div>
                </div>
                <Switch on={voiceRoutingAgents} onChange={toggleVoiceRoutingAgents} />
              </div>
            )}
          </div>
        </Section>

        {/* Suggestions — advanced-only (power knob, not for the simple view) */}
        {advancedMenu && (
          <Section
            sectionKey="suggestions"
            title={SECTIONS.suggestions.title}
            keywords={SECTIONS.suggestions.keywords}
            query={query}
            collapse={collapse}
          >
            <div className={cardCls}>
              <SettingRow
                title={
                  <div className="font-semibold text-lg">
                    Suggestions <Badge color="violet">Admin</Badge>
                  </div>
                }
                control={<Switch on={suggestions} onChange={toggleSuggestions} />}
              >
                <div className="text-muted text-sm">
                  Pop a small bubble near your cursor with the best next move. Fires when you pause,
                  or any time you press the suggest shortcut.
                </div>
              </SettingRow>
            </div>
          </Section>
        )}

        {/* Sound effects + Capture HUD — plain preferences, everyone gets them.
            Were admin-gated until 2026-07-22 by an {advancedMenu} FRAGMENT that
            wrapped both; neither is admin-worthy on its own. */}

        {/* Talk out loud — opens the companion overlay and turns on the mic loop.
            The overlay has no other entry point, so this switch is how it exists. */}

        {/* Auto-paste + Feedback + Ambient context log + Run details. Auto-paste
            is core dictation UX; the rest are ordinary preferences. All four were
            admin-gated until 2026-07-22 by one {advancedMenu} FRAGMENT wrapping
            the group — inherited gating, never a per-section decision. */}

        {/* Show run details — the Run Transcript Inspector. When on, a finished/
            running HUD card gets an expand icon that opens the full-screen
            timeline of every tool call, thought, and token usage. Debug surface. */}

        {/* Privacy: incognito (master off switch). When ON, the card flips to an
            amber active state + status badge so the privacy mode is unmistakable. */}

        {/* Permissions moved to the title-bar button (one-time setup; the tray
            also auto-warns when a required permission is missing). */}

        {showBucketHeader(BUCKETS.general) && <div className={bucketCls}>General</div>}

        <Section
          sectionKey="sound"
          title={SECTIONS.sound.title}
          keywords={SECTIONS.sound.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">Sound effects</div>}
              control={<Switch on={soundEnabled} onChange={toggleSound} />}
            >
              <div className="text-muted text-sm">A soft chime when things finish.</div>
            </SettingRow>
          </div>
        </Section>

        {/* Dynamic Island */}
        <Section
          sectionKey="island"
          title={SECTIONS.island.title}
          keywords={SECTIONS.island.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">Dynamic Island</div>}
              control={<Switch on={dynamicIsland} onChange={toggleDynamicIsland} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.DYNAMIC_ISLAND_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        {CONFIG.SELECTION_BAR.ENABLED && (
          <Section
            sectionKey="selectionBar"
            title={SECTIONS.selectionBar.title}
            keywords={SECTIONS.selectionBar.keywords}
            query={query}
            collapse={collapse}
            anchorId={SECTION_ANCHOR_ID.selectionBar}
          >
            <div className={cardCls}>
              <SettingRow
                title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.SELECTION_BAR}</div>}
                control={<Switch on={selectionBar} onChange={toggleSelectionBar} />}
              >
                <div className="text-muted text-sm">{CONFIG.UI_LABELS.SELECTION_BAR_HINT}</div>
              </SettingRow>
            </div>
          </Section>
        )}

        {/* `|| liveCompanion` so a conversation already running keeps its End
            button — hiding the card mid-conversation strands it. */}
        {(advancedMenu || liveCompanion) && (
          <Section
            sectionKey="voice"
            title={SECTIONS.voice.title}
            keywords={SECTIONS.voice.keywords}
            query={query}
            collapse={collapse}
          >
            <div className={cardCls}>
              {/* Not a preference toggle: a conversation is a thing you START and
              END, so the control says so. There is no "voice mode is on" state
              to sit in — either you are talking to it or you are not. */}
              <SettingRow
                title={<div className="font-semibold text-lg">{SECTIONS.voice.title}</div>}
                control={
                  <Button
                    variant={liveCompanion ? 'ghost' : 'primary'}
                    onClick={() => toggleLiveCompanion(!liveCompanion)}
                  >
                    {liveCompanion ? 'End' : 'Start'}
                  </Button>
                }
              >
                <div className="text-muted text-sm">{CONFIG.UI_LABELS.LIVE_COMPANION_HINT}</div>
              </SettingRow>

              {/* The one thing worth deciding BEFORE you start talking: whether it
              may touch your Mac. Shown whether or not a conversation is running,
              because it is the answer to "is this safe to try?" — the question
              people have before they press Start, not after. */}
              <div className="mt-4 pt-4 border-t border-surface3">
                <SettingRow
                  title={<div className="font-semibold text-lg">Let it use your Mac</div>}
                  control={<Switch on={liveActs} onChange={toggleLiveActs} />}
                >
                  <div className="text-muted text-sm">
                    It can click and type for you to get things done. Turn this off and it only
                    answers out loud, and never touches anything.
                  </div>
                </SettingRow>
              </div>

              {/* Voice picker only matters once the loop is on — it has nothing to
              say about a companion that never speaks. */}
              {liveCompanion && (
                <div className="mt-4 pt-4 border-t border-surface3">
                  <KokoroVoiceCard />
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Show in Dock */}
        <Section
          sectionKey="dockIcon"
          title={SECTIONS.dockIcon.title}
          keywords={SECTIONS.dockIcon.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">Show in Dock</div>}
              control={<Switch on={dockIcon} onChange={toggleDockIcon} />}
            >
              <div className="text-muted text-sm">
                Add a Dock icon so you can click to open. Also puts {CONFIG.PRODUCT_NAME} in the app
                switcher. The menu bar icon stays either way.
              </div>
            </SettingRow>
          </div>
        </Section>

        <Section
          sectionKey="fnListen"
          title={SECTIONS.fnListen.title}
          keywords={SECTIONS.fnListen.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.FN_LISTEN}</div>}
              control={<Switch on={fnListenEnabled} onChange={toggleFnListen} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.FN_LISTEN_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        <Section
          sectionKey="autoPaste"
          title={SECTIONS.autoPaste.title}
          keywords={SECTIONS.autoPaste.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.AUTO_PASTE}</div>}
              control={<Switch on={listenAutoPaste} onChange={toggleListenAutoPaste} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.AUTO_PASTE_HINT}</div>
            </SettingRow>
            {TRANSCRIPT_FORMATS.map((f) => (
              <SettingRow
                key={f.id}
                title={<div className="font-semibold text-lg">{f.title}</div>}
                control={
                  <Switch
                    on={transcriptFormats[f.id] ?? f.defaultOn}
                    onChange={(next) => void toggleTranscriptFormat(f.id, next)}
                  />
                }
              >
                <div className="text-muted text-sm">{f.hint}</div>
              </SettingRow>
            ))}
          </div>
        </Section>

        {showBucketHeader(BUCKETS.privacy) && (
          <div className={bucketCls}>Privacy & data</div>
        )}

        {/* Feedback & learning */}
        <Section
          sectionKey="feedback"
          title={SECTIONS.feedback.title}
          keywords={SECTIONS.feedback.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={
                <div className="font-semibold text-lg">{CONFIG.UI_LABELS.FEEDBACK_LEARNING}</div>
              }
              control={<Switch on={feedbackEnabled} onChange={toggleFeedback} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.FEEDBACK_LEARNING_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        {/* Photo access for agents */}
        <Section
          sectionKey="agentPhotos"
          title={SECTIONS.agentPhotos.title}
          keywords={SECTIONS.agentPhotos.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.AGENT_PHOTOS}</div>}
              control={<Switch on={agentPhotos} onChange={toggleAgentPhotos} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.AGENT_PHOTOS_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        <Section
          sectionKey="decisionCards"
          title={SECTIONS.decisionCards.title}
          keywords={SECTIONS.decisionCards.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.DECISION_CARDS}</div>}
              control={<Switch on={decisionCards} onChange={toggleDecisionCards} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.DECISION_CARDS_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        <Section
          sectionKey="incognito"
          title={SECTIONS.incognito.title}
          keywords={SECTIONS.incognito.keywords}
          query={query}
          collapse={collapse}
        >
          <div
            className={cardCls}
            style={
              incognito
                ? {
                    borderColor: 'var(--amber-border-subtle)',
                    background: 'var(--amber-bg-subtle)'
                  }
                : undefined
            }
          >
            <SettingRow
              title={
                <div className="flex items-center gap-2">
                  <div className="font-semibold text-lg">Incognito mode</div>
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide"
                    style={
                      incognito
                        ? {
                            color: 'var(--amber)',
                            background: 'var(--amber-bg-subtle)',
                            border: '1px solid var(--amber-border-subtle)'
                          }
                        : {
                            color: 'var(--muted)',
                            background: 'var(--surface2)',
                            border: '1px solid var(--surface3)'
                          }
                    }
                  >
                    {incognito ? <EyeOff size={11} strokeWidth={2.5} /> : null}
                    {incognito ? 'On · not logging' : 'Off'}
                  </span>
                </div>
              }
              control={<Switch on={incognito} onChange={toggleIncognito} />}
            >
              <div className="text-muted text-sm">
                Stop saving everything. While this is on, nothing you do is written to your history,
                logs, or the cloud. Your existing history stays put. Turn it off to start saving
                again.
              </div>
            </SettingRow>
          </div>
        </Section>

        {/* Privacy: encrypt history + clear history */}
        <Section
          sectionKey="privacy"
          title={SECTIONS.privacy.title}
          keywords={SECTIONS.privacy.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">Encrypt &amp; clear history</div>}
              control={<Switch on={historyEncryption} onChange={toggleHistoryEncryption} />}
            >
              <div className="text-muted text-sm">
                Lock your saved history on this Mac so backups and other apps can not read it. We
                save a copy first, so turning this on or off never loses anything.
              </div>
            </SettingRow>
            <div className="mt-4 pt-4 border-t border-surface3">
              <SettingRow
                title={<div className="font-semibold text-lg">Clear history</div>}
                control={
                  <Button variant="ghost" onClick={clearHistory}>
                    Clear
                  </Button>
                }
              >
                <div className="text-muted text-sm">
                  Delete everything you have asked and gotten back. A backup is saved first.
                </div>
              </SettingRow>
            </div>
          </div>
        </Section>

        {showBucketHeader(BUCKETS.advanced) && <div className={bucketCls}>Advanced</div>}

        {/* Recording */}
        <Section
          sectionKey="recording"
          title={SECTIONS.recording.title}
          keywords={SECTIONS.recording.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <div className="flex justify-between items-center gap-3">
              <div className="max-w-[380px]">
                <div className="font-semibold text-lg">{CONFIG.UI_LABELS.SCREEN_RECORDING_MAX}</div>
                <div className="text-muted text-sm mt-1">
                  {CONFIG.UI_LABELS.SCREEN_RECORDING_MAX_HINT}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="number"
                  min={0.1}
                  step={0.5}
                  className={`${inputCls} w-20 text-right`}
                  value={maxRecMin}
                  onChange={(e) => setMaxRecMin(Number(e.target.value))}
                  onBlur={(e) => commitMaxRec(Number(e.target.value))}
                />
                <span className="text-muted text-sm">min</span>
              </div>
            </div>
          </div>
        </Section>

        <Section
          sectionKey="captureHud"
          title={SECTIONS.captureHud.title}
          keywords={SECTIONS.captureHud.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.CAPTURE_HUD}</div>}
              control={<Switch on={captureHud} onChange={toggleCaptureHud} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.CAPTURE_HUD_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        <Section
          sectionKey="showTiming"
          title={SECTIONS.showTiming.title}
          keywords={SECTIONS.showTiming.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.SHOW_TIMING}</div>}
              control={<Switch on={showTiming} onChange={toggleShowTiming} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.SHOW_TIMING_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        {/* Ambient context log */}
        <Section
          sectionKey="contextLog"
          title={SECTIONS.contextLog.title}
          keywords={SECTIONS.contextLog.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.CONTEXT_LOG}</div>}
              control={<Switch on={contextLog} onChange={toggleContextLog} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.CONTEXT_LOG_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        <Section
          sectionKey="runTranscript"
          title={SECTIONS.runTranscript.title}
          keywords={SECTIONS.runTranscript.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <SettingRow
              title={<div className="font-semibold text-lg">{CONFIG.UI_LABELS.RUN_DETAILS}</div>}
              control={<Switch on={runTranscript} onChange={toggleRunTranscript} />}
            >
              <div className="text-muted text-sm">{CONFIG.UI_LABELS.RUN_DETAILS_HINT}</div>
            </SettingRow>
          </div>
        </Section>

        {/* Whisper / capture binaries */}
        <Section
          sectionKey="binaries"
          title={SECTIONS.binaries.title}
          keywords={SECTIONS.binaries.keywords}
          query={query}
          collapse={collapse}
          anchorId={SECTION_ANCHOR_ID.binaries}
        >
          <div className={cardCls}>
            <BinRow label="ffmpeg" bin={ffmpegBin} />
            {/* Recording is dead without ffmpeg, so a missing one gets a real
              one-click fix here — this is where the HUD's capture error sends
              the user. Homebrew absent = explain that instead of a dead button. */}
            {!ffmpegBin?.found && (
              <div className="mt-2">
                {state.hasHomebrew ? (
                  <Button disabled={busy === 'ffmpeg'} onClick={installFfmpeg}>
                    {busy === 'ffmpeg'
                      ? CONFIG.CAPTURE_ERROR.installing
                      : CONFIG.CAPTURE_ERROR.installAction}
                  </Button>
                ) : (
                  <div className="text-xs text-muted">
                    {ffmpegInstallHint}{' '}
                    <a
                      href={CONFIG.BREW_INSTALL_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {CONFIG.BREW_INSTALL_URL.replace('https://', '')}
                    </a>
                  </div>
                )}
                {busy === 'ffmpeg' && installLine && (
                  <div className="text-xs text-muted mt-1 truncate">{installLine}</div>
                )}
              </div>
            )}
            {/* Manual path override — advanced only; saved by the Advanced bucket's
              button. Simple mode just shows status + Open Folder. */}
            {advancedMenu && (
              <div className="flex gap-2 mt-2">
                <input
                  className={inputCls}
                  value={ffmpeg}
                  placeholder={ffmpegBin?.path || OVERRIDE_PATH_PLACEHOLDER}
                  onChange={(e) => setFfmpeg(e.target.value)}
                />
              </div>
            )}
          </div>

          <div className={cardCls}>
            <BinRow label="whisper-cli" bin={whisperBin} />
            {(advancedMenu || !whisperBin?.found) && (
              <div className="flex gap-2 mt-2">
                {advancedMenu && (
                  <input
                    className={inputCls}
                    value={whisper}
                    placeholder={whisperBin?.path || OVERRIDE_PATH_PLACEHOLDER}
                    onChange={(e) => setWhisper(e.target.value)}
                  />
                )}
                {!whisperBin?.found && (
                  <Button disabled={busy === 'whisper'} onClick={installWhisper}>
                    {busy === 'whisper' ? 'Installing…' : 'Install via brew'}
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className={cardCls}>
            <BinRow label="Whisper model" bin={modelBin} />
            {(advancedMenu || !modelBin?.found) && (
              <div className="flex gap-2 mt-2">
                {advancedMenu && (
                  <input
                    className={inputCls}
                    value={whisperModel}
                    placeholder={modelBin?.path || OVERRIDE_PATH_PLACEHOLDER}
                    onChange={(e) => setWhisperModel(e.target.value)}
                  />
                )}
                {!modelBin?.found && (
                  <Button disabled={busy === 'model'} onClick={downloadModel}>
                    {busy === 'model' ? `${dlPct ?? 0}%` : 'Download base.en'}
                  </Button>
                )}
              </div>
            )}
            {dlPct !== null && (
              <div className="h-1 bg-surface3 rounded-full mt-2 overflow-hidden">
                <div
                  className="h-1 bg-cyan rounded-full transition-all"
                  style={{ width: `${dlPct}%` }}
                />
              </div>
            )}
          </div>

          {/* Only for languages it can transcribe: on Hebrew or auto-detect this
              row would sit there red and "not found" for something the user does
              not need and cannot use. */}
          {parakeetCanTranscribe(state.whisperLang) && (
            <div className={cardCls}>
              <BinRow label="Fast transcription" bin={parakeetBin} />
              <div className="mt-2 text-sm text-muted">
                {parakeetBin?.found
                  ? 'Your voice becomes text about three times faster.'
                  : 'Dictation works the usual way until this finishes downloading.'}
              </div>
            </div>
          )}
        </Section>

        {/* Advanced bucket — power-user knobs. Hidden in Simple mode (the tray
            owns the toggle). AV device selection, manual paths, storage roots. */}
        {advancedMenu && (
          <>
            {/* AV devices */}
            <Section
              sectionKey="devices"
              title={SECTIONS.devices.title}
              keywords={SECTIONS.devices.keywords}
              query={query}
              collapse={collapse}
            >
              <div className={cardCls}>
                <p className="text-muted text-sm mb-2.5">
                  Stored by name so the choice survives device reshuffles. Refresh detects newly
                  plugged-in devices.
                </p>
                <div className="flex gap-3">
                  <label className="flex-1 text-md text-muted">
                    Video (screen)
                    <DeviceSelect
                      value={videoDevice}
                      onChange={setVideoDevice}
                      options={state.available.video}
                    />
                  </label>
                  <label className="flex-1 text-md text-muted">
                    Audio (mic)
                    <DeviceSelect
                      value={audioDevice}
                      onChange={setAudioDevice}
                      options={state.available.audio}
                    />
                  </label>
                </div>
                <Button variant="ghost" className="mt-2.5" onClick={refresh}>
                  Refresh device list
                </Button>
              </div>
            </Section>

            {/* Saves both AV device picks (above) and the ffmpeg/whisper path
            overrides (Binaries, above that) — kept outside both Sections so
            it's never hidden by either one's collapse state, but still hidden
            when a search filtered every section away. */}
            {anyResults &&
              (!paged || shownPage === 'advanced') && advancedMode && (
              <div className="flex items-center gap-3 mt-2">
                <Button disabled={busy === 'save'} onClick={save}>
                  {busy === 'save' ? 'Saving…' : 'Save paths & devices'}
                </Button>
                {msg && <span className="text-cyan text-md">{msg}</span>}
              </div>
            )}

            {/* Storage — read-only; open in Finder */}
            <Section
              sectionKey="storage"
              title={SECTIONS.storage.title}
              keywords={SECTIONS.storage.keywords}
              query={query}
              collapse={collapse}
            >
              <div className={cardCls}>
                <p className="text-muted text-sm mb-2.5">
                  Where every run is saved. Read-only for now.
                </p>
                <StorageRow
                  label="Captures (screenshots + recordings)"
                  path={state.storage.captures}
                />
                <StorageRow label="ACT runs" path={state.storage.acts} />
                <StorageRow
                  label={CONFIG.UI_LABELS.CONTEXT_LOG}
                  path={`${state.storage.root}/context-log`}
                />
                <StorageRow label="App root" path={state.storage.root} />
              </div>
            </Section>

            <Section
              sectionKey="smallPanel"
              title={SECTIONS.smallPanel.title}
              keywords={SECTIONS.smallPanel.keywords}
              query={query}
              collapse={collapse}
            >
              <div className={cardCls}>
                <div className="flex justify-between items-center gap-3">
                  <div className="max-w-[380px]">
                    <div className="text-sm">Open the small panel</div>
                    <div className="text-muted text-xs mt-1">
                      Off: the hotkey, menu bar and Dock open the main window, on Chat or Code
                      - wherever you left it.
                    </div>
                  </div>
                  <Switch on={smallPanel} onChange={toggleSmallPanel} />
                </div>
              </div>
            </Section>
          </>
        )}

        {/* Updates — auto-update status + manual check (electron-updater) */}
        <Section
          sectionKey="updates"
          title={SECTIONS.updates.title}
          keywords={SECTIONS.updates.keywords}
          query={query}
          collapse={collapse}
        >
          <div className={cardCls}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-md font-semibold">
                  {update.state === 'available'
                    ? `Version ${update.version} available`
                    : `You're on v${CONFIG.APP_VERSION}`}
                </div>
                <div className="text-sm text-muted">{UPDATE_STATUS_TEXT[update.state]}</div>
              </div>
              <UpdateBadge state={checking ? 'checking' : update.state} />
            </div>
            {update.state === 'download-progress' && (
              <div className="flex items-center gap-3 mt-3">
                <ProgressBar pct={update.percent ?? 0} />
                <span className="text-sm text-muted tabular-nums">
                  {Math.round(update.percent ?? 0)}%
                </span>
              </div>
            )}
            <div className="flex items-center gap-2 mt-3">
              <Button variant="ghost" disabled={checking} onClick={checkForUpdates}>
                {checking ? 'Checking…' : 'Check for updates'}
              </Button>
              {update.state === 'available' && (
                <Button variant="ghost" onClick={() => window.api.update.openReleasePage()}>
                  Get update manually
                </Button>
              )}
              {update.state === 'downloaded' && (
                <Button onClick={() => window.api.update.install()}>Restart to update</Button>
              )}
            </div>
            {update.state === 'error' && update.message && (
              <div className="text-sm text-red-light mt-2">{update.message}</div>
            )}
          </div>
        </Section>

        {/* Code agent relay — its own "Developer" bucket, gated the same way as
            Advanced. kept off the main flow so
            it never adds a noun ("MCP", "agent") to consumer onboarding. */}
        {advancedMenu && (
          <>
            <Section
              sectionKey="agentRelay"
              anchorId={SECTION_ANCHOR_ID.agentRelay}
              title={SECTIONS.agentRelay.title}
              keywords={SECTIONS.agentRelay.keywords}
              query={query}
              collapse={collapse}
            >
              <div className={cardCls}>
                <SettingRow
                  title={
                    <div className="text-muted text-sm">
                      Let your coding agents buzz your phone when they need you, and hand you the
                      live screen when you tap in.
                    </div>
                  }
                  control={<Switch on={agentRelay.enabled} onChange={toggleAgentRelay} />}
                />

                {agentRelay.enabled && (
                  <div className="mt-4 pt-4 border-t border-surface3 flex flex-col gap-3">
                    {/* Same derivation the Code tab's strip uses, so the two
                        surfaces can never disagree about how many are connected. */}
                    {(() => {
                      const line = relayStatusLine(agentRelay, mcpClients)
                      const open = line.names.filter((s) => !s.stale)
                      return (
                        <div
                          className="code-status"
                          data-health={line.health}
                          data-sessions={open.length > 0 ? '' : undefined}
                          tabIndex={open.length > 0 ? 0 : undefined}
                        >
                          <span className="code-status-dot" aria-hidden="true" />
                          <span className="text-sm" aria-live="polite">
                            {line.text}
                          </span>
                          {open.length > 0 && (
                            <div className="code-status-sessions" role="list">
                              {open.map((s, i) => (
                                <div
                                  className="code-status-session"
                                  role="listitem"
                                  key={`${s.label}-${i}`}
                                >
                                  <span className="code-status-session-name">{s.label}</span>
                                  {s.cwd && (
                                    <span className="code-status-session-where">{s.cwd}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Setup is done the moment an agent has connected, so the
                        whole block collapses rather than nagging forever. */}
                    {relayStatusLine(agentRelay, mcpClients).health === 'no-agent' && (
                      <div>
                        <div className="text-sm text-muted mb-1">
                          {mcpClients.length > 0
                            ? 'Connect the coding apps on this Mac'
                            : 'Point any MCP client at this Mac'}
                        </div>

                        {mcpClients.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            {mcpClients.map((client) => (
                              <Button
                                key={client.id}
                                variant="ghost"
                                disabled={client.configured}
                                onClick={() => setUpMcpClient(client.id)}
                              >
                                {client.configured ? `${client.label} ✓` : `Set up ${client.label}`}
                              </Button>
                            ))}
                          </div>
                        )}

                        {mcpClientError && (
                          <div className="text-sm text-red-light mb-2">{mcpClientError}</div>
                        )}

                        {mcpClients.some((c) => c.configured) && (
                          <div className="text-sm text-muted mb-2">
                            Quit and reopen{' '}
                            {listNames(mcpClients.filter((c) => c.configured).map((c) => c.label))}{' '}
                            — it reads this setting when it starts.
                          </div>
                        )}

                        {mcpClients.length > 0 && !showManualSnippet ? (
                          <Button
                            variant="ghost"
                            type="button"
                            className="text-sm text-muted underline"
                            onClick={() => setShowManualSnippet(true)}
                          >
                            or set it up manually
                          </Button>
                        ) : (
                          <CopySnippet text="npx mightymouse-code" />
                        )}
                      </div>
                    )}

                    {/* Gates the buzz only -- every card still arrives in the
                        app, which is what makes muting a question safe enough
                        to offer. The footnote says so out loud. */}
                    <div className="pt-3 border-t border-surface3">
                      <div className="text-sm text-muted mb-2">What buzzes your phone</div>
                      {RELAY_PUSH_VERBS.map((verb) => (
                        <Fragment key={verb}>
                          <SettingRow
                            title={<div className="text-sm">{RELAY_PUSH_LABELS[verb]}</div>}
                            control={
                              <Switch
                                on={relayPush.filter[verb]}
                                onChange={(next) => toggleRelayPush(verb, next)}
                              />
                            }
                          />
                          {/* Indented under its parent switch, and hidden when that
                              switch is off -- a floor on a muted verb does nothing. */}
                          {verb === 'notify' && relayPush.filter.notify && (
                            <div className="pl-4">
                              <SettingRow
                                title={
                                  <div>
                                    <div className="text-sm">{RELAY_NOTIFY_LEVEL_LABEL}</div>
                                    <div className="text-xs text-muted">
                                      {RELAY_NOTIFY_LEVEL_HINT}
                                    </div>
                                  </div>
                                }
                                control={
                                  <Switch
                                    on={relayPush.notifyLevel === 'problems'}
                                    onChange={(next) =>
                                      setRelayNotifyLevel(next ? 'problems' : 'all')
                                    }
                                  />
                                }
                              />
                              {/* Opt-in, and off by default: it fires every time
                                  any agent finishes anything. */}
                              <SettingRow
                                title={
                                  <div>
                                    <div className="text-sm">{RELAY_TURN_END_LABEL}</div>
                                    <div className="text-xs text-muted">{RELAY_TURN_END_HINT}</div>
                                  </div>
                                }
                                control={
                                  <Switch
                                    on={relayPush.turnEndPing}
                                    onChange={(next) => setRelayTurnEndPing(next)}
                                  />
                                }
                              />
                            </div>
                          )}
                        </Fragment>
                      ))}
                      <div className="text-sm text-muted mt-2">{RELAY_PUSH_FOOTNOTE}</div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        disabled={agentRelayTestState === 'sending'}
                        onClick={sendAgentRelayTest}
                      >
                        {agentRelayTestState === 'sending' ? 'Sending…' : 'Send test notification'}
                      </Button>
                      {agentRelayTestState === 'sent' && (
                        <span className="text-sm text-green-light">Sent — check your phone.</span>
                      )}
                      {typeof agentRelayTestState === 'object' && (
                        <span className="text-sm text-red-light">{agentRelayTestState.error}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Section>
          </>
        )}

        {/* No-match hint — only when a query is typed and nothing survived the filter. */}
        {query.trim() && !anyResults && (
          <div className="text-center text-muted text-md py-10">
            No settings match “{query.trim()}”.
          </div>
        )}

        {/* What's new / release notes — hidden while searching (it's notes, not a
            setting), so a query only ever surfaces real settings. */}
        {!query.trim() && (!paged || shownPage === 'advanced') && (
          <>
            <div className={bucketCls}>Release notes</div>
            <Button
              variant="bare"
              className="flex items-center gap-2 w-full text-left bg-transparent border-0 cursor-pointer mt-4 mb-2 p-0"
              onClick={() => setShowNotes((v) => !v)}
              aria-expanded={showNotes}
            >
              <span className="text-md uppercase text-muted font-bold tracking-wider">
                What's new
              </span>
              <span className="text-muted text-sm">{showNotes ? '▾' : '▸'}</span>
            </Button>
            {showNotes && (
              <div className={cardCls}>
                {CONFIG.RELEASE_NOTES.map((rel) => (
                  <div key={rel.version} className="mb-4 last:mb-0">
                    <div className="flex items-baseline gap-2 mb-1.5">
                      <span className="text-md font-bold text-accent-text">v{rel.version}</span>
                      <span className="text-sm text-muted">{rel.date}</span>
                    </div>
                    <ul className="flex flex-col gap-2">
                      {rel.changes.map((c, i) => (
                        // Icon is its own flex column so a wrapping title stays aligned
                        // instead of flowing back under the emoji. Older entries have no
                        // icon; the column collapses and the row reads as it always did.
                        <li key={i} className="leading-snug flex gap-2">
                          {'icon' in c && c.icon && (
                            <span className="text-md shrink-0" aria-hidden="true">
                              {c.icon}
                            </span>
                          )}
                          <div className="min-w-0">
                            <div className="text-md font-semibold">{c.title}</div>
                            <div className="text-sm text-muted">{c.detail}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Sign out — always pinned at the bottom of the panel (not inside the
            Account section). Only shown when signed in and not searching. */}
        {!query.trim() && account && (!paged || shownPage === 'essentials') && (
          <div className="mt-6">
            <Button
              className="w-full"
              onClick={async () => {
                await window.api.auth.signOut()
                setAccount(null)
              }}
            >
              Sign out
            </Button>
          </div>
        )}

        {/* Version footer */}
        <div className="text-center text-muted text-sm mt-4 pb-2">
          {CONFIG.BRAND_NAME} v{CONFIG.APP_VERSION}
        </div>
      </div>
    </div>
  )
}

/** One-line command a dev pastes into their MCP client config, with a copy
 *  button — the whole "second door" is this one string. */
function CopySnippet({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 bg-surface2 border border-surface3 rounded-sm px-2.5 py-1.5 text-sm font-mono">
        {text}
      </code>
      <CopyButton label="Copy command" text={text} />
    </div>
  )
}

/**
 * The empty state for a local backend — one button that gets the service running,
 * or a plain sentence when there's genuinely nothing we can do for them.
 *
 * The manual command stays visible in every state. It's the escape hatch for a
 * user whose machine we can't automate, and the thing they'd search for.
 */
function LocalSetupRow({
  backend,
  state,
  busy,
  error,
  onRun
}: {
  backend: 'local' | 'mlx'
  state: LocalSetupState | null
  busy: LocalSetupProgress | null
  error: string | null
  onRun: () => void
}): JSX.Element {
  const isMlx = backend === 'mlx'
  const pullCmd = isMlx ? 'rapid-mlx pull <model>' : 'ollama pull <model>'

  // A bare spinner on a 60s install reads as "hung". Percent + a running clock
  // is the difference between waiting and wondering whether to force-quit.
  if (busy) {
    const seconds = Math.floor(busy.elapsedMs / 1000)
    const clock = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    return (
      <div className="mt-1 flex flex-col gap-1.5" style={{ maxWidth: 320 }}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">{busy.message}</span>
          <span className="text-muted text-sm font-mono">{busy.percent}%</span>
        </div>
        <div className="flex">
          <ProgressBar pct={busy.percent} height="h-1.5" />
        </div>
        <div className="text-muted text-sm">{clock} elapsed</div>
      </div>
    )
  }

  const label = state?.action === 'start' ? 'Start it for me' : 'Set it up for me'

  return (
    <div className="mt-1 flex flex-col gap-1.5 items-start">
      <div className="text-muted text-sm">
        {state?.detail ?? (isMlx ? 'Rapid-MLX isn’t running yet.' : 'Ollama isn’t running yet.')}
      </div>
      {state?.action && <Button onClick={onRun}>{label}</Button>}
      <div className="text-muted text-sm">
        Or run <code className="font-mono">{pullCmd}</code> in a terminal.
      </div>
      {error && (
        <div className="text-sm" style={{ color: 'var(--yellow)' }}>
          {error}
        </div>
      )}
    </div>
  )
}

function StorageRow({ label, path }: { label: string; path: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-md font-semibold">{label}</div>
        <div className="text-sm text-muted font-mono truncate" title={path}>
          {path}
        </div>
      </div>
      <Button
        variant="ghost"
        className="bg-transparent border border-surface3 text-muted rounded-sm px-3 text-md font-semibold cursor-pointer transition-colors hover:bg-surface2 hover:text-on-surface shrink-0"
        onClick={() => window.api.openPath(path)}
      >
        Open
      </Button>
    </div>
  )
}

function DeviceSelect({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ index: string; name: string }>
}): JSX.Element {
  const names = options.map((o) => o.name)
  // Keep the current value selectable even if the device is currently unplugged.
  const showOrphan = value && !names.includes(value)
  const display = value || 'no devices found'

  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        className="mt-1 w-full flex items-center justify-between bg-surface2 border border-surface3 rounded-sm text-on-surface px-2.5 py-1.5 text-md font-sans outline-none transition-colors hover:border-muted-dark focus:border-accent focus:shadow-focus data-[placeholder]:text-muted"
        aria-label="device"
      >
        <Select.Value placeholder={display}>{value || display}</Select.Value>
        <Select.Icon className="text-muted">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-72 overflow-hidden bg-surface2 border border-surface3 rounded-md shadow-panel"
        >
          <Select.Viewport className="p-1">
            {showOrphan && <SelectItem value={value}>{value} (not connected)</SelectItem>}
            {options.map((o) => (
              <SelectItem key={o.index} value={o.name}>
                [{o.index}] {o.name}
              </SelectItem>
            ))}
            {options.length === 0 && (
              <div className="px-2.5 py-2 text-sm text-muted">no devices found</div>
            )}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  )
}

function SelectItem({
  value,
  children
}: {
  value: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <Select.Item
      value={value}
      className="text-md text-on-surface px-2.5 py-1.5 rounded-sm cursor-pointer outline-none select-none data-[highlighted]:bg-surface3 data-[state=checked]:text-accent-text"
    >
      <Select.ItemText>{children}</Select.ItemText>
    </Select.Item>
  )
}

// A selectable preview card with a small looping animation of the style.
// The preview uses pure CSS keyframes (defined in index.css) so it's cheap and
// doesn't run the real overlay engine — just enough to convey the look.
function CursorStyleCard({
  meta,
  active,
  onPick
}: {
  meta: { id: CursorStyleId; label: string; description: string }
  active: boolean
  onPick: () => void
}): JSX.Element {
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={[
        'flex-shrink-0 w-[168px] text-left rounded-md border p-0 overflow-hidden cursor-pointer transition-all',
        active
          ? 'border-accent shadow-focus bg-surface2'
          : 'border-surface3 bg-surface2 hover:border-muted-dark'
      ].join(' ')}
    >
      {/* Preview stage: dark canvas with the animated companion looping across */}
      <div className="relative h-[88px] w-full overflow-hidden bg-bg-dark">
        <div className={`cursor-preview cursor-preview-${meta.id}`} aria-hidden>
          {meta.id === 'mouseHead' ? (
            <span className="cursor-preview-mouse-wrap">
              <MouseGlyph size={44} showLaser />
            </span>
          ) : (
            <>
              {meta.id === 'comet' && <span className="cursor-preview-tail" aria-hidden />}
              <span className="cursor-preview-orb" aria-hidden />
            </>
          )}
        </div>
      </div>
      <div className="px-2.5 py-2">
        <div className={`text-sm font-semibold ${active ? 'text-accent-text' : 'text-on-surface'}`}>
          {meta.label}
        </div>
        <div className="text-xlg text-muted mt-0.5 leading-tight line-clamp-2">
          {meta.description}
        </div>
      </div>
    </Button>
  )
}

function BinRow({
  label,
  bin
}: {
  label: string
  bin?: { found: boolean; detail?: string; path?: string }
}): JSX.Element {
  const color = bin?.found ? 'var(--green-light)' : 'var(--red-light)'
  const statusText = bin?.found ? bin.detail || 'found' : 'not found'
  // Reveal the binary in Finder by opening its parent folder.
  const parentDir = bin?.path ? bin.path.replace(/\/[^/]*$/, '') : ''
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="font-semibold text-lg shrink-0">{label}</span>
      {/* Dot + status text take the middle and TRUNCATE — a long ffmpeg version
          string must never push the Open Folder button off the card. GlowDot
          carries just the dot; the label truncates separately. */}
      <span className="flex items-center gap-1.5 min-w-0 flex-1">
        <GlowDot color={color} />
        <span className="text-md font-semibold truncate" style={{ color }} title={statusText}>
          {statusText}
        </span>
      </span>
      {bin?.found && parentDir && (
        <Button
          variant="ghost"
          className="bg-transparent border border-surface3 text-muted rounded-sm px-2.5 text-sm font-semibold cursor-pointer transition-colors hover:bg-surface2 hover:text-on-surface shrink-0"
          onClick={() => window.api.openPath(parentDir)}
        >
          Open Folder
        </Button>
      )}
    </div>
  )
}
