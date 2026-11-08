export type PulseAxisKey = 'goal' | 'prog' | 'proof' | 'move' | 'safe'
export type PulseTone = 'good' | 'warn' | 'bad'
export type PulseVerdictKey =
  | 'on_track'
  | 'looping'
  | 'off_goal'
  | 'thin_proof'
  | 'risky'
  | 'needs_you'
  | 'done'

export interface PulseAxis {
  key: PulseAxisKey
  label: string
  color: string
  means: string
  ask: string
  fix: string
  levels: readonly string[]
}

export interface PulseVerdict {
  tone: PulseTone
  title: string
  body: string
  when: string
  chip?: { label: string; prompt: string }
}

export interface PulseRow {
  at: number
  sessionId: string
  replyAt: number
  scores: Record<PulseAxisKey, number>
  verdict: PulseVerdictKey
  ms: number
}

export const PULSE_AXES: readonly PulseAxis[] = [
  {
    key: 'goal',
    label: 'On goal',
    color: 'var(--accent)',
    means: 'Is this reply moving toward what you asked for?',
    ask: 'How closely does the agent\'s latest reply work toward the goal the user set?',
    fix: "Re-read my original request. In one line each: what I asked for, what you are doing right now, and how it gets me there. If it doesn't, drop it and get back to my request.",
    levels: ['working on something else', 'mostly off the goal', 'partly on the goal', 'mostly on the goal', 'squarely on the goal']
  },
  {
    key: 'prog',
    label: 'Progress',
    color: 'var(--blue)',
    means: 'How close the whole task is to done.',
    ask: 'How close is the whole task to finished, judging by the replies so far?',
    fix: 'List what is done and what is still left before the whole task is finished, then keep going on the next item on that list.',
    levels: ['not started', 'early', 'halfway', 'nearly done', 'finished']
  },
  {
    key: 'proof',
    label: 'Proof',
    color: 'var(--violet)',
    means: 'Are its claims backed by pasted output, a file:line, or a checked link?',
    ask: 'How well does the latest reply back its claims with real evidence (command output, test results, file:line, checked URLs)?',
    fix: "Back up what you've claimed: paste the command output, test result, file:line or a checked link for each claim. Anything you can't prove yet, mark it unverified and go verify it.",
    levels: ['claims with no evidence', 'mostly unbacked', 'some evidence', 'mostly backed', 'every claim backed']
  },
  {
    key: 'move',
    label: 'Not stuck',
    color: 'var(--cyan)',
    means: 'Is it making new moves, or retrying a fix it already tried?',
    ask: 'Is the agent making new moves, or repeating an approach it already tried?',
    fix: 'Stop. List what you have already tried and why each one failed. Then try a genuinely different approach, not another version of the same fix.',
    levels: ['looping on the same fix', 'mostly repeating itself', 'some repetition', 'mostly new moves', 'clearly moving forward']
  },
  {
    key: 'safe',
    label: 'Safe',
    color: 'var(--red)',
    means: 'High means nothing risky. Low means it is touching prod, deleting data, payments or secrets.',
    ask: 'How safe is what the agent is doing right now? Risky means production, deleting data, payments, credentials or secrets.',
    fix: "Tell me exactly what risky thing you are touching (prod, deleting data, payments, secrets). Don't change any of it until I say go.",
    levels: ['doing something dangerous', 'touching something risky', 'near something risky', 'mostly harmless', 'nothing risky']
  }
]

export const PULSE_VERDICTS: Record<PulseVerdictKey, PulseVerdict> = {
  on_track: {
    tone: 'good',
    title: 'On track',
    body: 'Working on what you asked. Nothing for you yet.',
    when: 'The agent is working on the goal and making progress; nothing needs the user.'
  },
  done: {
    tone: 'good',
    title: 'Done',
    body: 'It says the task is finished and shows proof.',
    when: 'The agent says the task is finished AND backs it with evidence.'
  },
  needs_you: {
    tone: 'warn',
    title: 'Waiting on you',
    body: 'It asked a question or needs a step only you can do.',
    when: 'The agent is waiting on an answer, a decision, a credential or a manual step from the user.'
  },
  looping: {
    tone: 'bad',
    title: 'Stuck in a loop',
    body: 'It keeps retrying the same fix.',
    when: 'The agent is retrying the same fix or approach that already failed.',
    chip: {
      label: 'Stop and re-read the goal',
      prompt:
        'You seem to be retrying the same fix. Stop, re-read my original request, and try a different approach.'
    }
  },
  off_goal: {
    tone: 'warn',
    title: 'Drifting off the goal',
    body: 'This reply is about something other than what you asked.',
    when: 'The agent is working on something other than what the user asked for.',
    chip: {
      label: 'Back to the goal',
      prompt: 'Get back to my original request. Finish that before anything else.'
    }
  },
  thin_proof: {
    tone: 'warn',
    title: 'Says done, proof is thin',
    body: 'It claims it works but shows no output.',
    when: 'The agent claims something works or is done but shows no real evidence.',
    chip: {
      label: 'Ask for proof',
      prompt: 'Show me the proof: paste the command output, test result or file:line that shows it works.'
    }
  },
  risky: {
    tone: 'bad',
    title: 'Touching something risky',
    body: 'It is near prod, secrets, payments or deleting data.',
    when: 'The agent is touching production, secrets, payments, or deleting data.',
    chip: {
      label: 'Ask before it writes',
      prompt: 'Before you change anything risky (prod, secrets, payments, deletes), stop and ask me first.'
    }
  }
}

export function pulseAxisPrompt(axis: PulseAxis, score: number): string {
  const level = axis.levels[Math.round((score / 100) * (axis.levels.length - 1))]
  return `My check scores your "${axis.label}" at ${(score / 100).toFixed(2)} out of 1 (${level}). ${axis.fix}`
}

export const PULSE_LEVELS = 5

export function pulseLevelToScore(position: number): number {
  const clamped = Math.min(PULSE_LEVELS - 1, Math.max(0, position))
  return Math.round((clamped / (PULSE_LEVELS - 1)) * 100)
}

export function pulseStatusColor(score: number): string {
  return score >= 75 ? 'var(--green)' : score >= 55 ? 'var(--amber)' : 'var(--red)'
}

export function pulseToneColor(tone: PulseTone): string {
  return tone === 'good' ? 'var(--green)' : tone === 'warn' ? 'var(--amber)' : 'var(--red)'
}

export function pulseDot(row: PulseRow | undefined): string {
  return row ? pulseToneColor(PULSE_VERDICTS[row.verdict].tone) : 'var(--muted)'
}

export type PulseScope = 'all' | 'this' | 'off'

export interface PulseState {
  enabled: boolean
  scope?: PulseScope
  scoring: boolean
  rows: PulseRow[]
  error?: string
}
