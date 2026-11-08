import { useCallback, useState, type SetStateAction } from 'react'

const typedByKey = new Map<string, string>()

export function useRememberedText(key: string, seed?: string): [string, (next: SetStateAction<string>) => void] {
  const [text, setTextState] = useState(() => seed ?? typedByKey.get(key) ?? '')
  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setTextState(typedByKey.get(key) ?? '')
  }
  const setText = useCallback(
    (next: SetStateAction<string>) =>
      setTextState((prev) => {
        const value = typeof next === 'function' ? next(prev) : next
        if (value) typedByKey.set(key, value)
        else typedByKey.delete(key)
        return value
      }),
    [key]
  )
  return [text, setText]
}
