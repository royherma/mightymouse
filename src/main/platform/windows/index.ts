/**
 * Windows implementation of the platform contract — Tier 1.
 *
 * Tier 1 is the minimal USEFUL Windows app: hotkey → panel →
 * Claude/Codex on the selection + clipboard, tray, settings, updater. Selection,
 * context, binaries, shell, permissions, chrome, helpers and phone-remote input
 * (SendInput via koffi) are real here. Capture and the native helpers are Tier
 * 2+ and still throw.
 *
 * Two failure styles, both HONEST (this replaced the old silent fake-pass):
 *  - An unimplemented automation method THROWS `PlatformNotSupportedError` —
 *    loud, and caught by the same error pipeline as any runtime failure.
 *  - `capabilities` says up front what is worth showing a control for, so the UI
 *    hides what cannot work instead of offering a button that throws.
 *
 * phoneMic and virtualDisplay are false and stay false: both need WHQL-signed
 * kernel drivers, which puts them permanently out of scope on Windows.
 */
import { hostname } from 'node:os'
import { screen } from 'electron'
import type { InstallableTool, PlatformImpl } from '../contract'
import { PlatformNotSupportedError } from '../errors'
import { EMPTY_READING } from '../../../shared/app-context'
import { captureSelection, pasteText, pasteTextToApp, setSyntheticPasteListener } from './selection'
import { createWindowsInput } from './input'
import { win32Available } from './win32'
import { captureContext, captureFinderSelection, captureScreenshot } from './context'
import {
  resolveBinary,
  resolveClaude,
  resolveCodex,
  resolveOpencode,
  resolveGemini,
  resolveNpm,
  resolveBrewBin,
  npmPrefixWritable,
  clearBinaryCache
} from './resolve-binary'
import {
  PERMISSIONS,
  requiredPermissionKeys,
  runSelfTest,
  buildPermissionChecks,
  needsOnboarding
} from './permissions'
import {
  bin as shellBin,
  pathPrefix,
  quote,
  spawnArgs,
  fileText,
  env as shellEnv,
  agentToolHints,
  applyLoginShellPath
} from './shell'

const PLATFORM: NodeJS.Platform = 'win32'
const unsupported = (capability: string): never => {
  throw new PlatformNotSupportedError(PLATFORM, capability)
}

// winget package ids for the tools Settings can't auto-install here.
const WINGET_ID: Record<InstallableTool, string> = {
  ffmpeg: 'Gyan.FFmpeg',
  whisper: 'ggerganov.whisper.cpp',
  node: 'OpenJS.NodeJS.LTS'
}

const windowsInput = createWindowsInput((x, y) => {
  const p = screen.dipToScreenPoint({ x, y })
  return { x: p.x, y: p.y }
})

