import { JSX, ReactNode } from 'react'
import { Spinner } from './components/Spinner'

// Shared chrome for the framed, scrollable windows (Settings, Cheat Sheet).
// Owns the draggable hiddenInset titlebar so every window is visually consistent
// and the title clears the macOS traffic lights.

export function TitleBar({
  title,
  icon,
  action,
  leading
}: {
  title: string
  icon?: ReactNode
  action?: ReactNode
  leading?: ReactNode
}): JSX.Element {
  return (
    <div
      className="sticky top-0 z-10 h-11 flex items-center justify-center bg-bg border-b border-surface2 select-none"
      style={{
        // @ts-expect-error -webkit-app-region is valid in Electron
        WebkitAppRegion: 'drag'
      }}
    >
      {leading && (
        <div
          className="absolute left-[84px] flex items-center"
          style={{
            // @ts-expect-error -webkit-app-region is valid in Electron
            WebkitAppRegion: 'no-drag'
          }}
        >
          {leading}
        </div>
      )}
      <span className="flex min-w-0 max-w-[40%] items-center gap-2 text-lg font-semibold tracking-wide text-on-surface">
        {icon}
        <span className="truncate">{title}</span>
      </span>
      {/* Right-side action (e.g. Settings → Permissions). Opted out of the drag
          region so it stays clickable inside the draggable titlebar. */}
      {action && (
        <div
          className="absolute right-3 flex items-center"
          style={{
            // @ts-expect-error -webkit-app-region is valid in Electron
            WebkitAppRegion: 'no-drag'
          }}
        >
          {action}
        </div>
      )}
    </div>
  )
}

export function WindowFrame({
  title,
  icon,
  action,
  leading,
  children,
  className = ''
}: {
  title: string
  icon?: ReactNode
  action?: ReactNode
  leading?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={`font-sans text-on-surface bg-bg h-screen overflow-y-auto overflow-x-hidden ${className}`}>
      <TitleBar title={title} icon={icon} action={action} leading={leading} />
      {children}
    </div>
  )
}

// Centered spinner + label. Used as the window body while data loads, so the
// loading state keeps the titlebar and sits in the middle (not bare top-left).
export function LoadingBody({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 h-[calc(100vh-2.75rem)] text-muted">
      <Spinner />
      <span className="text-md">{label}</span>
    </div>
  )
}
