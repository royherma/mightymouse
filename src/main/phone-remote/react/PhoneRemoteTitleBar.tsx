import type { ReactNode } from 'react'

/** Shared title-row frame for phone remote sheets and full-screen surfaces. */
export default function PhoneRemoteTitleBar({
  title,
  leading,
  actions,
  className = ''
}: {
  title: ReactNode
  leading?: ReactNode
  actions?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`phoneRemoteTitleBar${className ? ` ${className}` : ''}`}>
      {leading != null && <div className="phoneRemoteTitleBarLeading">{leading}</div>}
      <div className="phoneRemoteTitleBarTitle">{title}</div>
      {actions != null && <div className="phoneRemoteTitleBarActions">{actions}</div>}
    </div>
  )
}
