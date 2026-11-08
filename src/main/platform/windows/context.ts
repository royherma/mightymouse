/**
 * context.ts — sense the focused world on Windows.
 *
 * The foreground window is a P/Invoke away (GetForegroundWindow +
 * GetWindowTextW + GetWindowThreadProcessId), and PowerShell can P/Invoke via
 * `Add-Type`. The catch is that `Add-Type` COMPILES C# — csc.exe, ~1.5-3s — and
 * we spawn a fresh PowerShell every call, so nothing is cached between them.
 * captureContext() runs on every WRITE paste; 3s there is not a slow path, it is
 * a broken one.
 *
 * So: compile ONCE to a DLL under PATHS.TMP, then every call is
 * `Add-Type -Path <dll>` (~50ms) plus the PowerShell start. This is the same
 * shape as the macOS AX helper, which compiles a Swift binary on first use and
 * spawns the cached one thereafter — deliberately, so the two platforms fail and
 * recover the same way.
 *
 * Browser URL is NOT implemented. Reading it needs UI Automation to walk to the
 * address bar, which is per-browser, per-version, and reports a URL the user may
 * have typed but not navigated to. `capabilities.browserUrl` is false on both
 * platforms today; a wrong URL in every prompt is worse than none.
 */
import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PATHS } from '../../store/paths'
import { ContextData } from '../../../shared/types'
import { devLog } from '../../../shared/env'
import { quote, runPowerShell } from './shell'

/** Resolved on use, never at module scope: this file is reachable from
 *  `platform/index.ts`, which the whole main process imports, and reading PATHS
 *  at import time makes the store's init order load-bearing for everything
 *  downstream. */
const foregroundDll = (): string => join(PATHS.TMP, 'mm-foreground.dll')
const foregroundSource = (): string => join(PATHS.TMP, 'mm-foreground.cs')

/** Compiling csc.exe cold on a slow machine is well past the 5s default that
 *  every other PowerShell call here uses. Paid once per install. */
const COMPILE_TIMEOUT_MS = 60_000

/**
 * The three user32 calls that answer "what is the user looking at".
 *
 * GetWindowTextW and not GetWindowText: the ANSI variant mangles any non-Latin
 * window title, and titles are filenames and page names — exactly the text that
 * is not ASCII.
 */
const FOREGROUND_CS = `
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class MMForeground {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll")]
  public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);

  public static string Title() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(1024);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static int ProcessId() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    int pid;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }
}
`.trim()

/** Resolves false when the helper could not be produced — every caller then
 *  degrades to partial context rather than failing the run. */
async function ensureForegroundAssembly(): Promise<boolean> {
  const dll = foregroundDll()
  if (existsSync(dll)) return true
  try {
    const source = foregroundSource()
    writeFileSync(source, FOREGROUND_CS, 'utf-8')
    await runPowerShell(
      `Add-Type -TypeDefinition (Get-Content -Raw -Encoding UTF8 ${quote(source)}) ` +
        `-OutputAssembly ${quote(dll)} -OutputType Library`,
      COMPILE_TIMEOUT_MS
    )
    return existsSync(dll)
  } catch (err) {
    console.error('[context] could not compile the foreground-window helper:', err)
    // A half-written DLL would make every later call fail on load with no way
    // back, since the existsSync above would keep short-circuiting the rebuild.
    try {
      rmSync(dll, { force: true })
    } catch {
      /* best effort */
    }
    return false
  }
}

export async function captureContext(): Promise<ContextData> {
  const result: ContextData = {
    frontApp: null,
    windowTitle: null,
    // Not supported here; see the file header.
    browserURL: null
  }

  if (!(await ensureForegroundAssembly())) return result

  // Same `|||` framing as the macOS AppleScript, so both platforms hand the
  // caller the same two fields in the same order.
  //
  // Description before ProcessName: a process is "msedge", its description is
  // "Microsoft Edge". The description is what the user calls the app, and what
  // the model needs to reason about it.
  const script = `
Add-Type -Path ${quote(foregroundDll())}
$title = [MMForeground]::Title()
$procId = [MMForeground]::ProcessId()
$name = ''
if ($procId -ne 0) {
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($p) { if ($p.Description) { $name = $p.Description } else { $name = $p.ProcessName } }
}
Write-Output ($name + '|||' + $title)
`.trim()

  try {
    const raw = await runPowerShell(script)
    const parts = raw.split('|||')
    if (parts[0]) result.frontApp = parts[0]
    if (parts[1]) result.windowTitle = parts[1]
  } catch (err) {
    // Expected + degradable: callers proceed with partial context. Kept out of
    // console.error so a busy foreground app doesn't spam the log.
    devLog.warn('captureContext: foreground query failed (degrading to partial):', err)
  }

  return result
}

/**
 * The Finder-selection analogue: files selected in an Explorer window.
 *
 * Shell.Application enumerates open Explorer windows and their selections
 * without any P/Invoke. It only sees Explorer — a file selected on the desktop
 * or in a file dialog is invisible to it, same as macOS's Finder-only script.
 */
export async function captureFinderSelection(): Promise<string[]> {
  // Every open Explorer window, not just the foreground one — the same breadth
  // as the macOS script, which asks Finder for its selection without caring
  // which window holds it. A window whose Document has no SelectedItems (the
  // Control Panel, an Internet Explorer frame) throws on access, hence the
  // per-window try.
  const script = `
$sh = New-Object -ComObject Shell.Application
foreach ($w in $sh.Windows()) {
  try {
    foreach ($item in $w.Document.SelectedItems()) { Write-Output $item.Path }
  } catch {}
}
`.trim()

  try {
    const raw = await runPowerShell(script)
    return raw
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p !== '')
  } catch (err) {
    console.error('Failed to capture Explorer selection:', err)
    return []
  }
}

/**
 * Best-effort screen context for a run. Resolves null when there's no usable
 * screenshot — every caller treats that as "run without the image".
 *
 * Not implemented in Tier 1: screen capture is Tier 2, and
 * the callers that want a screenshot (the suggest bubble, Panel "include screen
 * context") already treat it as an enhancement. Returning null degrades to a
 * text-only run, which is the same thing a denied Screen Recording grant does on
 * macOS — a path every caller is already built to handle.
 */
export function captureScreenshot(): Promise<string | null> {
  return Promise.resolve(null)
}
