import { CONFIG } from '../../../shared/config'
import { KEY_COMBOS, SITES } from '../capabilities/input'
import { callJev, takeDecideFailure } from '../decide-transport'
import { describeItem, type Observation, type ScreenItem } from './observe'

export type StepKind =
  | 'click'
  | 'press_offscreen'
  | 'type'
  | 'enter'
  | 'search'
  | 'site'
  | 'app'
  | 'key'
  | 'selection'
  | 'scroll_down'
  | 'scroll_up'
  | 'wait'
  | 'done'
  | 'yours'
  | 'stuck'

export interface StepDecision {
  kind: StepKind
  confidence: number
  kindCount: number
  item: ScreenItem | null
  itemConfidence: number
  site: { label: string; url: string } | null
  key: { label: string; combo: string } | null
  latencyMs: number
  serverMs: number
  jevMs: number
  inputTokens: number
}

export interface RunProgress {
  step: number
  lastKind: StepKind | null
  lastKindRun: number
  scrollsUsed: number
  hasSelection: boolean
}

export interface StepDecideFailure {
  failure: string
}

const KIND_QUESTION = 'kind'
const CLICK_QUESTION = 'click_item'
const OFFSCREEN_QUESTION = 'offscreen_item'
const TYPE_QUESTION = 'type_item'
const SITE_QUESTION = 'site'
const KEY_QUESTION = 'key'

const RUN_KEYS = KEY_COMBOS.filter((k) => !k.confirm && k.value !== 'enter')

const KIND_CRITERIA: Record<StepKind, string> = {
  click: 'Press one button, link, tab, menu item or checkbox that is on screen right now.',
  press_offscreen:
    'Press one control the app has but does not show right now - a menu in the menu bar, or a button or link that is scrolled out of view. Only when the control needed is in that list and is not on screen. Always better than scrolling to reach it.',
  type: 'Put text into one text field that is on screen right now - new text, or a changed version of the text already in it.',
  enter: 'Press Return to submit the text that was typed in the previous step.',
  search:
    'Run a web search. Only to FIND a page, a download or a fact. Never to reach a website that the site operation lists, and never to look up how to do the task.',
  site: `Open a website directly: ${SITES.map((s) => s.label).join(', ')}, or any other website the goal names. X is Twitter, and speech-to-text often writes it as "ex". Always the right first operation when the goal names a website and it is not open yet.`,
  app: 'Open or switch to a Mac app by name. Always the right first operation when the goal names an app and it is not the app in front.',
  key: `Press one keyboard shortcut: ${RUN_KEYS.map((k) => k.label).join(', ')}.`,
  selection:
    'Rewrite the text the user has selected right now - shorter, longer, friendlier, fixed, translated - and put the new version in its place.',
  scroll_down: 'Scroll down because the thing needed is probably further down this page.',
  scroll_up: 'Scroll up because the thing needed is probably further up this page.',
  wait: 'The screen is still loading and nothing useful can be done yet.',
  done: 'The page, app or thing the user asked for is open now - check the app, window and website. Finding or opening something is finished the moment it is open. Never scroll or read it for the user.',
  yours:
    'The next part needs something only the user can do: a drag, a right-click, a double-click, a hover, a captcha, signing in, or working inside a picture, video or drawing.',
  stuck: 'Nothing on screen helps and no other operation would move toward the goal.'
}

const SITE_HINTS: Record<string, string> = {
  x: 'X, formerly Twitter - tweets and posts. Speech-to-text often writes it as "ex" or "eks".'
}

const ITEM_KINDS: Partial<
  Record<StepKind, { pool: 'pressables' | 'offscreen' | 'fields'; question: string }>
> = {
  click: { pool: 'pressables', question: CLICK_QUESTION },
  press_offscreen: { pool: 'offscreen', question: OFFSCREEN_QUESTION },
  type: { pool: 'fields', question: TYPE_QUESTION }
}

const RUN_CAPPED: readonly StepKind[] = ['scroll_down', 'scroll_up', 'wait']
const OTHER_SITE = 'other'

function offeredKinds(screen: Observation, progress: RunProgress): StepKind[] {
  const { lastKind, lastKindRun, scrollsUsed } = progress
  const canSee = screen.pressables.length + screen.fields.length > 0
  const kinds: StepKind[] = []
  if (screen.pressables.length > 0) kinds.push('click')
  if (screen.offscreen.length > 0) kinds.push('press_offscreen')
  if (screen.fields.length > 0) kinds.push('type')
  if (lastKind === 'type') kinds.push('enter')
  if (progress.hasSelection) kinds.push('selection')
  kinds.push('search', 'site', 'app', 'key')
  if (canSee && scrollsUsed < CONFIG.COMPUTER_USE.MAX_SCROLLS_PER_RUN)
    kinds.push('scroll_down', 'scroll_up')
  kinds.push('wait', 'done', 'yours', 'stuck')
  const worn = lastKindRun >= CONFIG.COMPUTER_USE.MAX_SAME_KIND_RUN
  return kinds.filter((kind) => !(worn && kind === lastKind && RUN_CAPPED.includes(kind)))
}

