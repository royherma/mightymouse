import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './Button'

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const EXIT_MS = 240
const SNAP_MS = 280
const CLOSE_PX = 110
const FLICK_PX_PER_MS = 0.55
const SLOP_PX = 6

const SCRIM =
  'fixed inset-0 z-[45] bg-[rgb(18_16_14/0.32)] transition-opacity duration-300'
const PANEL =
  'fixed inset-x-0 bottom-0 z-[60] rounded-t-[14px] px-5 pt-2 pb-[calc(20px+env(safe-area-inset-bottom,0px))] ' +
  '[background:linear-gradient(var(--bg),var(--bg)),var(--surface-solid,var(--bg))] ' +
  'supports-[color:rgb(from_red_r_g_b)]:[background:rgb(from_var(--bg)_r_g_b_/_1)] ' +
  'shadow-[0_-10px_40px_-12px_rgb(0_0_0/0.25)] outline-none will-change-transform ' +
  'transition-[transform,visibility,bottom] duration-[380ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ' +
  '[&_h3]:mt-1.5 [&_h3]:mb-1 [&_h3]:text-center [&_h3]:text-[22px] [&_h3]:font-bold [&_h3]:tracking-[-0.02em]'

function scrolledWithin(target: EventTarget | null, sheet: HTMLElement): boolean {
  for (let node = target instanceof Element ? target : null; node; node = node.parentElement) {
    if (node.scrollTop > 0) return true
    if (node === sheet) break
  }
  return false
}

export function Sheet({
  label,
  onClose,
  open = true,
  closeButton = false,
  modal = false,
  bottom,
  onSwipeClose,
  className = '',
  scrimClassName = '',
  gripClassName = '',
  children
}: {
  label: string
  onClose: () => void
  open?: boolean
  closeButton?: boolean
  modal?: boolean
  bottom?: number
  onSwipeClose?: () => void
  className?: string
  scrimClassName?: string
  gripClassName?: string
  children: ReactNode
}): JSX.Element {
  const sheetRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const closingRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const swipeRef = useRef(onSwipeClose)
  swipeRef.current = onSwipeClose
  const [shown, setShown] = useState(false)

  const dismiss = useCallback(() => {
    const sheet = sheetRef.current
    const scrim = scrimRef.current
    if (!sheet || !scrim || closingRef.current) return
    closingRef.current = true
    sheet.style.transition = `transform ${EXIT_MS}ms ${EASE}`
    sheet.style.transform = 'translateY(100%)'
    scrim.style.transition = `opacity ${EXIT_MS}ms linear`
    scrim.style.opacity = '0'
    window.setTimeout(() => onCloseRef.current(), EXIT_MS)
  }, [])

  useEffect(() => {
    const sheet = sheetRef.current
    const scrim = scrimRef.current
    if (!open || !sheet || !scrim) {
      setShown(false)
      return
    }
    closingRef.current = false
    for (const el of [sheet, scrim]) {
      el.style.transition = ''
      el.style.transform = ''
      el.style.opacity = ''
    }
    void sheet.offsetHeight
    setShown(true)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sheet.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (sheet.contains(document.activeElement)) previous?.focus({ preventScroll: true })
    }
  }, [open, dismiss])

  useEffect(() => {
    const sheet = sheetRef.current
    const scrim = scrimRef.current
    if (!sheet || !scrim) return
    let startY = 0
    let lastY = 0
    let lastT = 0
    let velocity = 0
    let armed = false
    let dragging = false

    const onStart = (e: TouchEvent): void => {
      if (closingRef.current || e.touches.length !== 1) return
      startY = lastY = e.touches[0].clientY
      lastT = e.timeStamp
      velocity = 0
      armed = !scrolledWithin(e.target, sheet)
      dragging = false
    }
    const onMove = (e: TouchEvent): void => {
      if (!armed) return
      const y = e.touches[0].clientY
      const dy = y - startY
      if (!dragging) {
        if (dy < -SLOP_PX) armed = false
        if (dy < SLOP_PX) return
        dragging = true
        sheet.style.transition = 'none'
        scrim.style.transition = 'none'
      }
      e.preventDefault()
      const dt = e.timeStamp - lastT
      if (dt > 0) velocity = (y - lastY) / dt
      lastY = y
      lastT = e.timeStamp
      const offset = Math.max(0, dy)
      sheet.style.transform = `translateY(${offset}px)`
      scrim.style.opacity = String(1 - Math.min(1, offset / sheet.offsetHeight))
    }
    const onEnd = (): void => {
      armed = false
      if (!dragging) return
      dragging = false
      if (lastY - startY > CLOSE_PX || velocity > FLICK_PX_PER_MS) {
        swipeRef.current?.()
        dismiss()
        return
      }
      sheet.style.transition = `transform ${SNAP_MS}ms ${EASE}`
      sheet.style.transform = ''
      scrim.style.transition = `opacity ${SNAP_MS}ms linear`
      scrim.style.opacity = ''
    }

    sheet.addEventListener('touchstart', onStart, { passive: true })
    sheet.addEventListener('touchmove', onMove, { passive: false })
    sheet.addEventListener('touchend', onEnd)
    sheet.addEventListener('touchcancel', onEnd)
    return () => {
      sheet.removeEventListener('touchstart', onStart)
      sheet.removeEventListener('touchmove', onMove)
      sheet.removeEventListener('touchend', onEnd)
      sheet.removeEventListener('touchcancel', onEnd)
    }
  }, [dismiss])

  return (
    <>
      <div
        ref={scrimRef}
        className={`${SCRIM} ${shown ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'} ${scrimClassName}`.trim()}
        onClick={dismiss}
      />
      <div
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={modal || undefined}
        aria-label={label}
        aria-hidden={!open}
        style={bottom ? { bottom } : undefined}
        className={`${PANEL} ${shown ? 'visible translate-y-0' : 'invisible translate-y-[110%]'} ${className}`.trim()}
      >
        <div className={`mx-auto mb-2.5 h-[5px] w-9 rounded-[3px] bg-surface3 ${gripClassName}`.trim()} />
        {closeButton && (
          <Button
            variant="bare"
            aria-label="Close"
            onClick={dismiss}
            className="absolute right-3.5 top-3.5 grid h-[30px] w-[30px] place-items-center rounded-[15px] !bg-surface2 !text-muted"
          >
            <X size={16} />
          </Button>
        )}
        {children}
      </div>
    </>
  )
}
