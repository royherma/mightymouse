import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import PanelApp from './PanelApp'
import HudApp from './HudApp'
import VoiceRouteApp from './VoiceRouteApp'
import IslandApp from './IslandApp'
import CompanionApp from './CompanionApp'
import HandsFreeHostApp from './HandsFreeHostApp'
import CursorApp from './CursorApp'
import AgentCursorApp from './AgentCursorApp'
import ComputerUseStatusApp from './ComputerUseStatusApp'
import HighlightApp from './HighlightApp'
import InkApp from './InkApp'
import SelectionBarApp from './SelectionBarApp'
import SkillEditorApp from './SkillEditorApp'
import TranscriptApp from './TranscriptApp'
import DeckApp from './DeckApp'
import CanvasApp from './CanvasApp'
import PhoneRemoteQrApp from './PhoneRemoteQrApp'
import CheatSheetApp from './CheatSheetApp'
import NavigatorApp from './NavigatorApp'
import SoundApp from './SoundApp'
import PlaygroundApp from './PlaygroundApp'
import AnalyticsApp from './AnalyticsApp'
import ResourcesApp from './ResourcesApp'
import ActionsApp from './ActionsApp'
import MediaLibraryApp from './MediaLibraryApp'
import MightyApp from './MightyApp'
import BillingApp from './BillingApp'
import UpgradeApp from './UpgradeApp'
import AuthApp from './AuthApp'
import BugReportApp from './BugReportApp'
import SpecialistApp from './SpecialistApp'
import { ReplyWindowApp } from './ReplyApp'
import OnboardingOneScreen from './OnboardingOneScreen'
import FirstRunApp from './FirstRunApp'
import DragCoachApp from './DragCoachApp'
import SetupCheckApp from './SetupCheckApp'
import TourApp from './TourApp'
import WebrtcCaptureApp from './WebrtcCaptureApp'
import { TOUR } from '../../shared/tour/constants'
import { installDevErrorOverlay } from './devErrorOverlay'
import { injectTheme } from './theme'
import { installRendererCrashHook } from './crash-hook'
import { WindowBoundary } from './WindowBoundary'
import { IS_DEV } from '../../shared/env'

// Dev-only render-error overlay: a blank window is a thrown error visible only in
// DevTools (never the dev-server stdout). In dev, paint the error + stack into the
// page so the cause is obvious at a glance. Pairs with `npm run dev:console`.
// Gated on IS_DEV so a prod build never replaces real UI with an error dump.
if (IS_DEV) {
  const paint = (label: string, msg: string, stack: string): void => {
    const el = document.getElementById('root') || document.body
    if (el)
      el.innerHTML = `<pre style="color:#fff;padding:16px;font-size:11px;white-space:pre-wrap">${label}:\n${msg}\n\n${stack}</pre>`
  }
  // A stack rooted in chrome-extension:// belongs to one of the user's browser
  // extensions, not to us. Electron loads none, so this only ever fires when a
  // harness is opened in a real Chrome — where MetaMask injects into localhost,
  // fails to reach its worker, and rejects. Blanking the window for someone
  // else's extension makes our own page look broken.
  const isExtension = (stack: string): boolean => stack.includes('chrome-extension://')

  window.addEventListener('error', (e) => {
    // Chrome fires this as an error event when observer work moves layout in
    // the same cycle; it is a benign warning, not a failure — wiping the DOM
    // for it blanks a perfectly healthy window.
    if (e.message?.startsWith('ResizeObserver loop')) return
    const stack = e.error?.stack || ''
    if (isExtension(stack) || e.filename?.startsWith('chrome-extension://')) return
    paint('RENDER ERROR', e.message, stack)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const stack = (e.reason && e.reason.stack) || ''
    if (isExtension(stack)) return
    paint('PROMISE REJECTION', (e.reason && e.reason.message) || String(e.reason), stack)
  })
}

// Inject design variables
injectTheme()

// Simple router based on query parameters
const params = new URLSearchParams(window.location.search)
const windowType = params.get('window') || 'panel'

// Ship renderer crashes (React throws, unhandled rejections) to public.errors,
// tagged with which window threw. Dev drops the row main-side but still logs.
installRendererCrashHook(windowType)

