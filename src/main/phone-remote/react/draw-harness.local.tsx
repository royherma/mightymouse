import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import type { InkOp } from '@shared/ink'
import type { PhoneRemoteMessage } from '@shared/phone-remote-protocol'
import { createSocketBus } from './socket-bus'
import DrawPage from './DrawPage'
import { Button } from '@shared/ui/Button'
import './theme.css'

// ?side=phone (default) is the Draw page; ?side=mac is the Mac ink layer. Two tabs talk over a BroadcastChannel.
const side = new URLSearchParams(location.search).get('side') ?? 'phone'
const channel = new BroadcastChannel('mm-draw-harness')
const SCREEN = { width: 1512, height: 982 }

for (const [key, val] of Object.entries(CONFIG.THEME_TOKENS)) {
  document.documentElement.style.setProperty(
    `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`,
    val
  )
}

function fakeScreen(): string {
  const c = document.createElement('canvas')
  c.width = 1512
  c.height = 982
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 1512, 982)
  g.addColorStop(0, '#2b3a55')
  g.addColorStop(1, '#6a4c7d')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 1512, 982)
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillRect(160, 120, 1190, 720)
  ctx.fillStyle = '#1c1a18'
  ctx.font = 'bold 56px -apple-system, sans-serif'
  ctx.fillText('Pricing page', 220, 230)
  ctx.font = '32px -apple-system, sans-serif'
  ctx.fillText('Starter  $9      Pro  $29      Team  $99', 220, 330)
  ctx.fillStyle = '#c2501a'
  ctx.fillRect(220, 420, 300, 80)
  return c.toDataURL('image/jpeg', 0.85)
}

export function PhoneSide(): React.JSX.Element {
  const [bus] = useState(createSocketBus)
  const [open, setOpen] = useState(true)
  const send = (msg: PhoneRemoteMessage): void => {
    if (msg.type === 'ink') {
      channel.postMessage({ kind: 'op', op: msg.ink })
      if (msg.ink.op === 'snapshot') {
        const fail = new URLSearchParams(location.search).has('noshot')
        window.setTimeout(
          () => bus.dispatch({ type: 'inkBackdrop', image: fail ? null : fakeScreen(), ...SCREEN }),
          500
        )
      }
    }
  }
  const sendBinary = (data: ArrayBuffer): boolean => {
    channel.postMessage({ kind: 'sent', data })
    window.setTimeout(
      () =>
        bus.dispatch({ type: 'inkSent', ok: !new URLSearchParams(location.search).has('fail') }),
      400
    )
    return true
  }
  if (!open) return <Button onClick={() => setOpen(true)}>Open Draw again</Button>
  return <DrawPage bus={bus} send={send} sendBinary={sendBinary} onClose={() => setOpen(false)} />
}

export function MacSide(): React.JSX.Element {
  const [InkApp, setInkApp] = useState<React.ComponentType | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  useEffect(() => {
    const listeners = new Set<(op: InkOp) => void>()
    ;(window as unknown as { api: unknown }).api = {
      onInkOp: (cb: (op: InkOp) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    }
    channel.onmessage = (e: MessageEvent<{ kind: string; op?: InkOp; data?: ArrayBuffer }>) => {
      if (e.data.kind === 'op' && e.data.op) listeners.forEach((l) => l(e.data.op!))
      if (e.data.kind === 'sent' && e.data.data)
        setSent(URL.createObjectURL(new Blob([e.data.data], { type: 'image/jpeg' })))
    }
    void import('../../../renderer/src/InkApp').then((m) => setInkApp(() => m.default))
  }, [])
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#555' }}>
      <img
        src={fakeScreen()}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      {InkApp && <InkApp />}
      {sent && (
        <img
          id="sent"
          src={sent}
          style={{
            position: 'absolute',
            right: 12,
            bottom: 12,
            width: 360,
            border: '3px solid #fff'
          }}
        />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{side === 'mac' ? <MacSide /> : <PhoneSide />}</StrictMode>
)
