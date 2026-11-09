export type TaskCandidate = { ref: string; title: string; recap?: string }

export type TaskDelivery = { kind: 'existing'; ref: string } | { kind: 'new'; pickedClosed?: string }

const MAX_CANDIDATES = 20
const MAX_TASK_CHARS = 2_000
const MAX_LINE_CHARS = 200

export function routeCandidates(candidates: TaskCandidate[]): TaskCandidate[] {
  return candidates.filter((c) => c.ref && c.title).slice(0, MAX_CANDIDATES)
}

export function routePrompt(task: string, sessions: TaskCandidate[]): string {
  const list = sessions
    .map((s, i) => `${i + 1}. ${[s.title, s.recap].filter(Boolean).join(' - ').slice(0, MAX_LINE_CHARS)}`)
    .join('\n')
  return [
    'Someone typed a message into the home screen of a coding project.',
    'Below are the agent sessions already open in that project, each with its title and what it is doing.',
    "Pick the ONE session the message belongs to: it continues, asks about, fixes or changes that session's work.",
    'If no session is clearly about the same thing, answer NEW. When unsure, answer NEW.',
    '',
    'Open sessions:',
    list,
    '',
    `Message: ${task.slice(0, MAX_TASK_CHARS)}`,
    '',
    'Reply with only the session number, or NEW.'
  ].join('\n')
}

export function parseRoute(raw: string, count: number): number | null {
  const answer = raw.trim()
  if (/^\W*new\b/i.test(answer)) return null
  const n = Number(answer.match(/\d+/)?.[0])
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : null
}

export async function deliverTask(
  said: string,
  candidates: TaskCandidate[],
  io: {
    route: (said: string, candidates: TaskCandidate[]) => Promise<string | null>
    reply: (ref: string, said: string) => Promise<{ ok: boolean }>
    startNew: (said: string) => Promise<void>
  }
): Promise<TaskDelivery> {
  const ref = candidates.length ? await io.route(said, candidates) : null
  if (ref && (await io.reply(ref, said)).ok) return { kind: 'existing', ref }
  await io.startNew(said)
  return ref ? { kind: 'new', pickedClosed: ref } : { kind: 'new' }
}
