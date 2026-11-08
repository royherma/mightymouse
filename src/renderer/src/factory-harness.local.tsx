import './index.css'
import { createRoot } from 'react-dom/client'
import { FactoryPanel } from './components/FactoryPanel'
import { injectTheme } from './theme'
import {
  FACTORY,
  type FactoryAttempt,
  type FactoryProject,
  type FactorySnapshot,
  type FactoryTask
} from '../../shared/factory'

injectTheme()
const now = Date.now()
const blank: FactoryTask = {
  id: 'example',
  projectId: 'example-project',
  title: 'Fix reconnect',
  outcome: 'Reconnect the phone after a short network interruption without pairing again.',
  source: 'write',
  sourceDetail: '',
  area: 'engineering',
  kind: 'Bug',
  acceptance: [{ text: 'Reconnect after the network returns', command: '' }],
  scope: [],
  dependsOn: [],
  priority: 0,
  stage: 'building',
  condition: 'clear',
  blockReason: '',
  nextAction: '',
  repairNote: '',
  branch: 'factory/reconnect',
  baseSha: 'base',
  commitSha: '',
  worktree: '',
  batchId: 'example-batch',
  repairsUsed: 0,
  workflowVersion: 1,
  parked: false,
  oversized: false,
  duplicateOf: '',
  prUrl: '',
  activity: 'Updating reconnect handling',
  approvedAt: now,
  createdAt: now,
  updatedAt: now
}
const tasks: FactoryTask[] = [
  { ...blank, id: 'queue-one', title: 'Keyboard shortcuts', stage: 'queued', activity: '' },
  { ...blank, id: 'queue-two', title: 'Connection status', stage: 'queued', activity: '' },
  blank,
  {
    ...blank,
    id: 'review',
    title: 'probeRepo git rev-parse calls leak stderr into blocker',
    stage: 'reviewing',
    condition: 'blocked',
    commitSha: 'abc',
    blockReason: 'The reviewer stopped twice without a verdict.',
    nextAction: 'Retry the review, or park it and look at the findings.',
    activity: 'Reviewing the wording'
  },
  {
    ...blank,
    id: 'review-two',
    title: 'Show real git error text on Factory setup blockers',
    stage: 'reviewing',
    activity: 'Reviewing the wording'
  },
  {
    ...blank,
    id: 'ready',
    title: 'Clearer errors',
    stage: 'ready',
    activity: 'Checks and review passed',
    prUrl: 'https://github.com/example/repo/pull/12',
    branch: 'factory/clearer-errors'
  }
]
const attempt: FactoryAttempt = {
  id: 'attempt',
  audit: [
    {
      id: 'run',
      startedAt: now - 90_000,
      finishedAt: 0,
      exitCode: null,
      usage: null,
      models: ['claude-opus-5-5'],
      actions: [
        {
          id: 'a1',
          at: now - 10_000,
          name: 'Edit',
          detail: 'server.ts',
          finishedAt: 0,
          failed: null
        }
      ]
    }
  ],
  taskId: blank.id,
  projectId: blank.projectId,
  role: 'build',
  generation: 1,
  dispatchKey: '',
  state: 'started',
  pid: 0,
  runId: '',
  runDir: '',
  timeoutAt: 0,
  brief: '',
  result: '',
  startedAt: now,
  finishedAt: 0
}
const drafts: FactoryTask[] = [
  'Show a clear message when the phone loses Wi-Fi mid-gesture',
  'Let the trackpad scroll speed follow the Mac setting',
  'Remember the last project picked in the Code tab',
  'Split the history file writer so one slow disk write cannot block the panel'
].map((title, index) => ({
  ...blank,
  id: `draft-${index}`,
  title,
  stage: 'draft',
  source: 'audit',
  sourceDetail: ['src/main/phone-remote/server.ts', 'src/renderer/src/Trackpad.tsx', '', ''][index],
  scope: index === 3 ? ['src/main/store/history.ts', 'src/main/store/writer.ts'] : [],
  oversized: index === 3,
  priority: index,
  activity: '',
  createdAt: now - (index + 1) * 7 * 60_000
}))
const project: FactoryProject = {
  id: blank.projectId,
  mightyId: 'mm',
  name: 'MightyMouse',
  repoRoot: '/repo',
  integrationRef: 'dev',
  workflowVersion: 1,
  backend: FACTORY.backend,
  checkCommands: [],
  tasksAtOnce: 1,
  repairs: 2,
  attemptMs: 0,
  stallMs: 0,
  readyCap: 3,
  paused: false,
  priority: 0,
  lastDispatchAt: now,
  setupBlockers: [],
  batchId: 'example-batch',
  updatedAt: now
}
const snapshot: FactorySnapshot = {
  generatedAt: now,
  globalPaused: false,
  globalSlots: 4,
  stopAfter: null,
  models: { ideas: 'opus', build: 'sonnet', review: 'opus' },
  projects: [project],
  tasks: [...tasks, ...drafts],
  attempts: [
    attempt,
    ...(['prepare', 'build', 'check', 'review', 'review'] as const).map((role, index) => ({
      ...attempt,
      id: `r${index}`,
      taskId: 'review',
      role,
      state: 'finished' as const,
      result: role === 'review' ? '{"kind":"blocked"}' : '{}',
      startedAt: now - (60 - index * 9) * 60_000,
      finishedAt: now - (60 - index * 9 - 2) * 60_000 - 23_000
    })),
    {
      ...attempt,
      id: 'plan',
      taskId: '',
      role: 'plan',
      state: 'finished',
      finishedAt: now - 60_000,
      startedAt: now - 9 * 60_000
    }
  ],
  evidence: [
    {
      id: 'ev1',
      taskId: 'review',
      criterion: 'make tc',
      command: 'make tc',
      exitCode: 1,
      commitSha: 'old',
      stale: true,
      artifactPath: '/x',
      provenance: 'check'
    },
    {
      id: 'ev2',
      taskId: 'review',
      criterion: 'make tc',
      command: 'make tc',
      exitCode: 0,
      commitSha: 'abc',
      stale: false,
      artifactPath: '/x',
      provenance: 'check'
    }
  ] as never,
  blockers: [],
  planError: '',
  auditEvents: []
}
const query = new URLSearchParams(location.search)
const second: FactoryProject = {
  ...project,
  id: 'jobs-project',
  mightyId: 'rj',
  name: 'jobboard'
}
const onLine = (task: FactoryTask): boolean => task.stage !== 'draft'
const waiting = (task: FactoryTask): boolean => task.condition !== 'clear' || task.stage === 'ready'
const long =
  'Validate the size of every uploaded material before the whole file is buffered into memory by the handler'
