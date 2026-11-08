import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bell,
  Brush,
  Camera,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Hand,
  Loader2,
  MonitorPlay,
  Palette,
  Unplug,
  Vibrate,
  Wrench,
  X
} from 'lucide-react'
import type {
  InstallableSkin,
  PhoneRemoteColorScheme,
  PhoneRemoteHandedness,
  PhoneRemoteKeysPosition,
  PhoneRemoteDeckMode,
  PhoneRemoteSplitConcept,
  PhoneRemoteMirrorPlacement
} from '@shared/types'
import { SHIPPING_SPLIT_CONCEPTS, MIRROR_PLACEMENT_LABELS } from '@shared/types'
import { CONFIG, type SupabaseEnvName } from '@shared/config'
import type { HostCapabilities } from '@shared/phone-remote-protocol'
import type { HostDevice } from '@shared/phone-remote-keys'
import type { MirrorMode, MirrorQuality } from './mirror-quality'
import GestureLegend from './GestureLegend'
import SettingsSection from './SettingsSection'
import {
  getHapticsEnabled,
  setHapticsEnabled,
  getDragHapticsEnabled,
  setDragHapticsEnabled,
  hapticDragEngage,
  hapticTick
} from './haptics'
import { capabilities } from './host-capabilities'
import { getMicSource, setMicSource } from './mic-source'
import { getDebugLayoutEnabled, setDebugLayoutEnabled } from './debug-layout'
import { formatKbTrace } from './keyboard-trace'
import { copyText } from './clipboard'
import { PairDeviceForm } from './PairDeviceForm'
import {
  getVirtualKeyboardEnabled,
  setVirtualKeyboardEnabled
} from './virtual-keyboard-pref'
import { getLazyModeEnabled, setLazyModeEnabled } from './lazy-mode-pref'
import {
  setScreenShareLayout,
  useScreenShareLayout,
  type ScreenShareLayout
} from './screen-share-layout'
import { macLookLabel } from './MacLookView'
import {
  SKIN_OPTIONS,
  inlineSkinRow,
  isImageSkin,
  isLightPinnedSkin,
  refreshRemoteSkinStyles,
  type StoreSkinOption
} from './skins'
import SkinPreview from './SkinPreview'
import { Button } from '@shared/ui/Button'

/** Section ids, so an open-state entry can't be typo'd into a section that
 *  never opens. */
const SECTION = {
  screen: 'screen',
  trackpad: 'trackpad',
  camera: 'camera',
  display: 'display',
  haptics: 'haptics',
  alerts: 'alerts',
  troubleshooting: 'troubleshooting',
  connection: 'connection',
  environment: 'environment'
} as const
type SectionId = (typeof SECTION)[keyof typeof SECTION]

/** Open on FIRST EVER render: just the one you reach for most. Everything else
 *  starts collapsed so the sheet opens short enough to read at a glance. Only
 *  consulted when nothing has been stored yet -- after that, whatever you left
 *  open wins. */
const DEFAULT_OPEN_SECTIONS: readonly SectionId[] = [SECTION.screen]

// Which sections you left open survives a remount and a reload.
// This component is unmounted outright on a remount -- so plain useState reset
// every section to the defaults and looked like the settings themselves had
// been forgotten. They hadn't (theme/cursor round-trip to the Mac; the
// rest are their own localStorage keys); only the expansion state was lost.
//
// Phone-local, same reasoning as the haptics pref: how you like the sheet
// arranged is a property of the device in your hand, not config worth syncing
// to the Mac.
const OPEN_SECTIONS_PREF_KEY = 'mm-remote-settings-open-sections'

/** Only the finished concepts are offered — SHIPPING_SPLIT_CONCEPTS in
 *  types.ts, beside the full list, so the two can't drift apart unnoticed.
 *  fan/rails/pods still render (deck viewer, an existing pref); they just
 *  aren't choosable. */
const SPLIT_CONCEPT_LABELS = SHIPPING_SPLIT_CONCEPTS

const HUGE_CURSOR_SIZE = 3

const isShipping = (v: PhoneRemoteSplitConcept): boolean =>
  SHIPPING_SPLIT_CONCEPTS.some(([id]) => id === v)

/** inset/bleed are still valid prefs but are no longer offered — see
 *  MIRROR_PLACEMENT_LABELS in types.ts. */
const isOfferedPlacement = (v: PhoneRemoteMirrorPlacement): boolean =>
  MIRROR_PLACEMENT_LABELS.some(([id]) => id === v)

type Choices<T extends string> = readonly (readonly [T, string])[]

const STORE_CHOICE = 'store'

const MIRROR_MODE_CHOICES: Choices<MirrorMode> = [
  ['mirror', 'Same screen'],
  ['extended', 'Second screen']
]
const MIRROR_QUALITY_CHOICES: Choices<MirrorQuality> = [
  ['capped', 'Smoother'],
  ['native', 'Sharper']
]
const SCREEN_FIT_CHOICES: Choices<ScreenShareLayout> = [
  ['full', 'Full screen'],
  ['trackpad', 'With trackpad']
]
const THEME_CHOICES: Choices<PhoneRemoteColorScheme> = [
  ['light', 'Light'],
  ['dark', 'Dark']
]
const HANDEDNESS_CHOICES: Choices<PhoneRemoteHandedness> = [
  ['left', 'Left'],
  ['right', 'Right']
]
const KEYS_POSITION_CHOICES: Choices<PhoneRemoteKeysPosition> = [
  ['top', 'Top'],
  ['bottom', 'Bottom']
]
const DECK_MODE_CHOICES: Choices<PhoneRemoteDeckMode> = [
  ['stacked', 'One side'],
  ['split', 'Dual hand']
]