export const windows: PlatformImpl = {
  selection: {
    captureSelection,
    pasteText,
    pasteTextToApp,
    setSyntheticPasteListener
  },
  context: {
    captureContext,
    captureFinderSelection,
    captureScreenshot,
    // The phone-remote connect path calls these watchers and readers
    // unconditionally, so they answer "nothing to report". The actions behind
    // appSwitcher/windowLayout stay unsupported; capability flags hide them.
    frontmostBundleId: () => '',
    userFacingFrontmostBundleId: () => '',
    waitForFrontmost: async () => false,
    readAppContext: async () => ({
      adapterId: null,
      appName: '',
      bundleId: '',
      appIconPngBase64: '',
      ...EMPTY_READING
    }),
    readFrontmostScreen: async () => null,
    activateAppItem: () => unsupported('context.activateAppItem'),
    activateAppPane: () => unsupported('context.activateAppPane'),
    activateAppGroup: () => unsupported('context.activateAppGroup'),
    onFrontmostAppChange: () => () => {},
    onRunningAppsChange: () => () => {},
    pinFrontmostWatch: () => {},
    stopFrontmostWatch: () => {},
    listSwitchableApps: () => [],
    activateApp: () => unsupported('context.activateApp'),
    axPress: () => unsupported('context.axPress'),
    quickSwitchApps: () => unsupported('context.quickSwitchApps'),
    resetQuickSwitchAnchor: () => {},
    getQuickSwitchAnchor: () => null,
    setQuickSwitchAnchor: () => unsupported('context.setQuickSwitchAnchor'),
    afterQuickSwitchQueue: () => unsupported('context.afterQuickSwitchQueue'),
    applyWindowLayout: () => unsupported('context.applyWindowLayout'),
    hasRestoreStash: () => false,
    clearRestoreStash: () => {}
  },
  input: windowsInput,
  system: {
    getSystemVolume: () => unsupported('system.getSystemVolume'),
    setSystemVolume: () => unsupported('system.setSystemVolume'),
    // `percent: null` is the existing "no battery" shape (a Mac desktop reports
    // the same), and the phone protocol already types it nullable. Reading the
    // real Win32 level needs a PowerShell round trip per poll — not worth it
    // until the phone remote itself works on Windows.
    getBatteryStatus: () => ({ percent: null, charging: true }),
    getComputerName: () => hostname(),
    getHostDevice: async () => null,
    // There is no notch. Not a gap — `capabilities.notch` is false, and the one
    // caller (island-window.ts:42) reads that flag before calling. It did NOT
    // until v0.41.1; the comment asserted a guard that was never written.
    getNotchInfo: () => unsupported('system.getNotchInfo')
  },

  permissions: PERMISSIONS,
  requiredPermissionKeys,
  runSelfTest,
  buildPermissionChecks,
  needsOnboarding,

  binaries: {
    resolveBinary,
    resolveClaude,
    resolveCodex,
    resolveOpencode,
    resolveGemini,
    resolveNpm,
    resolveBrewBin,
    npmPrefixWritable,
    clearBinaryCache,
    installHint: (tool) => `Install it first: winget install ${WINGET_ID[tool]}, then try again.`
  },

  shell: {
    bin: shellBin,
    pathPrefix,
    quote,
    spawnArgs,
    fileText,
    env: shellEnv,
    agentToolHints,
    applyLoginShellPath
  },

  // Nothing to resolve: `native/**` is filtered out of the Windows installer
  // (electron-builder.yml) because every helper in it is a Mach-O binary. The
  // reserved landing spot for their eventual counterparts is `native-win/`.
  helpers: {
    resolve: () => null
  },

  chrome: {
    windowOptions: (kind) => {
      switch (kind) {
        case 'inset':
        case 'inset-notraffic':
          // titleBarOverlay gives back the caption buttons that 'hidden' removes;
          // without it a frameless window on Windows has no way to be closed.
          return { titleBarStyle: 'hidden', titleBarOverlay: true }
        case 'panel':
          // No NSPanel equivalent. alwaysOnTop + skipTaskbar is the closest
          // behaviour: floats over other windows, never appears as a task.
          return { alwaysOnTop: true, skipTaskbar: true }
        case 'vibrant':
          // Win11 only; silently ignored on Win10, which is the right degrade.
          return { backgroundMaterial: 'acrylic' }
      }
    },
    // No per-desktop visibility API in Electron on Windows beyond this — the
    // visibleOnFullScreen option is macOS-only and passing it would be a lie.
    showOnAllWorkspaces: (win) => win.setVisibleOnAllWorkspaces(true)
  },

  capabilities: {
    // Kernel-driver bound, permanently out of scope on Windows.
    phoneMic: false,
    virtualDisplay: false,
    // No notch on any Windows machine.
    notch: false,
    // Tier 2: all of these are `mm-input`/UI-Automation work.
    windowLayout: false,
    appSwitcher: false,
    // No Fn-key edge to watch — Windows exposes no such event.
    fnKey: false,
    get pointerControl() {
      return win32Available()
    },
    systemAudio: false,
    ocr: false,
    clamshell: false,
    nativeMic: false,
    // False on macOS too today — context.ts explains why we don't guess a URL.
    browserUrl: false
  }
}
