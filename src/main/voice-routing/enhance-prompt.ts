export type EnhanceDestination =
  | { kind: 'agent'; project: string; branch?: string; task?: string }
  | { kind: 'new-agent'; project: string; about?: string }
  | { kind: 'skill'; name: string; description?: string }
  | { kind: 'app'; name: string }

export interface EnhanceInput {
  transcript: string
  destination: EnhanceDestination
  screenHeader?: string
  retake?: boolean
}

export interface EnhanceVariant {
  label: string
  text: string
}

export interface EnhanceResult {
  kind: string
  variants: EnhanceVariant[]
}

const VARIANT_COUNT = 3
const MAX_TRANSCRIPT_CHARS = 4_000

function describeDestination(d: EnhanceDestination): string {
  switch (d.kind) {
    case 'agent':
      return [
        `A coding agent already running in the ${d.project} project${d.branch ? ` on branch ${d.branch}` : ''}.`,
        d.task ? `It is currently working on: ${d.task}` : '',
        'It already has that conversation and the repo in context, so the prompt continues its work rather than re-introducing the project.'
      ].filter(Boolean).join('\n')
    case 'new-agent':
      return [
        `A brand-new coding agent starting fresh in the ${d.project} project, with full access to the repo but no conversation so far.`,
        d.about ? `The project: ${d.about}` : ''
      ].filter(Boolean).join('\n')
    case 'skill':
      return `The /${d.name} skill, which receives this text as its argument.${d.description ? ` The skill: ${d.description}` : ''} Do not start the text with a slash.`
    case 'app':
      return `Typed into ${d.name}.`
  }
}

export function buildEnhancePrompt(input: EnhanceInput): string {
  const transcript = input.transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS)
  return `You are the best writer and prompt writer alive. The user just dictated the note below by voice. Dictation rambles, says "this" and "that", backtracks and trails off. Branch it into three versions that are drastically better than what they said, each taking it in a different useful direction: what a brilliant expert would have written with ten quiet minutes, knowing exactly what they want and exactly how to get the best out of whoever receives it.

<note>
${transcript}
</note>

<where_it_goes>
${describeDestination(input.destination)}
</where_it_goes>
${input.retake ? `\n<another_take>\nThe user already saw one set of these three and asked for another. Keep the same three labels; write each one fresh, with a noticeably different angle or wording.\n</another_take>\n` : ''}${input.screenHeader ? `\n<on_screen_when_they_spoke>\n${input.screenHeader.trim()}\n</on_screen_when_they_spoke>\n` : ''}
<what_great_looks_like>
- Leads with the outcome and why it matters, not the activity.
- Turns every vague word into the concrete thing it means here. "Make it nicer" becomes the specific qualities (hierarchy, spacing, contrast, hover and focus states, motion, density). "It's buggy" becomes observed behaviour versus expected behaviour and how to reproduce it.
- Every wish gets a checkable done-when: something the agent can verify and show.
- Names the traps an expert sees coming - edge cases, states people forget (empty, loading, error, huge), regressions to avoid - and tells the agent how to start and when to stop and show the user.
- Reads like a confident expert wrote it. Dense, specific, no filler, no hedging, no pleasantries.
</what_great_looks_like>

<rules>
- Keep the intent. Sharpen, organise and extend it to what they clearly meant; never swap in a different task or drop part of the ask.
- Never invent facts. No file names, function names, numbers, colours or history you were not given. When a specific is needed and unknown, tell the agent to find it ("find the component that renders the event list") or state it as "Assume ...".
- Keep every pointer the agent needs verbatim in meaning: "my last screenshot", a person, an email, a project, an earlier decision. If they said to look at a screenshot, the prompt tells the agent to look at it.
- Fix obvious mis-transcriptions from context (product, repo and people names).
- A question stays a question: ask it sharper and say what a good answer contains. Approval or a go-ahead stays one, with its conditions made explicit.
- Written as the user, first person, straight to the agent. Same language as the note. No preamble like "Here is".
- You have no tools and cannot see any files, repo or screen beyond what is written here. Never say you read, checked or looked at anything, and never bring in work, features or files the note and <where_it_goes> do not mention.
</rules>

<the_three_versions>
Always write these three, in this order, with exactly these labels. First decide what the note is, then shape each one to fit it.

1. "Sharp" - the same intent with every word earning its place. At most 90 words.
2. "Full brief" - the complete version an expert would hand over, with nothing left to guess. 150-400 words.
3. "Genius" - what the note is really reaching for, solved from first principles: the underlying goal and the stronger version an expert would go for. It stays about the exact thing the note names and goes deeper on that, never sideways into a different feature. The original ask stays the floor. 120-300 words.

What each one means for each kind of note:
- task (build, fix, change or investigate something): Sharp ends with a "Done when:" line. Full brief uses tagged sections such as <goal>, <context>, <direction>, <constraints>, <gotchas>, <done_when>, <start> - only the ones that earn their place. Genius says what to measure and asks for a plan or first cut before going further.
- question: Sharp is the question made precise. Full brief adds what a great answer must contain. Genius asks the deeper question behind it.
- post (a tweet, thread, caption, script or other copy, or a request to write one): each is a finished piece ready to publish in its format, and a tweet fits in 280 characters. Sharp is the tightest, punchiest version. Full brief is the fuller format, such as a thread or a caption with a hook. Genius is the boldest, most unexpected angle - contrarian take, hard number or prediction. If the note asks someone to write or post it, keep that ask and put the draft inside it.
- idea (a brainstorm, "what if we", "what about" - even said to an agent mid-task): Sharp is the idea as one tight pitch. Full brief covers what it is, why it could win, and the first thing to test. Genius is the bigger version the idea is pointing at.
- message (words meant for a person): Sharp is short and direct. Full brief is warm and complete. Genius is the one that moves the conversation forward.
- other: the same three depths, shaped the way an expert would find most useful.
</the_three_versions>

Output the kind, then exactly three blocks, and nothing else:
<kind>task|question|post|idea|message|other</kind>
<variant label="Sharp">...</variant>
<variant label="Full brief">...</variant>
<variant label="Genius">...</variant>`
}

export function parseEnhanceVariants(output: string): EnhanceResult | null {
  const variants: EnhanceVariant[] = []
  for (const m of output.matchAll(/<variant\b[^>]*?\blabel="([^"]+)"[^>]*>([\s\S]*?)<\/variant>/g)) {
    const text = m[2].trim()
    if (text !== '') variants.push({ label: m[1].trim(), text })
  }
  if (variants.length !== VARIANT_COUNT) return null
  const kind = /<kind>\s*([a-z]+)\s*<\/kind>/i.exec(output)?.[1]?.toLowerCase() ?? 'other'
  return { kind, variants }
}
