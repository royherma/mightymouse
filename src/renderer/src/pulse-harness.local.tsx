import './index.css'
import { createRoot } from 'react-dom/client'
import { SessionDetail } from './components/session-detail'
import { injectTheme } from './theme'

injectTheme()
createRoot(document.getElementById('root') as HTMLElement).render(
  <SessionDetail
    session={{ label: 'Right panel browser', sessionId: 'a3', cwd: '/Users/roy/Development/ShowAndTell', agent: 'claude', since: Date.now() - 3_900_000 }}
    history={[]}
    onRespond={() => {}}
    onBack={() => {}}
    withRail={new URLSearchParams(location.search).has('rail')}
  />
)
