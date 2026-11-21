import type { TalkOptionKind, TalkOptionWire } from './phone-remote-protocol'

export const TALK = {
  COMPUTER_ID: 'computer',
  SESSION_TITLE: 'Computer chat',
  MODE_QUESTION: 'talk_mode',
  AUTO_GO_MS: 2500,
  MAX_OPTIONS: 3,
  TEXT_MAX_CHARS: 4000,
  HISTORY_MAX: 12,
  ID_MAX_CHARS: 64,
  ATTACH_PREFIX: 'talk:',
  IDEAS_MAX: 3
} as const

export const TALK_MODE = { computer: 'computer', agent: 'agent' } as const

export const TALK_MODE_INSTRUCTIONS =
  'Who should act on this spoken request. "computer" means do it right here on the computer: open or control apps, ' +
  'change a setting, find or move files, look at the screen, answer a question, or write something short. ' +
  '"agent" means it is software or project work that belongs with a coding agent: continuing what a running agent ' +
  'is doing, or a new coding task in one of the projects.'

export const TALK_MODE_CRITERIA: Record<keyof typeof TALK_MODE, string> = {
  computer:
    'Handle it directly on the computer: apps, settings, files, the screen, questions, quick writing.',
  agent:
    'Coding or project work: hand it to a running coding agent or start a new one in a project.'
}

export const TALK_SYSTEM_PROMPT = `
THE USER IS TALKING TO YOU FROM THEIR PHONE. They may be away from the computer, so do the task here instead of telling them how.
- Reply for a phone screen, easy to scan. First line: the answer or what you did, in one short sentence, with the key name or number in **bold**.
- Then, only if it adds something, up to 4 short bullet points ("- "), one fact each. No headings, tables, code blocks or emoji. Under 70 words total.
- Show the result when a picture says it better than words: a page you opened, a chart, a document, what is now on screen. Save each picture as a .png or .jpg in the current folder (for the whole screen: screencapture -x result.png). Every image you save there is sent to their phone, so send as many as help and no throwaway ones.
- If something needs their decision or would delete or send anything, stop and ask in one sentence instead of guessing.`

export const TALK_LABELS = {
  title: 'Computer chat',
  startFresh: 'Start fresh',
  startFreshHint: 'Start fresh - this chat moves to Archived chats',
  button: 'Chat',
  emptyLead: 'Say or type what you want done.',
  newAgentIn: 'New agent in',
  or: 'Or',
  deciding: 'Working out who should do this…',
  typePlaceholder: 'Message your computer',
  photoOnly: 'Here is a photo.',
  yourPhoto: 'Your photo',
  yourComputer: 'Your computer',
  goNow: 'Go now',
  change: 'Change',
  cancel: 'Cancel',
  pickOne: 'Who should do this?',
  done: 'Done',
  notConnected: "Your computer isn't connected",
  failed: "That didn't work",
  cancelled: 'Cancelled',
  noHelper: "That agent isn't there anymore",
  noHarness: 'Install Claude Code or Codex to start an agent.',
  cantStart: "Couldn't start it:",
  agentStarted: 'A new agent is on it.',
  agentHasIt: 'It has your message.',
  ideas: ["What's taking up space on my disk?", "Close the apps I'm not using", "What's on my screen right now?"],
  appIdeas: {
    'com.spotify.client': 'Play something calm on Spotify',
    'com.apple.Music': 'Play something calm in Music',
    'com.apple.mail': 'Any important emails I missed?',
    'com.apple.iCal': "What's on my calendar today?",
    'com.tinyspeck.slackmacgap': 'Any Slack messages I need to answer?',
    'com.apple.MobileSMS': 'Read me my latest messages',
    'com.google.Chrome': 'Sum up the page I have open',
    'com.apple.Safari': 'Sum up the page I have open',
    'company.thebrowser.Browser': 'Sum up the page I have open'
  } as Record<string, string>,
  agentIdea: 'How is my {project} agent doing?',
  doing: {
    computer: 'Doing it on your computer',
    agent: 'Sending it to',
    'new-agent': 'Starting a new agent in'
  } satisfies Record<TalkOptionKind, string>,
  done_: {
    computer: 'Your computer',
    agent: 'Sent to',
    'new-agent': 'Started in'
  } satisfies Record<TalkOptionKind, string>
} as const

export interface TalkCandidate {
  id: string
  kind: Exclude<TalkOptionKind, 'computer'>
  label: string
  detail: string
  project?: TalkOptionWire['project']
}

