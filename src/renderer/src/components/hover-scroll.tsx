import { useLayoutEffect, useRef, type JSX } from 'react'
import './hover-scroll.css'

const PX_PER_SECOND = 60
const MIN_MS = 700

export function HoverScroll({
  text,
  className = ''
}: {
  text: string
  className?: string
}): JSX.Element {
  const outerRef = useRef<HTMLSpanElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return
    const measure = (): void => {
      const over = inner.scrollWidth - outer.clientWidth
      outer.toggleAttribute('data-overflow', over > 1)
      outer.style.setProperty('--hover-scroll-by', `${-Math.max(0, over)}px`)
      outer.style.setProperty(
        '--hover-scroll-ms',
        `${Math.max(MIN_MS, Math.round((over / PX_PER_SECOND) * 1000))}ms`
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    return () => observer.disconnect()
  }, [text])

  return (
    <span ref={outerRef} className={`hover-scroll ${className}`.trim()} title={text}>
      <span ref={innerRef} className="hover-scroll-inner">
        {text}
      </span>
    </span>
  )
}
