import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX, KeyboardEvent, ReactNode } from 'react'
import { useEscape } from '../hooks/useEscape'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const DEFAULT_BACKDROP = 'fixed inset-0 z-50 grid place-items-center bg-black/40'

function focusables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

export function Modal({
  label,
  onClose,
  dismissOnBackdrop = true,
  backdropClassName = DEFAULT_BACKDROP,
  backdropStyle,
  className,
  style,
  children
}: {
  label: string
  onClose: () => void
  dismissOnBackdrop?: boolean
  backdropClassName?: string
  backdropStyle?: CSSProperties
  className?: string
  style?: CSSProperties
  children: ReactNode
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const [returnTo] = useState(() => document.activeElement)
  useEscape(onClose)

  useEffect(() => {
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected)
        returnTo.focus({ preventScroll: true })
    }
  }, [returnTo])

  const trapTab = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || e.defaultPrevented || !panelRef.current) return
    const all = focusables(panelRef.current)
    e.preventDefault()
    if (all.length === 0) return
    const at = all.indexOf(document.activeElement as HTMLElement)
    const next = e.shiftKey
      ? at <= 0
        ? all.length - 1
        : at - 1
      : at === all.length - 1
        ? 0
        : at + 1
    all[next].focus()
  }

  return (
    <div
      className={backdropClassName}
      style={backdropStyle}
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={className}
        style={{ outline: 'none', ...style }}
        onKeyDown={trapTab}
      >
        {children}
      </div>
    </div>
  )
}
