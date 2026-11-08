import './ai/phone-kit.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CONFIG } from '@shared/config'
import type { AgentRelaySessionInfo, AgentChecklist, AgentHelper } from '@shared/types'
import type { RelayProjectWire, RelayRequestWire } from '@shared/phone-remote-protocol'
import type { ProjectIdea } from '@shared/project-ideas'
import { scoreDecision, type DecisionWeights } from '@shared/decision-score'
import type { ChatSessionSummary } from './chat-steps'
import { AiHome, ModelPicker, ProjectPicker } from './ai/AiHome'
import { Welcome } from './FirstSteps'
import { Conversation } from './ai/Conversation'
import { KEYS_KEY, ScreenView } from './ai/ScreenView'
import MicInputBadge from './MicInputBadge'
import MirrorAudioBadge from './MirrorAudioBadge'
import { DecisionCard } from './ai/DecisionCard'
import { SessionInfoSheet } from './ai/SessionInfoSheet'
import { MediaViewer } from './ai/MediaViewer'
import type { MediaRef, SessionInfoWire, ThreadItem } from './ai/use-ai-session'
import './theme.css'
import './ai/ai.css'
import './ai.local.css'
import mmLogo from './harness-logos/mightymouse.png?inline'
import acmeLogo from './harness-logos/acme.png?inline'

function injectTheme(): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(CONFIG.THEME_TOKENS)) {
    root.style.setProperty(`--${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`, String(value))
  }
}
injectTheme()
localStorage.setItem(KEYS_KEY, '0')

const NOW = Date.UTC(2026, 8, 26, 15, 0, 0)
const MIN = 60_000

function session(over: Partial<AgentRelaySessionInfo> & { label: string }): AgentRelaySessionInfo {
  return {
    since: NOW - 18 * MIN,
    sessionId: `sess-${over.label}`,
    agent: 'claude',
    model: 'Opus 5',
    effort: 'high',
    pid: 4242,
    ...over
  }
}

function request(
  over: Partial<RelayRequestWire> & { verb: RelayRequestWire['verb']; from: string }
): RelayRequestWire {
  const { from, ...rest } = over
  return {
    id: rest.id ?? `req-${from}`,
    verb: rest.verb,
    params: { from, ...(rest.params ?? {}) },
    createdAt: rest.createdAt ?? Date.now() - 3 * MIN,
    timeoutMs: rest.timeoutMs ?? 10 * MIN,
    status: rest.status ?? 'pending',
    response: rest.response ?? null
  }
}

const base64 = (dataUrl: string): string => dataUrl.slice(dataUrl.indexOf(',') + 1)
const PROJECT_MM: RelayProjectWire = {
  id: 'p-mm',
  name: 'ShowAndTell',
  folderName: 'ShowAndTell',
  imageBase64: base64(mmLogo)
}
const PROJECT_GROWTH: RelayProjectWire = {
  id: 'p-growth',
  name: 'acme',
  folderName: 'acme-growth',
  pinned: true,
  imageBase64: base64(acmeLogo)
}
const PROJECTS = [PROJECT_GROWTH, PROJECT_MM]

const IDEAS: ProjectIdea[] = [
  {
    kind: 'fix',
    emoji: '🐛',
    label: 'Fix the Windows updater 404',
    prompt: 'Fix the Windows updater feed 404',
    why: 'Blocks every existing install from seeing a new build'
  },
  {
    kind: 'next',
    emoji: '✍️',
    label: 'Draft the 0.40.6 release notes',
    prompt: 'Draft release notes for 0.40.6',
    why: 'Leads with the benefit, not the mechanism'
  },
  {
    kind: 'try',
    emoji: '🧪',
    label: 'Try a faster cold start',
    prompt: 'Profile app cold start and cut it in half',
    why: 'Startup is the first thing every new user judges'
  }
]

const NEEDS_SESSION = session({
  label: 'mm-billing-04 - ShowAndTell/main',
  stated: 'mm-billing-04',
  project: PROJECT_MM,
  waiting: 1,
  tldr: 'Waiting on which Stripe mode to test'
})

const IDLE_SESSION = session({
  label: 'mm-dev-735 - ShowAndTell/dev',
  stated: 'mm-dev-735',
  project: PROJECT_MM,
  idleSince: NOW - 3 * MIN,
  tldr: 'Porting the swipe deck to the Mac'
})

