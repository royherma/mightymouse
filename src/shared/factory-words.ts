import type { FactoryStage, FactoryTask } from './factory'

type Word = { one: string; many: string; means: string }

export const FACTORY_WORDS = {
  project: { one: 'project', many: 'projects', means: 'What the factory grows.' },
  idea: {
    one: 'idea',
    many: 'ideas',
    means: 'Work the factory suggests. Nothing happens until you say Build it.'
  },
  task: {
    one: 'task',
    many: 'tasks',
    means: 'An idea you said yes to. The factory builds, checks and reviews it on its own.'
  },
  line: {
    one: 'line',
    many: 'lines',
    means: 'The steps every task moves through: Preparing, Building, Checking, Reviewing.'
  },
  decision: {
    one: 'decision',
    many: 'decisions',
    means: 'Something only you can answer: an idea, a stuck task, or a task ready to ship.'
  },
  stuck: {
    one: 'stuck task',
    many: 'stuck tasks',
    means: 'A task that stopped partway. Its work so far is kept.'
  },
  ready: {
    one: 'task ready to ship',
    many: 'tasks ready to ship',
    means: 'It passed its checks and review. It waits for your yes.'
  },
  shipped: { one: 'shipped task', many: 'shipped tasks', means: 'Merged and done.' }
} as const satisfies Record<string, Word>

export type FactoryWord = keyof typeof FACTORY_WORDS

export function factoryCount(word: FactoryWord, count: number): string {
  const { one, many } = FACTORY_WORDS[word]
  return `${count} ${count === 1 ? one : many}`
}

type State = { label: string; means: string }

export const FACTORY_STATE = {
  idea: { label: 'Idea', means: FACTORY_WORDS.idea.means },
  waiting: { label: 'Waiting its turn', means: 'Starts when a slot frees up.' },
  working: { label: 'Working', means: 'An agent is on it right now.' },
  stuck: { label: 'Stuck', means: FACTORY_WORDS.stuck.means },
  interrupted: {
    label: 'Interrupted',
    means: 'The app or the agent stopped mid-step. Its work so far is kept.'
  },
  ready: { label: 'Ready to ship', means: FACTORY_WORDS.ready.means },
  shipped: { label: 'Shipped', means: FACTORY_WORDS.shipped.means },
  canceled: {
    label: 'Canceled',
    means: 'Stopped. Its branch and results are kept, so you can restore it.'
  }
} as const satisfies Record<string, State>

export type FactoryStateKey = keyof typeof FACTORY_STATE

export function factoryState(
  task: Pick<FactoryTask, 'stage' | 'condition'>,
  running: boolean
): FactoryStateKey {
  if (task.condition === 'canceled') return 'canceled'
  if (task.condition === 'blocked') return 'stuck'
  if (task.condition === 'interrupted') return 'interrupted'
  if (task.stage === 'draft') return 'idea'
  if (task.stage === 'merged') return 'shipped'
  if (task.stage === 'ready') return 'ready'
  return running ? 'working' : 'waiting'
}

type Action = { label: string; does: string; keeps: string }

const KEEPS_WORK = 'Everything it made so far is kept.'

export const FACTORY_ACTION = {
  build: {
    label: 'Build it',
    does: 'Turns the idea into a task and puts it on the line.',
    keeps: ''
  },
  skip: {
    label: 'Skip',
    does: 'Removes the idea.',
    keeps: 'Nothing is kept.'
  },
  retry: {
    label: 'Try this step again',
    does: 'Runs the same step again. The agent reads why it stopped.',
    keeps: KEEPS_WORK
  },
  rebuild: {
    label: 'Fix the code',
    does: 'Goes back to Build. The agent changes the code using this error, then checks and review run again.',
    keeps: KEEPS_WORK
  },
  note: {
    label: 'Add a note',
    does: 'Tells the agent what to do differently on the next try.',
    keeps: 'The note is sent with Try again or Fix the code.'
  },
  park: {
    label: 'Park for later',
    does: 'Sets it aside so another task can start.',
    keeps: KEEPS_WORK
  },
  unpark: {
    label: 'Bring back',
    does: 'Puts it back in line.',
    keeps: KEEPS_WORK
  },
  cancel: {
    label: 'Cancel task',
    does: 'Stops it and moves it to Canceled.',
    keeps: 'Its branch and results are kept.'
  },
  restore: {
    label: 'Restore task',
    does: 'Brings it back so you can try it again.',
    keeps: KEEPS_WORK
  },
  ship: {
    label: 'Ship it',
    does: 'Merges the pull request on GitHub.',
    keeps: 'The task moves to Shipped.'
  },
  shipConfirm: { label: 'Click again to ship', does: 'Merges it now.', keeps: '' },
  shipping: { label: 'Shipping…', does: '', keeps: '' },
  changes: {
    label: 'See changes',
    does: 'Opens the pull request on GitHub.',
    keeps: 'Nothing changes here.'
  },
  watch: {
    label: 'Watch live',
    does: 'Shows what the agent is doing right now.',
    keeps: 'Nothing changes here.'
  },
  decide: {
    label: 'Start deciding',
    does: 'Shows each decision one at a time.',
    keeps: 'Leave any time. Nothing is decided until you press a button.'
  }
} as const satisfies Record<string, Action>

export type FactoryActionKey = keyof typeof FACTORY_ACTION

export const FACTORY_RETRY_LABEL: Partial<Record<FactoryStage, string>> = {
  preparing: 'Set it up again',
  building: 'Keep building',
  checking: 'Run the checks again',
  reviewing: 'Run the review again'
}

export const FACTORY_STEPS = ['preparing', 'building', 'checking', 'reviewing'] as const

export const FACTORY_SCREEN = {
  turn: 'Your turn',
  turnEmpty: 'Nothing needs you right now. Ask for ideas below.',
  turnEmptyAll: 'Nothing needs you right now. Pick a project on the left to ask for ideas.',
  paused: 'Paused. Running tasks finish, and nothing new starts until you resume.',
  firstRun: 'Your work moves through these steps, then comes back ready for you to ship.',
  working: 'Working',
  shipped: 'Shipped this week',
  shippedEmpty: 'Shipped tasks show up here.',
  moreIdeas: (count: number) => `${count} more ${count === 1 ? 'idea' : 'ideas'}`,
  fewerIdeas: 'Show fewer',
  needsArea: 'Pick where it goes',
  open: 'Open',
  parked: 'Parked',
  fixing: 'Fixing after review',
  skipped: 'Skipped',
  retrying: 'Trying again',
  rebuilding: 'Back to Building',
  minutes: (count: number) => `${count} min`,
  ask: 'Get ideas to',
  write: 'or write your own task',
  add: 'Add',
  brief: 'Paste a brief',
  briefHint: 'Paste a spec or notes. The agent reads it and splits it into tasks.',
  noScans: 'No idea scans yet',
  lastScan: (ago: string) => `Last idea scan ${ago} ago`,
  notMeasured: 'Not measured yet',
  openReports: 'Open Reports',
  typical: (group: string, value: string, by: string) => `Typical for ${group}: ${value} · ${by}`,
  noKind: 'Say what kind of project this is to get goals that fit it.',
  openInfra: 'Open Infrastructure',
  testWith: 'Command that tests this project',
  testExample: 'e.g. npm test',
  checkAgain: 'Save and check again'
} as const

export function factoryHint(action: FactoryActionKey): string {
  const { does, keeps } = FACTORY_ACTION[action]
  return [does, keeps].filter(Boolean).join(' ')
}
