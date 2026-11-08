import { useEffect, useState } from 'react'

export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.api.admin
        .isAdmin()
        .then((on) => {
          if (alive) setIsAdmin(on)
        })
        .catch(() => {})
    }
    refresh()
    const off = window.api.onViewAsUserChanged(refresh)
    return () => {
      alive = false
      off()
    }
  }, [])
  return isAdmin
}