const GROWTH_SESSION = session({
  label: 'acme-ads-021 - acme/growth',
  stated: 'acme-ads-021',
  project: PROJECT_GROWTH,
  progress: 0.64,
  since: NOW - 6 * MIN,
  tldr: 'Planning this week of ad tests'
})

const SESSIONS: AgentRelaySessionInfo[] = [NEEDS_SESSION, IDLE_SESSION, GROWTH_SESSION]

const CHAT_SESSIONS: ChatSessionSummary[] = [
  {
    id: 'c1',
    title: 'Why is the phone dropping the socket on wifi handoff',
    updated: new Date(NOW - 5 * MIN).toISOString(),
    messageCount: 11,
    preview: 'Reading src/main/phone-remote/socket-admission.ts',
    running: true,
    phase: 'Reading  socket-admission.ts',
    project: PROJECT_MM,
    group: 1
  },
  {
    id: 'c2',
    title: 'Draft the release notes for 0.40.6',
    updated: new Date(NOW - 90 * MIN).toISOString(),
    messageCount: 6,
    preview: "Here's a version that leads with the benefit rather than the mechanism…",
    running: false,
    project: PROJECT_MM,
    group: 1
  },
  {
    id: 'c3',
    title: 'What does the idle-autocommit hook do',
    updated: new Date(NOW - 26 * 60 * MIN).toISOString(),
    messageCount: 3,
    preview: 'It commits your changed files as "wip:" after 60s idle.',
    running: false,
    group: 2
  }
]

const CONVO_ITEMS: ThreadItem[] = [
  {
    kind: 'you',
    key: 'q0',
    at: 0,
    text: 'what is this thing on my screen saying',
    media: [{ key: 'y0', src: '/fixtures-media/photo-1.png', name: 'IMG_4821.png' }]
  },
  {
    kind: 'steps',
    key: 's0',
    at: 1,
    texts: [
      'Reading  src/main/updater/feed.ts',
      'Running command  curl -sI https://getmightymouse.com/latest.yml'
    ]
  },
  {
    kind: 'agent',
    key: 'a0',
    at: 2,
    recap: 'Chasing the Windows updater 404 before the 0.40.6 post',
    text: "That's the updater failing to reach the release feed - the app is fine, it just can't check for a new version. Here's the release page, Windows row is the empty one.",
    media: [{ key: 'a0m', src: '/fixtures-media/shot-wide.png', name: 'screenshot.png' }]
  },
  {
    kind: 'you',
    key: 'q1',
    at: 3,
    text: 'here are the four screens I get, in order',
    media: [
      { key: 'y1a', src: '/fixtures-media/photo-1.png', name: 'a.png' },
      { key: 'y1b', src: '/fixtures-media/photo-2.png', name: 'b.png' },
      { key: 'y1c', src: '/fixtures-media/photo-3.png', name: 'c.png' },
      { key: 'y1d', src: '/fixtures-media/photo-4.png', name: 'd.png' }
    ]
  },
  {
    kind: 'agent',
    key: 'a1',
    at: 4,
    text: 'All four are the same failure at different stages. The third one is the useful one: it names the missing file.',
    media: []
  }
]

const ASK_ONE = request({
  verb: 'ask',
  from: 'mm-billing-04',
  params: {
    question: 'Use Stripe test mode for this run?',
    options: ['Yes, test mode', 'No, use live'],
    canReadPane: true
  }
})

const ASK_THREE = request({
  verb: 'ask',
  from: 'mm-release-09',
  params: {
    questions: [
      { question: 'Which environment?', options: ['Staging', 'Production'] },
      { question: 'Run the full test suite first?', options: ['Yes', 'No'] },
      { question: 'Who should I notify when it finishes?' }
    ],
    canReadPane: true,
    buffered: []
  }
})

const ASK_THREE_ANSWERED = request({
  ...ASK_THREE,
  id: 'req-mm-release-09-answered',
  from: 'mm-release-09',
  params: {
    ...ASK_THREE.params,
    buffered: [
      { index: 0, answer: 'Staging' },
      { index: 1, answer: 'Yes' },
      { index: 2, answer: 'Post in the release channel' }
    ]
  }
})

const ASK_PICK_SEVERAL = request({
  verb: 'ask',
  from: 'mm-docs-02',
  params: {
    questions: [
      {
        question: 'Which docs need updating for this change?',
        options: ['README', 'API reference', 'Changelog', 'Onboarding guide'],
        multiSelect: true
      }
    ],
    canReadPane: true,
    buffered: []
  }
})

