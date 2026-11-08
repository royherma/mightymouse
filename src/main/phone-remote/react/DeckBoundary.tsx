import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@shared/ui/Button'
import { CONFIG } from '@shared/config'
import { capabilities } from './host-capabilities'
import { PREVIEW_MODE } from './hooks/use-mirror'

const MAX_CLIENT_ERRORS_PER_PAGE_LOAD = 5
let clientErrorsReported = 0

export function reportClientError(kind: string, message: string, stack?: string, where?: string): void {
  if (PREVIEW_MODE || clientErrorsReported >= MAX_CLIENT_ERRORS_PER_PAGE_LOAD) return
  clientErrorsReported += 1
  void fetch(CONFIG.PHONE_REMOTE.CLIENT_ERROR_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      message: (message || 'unknown').slice(0, 4000),
      stack: stack?.slice(0, 8000),
      where: where?.slice(0, 500),
      shell: capabilities.shell
    }),
    keepalive: true
  }).catch(() => {})
}

// Safari hides a cross-origin script's error as "Script error." - the foreign origins are the only lead.
function errorWhere(e: ErrorEvent): string {
  const at = `${e.filename || '?'}:${e.lineno}:${e.colno}`
  const foreign = [...new Set(performance.getEntriesByType('resource')
    .filter((r) => (r as PerformanceResourceTiming).initiatorType === 'script')
    .map((r) => { try { return new URL(r.name).origin } catch { return '' } })
    .filter((origin) => origin && origin !== location.origin))]
  return `${at} visible=${document.visibilityState}${foreign.length ? ` foreign=${foreign.join(',')}` : ''}`
}

export function installClientErrorHooks(): void {
  window.addEventListener('error', (e) => {
    reportClientError('window.onerror', e.message, (e.error as Error | undefined)?.stack, errorWhere(e))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { message?: string; stack?: string } | undefined
    reportClientError('window.unhandledrejection', reason?.message ?? String(e.reason), reason?.stack)
  })
}

/**
 * Catches a render throw anywhere in the deck so the phone shows a reload
 * affordance instead of a dead screen.
 *
 * Two things this must do that a plain boundary wouldn't:
 *
 * 1. Dismiss the boot splash (`#boot`, z-index 9999, inset:0). App's onReady is
 *    what normally retires it, and a throw before first commit means that never
 *    runs — leaving a shield over the fallback that also eats every touch.
 * 2. NOT report over the WS. `remoteLog` is `send()`, which silently drops on a
 *    socket that isn't OPEN — and a boot-time throw is exactly when it isn't.
 *    The message is painted on the glass instead, which is the only readout that
 *    reaches whoever is holding the phone.
 */

type Props = { children: ReactNode }
type State = { failed: boolean; message: string }

export class DeckBoundary extends Component<Props, State> {
  state: State = { failed: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[deck] render failed:', error, info.componentStack)
    reportClientError(
      'react.render',
      error.message,
      `${error.stack ?? ''}\n${info.componentStack ?? ''}`
    )
    document.getElementById('boot')?.remove()
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="deckBoundary">
        <p className="deckBoundary__title">The remote hit a snag.</p>
        <p className="deckBoundary__body">Reload to get back to your Mac.</p>
        <Button variant="primary" size="lg" className="deckBoundary__reload" onClick={() => window.location.reload()}>
          Reload
        </Button>
        {this.state.message ? <pre className="deckBoundary__detail">{this.state.message}</pre> : null}
      </div>
    )
  }
}
