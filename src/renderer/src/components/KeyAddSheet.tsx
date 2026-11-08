import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { CONFIG } from '../../../shared/config'
import type { MightyProject } from '../../../shared/types'
import { KEY_NAME_RE, detectProvider, type KeyScope } from '../../../shared/keys'
import { KEY_PROVIDERS, keyProvider } from '../../../shared/key-providers'
import { KeyProviderIcon } from './KeyProviderIcon'
import { Button } from './Button'
import { Modal } from './Modal'
import './KeysPanel.css'

const L = CONFIG.UI_LABELS

function scopeName(id: KeyScope, projects: MightyProject[]): string {
  if (id === 'global') return L.CODE_KEYS_EVERYWHERE
  return projects.find((p) => p.id === id)?.name ?? id
}

export function KeyAddSheet({
  scope,
  scopes,
  projects,
  seedName,
  seedProvider,
  onClose
}: {
  scope: KeyScope
  scopes: KeyScope[]
  projects: MightyProject[]
  seedName?: string
  seedProvider?: string
  onClose: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const [name, setName] = useState(seedName ?? '')
  const [nameTouched, setNameTouched] = useState(Boolean(seedName))
  const [providerId, setProviderId] = useState(seedProvider ?? '')
  const [saveScope, setSaveScope] = useState<KeyScope>(scope)
  const [expiresAt, setExpiresAt] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!value) return
    const detected = detectProvider(KEY_PROVIDERS, name, value)
    if (!detected) return
    setProviderId(detected.id)
    if (!nameTouched && detected.envNames[0]) setName(detected.envNames[0])
  }, [value, name, nameTouched])

  const nameValid = KEY_NAME_RE.test(name)
  const provider = providerId ? keyProvider(providerId) : undefined
  const shapeLabel = useMemo(() => {
    if (!provider || !value) return null
    const hit = provider.shapes.find((s) => value.trim().startsWith(s.prefix))
    return hit?.label ?? null
  }, [provider, value])

  const canSave = value.trim().length > 0 && nameValid && !saving

  const save = (): void => {
    if (!canSave) return
    setSaving(true)
    void window.api.keys
      .set({
        name,
        value,
        scope: saveScope,
        provider: providerId || undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        note: note || undefined,
        addedBy: 'user'
      })
      .then(() => {
        setValue('')
        onClose()
      })
      .finally(() => setSaving(false))
  }

  return (
    <Modal
      label={L.CODE_KEYS_ADD_TITLE}
      onClose={onClose}
      backdropClassName="keys-sheet-backdrop"
      className="keys-sheet"
    >
      <div className="keys-sheet-title">{L.CODE_KEYS_ADD_TITLE}</div>
      <p className="keys-sheet-intro">{L.CODE_KEYS_ADD_INTRO}</p>

      <label className="keys-sheet-field">
        <span>{L.CODE_KEYS_ADD_VALUE}</span>
        <span className="keys-sheet-value-row">
          <input
            type={showValue ? 'text' : 'password'}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) save()
            }}
          />
          <Button
            variant="bare"
            className="keys-sheet-eye"
            onClick={() => setShowValue((v) => !v)}
            title={showValue ? 'Hide' : 'Show'}
          >
            {showValue ? <EyeOff size={14} /> : <Eye size={14} />}
          </Button>
        </span>
      </label>

      <label className="keys-sheet-field">
        <span>{L.CODE_KEYS_ADD_NAME}</span>
        <input
          className="keys-sheet-mono"
          value={name}
          onChange={(e) => {
            setNameTouched(true)
            setName(e.target.value.toUpperCase())
          }}
        />
        {!nameValid && name.length > 0 && (
          <span className="keys-sheet-err">{L.CODE_KEYS_ADD_NAME_INVALID}</span>
        )}
      </label>

      <label className="keys-sheet-field">
        <span>{L.CODE_KEYS_ADD_PROVIDER}</span>
        <span className="keys-sheet-provider-row">
          <KeyProviderIcon provider={providerId || 'unknown'} size={16} />
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">{L.CODE_KEYS_ADD_UNKNOWN_PROVIDER}</option>
            {KEY_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {shapeLabel && <span className="keys-sheet-shape">{shapeLabel}</span>}
        </span>
      </label>

      <label className="keys-sheet-field">
        <span>{L.CODE_KEYS_ADD_WHERE}</span>
        <select value={saveScope} onChange={(e) => setSaveScope(e.target.value)}>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {scopeName(s, projects)}
            </option>
          ))}
        </select>
      </label>

      <label className="keys-sheet-field">
        <span>{L.CODE_KEYS_ADD_EXPIRES}</span>
        <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      </label>

      <label className="keys-sheet-field">
        <span>{L.CODE_KEYS_ADD_NOTE}</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      <div className="keys-sheet-actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} disabled={!canSave}>
          {saving ? L.CODE_KEYS_ADD_SAVING : L.CODE_KEYS_ADD_SAVE}
        </Button>
      </div>
    </Modal>
  )
}