const RAMP_WEIGHTS: DecisionWeights = { fast: 20, cheap: 25, undo: 15, lasts: 30, handsoff: 10 }
const RAMP_SCORES = [
  [80, 75, 55, 80, 80],
  [75, 50, 95, 60, 75],
  [100, 40, 90, 20, 100]
]
const rampAsk = (youIdx: number): RelayRequestWire =>
  request({
    verb: 'ask',
    from: GROWTH_SESSION.label,
    params: {
      question: 'No cheap US-warehouse version of the ramp. What now?',
      context:
        'Only a UK seller stocks this ramp, so US orders ship slow. I found a US-warehouse twin (CJDS2170238). The ramp is listed at $94.99.',
      options: ['Add the US twin, unpublish the ramp', 'Add the US twin, keep the ramp', 'Leave it as is'],
      hasImage: true,
      canReadPane: true,
      decision: {
        weights: RAMP_WEIGHTS,
        scores: RAMP_SCORES,
        notes: { lasts: 'Slow UK shipping means bad reviews', cheap: 'Two listings, more ad spend' },
        ...scoreDecision(RAMP_WEIGHTS, RAMP_SCORES),
        youIdx,
        youWeights: { fast: 15, cheap: 15, undo: 40, lasts: 20, handsoff: 10 },
        history: { agreed: 14, of: 20 }
      }
    }
  })
const ASK_RAMP = rampAsk(1)
const ASK_AGREE = rampAsk(0)

const CHECKLIST: AgentChecklist = {
  goal: 'Fix the Windows updater feed 404 before the 0.40.6 post',
  done: 2,
  items: [
    { label: 'Read the release job and feed writer', status: 'completed' },
    { label: 'Reproduce the 404 against latest.yml', status: 'completed' },
    { label: 'Confirm which Stripe mode to test with', status: 'in_progress', waiting: true },
    { label: 'Ship the glob fix and verify the feed', status: 'pending' }
  ]
}

const HELPERS: AgentHelper[] = [
  { task: 'Grep the release workflows', doing: 'Running ripgrep', since: NOW - 90_000 }
]

const INFO: SessionInfoWire = {
  label: NEEDS_SESSION.label,
  checklist: CHECKLIST,
  helpers: HELPERS,
  tools: [
    { name: 'Read', kind: 'builtin', calls: 14, lastAt: NOW - 30_000 },
    { name: 'Bash', kind: 'builtin', calls: 6, lastAt: NOW - 45_000 },
    { name: 'Edit', kind: 'builtin', calls: 3, lastAt: NOW - 60_000 }
  ],
  mcpList: [
    { name: 'stripe', scope: 'project' },
    { name: 'sentry', scope: 'user' }
  ]
}

const NOOP = (): void => {}
const IDLE_MIC = { onMicDown: NOOP, onMicUp: NOOP, dictating: false, recording: false, micStreamRef: { current: null }, draftPatch: null, onDraftConsumed: NOOP }

function Panel({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="aiPanelLabel">{label}</div>
      <div className="aiPhone">{children}</div>
    </div>
  )
}

