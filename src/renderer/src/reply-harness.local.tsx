import './index.css'
import { createRoot } from 'react-dom/client'
import ReplyApp, { REPLY_AGENT_KEY } from './ReplyApp'
import { injectTheme } from './theme'
import { ReplyScreenContext } from './components/session-thread'

injectTheme()
const params = new URLSearchParams(location.search)
const agent = params.get('aim') ?? params.get('stay')
if (agent) localStorage.setItem(REPLY_AGENT_KEY, agent)
else localStorage.removeItem(REPLY_AGENT_KEY)
createRoot(document.getElementById('root') as HTMLElement).render(
  <ReplyScreenContext.Provider value={{ on: true, setOn: () => {} }}>
    <ReplyApp onHide={() => document.body.setAttribute('data-hidden', '')} />
  </ReplyScreenContext.Provider>
)
if (params.get('menu')) setTimeout(() => document.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.click(), 600)