function itemCriteria(items: readonly ScreenItem[]): Record<string, string> {
  const criteria: Record<string, string> = {}
  for (const item of items) criteria[item.key] = describeItem(item)
  return criteria
}

function readChoice(answer: unknown): { choice: string; confidence: number } {
  const a = answer as { choice?: unknown; confidence?: unknown } | undefined
  return {
    choice: typeof a?.choice === 'string' ? a.choice : '',
    confidence: typeof a?.confidence === 'number' ? a.confidence : 0
  }
}

export async function decideStep(
  goal: string,
  screen: Observation,
  history: readonly string[],
  progress: RunProgress
): Promise<StepDecision | StepDecideFailure> {
  const kinds = offeredKinds(screen, progress)
  const kindCriteria: Record<string, string> = {}
  for (const kind of kinds) kindCriteria[kind] = KIND_CRITERIA[kind]

  const questions: Record<string, unknown> = {
    [KIND_QUESTION]: {
      type: 'choice',
      instructions:
        'An assistant is operating this computer for the user, one operation at a time, to reach the goal. ' +
        'Pick the single next operation. Never repeat an operation that already left the screen unchanged.',
      criteria: kindCriteria
    },
    [SITE_QUESTION]: {
      type: 'choice',
      instructions: 'If a known website were opened next, which one moves toward the goal?',
      criteria: {
        ...Object.fromEntries(SITES.map((s) => [s.value, SITE_HINTS[s.value] ?? s.label])),
        [OTHER_SITE]: 'A website the goal names that is not in this list.'
      }
    },
    [KEY_QUESTION]: {
      type: 'choice',
      instructions: 'If a keyboard shortcut were pressed next, which one moves toward the goal?',
      criteria: Object.fromEntries(RUN_KEYS.map((k) => [k.value, k.label]))
    }
  }
  if (screen.pressables.length > 0) {
    questions[CLICK_QUESTION] = {
      type: 'choice',
      instructions: 'If a control were pressed next, which one moves toward the goal?',
      criteria: itemCriteria(screen.pressables)
    }
  }
  if (screen.offscreen.length > 0) {
    questions[OFFSCREEN_QUESTION] = {
      type: 'choice',
      instructions:
        'If a control that is not on screen were pressed next, which one moves toward the goal? These are real controls of the app, pressed without the mouse.',
      criteria: itemCriteria(screen.offscreen)
    }
  }
  if (screen.fields.length > 0) {
    questions[TYPE_QUESTION] = {
      type: 'choice',
      instructions: 'If text were typed next, which field should receive it?',
      criteria: itemCriteria(screen.fields)
    }
  }

  const state = {
    goal,
    app: screen.appName,
    window: screen.windowTitle,
    website: screen.urlHost,
    selected_text: progress.hasSelection ? 'yes' : 'no',
    step: progress.step,
    steps_so_far: history.slice(-CONFIG.COMPUTER_USE.HISTORY_STEPS)
  }

  const result = await callJev({ state, questions }, CONFIG.ACTIONS.DECIDE_TIMEOUT_MS)
  if (!result) return { failure: takeDecideFailure() || 'no answer' }

  const kindAnswer = readChoice(result.answers[KIND_QUESTION])
  if (!kinds.includes(kindAnswer.choice as StepKind)) return { failure: 'no operation chosen' }
  const kind = kindAnswer.choice as StepKind

  let item: ScreenItem | null = null
  let itemConfidence = 0
  const target = ITEM_KINDS[kind]
  if (target) {
    const pool = screen[target.pool]
    const picked = readChoice(result.answers[target.question])
    item = pool.find((candidate) => candidate.key === picked.choice) ?? null
    itemConfidence = picked.confidence
    if (!item) return { failure: `no target chosen for ${kind}` }
  }

  let site: StepDecision['site'] = null
  if (kind === 'site') {
    const picked = readChoice(result.answers[SITE_QUESTION])
    const match = SITES.find((s) => s.value === picked.choice)
    if (!match && picked.choice !== OTHER_SITE) return { failure: 'no site chosen' }
    site = match ? { label: match.label, url: match.url } : { label: '', url: '' }
    itemConfidence = picked.confidence
  }

  let key: StepDecision['key'] = null
  if (kind === 'key') {
    const picked = readChoice(result.answers[KEY_QUESTION])
    const match = RUN_KEYS.find((k) => k.value === picked.choice)
    if (!match) return { failure: 'no shortcut chosen' }
    key = { label: match.label, combo: match.combo }
    itemConfidence = picked.confidence
  }

  return {
    kind,
    confidence: kindAnswer.confidence,
    kindCount: kinds.length,
    item,
    itemConfidence,
    site,
    key,
    latencyMs: result.latencyMs,
    serverMs: result.serverMs,
    jevMs: result.jevMs,
    inputTokens: result.inputTokens
  }
}