function Harness(): React.JSX.Element {
  const waitingFor = (s: AgentRelaySessionInfo): number => s.waiting ?? 0
  const isPinned = (s: AgentRelaySessionInfo): boolean => s.label === IDLE_SESSION.label

  return (
    <div className="aiGrid">
      <Panel label="0. Home — first time: the welcome">
        <div className="ai" role="dialog" aria-label="AI">
          <AiHome
            mode="chat"
            onMode={NOOP}
            onClose={NOOP}
            onOpenSettings={NOOP}
            project={PROJECT_MM}
            onOpenPicker={NOOP}
            onRefreshIdeas={NOOP}
            onStart={NOOP}
            onStartIdea={NOOP}
            onChatAsk={NOOP}
            chatSessions={[]}
            onOpenChat={NOOP}
            recall={() => ({})}
            remember={NOOP}
            sessions={[]}
            waitingFor={waitingFor}
            isPinned={isPinned}
            onOpenSession={NOOP}
            needsCount={0}
            deckCount={0}
            onOpenDeck={NOOP}
            answeredCount={0}
            onOpenAnswered={NOOP}
            archivedCount={0}
            showArchived={false}
            onShowArchived={NOOP}
            thoughtRecording={false}
            onWatch={NOOP}
            linkOk
            startHere={<Welcome onPick={NOOP} />}
          />
        </div>
      </Panel>

      <Panel label="1. Home — Code mode: ideas, Needs you, recent agents">
        <div className="ai" role="dialog" aria-label="AI">
          <AiHome
            mode="code"
            onMode={NOOP}
            onClose={NOOP}
            onOpenSettings={NOOP}
            project={PROJECT_MM}
            onOpenPicker={NOOP}
            ideas={{ ideas: IDEAS, loading: false }}
            onRefreshIdeas={NOOP}
            onStart={NOOP}
            onStartIdea={NOOP}
            onChatAsk={NOOP}
            chatSessions={CHAT_SESSIONS}
            onOpenChat={NOOP}
            recall={() => ({})}
            remember={NOOP}
            sessions={SESSIONS}
            waitingFor={waitingFor}
            isPinned={isPinned}
            onOpenSession={NOOP}
            needsCount={1}
            deckCount={2}
            onOpenDeck={NOOP}
            answeredCount={5}
            onOpenAnswered={NOOP}
            archivedCount={3}
            showArchived={false}
            onShowArchived={NOOP}
            thoughtRecording={false}
            onWatch={NOOP}
            linkOk
          />
        </div>
      </Panel>

      <Panel label="2. Home — Chat mode: recent chats, one running">
        <div className="ai" role="dialog" aria-label="AI">
          <AiHome
            mode="chat"
            onMode={NOOP}
            onClose={NOOP}
            onOpenSettings={NOOP}
            project={PROJECT_MM}
            onOpenPicker={NOOP}
            models={{ current: 'opus', options: [{ id: 'opus', label: 'Opus 5', icon: 'claude' }] }}
            onOpenModels={NOOP}
            onRefreshIdeas={NOOP}
            onStart={NOOP}
            onStartIdea={NOOP}
            onChatAsk={NOOP}
            chatSessions={CHAT_SESSIONS}
            onOpenChat={NOOP}
            recall={() => ({})}
            remember={NOOP}
            sessions={SESSIONS}
            waitingFor={waitingFor}
            isPinned={isPinned}
            onOpenSession={NOOP}
            needsCount={1}
            deckCount={2}
            onOpenDeck={NOOP}
            answeredCount={5}
            onOpenAnswered={NOOP}
            archivedCount={3}
            showArchived={false}
            onShowArchived={NOOP}
            thoughtRecording={false}
            onWatch={NOOP}
            linkOk
          />
        </div>
      </Panel>

      <Panel label="3. Code conversation — inline images, a set of four, recap banner">
        <div className="ai" role="dialog" aria-label="AI">
          <Conversation
            title="mm-billing-04"
            subtitle="ShowAndTell/main"
            project={PROJECT_MM}
            health="working"
            items={CONVO_ITEMS}
            statusText={null}
            onBack={NOOP}
            onWatch={NOOP}
            onMore={NOOP}
            placeholder="Reply to Claude"
            canReply
            allowPhoto
            mic={IDLE_MIC}
            onSend={NOOP}
          />
        </div>
      </Panel>

      <Panel label="4. A single ask">
        <div className="ai" role="dialog" aria-label="AI">
          <div className="aiScroll">
            <div className="aiThread">
              <DecisionCard request={ASK_ONE} title={PROJECT_MM.name} onRespond={NOOP} imageSrc={() => ''} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel label="4b. A scored ask (ramp)">
        <div className="ai" role="dialog" aria-label="AI">
          <div className="aiScroll">
            <div className="aiThread">
              <DecisionCard request={ASK_RAMP} session={GROWTH_SESSION} onRespond={NOOP} imageSrc={() => '/fixtures-media/shot-wide.png'} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel label="4c. A scored ask (you agree)">
        <div className="ai" role="dialog" aria-label="AI">
          <div className="aiScroll">
            <div className="aiThread">
              <DecisionCard request={ASK_AGREE} session={GROWTH_SESSION} onRespond={NOOP} imageSrc={() => '/fixtures-media/shot-wide.png'} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel label="5. A 3-question ask">
        <div className="ai" role="dialog" aria-label="AI">
          <div className="aiScroll">
            <div className="aiThread">
              <DecisionCard request={ASK_THREE} title={PROJECT_MM.name} onRespond={NOOP} imageSrc={() => ''} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel label="5b. A 3-question ask, all answered">
        <div className="ai" role="dialog" aria-label="AI">
          <div className="aiScroll">
            <div className="aiThread">
              <DecisionCard request={ASK_THREE_ANSWERED} title={PROJECT_MM.name} onRespond={NOOP} imageSrc={() => ''} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel label="6. A pick-several ask">
        <div className="ai" role="dialog" aria-label="AI">
          <div className="aiScroll">
            <div className="aiThread">
              <DecisionCard request={ASK_PICK_SEVERAL} title={PROJECT_MM.name} onRespond={NOOP} imageSrc={() => ''} />
            </div>
          </div>
        </div>
      </Panel>

      <Panel label="7. Session info sheet">
        <div className="ai" role="dialog" aria-label="AI">
          <SessionInfoSheet
            session={NEEDS_SESSION}
            info={INFO}
            onRequestInfo={NOOP}
            onClose={NOOP}
            git={{
              state: {
                label: NEEDS_SESSION.label,
                op: 'status',
                github: true,
                dirty: 0,
                pull: { url: 'https://github.com/acme/app/pull/42', number: 42, state: 'open', base: 'main', blocker: 'GitHub is waiting on checks or a review.' },
                files: 7,
                added: 214,
                removed: 38
              },
              onAsk: NOOP,
              onClearNote: NOOP
            }}
            actions={{
              onGoTo: NOOP,
              onWatch: NOOP,
              onZoom: NOOP,
              onRaw: NOOP,
              showSteps: false,
              onSteps: NOOP,
              pinned: false,
              onPin: NOOP,
              archived: false,
              onArchive: NOOP
            }}
          />
        </div>
      </Panel>

      <Panel label="8. Project picker">
        <div className="ai" role="dialog" aria-label="AI">
          <ProjectPicker
            projects={PROJECTS}
            current={PROJECT_GROWTH.id}
            onPick={NOOP}
            onClose={NOOP}
          />
        </div>
      </Panel>

      <Panel label="8b. Model picker">
        <div className="ai" role="dialog" aria-label="AI">
          <ModelPicker
            models={{
              current: 'opus',
              options: [
                { id: 'opus', label: 'Opus 5', icon: 'claude' },
                { id: 'gpt', label: 'GPT-5', icon: 'codex' },
                { id: 'gemini', label: 'Gemini 3', icon: 'gemini' }
              ]
            }}
            title="Model"
            note="Your Mac chats use this model too"
            onPick={NOOP}
            onClose={NOOP}
          />
        </div>
      </Panel>

      <Panel label="9. Media viewer open">
        <div className="ai" role="dialog" aria-label="AI">
          <MediaViewer
            media={
              [
                { key: 'v0', src: '/fixtures-media/photo-1.png', name: 'a.png' },
                { key: 'v1', src: '/fixtures-media/photo-2.png', name: 'b.png' },
                { key: 'v2', src: '/fixtures-media/photo-3.png', name: 'c.png' },
                { key: 'v3', src: '/fixtures-media/shot-wide.png', name: 'screenshot.png' },
                { key: 'v4', src: '/fixtures-media/photo-4.png', name: 'd.png' }
              ] as MediaRef[]
            }
            index={1}
            onClose={NOOP}
          />
        </div>
      </Panel>

      <Panel label="10. Mac screen view — trackpad mode">
        <div className="ai proRoot" role="dialog" aria-label="AI">
          <ScreenView
            pane={
              <div className="mirrorPane proMirrorPane">
                <img className="mirrorVideo active" src="/fixtures-media/photo-2.png" alt="" />
                <div className="mirrorShareControls">
                  <MicInputBadge micOn={false} onMicChange={NOOP} micStreamRef={{ current: null }} />
                  <MirrorAudioBadge
                    shareAudio={false}
                    onShareAudioChange={NOOP}
                    systemVolume={50}
                    onSystemVolumeChange={NOOP}
                    onRequestSystemVolume={NOOP}
                  />
                </div>
              </div>
            }
            controls={<div />}
            macName="Pat's MacBook Pro"
            send={NOOP}
            onBack={NOOP}
          />
        </div>
      </Panel>

      <Panel label="11. Mac screen view — opened from the trackpad">
        <div className="ai proRoot" role="dialog" aria-label="AI">
          <ScreenView
            stop
            pane={
              <div className="mirrorPane proMirrorPane">
                <img className="mirrorVideo active" src="/fixtures-media/photo-2.png" alt="" />
              </div>
            }
            controls={<div />}
            macName="Pat's MacBook Pro"
            send={NOOP}
            onBack={NOOP}
          />
        </div>
      </Panel>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>
)
