import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './components/Button'

/**
 * Catches a render throw in ANY `?window=` route (see main.tsx) so the window
 * shows a recoverable message instead of a blank rectangle the user can only
 * escape by quitting.
 *
 * `crash-hook.ts` already reports `window.onerror`, but React swallows render
 * errors from that path — without a boundary they unmount the tree silently and
 * never reach public.errors. This reports them under the same shape, tagged
 * `react.render`, so both kinds land in one table.
 */

type Props = { route: string; children: ReactNode }
type State = { failed: boolean; message: string }

export class WindowBoundary extends Component<Props, State> {
  state: State = { failed: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[boundary] ${this.props.route} failed to render:`, error)
    try {
      window.api?.reportError({
        kind: 'react.render',
        message: error.message || 'unknown',
        // componentStack points at the subtree that threw, which the JS stack
        // alone doesn't give us for a render error.
        stack: `${error.stack ?? ''}\n--- component stack ---${info.componentStack ?? ''}`,
        source: 'renderer',
        props: { route: this.props.route }
      })
    } catch {
      // Reporting must never throw from inside an error handler.
    }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="window-boundary">
        <p className="window-boundary__title">This window hit a snag.</p>
        <p className="window-boundary__body">
          Close it and open it again. We&rsquo;ve logged what happened.
        </p>
        <Button className="window-boundary__retry" onClick={() => this.setState({ failed: false, message: '' })}>
          Try again
        </Button>
        {this.state.message ? <pre className="window-boundary__detail">{this.state.message}</pre> : null}
      </div>
    )
  }
}
