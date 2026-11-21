import { useEffect, useState, useCallback, useRef } from 'react'
import { useInterval } from '../../hooks/useInterval'
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
} from '../../../../shared/types'
import type { UsageMeter } from '../../../../shared/billing-math'
import { derivePairing } from '../../../../shared/phone-remote-pairing'
import { CONFIG } from '../../../../shared/config'
import type { RelayVerbWire } from '../../../../shared/phone-remote-protocol'
import {
  DEFAULT_RELAY_PUSH_FILTER,
  DEFAULT_RELAY_TURN_END_PING,
  type RelayNotifyPushLevel,
  type RelayPushSettings
} from '../../../../shared/relay-push-filter'
import {
  CursorStyleId,
  DEFAULT_CURSOR_STYLE,
  toCursorStyle
} from '../../../../shared/cursor-styles'
import { type ChatSettingsHooks } from '../../mighty/MightySecondaryTabs'
import { Switch } from '../Switch'
import { Button } from '../Button'
import {
  SECTIONS,
  ADMIN_ONLY_SECTIONS,
  SIMPLE_SECTIONS,
  BUCKETS,
  sectionDomId,
  useSidebarVisible,
  COLLAPSE_STORAGE_KEY,
  loadCollapsedSections,
  anySectionVisible,
  bucketOf,
  SETTINGS_PAGE_STORAGE_KEY,
  type BucketKey,
  type SectionKey,
  type CollapseCtx
} from './registry'
import { TRANSCRIPT_FORMAT_KEY } from '../../../../shared/transcript-format'
import { useUpdateNotifications } from '../../hooks/useUpdateNotifications'
import { ShieldCheck, BarChart3, Eye } from 'lucide-react'
import { SETUP_COPY, SETUP_FAIL_COPY } from './settings-consts'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred: ~300 settings values
export function useSettingsState({
  onBack,
  chat
}: {
  onBack?: () => void
  chat: ChatSettingsHooks
}) {
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
  const [showTiming, setShowTiming] = useState(false)
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
    !paged &&
    anySectionVisible(query, simple ? keys.filter((k) => SIMPLE_SECTIONS.includes(k)) : keys)

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

  if (!state) return null

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
  const headerLinks = (
    <>
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
    </>
  )
  const sidebarLinkCls =
    'w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-surface2 hover:text-on-surface'
  const sidebarLinks = (
    <>
      <Button
        variant="bare"
        className={sidebarLinkCls}
        onClick={() => void window.api.setup.open()}
      >
        <ShieldCheck size={14} strokeWidth={2.25} className="shrink-0" />
        {CONFIG.SETUP_CHECK.title}
      </Button>
      <Button
        variant="bare"
        className={sidebarLinkCls}
        onClick={() => window.api.openAnalyticsWindow()}
      >
        <BarChart3 size={14} strokeWidth={2.25} className="shrink-0" />
        Analytics
      </Button>
    </>
  )
  // Stays on every page while on, so the preview is never mistaken for the normal view.
  const viewAsUserRow = (
    <div
      className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 mb-3 border ${
        viewAsUser ? 'bg-violet/10 border-violet/40' : 'bg-surface1 border-surface3'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Eye size={14} strokeWidth={2.25} className={viewAsUser ? 'text-violet' : 'text-muted'} />
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
  )

  return {
    state,
    setState,
    ffmpegInstallHint,
    setFfmpegInstallHint,
    query,
    setQuery,
    projectsOpen,
    setProjectsOpen,
    collapsed,
    setCollapsed,
    forceOpenKey,
    setForceOpenKey,
    toggleSection,
    sidebarShown,
    toggleSidebar,
    page,
    setPage,
    scrollRef,
    openPage,
    searchOpen,
    setSearchOpen,
    searchInputRef,
    showNotes,
    setShowNotes,
    busy,
    setBusy,
    dlPct,
    setDlPct,
    installLine,
    setInstallLine,
    msg,
    setMsg,
    ffmpeg,
    setFfmpeg,
    whisper,
    setWhisper,
    whisperModel,
    setWhisperModel,
    whisperLang,
    setWhisperLang,
    videoDevice,
    setVideoDevice,
    audioDevice,
    setAudioDevice,
    siriScreenAnswer,
    setSiriScreenAnswer,
    smallPanel,
    setSmallPanel,
    holdForSmart,
    setHoldForSmart,
    advancedMode,
    setAdvancedMode,
    webAccess,
    setWebAccess,
    codeOwnCopy,
    setCodeOwnCopy,
    backend,
    setBackend,
    backendRowRef,
    ollamaModel,
    setOllamaModel,
    mlxModel,
    setMlxModel,
    thinkingEnabled,
    setThinkingEnabled,
    localModels,
    setLocalModels,
    localModelsLoading,
    setLocalModelsLoading,
    setupState,
    setSetupState,
    setupBusy,
    setSetupBusy,
    setupRunning,
    setSetupRunning,
    setupError,
    setSetupError,
    cursorCompanion,
    setCursorCompanion,
    cursorStyle,
    setCursorStyle,
    maxRecMin,
    setMaxRecMin,
    soundEnabled,
    setSoundEnabled,
    captureHud,
    setCaptureHud,
    dynamicIsland,
    setDynamicIsland,
    selectionBar,
    setSelectionBar,
    liveCompanion,
    setLiveCompanion,
    liveActs,
    setLiveActs,
    dockIcon,
    setDockIcon,
    suggestions,
    setSuggestions,
    fnListenEnabled,
    setFnListenEnabled,
    clickEnabled,
    setClickEnabled,
    actHighlight,
    setActHighlight,
    voiceRoutingMode,
    setVoiceRoutingMode,
    voiceRoutingGoTo,
    setVoiceRoutingGoTo,
    voiceRoutingSkills,
    setVoiceRoutingSkills,
    voiceRoutingAgents,
    setVoiceRoutingAgents,
    feedbackEnabled,
    setFeedbackEnabled,
    listenAutoPaste,
    setListenAutoPaste,
    transcriptFormats,
    setTranscriptFormats,
    contextLog,
    setContextLog,
    agentPhotos,
    setAgentPhotos,
    decisionCards,
    setDecisionCards,
    runTranscript,
    setRunTranscript,
    showTiming,
    setShowTiming,
    historyEncryption,
    setHistoryEncryption,
    incognito,
    setIncognito,
    phoneRemoteEnabled,
    setPhoneRemoteEnabled,
    phoneRemoteSupported,
    setPhoneRemoteSupported,
    phoneRemoteStayAwake,
    setPhoneRemoteStayAwake,
    extendedScreenOn,
    setExtendedScreenOn,
    phoneRemoteClamshell,
    setPhoneRemoteClamshell,
    clamshellError,
    setClamshellError,
    phoneRemoteAwayMode,
    setPhoneRemoteAwayMode,
    awayModeError,
    setAwayModeError,
    phoneRemoteAwayHeld,
    setPhoneRemoteAwayHeld,
    coverBusy,
    setCoverBusy,
    phoneRemoteQr,
    setPhoneRemoteQr,
    phoneRemoteConnected,
    setPhoneRemoteConnected,
    phoneRemoteError,
    setPhoneRemoteError,
    agentRelay,
    setAgentRelay,
    relayPush,
    setRelayPush,
    agentRelayTestState,
    setAgentRelayTestState,
    mcpClients,
    setMcpClients,
    mcpClientError,
    setMcpClientError,
    showManualSnippet,
    setShowManualSnippet,
    tunnelEnabled,
    setTunnelEnabled,
    tunnelStatus,
    setTunnelStatus,
    tunnelQr,
    setTunnelQr,
    globalInstructions,
    setGlobalInstructions,
    isAdmin,
    setIsAdmin,
    viewAsUser,
    setViewAsUser,
    advancedMenu,
    simple,
    pageAvailable,
    shownPage,
    paged,
    collapse,
    showBucketHeader,
    account,
    setAccount,
    deleteArmed,
    setDeleteArmed,
    deleting,
    setDeleting,
    deleteError,
    setDeleteError,
    showDebug,
    setShowDebug,
    update,
    checking,
    setChecking,
    balanceCents,
    setBalanceCents,
    usage,
    setUsage,
    topupPending,
    setTopupPending,
    topupMsg,
    setTopupMsg,
    topupPollRef,
    creditsTab,
    setCreditsTab,
    subscription,
    setSubscription,
    lifetime,
    setLifetime,
    testing,
    setTesting,
    testResult,
    setTestResult,
    jumpToSection,
    focusSection,
    seedForm,
    apply,
    refresh,
    centreBackendCard,
    attachBackendRow,
    openSearch,
    closeSearch,
    openCheckout,
    openPortal,
    chooseBackend,
    chooseOllamaModel,
    chooseMlxModel,
    runLocalSetup,
    testBackend,
    checkForUpdates,
    toggleCursorCompanion,
    chooseCursorStyle,
    commitMaxRec,
    toggleThinking,
    toggleSound,
    toggleCaptureHud,
    toggleSuggestions,
    toggleDynamicIsland,
    toggleSelectionBar,
    toggleLiveCompanion,
    toggleLiveActs,
    toggleDockIcon,
    toggleFnListen,
    toggleClickEnabled,
    toggleActHighlight,
    grantAccessibility,
    pickVoiceRoutingMode,
    toggleVoiceRoutingGoTo,
    toggleVoiceRoutingSkills,
    toggleVoiceRoutingAgents,
    toggleStayAwake,
    clearExtendedScreen,
    toggleClamshell,
    toggleAwayMode,
    toggleSiriScreenAnswer,
    toggleTranscriptFormat,
    toggleAdvancedMode,
    toggleSmallPanel,
    toggleHoldForSmart,
    toggleCodeOwnCopy,
    toggleWebAccess,
    toggleCoverNow,
    toggleStayAwakeWithClamshell,
    togglePhoneRemote,
    toggleAgentRelay,
    toggleRelayPush,
    setRelayNotifyLevel,
    setRelayTurnEndPing,
    sendAgentRelayTest,
    setUpMcpClient,
    fetchPhoneRemoteQr,
    pairing,
    toggleTunnel,
    retryTunnel,
    toggleFeedback,
    toggleListenAutoPaste,
    toggleShowTiming,
    toggleAgentPhotos,
    toggleDecisionCards,
    toggleContextLog,
    toggleIncognito,
    saveGlobalInstructions,
    toggleInstructionsAppliesTo,
    onToggleInstructionsMode,
    instructionsSaveTimer,
    globalInstructionsRef,
    onInstructionsTextChange,
    toggleRunTranscript,
    toggleHistoryEncryption,
    clearHistory,
    save,
    saveLanguage,
    downloadModel,
    installWhisper,
    installFfmpeg,
    ffmpegBin,
    whisperBin,
    modelBin,
    parakeetBin,
    searchableKeys,
    anyResults,
    headerLinks,
    sidebarLinkCls,
    sidebarLinks,
    viewAsUserRow,
    onBack,
    chat
  }
}

export type SettingsCtx = NonNullable<ReturnType<typeof useSettingsState>>
