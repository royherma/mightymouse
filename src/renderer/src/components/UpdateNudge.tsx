import { useMemo, useState, type JSX } from 'react'
import { useUpdateNotifications } from '../hooks/useUpdateNotifications'
import { ProgressBar } from './ProgressBar'
import { Button } from './Button'
import { usePostNotice } from './SidebarNotices'

/**
 * Surfaces update state outside Settings, which most users never open. Mounted in
 * PanelApp + MightyApp; the tray "Restart to update" row is its always-visible twin.
 */
export function UpdateNudge({ readyInSidebar = false }: { readyInSidebar?: boolean }): JSX.Element | null {
  const update = useUpdateNotifications()
  const [dismissed, setDismissed] = useState(false)

  if (update.state === 'download-progress') {
    if (dismissed) return null
    return (
      <div className="fixed bottom-3 inset-x-3 z-50 flex items-center gap-3 rounded-lg px-3 py-2 shadow-lg"
        style={{ background: 'var(--surface2)', border: '1px solid var(--border)' }}>
        <span className="text-sm text-muted whitespace-nowrap">Downloading update…</span>
        <ProgressBar pct={update.percent ?? 0} />
        <span className="text-sm text-muted tabular-nums">{Math.round(update.percent ?? 0)}%</span>
        <Button variant="bare" className="text-sm text-muted hover:text-fg" onClick={() => setDismissed(true)} aria-label="Dismiss">
          ✕
        </Button>
      </div>
    )
  }

  if (update.state === 'downloaded' && !readyInSidebar) {
    // Not dismissible on purpose: "ready to install" is the one the user must see.
    // Top, not bottom. The panel's input and answer area own the bottom edge, so a
    // bar down there sat behind them and was the reason nobody ever clicked it.
    return (
      <div className="fixed top-3 inset-x-3 z-50 flex items-center justify-between gap-3 rounded-lg px-3 py-2 shadow-lg"
        style={{ background: 'var(--accent)', color: 'var(--accent-fg, #fff)' }}>
        <span className="text-sm font-medium">
          Version {update.version ?? 'update'} is ready to install.
        </span>
        <Button
          variant="bare"
          className="text-sm font-semibold rounded-md px-3 py-1 whitespace-nowrap"
          style={{ background: 'var(--accent-fg, #fff)', color: 'var(--accent)' }}
          onClick={() => window.api.update.install()}
        >
          Restart now
        </Button>
      </div>
    )
  }

  return null
}

export function usePostUpdateNotice(): void {
  const update = useUpdateNotifications()
  const ready = update.state === 'downloaded'
  const notice = useMemo(
    () =>
      ready
        ? {
            id: 'update-ready',
            sticky: true,
            title: 'Update ready',
            detail: `Version ${update.version ?? 'new'}`,
            action: { label: 'Restart', run: () => window.api.update.install() }
          }
        : null,
    [ready, update.version]
  )
  usePostNotice(notice)
}
