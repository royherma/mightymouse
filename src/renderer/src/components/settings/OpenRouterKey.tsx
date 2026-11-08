import { JSX, useCallback, useEffect, useState } from 'react'
import type { BackendTestResult } from '../../../../shared/types'
import { keyProvider } from '../../../../shared/key-providers'
import { Button } from '../Button'
import { GlowDot } from '../GlowDot'

const KEY_NAME = keyProvider('openrouter')?.envNames[0] ?? 'OPENROUTER_API_KEY'
const KEYS_URL = keyProvider('openrouter')?.docsUrl ?? 'https://openrouter.ai/keys'

export function OpenRouterKey({ inputCls }: { inputCls: string }): JSX.Element {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<BackendTestResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const check = useCallback(async () => {
    setStatus(await window.api.settingsTestBackend('openrouter'))
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  const save = async (): Promise<void> => {
    const key = value.trim()
    if (!key) return
    setBusy(true)
    setError('')
    const saved = await window.api.keys
      .set({ name: KEY_NAME, value: key, scope: 'global', provider: 'openrouter', addedBy: 'user' })
      .catch(() => null)
    if (!saved) {
      setError('Could not save the key to your keychain. Try again.')
    } else {
      setValue('')
      await check()
    }
    setBusy(false)
  }

  const line = status?.checks[0]
  const hasKey = !!line && line.detail !== 'No key saved'
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        <div className="text-md font-semibold">OpenRouter key</div>
        <Button variant="bare" className="text-sm text-accent-text" onClick={() => window.api.openExternal(KEYS_URL)}>
          Get a key
        </Button>
      </div>
      {line && (
        <div className="flex items-center gap-2 mt-1 text-sm">
          <GlowDot color={line.ok ? 'var(--green-light)' : 'var(--red-light)'} size="w-2 h-2" />
          <span className="text-muted">{status?.advice && hasKey ? status.advice : line.detail}</span>
        </div>
      )}
      <form
        className="flex gap-2 mt-2"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <input
          type="password"
          className={inputCls}
          value={value}
          placeholder={hasKey ? 'Paste a new key to replace it' : 'sk-or-...'}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="ghost" disabled={busy || !value.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </form>
      {error && (
        <div className="text-sm mt-1" style={{ color: 'var(--red-light)' }}>
          {error}
        </div>
      )}
    </div>
  )
}
