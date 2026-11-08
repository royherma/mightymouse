/**
 * The one place that knows where a native helper binary lives on macOS.
 *
 * Dev: `<repo>/native/<dir>/<bin>` — app.getAppPath() is the project root.
 * Don't count '..' from __dirname: the bundler flattens src/main/** into
 * out/main, so a fixed level count silently points at the wrong dir.
 * Packaged: `MightyMouse.app/Contents/Resources/native/<dir>/<bin>` —
 * electron-builder's `extraResources` ships all of native/** there, signed.
 */
import { dirname, join } from 'path'
import { app } from 'electron'
import { IS_DEV, warnIfArchMismatch } from '../../../shared/env'

export type HelperName =
  | 'mm-input'
  | 'mm-shot'
  | 'mm-ui'
  | 'mm-ax'
  | 'mic-recorder'
  | 'ocr'
  | 'notch-info'
  | 'app-switcher-list'
  | 'activate-app'
  | 'fn-watch'
  | 'frontmost-watch'
  | 'window-layout'
  | 'mm-vdisplay'
  | 'system-audio'
  | 'mm-ring-writer'
  | 'mm-default-input'
  | 'mm-audiodev.driver'
  | 'MightyMouseLocation.app'

/** Which native/ dir each helper is built into — most are 1:1, the audiodev
 *  dir ships three artifacts. */
const HELPER_DIR: Record<HelperName, string> = {
  'mm-input': 'native/mm-input',
  'mm-shot': 'native/mm-shot',
  'mm-ui': 'native/mm-ui',
  'mm-ax': 'native/mm-ax',
  'mic-recorder': 'native/mic-recorder',
  ocr: 'native/ocr',
  'notch-info': 'native/notch-info',
  'app-switcher-list': 'native/app-switcher-list',
  'activate-app': 'native/activate-app',
  'fn-watch': 'native/fn-watch',
  'frontmost-watch': 'native/frontmost-watch',
  'window-layout': 'native/window-layout',
  'mm-vdisplay': 'native/mm-vdisplay',
  'system-audio': 'native/system-audio',
  'mm-ring-writer': 'native/mm-audiodev',
  'mm-default-input': 'native/mm-audiodev',
  'mm-audiodev.driver': 'native/mm-audiodev',
  'MightyMouseLocation.app': 'native/mm-location'
}

/** Absolute path to a native helper. Never checks existence — callers keep
 *  their own existsSync fallbacks. */
export function resolveHelper(name: HelperName): string {
  warnIfArchMismatch(name)
  if (IS_DEV) return join(app.getAppPath(), HELPER_DIR[name], name)
  return join(dirname(app.getPath('exe')), '..', 'Resources', HELPER_DIR[name], name)
}