export interface TalkRanking {
  mode: Record<string, number>
  modeConfidence: number
  helper: Record<string, number>
  helperPick: string
  helperConfidence: number
}

export interface TalkDecision {
  auto: boolean
  pick: string
  options: TalkOptionWire[]
}

export const COMPUTER_OPTION: Omit<TalkOptionWire, 'percent'> = {
  id: TALK.COMPUTER_ID,
  kind: 'computer',
  label: 'Your computer',
  detail: 'Does it right here'
}

export interface TalkRoutePush extends TalkDecision {
  clientRunId: string
}

export function talkOptionName(option: TalkOptionWire): string {
  return option.kind === 'new-agent'
    ? `${TALK_LABELS.newAgentIn} ${option.project?.name ?? option.label}`
    : option.label
}

export function talkHeadline(options: readonly TalkOptionWire[], pick: string): string {
  const option = options.find((o) => o.id === pick) ?? { ...COMPUTER_OPTION, percent: 100 }
  if (option.kind === 'computer') return TALK_LABELS.doing.computer
  const name = option.kind === 'new-agent' ? (option.project?.name ?? option.label) : option.label
  return `${TALK_LABELS.doing[option.kind]} ${name}`
}

function percent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100)))
}

// Hands off on its own only when sure of BOTH: that it is agent work, and which agent.
export function decideTalk(
  candidates: readonly TalkCandidate[],
  ranking: TalkRanking | null,
  floor: number
): TalkDecision {
  const computerOnly = {
    auto: true,
    pick: TALK.COMPUTER_ID,
    options: [{ ...COMPUTER_OPTION, percent: 100 }]
  }
  if (ranking === null || candidates.length === 0) return computerOnly

  const agentShare = ranking.mode[TALK_MODE.agent] ?? 0
  const computerShare = ranking.mode[TALK_MODE.computer] ?? 1 - agentShare
  const wantsAgent = agentShare > computerShare
  const sure = ranking.modeConfidence >= floor

  if (!wantsAgent && sure) return computerOnly

  const scored = candidates
    .map((c) => ({ c, score: agentShare * (ranking.helper[c.id] ?? 0) }))
    .sort((a, b) => b.score - a.score)
  const named = candidates.find((c) => c.id === ranking.helperPick)
  const lead = named ?? scored[0]?.c
  const helperSure = named !== undefined && ranking.helperConfidence >= floor

  const helpers = [
    ...(lead ? [lead] : []),
    ...scored.map((s) => s.c).filter((c) => c.id !== lead?.id)
  ]
    .slice(0, TALK.MAX_OPTIONS - 1)
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      detail: c.detail,
      percent: percent(agentShare * (ranking.helper[c.id] ?? 0)),
      ...(c.project ? { project: c.project } : {})
    }))
  const computer = { ...COMPUTER_OPTION, percent: percent(computerShare) }

  if (wantsAgent && sure && helperSure && lead) {
    return { auto: true, pick: lead.id, options: [...helpers, computer] }
  }
  const options = wantsAgent ? [...helpers, computer] : [computer, ...helpers]
  return { auto: false, pick: options[0].id, options }
}

function readChoice(raw: unknown): { probabilities: Record<string, number>; confidence: number } {
  const answer = (raw ?? {}) as { probabilities?: unknown; confidence?: unknown }
  const probabilities: Record<string, number> = {}
  if (answer.probabilities && typeof answer.probabilities === 'object') {
    for (const [key, value] of Object.entries(answer.probabilities as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) probabilities[key] = value
    }
  }
  const confidence =
    typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
      ? answer.confidence
      : 0
  return { probabilities, confidence }
}

export interface RankedAnswers {
  answers: Record<string, unknown>
  helperProbabilities: Record<string, number>
  helperSinkId: string
  confidence: number
}

export function talkRankingOf(ranking: RankedAnswers | null): TalkRanking | null {
  if (!ranking) return null
  const mode = readChoice(ranking.answers[TALK.MODE_QUESTION])
  if (Object.keys(mode.probabilities).length === 0) return null
  return {
    mode: mode.probabilities,
    modeConfidence: mode.confidence,
    helper: ranking.helperProbabilities,
    helperPick: ranking.helperSinkId,
    helperConfidence: ranking.confidence
  }
}

export function talkId(raw: unknown): string {
  return typeof raw === 'string' ? raw.slice(0, TALK.ID_MAX_CHARS) : ''
}

export function talkText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, TALK.TEXT_MAX_CHARS) : ''
}
