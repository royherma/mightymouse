import { useCallback, useState } from 'react'

const FOLDED_KEY = 'mm.sidebar.folded'

export function useFolded(scope: string): [Record<string, boolean>, (id: string, shut: boolean) => void] {
  const storageKey = `${FOLDED_KEY}.${scope}`
  const [folded, setFolded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })
  const fold = useCallback(
    (id: string, shut: boolean) =>
      setFolded((prev) => {
        if ((prev[id] === true) === shut) return prev
        const next = { ...prev }
        if (shut) next[id] = true
        else delete next[id]
        try {
          localStorage.setItem(storageKey, JSON.stringify(next))
        } catch {
          /* private storage off: folds reset on the next launch */
        }
        return next
      }),
    [storageKey]
  )
  return [folded, fold]
}