function readOpenSections(): ReadonlySet<SectionId> {
  try {
    const raw = localStorage.getItem(OPEN_SECTIONS_PREF_KEY)
    // Absence means "never touched" -> defaults. An empty ARRAY is different:
    // that's every section deliberately collapsed, and must be honored.
    if (raw === null) return new Set(DEFAULT_OPEN_SECTIONS)
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set(DEFAULT_OPEN_SECTIONS)
    // Filter against SECTION rather than trusting the stored strings: a
    // renamed or removed section id would otherwise sit in the set forever,
    // matching nothing.
    const known = new Set<string>(Object.values(SECTION))
    return new Set(parsed.filter((id): id is SectionId => typeof id === 'string' && known.has(id)))
  } catch {
    // Malformed JSON or storage disabled -- defaults are always safe here.
    return new Set(DEFAULT_OPEN_SECTIONS)
  }
}

function writeOpenSections(open: ReadonlySet<SectionId>): void {
  try {
    localStorage.setItem(OPEN_SECTIONS_PREF_KEY, JSON.stringify([...open]))
  } catch {
    // Private mode: the in-memory set still drives this session.
  }
}

// The slider owns its own value WHILE the finger is down, and only reports on
// release. A range input fires onChange per touchmove (~60/s); routing each one
// up to App meant a full re-render of the 4k-line root, a WS frame, a
// synchronous pref write on the Mac, and an echo back that rewrote this very
// `value` mid-drag -- so a late frame yanked the thumb backwards under the
// finger. Committing on pointerup makes the drag pure-local and the echo
// arrives when there's nothing left to fight.
function SensitivitySlider({
  sensitivity,
  onCommit
}: {
  sensitivity: { min: number; max: number; value: number }
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [live, setLive] = useState(sensitivity.value)
  const draggingRef = useRef(false)

  // Adopt outside changes (connect handshake, the Mac's own settings window)
  // only while the finger is off -- otherwise this is the echo fight again.
  useEffect(() => {
    if (!draggingRef.current) setLive(sensitivity.value)
  }, [sensitivity.value])

  const commit = (): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    onCommit(live)
  }

  return (
    <>
      <div className="row">
        <span className="label">Sensitivity</span>
        <span className="value">{live.toFixed(1)}x</span>
      </div>
      <input
        type="range"
        min={sensitivity.min}
        max={sensitivity.max}
        step={0.1}
        value={live}
        onChange={(e) => {
          draggingRef.current = true
          setLive(parseFloat(e.target.value))
        }}
        // pointerup alone misses a cancelled touch (a drag that leaves the
        // element, an incoming call); without pointercancel the ref stays true
        // and the slider ignores every later push from the Mac.
        onPointerUp={commit}
        onPointerCancel={commit}
        // Keyboard/assistive input never fires a pointer event, so arrow keys
        // would otherwise change the display and never reach the Mac.
        onKeyUp={commit}
      />
    </>
  )
}

/** What the Mac reports over the `env` WS event. `buildDefault` is what this
 *  build would resolve to with no override on disk -- kept separate from
 *  `current` so the row can say "off default" without the phone having to know
 *  how env resolution works. */
export type EnvSwitcherState = {
  isAdmin: boolean
  current: SupabaseEnvName
  buildDefault: SupabaseEnvName
}

export type SettingsBodyProps = {
  onOpenDraw: () => void
  sensitivity: { min: number; max: number; value: number }
  hostCaps: HostCapabilities | null
  onSensitivityChange: (value: number) => void
  cursorSize: number
  onCursorSizeChange: (size: number) => void
  cursorAnimated: boolean
  onCursorAnimatedChange: (animated: boolean) => void
  mirrorOn: boolean
  toggleMirror: (on: boolean) => void
  mirrorQuality: MirrorQuality
  onMirrorQualityChange: (quality: MirrorQuality) => void
  mirrorMode: MirrorMode
  onMirrorModeChange: (mode: MirrorMode) => void
  shareAudio: boolean
  onShareAudioChange: (value: boolean) => void
  /** A second screen is showing the Mac, so the ring's zoom track is live.
   *  Reaches only the gesture legend -- same flag that lights the track, so
   *  the list can never describe a control that isn't there. */
  glassesAttached?: boolean
  skin: InstallableSkin
  /** Display name for `skin` when it's a remote one, from the Mac's manifest.
   *  Undefined for a built-in (its label is compiled in) and for a remote skin
   *  that is no longer installed. */
  wornSkinLabel?: string
  onSkinChange: (value: InstallableSkin) => void
  colorScheme: PhoneRemoteColorScheme
  onColorSchemeChange: (value: PhoneRemoteColorScheme) => void
  handedness: PhoneRemoteHandedness
  onHandednessChange: (value: PhoneRemoteHandedness) => void
  keysPosition: PhoneRemoteKeysPosition
  onKeysPositionChange: (value: PhoneRemoteKeysPosition) => void
  deckMode: PhoneRemoteDeckMode
  onDeckModeChange: (value: PhoneRemoteDeckMode) => void
  splitConcept: PhoneRemoteSplitConcept
  onSplitConceptChange: (value: PhoneRemoteSplitConcept) => void
  mirrorPlacement: PhoneRemoteMirrorPlacement
  onMirrorPlacementChange: (value: PhoneRemoteMirrorPlacement) => void
  hostDevice: HostDevice | undefined
  // The keys-position and deck-mode controls are BOTH landscape-only: in
  // portrait the deck is always one cluster at the bottom, so either toggle
  // would be a control that does nothing.
  isLandscape: boolean
  showCursor: boolean
  onShowCursorChange: (value: boolean) => void
  appRing: boolean
  onAppRingChange: (value: boolean) => void
  onCenterCursor: () => void
  startChatGptVoiceWithMic: () => void
  cameraOn: boolean
  onCameraChange: (value: boolean) => void
  /** Shared with the Mac's Mighty window, unlike every other row here -- see
   *  the hint copy below, which says so out loud rather than surprising anyone. */
  renderMarkup: boolean
  onRenderMarkupChange: (value: boolean) => void
  /** Reconnect with the freshly-stored credential after a manual re-pair.
   *  Same callback the stranded guard passes to PairDeviceForm. */
  onPaired: () => void
  /** End this session on purpose. Keeps the pairing -- the parked screen's
   *  button reconnects with no code. */
  onDisconnect: () => void
  onOpenAlerts?: () => void
  /** null until the Mac answers `getEnv`, and on a non-admin session the Mac
   *  reports `isAdmin: false` -- either way the section doesn't render. The
   *  real gate is Mac-side in ipc/phone-remote.ts; this one only hides a row
   *  nobody else can usefully press. */
  env: EnvSwitcherState | null
  onEnvChange: (value: SupabaseEnvName) => void
  /** True while the settings sheet is on screen. Only `Escape` needs it -- the
   *  rows themselves render the same either way -- but the key is global, so
   *  without this a closed sheet would still swallow Back. */
  sheetOpen?: boolean
  /** Close the sheet. Called on `Escape` only once every section is collapsed:
   *  expanding a section is otherwise a one-way trip on a host whose only exits
   *  are swiping past every control inside it. */
  onRequestClose?: () => void
}

