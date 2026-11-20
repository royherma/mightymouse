import { StrictMode, useEffect, useRef, useState } from 'react'
import { History, Laptop } from 'lucide-react'
import { createRoot } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import { COMPUTER_OPTION, TALK, TALK_LABELS } from '@shared/talk'
import type { TalkOptionWire } from '@shared/phone-remote-protocol'
import { Button } from '@shared/ui/Button'
import TalkSheet from './TalkSheet'
import type { TalkState, TalkTurnView } from './hooks/use-talk'
import './theme.css'
import './ai/ai.css'

// ?state= or #state= one of: button|empty|listening|deciding|counting|choosing|running|done|photo|failed|all
function stateFromUrl(): string {
  return location.hash.slice(1) || new URLSearchParams(location.search).get('state') || 'all'
}

for (const [key, val] of Object.entries(CONFIG.THEME_TOKENS)) {
  document.documentElement.style.setProperty(
    `--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`,
    val
  )
}

const computer: TalkOptionWire = { ...COMPUTER_OPTION, percent: 22 }
const api: TalkOptionWire = {
  id: 'a1',
  kind: 'agent',
  label: 'api-server',
  detail: 'fix-login · Running tests',
  percent: 61,
  project: { name: 'Api' }
}
const docs: TalkOptionWire = {
  id: 'n1',
  kind: 'new-agent',
  label: 'Docs',
  detail: 'Starts fresh with just this',
  percent: 17,
  project: { name: 'Docs' }
}

function turn(id: string, text: string, over: Partial<TalkTurnView>): TalkTurnView {
  return {
    id,
    text,
    phase: 'deciding',
    pick: TALK.COMPUTER_ID,
    options: [computer],
    goAt: 0,
    steps: [],
    streamed: '',
    reply: '',
    target: '',
    ...over
  }
}

const FIXTURES: Record<string, TalkTurnView> = {
  deciding: turn('d', 'Tell the api agent the tests pass now', {}),
  counting: turn('c', 'Tell the api agent the tests pass now', {
    phase: 'counting',
    pick: 'a1',
    options: [api, computer],
    goAt: Date.now() + 60_000
  }),
  choosing: turn('ch', 'Write a short readme for the new endpoint', {
    phase: 'choosing',
    pick: 'a1',
    options: [api, docs, computer]
  }),
  running: turn('r', 'Open Spotify and play something calm', {
    phase: 'running',
    target: COMPUTER_OPTION.label,
    steps: [
      { phase: 'Looking at the screen', detail: '', n: 1 },
      { phase: 'Opening Spotify', detail: 'open -a Spotify', n: 1 },
      { phase: 'Searching', detail: 'calm focus playlist', n: 1 }
    ],
    streamed: 'Found a playlist called Calm Focus.'
  }),
  done: turn('dn', "What's taking up space on my disk?", {
    phase: 'done',
    reply: 'Your **Downloads** folder is the biggest at **38 GB**.\n\n- Mostly old installers (.dmg)\n- Movies is next at 21 GB\n- Trash is empty',
    target: TALK_LABELS.done_.computer,
    media: { sessionId: 's1', turn: 0, items: [{ item: 0, kind: 'image', name: 'downloads.png' }, { item: 1, kind: 'image', name: 'movies.png' }] }
  }),
  photo: turn('p', 'What plant is this?', {
    phase: 'done',
    reply: 'A monstera. Water it once a week and keep it out of direct sun.',
    target: TALK_LABELS.done_.computer,
    photo: '/harness-photo.jpg'
  }),
  sent: turn('s', 'Tell the api agent the tests pass now', {
    phase: 'done',
    reply: TALK_LABELS.agentHasIt,
    target: `${TALK_LABELS.done_.agent} api-server`,
    openLabel: 'api-server'
  }),
  failed: turn('f', 'Empty the trash', {
    phase: 'failed',
    reply: TALK_LABELS.notConnected,
    target: ''
  })
}

function turnsFor(name: string): TalkTurnView[] {
  if (name === 'all')
    return [FIXTURES.done, FIXTURES.sent, FIXTURES.failed, FIXTURES.running, FIXTURES.choosing]
  const one = FIXTURES[name]
  return one ? [one] : []
}

export function Harness(): React.JSX.Element {
  const [state, setState] = useState(stateFromUrl)
  const [open, setOpen] = useState(state !== 'button')
  useEffect(() => {
    const onHash = (): void => {
      const next = stateFromUrl()
      setState(next)
      setOpen(next !== 'button')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const micStreamRef = useRef<MediaStream | null>(null)
  const log =
    (what: string) =>
    (...args: unknown[]) =>
      console.log(`[talk] ${what}`, ...args)
  const talk: TalkState = {
    turns: turnsFor(state),
    ideas: ['Play something calm on Spotify', 'How is my ShowAndTell agent doing?', 'Sum up the page I have open'],
    say: (text) => {
      log('say')(text)
      return true
    },
    go: log('go'),
    change: log('change'),
    cancel: log('cancel')
  }
  return (
    <div className="proRoot" data-orient={innerWidth > innerHeight ? 'landscape' : 'portrait'}>
      <Button variant="bare" className="historyBtn" aria-label="History">
        <History size={19} strokeWidth={2.25} />
        <span className="proBtnLabel">History</span>
      </Button>
      <Button
        variant="bare"
        className={`chatBtn talkBtn${open ? ' open' : ''}`}
        aria-label={TALK_LABELS.title}
        onClick={() => setOpen(true)}
      >
        <Laptop size={19} strokeWidth={2.25} />
        <span className="proBtnLabel">{TALK_LABELS.button}</span>
      </Button>
      <TalkSheet
        open={open}
        talk={talk}
        mic={{
          onMicDown: log('micDown'),
          onMicUp: log('micUp'),
          dictating: false,
          recording: state === 'listening',
          micStreamRef,
          draftPatch: null,
          onDraftConsumed: log('draftConsumed')
        }}
        macName="MacBook Pro (8)"
        onWatch={log('watch')}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
)