// Settings + cheat sheet are scrollable windows; opt them out of the global
// overflow:hidden (reuses the .settings-window CSS class).
if (
  windowType === 'cheatsheet' ||
  windowType === 'playground' ||
  windowType === 'analytics' ||
  windowType === 'resources' ||
  windowType === 'actions' ||
  windowType === 'media' ||
  windowType === 'mighty' ||
  windowType === 'billing' ||
  windowType === 'auth' ||
  windowType === 'onboarding1' ||
  windowType === 'first-run' ||
  windowType === 'setup' ||
  windowType === 'phone-remote-qr' ||
  windowType === 'bug' ||
  windowType === 'specialist' ||
  windowType === TOUR.WINDOW
) {
  document.documentElement.classList.add('settings-window')
  document.body.classList.add('settings-window')
}

// The panel sizes its BrowserWindow to content height (see ResizeObserver in
// PanelApp). Let html/body grow with content so scrollHeight reflects the real size.
if (windowType === 'panel') {
  document.documentElement.classList.add('panel-window')
  document.body.classList.add('panel-window')
}

const rootElement = document.getElementById('root')!

// Dev-only: replaces Vite's always-on-top error wall with a dismissible toast.
// Installed before render so a compile error in ANY app below is still catchable.
installDevErrorOverlay()

createRoot(rootElement).render(
  <StrictMode>
    <WindowBoundary route={windowType}>
      {windowType === 'hud' ? (
        <HudApp />
      ) : windowType === 'voice-route' ? (
        <VoiceRouteApp />
      ) : windowType === 'island' ? (
        <IslandApp />
      ) : windowType === 'companion' ? (
        <CompanionApp />
      ) : windowType === 'handsfree' ? (
        <HandsFreeHostApp />
      ) : windowType === 'cursor' ? (
        <CursorApp />
      ) : windowType === 'agent-cursor' ? (
        <AgentCursorApp />
      ) : windowType === 'computer-use-status' ? (
        <ComputerUseStatusApp />
      ) : windowType === 'selection-bar' ? (
        <SelectionBarApp />
      ) : windowType === 'highlight' ? (
        <HighlightApp />
      ) : windowType === 'ink' ? (
        <InkApp />
      ) : windowType === 'deck' ? (
        <DeckApp />
      ) : windowType === 'canvas' ? (
        <CanvasApp />
      ) : windowType === 'skill-editor' ? (
        <SkillEditorApp />
      ) : windowType === 'transcript' ? (
        <TranscriptApp />
      ) : windowType === 'phone-remote-qr' ? (
        <PhoneRemoteQrApp />
      ) : windowType === 'navigator' ? (
        <NavigatorApp />
      ) : windowType === 'cheatsheet' ? (
        <CheatSheetApp />
      ) : windowType === 'sound' ? (
        <SoundApp />
      ) : windowType === 'playground' ? (
        <PlaygroundApp />
      ) : windowType === 'analytics' ? (
        <AnalyticsApp />
      ) : windowType === 'resources' ? (
        <ResourcesApp />
      ) : windowType === 'actions' ? (
        <ActionsApp />
      ) : windowType === 'media' ? (
        <MediaLibraryApp />
      ) : windowType === 'mighty' ? (
        <MightyApp />
      ) : windowType === 'billing' ? (
        <BillingApp />
      ) : windowType === 'upgrade' ? (
        <UpgradeApp />
      ) : windowType === 'auth' ? (
        <AuthApp />
      ) : windowType === 'bug' ? (
        <BugReportApp />
      ) : windowType === 'specialist' ? (
        <SpecialistApp />
      ) : windowType === 'reply' ? (
        <ReplyWindowApp />
      ) : windowType === 'onboarding1' ? (
        <OnboardingOneScreen />
      ) : windowType === 'first-run' ? (
        <FirstRunApp />
      ) : windowType === 'drag-coach' ? (
        <DragCoachApp />
      ) : windowType === 'setup' ? (
        <SetupCheckApp />
      ) : windowType === TOUR.WINDOW ? (
        <TourApp />
      ) : windowType === 'webrtc-capture' ? (
        <WebrtcCaptureApp />
      ) : (
        <PanelApp />
      )}
    </WindowBoundary>
  </StrictMode>
)
