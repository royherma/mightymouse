// Renderer crash reporting → public.errors (via the reportError IPC → trackError).
// A thrown error in a window paints a blank screen the user can't recover from
// and we can't see; this ships the message + stack + which window (route) threw,
// so it lands next to main-process crashes in the same errors table.
//
// Identity (anon_id / user_id / app_version / platform / session) is attached
// main-side in trackError() — the renderer only sends the error shape.

export function installRendererCrashHook(route: string): void {
  const report = (kind: string, message: string, stack?: string): void => {
    try {
      window.api?.reportError({ kind, message: message || 'unknown', stack, source: 'renderer', props: { route } })
    } catch {
      // reportError must never itself throw inside an error handler.
    }
  }

  // Errors thrown by the user's own browser extensions are not ours to log. The
  // app is Electron and loads none, so this only bites when a dev harness is
  // opened in a real Chrome (MetaMask injects into localhost and rejects) — but
  // filing those in public.errors puts crashes we can never fix, in code we
  // don't ship, next to real ones.
  const fromExtension = (stack?: string): boolean => !!stack?.includes('chrome-extension://')

  window.addEventListener('error', (e) => {
    if (fromExtension(e.error?.stack) || e.filename?.startsWith('chrome-extension://')) return
    report('window.onerror', e.message, e.error?.stack)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason
    if (fromExtension(reason?.stack)) return
    report('window.unhandledrejection', reason?.message ?? String(reason), reason?.stack)
  })
}
