import './index.css'
import { StrictMode, useEffect, type JSX, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { KokoroVoiceCard } from './components/KokoroVoiceCard'
import { injectTheme } from './theme'

/**
 * Visual harness for KokoroVoiceCard — the four states it can render, side by
 * side, against the real index.css and theme tokens.
 *
 * Exists because the card lives in the Settings window, which no existing
 * harness covers, and DESIGN.md rules 9-10 require reading actual pixels before
 * calling a UI change done. `?state=` picks which branch mounts; `?state=all`
 * stacks the static ones so one screenshot covers them.
 */

injectTheme()

const params = new URLSearchParams(window.location.search)
const state = params.get('state') || 'notinstalled'

/** Auto-clicks the install button so the downloading state can be captured. */
function AutoInstall(): null {
  useEffect(() => {
    const t = setTimeout(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) =>
        /free voice/i.test(b.textContent || '')
      )
      btn?.click()
    }, 300)
    return () => clearTimeout(t)
  }, [])
  return null
}

function Frame({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          font: '600 10px ui-monospace, monospace',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          marginBottom: 8
        }}
      >
        {label}
      </div>
      {/* A 1px outline shows the card's real bounds — that is what reveals a
          zero-width or overflowing child, which a borderless render hides. */}
      <div style={{ outline: '1px dashed var(--surface3)', padding: 12 }}>{children}</div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div
      className="settings-window"
      style={{ padding: 24, background: 'var(--bg)', minHeight: '100vh', width: 520 }}
    >
      {state === 'downloading' ? (
        <Frame label="downloading">
          <AutoInstall />
          <KokoroVoiceCard />
        </Frame>
      ) : (
        <Frame label={state}>
          <KokoroVoiceCard />
        </Frame>
      )}
    </div>
  </StrictMode>
)
