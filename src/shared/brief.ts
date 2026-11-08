import {
  BRIEF_LINE_MAX,
  BUSINESS_LABELS,
  GOAL_LIVE,
  cleanBrief,
  type BusinessType,
  type ProjectBrief,
  type ProjectGoal
} from './infra'
import { BUSINESS_PLAYBOOKS, metricById, nichesFor, typicalFor, typicalText } from './playbooks'

export const README_PATTERN = '^README\\.md$'
const README_CHARS = 4000
const GOAL_CHOICES = 3

export const BRIEF_WORDS = {
  ask: 'What is it, and who is it for?',
  askHint: 'One sentence is enough. We use it to pick the look and the words.',
  placeholder: 'An online pet store for dog owners in Thailand',
  next: 'Next',
  needSentence: 'Type one sentence first.',
  drafting: 'Reading that…',
  got: 'Here is what we got',
  what: 'What it is',
  audience: 'Who it is for',
  fix: 'Tap any line to fix it.',
  ok: 'Looks right',
  skip: 'Skip',
  goalAsk: 'What is your main goal right now?',
  goalHint: 'Pick one. You can change it any time.',
  live: 'Get it live first',
  liveHint: 'No numbers yet. We aim for a working version people can use.',
  aim: 'Aim for',
  by: 'by',
  setGoal: 'Set goal',
  later: 'Later',
  goal: 'Your goal',
  change: 'Change',
  failed: 'That did not save - try again.',
  about: 'About this project',
  aboutHint: 'Optional. Pick an idea or type your own.',
  whatExample: 'e.g. Online pet store',
  audienceExample: 'e.g. Dog owners in Thailand',
  nicheExample: 'e.g. Pet supplies',
  fill: 'Fill in for me',
  filling: 'Reading your project…',
  filled: 'Filled in from your project. Change anything.',
  fillSignedOut: 'Sign in to MightyMouse and we can fill this in for you.',
  fillNothing: 'This project has no README to read yet.',
  fillFailed: 'That did not work - try again.'
} as const

export type BriefDraftFail = 'signed_out' | 'nothing' | 'failed'
export type BriefDraft = { brief: ProjectBrief } | { fail: BriefDraftFail }

export const BRIEF_FILL_FAIL: Record<BriefDraftFail, string> = {
  signed_out: BRIEF_WORDS.fillSignedOut,
  nothing: BRIEF_WORDS.fillNothing,
  failed: BRIEF_WORDS.fillFailed
}

const AUDIENCE_IDEAS = [
  'Solo founders',
  'Small business owners',
  'Developers',
  'Designers',
  'Marketers',
  'Creators',
  'Freelancers',
  'Students',
  'Teachers',
  'Parents',
  'Online shoppers',
  'Teams at work'
]

const NICHE_IDEAS = [
  'AI tools',
  'Productivity',
  'Developer tools',
  'Finance',
  'Health and fitness',
  'Education',
  'Games',
  'Social',
  'Music and audio',
  'Photo and video',
  'Travel',
  'Food and drink',
  'Shopping',
  'News and media'
]

export function briefIdeas(types: BusinessType[]): Record<'what' | 'audience' | 'niche', string[]> {
  const kinds = types.length ? types : (Object.keys(BUSINESS_LABELS) as BusinessType[])
  const niches = nichesFor(types)
  return {
    what: kinds.map((t) => BUSINESS_LABELS[t].label),
    audience: AUDIENCE_IDEAS,
    niche: niches.length ? niches : NICHE_IDEAS
  }
}

const LIKE_YOURS: Partial<Record<BusinessType, string>> = {
  store: 'Stores like yours',
  landing: 'Pages like yours',
  app: 'Apps like yours',
  saas: 'Apps like yours',
  content: 'Sites like yours'
}

export function likeYours(types: BusinessType[]): string {
  return LIKE_YOURS[types[0]] ?? 'Projects like yours'
}

export function briefDraftPrompt(
  source: { sentence?: string; readme?: string },
  types: BusinessType[]
): string {
  const niches = nichesFor(types)
  const kinds = types.map((t) => BUSINESS_LABELS[t].label).join(', ')
  return [
    source.sentence
      ? `A person described what they are building in one sentence: "${source.sentence.slice(0, 300)}"`
      : `Here is the start of a project's README:\n${(source.readme ?? '').slice(0, README_CHARS)}`,
    ...(kinds ? [`Kind of project: ${kinds}.`] : []),
    'Reply with JSON only: {"what": string, "audience": string, "niche": string}.',
    `what: what it is, in 2 to 5 plain words, e.g. "Online pet store". audience: who it is for, in 2 to 6 plain words, e.g. "Dog owners in Thailand". Each under ${BRIEF_LINE_MAX} characters.`,
    niches.length
      ? `niche: the one name from this list that fits best, copied exactly - ${niches.join('; ')}. Use "" if none fits.`
      : 'niche: the industry in 1 to 3 plain words, e.g. "Pet supplies".',
    'Use "" for anything the text does not say. Never invent a detail.'
  ].join('\n')
}

export function parseBriefDraft(text: string): ProjectBrief | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    return cleanBrief({ what: parsed.what, audience: parsed.audience, niche: parsed.niche }) ?? null
  } catch {
    return null
  }
}

export interface GoalChoice {
  id: string
  label: string
  hint: string
  typical?: string
  target?: number
}

export function goalChoices(types: BusinessType[], niche?: string): GoalChoice[] {
  const metrics = types.flatMap((type) => BUSINESS_PLAYBOOKS[type].metrics)
  const ranked = [...metrics.filter((m) => m.benchmarks), ...metrics.filter((m) => !m.benchmarks)]
  const picks = ranked.slice(0, GOAL_CHOICES).map((m): GoalChoice => {
    const found = typicalFor(m, niche)
    return {
      id: m.id,
      label: m.label,
      hint: `${found ? `Typical for ${found.group}. ` : ''}${m.what}`,
      ...(found ? { typical: typicalText(m, found.value), target: found.value } : {})
    }
  })
  return [...picks, { id: GOAL_LIVE, label: BRIEF_WORDS.live, hint: BRIEF_WORDS.liveHint }]
}

export function defaultGoalDay(now: Date): string {
  const quarterEnd = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 + 3, 0))
  return quarterEnd.toISOString().slice(0, 10)
}

export function goalFrom(choice: GoalChoice, target: string, by: string): ProjectGoal {
  if (choice.id === GOAL_LIVE) return { metric: GOAL_LIVE }
  const value = Number(target)
  return {
    metric: choice.id,
    ...(target.trim() && Number.isFinite(value) ? { target: value } : {}),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(by) ? { by } : {})
  }
}

export function goalUnit(id: string): string {
  const unit = metricById(id)?.unit
  return unit === 'percent' ? '%' : unit === 'usd' ? '$' : ''
}

export function briefFilled(brief: ProjectBrief | undefined): number {
  return [brief?.what, brief?.audience, brief?.niche, brief?.goal].filter(Boolean).length
}
