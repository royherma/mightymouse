import { useEffect, useRef } from 'react'

const stack: Array<{ current: () => void }> = []

// Document bubble phase: a field that handles Escape itself (preventDefault/stopPropagation) wins.
function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
  const top = stack.at(-1)
  if (!top) return
  e.preventDefault()
  e.stopPropagation()
  top.current()
}

export function useEscape(onEscape: () => void, active = true): void {
  const ref = useRef(onEscape)
  ref.current = onEscape

  useEffect(() => {
    if (!active) return
    const entry = ref
    stack.push(entry)
    if (stack.length === 1) document.addEventListener('keydown', onKey)
    return () => {
      const i = stack.lastIndexOf(entry)
      if (i !== -1) stack.splice(i, 1)
      if (stack.length === 0) document.removeEventListener('keydown', onKey)
    }
  }, [active])
}
