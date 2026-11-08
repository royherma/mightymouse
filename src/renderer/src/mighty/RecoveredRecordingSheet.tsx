import { JSX, useCallback, useEffect, useState } from 'react'
import { Button } from '../components/Button'
import { Modal } from '../components/Modal'
import { CONFIG } from '../../../shared/config'
import type { RecoveredRecordingsState } from '../../../shared/types'

const L = CONFIG.UI_LABELS
const COPIED_HOLD_MS = 700

export function RecoveredRecordingSheet({ onOpen }: { onOpen: (folder: string) => void }): JSX.Element | null {
  const [state, setState] = useState<RecoveredRecordingsState>({ working: false, items: [] })
  const [copied, setCopied] = useState(false)
  const shown = state.working || state.items.length > 0

  useEffect(() => {
    void window.api.getRecoveredRecordings().then(setState)
    return window.api.onRecoveredRecordingsChanged(setState)
  }, [])

  const close = useCallback(() => {
    setCopied(false)
    setState({ working: false, items: [] })
    void window.api.dismissRecoveredRecordings()
  }, [])

  if (!shown) return null

  const { items } = state
  const text = items.map((r) => r.transcript).filter((t) => t !== '').join('\n\n')
  const newest = items[items.length - 1]
  const title = state.working
    ? L.RECOVERED_WORKING
    : items.length > 1
      ? L.RECOVERED_MANY.replace('{n}', String(items.length))
      : L.RECOVERED_ONE

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(close, COPIED_HOLD_MS)
    })
  }

  return (
    <Modal
      label={title}
      onClose={close}
      dismissOnBackdrop={false}
      backdropClassName="fixed inset-0 z-50 flex items-center justify-center p-6"
      backdropStyle={{ background: 'rgba(0,0,0,0.45)' }}
      className="w-full max-w-[560px] max-h-full rounded-lg p-4 flex flex-col gap-3"
      style={{
        background: 'var(--surface1)',
        border: '1px solid var(--surface3)',
        boxShadow: 'var(--shadow-panel)'
      }}
    >
      <div className="text-md font-semibold text-on-surface">{title}</div>
      {!state.working && (
        <div className="text-sm text-muted leading-snug">
          {items.length > 1 ? L.RECOVERED_DETAIL_MANY : L.RECOVERED_DETAIL}
        </div>
      )}
      {items.length > 0 && (
        <div className="min-h-0 max-h-[50vh] overflow-y-auto rounded-md bg-surface2 p-3 flex flex-col gap-3 select-text">
          {items.map((r) => (
            <div key={r.folder} className="flex flex-col gap-1">
              <span className="text-xs text-muted">{r.summary}</span>
              <span className="text-md text-on-surface leading-relaxed whitespace-pre-wrap">
                {r.transcript !== '' ? r.transcript : L.RECOVERED_NO_WORDS}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 mt-1">
        <Button variant="ghost" onClick={close}>
          {L.RECOVERED_LATER}
        </Button>
        {newest && (
          <Button
            variant="ghost"
            onClick={() => {
              close()
              onOpen(newest.folder)
            }}
          >
            {L.RECOVERED_OPEN}
          </Button>
        )}
        {text !== '' && (
          <Button autoFocus variant={copied ? 'success' : 'primary'} onClick={copy} disabled={copied}>
            {copied ? L.RECOVERED_COPIED : L.RECOVERED_COPY}
          </Button>
        )}
      </div>
    </Modal>
  )
}
