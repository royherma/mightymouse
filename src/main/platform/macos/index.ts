/**
 * macOS implementation of the platform contract. Assembles the existing
 * per-concern modules (selection, context, permissions, resolve-binary) into
 * one `PlatformImpl`, grouped by domain. These modules now assume they run on
 * darwin — the picker (`../index.ts`) guarantees it, so they carry no
 * `process.platform` guards.
 *
 * shell/helpers/chrome are stubs here — their real mac impls land in Phase 3
 * (3.1/3.2/3.3). Nothing outside `platform/` reaches them yet.
 */
import { CONFIG } from '../../../shared/config'
import type { PlatformImpl } from '../contract'
import { resolveHelper } from './helpers'
import { chrome } from './chrome'
import {
  captureSelection,
  pasteText,
  pasteTextToApp,
  setSyntheticPasteListener
} from './selection'
import { captureContext, captureFinderSelection, captureScreenshot } from './context'
import {
  frontmostBundleId,
  userFacingFrontmostBundleId,
  waitForFrontmost,
  readAppContext,
  readFrontmostScreen,
  activateAppItem,
  activateAppPane,
  activateAppGroup
} from './app-context'
import { onFrontmostAppChange, onRunningAppsChange, pinFrontmostWatch, stopFrontmostWatch } from './frontmost-watch'
import { listSwitchableApps } from './app-switcher-list'
import { activateApp } from './activate-app'
import { axPress } from './ax-control'
import {
  quickSwitchApps,
  resetQuickSwitchAnchor,
  getQuickSwitchAnchor,
  setQuickSwitchAnchor,
  afterQuickSwitchQueue
} from './quick-switch'
import { applyWindowLayout, hasRestoreStash, clearRestoreStash } from './window-layout'
import {
  setSyntheticInputListener,
  runInput,
  inputBinPath,
  shotCommand,
  captureScreenWithoutUs,
  uiBinPath,
  detectHostKeyboardType,
  moveCursorFast,
  dragDownFast,
  dragMoveFast,
  dragUpFast,
  scrollFast,
  stopMoveLoop,
  clickAt,
  rightClickAt,
  doubleClickAt,
  typeText,
  pressKeys,
  zoomMac,
  smartZoomMac,
  openAppOverview
} from './input'
import { hideSystemCursor, showSystemCursor } from './hide-cursor'
import { getCursorAppearance, setCursorSize } from './cursor-appearance'
import { onFnEdge, stopFnWatch } from './fn-watch'
import { getSystemVolume, setSystemVolume } from './system-volume'
import { getBatteryStatus } from './battery-status'
import { getComputerName, getHostDevice } from './computer-name'
import { getNotchInfo } from './notch-info'
import { PERMISSIONS, requiredPermissionKeys } from './permissions'
import { runSelfTest, buildPermissionChecks, needsOnboarding } from './permission-tests'
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
import { applyLoginShellPath } from './login-path'
import {
  bin as shellBin,
  pathPrefix,
  quote,
  spawnArgs,
  fileText,
  env as shellEnv,
  agentToolHints
} from './shell'

export const macos: PlatformImpl = {
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
    frontmostBundleId,
    userFacingFrontmostBundleId,
    waitForFrontmost,
    readAppContext,
    readFrontmostScreen,
    activateAppItem,
    activateAppPane,
    activateAppGroup,
    onFrontmostAppChange,
    onRunningAppsChange,
    pinFrontmostWatch,
    stopFrontmostWatch,
    listSwitchableApps,
    activateApp,
    axPress,
    quickSwitchApps,
    resetQuickSwitchAnchor,
    getQuickSwitchAnchor,
    setQuickSwitchAnchor,
    afterQuickSwitchQueue,
    applyWindowLayout,
    hasRestoreStash,
    clearRestoreStash
  },
  input: {
    setSyntheticInputListener,
    runInput,
    inputBinPath,
    shotCommand,
    captureScreenWithoutUs,
    uiBinPath,
    detectHostKeyboardType,
    moveCursorFast,
    dragDownFast,
    dragMoveFast,
    dragUpFast,
    scrollFast,
    stopMoveLoop,
    clickAt,
    rightClickAt,
    doubleClickAt,
    typeText,
    pressKeys,
    zoomMac,
    smartZoomMac,
    openAppOverview,
    hideSystemCursor,
    showSystemCursor,
    getCursorAppearance,
    setCursorSize,
    onFnEdge,
    stopFnWatch
  },
  system: {
    getSystemVolume,
    setSystemVolume,
    getBatteryStatus,
    getComputerName,
    getHostDevice,
    getNotchInfo
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
    installHint: () => CONFIG.CAPTURE_ERROR.brewMissing
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
  helpers: {
    resolve: resolveHelper
  },
  chrome,
  // Existing behaviour: every mac-only capability is on except browser-URL
  // context, which today is Chrome/Cmux/Cursor-specific (app-context/*.ts),
  // not a general capability — see PRD §8 2.2.
  capabilities: {
    phoneMic: true,
    virtualDisplay: true,
    notch: true,
    windowLayout: true,
    appSwitcher: true,
    fnKey: true,
    pointerControl: true,
    systemAudio: true,
    ocr: true,
    clamshell: true,
    nativeMic: true,
    browserUrl: false
  }
}
