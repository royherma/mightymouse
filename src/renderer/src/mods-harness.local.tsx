import './index.css'
import './components/side-browser.css'
import { StrictMode, useEffect, useRef, type JSX, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { ModOffers, ModsMenu } from './components/side-browser-mods'
import { SharedModBar } from './components/side-browser-shared-mods'
import type { SharedMod, SharedModRequest, SharedModResult, SiteModState } from '../../shared/types'
import { injectTheme } from './theme'

const shared = (over: Partial<SharedMod> & { name: string }): SharedMod => ({
  id: over.name.replace(/\W/g, '').toUpperCase().padEnd(10, '0').slice(0, 10),
  host: 'youtube.com',
  summary: '',
  kind: 'look',
  asks: [],
  status: 'live',
  statusReason: null,
  installs: 0,
  fingerprint: '',
  maker: { name: 'Alice Park', verified: true },
  ...over
})

const NO_SHORTS = shared({ name: 'No Shorts', summary: 'Hides Shorts everywhere on YouTube', installs: 412 })
const SKIP_ADS = shared({
  name: 'Skip button for me',
  summary: 'Presses Skip the moment it shows',
  kind: 'code',
  asks: ['presses buttons on the site for you'],
  maker: { name: 'Ben', verified: false }
})
const SPEED = shared({ name: 'Speed boost', summary: 'Makes the page faster', kind: 'code', maker: { name: 'Mallory', verified: false } })

const mine = (over: Partial<SiteModState> & { name: string }): SiteModState => ({
  id: over.name,
  host: 'youtube.com',
  on: true,
  kind: 'look',
  asks: [],
  ...over
})

const WIDE = mine({ name: 'Wide player' })
const LINK = 'https://app.getmightymouse.com/m/7K2M9QX4TB'
const SHARED_WIDE = mine({ name: 'Wide player', shared: { id: '7K2M9QX4TB', url: LINK, maker: 'techguyver', verified: false, mine: true, status: 'live' } })
const FROM_BEN = mine({ name: 'Skip button for me', kind: 'code', asks: SKIP_ADS.asks, shared: { id: SKIP_ADS.id, url: LINK, maker: 'Ben', verified: false, mine: false, status: 'live' } })
const PULLED = mine({
  name: 'Clean sidebar',
  on: false,
  pulled: 'It hid the Sign out button',
  shared: { id: 'PULLED0000', url: LINK, maker: 'Dana', verified: false, mine: false, status: 'pulled' }
})
const QUICK_REPLY = mine({ name: 'Quick reply', host: 'x.com', kind: 'code', builtIn: true })

type Answer = (request: SharedModRequest) => SharedModResult

function useApi(list: SiteModState[], answer: Answer): void {
  ;(window as unknown as { api: unknown }).api = {
    sideBrowser: {
      mod: async () => list,
      sharedMod: async (_id: string, request: SharedModRequest) => answer(request)
    }
  }
}

export function Frame({ title, clicks = [], tall, children }: { title: string; clicks?: string[]; tall?: boolean; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      for (const label of clicks) {
        await new Promise((r) => setTimeout(r, 350))
        if (!live) return
        const button = [...(ref.current?.querySelectorAll('button') ?? [])].find(
          (b) => b.getAttribute('aria-label') === label || b.innerText.trim() === label
        )
        button?.click()
      }
    })()
    return () => {
      live = false
    }
  }, [clicks])
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <h2 style={{ margin: 0, font: '600 12px system-ui', color: 'var(--muted)' }}>{title}</h2>
      <div
        ref={ref}
        className="side-browser"
        style={{ position: 'relative', minHeight: tall ? 300 : 96, padding: 8, borderRadius: 10, background: 'var(--surface2)', containerType: 'normal' }}
      >
        {children}
      </div>
    </section>
  )
}

export function Bar({ mod, answer }: { mod: SharedMod; answer: Answer }): JSX.Element {
  useApi([], answer)
  return <SharedModBar viewId="v" mod={mod} onDecline={() => undefined} />
}

export function Menu({ list, answer, offers = [] }: { list: SiteModState[]; answer: Answer; offers?: SharedMod[] }): JSX.Element {
  useApi(list, answer)
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <ModsMenu viewId="v" here={list.filter((m) => m.host === 'youtube.com')} suggestion={undefined} shared={offers} onEdit={() => undefined} />
    </div>
  )
}

const ok: Answer = () => ({ ok: true })

export function One({ which }: { which: string }): JSX.Element {
  switch (which) {
    case 'offer':
      return <Bar mod={NO_SHORTS} answer={ok} />
    case 'asks':
      return <Bar mod={SKIP_ADS} answer={(r) => (r.do === 'add' && !r.yes ? { ok: false, needsYes: SKIP_ADS.asks } : { ok: true })} />
    case 'refused':
      return <Bar mod={SPEED} answer={() => ({ ok: false, message: 'MightyMouse stopped this mod: it talks to the internet.' })} />
    case 'starter':
      return <ModOffers viewId="v" link={undefined} shared={[]} suggestion="Hide Shorts everywhere on YouTube" onTry={() => undefined} />
    case 'menu':
      return <Menu list={[WIDE, QUICK_REPLY]} offers={[NO_SHORTS, SKIP_ADS]} answer={ok} />
    case 'share':
      return <Menu list={[WIDE, QUICK_REPLY]} answer={() => ({ ok: false, needsName: true })} />
    case 'shared':
      return <Menu list={[SHARED_WIDE, QUICK_REPLY]} answer={ok} />
    default:
      return <Menu list={[FROM_BEN, PULLED, QUICK_REPLY]} answer={ok} />
  }
}

const CARDS: Array<{ which: string; title: string; clicks?: string[]; tall?: boolean }> = [
  { which: 'offer', title: '1. A site with a mod from someone else offers it' },
  { which: 'asks', title: '2. A mod with code says what it can do first', clicks: ['Add'] },
  { which: 'refused', title: '3. A dangerous mod is stopped, with the reason', clicks: ['Add'] },
  { which: 'starter', title: '4. No shared mods yet: our own idea for the site' },
  { which: 'menu', title: '5. Mods menu: from other people, then yours', clicks: ['Mods'], tall: true },
  { which: 'share', title: '6. Share your own: first time asks a maker name', clicks: ['Mods', 'Share Wide player', 'Share'], tall: true },
  { which: 'shared', title: '7. Shared: copy the link or stop sharing', clicks: ['Mods', 'Share Wide player'], tall: true },
  { which: 'pulled', title: '8. Pulled by MightyMouse, and reporting one', clicks: ['Mods', 'Report Skip button for me'], tall: true }
]

export function App(): JSX.Element {
  const only = CARDS.find((c) => c.which === new URLSearchParams(location.search).get('card'))
  if (only)
    return (
      <main style={{ padding: 10, background: 'var(--bg)', minHeight: '100vh', boxSizing: 'border-box' }}>
        <Frame title={only.title} clicks={only.clicks} tall={only.tall}>
          <One which={only.which} />
        </Frame>
      </main>
    )
  return (
    <main style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, padding: 12, background: 'var(--bg)', minHeight: '100vh', boxSizing: 'border-box', alignContent: 'start' }}>
      {CARDS.map((c) => (
        <iframe key={c.which} title={c.title} src={`?card=${c.which}`} style={{ border: 0, width: '100%', height: c.tall ? 400 : 190 }} />
      ))}
    </main>
  )
}

injectTheme()
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