// The entire contents of the settings sheet, shared by Classic and Pro --
// both previously carried a byte-identical ~100-line copy of these rows plus
// a <LayoutSettings>, so a fix in one silently skipped the other.
//
// Rows are grouped into five collapsible sections rather than one flat list:
// 15 rows in a row is a scroll, not a menu. Sections toggle independently
// (not an accordion) -- Trackpad and Screen start open, the rest collapsed,
// which keeps the sheet short enough to sit centered in portrait.
export default function SettingsBody(props: SettingsBodyProps): React.JSX.Element {
  const {
    onOpenDraw,
    sensitivity,
    hostCaps,
    onSensitivityChange,
    cursorSize,
    onCursorSizeChange,
    cursorAnimated,
    onCursorAnimatedChange,
    mirrorOn,
    toggleMirror,
    mirrorQuality,
    onMirrorQualityChange,
    mirrorMode,
    onMirrorModeChange,
    shareAudio,
    onShareAudioChange,
    glassesAttached,
    skin,
    wornSkinLabel,
    onSkinChange,
    colorScheme,
    onColorSchemeChange,
    handedness,
    onHandednessChange,
    keysPosition,
    deckMode,
    onDeckModeChange,
    splitConcept,
    onSplitConceptChange,
    mirrorPlacement,
    onMirrorPlacementChange,
    hostDevice,
    onKeysPositionChange,
    isLandscape,
    showCursor,
    onShowCursorChange,
    appRing,
    onAppRingChange,
    onCenterCursor,
    cameraOn,
    onCameraChange,
    renderMarkup,
    onRenderMarkupChange,
    onPaired,
    onDisconnect,
    onOpenAlerts,
    env,
    onEnvChange,
    sheetOpen,
    onRequestClose
  } = props

  // Which env the confirm sheet is asking about, or null when it's closed.
  // A plain confirm step rather than a direct toggle: pressing this quits and
  // relaunches the Mac app, which is not something to do by brushing a row.
  const [envConfirm, setEnvConfirm] = useState<SupabaseEnvName | null>(null)

  // Collapsed by default: re-pairing is a recovery action, and an always-open
  // code field in Settings reads like something you're supposed to fill in.
  const [pairOpen, setPairOpen] = useState(false)

  // Same one-tap-to-arm guard as envConfirm above, for the same reason: the
  // undo lives on the Mac, so a mis-tap here can strand the phone.
  const [disconnectArmed, setDisconnectArmed] = useState(false)

  // A set, not a single id: sections open and close independently, so opening
  // Screen doesn't shut Trackpad while you're mid-adjustment. Seeded from
  // localStorage so a remount of this component doesn't
  // reset it -- see readOpenSections above.
  const [openSections, setOpenSections] = useState<ReadonlySet<SectionId>>(readOpenSections)
  const [micSource, setMicSourceState] = useState(getMicSource)
  const isOpen = (id: SectionId): boolean => openSections.has(id)
  // Written inside the updater rather than in an effect: the set is the only
  // thing being persisted and it's already computed here, so an effect would
  // just be a second place for the two to drift apart.
  const toggle = (id: SectionId) => (): void =>
    setOpenSections((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      writeOpenSections(next)
      return next
    })

  // A ref because both call sites pass an inline arrow -- as a dep, that fresh
  // identity would re-add the listener every render.
  const requestCloseRef = useRef(onRequestClose)
  requestCloseRef.current = onRequestClose

  // Escape (the band's thumb-middle pinch, labelled Back) collapses before it
  // closes: with sections shut a swipe walks 8 headers instead of ~60 controls,
  // so otherwise opening one is a one-way trip back through everything inside.
  useEffect(() => {
    if (!sheetOpen) return
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || e.altKey || e.ctrlKey || e.metaKey) return
      e.preventDefault()
      // Read through the updater rather than closing over `openSections` --
      // this effect must not re-subscribe on every section toggle.
      setOpenSections((cur) => {
        if (cur.size === 0) {
          requestCloseRef.current?.()
          return cur
        }
        const next: ReadonlySet<SectionId> = new Set()
        writeOpenSections(next)
        return next
      })
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [sheetOpen])

  // Phone-local prefs (localStorage via haptics.ts / debug-layout.ts), unlike
  // most rows here which round-trip through the Mac's PREFS -- whether haptics
  // feel right is a property of the phone in hand, so it stays on the device.
  const [haptics, setHaptics] = useState(getHapticsEnabled)
  const [dragHaptics, setDragHaptics] = useState(getDragHapticsEnabled)
  const [debugLayout, setDebugLayout] = useState(getDebugLayoutEnabled)
  const [kbCopied, setKbCopied] = useState<string | null>(null)
  // A plain seeded read: this switch is the pref's ONLY writer now, so nothing
  // can change it behind this sheet's back. It used to need a subscription
  // because the swap button on either keyboard wrote the same pref -- that is
  // exactly the coupling keyboard-state.ts removed.
  const [virtualKeyboard, setVirtualKeyboard] = useState(getVirtualKeyboardEnabled)
  // Single-writer, so a plain seeded read here -- but the DECK subscribes via
  // useLazyMode, because the button has to appear the moment this flips while
  // this sheet is still covering it.
  const [lazyMode, setLazyMode] = useState(getLazyModeEnabled)
  const screenShareLayout = useScreenShareLayout()
  const [storeOpen, setStoreOpen] = useState(false)
  // Skins that came from the catalog rather than the bundle. Empty until the
  // store is opened for the first time.
  const [remoteSkins, setRemoteSkins] = useState<StoreSkinOption[]>([])
  const [remoteState, setRemoteState] = useState<'idle' | 'loading' | 'done'>('idle')

  // THE fetch. Fires when the store opens, and only then -- not on connect, not
  // on an interval. The Mac does the actual outbound request (this hits its
  // local /_skins route), and doing it on connect would tell the catalog host a
  // MightyMouse device came online every single time one did. Opening the store
  // is a deliberate act, so it's the one moment a network read is expected.
  //
  // Refetches on each open rather than caching for the session: a skin added to
  // the catalog should appear on the next visit, and the Mac already caches
  // installs on disk, so a repeat open costs one small local request.
  useEffect(() => {
    if (!storeOpen) return
    let cancelled = false
    setRemoteState('loading')
    fetch(CONFIG.PHONE_REMOTE.REMOTE_SKIN_CATALOG_ROUTE)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { skins?: Array<Omit<StoreSkinOption, 'remote'>> }) => {
        if (cancelled) return
        setRemoteSkins((body.skins ?? []).map((s) => ({ ...s, remote: true })))
        setRemoteState('done')
        // This fetch is also what INSTALLS the skins it reports, and the page's
        // skin stylesheet was built before them. Without this the store can
        // offer a card whose selection paints nothing until a full app reload.
        refreshRemoteSkinStyles()
      })
      .catch(() => {
        // Offline, or the catalog is down. The store still shows every built-in
        // skin, so this is a missing section, never an error to dismiss.
        if (!cancelled) setRemoteState('done')
      })
    return () => {
      cancelled = true
    }
  }, [storeOpen])

  // Built-ins first, then remote. Built-ins are guaranteed present and instant;
  // putting a network-dependent section above them would make the store's top
  // shift as results land.
  const storeSkins: StoreSkinOption[] = [
    ...SKIN_OPTIONS.map((o) => ({
      ...o,
      remote: false,
      lightOnly: isLightPinnedSkin(o.id),
      imageSkin: isImageSkin(o.id)
    })),
    ...remoteSkins
  ]
  const remoteLightOnly = new Set(remoteSkins.filter((s) => s.lightOnly).map((s) => s.id))

  // The promoted skin plus, when it isn't already there, the one being worn.
  // See inlineSkinRow -- the worn half is load-bearing and has its own test.
  const inlineSkinOptions = inlineSkinRow(skin, wornSkinLabel)

  return (
    <div className="settingsSections">
      <Button variant="bare" type="button" className="settingsDrawBtn" onClick={onOpenDraw}>
        <Brush size={18} aria-hidden="true" />
        <span className="settingsDrawText">
          <span className="settingsDrawTitle">Draw on your Mac</span>
          <span className="settingsDrawSub">Mark up your screen or a blank page, then send it</span>
        </span>
        <ChevronRight size={18} aria-hidden="true" />
      </Button>
      <SettingsSection
        title="Screen"
        icon={MonitorPlay}
        open={isOpen(SECTION.screen)}
        onToggle={toggle(SECTION.screen)}
      >
        {hostCaps?.virtualDisplay !== false && (
          <div className="row">
            <span className="label">Show my Mac screen</span>
            <label className="mirrorToggle">
              <input
                type="checkbox"
                checked={mirrorOn}
                onChange={(e) => toggleMirror(e.target.checked)}
              />
              <span className="mirrorToggleTrack" />
            </label>
          </div>
        )}
        <div className="settingHint">
          {mirrorMode === 'extended'
            ? "Give your Mac a second screen. Your monitor keeps showing your own work, and the screen stays after you disconnect."
            : "Watch your Mac's screen live on this phone."}
        </div>
        {mirrorOn && (
          <SettingChoice
            label="Show"
            value={mirrorMode}
            options={MIRROR_MODE_CHOICES}
            onChange={onMirrorModeChange}
          />
        )}
        {mirrorOn && (
          <SettingChoice
            label="Video"
            value={mirrorQuality}
            options={MIRROR_QUALITY_CHOICES}
            onChange={onMirrorQualityChange}
          />
        )}
        {/* Audio rides the mirror's own peer connection, so it can't do
            anything with the mirror off -- shown only alongside it, same
            rule as Quality above. */}
        {mirrorOn && (
          <>
            <div className="row">
              <span className="label">Computer audio</span>
              <label className="mirrorToggle">
                <input
                  type="checkbox"
                  checked={shareAudio}
                  onChange={(e) => onShareAudioChange(e.target.checked)}
                />
                <span className="mirrorToggleTrack" />
              </label>
            </div>
            <div className="settingHint">
              Hear your Mac through this phone. Your Mac keeps playing out loud too.{' '}
              {capabilities.backgroundAudio
                ? 'Keeps playing with your screen off.'
                : 'Stops when you leave this page.'}
            </div>
          </>
        )}
        {hostCaps?.virtualDisplay !== false && (
          <>
            <SettingChoice
              label="How it fits"
              value={screenShareLayout}
              options={
                env?.isAdmin
                  ? [...SCREEN_FIT_CHOICES, ['mac', macLookLabel(hostDevice)]]
                  : SCREEN_FIT_CHOICES
              }
              onChange={(value) => {
                setScreenShareLayout(value)
                if (value === 'mac' && !mirrorOn) toggleMirror(true)
              }}
            />
            <div className="settingHint">
              {screenShareLayout === 'mac'
                ? `Your phone becomes your ${hostDevice?.name ?? 'Mac'} - the screen on top, its keyboard and trackpad below.`
                : 'Full screen gives your Mac’s screen the whole phone. With trackpad keeps the trackpad and keys next to it.'}
            </div>
          </>
        )}
        {/* Portrait-only: landscape already puts the screen beside the pad
            rather than above it. */}
        {mirrorOn && !isLandscape && screenShareLayout === 'trackpad' && (
          <>
            <SettingChoice
              label="Screen position"
              // Shows the first option for a retired pref without rewriting it on open.
              value={
                isOfferedPlacement(mirrorPlacement) ? mirrorPlacement : MIRROR_PLACEMENT_LABELS[0][0]
              }
              options={MIRROR_PLACEMENT_LABELS}
              onChange={onMirrorPlacementChange}
            />
            <div className="settingHint">
              Where your Mac&rsquo;s screen sits. Above keeps it over the trackpad; under glass
              puts it inside, beneath the surface.
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Trackpad"
        icon={Hand}
        open={isOpen(SECTION.trackpad)}
        onToggle={toggle(SECTION.trackpad)}
      >
        <SensitivitySlider sensitivity={sensitivity} onCommit={onSensitivityChange} />
        <div className="row">
          <span className="label">Show cursor</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={showCursor}
              onChange={(e) => onShowCursorChange(e.target.checked)}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="settingHint">See the Mac pointer on the touchpad as it moves.</div>
        <div className="row">
          <span className="label">App ring</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={appRing}
              onChange={(e) => onAppRingChange(e.target.checked)}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="settingHint">
          Slide around the buttons to flip between your open apps.
        </div>
        {/* Rescue for a lost cursor -- dragged onto a display that's gone,
            buried under a fullscreen app, or just not findable by eye.
            Relative deltas can't fix that, so this is the one absolute move
            the phone can ask for. Centers on the cursor's current display. */}
        <div className="row">
          <span className="label">Find cursor</span>
          <Button variant="bare" className="qualityBtn" onClick={onCenterCursor}>
            Center
          </Button>
        </div>
        <div className="settingHint">Jumps the cursor to the middle of the screen.</div>
        <div className="row">
          <span className="label">Huge cursor</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={cursorSize > 1}
              onChange={(e) => onCursorSizeChange(e.target.checked ? HUGE_CURSOR_SIZE : 1)}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="row">
          <span className="label">Animated cursor</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={cursorAnimated}
              onChange={(e) => onCursorAnimatedChange(e.target.checked)}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="settingHint">Makes the pointer on your Mac easy to spot.</div>
        {/* Which tap of the Keyboard pill you get -- iOS's own native keyboard
            (default, free autocorrect/emoji) or the on-screen QWERTY this phone
            draws itself. Phone-local, same reasoning as haptics/debug layout
            below: which typing UI you prefer lives with the phone, not the Mac. */}
        <div className="row">
          <span className="label">On-screen keyboard</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={virtualKeyboard}
              onChange={(e) => {
                const on = e.target.checked
                setVirtualKeyboard(on)
                setVirtualKeyboardEnabled(on)
              }}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="settingHint">
          Show a keyboard you tap on the phone instead of opening your iPhone's own.
        </div>
        {/* For the phone sitting face-up beside the Mac: the icon row's mic is
            60px and has to be found by looking, which is the wrong ask for a
            phone you are not holding. Additive -- the cursor, taps and
            scrolling all still work underneath. */}
        <div className="row">
          <span className="label">Big record button</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={lazyMode}
              onChange={(e) => {
                const on = e.target.checked
                setLazyMode(on)
                setLazyModeEnabled(on)
              }}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="settingHint">
          Puts a big red mic in the middle of the touchpad, for when your phone is sitting
          on the desk. Tap it to talk, tap again to send.
        </div>
        <GestureLegend glassesAttached={glassesAttached} />
      </SettingsSection>

      {/* Its own section, not a row under Screen sharing: this is the PHONE's
          camera, phone-local (plain getUserMedia + localStorage, never synced
          over the WS), while every other row in that section is about pushing
          the MAC's screen down here. Two different subjects. */}
      <SettingsSection
        title="Camera"
        icon={Camera}
        open={isOpen(SECTION.camera)}
        onToggle={toggle(SECTION.camera)}
      >
        <div className="row">
          <span className="label">Camera</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={cameraOn}
              onChange={(e) => onCameraChange(e.target.checked)}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="settingHint">
          A small selfie preview floats on screen. Drag to move, pinch to resize, double-tap
          to flip. Tap the shape button to switch between landscape, portrait, and circle.
        </div>
        {/* Admin-only, same reasoning as Environment below: the glasses are an
            experiment, and the Mac repeats the check on anything it acts on. */}
        {env?.isAdmin && capabilities.shell === 'native' && hostCaps?.phoneMic !== false ? (
          <>
            <div className="row">
              <span className="label">Voice from</span>
              <div className="mirrorQualityChoice">
                {(['phone', 'glasses'] as const).map((value) => (
                  <Button
                    variant="bare"
                    key={value}
                    className={`qualityBtn${micSource === value ? ' active' : ''}`}
                    onClick={() => {
                      if (value === micSource) return
                      hapticTick()
                      setMicSource(value)
                      setMicSourceState(value)
                    }}
                  >
                    {value === 'glasses' ? 'Glasses' : 'Phone'}
                  </Button>
                ))}
              </div>
            </div>
            <div className="settingHint">
              Talk through your Ray-Ban glasses instead of your phone. Put them on first - if
              they aren&apos;t connected, your phone records instead and tells you.
            </div>
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Display"
        icon={Palette}
        open={isOpen(SECTION.display)}
        onToggle={toggle(SECTION.display)}
      >
        {/* Only the promoted skin sits inline; the rest live behind Store.
            That keeps this row a fixed width as skins are added — the old
            all-in-a-row picker was already at four buttons and would have
            wrapped into an unreadable grid by the sixth.

            The row still renders the CURRENT skin even when it came from the
            store, so Settings never shows a stale "Pro II" while the deck is
            wearing something else. */}
        <SettingChoice<InstallableSkin | typeof STORE_CHOICE>
          label="Skin"
          value={skin}
          options={[
            ...inlineSkinOptions.map((o) => [o.id, o.label] as const),
            [STORE_CHOICE, 'More skins…']
          ]}
          onChange={(value) => (value === STORE_CHOICE ? setStoreOpen(true) : onSkinChange(value))}
        />
          {/* Skins pin their theme (no dark variant yet), so the light/dark
              row only applies to the plain skin. One source for that set,
              shared with the root that does the pinning — otherwise this row
              reappears for a skin whose choice does nothing. Handedness/keys
              apply to every skin, so they stay outside this guard. */}
          {!isLightPinnedSkin(skin, remoteLightOnly) && (
            <SettingChoice
              label="Theme"
              value={colorScheme}
              options={THEME_CHOICES}
              onChange={onColorSchemeChange}
            />
          )}
          <SettingChoice
            label="Handedness"
            value={handedness}
            options={HANDEDNESS_CHOICES}
            onChange={onHandednessChange}
          />
          {isLandscape && (
            <SettingChoice
              label="Keys"
              value={keysPosition}
              options={KEYS_POSITION_CHOICES}
              onChange={onKeysPositionChange}
            />
          )}
          {isLandscape && (
            <SettingChoice
              label="Deck"
              value={deckMode}
              options={DECK_MODE_CHOICES}
              onChange={onDeckModeChange}
            />
          )}
          {isLandscape && deckMode === 'split' && (
            <SettingChoice
              label="Split style"
              // Shows the first option for a retired pref without rewriting it on open.
              value={isShipping(splitConcept) ? splitConcept : SPLIT_CONCEPT_LABELS[0][0]}
              options={SPLIT_CONCEPT_LABELS}
              onChange={onSplitConceptChange}
            />
          )}
        <div className="row">
          <span className="label">Render markdown</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={renderMarkup}
              onChange={(e) => onRenderMarkupChange(e.target.checked)}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="settingHint">
          Format code blocks, lists and bold in chat replies. Shared with your Mac.
        </div>
      </SettingsSection>

      <SettingsSection
        title="Haptics"
        icon={Vibrate}
        open={isOpen(SECTION.haptics)}
        onToggle={toggle(SECTION.haptics)}
      >
        {/* "Haptic feedback" would just restate the section title above it. */}
        <div className="row">
          <span className="label">Vibrate on touch</span>
          <label className="mirrorToggle">
            <input
              type="checkbox"
              checked={haptics}
              onChange={(e) => {
                const on = e.target.checked
                setHaptics(on)
                setHapticsEnabled(on)
                // Turning it ON answers itself with a tick -- instant proof
                // the phone supports it, no hunting for a gesture to test with.
                if (on) hapticTick()
              }}
            />
            <span className="mirrorToggleTrack" />
          </label>
        </div>
        <div className="settingHint">
          A tiny tick on taps, button presses, and recording start/stop.
        </div>

        {/* Only offered where the host can actually fire mid-drag. In Safari
            and the PWA, touchmove gets no user-activation window, so a toggle
            here would promise a sensation the browser cannot produce — see
            hapticDragDetent. `continuousHaptics` is the capability, never a
            user-agent string. Nested under the master switch because it is a
            second, much denser sensation, not a rename of the first. */}
        {capabilities.continuousHaptics && (
          <>
            <div className="row">
              <span className="label">Vibrate on drag</span>
              <label className="mirrorToggle">
                <input
                  type="checkbox"
                  checked={haptics && dragHaptics}
                  // Meaningless while the master switch is off, and a control
                  // that silently does nothing is worse than one that shows it
                  // has a prerequisite.
                  disabled={!haptics}
                  onChange={(e) => {
                    const on = e.target.checked
                    setDragHaptics(on)
                    setDragHapticsEnabled(on)
                    // Answer with the engage tick -- the same sensation this
                    // switch governs, so turning it on demonstrates itself.
                    if (on) hapticDragEngage()
                  }}
                />
                <span className="mirrorToggleTrack" />
              </label>
            </div>
            <div className="settingHint">
              Steady ticks as you move the cursor, like a real trackpad.
            </div>
          </>
        )}
      </SettingsSection>

      {onOpenAlerts && (
        <SettingsSection
          title="Alerts"
          icon={Bell}
          open={isOpen(SECTION.alerts)}
          onToggle={toggle(SECTION.alerts)}
        >
          <div className="row">
            <span className="label">Alerts on this phone</span>
            <Button variant="bare" className="qualityBtn" onClick={onOpenAlerts}>
              Open
            </Button>
          </div>
          <div className="settingHint">Choose what your phone tells you about.</div>
        </SettingsSection>
      )}

      <SettingsSection
        title="Troubleshooting"
        icon={Wrench}
        open={isOpen(SECTION.troubleshooting)}
        onToggle={toggle(SECTION.troubleshooting)}
      >
        {/* Added to Home Screen, the page runs standalone: no address bar, no
            pull-to-refresh, so there is no built-in way to pick up a new build
            short of force-quitting from the app switcher. There's no service
            worker caching anything, so a plain reload always fetches fresh. */}
        {/* The stranded guard offers this same form, but only once the socket
            is already dead. Reachable here too so a connection that's merely
            misbehaving -- or a device you want to re-enroll deliberately --
            has a way in that doesn't require getting stranded first. */}
        <div className="row">
          <span className="label">Connect again</span>
          <Button variant="bare" className="qualityBtn" onClick={() => setPairOpen((v) => !v)}>
            {pairOpen ? 'Cancel' : 'Connect'}
          </Button>
        </div>
        {pairOpen ? (
          <PairDeviceForm
            onPaired={() => {
              setPairOpen(false)
              onPaired()
            }}
          />
        ) : (
          <div className="settingHint">
            Enter the code shown in MightyMouse on your Mac.
          </div>
        )}
        <div className="row">
          <span className="label">Reload remote</span>
          <Button variant="bare" className="qualityBtn" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
        <div className="settingHint">Pulls the latest version from your Mac.</div>
        {env?.isAdmin && (
          <>
            {/* Applies instantly, no reload -- the CSS keys off a data attribute
                on <html> that this flips directly. */}
            <div className="row">
              <span className="label">Debug layout colors</span>
              <label className="mirrorToggle">
                <input
                  type="checkbox"
                  checked={debugLayout}
                  onChange={(e) => {
                    const on = e.target.checked
                    setDebugLayout(on)
                    setDebugLayoutEnabled(on)
                  }}
                />
                <span className="mirrorToggleTrack" />
              </label>
            </div>
            <div className="settingHint">
              Tints each layer: orange page, magenta root, lime card, cyan touchpad.
            </div>
            {/* Deliberately NOT behind the debug-layout toggle. The keyboard bugs
                this answers are reported by people who have not turned anything on,
                and the tint is visually destructive -- asking someone to wreck the
                colors just to send a log means the log does not get sent. The
                status-line copy stays where it is; this is the same trace reachable
                without the tint. */}
            <div className="row">
              <span className="label">Copy keyboard log</span>
              <Button
                variant="bare"
                className="qualityBtn"
                onClick={() => {
                  // Synchronous inside the tap: iOS only honours a clipboard write
                  // in the gesture's own call stack.
                  setKbCopied(copyText(formatKbTrace()) ? 'Copied' : 'Failed')
                  window.setTimeout(() => setKbCopied(null), 1500)
                }}
              >
                {kbCopied ?? 'Copy'}
              </Button>
            </div>
            <div className="settingHint">
              What the keyboard did in the last few seconds. Paste it into a bug report.
            </div>
          </>
        )}
      </SettingsSection>

      {/* Admin-only, and last: it's the one row here that quits the Mac app.
          Rendered at all only when the Mac says this session is a real admin --
          but that check is repeated Mac-side when `setEnv` arrives, because a
          phone is on the far end of a WS the tunnel makes internet-reachable
          and nothing it claims about itself is load-bearing. */}
      {env?.isAdmin ? (
        <SettingsSection
          title="Environment"
          icon={FlaskConical}
          open={isOpen(SECTION.environment)}
          onToggle={toggle(SECTION.environment)}
        >
          <div className="row">
            <span className="label">
              Backend
              {env.current !== env.buildDefault ? (
                <span className="envOffDefault">off default</span>
              ) : null}
            </span>
            <div className="mirrorQualityChoice">
              {(['staging', 'prod'] as const).map((value) => (
                <Button
                  variant="bare"
                  key={value}
                  className={`qualityBtn${env.current === value ? ' active' : ''}`}
                  onClick={() => {
                    if (value === env.current) return
                    hapticTick()
                    setEnvConfirm(value)
                  }}
                >
                  {value === 'prod' ? 'Prod' : 'Staging'}
                </Button>
              ))}
            </div>
          </div>
          {envConfirm ? (
            <div className="settingHint envConfirm">
              <p>
                Switching to {envConfirm === 'prod' ? 'prod' : 'staging'} quits and reopens
                MightyMouse on your Mac. Takes about 15 seconds. This remote reconnects on its
                own -- no QR.
              </p>
              <p>
                Each backend keeps its own account, history, and settings, so you&apos;ll be
                signed out over there until you sign in once.
              </p>
              <div className="envConfirmActions">
                <Button variant="bare" className="qualityBtn" onClick={() => setEnvConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  variant="bare"
                  className="qualityBtn active"
                  onClick={() => {
                    const target = envConfirm
                    setEnvConfirm(null)
                    onEnvChange(target)
                  }}
                >
                  Switch &amp; restart
                </Button>
              </div>
            </div>
          ) : (
            <div className="settingHint">
              Which Supabase project the Mac app talks to. Staging is safe to break.
            </div>
          )}
        </SettingsSection>
      ) : null}

      {/* Last section, and collapsed on a first run (it is not in
          DEFAULT_OPEN_SECTIONS) -- unpairing is not something to leave one
          stray tap from the skin picker. The lid is the point here, unlike the
          rows above it. */}
      <SettingsSection
        title="Connection"
        icon={Unplug}
        open={isOpen(SECTION.connection)}
        // Closing disarms: an armed button left behind a lid would fire on the
        // first tap next time, which is the mis-tap the arming exists to stop.
        onToggle={() => {
          setDisconnectArmed(false)
          toggle(SECTION.connection)()
        }}
      >
        <div className="row">
          <span className="label">Disconnect</span>
          <Button
            variant="bare"
            className={`qualityBtn${disconnectArmed ? ' active' : ''}`}
            onClick={() => {
              hapticTick()
              // Two taps, because this can't be undone from the phone -- the
              // code it asks for afterwards is on the Mac, which may not be in
              // the room.
              if (!disconnectArmed) {
                setDisconnectArmed(true)
                return
              }
              onDisconnect()
            }}
          >
            {disconnectArmed ? 'Tap to confirm' : 'Disconnect'}
          </Button>
        </div>
        <div className="settingHint">
          Disconnects this phone and frees your Mac. To use it again you&apos;ll need the
          code shown in MightyMouse on your Mac.
        </div>

        {/* Deliberately NOT a delete button. This phone is paired to whoever's
            Mac it connected to, and the account behind that Mac may not be the
            person holding the phone -- a tap here could wipe someone else's
            account. Pointing at the Mac keeps deletion where the account owner
            is already signed in. App Review (Guideline 5.1.1) asks that the
            path be findable, not that it fire from here. */}
        <div className="row">
          <span className="label">Delete your account</span>
          <span className="value">On your Mac</span>
        </div>
        <div className="settingHint">
          Open MightyMouse on your Mac and go to Settings, then Account, to delete your
          account and everything in it. We do it there so nobody can delete an account
          from a phone that isn&apos;t theirs.
        </div>
      </SettingsSection>

      {/* Skin store. A sheet rather than an inline expander because it sits
          INSIDE the settings sheet, which already scrolls -- growing a nested
          list would push the rows below it out of reach on a phone.

          Modelled on ReferralSheet: same scrim + same centered-sheet geometry,
          so there's one visual language for "a panel over the settings" rather
          than two. Rendered here and not at App level because the store is a
          detail of the skin row and has no other entry point; hoisting it would
          mean threading open-state through two layouts for no gain.

          Picking a skin closes the store. The whole point is seeing the deck
          repaint, and the sheet covers it. */}
      {/* PORTALLED TO document.body, and that is load-bearing rather than
          tidiness. .settingsPanel sets `transform: translate(-50%, -50%)` to
          centre itself, and a transformed element becomes the containing block
          for every position:fixed DESCENDANT. Rendered inline, the store was
          therefore positioned against the settings panel instead of the
          viewport: it inherited that panel's min(460px) box and got clipped by
          its overflow-y:auto -- visible in landscape as a store the same width
          as the settings sheet with the cards cut off at its edge, settings
          rows showing through around them.
          The scrim goes with it for the same reason: `inset: 0` against a
          transformed ancestor covers only that ancestor, not the screen.
          No CSS can undo this from inside -- escaping the subtree is the fix. */}
      {createPortal(
        <>
          {storeOpen && <div className="historyScrim" onClick={() => setStoreOpen(false)} />}
          <div
            className={`skinStore${storeOpen ? ' open' : ''}`}
            role="dialog"
            aria-label="Skin store"
          >
            <div className="historyHeader">
              <Palette size={17} strokeWidth={2.25} />
              <span className="historyTitle">Skin store</span>
              {/* Explicit way out, alongside the scrim tap. Tapping the scrim is
                  a shortcut you have to already know; now that the sheet is
                  nearly full-bleed there's barely any scrim left to aim at, so
                  the only discoverable exit has to live in the sheet itself. */}
              <Button
                variant="icon"
                className="skinStoreClose"
                aria-label="Close skin store"
                onClick={() => {
                  hapticTick()
                  setStoreOpen(false)
                }}
              >
                <X size={17} strokeWidth={2.5} />
              </Button>
            </div>
            {/* Every skin, including the one promoted inline. With text rows the
                promoted skin was redundant here; with preview cards its absence
                reads as a missing card -- the store is now the place you SEE the
                range, so a deck you can't see is a hole in it. The current skin
                is still selectable (a no-op tap that closes the sheet), which is
                the same thing tapping the active inline button does. */}
            <div className="skinStoreList">
              {storeSkins.map((option) => (
                <Button
                  variant="bare"
                  key={option.id}
                  className={`skinStoreItem${skin === option.id ? ' active' : ''}`}
                  onClick={() => {
                    hapticTick()
                    onSkinChange(option.id)
                    setStoreOpen(false)
                  }}
                >
                  <SkinPreview
                    skin={option.id}
                    isLandscape={isLandscape}
                    imageSkin={option.imageSkin}
                  />
                  {/* Name only, no pitch line. Describing a skin in words
                      ("olive drab deck, sand keycaps") asks the reader to render
                      the thing in their head -- which is the job the card above
                      already did, better. The name is here to be said out loud,
                      not to sell. */}
                  <span className="skinStoreMeta">
                    <span className="skinStoreNameRow">
                      <span className="skinStoreName">{option.label}</span>
                      {skin === option.id && (
                        <span className="skinStoreCurrent">Wearing</span>
                      )}
                    </span>
                  </span>
                </Button>
              ))}
              {/* Only while the first fetch is in flight, and only ever below
                  the built-ins -- the store must never look empty or shift its
                  top row while the network answers. */}
              {remoteState === 'loading' && (
                <span className="skinStoreNote">
                  <Loader2 size={15} strokeWidth={2.5} className="chatMicSpin" />
                  Checking for new skins…
                </span>
              )}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

function SettingChoice<T extends string>(props: {
  label: string
  value: T
  options: Choices<T>
  onChange: (value: T) => void
}): React.JSX.Element {
  const current = props.options.find(([id]) => id === props.value)
  return (
    <div className="row">
      <span className="label">{props.label}</span>
      <label className="settingChoice">
        <span className="settingChoiceText">{current?.[1] ?? 'Choose'}</span>
        <ChevronDown size={14} strokeWidth={2.5} aria-hidden="true" />
        <select
          className="settingChoiceSel"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value as T)}
          aria-label={props.label}
        >
          {!current && <option value={props.value} disabled hidden />}
          {props.options.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