const STATES: Record<string, () => Partial<FactorySnapshot>> = {
  busy: () => ({
    projects: [project, second],
    tasks: [
      ...snapshot.tasks,
      {
        ...blank,
        id: 'jobs-idea',
        projectId: second.id,
        title: 'Add the terms link to checkout',
        stage: 'draft',
        activity: ''
      }
    ]
  }),
  quiet: () => ({ tasks: [], attempts: [] }),
  working: () => ({ tasks: snapshot.tasks.filter((task) => onLine(task) && !waiting(task)) }),
  scanning: () => ({
    tasks: snapshot.tasks.filter(onLine),
    attempts: [
      {
        ...attempt,
        id: 'plan',
        taskId: '',
        role: 'plan',
        state: 'started',
        startedAt: now - 40_000
      }
    ]
  }),
  'scan-error': () => ({ planError: 'The app restarted during the idea scan.' }),
  blockers: () => ({
    projects: [
      {
        ...project,
        setupBlockers: ['Say how to test this project, so a finished task can prove it works.']
      }
    ]
  }),
  paused: () => ({ projects: [{ ...project, paused: true }] }),
  long: () => ({
    tasks: [
      {
        ...blank,
        id: 'l1',
        title: long,
        stage: 'building',
        condition: 'interrupted',
        blockReason:
          'The worker stopped before it finished. The commit 6ee224c is on the branch and was not treated as finished.'
      },
      {
        ...blank,
        id: 'l2',
        title: long,
        stage: 'reviewing',
        condition: 'blocked',
        blockReason:
          'Reparsing as ES module because module syntax was detected. This incurs a performance overhead.'
      },
      {
        ...blank,
        id: 'l6',
        title: 'Show real git error text',
        stage: 'reviewing',
        condition: 'blocked',
        blockReason: '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n FAIL src/x.test.ts'
      },
      {
        ...blank,
        id: 'l3',
        title: long,
        stage: 'draft',
        area: '',
        kind: '',
        source: 'audit',
        sourceDetail: 'materials.test.ts',
        outcome: long + '. ' + long,
        activity: ''
      },
      {
        ...blank,
        id: 'l4',
        title: long,
        stage: 'draft',
        area: '',
        kind: '',
        source: 'write',
        outcome: long,
        activity: ''
      },
      { ...blank, id: 'l5', title: long, stage: 'checking', activity: long }
    ]
  }),
  'first-run': () => ({ projects: [], tasks: [], attempts: [] })
}
const state = query.get('state') ?? 'busy'
const shown: FactorySnapshot = { ...snapshot, ...(STATES[state] ?? STATES.busy)() }
const reply = async (): Promise<FactorySnapshot> => shown
const infra = {
  business: query.has('nokind') ? [] : ['saas'],
  brief: query.has('nogoal')
    ? {}
    : { goal: { metric: 'saas.visitors-who-sign-up', target: 4, by: '2026-12-01' } }
}
Object.assign(window, {
  api: new Proxy(
    {
      factoryMaterials: async () => ({ files: [], notes: [] }),
      openExternal: async () => undefined,
      factoryCodeSize: async () => ({ lines: 0, files: 0, bytes: 0, points: [] }),
      infra: {
        list: async () => [{ projectId: 'mm', record: infra }],
        onChanged: () => () => undefined,
        setBrief: async (projectId: string, brief: unknown) => ({
          projectId,
          record: { ...infra, brief }
        })
      },
      reports: {
        get: async () => ({
          projectId: 'mm',
          state: 'ready',
          problems: [],
          cards: [{ id: 'signups', metric: 'saas.visitors-who-sign-up', unit: 'percent' }],
          results: { signups: { ok: true, output: { value: 2.1 }, ranAt: '', ms: 1 } },
          range: 7
        }),
        onChanged: () => () => undefined
      },
      factoryArtifact: async () => 'Example check log',
      factoryTranscript: async () => ({
        file: '/runs/attempt/transcript.jsonl',
        entries: [
          { at: now - 90_000, kind: 'prompt', text: 'Fix reconnect after a short network drop.' },
          {
            at: now - 80_000,
            kind: 'thinking',
            text: 'The socket closes but the retry timer is never armed.'
          },
          {
            at: now - 70_000,
            kind: 'tool',
            id: 't1',
            name: 'Read',
            input: '{"file_path":"src/main/phone-remote/server.ts"}'
          },
          {
            at: now - 69_000,
            kind: 'tool_end',
            id: 't1',
            output: 'export function startServer() {',
            failed: false
          },
          {
            at: now - 50_000,
            kind: 'text',
            text: 'Arming the reconnect timer on close and clearing it on open.'
          },
          {
            at: now - 40_000,
            kind: 'tool',
            id: 't2',
            name: 'Bash',
            input: '{"command":"npm test -- reconnect"}'
          },
          { at: now - 30_000, kind: 'tool_end', id: 't2', output: '1 failed', failed: true },
          {
            at: now - 10_000,
            kind: 'tool',
            id: 't3',
            name: 'Edit',
            input: '{"file_path":"src/main/phone-remote/server.ts"}'
          }
        ]
      })
    } as Record<string, unknown>,
    { get: (target, key: string) => target[key] ?? reply }
  )
})
createRoot(document.getElementById('root')!).render(
  <main
    className="flex"
    style={{ height: '100vh', background: 'var(--bg)', color: 'var(--on-surface)' }}
  >
    <FactoryPanel
      projects={
        state === 'first-run'
          ? []
          : ([
              {
                id: 'mm',
                name: 'MightyMouse',
                created: '',
                updated: '',
                agentProjectId: project.id
              },
              {
                id: 'rj',
                name: 'jobboard',
                created: '',
                updated: '',
                agentProjectId: second.id
              },
              { id: 'os', name: 'StringLab', created: '', updated: '', repoFolder: '/os' }
            ] as never)
      }
      focusTaskId={query.get('task')}
    />
  </main>
)
