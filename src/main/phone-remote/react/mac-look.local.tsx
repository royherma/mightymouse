import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { hostDeviceFrom, type HostDevice } from '@shared/phone-remote-keys'
import { KEYBOARD_LAYOUT_ID } from './keyboard-layouts'
import MacLookView, { macLookLabel, type MacLookMic } from './MacLookView'
import './theme.css'
import './ai/ai.css'

const MACS: { model: string; machineName: string }[] = [
  { model: 'MacBookPro18,2', machineName: 'MacBook Pro' },
  { model: 'Mac15,12', machineName: 'MacBook Air' },
  { model: 'MacBookAir10,1', machineName: 'MacBook Air' },
  { model: 'Mac14,13', machineName: 'Mac Studio' }
]

const NOOP = (): void => {}
const NO_STREAM = { current: null }
const MIC_STATES = ['idle', 'recording', 'hands-free'] as const
type MicState = (typeof MIC_STATES)[number]

function micFor(state: MicState): MacLookMic {
  return {
    recording: state === 'recording',
    micLatched: state === 'recording',
    handsFree: state === 'hands-free' ? 'listening' : 'off',
    handsFreeSpeaking: state === 'hands-free',
    micStreamRef: NO_STREAM,
    handsFreeStreamRef: NO_STREAM,
    micSidePress: NOOP,
    disarmHandsFree: NOOP
  }
}

function FakeMacScreen(): React.JSX.Element {
  return (
    <div className="mirrorPane proMirrorPane">
      <div className="mlFixtureScreen">
        <div className="mlFixtureMenu">
          <b></b>
          <b>Finder</b>
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <i>Wed 4 Nov 16:10</i>
        </div>
        <div className="mlFixtureWindow">
          <div className="mlFixtureDots">
            <span />
            <span />
            <span />
          </div>
          <div className="mlFixtureTitle">Notes</div>
          <p>Groceries - eggs, coffee, oat milk</p>
          <p>Call mum on Sunday</p>
        </div>
        <div className="mlFixtureDock">
          {['#4aa3ff', '#ffb02e', '#34c759', '#ff375f', '#af52de', '#8e8e93'].map((c) => (
            <span key={c} style={{ background: c }} />
          ))}
        </div>
      </div>
    </div>
  )
}

function Phone({
  device,
  sideways,
  micState
}: {
  device: HostDevice
  sideways: boolean
  micState: MicState
}): React.JSX.Element {
  const [lastKey, setLastKey] = useState('-')
  return (
    <figure className="mlFixtureCell">
      <div className={`mlFixturePhone${sideways ? ' sideways' : ''}`}>
        <div className="proRoot">
          <div className="ai">
            <MacLookView
              pane={<FakeMacScreen />}
              device={device}
              macName={`Pat's ${device.name}`}
              isLandscape={sideways}
              mic={micFor(micState)}
              layoutId={KEYBOARD_LAYOUT_ID.macUs}
              send={NOOP}
              onStop={NOOP}
              onOpenSettings={NOOP}
              onChar={(t) => setLastKey(JSON.stringify(t))}
              onBackspace={() => setLastKey('delete')}
              onSpecialKey={(k) => setLastKey(k)}
              onCombo={(m, k) => setLastKey([...m, k].join('+'))}
            />
          </div>
        </div>
      </div>
      <figcaption>
        <b>{macLookLabel(device)}</b> · {device.notch ? 'notch' : 'no notch'} · last key {lastKey}
      </figcaption>
    </figure>
  )
}

function Page(): React.JSX.Element {
  const [sideways, setSideways] = useState(false)
  const [micState, setMicState] = useState<MicState>('idle')
  return (
    <main className="mlFixturePage">
      <header>
        <h1>Mac look - the phone drawn as the Mac it controls</h1>
        <button type="button" onClick={() => setSideways((s) => !s)}>
          {sideways ? 'Upright' : 'Turn sideways'}
        </button>
        <button
          type="button"
          onClick={() => setMicState((m) => MIC_STATES[(MIC_STATES.indexOf(m) + 1) % MIC_STATES.length])}
        >
          Mic: {micState}
        </button>
      </header>
      <div className={`mlFixtureGrid${sideways ? ' sideways' : ''}`}>
        {MACS.map((m) => (
          <Phone
            key={m.model}
            device={hostDeviceFrom(m.machineName, m.model)}
            sideways={sideways}
            micState={micState}
          />
        ))}
      </div>
    </main>
  )
}

const style = document.createElement('style')
style.textContent = `
html, body { margin: 0; background: #e9e7e3; font: 13px -apple-system, system-ui, sans-serif; color: #2a2724; }
.mlFixturePage { padding: 12px 20px; }
.mlFixturePage header { display: flex; align-items: center; gap: 14px; height: 36px; }
.mlFixturePage h1 { font-size: 16px; margin: 0; }
.mlFixturePage header button { padding: 6px 12px; border-radius: 8px; border: 1px solid #c9c4bd; background: #fff; cursor: pointer; }
.mlFixtureGrid { display: grid; grid-template-columns: repeat(4, 331px); gap: 18px; margin-top: 10px; }
.mlFixtureGrid.sideways { grid-template-columns: repeat(2, 717px); }
.mlFixtureCell { margin: 0; }
.mlFixtureCell figcaption { margin-top: 6px; font-size: 12px; }
.mlFixturePhone { width: 390px; height: 844px; transform: scale(0.85); transform-origin: 0 0; margin-bottom: -127px; margin-right: -59px; border-radius: 48px; overflow: hidden; box-shadow: 0 0 0 10px #1b1b1d; }
.mlFixturePhone.sideways { width: 844px; height: 390px; margin-bottom: -59px; margin-right: -127px; }
.mlFixturePhone .proRoot { position: relative; width: 100%; height: 100%; }
.mlFixturePhone .ai { position: absolute; }
.mlFixtureScreen { position: absolute; inset: 0; background: url(/fixtures-media/shot-wide.png) center / cover; font-size: 5.5px; color: #fff; }
.mlFixtureMenu { display: flex; gap: 6px; align-items: center; height: 9px; padding: 0 6px; background: rgba(20,30,60,.45); }
.mlFixtureMenu i { margin-left: auto; font-style: normal; }
.mlFixtureWindow { position: absolute; left: 22%; top: 20%; width: 52%; height: 50%; border-radius: 4px; background: #fdfcf8; color: #222; padding: 4px 7px; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
.mlFixtureDots { display: flex; gap: 2px; }
.mlFixtureDots span { width: 4px; height: 4px; border-radius: 50%; background: #ff5f57; }
.mlFixtureDots span:nth-child(2) { background: #febc2e; }
.mlFixtureDots span:nth-child(3) { background: #28c840; }
.mlFixtureTitle { font-weight: 600; font-size: 7px; margin: 3px 0; }
.mlFixtureWindow p { margin: 2px 0; }
.mlFixtureDock { position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%); display: flex; gap: 3px; padding: 2px 4px; border-radius: 5px; background: rgba(255,255,255,.25); }
.mlFixtureDock span { width: 9px; height: 9px; border-radius: 2px; }
`
document.head.appendChild(style)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>
)
